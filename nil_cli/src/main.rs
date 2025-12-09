use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use nil_core::{
    kzg::{KzgContext, MDU_SIZE, BLOBS_PER_MDU, BLOB_SIZE},
    utils::{z_for_cell},
};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;
use rs_merkle::{MerkleTree, Hasher};

// Define local Hasher to match nil_core's behavior
#[derive(Clone)]
pub struct Blake2s256Hasher;
impl rs_merkle::Hasher for Blake2s256Hasher {
    type Hash = [u8; 32];
    fn hash(data: &[u8]) -> [u8; 32] {
        use blake2::{Blake2s256, Digest};
        Blake2s256::digest(data).into()
    }
}

#[derive(Parser)]
#[command(name = "nil-cli")]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    #[arg(long, env = "CKZG_TRUSTED_SETUP", default_value = "trusted_setup.txt")]
    trusted_setup: PathBuf,
}

#[derive(Subcommand)]
enum Commands {
    Shard {
        file: PathBuf,
        #[arg(long, default_value = "5,17,42")]
        seeds: String, // Random bytes to challenge (simulating future retrieval)
        #[arg(long, default_value = "output.json")]
        out: PathBuf,
    },
    Verify {
        file: PathBuf,
    },
    Store {
        file: PathBuf,
        #[arg(long, default_value = "http://127.0.0.1:3000")]
        url: String,
        #[arg(long, default_value = "Alice")]
        owner: String,
    },
}

#[derive(Serialize, Deserialize)]
struct Output {
    filename: String,
    file_size_bytes: u64,
    total_mdus: usize,
    manifest_root_hex: String,
    manifest_blob_hex: String, // For debugging/verifying
    mdus: Vec<MduData>,
    sample_proofs: Vec<ChainedProof>, // Generated from seeds
}

#[derive(Serialize, Deserialize)]
struct MduData {
    index: usize,
    root_hex: String,
    blobs: Vec<String>, // List of 64 commitment hex strings
}

#[derive(Serialize, Deserialize)]
struct ChainedProof {
    // Challenge Info
    byte_offset: usize,
    
    // Hop 1: Manifest -> MDU
    mdu_index: usize,
    mdu_root_hex: String, // The value Y1
    manifest_proof_hex: String,
    
    // Hop 2: MDU -> Blob (Merkle)
    blob_index: usize,
    blob_commitment_hex: String, // The value Y2 (Leaf)
    merkle_path_hex: Vec<String>,
    
    // Hop 3: Blob -> Data (KZG)
    local_offset: usize, // Index within blob (0..4096)
    z_hex: String, // Challenge point Z3
    y_hex: String, // Value Y3 (The data symbol)
    blob_proof_hex: String,
    
    verified: bool,
}

#[derive(Serialize)]
struct StoreRequest {
    filename: String,
    root_hash: String,
    size: u64,
    owner: String,
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    // Only load trusted setup for shard/verify commands
    let needs_ts = match cli.command {
        Commands::Store { .. } => false,
        _ => true,
    };

    let ts_path = if needs_ts {
        if !cli.trusted_setup.exists() {
            let fallback = PathBuf::from("demos/kzg/trusted_setup.txt");
            if fallback.exists() && cli.trusted_setup.to_string_lossy() == "trusted_setup.txt" {
                eprintln!("Using fallback trusted setup at {:?}", fallback);
                fallback
            } else {
                cli.trusted_setup
            }
        } else {
            cli.trusted_setup
        }
    } else {
        cli.trusted_setup // ignored
    };

    match cli.command {
        Commands::Shard { file, seeds, out } => run_shard(file, seeds, out, ts_path),
        Commands::Verify { file } => run_verify(file, ts_path),
        Commands::Store { file, url, owner } => run_store(file, url, owner),
    }
}

fn run_shard(file: PathBuf, seeds: String, out: PathBuf, ts_path: PathBuf) -> Result<()> {
    let kzg_ctx = KzgContext::load_from_file(&ts_path)
        .context("Failed to load KZG trusted setup")?;

    println!("Sharding file: {:?}", file);
    let mut data = std::fs::read(&file).context("Failed to read input file")?;
    let original_len = data.len();

    // 1. Chunk into MDUs (8 MiB)
    // Pad to multiple of MDU_SIZE if needed? 
    // Spec says: MDU is 8MiB. If file is smaller, pad it?
    // Let's pad the data to MDU boundary.
    if data.len() % MDU_SIZE != 0 {
        let padding = MDU_SIZE - (data.len() % MDU_SIZE);
        data.resize(data.len() + padding, 0);
    }
    
    let mdu_chunks: Vec<&[u8]> = data.chunks(MDU_SIZE).collect();
    let total_mdus = mdu_chunks.len();
    println!("Total MDUs: {}", total_mdus);

    let mut mdu_roots_bytes: Vec<[u8; 32]> = Vec::new();
    let mut mdu_outputs = Vec::new();
    let mut all_mdu_commitments = Vec::new(); // Store commitments for proof generation

    // 2. Process each MDU
    for (i, chunk) in mdu_chunks.iter().enumerate() {
        println!("Processing MDU {}/{}...", i + 1, total_mdus);
        
        // a. Get Commitments (64 blobs)
        let commitments = kzg_ctx.mdu_to_kzg_commitments(chunk)?;
        
        // b. Compute Merkle Root
        let root_bytes32 = kzg_ctx.create_mdu_merkle_root(&commitments)?;
        let root_arr: [u8; 32] = root_bytes32.as_slice().try_into().unwrap();
        mdu_roots_bytes.push(root_arr);
        
        all_mdu_commitments.push(commitments.clone());

        let blob_hex_list: Vec<String> = commitments.iter()
            .map(|c| format!("0x{}", hex::encode(c.as_slice())))
            .collect();
        
        mdu_outputs.push(MduData {
            index: i,
            root_hex: format!("0x{}", hex::encode(root_arr)),
            blobs: blob_hex_list,
        });
    }

    // 3. Compute Manifest
    println!("Computing Manifest...");
    let (manifest_commitment, manifest_blob) = kzg_ctx.compute_manifest_commitment(&mdu_roots_bytes)?;
    let manifest_root_hex = format!("0x{}", hex::encode(manifest_commitment.as_slice()));
    let manifest_blob_hex = format!("0x{}", hex::encode(&manifest_blob));

    println!("Manifest Root: {}", manifest_root_hex);

    // 4. Generate Sample Proofs (Chained)
    let seed_list: Vec<u64> = seeds.split(',')
        .filter_map(|s| s.trim().parse().ok())
        .collect();

    let mut sample_proofs = Vec::new();

    for seed in seed_list {
        // Pick a random byte in the original file
        let mut rng = StdRng::seed_from_u64(seed);
        let byte_offset = rng.random_range(0..original_len);
        
        // Calculate coordinates
        // Global Offset -> MDU Index -> Blob Index -> Local Offset
        let mdu_idx = byte_offset / MDU_SIZE;
        let offset_in_mdu = byte_offset % MDU_SIZE;
        let blob_idx = offset_in_mdu / BLOB_SIZE;
        let offset_in_blob = offset_in_mdu % BLOB_SIZE; 
        
        // Note: KZG works on "Symbols" (32 bytes). 
        // We usually prove a whole symbol.
        // Let's align to symbol boundary for the proof.
        let symbol_idx_in_blob = offset_in_blob / 32;
        
        // --- Hop 1: Manifest Inclusion ---
        // Verify that mdu_roots_bytes[mdu_idx] is in manifest
        let z_mdu = z_for_cell(mdu_idx);
        let (manifest_proof, _) = kzg_ctx.compute_proof(&manifest_blob, &z_mdu)?;
        
        // --- Hop 2: Merkle Inclusion ---
        // Verify that blob[blob_idx] is in MDU[mdu_idx]
        let commitments = &all_mdu_commitments[mdu_idx];
        let target_blob_commitment = &commitments[blob_idx];
        
        let leaves: Vec<[u8; 32]> = commitments.iter()
            .map(|c| Blake2s256Hasher::hash(c.as_slice()))
            .collect();
        let merkle_tree = MerkleTree::<Blake2s256Hasher>::from_leaves(&leaves);
        let merkle_proof = merkle_tree.proof(&[blob_idx]);
        let merkle_path_hex: Vec<String> = merkle_proof.proof_hashes().iter()
            .map(|h| format!("0x{}", hex::encode(h)))
            .collect();

        // --- Hop 3: Data Inclusion ---
        // Verify symbol at symbol_idx_in_blob is in blob[blob_idx]
        let z_blob = z_for_cell(symbol_idx_in_blob);
        
        // Extract blob bytes
        let mdu_start = mdu_idx * MDU_SIZE;
        let blob_start = mdu_start + (blob_idx * BLOB_SIZE);
        let blob_bytes = &data[blob_start .. blob_start + BLOB_SIZE];
        
        let (blob_proof, y_blob) = kzg_ctx.compute_proof(blob_bytes, &z_blob)?;
        
        // --- Verify (Simulate) ---
        // 1. Manifest
        let v1 = kzg_ctx.verify_manifest_inclusion(
            manifest_commitment.as_slice(),
            &mdu_roots_bytes[mdu_idx],
            mdu_idx,
            manifest_proof.as_slice()
        )?;
        
        // 2. Merkle
        let root_arr = mdu_roots_bytes[mdu_idx];
        let leaf = Blake2s256Hasher::hash(target_blob_commitment.as_slice());
        let v2 = merkle_proof.verify(
            root_arr,
            &[blob_idx],
            &[leaf],
            BLOBS_PER_MDU
        );
        
        // 3. Data
        let v3 = kzg_ctx.verify_proof(
            target_blob_commitment.as_slice(),
            &z_blob,
            y_blob.as_slice(),
            blob_proof.as_slice()
        )?;
        
        let verified = v1 && v2 && v3;
        
        sample_proofs.push(ChainedProof {
            byte_offset,
            mdu_index: mdu_idx,
            mdu_root_hex: format!("0x{}", hex::encode(mdu_roots_bytes[mdu_idx])),
            manifest_proof_hex: format!("0x{}", hex::encode(manifest_proof.as_slice())),
            
            blob_index: blob_idx,
            blob_commitment_hex: format!("0x{}", hex::encode(target_blob_commitment.as_slice())),
            merkle_path_hex,
            
            local_offset: symbol_idx_in_blob,
            z_hex: format!("0x{}", hex::encode(z_blob)),
            y_hex: format!("0x{}", hex::encode(y_blob.as_slice())),
            blob_proof_hex: format!("0x{}", hex::encode(blob_proof.as_slice())),
            
            verified,
        });
    }

    let output = Output {
        filename: file.to_string_lossy().into_owned(),
        file_size_bytes: original_len as u64,
        total_mdus,
        manifest_root_hex,
        manifest_blob_hex,
        mdus: mdu_outputs,
        sample_proofs,
    };

    let json = serde_json::to_string_pretty(&output)?;
    std::fs::write(&out, json)?;
    println!("Saved output to {:?}", out);
    Ok(())
}

fn run_verify(file: PathBuf, ts_path: PathBuf) -> Result<()> {
    let kzg_ctx = KzgContext::load_from_file(&ts_path)
        .context("Failed to load KZG trusted setup")?;

    println!("Verifying proofs in: {:?}", file);
    let data = std::fs::read_to_string(&file).context("Failed to read proof file")?;
    let output: Output = serde_json::from_str(&data)?;

    let mut all_valid = true;
    let manifest_root = hex::decode(&output.manifest_root_hex[2..])?;
    
    for (i, proof) in output.sample_proofs.iter().enumerate() {
        println!("Verifying Sample Proof {} (Offset {})...", i, proof.byte_offset);
        
        // Hop 1
        let mdu_root = hex::decode(&proof.mdu_root_hex[2..])?;
        let manifest_proof = hex::decode(&proof.manifest_proof_hex[2..])?;
        let v1 = kzg_ctx.verify_manifest_inclusion(
            &manifest_root,
            &mdu_root,
            proof.mdu_index,
            &manifest_proof
        )?;
        if !v1 { println!("  Hop 1 (Manifest) FAILED"); all_valid = false; continue; }
        
        // Hop 2
        // We need to reconstruct Merkle Proof from hex
        let hashes: Vec<[u8; 32]> = proof.merkle_path_hex.iter().map(|h| {
            let b = hex::decode(&h[2..]).unwrap();
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&b);
            arr
        }).collect();
        
        let merkle_proof = rs_merkle::MerkleProof::<Blake2s256Hasher>::new(hashes);
        let blob_comm = hex::decode(&proof.blob_commitment_hex[2..])?;
        let leaf = Blake2s256Hasher::hash(&blob_comm);
        let root_arr: [u8; 32] = mdu_root.as_slice().try_into().unwrap();
        
        let v2 = merkle_proof.verify(
            root_arr,
            &[proof.blob_index],
            &[leaf],
            BLOBS_PER_MDU
        );
        if !v2 { println!("  Hop 2 (Merkle) FAILED"); all_valid = false; continue; }
        
        // Hop 3
        let z = hex::decode(&proof.z_hex[2..])?;
        let y = hex::decode(&proof.y_hex[2..])?;
        let blob_proof = hex::decode(&proof.blob_proof_hex[2..])?;
        
        let v3 = kzg_ctx.verify_proof(
            &blob_comm,
            &z,
            &y,
            &blob_proof
        )?;
        if !v3 { println!("  Hop 3 (KZG) FAILED"); all_valid = false; continue; }
        
        println!("  OK");
    }

    if all_valid {
        println!("All sample proofs verified.");
    } else {
        std::process::exit(1);
    }
    Ok(())
}

fn run_store(file: PathBuf, url: String, owner: String) -> Result<()> {
    let json_content = std::fs::read_to_string(&file).context("Failed to read input file")?;
    let output: Output = serde_json::from_str(&json_content).context("Failed to parse JSON input.")?;

    let client = reqwest::blocking::Client::new();
    let endpoint = format!("{}/store", url);

    let req = StoreRequest {
        filename: output.filename,
        root_hash: output.manifest_root_hex, // New root
        size: output.file_size_bytes,
        owner,
    };

    let res = client.post(&endpoint)
        .json(&req)
        .send()
        .context("Failed to send request to L1")?;

    if res.status().is_success() {
        println!("Success! L1 response: {}", res.text()?);
    } else {
        eprintln!("Error: L1 returned {}", res.status());
        eprintln!("Body: {}", res.text()?);
        std::process::exit(1);
    }

    Ok(())
}