use polystore_core::kzg::{
    BLOB_SIZE, BLOBS_PER_MDU, KzgContext, MDU_SIZE, MDU0_ROOT_TABLE_CAPACITY,
    encode_mdu_root_for_root_table, root_table_position_for_mdu_index,
};
use std::ffi::CString;
use std::path::PathBuf;
use std::time::Instant;

fn trusted_setup_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop();
    path.push("demos");
    path.push("kzg");
    path.push("trusted_setup.txt");
    path
}

fn test_root(tag: u8, mdu_index: u64) -> [u8; 32] {
    let mut root = [tag; 32];
    root[24..32].copy_from_slice(&mdu_index.to_be_bytes());
    root
}

fn write_root_table_entry(mdu0: &mut [u8], mdu_index: u64, mdu_root: &[u8; 32]) {
    let position = root_table_position_for_mdu_index(mdu_index).unwrap();
    let encoded = encode_mdu_root_for_root_table(mdu_root).unwrap();
    let offset = position.root_table_du * BLOB_SIZE + position.root_table_cell * 32;
    mdu0[offset..offset + 32].copy_from_slice(&encoded);
}

fn polyfs_root_for_mdu0(ctx: &KzgContext, mdu0: &[u8]) -> [u8; 32] {
    let commitments = ctx.mdu_to_kzg_commitments(mdu0).unwrap();
    assert_eq!(commitments.len(), BLOBS_PER_MDU);
    ctx.create_mdu_merkle_root(&commitments).unwrap()
}

fn init_ffi_context() {
    let path = CString::new(trusted_setup_path().to_str().unwrap()).unwrap();
    assert_eq!(polystore_core::ffi::polystore_init(path.as_ptr()), 0);
}

#[test]
fn root_table_position_boundaries() {
    let first = root_table_position_for_mdu_index(1).unwrap();
    assert_eq!(first.root_table_index, 0);
    assert_eq!(first.root_table_du, 0);
    assert_eq!(first.root_table_cell, 0);

    let last_du0 = root_table_position_for_mdu_index(4096).unwrap();
    assert_eq!(last_du0.root_table_index, 4095);
    assert_eq!(last_du0.root_table_du, 0);
    assert_eq!(last_du0.root_table_cell, 4095);

    let first_du1 = root_table_position_for_mdu_index(4097).unwrap();
    assert_eq!(first_du1.root_table_index, 4096);
    assert_eq!(first_du1.root_table_du, 1);
    assert_eq!(first_du1.root_table_cell, 0);

    let near_cap = root_table_position_for_mdu_index(MDU0_ROOT_TABLE_CAPACITY).unwrap();
    assert_eq!(near_cap.root_table_du, 15);
    assert_eq!(near_cap.root_table_cell, 4095);

    assert!(root_table_position_for_mdu_index(0).is_err());
    assert!(root_table_position_for_mdu_index(MDU0_ROOT_TABLE_CAPACITY + 1).is_err());
}

#[test]
fn mdu0_merkle_root_generation_covers_64_du_commitments() {
    let ctx = KzgContext::load_from_file(trusted_setup_path()).unwrap();
    let mut mdu0 = vec![0u8; MDU_SIZE];
    write_root_table_entry(&mut mdu0, 1, &test_root(0x11, 1));
    write_root_table_entry(&mut mdu0, 4097, &test_root(0x22, 4097));
    write_root_table_entry(
        &mut mdu0,
        MDU0_ROOT_TABLE_CAPACITY,
        &test_root(0x33, MDU0_ROOT_TABLE_CAPACITY),
    );

    let commitments = ctx.mdu_to_kzg_commitments(&mdu0).unwrap();
    assert_eq!(commitments.len(), 64);
    let polyfs_root = ctx.create_mdu_merkle_root(&commitments).unwrap();

    let proof = ctx
        .compute_mdu0_root_table_proof(&mdu0, 4097, &test_root(0x22, 4097))
        .unwrap();
    assert_eq!(proof.position.root_table_du, 1);
    assert_eq!(proof.root_table_du_merkle_proof.len(), 6 * 32);

    let ok = ctx
        .verify_mdu0_root_table_proof(
            &polyfs_root,
            4097,
            &test_root(0x22, 4097),
            &proof.root_table_du_commitment,
            &proof.root_table_du_merkle_proof,
            &proof.root_table_opening_proof,
        )
        .unwrap();
    assert!(ok);
}

#[test]
fn valid_mdu0_root_table_proofs_cover_boundary_indices() {
    let ctx = KzgContext::load_from_file(trusted_setup_path()).unwrap();
    let indices = [1, 4096, 4097, MDU0_ROOT_TABLE_CAPACITY];
    let mut mdu0 = vec![0u8; MDU_SIZE];
    for (i, mdu_index) in indices.iter().copied().enumerate() {
        write_root_table_entry(&mut mdu0, mdu_index, &test_root(0x40 + i as u8, mdu_index));
    }
    let polyfs_root = polyfs_root_for_mdu0(&ctx, &mdu0);

    for (i, mdu_index) in indices.iter().copied().enumerate() {
        let target_root = test_root(0x40 + i as u8, mdu_index);
        let proof = ctx
            .compute_mdu0_root_table_proof(&mdu0, mdu_index, &target_root)
            .unwrap();

        let ok = ctx
            .verify_mdu0_root_table_proof(
                &polyfs_root,
                mdu_index,
                &target_root,
                &proof.root_table_du_commitment,
                &proof.root_table_du_merkle_proof,
                &proof.root_table_opening_proof,
            )
            .unwrap();
        assert!(ok, "proof should verify for mdu_index {mdu_index}");
    }
}

#[test]
fn mdu0_root_table_proof_rejects_tampering_and_invalid_indices() {
    let ctx = KzgContext::load_from_file(trusted_setup_path()).unwrap();
    let mdu_index = 4097;
    let target_root = test_root(0x77, mdu_index);
    let mut mdu0 = vec![0u8; MDU_SIZE];
    write_root_table_entry(&mut mdu0, mdu_index, &target_root);
    let polyfs_root = polyfs_root_for_mdu0(&ctx, &mdu0);
    let proof = ctx
        .compute_mdu0_root_table_proof(&mdu0, mdu_index, &target_root)
        .unwrap();

    let mut tampered_polyfs_root = polyfs_root;
    tampered_polyfs_root[0] ^= 0x01;
    let ok = ctx
        .verify_mdu0_root_table_proof(
            &tampered_polyfs_root,
            mdu_index,
            &target_root,
            &proof.root_table_du_commitment,
            &proof.root_table_du_merkle_proof,
            &proof.root_table_opening_proof,
        )
        .unwrap();
    assert!(!ok, "tampered MDU #0 root must reject");

    let mut tampered_merkle_proof = proof.root_table_du_merkle_proof.clone();
    tampered_merkle_proof[0] ^= 0x01;
    let ok = ctx
        .verify_mdu0_root_table_proof(
            &polyfs_root,
            mdu_index,
            &target_root,
            &proof.root_table_du_commitment,
            &tampered_merkle_proof,
            &proof.root_table_opening_proof,
        )
        .unwrap();
    assert!(!ok, "tampered MDU #0 DU merkle path must reject");

    let mut tampered_target_root = target_root;
    tampered_target_root[0] ^= 0x01;
    let ok = ctx
        .verify_mdu0_root_table_proof(
            &polyfs_root,
            mdu_index,
            &tampered_target_root,
            &proof.root_table_du_commitment,
            &proof.root_table_du_merkle_proof,
            &proof.root_table_opening_proof,
        )
        .unwrap();
    assert!(!ok, "tampered target MDU root must reject");

    let mut tampered_opening = proof.root_table_opening_proof;
    tampered_opening[0] ^= 0x01;
    let result = ctx.verify_mdu0_root_table_proof(
        &polyfs_root,
        mdu_index,
        &target_root,
        &proof.root_table_du_commitment,
        &proof.root_table_du_merkle_proof,
        &tampered_opening,
    );
    assert!(
        !matches!(result, Ok(true)),
        "tampered root-table KZG proof must reject"
    );

    let wrong_cell_result = ctx
        .verify_mdu0_root_table_proof(
            &polyfs_root,
            mdu_index + 1,
            &target_root,
            &proof.root_table_du_commitment,
            &proof.root_table_du_merkle_proof,
            &proof.root_table_opening_proof,
        )
        .unwrap();
    assert!(!wrong_cell_result, "wrong root-table cell must reject");

    assert!(
        ctx.verify_mdu0_root_table_proof(
            &polyfs_root,
            MDU0_ROOT_TABLE_CAPACITY + 1,
            &target_root,
            &proof.root_table_du_commitment,
            &proof.root_table_du_merkle_proof,
            &proof.root_table_opening_proof,
        )
        .is_err(),
        "out-of-range root-table index must reject"
    );
}

#[test]
fn old_flat_manifest_boundary_fails_while_mdu0_path_passes() {
    let ctx = KzgContext::load_from_file(trusted_setup_path()).unwrap();
    let mdu_index = 4096;
    let target_root = test_root(0x99, mdu_index);

    let mut old_roots = vec![[0u8; 32]; 4097];
    old_roots[mdu_index as usize] = target_root;
    let (flat_commitment, flat_manifest_blob) =
        ctx.compute_manifest_commitment(&old_roots).unwrap();
    let (flat_proof, _) = ctx
        .compute_proof(&flat_manifest_blob, &polystore_core::utils::z_for_cell(0))
        .unwrap();
    let old_ok = ctx
        .verify_manifest_inclusion(
            &flat_commitment,
            &target_root,
            mdu_index as usize,
            &flat_proof,
        )
        .unwrap();
    assert!(!old_ok, "old flat manifest verifier rejects mdu_index 4096");

    let mut mdu0 = vec![0u8; MDU_SIZE];
    write_root_table_entry(&mut mdu0, mdu_index, &target_root);
    let polyfs_root = polyfs_root_for_mdu0(&ctx, &mdu0);
    let proof = ctx
        .compute_mdu0_root_table_proof(&mdu0, mdu_index, &target_root)
        .unwrap();
    let new_ok = ctx
        .verify_mdu0_root_table_proof(
            &polyfs_root,
            mdu_index,
            &target_root,
            &proof.root_table_du_commitment,
            &proof.root_table_du_merkle_proof,
            &proof.root_table_opening_proof,
        )
        .unwrap();
    assert!(new_ok, "MDU #0 root-table path verifies mdu_index 4096");
}

#[test]
fn ffi_mdu0_root_table_proof_round_trip_covers_high_index() {
    init_ffi_context();

    let mdu_index = 4097;
    let target_root = test_root(0xab, mdu_index);
    let mut mdu0 = vec![0u8; MDU_SIZE];
    write_root_table_entry(&mut mdu0, mdu_index, &target_root);

    let mut polyfs_root = [0u8; 32];
    assert_eq!(
        polystore_core::ffi::polystore_compute_mdu_merkle_root(
            mdu0.as_ptr(),
            mdu0.len(),
            polyfs_root.as_mut_ptr(),
        ),
        0
    );

    let mut root_table_du_commitment = [0u8; 48];
    let mut root_table_du_merkle_proof = [0u8; 6 * 32];
    let mut root_table_du_merkle_proof_len = root_table_du_merkle_proof.len();
    let mut root_table_opening_proof = [0u8; 48];
    let mut root_table_opening_y = [0u8; 32];

    assert_eq!(
        polystore_core::ffi::polystore_compute_mdu0_root_table_proof(
            mdu0.as_ptr(),
            mdu0.len(),
            mdu_index,
            target_root.as_ptr(),
            root_table_du_commitment.as_mut_ptr(),
            root_table_du_merkle_proof.as_mut_ptr(),
            &mut root_table_du_merkle_proof_len,
            root_table_opening_proof.as_mut_ptr(),
            root_table_opening_y.as_mut_ptr(),
        ),
        0
    );
    assert_eq!(root_table_du_merkle_proof_len, 6 * 32);
    assert_eq!(
        root_table_opening_y,
        encode_mdu_root_for_root_table(&target_root).unwrap()
    );

    assert_eq!(
        polystore_core::ffi::polystore_verify_mdu0_root_table_proof(
            polyfs_root.as_ptr(),
            mdu_index,
            target_root.as_ptr(),
            root_table_du_commitment.as_ptr(),
            root_table_du_merkle_proof.as_ptr(),
            root_table_du_merkle_proof_len,
            root_table_opening_proof.as_ptr(),
        ),
        1
    );

    let mut undersized_merkle_proof = [0u8; 32];
    let mut undersized_merkle_proof_len = undersized_merkle_proof.len();
    assert_eq!(
        polystore_core::ffi::polystore_compute_mdu0_root_table_proof(
            mdu0.as_ptr(),
            mdu0.len(),
            mdu_index,
            target_root.as_ptr(),
            root_table_du_commitment.as_mut_ptr(),
            undersized_merkle_proof.as_mut_ptr(),
            &mut undersized_merkle_proof_len,
            root_table_opening_proof.as_mut_ptr(),
            root_table_opening_y.as_mut_ptr(),
        ),
        -7
    );
    assert_eq!(undersized_merkle_proof_len, 6 * 32);
}

#[test]
#[ignore = "prints local timing/proof-size evidence for issue #214 PR body"]
fn performance_evidence_mdu0_root_table_verifier() {
    let ctx = KzgContext::load_from_file(trusted_setup_path()).unwrap();
    let small_index = 1u64;
    let high_index = 4097u64;
    let small_root = test_root(0xa1, small_index);
    let high_root = test_root(0xa2, high_index);

    let mut mdu0 = vec![0u8; MDU_SIZE];
    write_root_table_entry(&mut mdu0, small_index, &small_root);
    write_root_table_entry(&mut mdu0, high_index, &high_root);
    let polyfs_root = polyfs_root_for_mdu0(&ctx, &mdu0);
    let small_proof = ctx
        .compute_mdu0_root_table_proof(&mdu0, small_index, &small_root)
        .unwrap();
    let high_proof = ctx
        .compute_mdu0_root_table_proof(&mdu0, high_index, &high_root)
        .unwrap();

    let mut old_roots = vec![[0u8; 32]; 2];
    old_roots[small_index as usize] = small_root;
    let (flat_commitment, flat_manifest_blob) =
        ctx.compute_manifest_commitment(&old_roots).unwrap();
    let (flat_proof, _) = ctx
        .compute_proof(
            &flat_manifest_blob,
            &polystore_core::utils::z_for_cell(small_index as usize),
        )
        .unwrap();

    let iterations = 10u32;

    let start = Instant::now();
    for _ in 0..iterations {
        assert!(
            ctx.verify_manifest_inclusion(
                &flat_commitment,
                &small_root,
                small_index as usize,
                &flat_proof,
            )
            .unwrap()
        );
    }
    let old_small_us = start.elapsed().as_micros() as f64 / f64::from(iterations);

    let start = Instant::now();
    for _ in 0..iterations {
        assert!(
            ctx.verify_mdu0_root_table_proof(
                &polyfs_root,
                small_index,
                &small_root,
                &small_proof.root_table_du_commitment,
                &small_proof.root_table_du_merkle_proof,
                &small_proof.root_table_opening_proof,
            )
            .unwrap()
        );
    }
    let new_small_us = start.elapsed().as_micros() as f64 / f64::from(iterations);

    let start = Instant::now();
    for _ in 0..iterations {
        assert!(
            ctx.verify_mdu0_root_table_proof(
                &polyfs_root,
                high_index,
                &high_root,
                &high_proof.root_table_du_commitment,
                &high_proof.root_table_du_merkle_proof,
                &high_proof.root_table_opening_proof,
            )
            .unwrap()
        );
    }
    let new_high_us = start.elapsed().as_micros() as f64 / f64::from(iterations);

    let old_hop1_payload_bytes = 32 + 48;
    let new_hop1_payload_bytes = 32 + 48 + small_proof.root_table_du_merkle_proof.len() + 48;

    println!(
        "old_flat_small_avg_us={old_small_us:.2} new_mdu0_small_avg_us={new_small_us:.2} new_mdu0_high_avg_us={new_high_us:.2}"
    );
    println!(
        "old_hop1_payload_bytes={old_hop1_payload_bytes} new_hop1_payload_bytes={new_hop1_payload_bytes} delta_bytes={}",
        new_hop1_payload_bytes as isize - old_hop1_payload_bytes as isize
    );
}
