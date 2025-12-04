use nil_core::kzg::{KzgContext, c_kzg};
use std::path::PathBuf;
use hex;

fn main() {
    let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    path.pop(); // nil_core/
    path.push("demos");
    path.push("kzg");
    path.push("trusted_setup.txt");

    if !path.exists() {
        eprintln!("Trusted setup not found at {:?}", path);
        return;
    }

    let ctx = KzgContext::load_from_file(&path).expect("Failed to load trusted setup");

    // Create a blob (128 KiB)
    // 4096 field elements * 32 bytes = 131,072 bytes.
    // c_kzg::BYTES_PER_BLOB should now reflect this.
    let mut blob_bytes = [0u8; c_kzg::BYTES_PER_BLOB];
    blob_bytes[0] = 42; 
    blob_bytes[32] = 69; 

    // Commit
    let commitment = ctx.blob_to_commitment(&blob_bytes).expect("Commit failed");
    let commitment_bytes = commitment.to_bytes();

    // Point to evaluate at (z)
    let mut z_bytes = [0u8; 32];
    z_bytes[0] = 10; // z = 10

    // Compute proof
    let (proof, y) = ctx.compute_proof(&blob_bytes, &z_bytes).expect("Compute proof failed");
    let proof_bytes = proof.to_bytes();
    let y_bytes = y.as_slice();

    // Verify locally to be sure
    let valid = ctx.verify_proof(
        commitment_bytes.as_slice(),
        &z_bytes,
        y_bytes,
        proof_bytes.as_slice()
    ).expect("Local verification failed");

    if valid {
        println!("Generated VALID Proof (128KB):");
        println!("Commitment: {}", hex::encode(commitment_bytes.as_slice()));
        println!("Z:          {}", hex::encode(z_bytes));
        println!("Y:          {}", hex::encode(y_bytes));
        println!("Proof:      {}", hex::encode(proof_bytes.as_slice()));
    } else {
        println!("Generated proof failed local verification!");
    }
}
