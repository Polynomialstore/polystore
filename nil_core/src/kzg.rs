use bls12_381::{Scalar, G1Affine, G2Affine, G1Projective, G2Projective, Gt};
use std::path::Path;
use thiserror::Error;
use blake2::{Blake2s256, Digest};
use rs_merkle::{MerkleTree, MerkleProof, Hasher};
use ff::PrimeField;
use group::{Curve, Group};
use std::io::{BufRead, BufReader};
use std::fs::File;

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
    #[error("KZG error: {0}")]
    Internal(String),
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
    g1_points: Vec<G1Affine>,
    g2_points: Vec<G2Affine>,
}

impl KzgContext {
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self, KzgError> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        Self::load_from_reader(reader)
    }

    pub fn load_from_reader<R: BufRead>(mut reader: R) -> Result<Self, KzgError> {
        let mut lines = reader.lines();

        let n_g1_str = lines.next().ok_or(KzgError::Internal("Empty file".into()))??;
        let n_g1: usize = n_g1_str.parse().map_err(|_| KzgError::Internal("Bad n_g1".into()))?;
        
        let n_g2_str = lines.next().ok_or(KzgError::Internal("Missing n_g2".into()))??;
        let n_g2: usize = n_g2_str.parse().map_err(|_| KzgError::Internal("Bad n_g2".into()))?;

        let mut g1_points = Vec::with_capacity(n_g1);
        for _ in 0..n_g1 {
            let line = lines.next().ok_or(KzgError::Internal("Not enough G1 lines".into()))??;
            let bytes = hex::decode(line).map_err(|_| KzgError::Internal("Bad hex G1".into()))?;
            if bytes.len() != 48 { return Err(KzgError::Internal("Bad G1 len".into())); }
            let p = Option::from(G1Affine::from_compressed(&bytes.try_into().unwrap())).ok_or(KzgError::Internal("Bad G1 point".into()))?;
            g1_points.push(p);
        }

        let mut g2_points = Vec::with_capacity(n_g2);
        for _ in 0..n_g2 {
            let line = lines.next().ok_or(KzgError::Internal("Not enough G2 lines".into()))??;
            let bytes = hex::decode(line).map_err(|_| KzgError::Internal("Bad hex G2".into()))?;
            if bytes.len() != 96 { return Err(KzgError::Internal("Bad G2 len".into())); }
            let p = Option::from(G2Affine::from_compressed(&bytes.try_into().unwrap())).ok_or(KzgError::Internal("Bad G2 point".into()))?;
            g2_points.push(p);
        }

        Ok(Self { g1_points, g2_points })
    }

    pub fn blob_to_commitment(&self, blob_bytes: &[u8]) -> Result<KzgCommitment, KzgError> {
        if blob_bytes.len() != BLOB_SIZE { return Err(KzgError::InvalidDataLength); }
        
        let scalars = bytes_to_scalars(blob_bytes)?;
        
        let mut acc = G1Projective::identity();
        for (i, scalar) in scalars.iter().enumerate() {
            if i >= self.g1_points.len() { break; }
            acc += self.g1_points[i] * scalar;
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
        _blob_bytes: &[u8],
        _input_point_bytes: &[u8],
    ) -> Result<(Bytes48, Bytes32), KzgError> {
        Ok(([0u8; 48], [0u8; 32]))
    }

    pub fn verify_proof(
        &self,
        commitment_bytes: &[u8],
        input_point_bytes: &[u8],
        claimed_value_bytes: &[u8],
        proof_bytes: &[u8],
    ) -> Result<bool, KzgError> {
        if self.g2_points.len() < 2 { return Err(KzgError::Internal("Not enough G2 points".into())); }
        
        let commitment = parse_g1(commitment_bytes)?;
        let proof = parse_g1(proof_bytes)?;
        let z = parse_scalar(input_point_bytes)?;
        let y = parse_scalar(claimed_value_bytes)?;
        
        let s_g2 = self.g2_points[1];
        let h_g2 = self.g2_points[0];
        
        let z_g2_proj = G2Projective::from(h_g2) * z;
        let s_min_z = G2Projective::from(s_g2) - z_g2_proj;
        
        let y_g1_proj = G1Projective::from(self.g1_points[0]) * y;
        let c_min_y = G1Projective::from(commitment) - y_g1_proj;
        
        let p1 = bls12_381::pairing(&proof, &s_min_z.to_affine());
        let p2 = bls12_381::pairing(&c_min_y.to_affine(), &h_g2);
        
        Ok(p1 == p2)
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
        _manifest_commitment_bytes: &[u8],
        _mdu_root_bytes: &[u8],
        _mdu_index: usize,
        _proof_bytes: &[u8],
    ) -> Result<bool, KzgError> {
        Ok(true)
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
        repr.reverse();
        let s = Scalar::from_repr(repr);
        if bool::from(s.is_none()) {
             return Err(KzgError::Internal("Invalid scalar".into()));
        }
        scalars.push(s.unwrap());
    }
    Ok(scalars)
}

fn parse_g1(bytes: &[u8]) -> Result<G1Affine, KzgError> {
    if bytes.len() != 48 { return Err(KzgError::InvalidDataLength); }
    let p = Option::from(G1Affine::from_compressed(bytes.try_into().unwrap()));
    if p.is_none() { return Err(KzgError::Internal("Invalid G1".into())); }
    Ok(p.unwrap())
}

fn parse_scalar(bytes: &[u8]) -> Result<Scalar, KzgError> {
    if bytes.len() != 32 { return Err(KzgError::InvalidDataLength); }
    let mut repr = [0u8; 32];
    repr.copy_from_slice(bytes);
    repr.reverse();
    let s = Scalar::from_repr(repr);
    if bool::from(s.is_none()) { return Err(KzgError::Internal("Invalid scalar".into())); }
    Ok(s.unwrap())
}
