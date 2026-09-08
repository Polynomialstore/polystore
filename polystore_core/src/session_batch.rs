//! PSB1 is one admitted session: 106-byte header then N fixed304-byte records
//! followed by each record's exact root and blob paths. Integers are big endian.
//! The caller authenticates context/root/seed, expected tuples and whole-list gas.
//! This layer independently bounds the transport, derives z, authenticates both
//! Merkle hops and batches the 2N KZG equations. It has no authority over state.
//!
//! For independent nonzero transcript weights r, A=sum(rC+rzP)-sum(ry)G and
//! B=sum(rP). Accept e(A,H)e(-B,tauH)=1 using two MSMs and one final exponentiation.
//! Soundness is in the random-oracle model; adaptive attempts accumulate risk.
use super::*;
use crate::retrieval_challenge::{Reader, append_lp, derive_z, invalid};
use bls12_381::{Gt, multi_miller_loop};
use sha2::Sha256;

pub const SESSION_BATCH_MAX_PROOFS: usize = 64;
pub const SESSION_BATCH_MAX_BYTES: usize = 60_522;
const HEADER_BYTES: usize = 106;
const RECORD_BYTES: usize = 304;
const MAX_LEAVES: usize = 16384;

struct Record<'a> {
    mdu: u64,
    leaf: u32,
    root: [u8; 32],
    root_commitment: [u8; 48],
    root_proof: [u8; 48],
    commitment: [u8; 48],
    z: [u8; 32],
    y: [u8; 32],
    proof: [u8; 48],
    root_path: &'a [u8],
    blob_path: &'a [u8],
}
struct Batch<'a> {
    leaves: usize,
    root: [u8; 32],
    context: [u8; 32],
    seed: [u8; 32],
    records: Vec<Record<'a>>,
}
impl<'a> Batch<'a> {
    fn parse(bytes: &'a [u8]) -> Result<Self, KzgError> {
        if bytes.len() < HEADER_BYTES + RECORD_BYTES || bytes.len() > SESSION_BATCH_MAX_BYTES {
            return Err(invalid());
        }
        let mut r = Reader { bytes };
        if r.take(4)? != b"PSB1" {
            return Err(invalid());
        }
        let n = usize::from(r.u16()?);
        let leaves = r.u32()? as usize;
        if n == 0 || n > SESSION_BATCH_MAX_PROOFS || leaves == 0 || leaves > MAX_LEAVES {
            return Err(invalid());
        }
        let root = r.array()?;
        let context = r.array()?;
        let seed = r.array()?;
        let mut records = Vec::with_capacity(n);
        for _ in 0..n {
            let mdu = r.u64()?;
            let leaf = r.u32()?;
            let record = Record {
                mdu,
                leaf,
                root: r.array()?,
                root_commitment: r.array()?,
                root_proof: r.array()?,
                commitment: r.array()?,
                z: r.array()?,
                y: r.array()?,
                proof: r.array()?,
                root_path: &[],
                blob_path: &[],
            };
            root_table_position_for_mdu_index(mdu)?;
            let root_count = usize::from(r.u16()?);
            let blob_count = usize::from(r.u16()?);
            if root_count != 6
                || blob_count > 14
                || blob_count != merkle_sibling_count(leaf as usize, leaves)?
            {
                return Err(invalid());
            }
            records.push(Record {
                root_path: r.take(root_count * 32)?,
                blob_path: r.take(blob_count * 32)?,
                ..record
            });
        }
        if !r.bytes.is_empty() {
            return Err(invalid());
        }
        Ok(Self {
            leaves,
            root,
            context,
            seed,
            records,
        })
    }
}

struct Opening {
    c: G1Affine,
    z: Scalar,
    y: Scalar,
    p: G1Affine,
}
fn append_opening(
    transcript: &mut Vec<u8>,
    role: u8,
    c: &[u8; 48],
    z: &[u8; 32],
    y: &[u8; 32],
    p: &[u8; 48],
) -> Result<Opening, KzgError> {
    let opening = Opening {
        c: parse_g1(c)?,
        z: parse_scalar(z)?,
        y: parse_scalar(y)?,
        p: parse_g1(p)?,
    };
    transcript.push(role);
    transcript.extend(c);
    transcript.extend(z);
    transcript.extend(y);
    transcript.extend(p);
    Ok(opening)
}

fn coefficient(hash: &[u8; 32], index: u16) -> Result<Scalar, KzgError> {
    let mut prefix = Vec::with_capacity(80);
    append_lp(&mut prefix, b"polystore/kzg-batch-coefficient/v1");
    prefix.extend(hash);
    prefix.extend(index.to_be_bytes());
    coefficient_from_candidates(|retry| {
        let mut h = Sha256::new();
        h.update(&prefix);
        h.update(retry.to_be_bytes());
        h.finalize().into()
    })
}

fn coefficient_from_candidates(
    mut digest: impl FnMut(u16) -> [u8; 32],
) -> Result<Scalar, KzgError> {
    for retry in 0u16..256 {
        if let Ok(value) = parse_scalar(&digest(retry)) {
            if value != Scalar::zero() {
                return Ok(value);
            }
        }
    }
    Err(KzgError::Internal(
        "Batch coefficient rejection exhausted".into(),
    ))
}

/// Never allow the legacy MSM's release-mode dimension truncation at this boundary.
fn checked_msm(points: &[G1Affine], scalars: &[Scalar]) -> Result<G1Projective, KzgError> {
    if points.len() != scalars.len() || points.len() > 4 * SESSION_BATCH_MAX_PROOFS {
        return Err(invalid());
    }
    Ok(msm_pippenger_g1(points, scalars))
}

impl KzgContext {
    pub fn verify_polyfs_session_batch(&self, input: &[u8]) -> Result<bool, KzgError> {
        let batch = Batch::parse(input)?;
        let Some((transcript, openings)) = self.prepare_session_batch(&batch)? else {
            return Ok(false);
        };
        let hash: [u8; 32] = Sha256::digest(transcript).into();
        let coefficients: Vec<Scalar> = (0..openings.len())
            .map(|i| coefficient(&hash, i as u16))
            .collect::<Result<_, _>>()?;
        self.verify_opening_batch(&openings, &coefficients)
    }

    fn prepare_session_batch(
        &self,
        batch: &Batch<'_>,
    ) -> Result<Option<(Vec<u8>, Vec<Opening>)>, KzgError> {
        let n = batch.records.len();
        let mut transcript = Vec::with_capacity(256 + n * 400);
        append_lp(&mut transcript, b"polystore/kzg-batch/v1");
        transcript.extend(TRUSTED_SETUP_SHA256);
        transcript.extend(4096u32.to_be_bytes());
        append_lp(&mut transcript, b"bls12-381/fr-be/polyfs-natural-order");
        transcript.extend((n as u16).to_be_bytes());
        transcript.extend((2 * n as u16).to_be_bytes());
        transcript.extend(batch.context);
        transcript.extend(batch.seed);
        transcript.extend(batch.root);
        let mut openings = Vec::with_capacity(2 * n);
        for (i, record) in batch.records.iter().enumerate() {
            let position = root_table_position_for_mdu_index(record.mdu)?;
            if record.z
                != derive_z(
                    &batch.context,
                    &batch.seed,
                    i as u64,
                    record.mdu,
                    record.leaf,
                )?
                || !Self::verify_mdu_merkle_proof(
                    &batch.root,
                    &record.root_commitment,
                    position.root_table_du,
                    record.root_path,
                    64,
                )?
                || !Self::verify_mdu_merkle_proof(
                    &record.root,
                    &record.commitment,
                    record.leaf as usize,
                    record.blob_path,
                    batch.leaves,
                )?
            {
                return Ok(None);
            }
            let root_z = crate::utils::z_for_cell(position.root_table_cell);
            let root_y = encode_mdu_root_for_root_table(&record.root)?;
            transcript.extend((i as u16).to_be_bytes());
            transcript.extend((i as u64).to_be_bytes());
            transcript.extend(record.mdu.to_be_bytes());
            transcript.extend(record.leaf.to_be_bytes());
            transcript.extend((batch.leaves as u32).to_be_bytes());
            transcript.extend(record.root);
            transcript.extend((position.root_table_du as u16).to_be_bytes());
            transcript.extend((position.root_table_cell as u16).to_be_bytes());
            openings.push(append_opening(
                &mut transcript,
                0,
                &record.root_commitment,
                &root_z,
                &root_y,
                &record.root_proof,
            )?);
            openings.push(append_opening(
                &mut transcript,
                1,
                &record.commitment,
                &record.z,
                &record.y,
                &record.proof,
            )?);
        }
        Ok(Some((transcript, openings)))
    }

    fn verify_opening_batch(
        &self,
        openings: &[Opening],
        coefficients: &[Scalar],
    ) -> Result<bool, KzgError> {
        if openings.is_empty()
            || openings.len() > 2 * SESSION_BATCH_MAX_PROOFS
            || openings.len() != coefficients.len()
        {
            return Err(invalid());
        }
        let m = openings.len();
        let mut points = Vec::with_capacity(2 * m);
        let mut scalars = Vec::with_capacity(2 * m);
        let mut proofs = Vec::with_capacity(m);
        let mut weighted_y = Scalar::zero();
        for (opening, r) in openings.iter().zip(coefficients) {
            if *r == Scalar::zero() {
                return Err(invalid());
            }
            points.push(opening.c);
            scalars.push(*r);
            points.push(opening.p);
            scalars.push(*r * opening.z);
            proofs.push(opening.p);
            weighted_y += *r * opening.y;
        }
        let a = (checked_msm(&points, &scalars)?
            - G1Projective::from(self.g1_generator) * weighted_y)
            .to_affine();
        let minus_b = (-checked_msm(&proofs, coefficients)?).to_affine();
        Ok(
            multi_miller_loop(&[(&a, &self.prepared_h), (&minus_b, &self.prepared_tau)])
                .final_exponentiation()
                == Gt::identity(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;
    #[test]
    fn independent_python_transcript_and_coefficients() {
        let input = include_bytes!("../tests/testdata/session-batch-input.bin");
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../tests/testdata/session-batch-golden.json"))
                .unwrap();
        let batch = Batch::parse(input).unwrap();
        let (transcript, openings) = context().prepare_session_batch(&batch).unwrap().unwrap();
        assert_eq!(
            hex::encode(&transcript),
            expected["transcript_hex"].as_str().unwrap()
        );
        let hash: [u8; 32] = Sha256::digest(&transcript).into();
        assert_eq!(
            hex::encode(hash),
            expected["transcript_hash"].as_str().unwrap()
        );
        let values = expected["coefficients"].as_array().unwrap();
        assert_eq!(openings.len(), values.len());
        for (i, value) in values.iter().enumerate() {
            let mut bytes = coefficient(&hash, i as u16).unwrap().to_bytes();
            bytes.reverse();
            assert_eq!(hex::encode(bytes), value["scalar"].as_str().unwrap());
        }
        assert!(context().verify_polyfs_session_batch(input).unwrap());
    }
    #[test]
    fn coefficient_rejection_is_finite_and_canonical() {
        let mut calls = 0;
        assert!(
            coefficient_from_candidates(|retry| {
                assert_eq!(retry, calls);
                calls += 1;
                [0; 32]
            })
            .is_err()
        );
        assert_eq!(calls, 256);
        let mut one = [0; 32];
        one[31] = 1;
        assert_eq!(
            coefficient_from_candidates(|retry| if retry == 255 { one } else { [0xff; 32] })
                .unwrap(),
            Scalar::one()
        );
    }
    fn context() -> &'static KzgContext {
        static CONTEXT: OnceLock<KzgContext> = OnceLock::new();
        CONTEXT.get_or_init(|| {
            KzgContext::load_from_file(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../polystorechain/trusted_setup.txt"
            ))
            .unwrap()
        })
    }
    fn fixture(count: usize) -> Vec<u8> {
        static RECORDS: OnceLock<([u8; 32], Vec<Vec<u8>>)> = OnceLock::new();
        let (root, records) = RECORDS.get_or_init(|| {
            let ctx = context();
            let blobs: Vec<_> = (0..64u8)
                .map(|i| {
                    let mut b = vec![0; BLOB_SIZE];
                    b[31] = i + 1;
                    b[63] = i + 2;
                    b
                })
                .collect();
            let mut commitments: Vec<_> = blobs
                .iter()
                .map(|b| ctx.commit_received_blob(b).unwrap())
                .collect();
            commitments.resize(96, G1Affine::identity().to_compressed());
            let hashes: Vec<_> = commitments
                .iter()
                .map(|c| Blake2s256Hasher::hash(c))
                .collect();
            let tree = MerkleTree::<Blake2s256Hasher>::from_leaves(&hashes);
            let mdu_root = tree.root().unwrap();
            let mut root_blob = vec![0; BLOB_SIZE];
            root_blob[..32].copy_from_slice(&encode_mdu_root_for_root_table(&mdu_root).unwrap());
            let root_commitment = ctx.commit_received_blob(&root_blob).unwrap();
            let (root_proof, _) = ctx
                .compute_proof(&root_blob, &crate::utils::z_for_cell(0))
                .unwrap();
            let mut root_commitments = vec![G1Affine::identity().to_compressed(); 64];
            root_commitments[1] = root_commitment;
            let root_hashes: Vec<_> = root_commitments
                .iter()
                .map(|c| Blake2s256Hasher::hash(c))
                .collect();
            let root_tree = MerkleTree::<Blake2s256Hasher>::from_leaves(&root_hashes);
            let root_path = root_tree.proof(&[1]).to_bytes();
            let mut records = Vec::new();
            for i in 0..64 {
                let z = derive_z(&[17; 32], &[29; 32], i as u64, 4097, i as u32).unwrap();
                let (proof, y) = ctx.compute_proof(&blobs[i], &z).unwrap();
                assert!(ctx.verify_proof(&commitments[i], &z, &y, &proof).unwrap());
                let blob_path = tree.proof(&[i]).to_bytes();
                let mut record = Vec::new();
                record.extend(4097u64.to_be_bytes());
                record.extend((i as u32).to_be_bytes());
                record.extend(mdu_root);
                record.extend(root_commitment);
                record.extend(root_proof);
                record.extend(commitments[i]);
                record.extend(z);
                record.extend(y);
                record.extend(proof);
                record.extend(6u16.to_be_bytes());
                record.extend((blob_path.len() as u16 / 32).to_be_bytes());
                record.extend(&root_path);
                record.extend(blob_path);
                records.push(record);
            }
            (root_tree.root().unwrap(), records)
        });
        let mut input = Vec::new();
        input.extend(b"PSB1");
        input.extend((count as u16).to_be_bytes());
        input.extend(96u32.to_be_bytes());
        input.extend(root);
        input.extend([17; 32]);
        input.extend([29; 32]);
        for record in &records[..count] {
            input.extend(record);
        }
        input
    }

    #[test]
    fn batch_nonconstant_differential_and_all_or_nothing() {
        let ctx = context();
        for count in [1, 2, 8, 32, 64] {
            assert!(ctx.verify_polyfs_session_batch(&fixture(count)).unwrap());
        }
        let input = fixture(2);
        // Every wire field/path and a suffix is covered by parsing or verification.
        for offset in [
            0,
            4,
            6,
            10,
            42,
            74,
            106,
            114,
            118,
            150,
            198,
            246,
            294,
            326,
            358,
            406,
            408,
            410,
            input.len() - 1,
        ] {
            let mut bad = input.clone();
            bad[offset] ^= 1;
            assert!(
                !ctx.verify_polyfs_session_batch(&bad).unwrap_or(false),
                "offset {offset}"
            );
        }
        for len in [0, 105, 106, 409, input.len() - 1] {
            assert!(ctx.verify_polyfs_session_batch(&input[..len]).is_err());
        }
        let mut extra = input.clone();
        extra.push(0);
        assert!(ctx.verify_polyfs_session_batch(&extra).is_err());
        let mut empty = input.clone();
        empty[4..6].copy_from_slice(&0u16.to_be_bytes());
        assert!(Batch::parse(&empty).is_err());
        let mut excess = input.clone();
        excess[4..6].copy_from_slice(&65u16.to_be_bytes());
        assert!(Batch::parse(&excess).is_err());
        assert!(Batch::parse(&vec![0; SESSION_BATCH_MAX_BYTES + 1]).is_err());
        let mut noncanonical = input.clone();
        noncanonical[326..358].fill(0xff);
        assert!(ctx.verify_polyfs_session_batch(&noncanonical).is_err());
        // Complete admitted list order is committed into z as well as the batch transcript.
        let record_len = (input.len() - HEADER_BYTES) / 2;
        let mut reordered = input[..HEADER_BYTES].to_vec();
        reordered.extend(&input[HEADER_BYTES + record_len..]);
        reordered.extend(&input[HEADER_BYTES..HEADER_BYTES + record_len]);
        assert!(!ctx.verify_polyfs_session_batch(&reordered).unwrap());
        let mut duplicate = input.clone();
        duplicate[HEADER_BYTES + record_len..]
            .copy_from_slice(&input[HEADER_BYTES..HEADER_BYTES + record_len]);
        assert!(!ctx.verify_polyfs_session_batch(&duplicate).unwrap());
    }

    #[test]
    fn transcript_weights_defeat_equal_opposite_invalid_equations() {
        let ctx = context();
        let mut input = fixture(2);
        let record_len = (input.len() - HEADER_BYTES) / 2;
        for (index, delta) in [(0, Scalar::one()), (1, -Scalar::one())] {
            let offset = HEADER_BYTES + index * record_len + 220;
            let mut y = (parse_scalar(&input[offset..offset + 32]).unwrap() + delta).to_bytes();
            y.reverse();
            input[offset..offset + 32].copy_from_slice(&y);
        }
        let batch = Batch::parse(&input).unwrap();
        let (transcript, openings) = ctx.prepare_session_batch(&batch).unwrap().unwrap();
        for r in &batch.records {
            assert!(
                !ctx.verify_proof(&r.commitment, &r.z, &r.y, &r.proof)
                    .unwrap()
            );
        }
        assert!(
            ctx.verify_opening_batch(&openings, &[Scalar::one(); 4])
                .unwrap(),
            "fixture must demonstrate the unweighted cancellation bug"
        );
        assert!(!ctx.verify_polyfs_session_batch(&input).unwrap());
        let hash: [u8; 32] = Sha256::digest(&transcript).into();
        assert_ne!(
            coefficient(&hash, 0).unwrap(),
            coefficient(&hash, 1).unwrap()
        );
        assert!(checked_msm(&[G1Affine::identity()], &[]).is_err());
        assert!(
            ctx.verify_opening_batch(&openings, &[Scalar::one(); 3])
                .is_err()
        );
    }

    #[test]
    fn identities_remain_valid_and_transport_ffi_is_bounded() {
        let ctx = context();
        let opening = Opening {
            c: G1Affine::identity(),
            z: Scalar::from(17),
            y: Scalar::zero(),
            p: G1Affine::identity(),
        };
        assert!(
            ctx.verify_opening_batch(&[opening], &[Scalar::from(9)])
                .unwrap()
        );
        let constant = Scalar::from(11);
        let opening = Opening {
            c: (G1Projective::generator() * constant).to_affine(),
            z: Scalar::from(3),
            y: constant,
            p: G1Affine::identity(),
        };
        assert!(
            ctx.verify_opening_batch(&[opening], &[Scalar::from(7)])
                .unwrap()
        );
        assert_eq!(
            crate::ffi::polystore_verify_polyfs_session_batch_v1(std::ptr::null(), usize::MAX),
            -1
        );
        let path = std::ffi::CString::new(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../polystorechain/trusted_setup.txt"
        ))
        .unwrap();
        assert_eq!(crate::ffi::polystore_init(path.as_ptr()), 0);
        let input = fixture(2);
        assert_eq!(
            crate::ffi::polystore_verify_polyfs_session_batch_v1(input.as_ptr(), input.len()),
            1
        );
        assert_eq!(
            crate::ffi::polystore_verify_polyfs_session_batch_v1(input.as_ptr(), usize::MAX),
            -1
        );
    }

    /// Explicit local export only; Python independently reconstructs transcript and coefficients.
    #[test]
    #[ignore]
    fn export_batch_fixture() {
        let dir = std::env::var("POLYSTORE_BATCH_VECTOR_DIR").unwrap();
        let input = fixture(8);
        let batch = Batch::parse(&input).unwrap();
        let (transcript, openings) = context().prepare_session_batch(&batch).unwrap().unwrap();
        let hash: [u8; 32] = Sha256::digest(&transcript).into();
        let coefficients: Vec<_> = (0..openings.len())
            .map(|i| {
                let mut b = coefficient(&hash, i as u16).unwrap().to_bytes();
                b.reverse();
                hex::encode(b)
            })
            .collect();
        std::fs::write(std::path::Path::new(&dir).join("batch-input.bin"), input).unwrap();
        std::fs::write(std::path::Path::new(&dir).join("rust-batch-observed.json"), serde_json::to_vec_pretty(&serde_json::json!({"transcript_hex":hex::encode(transcript),"hash":hex::encode(hash),"coefficients":coefficients})).unwrap()).unwrap();
    }
}
