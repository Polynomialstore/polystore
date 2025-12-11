use nil_core::kzg::{KzgContext, BLOB_SIZE};
use nil_core::utils::{z_for_cell, frs_to_blobs};
use std::path::PathBuf;
use num_bigint::BigUint;
use num_traits::One;

fn get_trusted_setup_path() -> PathBuf {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // Go up to root
    path.push("demos");
    path.push("kzg");
    path.push("trusted_setup.txt");
    path
}

#[test]
fn test_end_to_end_fix() {
    let path = get_trusted_setup_path();
    let ctx = KzgContext::load_from_file(&path).unwrap();

    // 1. Create input evaluations (Fr elements)
    // P(omega^0) = 1, rest = 0.
    let mut frs = Vec::with_capacity(4096);
    frs.push(BigUint::one());
    for _ in 1..4096 {
        frs.push(BigUint::from(0u32));
    }
    
    // 2. Convert to Blob using the FIXED utils function (now BE)
    let blobs = frs_to_blobs(&frs);
    let blob_bytes = &blobs[0];

    // 3. Generate z for index 0 using the FIXED utils function (now BE)
    let z_bytes = z_for_cell(0);
    
    // 4. Compute Proof
    println!("Computing proof for BE Blob (from frs_to_blobs) at BE z (from z_for_cell)...");
    let (_, y_out) = ctx.compute_proof(blob_bytes, &z_bytes).expect("proof failed");
    
    println!("y_out: {:?}", y_out.as_slice());
    println!("y_out hex: {}", hex::encode(y_out.as_slice()));
    
    // 5. Expect y = 1 (BE) -> [0...01]
    let mut expected_y = [0u8; 32];
    expected_y[31] = 1;
    
    assert_eq!(y_out.as_slice(), &expected_y, "y should be 1 (BE)");
    println!("SUCCESS: End-to-End verification passed!");
}
