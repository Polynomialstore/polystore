use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

use nil_core::coding::{expand_mdu, expand_mdu_encoded};
use nil_core::kzg::KzgContext;

#[derive(serde::Serialize)]
struct FixtureInfo {
    mdu_bytes: usize,
    blob_bytes: usize,
    root_count: usize,
    root_indices: Vec<u8>,
}

#[derive(serde::Serialize)]
struct ExpandInfo {
    witness_sha256: String,
    shards_sha256: String,
    witness_count: usize,
    shard_count: usize,
    mdu_root: String,
}

#[derive(serde::Serialize)]
struct ExpandRsInfo {
    k: usize,
    m: usize,
    witness_sha256: String,
    shards_sha256: String,
    witness_count: usize,
    shard_count: usize,
    mdu_root: String,
}

#[derive(serde::Serialize)]
struct BlobCommitmentInfo {
    blob_bytes: usize,
    commitment_hex: String,
    commitment_sha256: String,
}

#[derive(serde::Serialize)]
struct CommitMduInfo {
    witness_sha256: String,
    mdu_root: String,
}

#[derive(serde::Serialize)]
struct ManifestInfo {
    manifest_root: String,
    manifest_blob_sha256: String,
}

#[derive(serde::Serialize)]
struct ParityOutput {
    fixture: FixtureInfo,
    expand_mdu: ExpandInfo,
    expand_mdu_rs: ExpandRsInfo,
    blob_commitment: BlobCommitmentInfo,
    commit_mdu: CommitMduInfo,
    manifest: ManifestInfo,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    hex::encode(digest)
}

fn sha256_chunks(chunks: &[Vec<u8>]) -> String {
    let mut hasher = Sha256::new();
    for chunk in chunks {
        let len = chunk.len() as u64;
        hasher.update(len.to_le_bytes());
        hasher.update(chunk);
    }
    let digest = hasher.finalize();
    hex::encode(digest)
}

fn derive_roots(base: [u8; 32], indices: &[u8]) -> Vec<[u8; 32]> {
    let mut out = Vec::with_capacity(indices.len());
    for idx in indices {
        let mut root = base;
        root[0] ^= *idx;
        root[31] ^= idx.wrapping_mul(29);
        out.push(root);
    }
    out
}

fn pick_indices(count: usize) -> Vec<u8> {
    const ROOT_SEED: u32 = 0xC0FFEE;
    let mut seed = ROOT_SEED;
    let mut out: Vec<u8> = Vec::with_capacity(count);
    while out.len() < count {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        let idx = (seed % 255 + 1) as u8; // 1..255 (avoid trivial 0)
        if !out.contains(&idx) {
            out.push(idx);
        }
    }
    out
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixtures_dir = manifest_dir.join("fixtures").join("parity");
    let mdu_path = fixtures_dir.join("mdu_8m.bin");
    let blob_path = fixtures_dir.join("blob_128k.bin");
    let setup_path = manifest_dir.join("..").join("nilchain").join("trusted_setup.txt");

    let mdu_bytes = fs::read(mdu_path)?;
    let blob_bytes = fs::read(blob_path)?;
    let setup_bytes = fs::read(setup_path)?;

    let ctx = KzgContext::load_from_reader(std::io::Cursor::new(setup_bytes))?;

    let expanded = expand_mdu(&ctx, &mdu_bytes)?;
    let witness_hash = sha256_chunks(&expanded.witness);
    let shards_hash = sha256_chunks(&expanded.shards);

    if expanded.witness.is_empty() {
        return Err("no witness commitments for mdu root".into());
    }

    let mut commitments = Vec::with_capacity(expanded.witness.len());
    for w in expanded.witness.iter() {
        if w.len() != 48 {
            return Err(format!("unexpected witness commitment length: {}", w.len()).into());
        }
        let mut c = [0u8; 48];
        c.copy_from_slice(w);
        commitments.push(c);
    }

    let mdu_root = ctx.create_mdu_merkle_root(&commitments)?;

    let rs_k = 4usize;
    let rs_m = 2usize;
    let expanded_rs = expand_mdu_encoded(&ctx, &mdu_bytes, rs_k, rs_m)?;
    let rs_witness_hash = sha256_chunks(&expanded_rs.witness);
    let rs_shards_hash = sha256_chunks(&expanded_rs.shards);
    let mut rs_commitments = Vec::with_capacity(expanded_rs.witness.len());
    for w in expanded_rs.witness.iter() {
        if w.len() != 48 {
            return Err(format!("unexpected rs witness commitment length: {}", w.len()).into());
        }
        let mut c = [0u8; 48];
        c.copy_from_slice(w);
        rs_commitments.push(c);
    }
    let rs_mdu_root = ctx.create_mdu_merkle_root(&rs_commitments)?;

    let blob_commitment = ctx.blob_to_commitment(&blob_bytes)?;
    let blob_commitment_hex = format!("0x{}", hex::encode(blob_commitment));
    let blob_commitment_sha256 = sha256_hex(&blob_commitment);

    let mdu_commitments = ctx.mdu_to_kzg_commitments(&mdu_bytes)?;
    let mut mdu_witness_flat = Vec::with_capacity(mdu_commitments.len() * 48);
    for c in mdu_commitments.iter() {
        mdu_witness_flat.extend_from_slice(c);
    }
    let mdu_commit_root = ctx.create_mdu_merkle_root(&mdu_commitments)?;
    let mdu_witness_sha256 = sha256_hex(&mdu_witness_flat);
    let root_indices = pick_indices(4);
    let roots = derive_roots(mdu_root, &root_indices);
    let (manifest_commitment, manifest_blob) = ctx.compute_manifest_commitment(&roots)?;

    let output = ParityOutput {
        fixture: FixtureInfo {
            mdu_bytes: mdu_bytes.len(),
            blob_bytes: blob_bytes.len(),
            root_count: roots.len(),
            root_indices,
        },
        expand_mdu: ExpandInfo {
            witness_sha256: witness_hash,
            shards_sha256: shards_hash,
            witness_count: expanded.witness.len(),
            shard_count: expanded.shards.len(),
            mdu_root: format!("0x{}", hex::encode(mdu_root)),
        },
        expand_mdu_rs: ExpandRsInfo {
            k: rs_k,
            m: rs_m,
            witness_sha256: rs_witness_hash,
            shards_sha256: rs_shards_hash,
            witness_count: expanded_rs.witness.len(),
            shard_count: expanded_rs.shards.len(),
            mdu_root: format!("0x{}", hex::encode(rs_mdu_root)),
        },
        blob_commitment: BlobCommitmentInfo {
            blob_bytes: blob_bytes.len(),
            commitment_hex: blob_commitment_hex,
            commitment_sha256: blob_commitment_sha256,
        },
        commit_mdu: CommitMduInfo {
            witness_sha256: mdu_witness_sha256,
            mdu_root: format!("0x{}", hex::encode(mdu_commit_root)),
        },
        manifest: ManifestInfo {
            manifest_root: format!("0x{}", hex::encode(manifest_commitment)),
            manifest_blob_sha256: sha256_hex(&manifest_blob),
        },
    };

    let json = serde_json::to_string(&output)?;
    println!("{json}");
    Ok(())
}
