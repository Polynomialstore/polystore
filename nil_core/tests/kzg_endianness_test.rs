use nil_core::kzg::{BLOB_SIZE, KzgContext};
use nil_core::utils::{frs_to_blobs, z_for_cell};
use num_bigint::BigUint;
use num_traits::One;
use std::path::PathBuf;

fn get_trusted_setup_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // Go up to root
    path.push("demos");
    path.push("kzg");
    path.push("trusted_setup.txt");
    path
}

#[test]
fn test_kzg_big_endian_compatibility() {
    // This test ensures that nil_core generates Blobs and evaluation points (z)
    // in the Big Endian format expected by the c-kzg library (v2.1.5) and the trusted setup.
    // Regression test for the "Slashing Issue" where LE encoding caused verification failures.

    let path = get_trusted_setup_path();
    let ctx = KzgContext::load_from_file(&path).unwrap();

    // 1. Create input evaluations (Fr elements)
    // Polynomial P(x) such that P(omega^0) = 1, and P(omega^i) = 0 for i > 0.
    // This effectively tests that index 0 maps to z=1 correctly in the committed blob.
    let mut frs = Vec::with_capacity(4096);
    frs.push(BigUint::one());
    for _ in 1..4096 {
        frs.push(BigUint::from(0u32));
    }

    // 2. Convert to Blob using utils::frs_to_blobs (which must use BE)
    let blobs = frs_to_blobs(&frs);
    let blob_bytes = &blobs[0];

    // 3. Generate z for index 0 using utils::z_for_cell (which must use BE)
    // Index 0 -> z = 1 (in BE: 00...01)
    let z_bytes = z_for_cell(0);

    // 4. Compute Proof
    let (_, y_out) = ctx
        .compute_proof(blob_bytes, &z_bytes)
        .expect("proof failed");

    // 5. Expect y = 1 (BE) -> [0...01]
    let mut expected_y = [0u8; 32];
    expected_y[31] = 1;

    assert_eq!(
        y_out.as_slice(),
        &expected_y,
        "y should be 1 (BE). Mismatch indicates Endianness or Domain issue."
    );
}

#[test]
fn test_constant_polynomial_all_ones() {
    // Verifies that a blob of all 1s is interpreted as evaluations P(omega^i) = 1,
    // resulting in P(z) = 1 for any z.
    let path = get_trusted_setup_path();
    let ctx = KzgContext::load_from_file(&path).unwrap();

    let mut blob_bytes = [0u8; BLOB_SIZE];
    for i in 0..4096 {
        let offset = i * 32;
        // Big Endian 1: [0, 0, ... 1]
        blob_bytes[offset + 31] = 1;
    }

    // z = 1 (Index 0)
    let z_bytes = z_for_cell(0);

    let (_, y_out) = ctx
        .compute_proof(&blob_bytes, &z_bytes)
        .expect("compute_proof failed");

    let mut expected_y = [0u8; 32];
    expected_y[31] = 1;

    assert_eq!(
        y_out.as_slice(),
        &expected_y,
        "y should be 1 for constant polynomial"
    );
}

#[test]
fn test_manifest_inclusion_round_trip() {
    let path = get_trusted_setup_path();
    let ctx = KzgContext::load_from_file(&path).unwrap();

    // Use a non-canonical 32-byte value (looks like a hash) to ensure reduction logic is exercised.
    let root = [0x42u8; 32];
    let (commitment, manifest_blob) = ctx.compute_manifest_commitment(&[root]).unwrap();

    let z_bytes = z_for_cell(0);
    let (proof, y_out) = ctx.compute_proof(&manifest_blob, &z_bytes).unwrap();

    // Index 0 maps to z = 1. The opening value should equal the first evaluation.
    assert_eq!(y_out, root, "manifest opening y must match root bytes (BE)");

    let ok_direct = ctx
        .verify_proof(&commitment, &z_bytes, &y_out, &proof)
        .unwrap();
    assert!(ok_direct, "direct KZG proof verification must succeed");

    let ok = ctx
        .verify_manifest_inclusion(&commitment, &root, 0, &proof)
        .unwrap();
    assert!(ok, "manifest inclusion must verify for index 0");
}
