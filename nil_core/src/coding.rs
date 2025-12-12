use crate::kzg::{BLOB_SIZE, BLOBS_PER_MDU, KzgContext, KzgError, MDU_SIZE};
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
    const SCALAR_BYTES: usize = 32;
    const SCALAR_PAYLOAD_BYTES: usize = 31;
    const SCALARS_PER_BLOB: usize = BLOB_SIZE / SCALAR_BYTES; // 4096
    const SCALARS_PER_MDU: usize = BLOBS_PER_MDU * SCALARS_PER_BLOB; // 262_144
    const MDU_PAYLOAD_BYTES: usize = SCALARS_PER_MDU * SCALAR_PAYLOAD_BYTES; // 8_126_464

    let mut mdu = vec![0u8; MDU_SIZE];
    let payload = raw_data.get(..MDU_PAYLOAD_BYTES).unwrap_or(raw_data);

    for (scalar_idx, chunk) in payload.chunks(SCALAR_PAYLOAD_BYTES).enumerate() {
        if scalar_idx >= SCALARS_PER_MDU {
            break;
        }
        let start = scalar_idx * SCALAR_BYTES;
        let pad = SCALAR_BYTES - chunk.len();
        mdu[start + pad..start + SCALAR_BYTES].copy_from_slice(chunk);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::frs_to_blobs;
    use num_bigint::BigUint;

    fn encode_to_mdu_reference(raw_data: &[u8]) -> Vec<u8> {
        let mut frs = Vec::new();
        for chunk in raw_data.chunks(31) {
            frs.push(BigUint::from_bytes_be(chunk));
        }

        let blobs = frs_to_blobs(&frs);

        let mut mdu = Vec::with_capacity(MDU_SIZE);
        for blob in blobs {
            mdu.extend_from_slice(&blob);
            if mdu.len() >= MDU_SIZE {
                break;
            }
        }

        if mdu.len() < MDU_SIZE {
            mdu.resize(MDU_SIZE, 0);
        } else if mdu.len() > MDU_SIZE {
            mdu.truncate(MDU_SIZE);
        }

        mdu
    }

    #[test]
    fn encode_to_mdu_matches_reference_for_various_sizes() {
        let sizes = [
            0usize,
            1,
            30,
            31,
            32,
            100,
            126_975, // just before blob boundary (4096*31)
            126_976, // exactly one blob payload
            126_977,
            253_952, // two blob payloads
            300_000,
        ];

        for size in sizes {
            let mut raw = Vec::with_capacity(size);
            for i in 0..size {
                raw.push((((i as u64).wrapping_mul(7).wrapping_add(3)) % 256) as u8);
            }

            let expected = encode_to_mdu_reference(&raw);
            let got = encode_to_mdu(&raw);
            assert_eq!(got, expected, "size={size}");
        }
    }
}
