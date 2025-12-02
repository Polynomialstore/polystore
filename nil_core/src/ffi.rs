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

    match KzgContext::load_from_file(path_str) {
        Ok(ctx) => {
             // We ignore the result because if it fails, it means it was set concurrently
             let _ = KZG_CTX.set(ctx);
             0
        },
        Err(_) => -3 // Failed to load
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_verify_proof(
    commitment: *const u8,
    z: *const u8,
    y: *const u8,
    proof: *const u8
) -> c_int {
    let ctx = match KZG_CTX.get() {
        Some(c) => c,
        None => return -1, // Not initialized
    };

    if commitment.is_null() || z.is_null() || y.is_null() || proof.is_null() {
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
        Err(_) => -3, // Internal error
    }
}
