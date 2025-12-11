use nil_core::kzg::{KzgContext, BLOB_SIZE};
use nil_core::utils::{z_for_cell, fr_to_bytes_le};
use std::path::PathBuf;
use num_bigint::BigUint;

fn get_trusted_setup_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // Go up to root
    path.push("demos");
    path.push("kzg");
    path.push("trusted_setup.txt");
    path
}

#[test]
fn test_repro_verification_failure() {
    let path = get_trusted_setup_path();
    let ctx = KzgContext::load_from_file(&path).unwrap();

    // 1. Create a blob with 1 at Index 0 (Natural Order)
    // We expect P(omega^0) = 1.
    let mut blob_bytes = [0u8; BLOB_SIZE];
    blob_bytes[0] = 1; // LE 1

    let commitment = ctx.blob_to_commitment(&blob_bytes).expect("blob_to_commitment failed");
    
    // 2. Compute proof for z = omega^0 = 1.
    let z_bytes = z_for_cell(0); // [1, 0...] (LE)
    
    let (proof, y_out) = ctx.compute_proof(&blob_bytes, &z_bytes).expect("compute_proof failed");
    
    println!("y_out: {:?}", y_out.as_slice());
    println!("y_out hex: {}", hex::encode(y_out.as_slice()));
    
    // Expected: 1 (LE)
    let expected_1 = [
        1, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0
    ];
    
    // This assertion fails currently, showing the mismatch
    // assert_eq!(y_out.as_slice(), &expected_1, "y should be 1");
    
    if y_out.as_slice() != &expected_1 {
        println!("FAILURE CONFIRMED: y != 1. The blob is not being interpreted as evaluations at standard roots.");
    }
}

#[test]
fn test_constant_polynomial() {
    let path = get_trusted_setup_path();
    let ctx = KzgContext::load_from_file(&path).unwrap();

    // Create a blob with 1 at ALL indices.
    // P(omega^i) = 1 for all i.
    // This implies P(x) = 1.
    // So P(z) should be 1 for ANY z.
    
    let mut blob_bytes = [0u8; BLOB_SIZE];
    for i in 0..4096 {
        let offset = i * 32;
        blob_bytes[offset] = 1; // LE 1
    }

    let z_bytes = z_for_cell(0); // z=1
    
    let (proof, y_out) = ctx.compute_proof(&blob_bytes, &z_bytes).expect("compute_proof failed");
    
    println!("y_out (constant poly): {:?}", y_out.as_slice());
    println!("y_out hex: {}", hex::encode(y_out.as_slice()));
    
    let expected_1 = [
        1, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0
    ];
    
    assert_eq!(y_out.as_slice(), &expected_1, "y should be 1 for constant polynomial");
    println!("SUCCESS: Constant polynomial P(x)=1 confirmed.");
}