use crate::kzg::{BLOB_SIZE, BLOBS_PER_MDU, KzgContext}; // Added BLOB_SIZE back
use libc::{c_char, c_int};
use std::ffi::CStr;
use std::sync::OnceLock;
use crate::builder::Mdu0Builder;
use crate::layout::{FileRecordV1, pack_length_and_flags};

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
        }
        Err(_e) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Failed to load KzgContext");
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

    if mdu_bytes.is_null() || out_mdu_merkle_root.is_null() || mdu_bytes_len != crate::kzg::MDU_SIZE
    {
        return -2; // Invalid inputs
    }

    let mdu_slice = unsafe { std::slice::from_raw_parts(mdu_bytes, mdu_bytes_len) };

    match ctx.mdu_to_kzg_commitments(mdu_slice) {
        Ok(commitments) => match ctx.create_mdu_merkle_root(&commitments) {
            Ok(root) => {
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        root.as_slice().as_ptr(),
                        out_mdu_merkle_root,
                        32,
                    );
                }
                0 // Success
            }
            Err(_e) => {
                eprintln!("ERROR: Failed to create MDU Merkle root");
                -4 // Merkle root creation failed
            }
        },
        Err(_e) => {
            eprintln!("ERROR: Failed to get KZG commitments for MDU");
            -3 // Commitment calculation failed
        }
    }
}

/// Verifies a KZG proof for a single 128 KiB blob within an MDU, including Merkle proof verification.
#[unsafe(no_mangle)]
pub extern "C" fn nil_verify_mdu_proof(
    mdu_merkle_root: *const u8,           // 32-byte MDU Merkle Root
    challenged_kzg_commitment: *const u8, // 48-byte KZG commitment of the challenged blob
    merkle_path_bytes: *const u8,         // Serialized Merkle path
    merkle_path_len: usize,               // Length of serialized Merkle path
    challenged_kzg_commitment_index: u32, // Index of the challenged blob (0-63)
    leaf_count: u64,                      // Number of leaves in the MDU Merkle tree
    z_value: *const u8,                   // 32-byte challenge point
    y_value: *const u8,                   // 32-byte claimed value
    kzg_opening_proof: *const u8,         // 48-byte KZG opening proof
) -> c_int {
    let ctx = match KZG_CTX.get() {
        Some(c) => c,
        None => return -1, // Not initialized
    };

    // Input validation for lengths and null pointers
    if mdu_merkle_root.is_null()
        || challenged_kzg_commitment.is_null()
        || merkle_path_bytes.is_null()
        || z_value.is_null()
        || y_value.is_null()
        || kzg_opening_proof.is_null()
    {
        return -2; // Null pointers
    }

    // Convert inputs to Rust slices/types
    let mdu_merkle_root_slice = unsafe { std::slice::from_raw_parts(mdu_merkle_root, 32) };
    let challenged_kzg_commitment_slice =
        unsafe { std::slice::from_raw_parts(challenged_kzg_commitment, 48) };
    let merkle_path_slice =
        unsafe { std::slice::from_raw_parts(merkle_path_bytes, merkle_path_len) };
    let z_value_slice = unsafe { std::slice::from_raw_parts(z_value, 32) };
    let y_value_slice = unsafe { std::slice::from_raw_parts(y_value, 32) };
    let kzg_opening_proof_slice = unsafe { std::slice::from_raw_parts(kzg_opening_proof, 48) };

    // 1. Verify Merkle Proof
    match crate::kzg::KzgContext::verify_mdu_merkle_proof(
        mdu_merkle_root_slice,
        challenged_kzg_commitment_slice,
        challenged_kzg_commitment_index as usize,
        merkle_path_slice,
        leaf_count as usize,
    ) {
        Ok(true) => { /* Merkle proof valid, proceed to KZG verification */ }
        Ok(false) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Merkle proof invalid.");
            return 0; // Merkle proof invalid
        }
        Err(_e) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Merkle proof verification error");
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
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: KZG opening proof invalid.");
            0 // KZG proof invalid
        }
        Err(_e) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: KZG verification error");
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

    use crate::kzg::Blake2s256Hasher;
    use rs_merkle::Hasher;
    use rs_merkle::MerkleTree; // Import Hasher trait for .hash()

    let leaves: Vec<[u8; 32]> = commitments
        .iter()
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

/// Computes the Manifest Root (KZG Commitment) and the Manifest MDU (Blob)
/// from a list of MDU Merkle Roots (32-byte hashes).
///
/// Inputs:
/// - hashes_ptr: Pointer to contiguous array of 32-byte hashes.
/// - num_hashes: Number of hashes.
///
/// Outputs:
/// - out_commitment: Buffer for 48-byte KZG Commitment.
/// - out_manifest_blob: Buffer for 128 KiB Manifest MDU.
#[unsafe(no_mangle)]
pub extern "C" fn nil_compute_manifest_commitment(
    hashes_ptr: *const u8,
    num_hashes: usize,
    out_commitment: *mut u8,
    out_manifest_blob: *mut u8,
) -> c_int {
    let ctx = match KZG_CTX.get() {
        Some(c) => c,
        None => return -1, // Not initialized
    };

    if hashes_ptr.is_null() || out_commitment.is_null() || out_manifest_blob.is_null() {
        return -2;
    }

    // Convert raw pointer to slice of [u8; 32]
    let total_bytes = num_hashes * 32;
    let hashes_slice = unsafe { std::slice::from_raw_parts(hashes_ptr, total_bytes) };

    let mut hashes = Vec::with_capacity(num_hashes);
    for chunk in hashes_slice.chunks_exact(32) {
        let mut arr = [0u8; 32];
        arr.copy_from_slice(chunk);
        hashes.push(arr);
    }

    match ctx.compute_manifest_commitment(&hashes) {
        Ok((commitment, blob)) => {
            unsafe {
                std::ptr::copy_nonoverlapping(commitment.as_slice().as_ptr(), out_commitment, 48);
                std::ptr::copy_nonoverlapping(
                    blob.as_ptr(),
                    out_manifest_blob,
                    crate::kzg::BLOB_SIZE,
                );
            }
            0
        }
        Err(_e) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Failed to compute manifest");
            -3
        }
    }
}

/// Computes a KZG proof for a specific MDU inclusion in the Manifest.
///
/// Inputs:
/// - manifest_blob_ptr: Pointer to 128 KiB Manifest MDU data.
/// - mdu_index: Index of the MDU in the manifest.
///
/// Outputs:
/// - out_proof: Buffer for 48-byte KZG Proof.
/// - out_y: Buffer for 32-byte Value (MDU Root).
#[unsafe(no_mangle)]
pub extern "C" fn nil_compute_manifest_proof(
    manifest_blob_ptr: *const u8,
    mdu_index: u64,
    out_proof: *mut u8,
    out_y: *mut u8,
) -> c_int {
    let ctx = match KZG_CTX.get() {
        Some(c) => c,
        None => return -1, // Not initialized
    };

    if manifest_blob_ptr.is_null() || out_proof.is_null() || out_y.is_null() {
        return -2;
    }

    let manifest_blob =
        unsafe { std::slice::from_raw_parts(manifest_blob_ptr, crate::kzg::BLOB_SIZE) };

    // Calculate z (evaluation point) from the index
    let z_bytes = crate::utils::z_for_cell(mdu_index as usize);

    match ctx.compute_proof(manifest_blob, &z_bytes) {
        Ok((proof, y)) => {
            unsafe {
                std::ptr::copy_nonoverlapping(proof.as_slice().as_ptr(), out_proof, 48);
                std::ptr::copy_nonoverlapping(y.as_slice().as_ptr(), out_y, 32);
            }
            0
        }
        Err(_e) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Failed to compute manifest proof");
            -3
        }
    }
}

/// Computes a KZG opening proof for a single 128 KiB blob.
///
/// Inputs:
/// - blob_ptr: Pointer to 128 KiB blob bytes (encoded).
/// - blob_len: Must equal BLOB_SIZE (131072).
/// - z_ptr: Pointer to 32-byte evaluation point.
///
/// Outputs:
/// - out_proof: Buffer for 48-byte KZG proof.
/// - out_y: Buffer for 32-byte evaluation.
#[unsafe(no_mangle)]
pub extern "C" fn nil_compute_blob_proof(
    blob_ptr: *const u8,
    blob_len: usize,
    z_ptr: *const u8,
    out_proof: *mut u8,
    out_y: *mut u8,
) -> c_int {
    let ctx = match KZG_CTX.get() {
        Some(c) => c,
        None => return -1, // Not initialized
    };

    if blob_ptr.is_null() || z_ptr.is_null() || out_proof.is_null() || out_y.is_null() {
        return -2;
    }
    if blob_len != crate::kzg::BLOB_SIZE {
        return -4;
    }

    let blob = unsafe { std::slice::from_raw_parts(blob_ptr, blob_len) };
    let z_slice = unsafe { std::slice::from_raw_parts(z_ptr, 32) };
    let mut z_bytes = [0u8; 32];
    z_bytes.copy_from_slice(z_slice);

    match ctx.compute_proof(blob, &z_bytes) {
        Ok((proof, y)) => {
            unsafe {
                std::ptr::copy_nonoverlapping(proof.as_slice().as_ptr(), out_proof, 48);
                std::ptr::copy_nonoverlapping(y.as_slice().as_ptr(), out_y, 32);
            }
            0
        }
        Err(_e) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Failed to compute blob proof");
            -3
        }
    }
}

/// Verifies a "Triple Proof" (Chained Verification).
///
/// Hop 1: Verify MDU Root is in Manifest (KZG).
/// Hop 2: Verify Blob Commitment is in MDU (Merkle).
/// Hop 3: Verify Data is in Blob (KZG).
#[unsafe(no_mangle)]
pub extern "C" fn nil_verify_chained_proof(
    // Hop 1 Inputs
    manifest_commitment: *const u8, // 48 bytes
    mdu_index: u64,                 // Index of MDU in Manifest
    manifest_proof: *const u8,      // 48 bytes (KZG proof for MDU Root)

    // Intermediate / Hop 2 Input
    mdu_merkle_root: *const u8, // 32 bytes (The "Value" for Hop 1, Root for Hop 2)

    // Hop 2 Inputs
    blob_commitment: *const u8,   // 48 bytes
    blob_index: u64,              // Index of Blob in MDU
    leaf_count: u64,              // Number of leaves in the MDU Merkle tree
    blob_merkle_proof: *const u8, // Serialized Merkle path
    blob_merkle_proof_len: usize,

    // Hop 3 Inputs
    blob_z: *const u8,     // 32 bytes
    blob_y: *const u8,     // 32 bytes
    blob_proof: *const u8, // 48 bytes
) -> c_int {
    let ctx = match KZG_CTX.get() {
        Some(c) => c,
        None => return -1, // Not initialized
    };

    if manifest_commitment.is_null()
        || manifest_proof.is_null()
        || mdu_merkle_root.is_null()
        || blob_commitment.is_null()
        || blob_merkle_proof.is_null()
        || blob_z.is_null()
        || blob_y.is_null()
        || blob_proof.is_null()
    {
        return -2;
    }

    // Convert Pointers to Slices
    let manifest_commitment_slice = unsafe { std::slice::from_raw_parts(manifest_commitment, 48) };
    let manifest_proof_slice = unsafe { std::slice::from_raw_parts(manifest_proof, 48) };
    let mdu_merkle_root_slice = unsafe { std::slice::from_raw_parts(mdu_merkle_root, 32) };
    let blob_commitment_slice = unsafe { std::slice::from_raw_parts(blob_commitment, 48) };
    let blob_merkle_proof_slice =
        unsafe { std::slice::from_raw_parts(blob_merkle_proof, blob_merkle_proof_len) };
    let blob_z_slice = unsafe { std::slice::from_raw_parts(blob_z, 32) };
    let blob_y_slice = unsafe { std::slice::from_raw_parts(blob_y, 32) };
    let blob_proof_slice = unsafe { std::slice::from_raw_parts(blob_proof, 48) };

    // --- Hop 1: Verify Manifest Inclusion ---
    // Verify that 'mdu_merkle_root' is indeed the value at 'mdu_index' in 'manifest_commitment'
    match ctx.verify_manifest_inclusion(
        manifest_commitment_slice,
        mdu_merkle_root_slice,
        mdu_index as usize,
        manifest_proof_slice,
    ) {
        Ok(true) => {}
        Ok(false) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Hop 1 (Manifest) verification failed.");
            return 0;
        }
        Err(_e) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Hop 1 error");
            return -3;
        }
    }

    // --- Hop 2: Verify Blob Commitment is in MDU Merkle Tree ---
    match crate::kzg::KzgContext::verify_mdu_merkle_proof(
        mdu_merkle_root_slice,
        blob_commitment_slice,
        blob_index as usize,
        blob_merkle_proof_slice,
        leaf_count as usize,
    ) {
        Ok(true) => {}
        Ok(false) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Hop 2 (Merkle) verification failed.");
            return 0;
        }
        Err(_e) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Hop 2 error");
            return -4;
        }
    }

    // --- Hop 3: Verify Data Inclusion in Blob (KZG) ---
    match ctx.verify_proof(
        blob_commitment_slice,
        blob_z_slice,
        blob_y_slice,
        blob_proof_slice,
    ) {
        Ok(true) => 1, // Success!
        Ok(false) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Hop 3 (Blob KZG) verification failed.");
            0
        }
        Err(_e) => {
            #[cfg(feature = "debug-print")]
            eprintln!("ERROR: Hop 3 error");
            -5
        }
    }
}

// --- Layout FFI ---

#[unsafe(no_mangle)]
pub extern "C" fn nil_mdu0_builder_new(max_user_mdus: u64) -> *mut Mdu0Builder {
    let builder = Mdu0Builder::new(max_user_mdus);
    Box::into_raw(Box::new(builder))
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_mdu0_builder_free(ptr: *mut Mdu0Builder) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let _ = Box::from_raw(ptr);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_mdu0_builder_load(data_ptr: *const u8, len: usize, max_user_mdus: u64) -> *mut Mdu0Builder {
    if data_ptr.is_null() || len != crate::builder::MDU_SIZE {
        return std::ptr::null_mut();
    }
    let slice = unsafe { std::slice::from_raw_parts(data_ptr, len) };
    match Mdu0Builder::load(slice, max_user_mdus) {
        Ok(builder) => Box::into_raw(Box::new(builder)),
        Err(_) => std::ptr::null_mut(),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_mdu0_builder_bytes(ptr: *mut Mdu0Builder, out_ptr: *mut u8, out_len: usize) -> c_int {
    if ptr.is_null() || out_ptr.is_null() || out_len != crate::builder::MDU_SIZE {
        return -1;
    }
    let builder = unsafe { &mut *ptr };
    let bytes = builder.bytes();
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, crate::builder::MDU_SIZE);
    }
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_mdu0_append_file(
    ptr: *mut Mdu0Builder,
    path_ptr: *const c_char,
    size: u64,
    start_offset: u64,
) -> c_int {
    if ptr.is_null() || path_ptr.is_null() {
        return -1;
    }
    let builder = unsafe { &mut *ptr };
    
    let c_str = unsafe { CStr::from_ptr(path_ptr) };
    let path_str = match c_str.to_str() {
        Ok(s) => s,
        Err(_) => return -2,
    };
    
    let mut path_bytes = [0u8; 40];
    let bytes = path_str.as_bytes();
    if bytes.len() > 40 {
        return -3; // Path too long
    }
    path_bytes[..bytes.len()].copy_from_slice(bytes);

    let rec = FileRecordV1 {
        start_offset,
        length_and_flags: pack_length_and_flags(size, 0),
        timestamp: 0,
        path: path_bytes,
    };

    match builder.append_file_record(rec) {
        Ok(_) => 0,
        Err(_) => -4,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_mdu0_set_root(
    ptr: *mut Mdu0Builder,
    index: u64,
    root_ptr: *const u8,
) -> c_int {
    if ptr.is_null() || root_ptr.is_null() {
        return -1;
    }
    let builder = unsafe { &mut *ptr };
    let root_slice = unsafe { std::slice::from_raw_parts(root_ptr, 32) };
    let mut root = [0u8; 32];
    root.copy_from_slice(root_slice);

    match builder.set_root(index, root) {
        Ok(_) => 0,
        Err(_) => -2,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_mdu0_get_root(
    ptr: *mut Mdu0Builder,
    index: u64,
    root_ptr: *mut u8,
) -> c_int {
    if ptr.is_null() || root_ptr.is_null() {
        return -1;
    }
    let builder = unsafe { &mut *ptr };
    // Check bounds (65536 roots max)
    if index >= 65536 {
        return -2;
    }
    let root = builder.get_root(index);
    unsafe {
        std::ptr::copy_nonoverlapping(root.as_ptr(), root_ptr, 32);
    }
    0
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_mdu0_get_witness_count(ptr: *mut Mdu0Builder) -> u64 {
    if ptr.is_null() {
        return 0;
    }
    let builder = unsafe { &*ptr };
    builder.witness_mdu_count
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_mdu0_get_record_count(ptr: *mut Mdu0Builder) -> u32 {
    if ptr.is_null() {
        return 0;
    }
    let builder = unsafe { &*ptr };
    builder.header.record_count
}

#[unsafe(no_mangle)]
pub extern "C" fn nil_mdu0_get_record(ptr: *mut Mdu0Builder, index: u32, out_rec: *mut FileRecordV1) -> c_int {
    if ptr.is_null() || out_rec.is_null() {
        return -1;
    }
    let builder = unsafe { &*ptr };
    if index >= builder.header.record_count {
        return -2;
    }
    let rec = builder.get_file_record(index);
    unsafe {
        *out_rec = rec;
    }
    0
}
