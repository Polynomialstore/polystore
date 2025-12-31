use crate::kzg::{BLOB_SIZE, BLOBS_PER_MDU, KzgContext, KzgError, MDU_SIZE};
use reed_solomon_erasure::galois_8::ReedSolomon;
use thiserror::Error;

pub const SHARDS_NUM: usize = 12;
pub const DATA_SHARDS_NUM: usize = 8;
pub const PARITY_SHARDS_NUM: usize = SHARDS_NUM - DATA_SHARDS_NUM;
pub const BLOBS_PER_SHARD: usize = 8; // 1MB / 128KB

pub const SCALAR_BYTES: usize = 32;
pub const SCALAR_PAYLOAD_BYTES: usize = 31;
pub const SCALARS_PER_BLOB: usize = BLOB_SIZE / SCALAR_BYTES; // 4096
pub const SCALARS_PER_MDU: usize = BLOBS_PER_MDU * SCALARS_PER_BLOB; // 262_144
pub const MDU_PAYLOAD_BYTES: usize = SCALARS_PER_MDU * SCALAR_PAYLOAD_BYTES; // 8_126_464

#[derive(Error, Debug)]
pub enum CodingError {
    #[error("RS Error: {0}")]
    Rs(String),
    #[error("KZG Error: {0}")]
    Kzg(#[from] KzgError),
    #[error("Invalid RS parameters")]
    InvalidRsParams,
    #[error("Invalid Input Size")]
    InvalidSize,
}

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct ExpandedMdu {
    pub witness: Vec<Vec<u8>>, // Commitments in slot-major order (48 bytes each)
    pub shards: Vec<Vec<u8>>,  // Shards per slot (rows * 128 KiB)
}

fn encode_to_mdu(raw_data: &[u8]) -> Vec<u8> {
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

fn encode_payload_into_blob(payload: &[u8], payload_base: usize, out_blob: &mut [u8]) {
    debug_assert_eq!(out_blob.len(), BLOB_SIZE);

    out_blob.fill(0);
    if payload_base >= payload.len() {
        return;
    }

    let mut src = payload_base;
    for scalar_idx in 0..SCALARS_PER_BLOB {
        if src >= payload.len() {
            break;
        }
        let remaining = payload.len() - src;
        let chunk_len = remaining.min(SCALAR_PAYLOAD_BYTES);
        if chunk_len == 0 {
            break;
        }

        let dst_scalar = scalar_idx * SCALAR_BYTES;
        let pad = SCALAR_BYTES - chunk_len;
        out_blob[dst_scalar + pad..dst_scalar + pad + chunk_len]
            .copy_from_slice(&payload[src..src + chunk_len]);

        src += chunk_len;
        if chunk_len < SCALAR_PAYLOAD_BYTES {
            break;
        }
    }
}

pub fn expand_mdu(ctx: &KzgContext, data: &[u8]) -> Result<ExpandedMdu, CodingError> {
    if data.len() != 8 * 1024 * 1024 {
        return Err(CodingError::InvalidSize);
    }

    // Encode raw bytes into a single MDU (field-aligned blobs).
    let encoded = encode_to_mdu(data);
    expand_mdu_encoded(ctx, &encoded, DATA_SHARDS_NUM, PARITY_SHARDS_NUM)
}

pub fn expand_mdu_encoded(
    ctx: &KzgContext,
    mdu_bytes: &[u8],
    data_shards: usize,
    parity_shards: usize,
) -> Result<ExpandedMdu, CodingError> {
    if mdu_bytes.len() != MDU_SIZE {
        return Err(CodingError::InvalidSize);
    }
    if data_shards == 0 || parity_shards == 0 {
        return Err(CodingError::InvalidRsParams);
    }
    if BLOBS_PER_MDU % data_shards != 0 {
        return Err(CodingError::InvalidRsParams);
    }

    let rows = BLOBS_PER_MDU / data_shards;
    let shards_total = data_shards + parity_shards;
    let mut shards: Vec<Vec<u8>> = vec![vec![0u8; rows * BLOB_SIZE]; shards_total];

    let r = ReedSolomon::new(data_shards, parity_shards)
        .map_err(|e| CodingError::Rs(format!("{}", e)))?;

    for row_idx in 0..rows {
        let dest_start = row_idx * BLOB_SIZE;
        let dest_end = dest_start + BLOB_SIZE;

        // Encode the row in-place directly into the final shard buffers to avoid per-row
        // allocations and extra copies.
        let mut row_shards: Vec<&mut [u8]> = shards
            .iter_mut()
            .map(|shard| &mut shard[dest_start..dest_end])
            .collect();

        for slot in 0..data_shards {
            let blob_idx = row_idx * data_shards + slot;
            let start = blob_idx * BLOB_SIZE;
            let end = start + BLOB_SIZE;
            row_shards[slot].copy_from_slice(&mdu_bytes[start..end]);
        }
        for slot in data_shards..shards_total {
            row_shards[slot].fill(0);
        }

        r.encode(&mut row_shards)
            .map_err(|e| CodingError::Rs(format!("{}", e)))?;
    }

    let mut witness = Vec::with_capacity(shards_total * rows);
    for slot in 0..shards_total {
        for row_idx in 0..rows {
            let start = row_idx * BLOB_SIZE;
            let blob = &shards[slot][start..start + BLOB_SIZE];
            witness.push(ctx.blob_to_commitment(blob)?.to_vec());
        }
    }

    Ok(ExpandedMdu { witness, shards })
}

/// Expands an encoded 8 MiB MDU into Mode 2 RS shards and witness commitments, writing the results
/// into flat output buffers.
///
/// Output layout:
/// - `out_witness_flat`: slot-major commitments, 48 bytes each, length = (K+M)*(64/K)*48
/// - `out_shards_flat`: slot-major shard bytes, length = (K+M)*(64/K)*BLOB_SIZE
pub fn expand_mdu_encoded_flat(
    ctx: &KzgContext,
    mdu_bytes: &[u8],
    data_shards: usize,
    parity_shards: usize,
    out_witness_flat: &mut [u8],
    out_shards_flat: &mut [u8],
) -> Result<(), CodingError> {
    if mdu_bytes.len() != MDU_SIZE {
        return Err(CodingError::InvalidSize);
    }
    if data_shards == 0 || parity_shards == 0 {
        return Err(CodingError::InvalidRsParams);
    }
    if BLOBS_PER_MDU % data_shards != 0 {
        return Err(CodingError::InvalidRsParams);
    }

    let rows = BLOBS_PER_MDU / data_shards;
    let shards_total = data_shards + parity_shards;
    let shard_len = rows * BLOB_SIZE;

    let expected_witness_len = shards_total * rows * 48;
    let expected_shards_len = shards_total * shard_len;
    if out_witness_flat.len() != expected_witness_len || out_shards_flat.len() != expected_shards_len {
        return Err(CodingError::InvalidSize);
    }

    let r = ReedSolomon::new(data_shards, parity_shards)
        .map_err(|e| CodingError::Rs(format!("{}", e)))?;

    for row_idx in 0..rows {
        let mut row_shards: Vec<&mut [u8]> = Vec::with_capacity(shards_total);
        let base_ptr = out_shards_flat.as_mut_ptr();
        for slot in 0..shards_total {
            let offset = slot * shard_len + row_idx * BLOB_SIZE;
            // SAFETY: each `(slot, row_idx)` maps to a disjoint BLOB_SIZE region within the
            // `out_shards_flat` buffer.
            row_shards.push(unsafe { std::slice::from_raw_parts_mut(base_ptr.add(offset), BLOB_SIZE) });
        }

        for slot in 0..data_shards {
            let blob_idx = row_idx * data_shards + slot;
            let start = blob_idx * BLOB_SIZE;
            let end = start + BLOB_SIZE;
            row_shards[slot].copy_from_slice(&mdu_bytes[start..end]);
        }
        for slot in data_shards..shards_total {
            row_shards[slot].fill(0);
        }

        r.encode(&mut row_shards)
            .map_err(|e| CodingError::Rs(format!("{}", e)))?;

        for slot in 0..shards_total {
            let commitment = ctx.blob_to_commitment(row_shards[slot])?;
            let woff = (slot * rows + row_idx) * 48;
            out_witness_flat[woff..woff + 48].copy_from_slice(&commitment);
        }
    }

    Ok(())
}

/// Expands a raw payload (up to `MDU_PAYLOAD_BYTES`) into Mode 2 RS shards and witness commitments,
/// writing the results into flat output buffers.
///
/// The payload is encoded into the field-aligned MDU layout (31-byte chunks right-aligned in 32-byte
/// scalars) before RS encoding.
pub fn expand_payload_flat(
    ctx: &KzgContext,
    payload_bytes: &[u8],
    data_shards: usize,
    parity_shards: usize,
    out_witness_flat: &mut [u8],
    out_shards_flat: &mut [u8],
) -> Result<(), CodingError> {
    if data_shards == 0 || parity_shards == 0 {
        return Err(CodingError::InvalidRsParams);
    }
    if BLOBS_PER_MDU % data_shards != 0 {
        return Err(CodingError::InvalidRsParams);
    }

    let payload = payload_bytes.get(..MDU_PAYLOAD_BYTES).unwrap_or(payload_bytes);

    let rows = BLOBS_PER_MDU / data_shards;
    let shards_total = data_shards + parity_shards;
    let shard_len = rows * BLOB_SIZE;

    let expected_witness_len = shards_total * rows * 48;
    let expected_shards_len = shards_total * shard_len;
    if out_witness_flat.len() != expected_witness_len || out_shards_flat.len() != expected_shards_len {
        return Err(CodingError::InvalidSize);
    }

    let r = ReedSolomon::new(data_shards, parity_shards)
        .map_err(|e| CodingError::Rs(format!("{}", e)))?;

    // RS encode and commit row-by-row to keep the working set small (and avoid an intermediate 8 MiB MDU buffer).
    for row_idx in 0..rows {
        let mut row_shards: Vec<&mut [u8]> = Vec::with_capacity(shards_total);
        let base_ptr = out_shards_flat.as_mut_ptr();
        for slot in 0..shards_total {
            let offset = slot * shard_len + row_idx * BLOB_SIZE;
            // SAFETY: each `(slot, row_idx)` maps to a disjoint BLOB_SIZE region within the
            // `out_shards_flat` buffer.
            row_shards.push(unsafe { std::slice::from_raw_parts_mut(base_ptr.add(offset), BLOB_SIZE) });
        }

        for slot in 0..data_shards {
            let blob_idx = row_idx * data_shards + slot;
            let payload_base = blob_idx * SCALARS_PER_BLOB * SCALAR_PAYLOAD_BYTES;
            encode_payload_into_blob(payload, payload_base, row_shards[slot]);
        }
        for slot in data_shards..shards_total {
            row_shards[slot].fill(0);
        }

        r.encode(&mut row_shards)
            .map_err(|e| CodingError::Rs(format!("{}", e)))?;

        for slot in 0..shards_total {
            let commitment = ctx.blob_to_commitment(row_shards[slot])?;
            let woff = (slot * rows + row_idx) * 48;
            out_witness_flat[woff..woff + 48].copy_from_slice(&commitment);
        }
    }

    Ok(())
}

pub fn reconstruct_mdu_from_shards(
    shards: &mut [Option<Vec<u8>>],
    data_shards: usize,
    parity_shards: usize,
) -> Result<Vec<u8>, CodingError> {
    if data_shards == 0 || parity_shards == 0 {
        return Err(CodingError::InvalidRsParams);
    }
    if BLOBS_PER_MDU % data_shards != 0 {
        return Err(CodingError::InvalidRsParams);
    }
    let shards_total = data_shards + parity_shards;
    if shards.len() != shards_total {
        return Err(CodingError::InvalidRsParams);
    }
    let rows = BLOBS_PER_MDU / data_shards;
    let expected_shard_len = rows * BLOB_SIZE;

    let mut present = 0usize;
    for shard in shards.iter() {
        if let Some(bytes) = shard {
            if bytes.len() != expected_shard_len {
                return Err(CodingError::InvalidSize);
            }
            present += 1;
        }
    }
    if present < data_shards {
        return Err(CodingError::Rs("not enough shards to reconstruct".to_string()));
    }

    let r = ReedSolomon::new(data_shards, parity_shards)
        .map_err(|e| CodingError::Rs(format!("{}", e)))?;
    r.reconstruct(shards)
        .map_err(|e| CodingError::Rs(format!("{}", e)))?;

    let mut mdu = vec![0u8; MDU_SIZE];
    for row_idx in 0..rows {
        let row_offset = row_idx * BLOB_SIZE;
        for slot in 0..data_shards {
            let blob_idx = row_idx * data_shards + slot;
            let dst = blob_idx * BLOB_SIZE;
            let shard = shards[slot]
                .as_ref()
                .ok_or_else(|| CodingError::Rs("missing data shard after reconstruct".to_string()))?;
            let src = &shard[row_offset..row_offset + BLOB_SIZE];
            mdu[dst..dst + BLOB_SIZE].copy_from_slice(src);
        }
    }

    Ok(mdu)
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
            0usize, 1, 30, 31, 32, 100, 126_975, // just before blob boundary (4096*31)
            126_976, // exactly one blob payload
            126_977, 253_952, // two blob payloads
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

    #[test]
    fn reconstruct_mdu_from_missing_shards() {
        let mut mdu = vec![0u8; MDU_SIZE];
        for (i, byte) in mdu.iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }

        let rows = BLOBS_PER_MDU / DATA_SHARDS_NUM;
        let shards_total = DATA_SHARDS_NUM + PARITY_SHARDS_NUM;
        let mut shards_raw: Vec<Vec<u8>> = vec![vec![0u8; rows * BLOB_SIZE]; shards_total];
        let r = ReedSolomon::new(DATA_SHARDS_NUM, PARITY_SHARDS_NUM).unwrap();
        for row_idx in 0..rows {
            let mut row_shards: Vec<Vec<u8>> = Vec::with_capacity(shards_total);
            for s in 0..DATA_SHARDS_NUM {
                let blob_idx = row_idx * DATA_SHARDS_NUM + s;
                let start = blob_idx * BLOB_SIZE;
                let end = start + BLOB_SIZE;
                row_shards.push(mdu[start..end].to_vec());
            }
            for _ in 0..PARITY_SHARDS_NUM {
                row_shards.push(vec![0u8; BLOB_SIZE]);
            }
            r.encode(&mut row_shards).unwrap();
            for slot in 0..shards_total {
                let dest_start = row_idx * BLOB_SIZE;
                let dest_end = dest_start + BLOB_SIZE;
                shards_raw[slot][dest_start..dest_end].copy_from_slice(&row_shards[slot]);
            }
        }

        let mut shards: Vec<Option<Vec<u8>>> = shards_raw.into_iter().map(Some).collect();

        shards[1] = None; // drop one data shard
        shards[10] = None; // drop a parity shard

        let reconstructed = reconstruct_mdu_from_shards(&mut shards, DATA_SHARDS_NUM, PARITY_SHARDS_NUM).unwrap();
        assert_eq!(reconstructed, mdu);
    }

    #[test]
    fn reconstruct_mdu_rejects_invalid_params() {
        let mut shards = vec![None; 10];
        let err = reconstruct_mdu_from_shards(&mut shards, 7, 3).unwrap_err();
        match err {
            CodingError::InvalidRsParams => {}
            _ => panic!("expected InvalidRsParams, got {err:?}"),
        }
    }
}
