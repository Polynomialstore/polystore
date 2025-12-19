use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

use nil_core::coding::expand_mdu;
use nil_core::kzg::KzgContext;

#[derive(serde::Serialize)]
struct FixtureInfo {
    mdu_bytes: usize,
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
struct ManifestInfo {
    manifest_root: String,
    manifest_blob_sha256: String,
}

#[derive(serde::Serialize)]
struct ParityOutput {
    fixture: FixtureInfo,
    expand_mdu: ExpandInfo,
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
    let setup_path = manifest_dir.join("..").join("nilchain").join("trusted_setup.txt");

    let mdu_bytes = fs::read(mdu_path)?;
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
    let root_indices = pick_indices(4);
    let roots = derive_roots(mdu_root, &root_indices);
    let (manifest_commitment, manifest_blob) = ctx.compute_manifest_commitment(&roots)?;

    let output = ParityOutput {
        fixture: FixtureInfo {
            mdu_bytes: mdu_bytes.len(),
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
        manifest: ManifestInfo {
            manifest_root: format!("0x{}", hex::encode(manifest_commitment)),
            manifest_blob_sha256: sha256_hex(&manifest_blob),
        },
    };

    let json = serde_json::to_string(&output)?;
    println!("{json}");
    Ok(())
}
