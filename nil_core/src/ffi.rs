use crate::kzg::KzgContext;
use libc::{c_char, c_int};
use std::ffi::CStr;
use std::sync::OnceLock;

static KZG_CTX: OnceLock<KzgContext> = OnceLock::new();

#[unsafe(no_mangle)]
pub extern "C" fn nil_init(trusted_setup_path: *const c_char) -> c_int {
    if trusted_setup_path.is_null() {
        return -1;
    }
    
    // Check if already initialized
    if KZG_CTX.get().is_some() {
        return 0; // Already initialized
    }

    let c_str = unsafe { CStr::from_ptr(trusted_setup_path) };
    let path_str = match c_str.to_str() {
        Ok(s) => s,
        Err(_) => return -2, // Invalid UTF-8
    };
    
    println!("DEBUG: nil_init called with path: {}", path_str);

    match KzgContext::load_from_file(path_str) {
        Ok(ctx) => {
             println!("DEBUG: KzgContext loaded successfully");
             // We ignore the result because if it fails, it means it was set concurrently
             let _ = KZG_CTX.set(ctx);
             0
        },
        Err(e) => {
            println!("DEBUG: Failed to load KzgContext: {:?}", e);
            -3
        } // Failed to load
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_verify_proof(
    commitment: *const u8,
    z: *const u8,
    y: *const u8,
    proof: *const u8
) -> c_int {
    println!("DEBUG: nil_verify_proof called");
    
    let ctx = match KZG_CTX.get() {
        Some(c) => {
            println!("DEBUG: KZG_CTX found");
            c
        },
        None => {
            println!("DEBUG: KZG_CTX NOT found (uninitialized)");
            return -1; // Not initialized
        }
    };

    if commitment.is_null() || z.is_null() || y.is_null() || proof.is_null() {
        println!("DEBUG: One or more input pointers are null");
        return -2; // Null pointers
    }

    // Standard KZG sizes
    // Commitment: 48 bytes (G1)
    // z: 32 bytes (Scalar)
    // y: 32 bytes (Scalar)
    // Proof: 48 bytes (G1)

    let commitment_slice = unsafe { std::slice::from_raw_parts(commitment, 48) };
    let z_slice = unsafe { std::slice::from_raw_parts(z, 32) };
    let y_slice = unsafe { std::slice::from_raw_parts(y, 32) };
    let proof_slice = unsafe { std::slice::from_raw_parts(proof, 48) };

    match ctx.verify_proof(commitment_slice, z_slice, y_slice, proof_slice) {
        Ok(true) => 1,
        Ok(false) => 0,
        Err(e) => {
            println!("DEBUG: nil_verify_proof error: {:?}", e);
            -3
        }, // Internal error
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_blob_to_commitment(
    blob: *const u8,
    out_commitment: *mut u8
) -> c_int {
    let ctx = match KZG_CTX.get() {
        Some(c) => c,
        None => return -1, // Not initialized
    };

    if blob.is_null() || out_commitment.is_null() {
        return -2;
    }

    // Blob size is fixed at compile time (EIP-4844 = 131072 bytes)
    let blob_slice = unsafe { std::slice::from_raw_parts(blob, crate::utils::BYTES_PER_BLOB) };

    match ctx.blob_to_commitment(blob_slice) {
        Ok(c) => {
            let bytes = c.to_bytes();
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_commitment, 48);
            }
            0 // Success
        },
        Err(e) => {
            println!("DEBUG: blob_to_commitment error: {:?}", e);
            -3
        }
    }
}
