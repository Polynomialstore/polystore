use crate::kzg::{KzgContext, BLOB_SIZE, BLOBS_PER_MDU}; // Added BLOB_SIZE back
use libc::{c_char, c_int};
use std::ffi::CStr;
use std::sync::OnceLock;

static KZG_CTX: OnceLock<KzgContext> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "C" fn nil_init(trusted_setup_path: *const c_char) -> c_int {
    if trusted_setup_path.is_null() {
        return -1; // Null path
    }
    
    // Check if already initialized
    if KZG_CTX.get().is_some() {
        return 0; // Already initialized, consider it success
    }

    let c_str = unsafe { CStr::from_ptr(trusted_setup_path) };
    let path_str = match c_str.to_str() {
        Ok(s) => s,
        Err(_) => return -2, // Invalid UTF-8 in path
    };
    
    // println!("DEBUG: nil_init called with path: {}", path_str);

    match KzgContext::load_from_file(path_str) {
        Ok(ctx) => {
             // println!("DEBUG: KzgContext loaded successfully");
             let _ = KZG_CTX.set(ctx); // Ignore error if set concurrently
             0
        },
        Err(e) => {
            eprintln!("ERROR: Failed to load KzgContext: {:?}", e); // Use eprintln for errors
            -3 // Failed to load
        }
    }
}

/// Computes the Merkle root of KZG commitments for an 8 MiB MDU.
/// Input `mdu_bytes` must be exactly 8 MiB. Output `mdu_merkle_root` must be 32 bytes.
#[unsafe(no_mangle)]
pub extern "C" fn nil_compute_mdu_merkle_root(
    mdu_bytes: *const u8,
    mdu_bytes_len: usize,
    out_mdu_merkle_root: *mut u8,
) -> c_int {
    let ctx = match KZG_CTX.get() {
        Some(c) => c,
        None => return -1, // Not initialized
    };

    if mdu_bytes.is_null() || out_mdu_merkle_root.is_null() || mdu_bytes_len != crate::kzg::MDU_SIZE {
        return -2; // Invalid inputs
    }

    let mdu_slice = unsafe { std::slice::from_raw_parts(mdu_bytes, mdu_bytes_len) };

    match ctx.mdu_to_kzg_commitments(mdu_slice) {
        Ok(commitments) => match ctx.create_mdu_merkle_root(&commitments) {
            Ok(root) => {
                unsafe {
                    std::ptr::copy_nonoverlapping(root.as_slice().as_ptr(), out_mdu_merkle_root, 32);
                }
                0 // Success
            },
            Err(e) => {
                eprintln!("ERROR: Failed to create MDU Merkle root: {:?}", e);
                -4 // Merkle root creation failed
            }
        },
        Err(e) => {
            eprintln!("ERROR: Failed to get KZG commitments for MDU: {:?}", e);
            -3 // Commitment calculation failed
        }
    }
}


/// Verifies a KZG proof for a single 128 KiB blob within an MDU, including Merkle proof verification.
#[unsafe(no_mangle)]
pub extern "C" fn nil_verify_mdu_proof(
    mdu_merkle_root: *const u8,                // 32-byte MDU Merkle Root
    challenged_kzg_commitment: *const u8,      // 48-byte KZG commitment of the challenged blob
    merkle_path_bytes: *const u8,              // Serialized Merkle path
    merkle_path_len: usize,                    // Length of serialized Merkle path
    challenged_kzg_commitment_index: u32,      // Index of the challenged blob (0-63)
    z_value: *const u8,                        // 32-byte challenge point
    y_value: *const u8,                        // 32-byte claimed value
    kzg_opening_proof: *const u8,              // 48-byte KZG opening proof
) -> c_int {
    let ctx = match KZG_CTX.get() {
        Some(c) => c,
        None => return -1, // Not initialized
    };

    // Input validation for lengths and null pointers
    if mdu_merkle_root.is_null() || challenged_kzg_commitment.is_null() ||
       merkle_path_bytes.is_null() || z_value.is_null() ||
       y_value.is_null() || kzg_opening_proof.is_null() {
        return -2; // Null pointers
    }

    // Convert inputs to Rust slices/types
    let mdu_merkle_root_slice = unsafe { std::slice::from_raw_parts(mdu_merkle_root, 32) };
    let challenged_kzg_commitment_slice = unsafe { std::slice::from_raw_parts(challenged_kzg_commitment, 48) };
    let merkle_path_slice = unsafe { std::slice::from_raw_parts(merkle_path_bytes, merkle_path_len) };
    let z_value_slice = unsafe { std::slice::from_raw_parts(z_value, 32) };
    let y_value_slice = unsafe { std::slice::from_raw_parts(y_value, 32) };
    let kzg_opening_proof_slice = unsafe { std::slice::from_raw_parts(kzg_opening_proof, 48) };

    // 1. Verify Merkle Proof
    match crate::kzg::KzgContext::verify_mdu_merkle_proof(
        mdu_merkle_root_slice,
        challenged_kzg_commitment_slice,
        challenged_kzg_commitment_index as usize,
        merkle_path_slice,
        BLOBS_PER_MDU,
    ) {
        Ok(true) => { /* Merkle proof valid, proceed to KZG verification */ },
        Ok(false) => {
            eprintln!("ERROR: Merkle proof invalid.");
            return 0; // Merkle proof invalid
        },
        Err(e) => {
            eprintln!("ERROR: Merkle proof verification error: {:?}", e);
            return -3; // Internal Merkle proof error
        }
    }

    // 2. Verify KZG Proof for the challenged commitment
    match ctx.verify_proof(
        challenged_kzg_commitment_slice,
        z_value_slice,
        y_value_slice,
        kzg_opening_proof_slice,
    ) {
        Ok(true) => 1, // Both proofs valid
        Ok(false) => {
            eprintln!("ERROR: KZG opening proof invalid.");
            0 // KZG proof invalid
        },
        Err(e) => {
            eprintln!("ERROR: KZG verification error: {:?}", e);
            -4 // Internal KZG verification error
        }
    }
}

/// TEST HELPER: Computes a full MDU proof for a given chunk index.
/// This is exposed primarily for integration testing to generate valid proofs.
/// 
/// Outputs:
/// - out_commitment: 48 bytes
/// - out_merkle_proof: buffer size sufficient for path (e.g. 6 * 32 bytes)
/// - out_merkle_proof_len: actual length written
/// - out_z: 32 bytes (challenge point)
/// - out_y: 32 bytes (evaluation)
/// - out_kzg_proof: 48 bytes
#[unsafe(no_mangle)]
pub extern "C" fn nil_compute_mdu_proof_test(
    mdu_bytes: *const u8,
    mdu_bytes_len: usize,
    chunk_index: u32,
    // Outputs
    out_commitment: *mut u8,
    out_merkle_proof: *mut u8,
    out_merkle_proof_len: *mut usize, // In/Out: capacity/actual
    out_z: *mut u8,
    out_y: *mut u8,
    out_kzg_proof: *mut u8,
) -> c_int {
    let ctx = match KZG_CTX.get() {
        Some(c) => c,
        None => return -1, // Not initialized
    };

    if mdu_bytes.is_null() || mdu_bytes_len != crate::kzg::MDU_SIZE {
        return -2;
    }

    let mdu_slice = unsafe { std::slice::from_raw_parts(mdu_bytes, mdu_bytes_len) };
    let idx = chunk_index as usize;
    if idx >= BLOBS_PER_MDU {
        return -5; // Invalid index
    }

    // 1. Commitments & Merkle Tree
    let commitments = match ctx.mdu_to_kzg_commitments(mdu_slice) {
        Ok(c) => c,
        Err(_) => return -3,
    };
    
    use rs_merkle::MerkleTree;
    use crate::kzg::Blake2s256Hasher;
    use rs_merkle::Hasher; // Import Hasher trait for .hash()

    let leaves: Vec<[u8; 32]> = commitments.iter()
            .map(|c| Blake2s256Hasher::hash(c.as_slice()))
            .collect();
    let merkle_tree = MerkleTree::<Blake2s256Hasher>::from_leaves(&leaves);
    let merkle_proof = merkle_tree.proof(&[idx]);
    let proof_bytes = merkle_proof.to_bytes(); // Should be already flattened
    
    // Copy Outputs
    // 1. Commitment
    unsafe {
        std::ptr::copy_nonoverlapping(commitments[idx].as_slice().as_ptr(), out_commitment, 48);
    }

    // 2. Merkle Proof
    let proof_len = proof_bytes.len();
    unsafe {
        if *out_merkle_proof_len < proof_len {
            return -7; // Buffer too small
        }
        std::ptr::copy_nonoverlapping(proof_bytes.as_ptr(), out_merkle_proof, proof_len);
        *out_merkle_proof_len = proof_len;
    }

    // 3. KZG Proof (Blob + Z)
    // For testing, we just pick Z = hash(blob) or something simple, OR just a fixed point.
    // Let's pick a random point.
    let mut z_bytes = [0u8; 32];
    z_bytes[0] = 42; // Deterministic for now
    z_bytes[1] = chunk_index as u8;

    // Get blob data
    let start = idx * BLOB_SIZE;
    let blob_slice = &mdu_slice[start..start + BLOB_SIZE];

    let (proof, y) = match ctx.compute_proof(blob_slice, &z_bytes) {
        Ok(res) => res,
        Err(_) => return -8,
    };

    unsafe {
        std::ptr::copy_nonoverlapping(z_bytes.as_ptr(), out_z, 32);
        std::ptr::copy_nonoverlapping(y.as_slice().as_ptr(), out_y, 32);
        std::ptr::copy_nonoverlapping(proof.as_slice().as_ptr(), out_kzg_proof, 48);
    }

    0 // Success
}
