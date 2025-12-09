use c_kzg::{
    Blob, Bytes32, Bytes48, KzgCommitment, KzgProof, KzgSettings,
};
pub use c_kzg; // Re-export the crate or types
use std::path::Path;
use thiserror::Error;
use blake2::{Blake2s256, Digest};
use rs_merkle::{MerkleTree, MerkleProof, Hasher};
use num_bigint::BigUint;
use num_integer::Integer;

// Define MDU (Mega-Data Unit) and Shard sizes
pub const MDU_SIZE: usize = 8 * 1024 * 1024; // 8 MiB
pub const SHARD_SIZE: usize = 1 * 1024 * 1024; // 1 MiB
pub const BLOB_SIZE: usize = c_kzg::BYTES_PER_BLOB; // 128 KiB
pub const BLOBS_PER_MDU: usize = MDU_SIZE / BLOB_SIZE; // 64 blobs per MDU

#[derive(Error, Debug)]
pub enum KzgError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("KZG error: {0:?}")]
    Internal(c_kzg::Error),
    #[error("Invalid data length")]
    InvalidDataLength,
    #[error("Invalid MDU size: expected {MDU_SIZE} bytes")]
    InvalidMduSize,
    #[error("MDU commitment calculation failed")]
    MduCommitmentFailed,
    #[error("Merkle Tree error: {0}")]
    MerkleTreeError(String),
}

impl From<c_kzg::Error> for KzgError {
    fn from(e: c_kzg::Error) -> Self {
        KzgError::Internal(e)
    }
}

/// Custom hasher for rs-merkle using Blake2s256 for KzgCommitment (Bytes48)
#[derive(Clone)]
pub struct Blake2s256Hasher;

impl rs_merkle::Hasher for Blake2s256Hasher {
    type Hash = [u8; 32]; // Blake2s256 output size

    fn hash(data: &[u8]) -> [u8; 32] {
        Blake2s256::digest(data).into()
    }
}


pub struct KzgContext {
    settings: KzgSettings,
}

impl KzgContext {
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self, KzgError> {
        let settings = KzgSettings::load_trusted_setup_file(path.as_ref(), 0)
            .map_err(KzgError::Internal)?;
        Ok(Self { settings })
    }

    pub fn blob_to_commitment(&self, blob_bytes: &[u8]) -> Result<KzgCommitment, KzgError> {
        if blob_bytes.len() != BLOB_SIZE {
            return Err(KzgError::InvalidDataLength);
        }
        
        let blob = Blob::from_bytes(blob_bytes).map_err(KzgError::Internal)?;
        self.settings.blob_to_kzg_commitment(&blob)
            .map_err(KzgError::Internal)
    }

    /// Converts an 8 MiB MDU into a vector of 64 KZG commitments for its constituent 128 KiB blobs.
    pub fn mdu_to_kzg_commitments(&self, mdu_bytes: &[u8]) -> Result<Vec<KzgCommitment>, KzgError> {
        if mdu_bytes.len() != MDU_SIZE {
            return Err(KzgError::InvalidMduSize);
        }

        let mut commitments = Vec::with_capacity(BLOBS_PER_MDU);
        for i in 0..BLOBS_PER_MDU {
            let start = i * BLOB_SIZE;
            let end = start + BLOB_SIZE;
            let blob_slice = &mdu_bytes[start..end];
            commitments.push(self.blob_to_commitment(blob_slice)?);
        }
        Ok(commitments)
    }

    /// Creates a Merkle root from a slice of KZG commitments.
    pub fn create_mdu_merkle_root(&self, commitments: &[KzgCommitment]) -> Result<Bytes32, KzgError> {
        if commitments.len() != BLOBS_PER_MDU {
            return Err(KzgError::MerkleTreeError("Incorrect number of commitments for MDU".to_string()));
        }

        // Convert KzgCommitment (Bytes48) to [u8; 32] by hashing for Merkle Tree leaves
        let leaves: Vec<[u8; 32]> = commitments.iter()
            .map(|c| Blake2s256Hasher::hash(c.as_slice()))
            .collect();
        
        let merkle_tree = MerkleTree::<Blake2s256Hasher>::from_leaves(&leaves);
        
        merkle_tree.root()
            .ok_or_else(|| KzgError::MerkleTreeError("Failed to get Merkle root".to_string()))
            .map(|root_hash| Bytes32::from_bytes(root_hash.as_slice()).unwrap()) // Bytes32 is 32 bytes, root_hash is 32 bytes
    }

    /// Computes the Manifest Root (KZG Commitment) and the Manifest MDU (Blob)
    /// from a list of MDU Merkle Roots (32-byte hashes).
    pub fn compute_manifest_commitment(&self, mdu_roots: &[[u8; 32]]) -> Result<(KzgCommitment, Vec<u8>), KzgError> {
        use crate::utils::{bytes_to_fr_be, frs_to_blobs, get_modulus};

        let modulus = get_modulus();
        let frs: Vec<BigUint> = mdu_roots.iter()
            .map(|root| {
                let bn = bytes_to_fr_be(root);
                bn.mod_floor(&modulus)
            })
            .collect();

        // frs_to_blobs handles the packing (4096 scalars per blob)
        // and bit-reversal ordering required by c-kzg.
        let blobs = frs_to_blobs(&frs);
        
        if blobs.is_empty() {
             // Handle empty case: single zero blob
             let zero_blob = vec![0u8; BLOB_SIZE];
             let commitment = self.blob_to_commitment(&zero_blob)?;
             return Ok((commitment, zero_blob));
        }
        
        // For Phase 2, we enforce a single Manifest MDU (max 4096 MDUs per file).
        if blobs.len() > 1 {
             return Err(KzgError::InvalidDataLength); // TODO: Support multi-blob manifest
        }
        
        let manifest_blob = &blobs[0];
        let commitment = self.blob_to_commitment(manifest_blob)?;
        
        Ok((commitment, manifest_blob.clone()))
    }

    /// Verifies a Merkle proof for a specific KZG commitment within an MDU.
    /// This is a helper function that might be called from an FFI exposed verify_mdu_proof
    pub fn verify_mdu_merkle_proof(
        mdu_merkle_root: &[u8],
        challenged_kzg_commitment: &[u8], // The 48-byte commitment itself
        challenged_kzg_commitment_index: usize,
        merkle_proof_bytes: &[u8], // Concatenated proof hashes
        num_leaves: usize,
    ) -> Result<bool, KzgError> {
        if mdu_merkle_root.len() != 32 || challenged_kzg_commitment.len() != 48 {
            return Err(KzgError::InvalidDataLength);
        }
        
        // Hash the challenged commitment to get the leaf hash
        let leaf_hash = Blake2s256Hasher::hash(challenged_kzg_commitment);

        // Reconstruct the proof from bytes
        let proof_hashes: Vec<[u8; 32]> = merkle_proof_bytes
            .chunks_exact(32)
            .map(|chunk| {
                let mut array = [0u8; 32];
                array.copy_from_slice(chunk);
                array
            })
            .collect();

        let merkle_proof = MerkleProof::<Blake2s256Hasher>::new(proof_hashes);

        // Verify the Merkle proof
        let indices = vec![challenged_kzg_commitment_index];
        let leaves = vec![leaf_hash];

        let root_bytes32 = Bytes32::from_bytes(mdu_merkle_root).map_err(KzgError::Internal)?;
        let root_array: [u8; 32] = root_bytes32.as_slice().try_into().map_err(|_| KzgError::InvalidDataLength)?;

        Ok(merkle_proof.verify(
            root_array,
            &indices,
            &leaves,
            num_leaves,
        ))
    }

    pub fn compute_proof(
        &self,
        blob_bytes: &[u8],
        input_point_bytes: &[u8],
    ) -> Result<(KzgProof, Bytes32), KzgError> {
        if blob_bytes.len() != BLOB_SIZE {
             return Err(KzgError::InvalidDataLength);
        }
        if input_point_bytes.len() != 32 {
             return Err(KzgError::InvalidDataLength);
        }

        let blob = Blob::from_bytes(blob_bytes).map_err(KzgError::Internal)?;
        let z = Bytes32::from_bytes(input_point_bytes).map_err(KzgError::Internal)?;

        self.settings.compute_kzg_proof(&blob, &z)
            .map_err(KzgError::Internal)
    }

    pub fn verify_proof(
        &self,
        commitment_bytes: &[u8],
        input_point_bytes: &[u8],
        claimed_value_bytes: &[u8],
        proof_bytes: &[u8],
    ) -> Result<bool, KzgError> {
         if commitment_bytes.len() != 48 || input_point_bytes.len() != 32 || claimed_value_bytes.len() != 32 || proof_bytes.len() != 48 {
            return Err(KzgError::InvalidDataLength);
        }

        let commitment = Bytes48::from_bytes(commitment_bytes).map_err(KzgError::Internal)?;
        let z = Bytes32::from_bytes(input_point_bytes).map_err(KzgError::Internal)?;
        let y = Bytes32::from_bytes(claimed_value_bytes).map_err(KzgError::Internal)?;
        let proof = Bytes48::from_bytes(proof_bytes).map_err(KzgError::Internal)?;

        self.settings.verify_kzg_proof(
            &commitment,
            &z,
            &y,
            &proof,
        )
        .map_err(KzgError::Internal)
    }

    /// Verifies that a specific MDU Merkle Root is included in the Manifest.
    /// This corresponds to "Hop 1" of the Triple Proof.
    pub fn verify_manifest_inclusion(
        &self,
        manifest_commitment_bytes: &[u8],
        mdu_root_bytes: &[u8], // The value (y) - MDU Merkle Root
        mdu_index: usize,      // The index in the manifest
        proof_bytes: &[u8],    // The KZG proof
    ) -> Result<bool, KzgError> {
        if manifest_commitment_bytes.len() != 48 || mdu_root_bytes.len() != 32 || proof_bytes.len() != 48 {
            return Err(KzgError::InvalidDataLength);
        }

        // 1. Calculate z (evaluation point) from the index
        let z_bytes = crate::utils::z_for_cell(mdu_index);

        // 2. Reuse standard verify_proof
        // The "value" (y) is the MDU root itself, treated as a field element.
        // verify_proof handles the Bytes32 conversion.
        self.verify_proof(
            manifest_commitment_bytes,
            &z_bytes,
            mdu_root_bytes,
            proof_bytes,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn test_load_trusted_setup() {
        let path = get_trusted_setup_path();
        assert!(path.exists(), "Trusted setup file not found at {:?}", path);
        let ctx = KzgContext::load_from_file(&path);
        assert!(ctx.is_ok());
    }

    #[test]
    fn test_mdu_to_kzg_commitments() {
        let path = get_trusted_setup_path();
        let ctx = KzgContext::load_from_file(&path).unwrap();

        let mdu_data = vec![0u8; MDU_SIZE];
        let commitments = ctx.mdu_to_kzg_commitments(&mdu_data).unwrap();
        assert_eq!(commitments.len(), BLOBS_PER_MDU);
    }

    #[test]
    fn test_create_mdu_merkle_root() {
        let path = get_trusted_setup_path();
        let ctx = KzgContext::load_from_file(&path).unwrap();

        let mdu_data = vec![0u8; MDU_SIZE];
        let commitments = ctx.mdu_to_kzg_commitments(&mdu_data).unwrap();
        let root = ctx.create_mdu_merkle_root(&commitments).unwrap();
        assert_ne!(root.as_slice(), &[0u8; 32]); // Root should not be all zeros
    }

    #[test]
    fn test_verify_mdu_merkle_proof() {
        let path = get_trusted_setup_path();
        let ctx = KzgContext::load_from_file(&path).unwrap();

        let mdu_data = vec![0u8; MDU_SIZE]; // 8MB of zeros
        let commitments = ctx.mdu_to_kzg_commitments(&mdu_data).unwrap();
        let mdu_root = ctx.create_mdu_merkle_root(&commitments).unwrap();

        // Challenge the first blob (index 0)
        let challenged_index = 0;
        let challenged_commitment = commitments[challenged_index];
        
        let leaves: Vec<[u8; 32]> = commitments.iter()
            .map(|c| Blake2s256Hasher::hash(c.as_slice()))
            .collect();
        let merkle_tree = MerkleTree::<Blake2s256Hasher>::from_leaves(&leaves);
        let proof = merkle_tree.proof(&[challenged_index]);
        
        let proof_bytes_flat: Vec<u8> = proof.to_bytes();

        let is_valid = KzgContext::verify_mdu_merkle_proof(
            mdu_root.as_slice(),
            challenged_commitment.as_slice(),
            challenged_index,
            &proof_bytes_flat,
            BLOBS_PER_MDU,
        ).unwrap();

        assert!(is_valid, "Merkle proof should be valid");
    }

    #[test]
    fn test_commit_prove_verify() {
        let path = get_trusted_setup_path();
        let ctx = KzgContext::load_from_file(&path).unwrap();

        // Create a dummy blob (all zeros except first byte)
        let mut blob_bytes = [0u8; BLOB_SIZE];
        blob_bytes[0] = 1; // Just some data

        // Commit
        let commitment = ctx.blob_to_commitment(&blob_bytes).expect("Commit failed");
        
        // Point to evaluate at (z)
        let mut z_bytes = [0u8; 32];
        z_bytes[0] = 2; // Just some point

        // Compute proof
        let (proof, y) = ctx.compute_proof(&blob_bytes, &z_bytes).expect("Proof failed");

        // Verify
        let valid = ctx.verify_proof(
            commitment.as_slice(),
            &z_bytes,
            y.as_slice(),
            proof.as_slice()
        ).expect("Verification failed");

        assert!(valid, "Proof should be valid");
    }
}