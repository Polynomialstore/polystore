use blake2::{Blake2s256, Digest};
use bls12_381::{G1Affine, G1Projective, G2Affine, G2Projective, Scalar};
use ff::{Field, PrimeField};
use group::Curve;
use rs_merkle::{Hasher, MerkleProof, MerkleTree};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::OnceLock;
use thiserror::Error;

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
    g1_points_projective: Vec<G1Projective>,
    g2_points: Vec<G2Affine>,
    g1_generator: G1Affine,
    g1_points_are_monomial: bool,
}

impl KzgContext {
    pub fn load_from_file<P: AsRef<Path>>(path: P) -> Result<Self, KzgError> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        Self::load_from_reader(reader)
    }

    pub fn load_from_reader<R: BufRead>(reader: R) -> Result<Self, KzgError> {
        let mut lines = reader.lines();

        let n_g1_str = lines
            .next()
            .ok_or(KzgError::Internal("Empty file".into()))??;
        let n_g1: usize = n_g1_str
            .parse()
            .map_err(|_| KzgError::Internal("Bad n_g1".into()))?;

        let n_g2_str = lines
            .next()
            .ok_or(KzgError::Internal("Missing n_g2".into()))??;
        let n_g2: usize = n_g2_str
            .parse()
            .map_err(|_| KzgError::Internal("Bad n_g2".into()))?;

        let mut g1_points = Vec::with_capacity(n_g1);
        for _ in 0..n_g1 {
            let line = lines
                .next()
                .ok_or(KzgError::Internal("Not enough G1 lines".into()))??;
            let bytes = hex::decode(line).map_err(|_| KzgError::Internal("Bad hex G1".into()))?;
            if bytes.len() != 48 {
                return Err(KzgError::Internal("Bad G1 len".into()));
            }
            let p = Option::from(G1Affine::from_compressed(&bytes.try_into().unwrap()))
                .ok_or(KzgError::Internal("Bad G1 point".into()))?;
            g1_points.push(p);
        }

        let mut g2_points = Vec::with_capacity(n_g2);
        for _ in 0..n_g2 {
            let line = lines
                .next()
                .ok_or(KzgError::Internal("Not enough G2 lines".into()))??;
            let bytes = hex::decode(line).map_err(|_| KzgError::Internal("Bad hex G2".into()))?;
            if bytes.len() != 96 {
                return Err(KzgError::Internal("Bad G2 len".into()));
            }
            let p = Option::from(G2Affine::from_compressed(&bytes.try_into().unwrap()))
                .ok_or(KzgError::Internal("Bad G2 point".into()))?;
            g2_points.push(p);
        }

        if g1_points.len() < 2 || g2_points.len() < 2 {
            return Err(KzgError::Internal("Trusted setup too small".into()));
        }

        // Determine whether the provided G1 points are monomial powers-of-τ (SRS) or Lagrange
        // points over the blob domain. The standard EIP-4844 ceremony file provides Lagrange
        // points for G1 (to commit directly from blob evaluations).
        let g1_points_are_monomial =
            bls12_381::pairing(&g1_points[1], &g2_points[0]) == bls12_381::pairing(&g1_points[0], &g2_points[1]);

        // The KZG verification equation uses the base G1 generator (τ^0).
        // - Monomial SRS: generator is g1_points[0].
        // - Lagrange SRS: generator is the commitment to the all-ones blob (Σ L_i(τ) = 1).
        let g1_points_projective: Vec<G1Projective> =
            g1_points.iter().map(|p| G1Projective::from(*p)).collect();
        let g1_generator = if g1_points_are_monomial {
            g1_points[0]
        } else {
            let mut acc = G1Projective::identity();
            for p in g1_points_projective.iter() {
                acc += *p;
            }
            acc.to_affine()
        };

        Ok(Self {
            g1_points,
            g1_points_projective,
            g2_points,
            g1_generator,
            g1_points_are_monomial,
        })
    }

    pub fn blob_to_commitment(&self, blob_bytes: &[u8]) -> Result<KzgCommitment, KzgError> {
        if blob_bytes.len() != BLOB_SIZE {
            return Err(KzgError::InvalidDataLength);
        }

        if blob_bytes.iter().all(|&b| b == 0) {
            return Ok(zero_blob_commitment());
        }

        if self.g1_points_are_monomial {
            // Blob is in evaluation form; interpolate to coefficients, then commit using monomial SRS.
            let omega = scalar_for_cell_index(1)?;
            let mut coeffs = bytes_to_scalars(blob_bytes)?;
            ifft_in_place(&mut coeffs, omega)?;

            let mut points = Vec::new();
            let mut scalars = Vec::new();
            for (i, coeff) in coeffs.iter().enumerate() {
                if i >= self.g1_points.len() {
                    break;
                }
                if bool::from(coeff.is_zero()) {
                    continue;
                }
                points.push(self.g1_points[i]);
                scalars.push(*coeff);
            }

            let acc = if points.is_empty() {
                G1Projective::identity()
            } else {
                msm_pippenger_g1(&points, &scalars)
            };

            Ok(acc.to_affine().to_compressed())
        } else {
            // G1 points are already in Lagrange form for the blob domain, so we can MSM directly
            // over the evaluations.
            let evals = bytes_to_scalars(blob_bytes)?;
            Ok(msm_pippenger_g1_projective(&self.g1_points_projective, &evals)
                .to_affine()
                .to_compressed())
        }
    }

    pub fn mdu_to_kzg_commitments(&self, mdu_bytes: &[u8]) -> Result<Vec<KzgCommitment>, KzgError> {
        if mdu_bytes.len() != MDU_SIZE {
            return Err(KzgError::InvalidMduSize);
        }
        let mut commitments = Vec::with_capacity(BLOBS_PER_MDU);
        for i in 0..BLOBS_PER_MDU {
            let start = i * BLOB_SIZE;
            let end = start + BLOB_SIZE;
            commitments.push(self.blob_to_commitment(&mdu_bytes[start..end])?);
        }
        Ok(commitments)
    }

    pub fn create_mdu_merkle_root(
        &self,
        commitments: &[KzgCommitment],
    ) -> Result<Bytes32, KzgError> {
        let leaves: Vec<[u8; 32]> = commitments
            .iter()
            .map(|c| Blake2s256Hasher::hash(c))
            .collect();
        let merkle_tree = MerkleTree::<Blake2s256Hasher>::from_leaves(&leaves);
        merkle_tree
            .root()
            .ok_or_else(|| KzgError::MerkleTreeError("Root not found".to_string()))
    }

    pub fn compute_proof(
        &self,
        blob_bytes: &[u8],
        input_point_bytes: &[u8],
    ) -> Result<(Bytes48, Bytes32), KzgError> {
        if blob_bytes.len() != BLOB_SIZE {
            return Err(KzgError::InvalidDataLength);
        }
        if input_point_bytes.len() != 32 {
            return Err(KzgError::InvalidDataLength);
        }

        let z = parse_scalar(input_point_bytes)?;

        if self.g1_points_are_monomial {
            // Monomial SRS: interpolate evaluations to coefficients, then use the standard KZG
            // opening proof algorithm in coefficient form.
            let omega = scalar_for_cell_index(1)?;
            let mut coeffs = bytes_to_scalars(blob_bytes)?;
            ifft_in_place(&mut coeffs, omega)?;

            // Evaluate p(z) via Horner's method.
            let mut y = Scalar::zero();
            for coeff in coeffs.iter().rev() {
                y *= z;
                y += coeff;
            }

            // Compute quotient polynomial q(x) = (p(x) - p(z)) / (x - z) using synthetic division.
            let n = coeffs.len();
            let mut b = vec![Scalar::zero(); n];
            b[n - 1] = coeffs[n - 1];
            for i in (0..n - 1).rev() {
                b[i] = coeffs[i] + b[i + 1] * z;
            }

            // Commitment to q(x) using monomial setup points.
            let mut points = Vec::new();
            let mut scalars = Vec::new();
            for (i, qi) in b.iter().skip(1).enumerate() {
                if i >= self.g1_points.len() {
                    break;
                }
                if bool::from(qi.is_zero()) {
                    continue;
                }
                points.push(self.g1_points[i]);
                scalars.push(*qi);
            }

            let proof = if points.is_empty() {
                G1Affine::identity().to_compressed()
            } else {
                msm_pippenger_g1(&points, &scalars).to_affine().to_compressed()
            };

            let mut y_le = y.to_repr();
            let mut y_be = [0u8; 32];
            y_le.as_mut().reverse();
            y_be.copy_from_slice(y_le.as_ref());

            return Ok((proof, y_be));
        }

        // Lagrange SRS: treat blob bytes as evaluations over the roots-of-unity domain, compute:
        // - y = p(z) via barycentric interpolation
        // - q_i = (p(x_i) - y) / (x_i - z) for all domain points x_i = ω^i
        //   with a special-case for z in-domain to avoid division by zero.
        let evals = bytes_to_scalars(blob_bytes)?;

        let omega = scalar_for_cell_index(1)?;
        let mut domain = Vec::with_capacity(4096);
        let mut x = Scalar::one();
        for _ in 0..4096 {
            domain.push(x);
            x *= omega;
        }

        let mut z_domain_index = None;
        for (i, xi) in domain.iter().enumerate() {
            if *xi == z {
                z_domain_index = Some(i);
                break;
            }
        }

        let y = if let Some(k) = z_domain_index {
            evals[k]
        } else {
            // Barycentric interpolation on the roots-of-unity domain:
            // weights w_i = x_i / n, but the constant factor cancels, so we use w_i = x_i.
            let mut num = Scalar::zero();
            let mut den = Scalar::zero();
            for (fi, xi) in evals.iter().zip(domain.iter()) {
                let inv = Option::<Scalar>::from((z - xi).invert())
                    .ok_or_else(|| KzgError::Internal("z unexpectedly equals a domain point".into()))?;
                let t = *xi * inv;
                den += t;
                num += *fi * t;
            }
            let den_inv = Option::<Scalar>::from(den.invert())
                .ok_or_else(|| KzgError::Internal("barycentric denominator is not invertible".into()))?;
            num * den_inv
        };

        let mut q_evals = vec![Scalar::zero(); 4096];
        if let Some(k) = z_domain_index {
            let mut sum = Scalar::zero();
            for i in 0..4096 {
                if i == k {
                    continue;
                }
                let inv = Option::<Scalar>::from((domain[i] - z).invert())
                    .ok_or_else(|| KzgError::Internal("unexpected zero denominator in q_evals".into()))?;
                let qi = (evals[i] - y) * inv;
                q_evals[i] = qi;
                sum += qi * domain[i];
            }
            // Enforce deg(q) < 4095 by setting the top coefficient to 0, which is equivalent to:
            // Σ q_i * ω^i = 0  =>  q_k = -(Σ_{i!=k} q_i * ω^i) / ω^k.
            let inv_z = Option::<Scalar>::from(z.invert())
                .ok_or_else(|| KzgError::Internal("domain point must be invertible".into()))?;
            q_evals[k] = -sum * inv_z;
        } else {
            for i in 0..4096 {
                let inv = Option::<Scalar>::from((domain[i] - z).invert())
                    .ok_or_else(|| KzgError::Internal("unexpected zero denominator in q_evals".into()))?;
                q_evals[i] = (evals[i] - y) * inv;
            }
        }

        let proof = msm_pippenger_g1(&self.g1_points, &q_evals).to_affine().to_compressed();

        let mut y_le = y.to_repr();
        let mut y_be = [0u8; 32];
        y_le.as_mut().reverse();
        y_be.copy_from_slice(y_le.as_ref());

        Ok((proof, y_be))
    }

    pub fn verify_proof(
        &self,
        commitment_bytes: &[u8],
        input_point_bytes: &[u8],
        claimed_value_bytes: &[u8],
        proof_bytes: &[u8],
    ) -> Result<bool, KzgError> {
        if self.g2_points.len() < 2 {
            return Err(KzgError::Internal("Not enough G2 points".into()));
        }

        let commitment = parse_g1(commitment_bytes)?;
        let proof = parse_g1(proof_bytes)?;
        let z = parse_scalar(input_point_bytes)?;
        let y = parse_scalar(claimed_value_bytes)?;

        let s_g2 = self.g2_points[1];
        let h_g2 = self.g2_points[0];

        let z_g2_proj = G2Projective::from(h_g2) * z;
        let s_min_z = G2Projective::from(s_g2) - z_g2_proj;

        let y_g1_proj = G1Projective::from(self.g1_generator) * y;
        let c_min_y = G1Projective::from(commitment) - y_g1_proj;

        let p1 = bls12_381::pairing(&proof, &s_min_z.to_affine());
        let p2 = bls12_381::pairing(&c_min_y.to_affine(), &h_g2);

        Ok(p1 == p2)
    }

    pub fn compute_manifest_commitment(
        &self,
        mdu_roots: &[[u8; 32]],
    ) -> Result<(KzgCommitment, Vec<u8>), KzgError> {
        // The manifest blob is stored as evaluations over the roots-of-unity domain.
        // Each entry is the (reduced) 32-byte MDU merkle root at that index.
        let mut blob_bytes = vec![0u8; BLOB_SIZE];
        for (i, root) in mdu_roots.iter().enumerate().take(4096) {
            let start = i * 32;
            blob_bytes[start..start + 32].copy_from_slice(&scalar_to_bytes_be(&reduce_bytes32_to_scalar(root)));
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
        if mdu_index >= 4096 {
            return Ok(false);
        }
        if mdu_root_bytes.len() != 32 || proof_bytes.len() != 48 {
            return Err(KzgError::InvalidDataLength);
        }

        let mut root_arr = [0u8; 32];
        root_arr.copy_from_slice(mdu_root_bytes);
        let y = reduce_bytes32_to_scalar(&root_arr);
        let y_bytes = scalar_to_bytes_be(&y);

        let z_bytes = crate::utils::z_for_cell(mdu_index);
        self.verify_proof(manifest_commitment_bytes, &z_bytes, &y_bytes, proof_bytes)
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

        let root_array: [u8; 32] = mdu_merkle_root
            .try_into()
            .map_err(|_| KzgError::InvalidDataLength)?;

        Ok(merkle_proof.verify(root_array, &indices, &leaves, num_leaves))
    }
}

fn zero_blob_commitment() -> KzgCommitment {
    static ZERO: OnceLock<KzgCommitment> = OnceLock::new();
    *ZERO.get_or_init(|| G1Affine::identity().to_compressed())
}

fn reduce_bytes32_to_scalar(bytes: &[u8; 32]) -> Scalar {
    let mut wide = [0u8; 64];
    wide[..32].copy_from_slice(bytes);
    wide[..32].reverse();
    Scalar::from_bytes_wide(&wide)
}

fn scalar_to_bytes_be(s: &Scalar) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(s.to_repr().as_ref());
    out.reverse();
    out
}

fn scalar_for_cell_index(idx: usize) -> Result<Scalar, KzgError> {
    let z_bytes = crate::utils::z_for_cell(idx);
    parse_scalar(&z_bytes)
}

fn ifft_in_place(values: &mut [Scalar], omega: Scalar) -> Result<(), KzgError> {
    if values.len() != 4096 {
        return Err(KzgError::InvalidDataLength);
    }

    let omega_inv = Option::<Scalar>::from(omega.invert())
        .ok_or_else(|| KzgError::Internal("omega is not invertible".into()))?;

    fft_in_place(values, omega_inv)?;

    let n_inv = Option::<Scalar>::from(Scalar::from(values.len() as u64).invert())
        .ok_or_else(|| KzgError::Internal("n is not invertible".into()))?;
    for v in values.iter_mut() {
        *v *= n_inv;
    }
    Ok(())
}

fn fft_in_place(values: &mut [Scalar], omega: Scalar) -> Result<(), KzgError> {
    let n = values.len();
    if n == 0 || !n.is_power_of_two() {
        return Err(KzgError::InvalidDataLength);
    }

    bit_reverse_permute(values);

    let mut len = 2;
    while len <= n {
        let half = len / 2;
        let wlen = omega.pow_vartime(&[((n / len) as u64), 0, 0, 0]);
        for i in (0..n).step_by(len) {
            let mut w = Scalar::one();
            for j in 0..half {
                let u = values[i + j];
                let v = values[i + j + half] * w;
                values[i + j] = u + v;
                values[i + j + half] = u - v;
                w *= wlen;
            }
        }
        len *= 2;
    }
    Ok(())
}

fn bit_reverse_permute(values: &mut [Scalar]) {
    let n = values.len();
    let bits = n.trailing_zeros();
    for i in 0..n {
        let j = i.reverse_bits() >> (usize::BITS - bits);
        if j > i {
            values.swap(i, j);
        }
    }
}

fn pippenger_window_size(n: usize) -> usize {
    match n {
        0..=32 => 3,
        33..=64 => 4,
        65..=128 => 5,
        129..=256 => 6,
        257..=512 => 7,
        513..=1024 => 8,
        1025..=2048 => 9,
        2049..=4096 => 10,
        4097..=8192 => 11,
        _ => 12,
    }
}

#[inline]
fn pippenger_window(bytes_le: &[u8; 32], bit_offset: usize, window_bits: usize) -> usize {
    debug_assert!(window_bits > 0 && window_bits <= 16);

    let start_byte = bit_offset / 8;
    if start_byte >= 32 {
        return 0;
    }
    let start_bit = bit_offset % 8;

    let mut word = 0u32;
    for i in 0..4 {
        if start_byte + i < 32 {
            word |= (bytes_le[start_byte + i] as u32) << (8 * i);
        }
    }

    let shifted = word >> start_bit;
    let mask = (1u32 << window_bits) - 1;
    (shifted & mask) as usize
}

fn msm_pippenger_g1(points: &[G1Affine], scalars: &[Scalar]) -> G1Projective {
    debug_assert_eq!(points.len(), scalars.len());

    let n = points.len().min(scalars.len());
    if n == 0 {
        return G1Projective::identity();
    }
    let points = &points[..n];
    let scalars = &scalars[..n];

    let window_bits = pippenger_window_size(points.len());
    let buckets_len = 1usize << window_bits;
    let windows = (256 + window_bits - 1) / window_bits;

    let scalar_bytes: Vec<[u8; 32]> = scalars
        .iter()
        .map(|s| {
            let repr = s.to_repr();
            let mut out = [0u8; 32];
            out.copy_from_slice(repr.as_ref());
            out
        })
        .collect();

    let mut buckets = vec![G1Projective::identity(); buckets_len];
    let mut acc = G1Projective::identity();

    for window_index in (0..windows).rev() {
        if window_index != windows - 1 {
            for _ in 0..window_bits {
                acc = acc.double();
            }
        }

        buckets.fill(G1Projective::identity());

        let bit_offset = window_index * window_bits;
        for (i, point) in points.iter().enumerate() {
            let w = pippenger_window(&scalar_bytes[i], bit_offset, window_bits);
            if w != 0 && w < buckets_len {
                buckets[w] += G1Projective::from(*point);
            }
        }

        let mut running = G1Projective::identity();
        let mut window_sum = G1Projective::identity();
        for idx in (1..buckets_len).rev() {
            running += buckets[idx];
            window_sum += running;
        }
        acc += window_sum;
    }

    acc
}

fn msm_pippenger_g1_projective(points: &[G1Projective], scalars: &[Scalar]) -> G1Projective {
    debug_assert_eq!(points.len(), scalars.len());

    let n = points.len().min(scalars.len());
    if n == 0 {
        return G1Projective::identity();
    }
    let points = &points[..n];
    let scalars = &scalars[..n];

    let window_bits = pippenger_window_size(points.len());
    let buckets_len = 1usize << window_bits;
    let windows = (256 + window_bits - 1) / window_bits;

    let scalar_bytes: Vec<[u8; 32]> = scalars
        .iter()
        .map(|s| {
            let repr = s.to_repr();
            let mut out = [0u8; 32];
            out.copy_from_slice(repr.as_ref());
            out
        })
        .collect();

    let mut buckets = vec![G1Projective::identity(); buckets_len];
    let mut acc = G1Projective::identity();

    for window_index in (0..windows).rev() {
        if window_index != windows - 1 {
            for _ in 0..window_bits {
                acc = acc.double();
            }
        }

        buckets.fill(G1Projective::identity());

        let bit_offset = window_index * window_bits;
        for (i, point) in points.iter().enumerate() {
            let w = pippenger_window(&scalar_bytes[i], bit_offset, window_bits);
            if w != 0 && w < buckets_len {
                buckets[w] += *point;
            }
        }

        let mut running = G1Projective::identity();
        let mut window_sum = G1Projective::identity();
        for idx in (1..buckets_len).rev() {
            running += buckets[idx];
            window_sum += running;
        }
        acc += window_sum;
    }

    acc
}

fn bytes_to_scalars(bytes: &[u8]) -> Result<Vec<Scalar>, KzgError> {
    // Map arbitrary 32-byte chunks (stored big-endian in blobs) into Scalars.
    // Using `from_bytes_wide` avoids BigUint/mod_floor overhead and is reliable on wasm.
    let mut scalars = Vec::with_capacity(4096);
    for chunk in bytes.chunks(32) {
        let mut wide = [0u8; 64];
        // Place chunk as the low limb in little-endian form.
        for (i, b) in chunk.iter().enumerate() {
            wide[i] = *b;
        }
        wide[..32].reverse();
        scalars.push(Scalar::from_bytes_wide(&wide));
    }
    Ok(scalars)
}

fn parse_g1(bytes: &[u8]) -> Result<G1Affine, KzgError> {
    if bytes.len() != 48 {
        return Err(KzgError::InvalidDataLength);
    }
    let p = Option::from(G1Affine::from_compressed(bytes.try_into().unwrap()));
    if p.is_none() {
        return Err(KzgError::Internal("Invalid G1".into()));
    }
    Ok(p.unwrap())
}

fn parse_scalar(bytes: &[u8]) -> Result<Scalar, KzgError> {
    if bytes.len() != 32 {
        return Err(KzgError::InvalidDataLength);
    }
    let mut repr = [0u8; 32];
    repr.copy_from_slice(bytes);
    repr.reverse();
    let s = Scalar::from_repr(repr);
    if bool::from(s.is_none()) {
        return Err(KzgError::Internal("Invalid scalar".into()));
    }
    Ok(s.unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::{fr_to_bytes_be, get_modulus};
    use num_bigint::BigUint;
    use num_integer::Integer;
    use rand::{RngCore, SeedableRng};
    use std::path::PathBuf;

    fn get_trusted_setup_path() -> PathBuf {
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.pop(); // repo root
        path.push("demos");
        path.push("kzg");
        path.push("trusted_setup.txt");
        path
    }

    #[test]
    fn bytes_to_scalars_accepts_arbitrary_blob_bytes() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        let mut blob = vec![0u8; BLOB_SIZE];
        rng.fill_bytes(&mut blob);

        let scalars = bytes_to_scalars(&blob).expect("arbitrary blob bytes should reduce");
        assert_eq!(scalars.len(), 4096);
    }

    #[test]
    fn bytes_to_scalars_matches_biguint_reduction() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        let mut blob = vec![0u8; BLOB_SIZE];
        rng.fill_bytes(&mut blob);

        let modulus = get_modulus();
        let expected: Vec<Scalar> = blob
            .chunks_exact(32)
            .map(|chunk| {
                let reduced = BigUint::from_bytes_be(chunk).mod_floor(&modulus);
                let mut repr = fr_to_bytes_be(&reduced);
                repr.reverse();
                Option::from(Scalar::from_repr(repr)).expect("reduced value must be a valid scalar")
            })
            .collect();

        let got = bytes_to_scalars(&blob).expect("bytes_to_scalars should succeed");
        assert_eq!(got, expected);
    }

    #[test]
    fn msm_matches_naive_sum_small_n() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(123);
        let n = 128;

        let points: Vec<G1Affine> = (0..n)
            .map(|_| {
                let mut wide = [0u8; 64];
                rng.fill_bytes(&mut wide);
                (G1Projective::generator() * Scalar::from_bytes_wide(&wide)).to_affine()
            })
            .collect();

        let scalars: Vec<Scalar> = (0..n)
            .map(|_| {
                let mut wide = [0u8; 64];
                rng.fill_bytes(&mut wide);
                Scalar::from_bytes_wide(&wide)
            })
            .collect();

        let mut naive = G1Projective::identity();
        for (p, s) in points.iter().zip(scalars.iter()) {
            naive += G1Projective::from(*p) * s;
        }

        let fast = msm_pippenger_g1(&points, &scalars);
        let points_projective: Vec<G1Projective> = points.iter().map(|p| G1Projective::from(*p)).collect();
        let fast_projective = msm_pippenger_g1_projective(&points_projective, &scalars);
        assert_eq!(fast.to_affine(), naive.to_affine());
        assert_eq!(fast_projective.to_affine(), naive.to_affine());
    }

    #[test]
    fn fft_round_trip_4096() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(99);
        let omega = scalar_for_cell_index(1).expect("omega must parse");

        let mut evals = Vec::with_capacity(4096);
        for _ in 0..4096 {
            let mut wide = [0u8; 64];
            rng.fill_bytes(&mut wide);
            evals.push(Scalar::from_bytes_wide(&wide));
        }
        let original = evals.clone();

        ifft_in_place(&mut evals, omega).expect("ifft must succeed");
        fft_in_place(&mut evals, omega).expect("fft must succeed");

        assert_eq!(evals, original, "fft(ifft(evals)) must recover evals");
    }

    #[test]
    fn verify_proof_round_trip() {
        let path = get_trusted_setup_path();
        let ctx = KzgContext::load_from_file(&path).unwrap();

        // p(x) = 1 in evaluation form: blob of all-ones field elements.
        let mut blob = vec![0u8; BLOB_SIZE];
        for i in 0..4096 {
            blob[i * 32 + 31] = 1;
        }

        let commitment = ctx.blob_to_commitment(&blob).unwrap();
        let z_bytes = crate::utils::z_for_cell(0); // z = 1
        let (proof, y_out) = ctx.compute_proof(&blob, &z_bytes).unwrap();

        let ok = ctx.verify_proof(&commitment, &z_bytes, &y_out, &proof).unwrap();
        assert!(ok, "KZG proof must verify for constant-one blob");
    }
}
