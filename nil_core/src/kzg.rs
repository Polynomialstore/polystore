use kzg_rs::KzgSettings;
use kzg_rs::kzg_proof::verify_kzg_proof_impl;
use sp1_bls12_381::{Scalar, G1Affine, G1Projective};
use std::path::Path;
use thiserror::Error;
use blake2::{Blake2s256, Digest};
use rs_merkle::{MerkleTree, MerkleProof, Hasher};
use ff::PrimeField;
use group::{Curve, Group};

pub const MDU_SIZE: usize = 8 * 1024 * 1024;
pub const SHARD_SIZE: usize = 1 * 1024 * 1024;
pub const BLOB_SIZE: usize = 131072;
pub const BLOBS_PER_MDU: usize = MDU_SIZE / BLOB_SIZE;

pub type KzgCommitment = [u8; 48];
pub type Bytes32 = [u8; 32];
pub type Bytes48 = [u8; 48];

#[derive(Error, Debug)]
pub enum KzgError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("KZG error")]
    Internal,
    #[error("Invalid data length")]
    InvalidDataLength,
    #[error("Invalid MDU size")]
    InvalidMduSize,
    #[error("Merkle Tree error: {0}")]
    MerkleTreeError(String),
}

#[derive(Clone)]
pub struct Blake2s256Hasher;

impl rs_merkle::Hasher for Blake2s256Hasher {
    type Hash = [u8; 32];
    fn hash(data: &[u8]) -> [u8; 32] {
        Blake2s256::digest(data).into()
    }
}

pub struct KzgContext {
    settings: KzgSettings,
}

impl KzgContext {
    pub fn load_from_file<P: AsRef<Path>>(_path: P) -> Result<Self, KzgError> {
        let settings = KzgSettings::load_trusted_setup_file()
            .map_err(|_| KzgError::Internal)?;
        Ok(Self { settings })
    }

    pub fn blob_to_commitment(&self, blob_bytes: &[u8]) -> Result<KzgCommitment, KzgError> {
        if blob_bytes.len() != BLOB_SIZE { return Err(KzgError::InvalidDataLength); }
        
        let scalars = bytes_to_scalars(blob_bytes)?;
        
        let mut acc = G1Projective::identity();
        for (i, scalar) in scalars.iter().enumerate() {
            if i >= self.settings.g1_points.len() { break; }
            let point = self.settings.g1_points[i];
            acc += point * scalar;
        }
        
        let affine = acc.to_affine();
        Ok(affine.to_compressed())
    }

    pub fn mdu_to_kzg_commitments(&self, mdu_bytes: &[u8]) -> Result<Vec<KzgCommitment>, KzgError> {
        if mdu_bytes.len() != MDU_SIZE { return Err(KzgError::InvalidMduSize); }
        let mut commitments = Vec::with_capacity(BLOBS_PER_MDU);
        for i in 0..BLOBS_PER_MDU {
            let start = i * BLOB_SIZE;
            let end = start + BLOB_SIZE;
            commitments.push(self.blob_to_commitment(&mdu_bytes[start..end])?);
        }
        Ok(commitments)
    }

    pub fn create_mdu_merkle_root(&self, commitments: &[KzgCommitment]) -> Result<Bytes32, KzgError> {
        let leaves: Vec<[u8; 32]> = commitments.iter()
            .map(|c| Blake2s256Hasher::hash(c))
            .collect();
        let merkle_tree = MerkleTree::<Blake2s256Hasher>::from_leaves(&leaves);
        merkle_tree.root()
            .ok_or_else(|| KzgError::MerkleTreeError("Root not found".to_string()))
    }

    pub fn compute_proof(
        &self,
        blob_bytes: &[u8],
        input_point_bytes: &[u8],
    ) -> Result<(Bytes48, Bytes32), KzgError> {
        Ok(([0u8; 48], [0u8; 32])) // Stub
    }

    pub fn verify_proof(
        &self,
        commitment_bytes: &[u8],
        input_point_bytes: &[u8],
        claimed_value_bytes: &[u8],
        proof_bytes: &[u8],
    ) -> Result<bool, KzgError> {
        let commitment = G1Affine::from_compressed(commitment_bytes.try_into().unwrap()).unwrap();
        
        let mut z_repr = [0u8; 32];
        z_repr.copy_from_slice(input_point_bytes);
        z_repr.reverse();
        let z = Scalar::from_repr(z_repr).unwrap();

        let mut y_repr = [0u8; 32];
        y_repr.copy_from_slice(claimed_value_bytes);
        y_repr.reverse();
        let y = Scalar::from_repr(y_repr).unwrap();

        let proof = G1Affine::from_compressed(proof_bytes.try_into().unwrap()).unwrap();

        verify_kzg_proof_impl(commitment, z, y, proof, &self.settings)
            .map_err(|_| KzgError::Internal)
    }

    pub fn compute_manifest_commitment(&self, mdu_roots: &[[u8; 32]]) -> Result<(KzgCommitment, Vec<u8>), KzgError> {
        let mut blob_bytes = vec![0u8; BLOB_SIZE];
        for (i, root) in mdu_roots.iter().enumerate() {
            if i >= 4096 { break; }
            let start = i * 32;
            blob_bytes[start..start+32].copy_from_slice(root);
        }
        
        let commitment = self.blob_to_commitment(&blob_bytes)?;
        Ok((commitment, blob_bytes))
    }

    pub fn verify_manifest_inclusion(
        &self,
        manifest_commitment_bytes: &[u8],
        mdu_root_bytes: &[u8],
        mdu_index: usize,
        proof_bytes: &[u8],
    ) -> Result<bool, KzgError> {
        Ok(true) // Stub
    }
    
    pub fn verify_mdu_merkle_proof(
        mdu_merkle_root: &[u8],
        challenged_kzg_commitment: &[u8], 
        challenged_kzg_commitment_index: usize,
        merkle_proof_bytes: &[u8], 
        num_leaves: usize,
    ) -> Result<bool, KzgError> {
        if mdu_merkle_root.len() != 32 || challenged_kzg_commitment.len() != 48 {
            return Err(KzgError::InvalidDataLength);
        }
        
        let leaf_hash = Blake2s256Hasher::hash(challenged_kzg_commitment);

        let proof_hashes: Vec<[u8; 32]> = merkle_proof_bytes
            .chunks_exact(32)
            .map(|chunk| {
                let mut array = [0u8; 32];
                array.copy_from_slice(chunk);
                array
            })
            .collect();

        let merkle_proof = MerkleProof::<Blake2s256Hasher>::new(proof_hashes);

        let indices = vec![challenged_kzg_commitment_index];
        let leaves = vec![leaf_hash];

        let root_array: [u8; 32] = mdu_merkle_root.try_into().map_err(|_| KzgError::InvalidDataLength)?;

        Ok(merkle_proof.verify(
            root_array,
            &indices,
            &leaves,
            num_leaves,
        ))
    }
}

fn bytes_to_scalars(bytes: &[u8]) -> Result<Vec<Scalar>, KzgError> {
    let mut scalars = Vec::with_capacity(4096);
    for chunk in bytes.chunks(32) {
        let mut repr = [0u8; 32];
        repr.copy_from_slice(chunk);
        repr.reverse(); // BE -> LE
        let s = Scalar::from_repr(repr);
        if s.is_none().into() {
             return Err(KzgError::Internal);
        }
        scalars.push(s.unwrap());
    }
    Ok(scalars)
}
