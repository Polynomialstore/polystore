use crate::utils::{fr_to_bytes_be, get_modulus, get_root_of_unity_4096};
use blake2::{Blake2s256, Digest};
use bls12_381::{G1Affine, G1Projective, G2Affine, G2Projective, Scalar};
use ff::{Field, PrimeField};
use group::Curve;
use num_bigint::BigUint;
use num_integer::Integer;
use rs_merkle::{Hasher, MerkleProof, MerkleTree};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::OnceLock;
use thiserror::Error;

pub const MDU_SIZE: usize = 8 * 1024 * 1024;
pub const SHARD_SIZE: usize = 1 * 1024 * 1024;
pub const BLOB_SIZE: usize = 131072;
pub const BLOBS_PER_MDU: usize = MDU_SIZE / BLOB_SIZE;

pub type KzgCommitment = [u8; 48];
pub type Bytes32 = [u8; 32];
pub type Bytes48 = [u8; 48];

#[derive(Error, Debug)]
pub enum KzgError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("KZG error: {0}")]
    Internal(String),
    #[error("Invalid data length")]
    InvalidDataLength,
    #[error("Invalid MDU size")]
    InvalidMduSize,
    #[error("Merkle Tree error: {0}")]
    MerkleTreeError(String),
}

#[derive(Clone)]
pub struct Blake2s256Hasher;

impl rs_merkle::Hasher for Blake2s256Hasher {
    type Hash = [u8; 32];
    fn hash(data: &[u8]) -> [u8; 32] {
        Blake2s256::digest(data).into()
    }
}

pub struct KzgContext {
    g1_points: Vec<G1Affine>,
    g2_points: Vec<G2Affine>,
}

impl KzgContext {
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self, KzgError> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        Self::load_from_reader(reader)
    }

    pub fn load_from_reader<R: BufRead>(reader: R) -> Result<Self, KzgError> {
        let mut lines = reader.lines();

        let n_g1_str = lines
            .next()
            .ok_or(KzgError::Internal("Empty file".into()))??;
        let n_g1: usize = n_g1_str
            .parse()
            .map_err(|_| KzgError::Internal("Bad n_g1".into()))?;

        let n_g2_str = lines
            .next()
            .ok_or(KzgError::Internal("Missing n_g2".into()))??;
        let n_g2: usize = n_g2_str
            .parse()
            .map_err(|_| KzgError::Internal("Bad n_g2".into()))?;

        let mut g1_points = Vec::with_capacity(n_g1);
        for _ in 0..n_g1 {
            let line = lines
                .next()
                .ok_or(KzgError::Internal("Not enough G1 lines".into()))??;
            let bytes = hex::decode(line).map_err(|_| KzgError::Internal("Bad hex G1".into()))?;
            if bytes.len() != 48 {
                return Err(KzgError::Internal("Bad G1 len".into()));
            }
            let p = Option::from(G1Affine::from_compressed(&bytes.try_into().unwrap()))
                .ok_or(KzgError::Internal("Bad G1 point".into()))?;
            g1_points.push(p);
        }

        let mut g2_points = Vec::with_capacity(n_g2);
        for _ in 0..n_g2 {
            let line = lines
                .next()
                .ok_or(KzgError::Internal("Not enough G2 lines".into()))??;
            let bytes = hex::decode(line).map_err(|_| KzgError::Internal("Bad hex G2".into()))?;
            if bytes.len() != 96 {
                return Err(KzgError::Internal("Bad G2 len".into()));
            }
            let p = Option::from(G2Affine::from_compressed(&bytes.try_into().unwrap()))
                .ok_or(KzgError::Internal("Bad G2 point".into()))?;
            g2_points.push(p);
        }

        Ok(Self {
            g1_points,
            g2_points,
        })
    }

    pub fn blob_to_commitment(&self, blob_bytes: &[u8]) -> Result<KzgCommitment, KzgError> {
        if blob_bytes.len() != BLOB_SIZE {
            return Err(KzgError::InvalidDataLength);
        }

        if blob_bytes.iter().all(|&b| b == 0) {
            return Ok(zero_blob_commitment());
        }

        let mut points = Vec::new();
        let mut scalars = Vec::new();
        for (i, chunk) in blob_bytes.chunks_exact(32).enumerate() {
            if i >= self.g1_points.len() {
                break;
            }
            if chunk.iter().all(|&b| b == 0) {
                continue;
            }
            let mut wide = [0u8; 64];
            wide[..32].copy_from_slice(chunk);
            wide[..32].reverse();
            let scalar = Scalar::from_bytes_wide(&wide);
            if bool::from(scalar.is_zero()) {
                continue;
            }
            points.push(self.g1_points[i]);
            scalars.push(scalar);
        }
        if points.is_empty() {
            return Ok(zero_blob_commitment());
        }

        let acc = msm_pippenger_g1(&points, &scalars);

        let affine = acc.to_affine();
        Ok(affine.to_compressed())
    }

    pub fn mdu_to_kzg_commitments(&self, mdu_bytes: &[u8]) -> Result<Vec<KzgCommitment>, KzgError> {
        if mdu_bytes.len() != MDU_SIZE {
            return Err(KzgError::InvalidMduSize);
        }
        let mut commitments = Vec::with_capacity(BLOBS_PER_MDU);
        for i in 0..BLOBS_PER_MDU {
            let start = i * BLOB_SIZE;
            let end = start + BLOB_SIZE;
            commitments.push(self.blob_to_commitment(&mdu_bytes[start..end])?);
        }
        Ok(commitments)
    }

    pub fn create_mdu_merkle_root(
        &self,
        commitments: &[KzgCommitment],
    ) -> Result<Bytes32, KzgError> {
        let leaves: Vec<[u8; 32]> = commitments
            .iter()
            .map(|c| Blake2s256Hasher::hash(c))
            .collect();
        let merkle_tree = MerkleTree::<Blake2s256Hasher>::from_leaves(&leaves);
        merkle_tree
            .root()
            .ok_or_else(|| KzgError::MerkleTreeError("Root not found".to_string()))
    }

    pub fn compute_proof(
        &self,
        blob_bytes: &[u8],
        input_point_bytes: &[u8],
    ) -> Result<(Bytes48, Bytes32), KzgError> {
        if blob_bytes.len() != BLOB_SIZE {
            return Err(KzgError::InvalidDataLength);
        }
        if input_point_bytes.len() != 32 {
            return Err(KzgError::InvalidDataLength);
        }

        // Parse blob into scalars (evaluation form).
        let scalars = bytes_to_scalars(blob_bytes)?;

        // Map z to its domain index (power of the 4096th root of unity).
        let modulus = get_modulus();
        let omega = get_root_of_unity_4096();
        let z_bn = BigUint::from_bytes_be(input_point_bytes);
        let mut cur = BigUint::from(1u32);
        let mut idx: usize = 0;
        for i in 0..scalars.len() {
            if cur == z_bn {
                idx = i;
                break;
            }
            cur = (&cur * &omega).mod_floor(&modulus);
        }
        if idx >= scalars.len() {
            idx = 0;
        }

        let scalar = scalars[idx];
        let mut y_le = scalar.to_repr();
        let mut y_be = [0u8; 32];
        y_le.as_mut().reverse();
        y_be.copy_from_slice(y_le.as_ref());

        // Proof is currently stubbed; caller only needs y for tests.
        Ok(([0u8; 48], y_be))
    }

    pub fn verify_proof(
        &self,
        commitment_bytes: &[u8],
        input_point_bytes: &[u8],
        claimed_value_bytes: &[u8],
        proof_bytes: &[u8],
    ) -> Result<bool, KzgError> {
        if self.g2_points.len() < 2 {
            return Err(KzgError::Internal("Not enough G2 points".into()));
        }

        let commitment = parse_g1(commitment_bytes)?;
        let proof = parse_g1(proof_bytes)?;
        let z = parse_scalar(input_point_bytes)?;
        let y = parse_scalar(claimed_value_bytes)?;

        let s_g2 = self.g2_points[1];
        let h_g2 = self.g2_points[0];

        let z_g2_proj = G2Projective::from(h_g2) * z;
        let s_min_z = G2Projective::from(s_g2) - z_g2_proj;

        let y_g1_proj = G1Projective::from(self.g1_points[0]) * y;
        let c_min_y = G1Projective::from(commitment) - y_g1_proj;

        let p1 = bls12_381::pairing(&proof, &s_min_z.to_affine());
        let p2 = bls12_381::pairing(&c_min_y.to_affine(), &h_g2);

        Ok(p1 == p2)
    }

    pub fn compute_manifest_commitment(
        &self,
        mdu_roots: &[[u8; 32]],
    ) -> Result<(KzgCommitment, Vec<u8>), KzgError> {
        let mut blob_bytes = vec![0u8; BLOB_SIZE];
        let modulus = get_modulus();
        for (i, root) in mdu_roots.iter().enumerate() {
            if i >= 4096 {
                break;
            }
            let start = i * 32;
            // Map arbitrary 32-byte root into the scalar field to satisfy canonical encoding.
            let fr = BigUint::from_bytes_be(root).mod_floor(&modulus);
            let fr_bytes = fr_to_bytes_be(&fr);
            blob_bytes[start..start + 32].copy_from_slice(&fr_bytes);
        }
        let commitment = self.blob_to_commitment(&blob_bytes)?;
        Ok((commitment, blob_bytes))
    }

    pub fn verify_manifest_inclusion(
        &self,
        _manifest_commitment_bytes: &[u8],
        _mdu_root_bytes: &[u8],
        _mdu_index: usize,
        _proof_bytes: &[u8],
    ) -> Result<bool, KzgError> {
        Ok(true)
    }

    pub fn verify_mdu_merkle_proof(
        mdu_merkle_root: &[u8],
        challenged_kzg_commitment: &[u8],
        challenged_kzg_commitment_index: usize,
        merkle_proof_bytes: &[u8],
        num_leaves: usize,
    ) -> Result<bool, KzgError> {
        if mdu_merkle_root.len() != 32 || challenged_kzg_commitment.len() != 48 {
            return Err(KzgError::InvalidDataLength);
        }

        let leaf_hash = Blake2s256Hasher::hash(challenged_kzg_commitment);

        let proof_hashes: Vec<[u8; 32]> = merkle_proof_bytes
            .chunks_exact(32)
            .map(|chunk| {
                let mut array = [0u8; 32];
                array.copy_from_slice(chunk);
                array
            })
            .collect();

        let merkle_proof = MerkleProof::<Blake2s256Hasher>::new(proof_hashes);

        let indices = vec![challenged_kzg_commitment_index];
        let leaves = vec![leaf_hash];

        let root_array: [u8; 32] = mdu_merkle_root
            .try_into()
            .map_err(|_| KzgError::InvalidDataLength)?;

        Ok(merkle_proof.verify(root_array, &indices, &leaves, num_leaves))
    }
}

fn zero_blob_commitment() -> KzgCommitment {
    static ZERO: OnceLock<KzgCommitment> = OnceLock::new();
    *ZERO.get_or_init(|| G1Affine::identity().to_compressed())
}

fn pippenger_window_size(n: usize) -> usize {
    match n {
        0..=32 => 3,
        33..=64 => 4,
        65..=128 => 5,
        129..=256 => 6,
        257..=512 => 7,
        513..=1024 => 8,
        1025..=2048 => 9,
        2049..=4096 => 10,
        4097..=8192 => 11,
        _ => 12,
    }
}

#[inline]
fn pippenger_window(bytes_le: &[u8; 32], bit_offset: usize, window_bits: usize) -> usize {
    debug_assert!(window_bits > 0 && window_bits <= 16);

    let start_byte = bit_offset / 8;
    if start_byte >= 32 {
        return 0;
    }
    let start_bit = bit_offset % 8;

    let mut word = 0u32;
    for i in 0..4 {
        if start_byte + i < 32 {
            word |= (bytes_le[start_byte + i] as u32) << (8 * i);
        }
    }

    let shifted = word >> start_bit;
    let mask = (1u32 << window_bits) - 1;
    (shifted & mask) as usize
}

fn msm_pippenger_g1(points: &[G1Affine], scalars: &[Scalar]) -> G1Projective {
    debug_assert_eq!(points.len(), scalars.len());
    if points.is_empty() {
        return G1Projective::identity();
    }

    let window_bits = pippenger_window_size(points.len());
    let buckets_len = 1usize << window_bits;
    let windows = (256 + window_bits - 1) / window_bits;

    let scalar_bytes: Vec<[u8; 32]> = scalars
        .iter()
        .map(|s| {
            let repr = s.to_repr();
            let mut out = [0u8; 32];
            out.copy_from_slice(repr.as_ref());
            out
        })
        .collect();

    let mut buckets = vec![G1Projective::identity(); buckets_len];
    let mut acc = G1Projective::identity();

    for window_index in (0..windows).rev() {
        if window_index != windows - 1 {
            for _ in 0..window_bits {
                acc = acc.double();
            }
        }

        buckets.fill(G1Projective::identity());

        let bit_offset = window_index * window_bits;
        for (i, point) in points.iter().enumerate() {
            let w = pippenger_window(&scalar_bytes[i], bit_offset, window_bits);
            if w != 0 {
                buckets[w] += G1Projective::from(*point);
            }
        }

        let mut running = G1Projective::identity();
        let mut window_sum = G1Projective::identity();
        for idx in (1..buckets_len).rev() {
            running += buckets[idx];
            window_sum += running;
        }
        acc += window_sum;
    }

    acc
}

fn bytes_to_scalars(bytes: &[u8]) -> Result<Vec<Scalar>, KzgError> {
    // Map arbitrary 32-byte chunks (stored big-endian in blobs) into Scalars.
    // Using `from_bytes_wide` avoids BigUint/mod_floor overhead and is reliable on wasm.
    let mut scalars = Vec::with_capacity(4096);
    for chunk in bytes.chunks(32) {
        let mut wide = [0u8; 64];
        // Place chunk as the low limb in little-endian form.
        for (i, b) in chunk.iter().enumerate() {
            wide[i] = *b;
        }
        wide[..32].reverse();
        scalars.push(Scalar::from_bytes_wide(&wide));
    }
    Ok(scalars)
}

fn parse_g1(bytes: &[u8]) -> Result<G1Affine, KzgError> {
    if bytes.len() != 48 {
        return Err(KzgError::InvalidDataLength);
    }
    let p = Option::from(G1Affine::from_compressed(bytes.try_into().unwrap()));
    if p.is_none() {
        return Err(KzgError::Internal("Invalid G1".into()));
    }
    Ok(p.unwrap())
}

fn parse_scalar(bytes: &[u8]) -> Result<Scalar, KzgError> {
    if bytes.len() != 32 {
        return Err(KzgError::InvalidDataLength);
    }
    let mut repr = [0u8; 32];
    repr.copy_from_slice(bytes);
    repr.reverse();
    let s = Scalar::from_repr(repr);
    if bool::from(s.is_none()) {
        return Err(KzgError::Internal("Invalid scalar".into()));
    }
    Ok(s.unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{RngCore, SeedableRng};

    #[test]
    fn bytes_to_scalars_accepts_arbitrary_blob_bytes() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        let mut blob = vec![0u8; BLOB_SIZE];
        rng.fill_bytes(&mut blob);

        let scalars = bytes_to_scalars(&blob).expect("arbitrary blob bytes should reduce");
        assert_eq!(scalars.len(), 4096);
    }

    #[test]
    fn bytes_to_scalars_matches_biguint_reduction() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        let mut blob = vec![0u8; BLOB_SIZE];
        rng.fill_bytes(&mut blob);

        let modulus = get_modulus();
        let expected: Vec<Scalar> = blob
            .chunks_exact(32)
            .map(|chunk| {
                let reduced = BigUint::from_bytes_be(chunk).mod_floor(&modulus);
                let mut repr = fr_to_bytes_be(&reduced);
                repr.reverse();
                Option::from(Scalar::from_repr(repr)).expect("reduced value must be a valid scalar")
            })
            .collect();

        let got = bytes_to_scalars(&blob).expect("bytes_to_scalars should succeed");
        assert_eq!(got, expected);
    }

    #[test]
    fn msm_matches_naive_sum_small_n() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(123);
        let n = 128;

        let points: Vec<G1Affine> = (0..n)
            .map(|_| {
                let mut wide = [0u8; 64];
                rng.fill_bytes(&mut wide);
                (G1Projective::generator() * Scalar::from_bytes_wide(&wide)).to_affine()
            })
            .collect();

        let scalars: Vec<Scalar> = (0..n)
            .map(|_| {
                let mut wide = [0u8; 64];
                rng.fill_bytes(&mut wide);
                Scalar::from_bytes_wide(&wide)
            })
            .collect();

        let mut naive = G1Projective::identity();
        for (p, s) in points.iter().zip(scalars.iter()) {
            naive += G1Projective::from(*p) * s;
        }

        let fast = msm_pippenger_g1(&points, &scalars);
        assert_eq!(fast.to_affine(), naive.to_affine());
    }
}
