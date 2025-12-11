use crate::kzg::{BLOB_SIZE, KzgContext, KzgError, MDU_SIZE};
use reed_solomon_erasure::galois_8::ReedSolomon;
use thiserror::Error;

pub const SHARDS_NUM: usize = 12;
pub const DATA_SHARDS_NUM: usize = 8;
pub const PARITY_SHARDS_NUM: usize = SHARDS_NUM - DATA_SHARDS_NUM;
pub const BLOBS_PER_SHARD: usize = 8; // 1MB / 128KB

#[derive(Error, Debug)]
pub enum CodingError {
    #[error("RS Error: {0}")]
    Rs(String),
    #[error("KZG Error: {0}")]
    Kzg(#[from] KzgError),
    #[error("Invalid Input Size")]
    InvalidSize,
}

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct ExpandedMdu {
    pub witness: Vec<Vec<u8>>, // 96 commitments (48 bytes each)
    pub shards: Vec<Vec<u8>>,  // 12 shards of 1MB each
}

fn encode_to_mdu(raw_data: &[u8]) -> Vec<u8> {
    // Mirror nil_cli encode_to_mdu: map bytes into field elements then blobs.
    use crate::utils::frs_to_blobs;
    use num_bigint::BigUint;

    // 1. Chunk into 31-byte scalars (safe for the field)
    let mut frs = Vec::new();
    for chunk in raw_data.chunks(31) {
        let bn = BigUint::from_bytes_be(chunk);
        frs.push(bn);
    }

    // 2. Map Frs into 4096-scalar blobs
    let blobs = frs_to_blobs(&frs);

    // 3. Flatten blobs into an 8MiB MDU
    let mut mdu = Vec::with_capacity(MDU_SIZE);
    for blob in blobs {
        mdu.extend_from_slice(&blob);
    }

    // 4. Pad MDU to 8MiB if needed
    if mdu.len() < MDU_SIZE {
        mdu.resize(MDU_SIZE, 0);
    }

    mdu
}

pub fn expand_mdu(ctx: &KzgContext, data: &[u8]) -> Result<ExpandedMdu, CodingError> {
    if data.len() != 8 * 1024 * 1024 {
        return Err(CodingError::InvalidSize);
    }

    // Encode raw bytes into a single MDU (field-aligned blobs).
    let encoded = encode_to_mdu(data);

    // 1. Organize data into 8 Shards of 8 Blobs each
    let mut shards: Vec<Vec<u8>> = vec![vec![0u8; 1024 * 1024]; SHARDS_NUM];

    // Fill first 8 shards with data (Card Dealing)
    // Blob i goes to Shard (i % 8), Row (i / 8)
    for blob_idx in 0..64 {
        let shard_idx = blob_idx % 8;
        let row_idx = blob_idx / 8; // 0..7

        let start = blob_idx * BLOB_SIZE;
        let end = start + BLOB_SIZE;
        let blob_data = &encoded[start..end];

        let dest_start = row_idx * BLOB_SIZE;
        let dest_end = dest_start + BLOB_SIZE;

        shards[shard_idx][dest_start..dest_end].copy_from_slice(blob_data);
    }

    // 2. Compute Parity Shards (8..11)
    let r = ReedSolomon::new(DATA_SHARDS_NUM, PARITY_SHARDS_NUM)
        .map_err(|e| CodingError::Rs(format!("{}", e)))?;

    for row_idx in 0..8 {
        // Collect the 8 data blobs for this row
        let mut row_shards: Vec<Vec<u8>> = Vec::with_capacity(SHARDS_NUM);
        for s in 0..DATA_SHARDS_NUM {
            let start = row_idx * BLOB_SIZE;
            let blob = shards[s][start..start + BLOB_SIZE].to_vec();
            row_shards.push(blob);
        }
        // Fill parity placeholders
        for _ in 0..PARITY_SHARDS_NUM {
            row_shards.push(vec![0u8; BLOB_SIZE]);
        }

        // Encode
        r.encode(&mut row_shards)
            .map_err(|e| CodingError::Rs(format!("{}", e)))?;

        // Write parity back to `shards`
        for p in 0..PARITY_SHARDS_NUM {
            let shard_idx = DATA_SHARDS_NUM + p;
            let start = row_idx * BLOB_SIZE;
            shards[shard_idx][start..start + BLOB_SIZE].copy_from_slice(&row_shards[shard_idx]);
        }
    }

    // 3. Commit to EVERYTHING (All 96 Blobs)
    let mut witness = Vec::with_capacity(96);

    // Data Blobs (0..63)
    for i in 0..64 {
        let start = i * BLOB_SIZE;
        witness.push(
            ctx.blob_to_commitment(&encoded[start..start + BLOB_SIZE])?
                .to_vec(),
        );
    }

    // Parity Blobs (64..95) - Ordered by Shard then Row
    for s in DATA_SHARDS_NUM..SHARDS_NUM {
        for b in 0..8 {
            let start = b * BLOB_SIZE;
            let blob = &shards[s][start..start + BLOB_SIZE];
            witness.push(ctx.blob_to_commitment(blob)?.to_vec());
        }
    }

    Ok(ExpandedMdu { witness, shards })
}
