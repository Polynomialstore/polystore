use polystore_core::kzg::Blake2s256Hasher;
use polystore_core::kzg::KzgContext;
use rs_merkle::{Hasher, MerkleTree};

fn setup() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../polystorechain/trusted_setup.txt"
    ))
    .unwrap()
}

#[test]
fn setup_identity_includes_unconsumed_trailer() {
    let mut bytes = setup();
    let last = bytes.len() - 2;
    bytes[last] = if bytes[last] == b'0' { b'1' } else { b'0' };
    assert!(KzgContext::load_from_reader(bytes.as_slice()).is_err());
}

#[test]
fn merkle_membership_consumes_exact_path() {
    let ctx = KzgContext::load_from_reader(setup().as_slice()).unwrap();
    let commitments: Vec<_> = (0..96u8).map(|i| [i; 48]).collect();
    let root = ctx.create_mdu_merkle_root(&commitments).unwrap();
    for index in [0, 63, 64, 95] {
        let leaves: Vec<_> = commitments
            .iter()
            .map(|c| Blake2s256Hasher::hash(c))
            .collect();
        let mut path = MerkleTree::<Blake2s256Hasher>::from_leaves(&leaves)
            .proof(&[index])
            .to_bytes();
        assert!(
            KzgContext::verify_mdu_merkle_proof(&root, &commitments[index], index, &path, 96)
                .unwrap()
        );
        path.extend_from_slice(&[0; 32]);
        assert!(
            KzgContext::verify_mdu_merkle_proof(&root, &commitments[index], index, &path, 96)
                .is_err()
        );
    }
}

#[test]
fn strict_received_blob_and_packed_payload_are_distinct_contracts() {
    use polystore_core::{coding::validate_packed_payload, kzg::BLOB_SIZE};
    let ctx = KzgContext::load_from_reader(setup().as_slice()).unwrap();
    let mut blob = vec![0u8; BLOB_SIZE];
    assert_eq!(
        ctx.commit_received_blob(&blob).unwrap(),
        ctx.blob_to_commitment(&blob).unwrap()
    );
    assert!(ctx.commit_received_blob(&blob[..BLOB_SIZE - 1]).is_err());
    assert!(ctx.commit_received_blob(&vec![0; BLOB_SIZE + 1]).is_err());
    let modulus =
        hex::decode("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001").unwrap();
    blob[BLOB_SIZE - 32..].copy_from_slice(&modulus);
    assert!(ctx.commit_received_blob(&blob).is_err());
    blob[BLOB_SIZE - 1] -= 1;
    // Full canonical Fr root-table cells are legal despite their nonzero leading byte.
    assert!(ctx.commit_received_blob(&blob).is_ok());
    assert!(validate_packed_payload(&blob, 4096 * 31).is_err());
    let mut packed = vec![0u8; 96];
    packed[1..32].fill(7);
    packed[62..64].copy_from_slice(&[8, 9]);
    assert!(validate_packed_payload(&packed, 33).is_ok());
    for index in [0, 32, 61, 64, 95] {
        let mut bad = packed.clone();
        bad[index] = 1;
        assert!(validate_packed_payload(&bad, 33).is_err(), "byte {index}");
    }
    assert!(validate_packed_payload(&packed[..95], 33).is_err());
    assert!(validate_packed_payload(&packed, usize::MAX).is_err());
    assert!(validate_packed_payload(&packed, 0).is_err());
    assert!(validate_packed_payload(&[0; 96], 0).is_ok());
}

#[test]
fn setup_read_is_bounded_and_reinit_authenticates_requested_file() {
    use polystore_core::kzg::{TRUSTED_SETUP_BYTES, read_trusted_setup, validate_trusted_setup};
    use std::io::{Cursor, Read};
    let bytes = setup();
    assert!(validate_trusted_setup(&bytes).is_ok());
    assert!(validate_trusted_setup(&bytes[..bytes.len() - 1]).is_err());
    let mut oversized = bytes.clone();
    oversized.extend_from_slice(&[0; 100]);
    let mut cursor = Cursor::new(oversized);
    assert!(read_trusted_setup(&mut cursor).is_err());
    assert_eq!(cursor.position(), (TRUSTED_SETUP_BYTES + 1) as u64);
    let mut remainder = Vec::new();
    cursor.read_to_end(&mut remainder).unwrap();
    assert_eq!(remainder.len(), 99);
    let path = std::ffi::CString::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../polystorechain/trusted_setup.txt"
    ))
    .unwrap();
    assert_eq!(polystore_core::ffi::polystore_init(path.as_ptr()), 0);
    let missing = std::ffi::CString::new("/polystore-nonexistent-trusted-setup").unwrap();
    assert!(polystore_core::ffi::polystore_init(missing.as_ptr()) < 0);
    assert_eq!(polystore_core::ffi::polystore_init(path.as_ptr()), 0);
    let mut out = [7; 48];
    assert!(
        polystore_core::ffi::polystore_commit_received_blob(
            std::ptr::null(),
            usize::MAX,
            out.as_mut_ptr()
        ) < 0
    );
    assert_eq!(out, [7; 48]);
    let blob = vec![0xff; polystore_core::kzg::BLOB_SIZE];
    assert!(
        polystore_core::ffi::polystore_commit_received_blob(
            blob.as_ptr(),
            blob.len(),
            out.as_mut_ptr()
        ) < 0
    );
    assert_eq!(out, [7; 48]);
}

#[test]
fn independent_root_table_coordinate_and_scalar_vectors() {
    use polystore_core::kzg::{encode_mdu_root_for_root_table, root_table_position_for_mdu_index};
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("testdata/session-batch-golden.json")).unwrap();
    let root: [u8; 32] = hex::decode(vectors["root_boundary_raw_digest"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    for vector in vectors["root_boundaries"].as_array().unwrap() {
        let mdu = vector["mdu"].as_str().unwrap().parse().unwrap();
        let position = root_table_position_for_mdu_index(mdu).unwrap();
        assert_eq!(
            position.root_table_du as u64,
            vector["du"].as_u64().unwrap()
        );
        assert_eq!(
            position.root_table_cell as u64,
            vector["cell"].as_u64().unwrap()
        );
        assert_eq!(
            hex::encode(polystore_core::utils::z_for_cell(position.root_table_cell)),
            vector["z"].as_str().unwrap()
        );
        assert_eq!(
            hex::encode(encode_mdu_root_for_root_table(&root).unwrap()),
            vector["y"].as_str().unwrap()
        );
    }
}

#[test]
fn session_verification_ignores_producer_msm_override() {
    // Global producer tuning is intentionally tested in a separate process so
    // this regression cannot perturb unrelated parallel prover tests.
    if std::env::var_os("POLYSTORE_MSM_OVERRIDE_CHILD").is_none() {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "session_verification_ignores_producer_msm_override",
                "--nocapture",
            ])
            .env("POLYSTORE_MSM_OVERRIDE_CHILD", "1")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        return;
    }
    let ctx = KzgContext::load_from_reader(setup().as_slice()).unwrap();
    let input = include_bytes!("testdata/session-batch-input.bin");
    let mut invalid = input.to_vec();
    invalid[106 + 220 + 31] ^= 1;
    for bits in [0, 1, 12, usize::MAX] {
        polystore_core::kzg::set_pippenger_window_override(Some(bits));
        assert!(ctx.verify_polyfs_session_batch(input).unwrap());
        assert!(!ctx.verify_polyfs_session_batch(&invalid).unwrap());
    }
}
