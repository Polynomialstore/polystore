use crate::builder::Mdu0Builder;
use crate::coding::{
    expand_mdu, expand_mdu_encoded, expand_mdu_encoded_flat_uncommitted,
    expand_payload_flat_profiled, expand_payload_flat_uncommitted,
};
use crate::kzg::KzgContext;
use crate::kzg::{
    set_pippenger_window_override, set_wasm_msm_basis_mode, BLOBS_PER_MDU, BLOB_SIZE,
};
use crate::layout::{FileRecordV1, FileTableHeaderV3};
use js_sys::{BigInt, Date, JsString, Uint8Array};
use sha2::Digest;
use wasm_bindgen::prelude::*;

fn compute_mdu_root_from_witness_flat_bytes(
    ctx: &KzgContext,
    witness_flat: &[u8],
) -> Result<[u8; 32], JsValue> {
    if witness_flat.len() % 48 != 0 {
        return Err(JsValue::from_str("Witness length must be multiple of 48"));
    }
    let count = witness_flat.len() / 48;
    let mut commitments = Vec::with_capacity(count);
    for chunk in witness_flat.chunks_exact(48) {
        let mut c = [0u8; 48];
        c.copy_from_slice(chunk);
        commitments.push(c);
    }

    ctx.create_mdu_merkle_root(&commitments)
        .map_err(|e| JsValue::from_str(&format!("Merkle root failed: {:?}", e)))
}

fn now_ms() -> f64 {
    Date::now()
}

#[wasm_bindgen]
pub struct PolyStoreWasm {
    kzg_ctx: KzgContext,
}

#[wasm_bindgen]
impl PolyStoreWasm {
    pub fn checked_retrieval_v3_range(
        file_start: BigInt,
        file_length: BigInt,
        range_start: BigInt,
        range_length: BigInt,
        user_mdus: BigInt,
    ) -> Result<Uint8Array, JsValue> {
        let range = crate::retrieval_v3::checked_range(
            checked_metadata_u64(file_start)?,
            checked_metadata_u64(file_length)?,
            checked_metadata_u64(range_start)?,
            checked_metadata_u64(range_length)?,
            checked_metadata_u64(user_mdus)?,
        )
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let mut out = Vec::with_capacity(24);
        out.extend(range.first.to_be_bytes());
        out.extend(range.last.to_be_bytes());
        out.extend(range.population.to_be_bytes());
        Ok(Uint8Array::from(out.as_slice()))
    }

    pub fn retrieval_v3_plan(
        first: BigInt,
        last: BigInt,
        population: BigInt,
        providers_flat: &[u8],
    ) -> Result<Uint8Array, JsValue> {
        if providers_flat.len() != 8 * 20 {
            return Err(JsValue::from_str(
                "v3 plan requires eight 20-byte providers",
            ));
        }
        let providers = std::array::from_fn(|i| {
            let mut provider = [0u8; 20];
            provider.copy_from_slice(&providers_flat[i * 20..(i + 1) * 20]);
            provider
        });
        let plan = crate::retrieval_v3::Plan::build(
            crate::retrieval_v3::Range {
                first: checked_metadata_u64(first)?,
                last: checked_metadata_u64(last)?,
                population: checked_metadata_u64(population)?,
            },
            providers,
        )
        .and_then(|plan| plan.bytes())
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Uint8Array::from(plan.as_slice()))
    }

    pub fn retrieval_v3_session_id(
        chain: JsString,
        owner: &[u8],
        deal: BigInt,
        generation: BigInt,
        record: f64,
        range_start: BigInt,
        range_length: BigInt,
        plan_hash: &[u8],
        nonce: BigInt,
    ) -> Result<Uint8Array, JsValue> {
        let owner: [u8; 20] = owner
            .try_into()
            .map_err(|_| JsValue::from_str("v3 owner must be 20 bytes"))?;
        let plan_hash: [u8; 32] = plan_hash
            .try_into()
            .map_err(|_| JsValue::from_str("v3 plan hash must be 32 bytes"))?;
        let id = crate::retrieval_v3::session_id(
            &checked_metadata_text(chain, 50, "v3 chain ID")?,
            &owner,
            checked_metadata_u64(deal)?,
            checked_metadata_u64(generation)?,
            checked_metadata_number(record, u32::MAX as usize)? as u32,
            checked_metadata_u64(range_start)?,
            checked_metadata_u64(range_length)?,
            &plan_hash,
            checked_metadata_u64(nonce)?,
        )
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Uint8Array::from(id.as_slice()))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn retrieval_v3_obligation_ack_hash(
        chain: JsString,
        session: &[u8],
        context: &[u8],
        plan: &[u8],
        slot: f64,
        assigned: &[u8],
        payee: &[u8],
        blob_count: BigInt,
        billed_encoded_bytes: BigInt,
        integrity: &[u8],
    ) -> Result<Uint8Array, JsValue> {
        let session: [u8; 32] = session
            .try_into()
            .map_err(|_| JsValue::from_str("v3 session ID must be 32 bytes"))?;
        let context: [u8; 32] = context
            .try_into()
            .map_err(|_| JsValue::from_str("v3 context hash must be 32 bytes"))?;
        let plan: [u8; 32] = plan
            .try_into()
            .map_err(|_| JsValue::from_str("v3 plan hash must be 32 bytes"))?;
        let assigned: [u8; 20] = assigned
            .try_into()
            .map_err(|_| JsValue::from_str("v3 assigned provider must be 20 bytes"))?;
        let payee: [u8; 20] = payee
            .try_into()
            .map_err(|_| JsValue::from_str("v3 payee must be 20 bytes"))?;
        let integrity: [u8; 32] = integrity
            .try_into()
            .map_err(|_| JsValue::from_str("v3 integrity root must be 32 bytes"))?;
        let obligation = crate::retrieval_v3::Obligation {
            slot: checked_metadata_number(slot, 7)? as u32,
            assigned,
            payee,
            blob_count: checked_metadata_u64(blob_count)?,
        };
        let bytes = crate::retrieval_v3::obligation_ack(
            &checked_metadata_text(chain, 50, "v3 chain ID")?,
            &session,
            &context,
            &plan,
            &obligation,
            checked_metadata_u64(billed_encoded_bytes)?,
            &integrity,
        )
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Uint8Array::from(sha2::Sha256::digest(bytes).as_slice()))
    }

    pub fn retrieval_v3_context_hash(bytes: &[u8]) -> Result<Uint8Array, JsValue> {
        let context = crate::retrieval_v3::Context::parse(bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Uint8Array::from(context.hash().as_slice()))
    }

    pub fn retrieval_v3_seed(bytes: &[u8], anchor: &[u8]) -> Result<Uint8Array, JsValue> {
        let context = crate::retrieval_v3::Context::parse(bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let anchor: [u8; 32] = anchor
            .try_into()
            .map_err(|_| JsValue::from_str("v3 anchor must be 32 bytes"))?;
        Ok(Uint8Array::from(context.seed(&anchor).as_slice()))
    }

    pub fn derive_retrieval_v3_challenges(
        bytes: &[u8],
        seed: &[u8],
    ) -> Result<Uint8Array, JsValue> {
        let context = crate::retrieval_v3::Context::parse(bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let seed: [u8; 32] = seed
            .try_into()
            .map_err(|_| JsValue::from_str("v3 seed must be 32 bytes"))?;
        let flat = context
            .challenges_flat(&seed)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Uint8Array::from(flat.as_slice()))
    }

    pub fn verify_fat_v3_header(
        &self,
        bytes: &[u8],
        expected_integrity_root: &[u8],
        expected_leaf_count: BigInt,
    ) -> Result<u32, JsValue> {
        let root: [u8; 32] = expected_integrity_root
            .try_into()
            .map_err(|_| JsValue::from_str("v3 integrity root must be 32 bytes"))?;
        let header = FileTableHeaderV3::from_bytes(bytes).map_err(|e| JsValue::from_str(&e))?;
        if header.integrity_root != root
            || header.integrity_leaf_count != checked_metadata_u64(expected_leaf_count)?
        {
            return Err(JsValue::from_str(
                "FAT v3 header does not match frozen authority",
            ));
        }
        Ok(header.record_count)
    }

    pub fn verify_integrity_v3_blob(
        &self,
        mdu_index: BigInt,
        leaf_index: f64,
        position: BigInt,
        leaf_count: BigInt,
        blob: &[u8],
        path_flat: &[u8],
        expected_root: &[u8],
    ) -> Result<bool, JsValue> {
        let leaf_index = checked_metadata_number(leaf_index, 95)? as u32;
        let expected: [u8; 32] = expected_root
            .try_into()
            .map_err(|_| JsValue::from_str("v3 integrity root must be 32 bytes"))?;
        if path_flat.len() > 23 * 32 || path_flat.len() % 32 != 0 {
            return Err(JsValue::from_str("invalid v3 integrity path"));
        }
        let siblings = path_flat
            .chunks_exact(32)
            .map(|value| value.try_into().unwrap())
            .collect::<Vec<[u8; 32]>>();
        let value = crate::integrity_v3::leaf(checked_metadata_u64(mdu_index)?, leaf_index, blob)
            .map_err(|e| JsValue::from_str(&e))?;
        Ok(crate::integrity_v3::verify_path(
            value,
            checked_metadata_u64(position)?,
            checked_metadata_u64(leaf_count)?,
            &siblings,
            expected,
        ))
    }

    pub fn verify_polyfs_session_batch(&self, input: &[u8]) -> Result<bool, JsValue> {
        self.kzg_ctx
            .verify_polyfs_session_batch(input)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn challenge_context_hash(bytes: &[u8]) -> Result<Uint8Array, JsValue> {
        let c = crate::retrieval_challenge::Context::parse(bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Uint8Array::from(c.hash().as_slice()))
    }

    pub fn derive_challenges(bytes: &[u8], seed: &[u8]) -> Result<Uint8Array, JsValue> {
        let c = crate::retrieval_challenge::Context::parse(bytes)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let seed = seed
            .try_into()
            .map_err(|_| JsValue::from_str("Seed must be 32 bytes"))?;
        let flat = c
            .challenges_flat(seed)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Uint8Array::from(flat.as_slice()))
    }

    pub fn validate_trusted_setup(bytes: &[u8]) -> Result<(), JsValue> {
        crate::kzg::validate_trusted_setup(bytes).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn commit_received_blob(&self, blob: &[u8]) -> Result<Uint8Array, JsValue> {
        let commitment = self
            .kzg_ctx
            .commit_received_blob(blob)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Uint8Array::from(commitment.as_slice()))
    }

    pub fn validate_packed_payload(encoded: &[u8], raw_len: f64) -> Result<(), JsValue> {
        // wasm-bindgen's integer argument coercion would wrap/truncate JS numbers.
        if !raw_len.is_finite()
            || raw_len < 0.0
            || raw_len.fract() != 0.0
            || raw_len > crate::coding::MDU_PAYLOAD_BYTES as f64
        {
            return Err(JsValue::from_str(
                "Raw length must be a bounded nonnegative integer",
            ));
        }
        crate::coding::validate_packed_payload(encoded, raw_len as usize)
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Recover only the 8MiB data MDU from exactly K authenticated shards.
    /// Authentication belongs to the caller. Exact-K admission caps supplied
    /// bytes at 8MiB, missing data at another 8MiB and the Rust output at 8MiB;
    /// absent parity remains absent even for K=1/M=255.
    pub fn reconstruct_mdu_from_shards(
        input: js_sys::Array,
        k: f64,
        m: f64,
    ) -> Result<Uint8Array, JsValue> {
        if !k.is_finite()
            || !m.is_finite()
            || k.fract() != 0.0
            || m.fract() != 0.0
            || k < 1.0
            || k > 64.0
            || m < 1.0
            || m > 255.0
        {
            return Err(JsValue::from_str("Invalid reconstruction geometry"));
        }
        let k = k as usize;
        let m = m as usize;
        if !js_sys::Array::is_array(input.as_ref())
            || BLOBS_PER_MDU % k != 0
            || k + m > 256
            || input.length() as usize != k + m
        {
            return Err(JsValue::from_str("Invalid reconstruction shape"));
        }
        let shard_len = BLOBS_PER_MDU / k * BLOB_SIZE;
        let mut present = 0usize;
        // Retain handles and validate the entire bounded input before copying
        // any shard bytes into owned Rust buffers.
        let mut handles = Vec::with_capacity(k + m);
        for value in input.iter() {
            if value.is_null() {
                handles.push(None);
            } else {
                let bytes = value
                    .dyn_into::<Uint8Array>()
                    .map_err(|_| JsValue::from_str("Shard must be Uint8Array or null"))?;
                if bytes.length() as usize != shard_len {
                    return Err(JsValue::from_str("Invalid reconstruction shard length"));
                }
                present += 1;
                handles.push(Some(bytes));
            }
        }
        if present != k {
            return Err(JsValue::from_str(
                "Exactly K authenticated shards are required",
            ));
        }
        let mut shards: Vec<Option<Vec<u8>>> = handles
            .iter()
            .map(|value| value.as_ref().map(Uint8Array::to_vec))
            .collect();
        let bytes = crate::coding::reconstruct_mdu_from_shards(&mut shards, k, m)
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        Ok(Uint8Array::from(bytes.as_slice()))
    }

    #[wasm_bindgen(constructor)]
    pub fn new(trusted_setup_bytes: &[u8]) -> Result<PolyStoreWasm, JsValue> {
        console_error_panic_hook::set_once();
        // Use std::io::Cursor to adapt bytes to Read trait
        let cursor = std::io::Cursor::new(trusted_setup_bytes);
        let ctx = KzgContext::load_from_reader(cursor)
            .map_err(|e| JsValue::from_str(&format!("Failed to load setup: {:?}", e)))?;
        Ok(PolyStoreWasm { kzg_ctx: ctx })
    }

    pub fn expand_file(&self, data: &[u8]) -> Result<JsValue, JsValue> {
        let res = expand_mdu(&self.kzg_ctx, data)
            .map_err(|e| JsValue::from_str(&format!("Expansion failed: {:?}", e)))?;

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn expand_mdu_rs(&self, mdu_bytes: &[u8], k: u32, m: u32) -> Result<JsValue, JsValue> {
        let res = expand_mdu_encoded(&self.kzg_ctx, mdu_bytes, k as usize, m as usize)
            .map_err(|e| JsValue::from_str(&format!("Expansion failed: {:?}", e)))?;

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn expand_payload_rs_flat(
        &self,
        payload_bytes: &[u8],
        k: u32,
        m: u32,
    ) -> Result<JsValue, JsValue> {
        let data_shards = k as usize;
        let parity_shards = m as usize;
        if data_shards == 0 || parity_shards == 0 {
            return Err(JsValue::from_str("RS parameters must be positive"));
        }
        if BLOBS_PER_MDU % data_shards != 0 {
            return Err(JsValue::from_str("Invalid RS parameters"));
        }

        let rows = BLOBS_PER_MDU / data_shards;
        let shard_count = data_shards + parity_shards;
        let shard_len = rows * BLOB_SIZE;
        let mut witness_flat = vec![0u8; shard_count * rows * 48];
        let mut shards_flat = vec![0u8; shard_count * shard_len];

        let perf = expand_payload_flat_profiled(
            &self.kzg_ctx,
            payload_bytes,
            data_shards,
            parity_shards,
            &mut witness_flat,
            &mut shards_flat,
        )
        .map_err(|e| JsValue::from_str(&format!("Expansion failed: {:?}", e)))?;

        #[derive(serde::Serialize)]
        struct ExpandPayloadFlatPerfResult {
            encode_ms: f64,
            rs_ms: f64,
            commit_decode_ms: f64,
            commit_transform_ms: f64,
            commit_msm_scalar_prep_ms: f64,
            commit_msm_bucket_fill_ms: f64,
            commit_msm_reduce_ms: f64,
            commit_msm_double_ms: f64,
            commit_msm_ms: f64,
            commit_compress_ms: f64,
            commit_ms: f64,
            total_ms: f64,
            rows: usize,
            shards_total: usize,
            shard_len: usize,
        }

        #[derive(serde::Serialize)]
        struct ExpandPayloadFlatResult {
            witness_flat: Vec<u8>,
            shards_flat: Vec<u8>,
            shard_len: usize,
            perf: ExpandPayloadFlatPerfResult,
        }

        let res = ExpandPayloadFlatResult {
            witness_flat,
            shards_flat,
            shard_len,
            perf: ExpandPayloadFlatPerfResult {
                encode_ms: perf.encode_ms,
                rs_ms: perf.rs_ms,
                commit_decode_ms: perf.commit_decode_ms,
                commit_transform_ms: perf.commit_transform_ms,
                commit_msm_scalar_prep_ms: perf.commit_msm_scalar_prep_ms,
                commit_msm_bucket_fill_ms: perf.commit_msm_bucket_fill_ms,
                commit_msm_reduce_ms: perf.commit_msm_reduce_ms,
                commit_msm_double_ms: perf.commit_msm_double_ms,
                commit_msm_ms: perf.commit_msm_ms,
                commit_compress_ms: perf.commit_compress_ms,
                commit_ms: perf.commit_ms,
                total_ms: perf.total_ms,
                rows: perf.rows,
                shards_total: perf.shards_total,
                shard_len: perf.shard_len,
            },
        };

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn expand_mdu_rs_flat_uncommitted(
        &self,
        mdu_bytes: &[u8],
        k: u32,
        m: u32,
    ) -> Result<JsValue, JsValue> {
        let data_shards = k as usize;
        let parity_shards = m as usize;
        if data_shards == 0 || parity_shards == 0 {
            return Err(JsValue::from_str("RS parameters must be positive"));
        }
        if BLOBS_PER_MDU % data_shards != 0 {
            return Err(JsValue::from_str("Invalid RS parameters"));
        }

        let rows = BLOBS_PER_MDU / data_shards;
        let shard_count = data_shards + parity_shards;
        let shard_len = rows * BLOB_SIZE;
        let mut shards_flat = vec![0u8; shard_count * shard_len];

        let perf = expand_mdu_encoded_flat_uncommitted(
            mdu_bytes,
            data_shards,
            parity_shards,
            &mut shards_flat,
        )
        .map_err(|e| JsValue::from_str(&format!("Expansion failed: {:?}", e)))?;

        #[derive(serde::Serialize)]
        struct ExpandRsFlatPerfResult {
            encode_ms: f64,
            rs_ms: f64,
            total_ms: f64,
            rows: usize,
            shards_total: usize,
            shard_len: usize,
        }

        #[derive(serde::Serialize)]
        struct ExpandRsFlatResult {
            shards_flat: Vec<u8>,
            shard_len: usize,
            perf: ExpandRsFlatPerfResult,
        }

        let res = ExpandRsFlatResult {
            shards_flat,
            shard_len,
            perf: ExpandRsFlatPerfResult {
                encode_ms: perf.encode_ms,
                rs_ms: perf.rs_ms,
                total_ms: perf.total_ms,
                rows: perf.rows,
                shards_total: perf.shards_total,
                shard_len: perf.shard_len,
            },
        };

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn expand_payload_rs_flat_uncommitted(
        &self,
        payload_bytes: &[u8],
        k: u32,
        m: u32,
    ) -> Result<JsValue, JsValue> {
        let data_shards = k as usize;
        let parity_shards = m as usize;
        if data_shards == 0 || parity_shards == 0 {
            return Err(JsValue::from_str("RS parameters must be positive"));
        }
        if BLOBS_PER_MDU % data_shards != 0 {
            return Err(JsValue::from_str("Invalid RS parameters"));
        }

        let rows = BLOBS_PER_MDU / data_shards;
        let shard_count = data_shards + parity_shards;
        let shard_len = rows * BLOB_SIZE;
        let mut shards_flat = vec![0u8; shard_count * shard_len];

        let perf = expand_payload_flat_uncommitted(
            payload_bytes,
            data_shards,
            parity_shards,
            &mut shards_flat,
        )
        .map_err(|e| JsValue::from_str(&format!("Expansion failed: {:?}", e)))?;

        #[derive(serde::Serialize)]
        struct ExpandRsFlatPerfResult {
            encode_ms: f64,
            rs_ms: f64,
            total_ms: f64,
            rows: usize,
            shards_total: usize,
            shard_len: usize,
        }

        #[derive(serde::Serialize)]
        struct ExpandRsFlatResult {
            shards_flat: Vec<u8>,
            shard_len: usize,
            perf: ExpandRsFlatPerfResult,
        }

        let res = ExpandRsFlatResult {
            shards_flat,
            shard_len,
            perf: ExpandRsFlatPerfResult {
                encode_ms: perf.encode_ms,
                rs_ms: perf.rs_ms,
                total_ms: perf.total_ms,
                rows: perf.rows,
                shards_total: perf.shards_total,
                shard_len: perf.shard_len,
            },
        };

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn expand_payload_rs_flat_committed_profiled(
        &self,
        payload_bytes: &[u8],
        k: u32,
        m: u32,
    ) -> Result<JsValue, JsValue> {
        let data_shards = k as usize;
        let parity_shards = m as usize;
        if data_shards == 0 || parity_shards == 0 {
            return Err(JsValue::from_str("RS parameters must be positive"));
        }
        if BLOBS_PER_MDU % data_shards != 0 {
            return Err(JsValue::from_str("Invalid RS parameters"));
        }

        let rows = BLOBS_PER_MDU / data_shards;
        let shard_count = data_shards + parity_shards;
        let shard_len = rows * BLOB_SIZE;
        let mut shards_flat = vec![0u8; shard_count * shard_len];

        let expand_perf = expand_payload_flat_uncommitted(
            payload_bytes,
            data_shards,
            parity_shards,
            &mut shards_flat,
        )
        .map_err(|e| JsValue::from_str(&format!("Expansion failed: {:?}", e)))?;

        let (witness_flat, commit_perf) = self
            .kzg_ctx
            .commit_blobs_flat_profiled(&shards_flat)
            .map_err(|e| JsValue::from_str(&format!("Commitment failed: {:?}", e)))?;
        let mdu_root = compute_mdu_root_from_witness_flat_bytes(&self.kzg_ctx, &witness_flat)?;

        #[derive(serde::Serialize)]
        struct ExpandPayloadCommittedPerfResult {
            encode_ms: f64,
            rs_ms: f64,
            commit_decode_ms: f64,
            commit_transform_ms: f64,
            commit_msm_scalar_prep_ms: f64,
            commit_msm_bucket_fill_ms: f64,
            commit_msm_reduce_ms: f64,
            commit_msm_double_ms: f64,
            commit_msm_ms: f64,
            commit_compress_ms: f64,
            commit_ms: f64,
            total_ms: f64,
            rows: usize,
            shards_total: usize,
            shard_len: usize,
        }

        #[derive(serde::Serialize)]
        struct ExpandPayloadCommittedResult {
            witness_flat: Vec<u8>,
            mdu_root: Vec<u8>,
            shards_flat: Vec<u8>,
            shard_len: usize,
            perf: ExpandPayloadCommittedPerfResult,
        }

        let res = ExpandPayloadCommittedResult {
            witness_flat,
            mdu_root: mdu_root.to_vec(),
            shards_flat,
            shard_len,
            perf: ExpandPayloadCommittedPerfResult {
                encode_ms: expand_perf.encode_ms,
                rs_ms: expand_perf.rs_ms,
                commit_decode_ms: commit_perf.decode_ms,
                commit_transform_ms: commit_perf.transform_ms,
                commit_msm_scalar_prep_ms: commit_perf.msm_scalar_prep_ms,
                commit_msm_bucket_fill_ms: commit_perf.msm_bucket_fill_ms,
                commit_msm_reduce_ms: commit_perf.msm_reduce_ms,
                commit_msm_double_ms: commit_perf.msm_double_ms,
                commit_msm_ms: commit_perf.msm_ms,
                commit_compress_ms: commit_perf.compress_ms,
                commit_ms: commit_perf.total_ms,
                total_ms: expand_perf.total_ms + commit_perf.total_ms,
                rows: expand_perf.rows,
                shards_total: expand_perf.shards_total,
                shard_len: expand_perf.shard_len,
            },
        };

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn expand_payload_rs_flat_committed(
        &self,
        payload_bytes: &[u8],
        k: u32,
        m: u32,
    ) -> Result<JsValue, JsValue> {
        let data_shards = k as usize;
        let parity_shards = m as usize;
        if data_shards == 0 || parity_shards == 0 {
            return Err(JsValue::from_str("RS parameters must be positive"));
        }
        if BLOBS_PER_MDU % data_shards != 0 {
            return Err(JsValue::from_str("Invalid RS parameters"));
        }

        let rows = BLOBS_PER_MDU / data_shards;
        let shard_count = data_shards + parity_shards;
        let shard_len = rows * BLOB_SIZE;
        let mut shards_flat = vec![0u8; shard_count * shard_len];

        let expand_perf = expand_payload_flat_uncommitted(
            payload_bytes,
            data_shards,
            parity_shards,
            &mut shards_flat,
        )
        .map_err(|e| JsValue::from_str(&format!("Expansion failed: {:?}", e)))?;

        let commit_start = now_ms();
        let witness_flat = self
            .kzg_ctx
            .commit_blobs_flat(&shards_flat)
            .map_err(|e| JsValue::from_str(&format!("Commitment failed: {:?}", e)))?;
        let commit_ms = now_ms() - commit_start;
        let mdu_root = compute_mdu_root_from_witness_flat_bytes(&self.kzg_ctx, &witness_flat)?;

        #[derive(serde::Serialize)]
        struct ExpandPayloadCommittedPerfResult {
            encode_ms: f64,
            rs_ms: f64,
            commit_ms: f64,
            total_ms: f64,
            rows: usize,
            shards_total: usize,
            shard_len: usize,
        }

        #[derive(serde::Serialize)]
        struct ExpandPayloadCommittedResult {
            witness_flat: Vec<u8>,
            mdu_root: Vec<u8>,
            shards_flat: Vec<u8>,
            shard_len: usize,
            perf: ExpandPayloadCommittedPerfResult,
        }

        let res = ExpandPayloadCommittedResult {
            witness_flat,
            mdu_root: mdu_root.to_vec(),
            shards_flat,
            shard_len,
            perf: ExpandPayloadCommittedPerfResult {
                encode_ms: expand_perf.encode_ms,
                rs_ms: expand_perf.rs_ms,
                commit_ms,
                total_ms: expand_perf.total_ms + commit_ms,
                rows: expand_perf.rows,
                shards_total: expand_perf.shards_total,
                shard_len: expand_perf.shard_len,
            },
        };

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn commit_mdu(&self, mdu_bytes: &[u8]) -> Result<JsValue, JsValue> {
        if mdu_bytes.len() != crate::kzg::MDU_SIZE {
            return Err(JsValue::from_str("MDU bytes must be exactly 8 MiB"));
        }

        let commitments = self
            .kzg_ctx
            .mdu_to_kzg_commitments(mdu_bytes)
            .map_err(|e| JsValue::from_str(&format!("Commitment failed: {:?}", e)))?;

        let root = self
            .kzg_ctx
            .create_mdu_merkle_root(&commitments)
            .map_err(|e| JsValue::from_str(&format!("Merkle root failed: {:?}", e)))?;

        let mut witness_flat = Vec::with_capacity(commitments.len() * 48);
        for c in commitments {
            witness_flat.extend_from_slice(&c);
        }

        #[derive(serde::Serialize)]
        struct CommitResult {
            witness_flat: Vec<u8>,
            mdu_root: Vec<u8>,
        }

        let res = CommitResult {
            witness_flat,
            mdu_root: root.to_vec(),
        };

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn commit_blobs(&self, blobs_flat: &[u8]) -> Result<Uint8Array, JsValue> {
        let flat = self
            .kzg_ctx
            .commit_blobs_flat(blobs_flat)
            .map_err(|e| JsValue::from_str(&format!("Commitment failed: {:?}", e)))?;
        Ok(Uint8Array::from(flat.as_slice()))
    }

    pub fn commit_blobs_profiled(&self, blobs_flat: &[u8]) -> Result<JsValue, JsValue> {
        if blobs_flat.len() % crate::kzg::BLOB_SIZE != 0 {
            return Err(JsValue::from_str(
                "Blobs length must be a multiple of 128 KiB",
            ));
        }

        let count = blobs_flat.len() / crate::kzg::BLOB_SIZE;
        let (flat, perf) = self
            .kzg_ctx
            .commit_blobs_flat_profiled(blobs_flat)
            .map_err(|e| JsValue::from_str(&format!("Commitment failed: {:?}", e)))?;

        #[derive(serde::Serialize)]
        struct CommitBlobsProfiledPerf {
            decode_ms: f64,
            transform_ms: f64,
            msm_scalar_prep_ms: f64,
            msm_bucket_fill_ms: f64,
            msm_reduce_ms: f64,
            msm_double_ms: f64,
            msm_ms: f64,
            compress_ms: f64,
            total_ms: f64,
            blobs: usize,
        }

        #[derive(serde::Serialize)]
        struct CommitBlobsProfiledResult {
            witness_flat: Vec<u8>,
            perf: CommitBlobsProfiledPerf,
        }

        let res = CommitBlobsProfiledResult {
            witness_flat: flat,
            perf: CommitBlobsProfiledPerf {
                decode_ms: perf.decode_ms,
                transform_ms: perf.transform_ms,
                msm_scalar_prep_ms: perf.msm_scalar_prep_ms,
                msm_bucket_fill_ms: perf.msm_bucket_fill_ms,
                msm_reduce_ms: perf.msm_reduce_ms,
                msm_double_ms: perf.msm_double_ms,
                msm_ms: perf.msm_ms,
                compress_ms: perf.compress_ms,
                total_ms: perf.total_ms,
                blobs: count,
            },
        };

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn webgpu_g1_srs_lagrange(&self) -> Result<Uint8Array, JsValue> {
        let bytes = self
            .kzg_ctx
            .webgpu_g1_srs_lagrange_bytes()
            .map_err(|e| JsValue::from_str(&format!("WebGPU SRS export failed: {:?}", e)))?;
        Ok(Uint8Array::from(bytes.as_slice()))
    }

    pub fn webgpu_fold_g1_window_sums(
        &self,
        window_sums: &[u8],
        bucket_width: u32,
    ) -> Result<Uint8Array, JsValue> {
        let commitment = self
            .kzg_ctx
            .webgpu_fold_g1_window_sums(window_sums, bucket_width as usize)
            .map_err(|e| JsValue::from_str(&format!("WebGPU MSM fold failed: {:?}", e)))?;
        Ok(Uint8Array::from(commitment.as_slice()))
    }

    pub fn expand_mdu_rs_flat_committed_profiled(
        &self,
        mdu_bytes: &[u8],
        k: u32,
        m: u32,
    ) -> Result<JsValue, JsValue> {
        let data_shards = k as usize;
        let parity_shards = m as usize;
        if data_shards == 0 || parity_shards == 0 {
            return Err(JsValue::from_str("RS parameters must be positive"));
        }
        if BLOBS_PER_MDU % data_shards != 0 {
            return Err(JsValue::from_str("Invalid RS parameters"));
        }

        let rows = BLOBS_PER_MDU / data_shards;
        let shard_count = data_shards + parity_shards;
        let shard_len = rows * BLOB_SIZE;
        let mut shards_flat = vec![0u8; shard_count * shard_len];

        let expand_perf = expand_mdu_encoded_flat_uncommitted(
            mdu_bytes,
            data_shards,
            parity_shards,
            &mut shards_flat,
        )
        .map_err(|e| JsValue::from_str(&format!("Expansion failed: {:?}", e)))?;

        let (witness_flat, commit_perf) = self
            .kzg_ctx
            .commit_blobs_flat_profiled(&shards_flat)
            .map_err(|e| JsValue::from_str(&format!("Commitment failed: {:?}", e)))?;
        let mdu_root = compute_mdu_root_from_witness_flat_bytes(&self.kzg_ctx, &witness_flat)?;

        #[derive(serde::Serialize)]
        struct ExpandMduCommittedPerfResult {
            encode_ms: f64,
            rs_ms: f64,
            commit_decode_ms: f64,
            commit_transform_ms: f64,
            commit_msm_scalar_prep_ms: f64,
            commit_msm_bucket_fill_ms: f64,
            commit_msm_reduce_ms: f64,
            commit_msm_double_ms: f64,
            commit_msm_ms: f64,
            commit_compress_ms: f64,
            commit_ms: f64,
            total_ms: f64,
            rows: usize,
            shards_total: usize,
            shard_len: usize,
        }

        #[derive(serde::Serialize)]
        struct ExpandMduCommittedResult {
            witness_flat: Vec<u8>,
            mdu_root: Vec<u8>,
            shards_flat: Vec<u8>,
            shard_len: usize,
            perf: ExpandMduCommittedPerfResult,
        }

        let res = ExpandMduCommittedResult {
            witness_flat,
            mdu_root: mdu_root.to_vec(),
            shards_flat,
            shard_len,
            perf: ExpandMduCommittedPerfResult {
                encode_ms: expand_perf.encode_ms,
                rs_ms: expand_perf.rs_ms,
                commit_decode_ms: commit_perf.decode_ms,
                commit_transform_ms: commit_perf.transform_ms,
                commit_msm_scalar_prep_ms: commit_perf.msm_scalar_prep_ms,
                commit_msm_bucket_fill_ms: commit_perf.msm_bucket_fill_ms,
                commit_msm_reduce_ms: commit_perf.msm_reduce_ms,
                commit_msm_double_ms: commit_perf.msm_double_ms,
                commit_msm_ms: commit_perf.msm_ms,
                commit_compress_ms: commit_perf.compress_ms,
                commit_ms: commit_perf.total_ms,
                total_ms: expand_perf.total_ms + commit_perf.total_ms,
                rows: expand_perf.rows,
                shards_total: expand_perf.shards_total,
                shard_len: expand_perf.shard_len,
            },
        };

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn expand_mdu_rs_flat_committed(
        &self,
        mdu_bytes: &[u8],
        k: u32,
        m: u32,
    ) -> Result<JsValue, JsValue> {
        let data_shards = k as usize;
        let parity_shards = m as usize;
        if data_shards == 0 || parity_shards == 0 {
            return Err(JsValue::from_str("RS parameters must be positive"));
        }
        if BLOBS_PER_MDU % data_shards != 0 {
            return Err(JsValue::from_str("Invalid RS parameters"));
        }

        let rows = BLOBS_PER_MDU / data_shards;
        let shard_count = data_shards + parity_shards;
        let shard_len = rows * BLOB_SIZE;
        let mut shards_flat = vec![0u8; shard_count * shard_len];

        let expand_perf = expand_mdu_encoded_flat_uncommitted(
            mdu_bytes,
            data_shards,
            parity_shards,
            &mut shards_flat,
        )
        .map_err(|e| JsValue::from_str(&format!("Expansion failed: {:?}", e)))?;

        let commit_start = now_ms();
        let witness_flat = self
            .kzg_ctx
            .commit_blobs_flat(&shards_flat)
            .map_err(|e| JsValue::from_str(&format!("Commitment failed: {:?}", e)))?;
        let commit_ms = now_ms() - commit_start;
        let mdu_root = compute_mdu_root_from_witness_flat_bytes(&self.kzg_ctx, &witness_flat)?;

        #[derive(serde::Serialize)]
        struct ExpandMduCommittedPerfResult {
            encode_ms: f64,
            rs_ms: f64,
            commit_ms: f64,
            total_ms: f64,
            rows: usize,
            shards_total: usize,
            shard_len: usize,
        }

        #[derive(serde::Serialize)]
        struct ExpandMduCommittedResult {
            witness_flat: Vec<u8>,
            mdu_root: Vec<u8>,
            shards_flat: Vec<u8>,
            shard_len: usize,
            perf: ExpandMduCommittedPerfResult,
        }

        let res = ExpandMduCommittedResult {
            witness_flat,
            mdu_root: mdu_root.to_vec(),
            shards_flat,
            shard_len,
            perf: ExpandMduCommittedPerfResult {
                encode_ms: expand_perf.encode_ms,
                rs_ms: expand_perf.rs_ms,
                commit_ms,
                total_ms: expand_perf.total_ms + commit_ms,
                rows: expand_perf.rows,
                shards_total: expand_perf.shards_total,
                shard_len: expand_perf.shard_len,
            },
        };

        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn compute_manifest(&self, roots_flat: &[u8]) -> Result<JsValue, JsValue> {
        if roots_flat.len() % 32 != 0 {
            return Err(JsValue::from_str("Roots length must be multiple of 32"));
        }
        let count = roots_flat.len() / 32;
        let mut roots = Vec::with_capacity(count);
        for chunk in roots_flat.chunks_exact(32) {
            let mut r = [0u8; 32];
            r.copy_from_slice(chunk);
            roots.push(r);
        }

        let (commitment, blob) = self
            .kzg_ctx
            .compute_manifest_commitment(&roots)
            .map_err(|e| JsValue::from_str(&format!("Compute manifest failed: {:?}", e)))?;

        #[derive(serde::Serialize)]
        struct ManifestResult {
            root: Vec<u8>,
            blob: Vec<u8>,
        }
        let res = ManifestResult {
            root: commitment.to_vec(),
            blob,
        };
        serde_wasm_bindgen::to_value(&res)
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn compute_mdu_root(&self, witness_flat: &[u8]) -> Result<JsValue, JsValue> {
        let root = compute_mdu_root_from_witness_flat_bytes(&self.kzg_ctx, witness_flat)?;

        serde_wasm_bindgen::to_value(&root.to_vec())
            .map_err(|e| JsValue::from_str(&format!("Serialization failed: {:?}", e)))
    }

    pub fn set_pippenger_window_bits(&self, bits: i32) -> Result<(), JsValue> {
        if bits < 0 {
            return Err(JsValue::from_str("window bits must be non-negative"));
        }
        if bits == 0 {
            set_pippenger_window_override(None);
        } else {
            set_pippenger_window_override(Some(bits as usize));
        }
        Ok(())
    }

    pub fn set_wasm_msm_basis_mode(&self, mode: &str) -> Result<(), JsValue> {
        match mode {
            "blst" => {
                set_wasm_msm_basis_mode(0);
                Ok(())
            }
            "projective" => {
                set_wasm_msm_basis_mode(2);
                Ok(())
            }
            "affine" => {
                set_wasm_msm_basis_mode(1);
                Ok(())
            }
            _ => Err(JsValue::from_str(
                "basis mode must be 'blst', 'projective' or 'affine'",
            )),
        }
    }
}

#[wasm_bindgen]
pub struct WasmMdu0Builder {
    inner: Mdu0Builder,
}

#[wasm_bindgen]
impl WasmMdu0Builder {
    #[wasm_bindgen(constructor)]
    pub fn new(max_user_mdus: BigInt) -> Result<WasmMdu0Builder, JsValue> {
        Ok(WasmMdu0Builder {
            inner: Mdu0Builder::new(checked_metadata_u64(max_user_mdus)?),
        })
    }

    #[wasm_bindgen]
    pub fn new_with_commitments(
        max_user_mdus: BigInt,
        commitments_per_mdu: BigInt,
    ) -> Result<WasmMdu0Builder, JsValue> {
        Ok(WasmMdu0Builder {
            inner: Mdu0Builder::new_with_commitments(
                checked_metadata_u64(max_user_mdus)?,
                checked_metadata_u64(commitments_per_mdu)?,
            ),
        })
    }

    #[wasm_bindgen]
    pub fn load(
        data: &[u8],
        max_user_mdus: BigInt,
        commitments_per_mdu: BigInt,
    ) -> Result<WasmMdu0Builder, JsValue> {
        let builder = Mdu0Builder::load_with_commitments(
            data,
            checked_metadata_u64(max_user_mdus)?,
            checked_metadata_u64(commitments_per_mdu)?,
        )
        .map_err(|e| JsValue::from_str(&e))?;
        Ok(WasmMdu0Builder { inner: builder })
    }

    pub fn load_legacy_recovery(
        data: &[u8],
        max_user_mdus: BigInt,
        commitments_per_mdu: BigInt,
    ) -> Result<WasmMdu0Builder, JsValue> {
        let inner = Mdu0Builder::load_legacy_recovery(
            data,
            checked_metadata_u64(max_user_mdus)?,
            checked_metadata_u64(commitments_per_mdu)?,
        )
        .map_err(|e| JsValue::from_str(&e))?;
        Ok(Self { inner })
    }

    pub fn stage_v2_from_trusted_legacy(
        data: &[u8],
        max_user_mdus: BigInt,
        commitments_per_mdu: BigInt,
    ) -> Result<WasmMdu0Builder, JsValue> {
        let inner = Mdu0Builder::stage_v2_from_trusted_legacy(
            data,
            checked_metadata_u64(max_user_mdus)?,
            checked_metadata_u64(commitments_per_mdu)?,
        )
        .map_err(|e| JsValue::from_str(&e))?;
        Ok(Self { inner })
    }

    pub fn append_file(
        &mut self,
        path: JsString,
        size: BigInt,
        start_offset: BigInt,
    ) -> Result<(), JsValue> {
        self.append_file_with_flags(path, size, start_offset, 0.0)
    }

    pub fn append_file_with_flags(
        &mut self,
        path: JsString,
        size: BigInt,
        start_offset: BigInt,
        flags: f64,
    ) -> Result<(), JsValue> {
        let path = checked_metadata_path(path)?;
        let rec = FileRecordV1::from_path(
            &path,
            checked_metadata_u64(size)?,
            checked_metadata_u64(start_offset)?,
            checked_metadata_number(flags, 255)? as u8,
        )
        .map_err(|e| JsValue::from_str(&e))?;
        self.inner
            .append_file_record(rec)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn bytes(&self) -> Vec<u8> {
        self.inner.bytes().to_vec()
    }

    pub fn set_root(&mut self, index: BigInt, root: &[u8]) -> Result<(), JsValue> {
        if root.len() != 32 {
            return Err(JsValue::from_str("root must be 32 bytes"));
        }

        let mut r = [0u8; 32];

        r.copy_from_slice(root);

        self.inner
            .set_root(checked_metadata_u64(index)?, r)
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn get_record_count(&self) -> u32 {
        self.inner.record_count()
    }

    pub fn is_legacy_recovery(&self) -> bool {
        self.inner.is_legacy_recovery()
    }

    pub fn get_record(&self, index: f64) -> Result<Vec<u8>, JsValue> {
        let index = checked_metadata_number(index, self.inner.record_count() as usize)?;
        self.inner
            .get_file_record(index as u32)
            .map(|rec| rec.to_bytes().to_vec())
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn read_fat_range(&self, offset: f64, len: f64) -> Result<Vec<u8>, JsValue> {
        let capacity = self.inner.fat_logical_capacity();
        let offset = checked_metadata_number(offset, capacity)?;
        let len = checked_metadata_number(len, capacity - offset)?;
        let mut out = vec![0; len];
        self.inner
            .read_fat_range(offset, &mut out)
            .map_err(|e| JsValue::from_str(&e))?;
        Ok(out)
    }

    /// Returns the stored cell, not the original digest supplied to set_root.
    pub fn get_root(&self, index: BigInt) -> Result<Vec<u8>, JsValue> {
        self.inner
            .get_root(checked_metadata_u64(index)?)
            .map(|root| root.to_vec())
            .map_err(|e| JsValue::from_str(&e))
    }

    pub fn get_witness_count(&self) -> u64 {
        self.inner.witness_mdu_count
    }
}

// Validate JavaScript numbers before conversion; wasm-bindgen integer arguments wrap.
fn checked_metadata_number(value: f64, max: usize) -> Result<usize, JsValue> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > max as f64 {
        return Err(JsValue::from_str("metadata index or range out of bounds"));
    }
    Ok(value as usize)
}

// Unlike wasm-bindgen's u64 argument ABI, its checked conversion compares the
// original BigInt with the converted value and rejects negative/overflow values.
// It performs no decimal conversion or input-dependent allocation.
fn checked_metadata_u64(value: BigInt) -> Result<u64, JsValue> {
    let raw: &JsValue = value.as_ref();
    if !raw.is_bigint() {
        return Err(JsValue::from_str("metadata u64 input must be a BigInt"));
    }
    u64::try_from(value).map_err(|_| JsValue::from_str("metadata BigInt exceeds u64 range"))
}

fn checked_metadata_text(value: JsString, max_bytes: usize, name: &str) -> Result<String, JsValue> {
    let raw: &JsValue = value.as_ref();
    if !raw.is_string()
        || value.length() == 0
        || value.length() as usize > max_bytes
        || !value.is_valid_utf16()
    {
        return Err(JsValue::from_str(&format!("invalid {name}")));
    }
    let value = String::from(value);
    if value.len() > max_bytes {
        return Err(JsValue::from_str(&format!("invalid {name}")));
    }
    Ok(value)
}

// Receive the original JavaScript code units rather than wasm-bindgen's lossy
// &str conversion. A valid U+FFFD remains allowed; an unpaired surrogate does not.
fn checked_metadata_path(value: JsString) -> Result<String, JsValue> {
    let raw: &JsValue = value.as_ref();
    if !raw.is_string() {
        return Err(JsValue::from_str("metadata path must be a string"));
    }
    // UTF-8 bytes are never fewer than UTF-16 code units, so this bounds the
    // installed validity check and conversion before allocation.
    if value.length() == 0 || value.length() > crate::layout::FILE_RECORD_PATH_BYTES as u32 {
        return Err(JsValue::from_str("metadata path exceeds byte capacity"));
    }
    if !value.is_valid_utf16() {
        return Err(JsValue::from_str("metadata path contains invalid UTF-16"));
    }
    Ok(String::from(value))
}
