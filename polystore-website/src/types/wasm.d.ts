declare module '/wasm/polystore_core.js' {
  const init: (
    input?:
      | RequestInfo
      | URL
      | Response
      | BufferSource
      | WebAssembly.Module
      | Promise<Response>
      | Promise<WebAssembly.Module>,
  ) => Promise<unknown>
  export default init

  export class PolyStoreWasm {
    constructor(trusted_setup_bytes: Uint8Array)
    static checked_retrieval_v3_range(file_start: bigint, file_length: bigint, range_start: bigint, range_length: bigint, user_mdus: bigint): Uint8Array
    static retrieval_v3_plan(first: bigint, last: bigint, population: bigint, providers_flat: Uint8Array): Uint8Array
    static retrieval_v3_session_id(chain: string, owner: Uint8Array, deal: bigint, generation: bigint, record: number, range_start: bigint, range_length: bigint, plan_hash: Uint8Array, nonce: bigint): Uint8Array
    static retrieval_v3_obligation_ack_hash(chain: string, session: Uint8Array, context: Uint8Array, plan: Uint8Array, slot: number, assigned: Uint8Array, payee: Uint8Array, blob_count: bigint, billed_encoded_bytes: bigint, integrity: Uint8Array): Uint8Array
    static retrieval_v3_context_hash(bytes: Uint8Array): Uint8Array
    static retrieval_v3_seed(bytes: Uint8Array, anchor: Uint8Array): Uint8Array
    static derive_retrieval_v3_challenges(bytes: Uint8Array, seed: Uint8Array): Uint8Array
    verify_fat_v3_header(bytes: Uint8Array, integrity_root: Uint8Array, integrity_leaf_count: bigint): number
    verify_integrity_v3_blob(mdu_index: bigint, leaf_index: number, position: bigint, leaf_count: bigint, blob: Uint8Array, path_flat: Uint8Array, expected_root: Uint8Array): boolean
    expand_file(data: Uint8Array): unknown
    expand_mdu_rs(data: Uint8Array, k: number, m: number): unknown
    expand_payload_rs_flat(data: Uint8Array, k: number, m: number): unknown
    expand_mdu_rs_flat_uncommitted(data: Uint8Array, k: number, m: number): unknown
    expand_payload_rs_flat_uncommitted(data: Uint8Array, k: number, m: number): unknown
    expand_mdu_rs_flat_committed_profiled(data: Uint8Array, k: number, m: number): unknown
    expand_payload_rs_flat_committed_profiled(data: Uint8Array, k: number, m: number): unknown
    commit_mdu(mdu_bytes: Uint8Array): unknown
    commit_blobs(blob_bytes: Uint8Array): Uint8Array
    commit_blobs_profiled(blob_bytes: Uint8Array): unknown
    webgpu_g1_srs_lagrange(): Uint8Array
    webgpu_fold_g1_window_sums(window_sums: Uint8Array, bucket_width: number): Uint8Array
    compute_mdu_root(witness_bytes: Uint8Array): unknown
    compute_manifest(roots: Uint8Array): unknown
    set_pippenger_window_bits(bits: number): void
    set_wasm_msm_basis_mode(mode: 'blst' | 'projective' | 'affine'): void
  }

  export class WasmMdu0Builder {
    constructor(max_user_mdus: bigint)
    static new_with_commitments(max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder
    static load(data: Uint8Array, max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder
    append_file(path: string, size: bigint, start_offset: bigint): void
    append_file_with_flags(path: string, size: bigint, start_offset: bigint, flags: number): void
    bytes(): Uint8Array
    set_root(index: bigint, root: Uint8Array): void
    get_record_count(): number
    get_record(index: number): Uint8Array
    read_fat_range(offset: number, length: number): Uint8Array
    get_root(index: bigint): Uint8Array
    is_legacy_recovery(): boolean
    static load_legacy_recovery(data: Uint8Array, max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder
    static stage_v2_from_trusted_legacy(data: Uint8Array, max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder
    get_witness_count(): bigint
    free(): void
  }
}

declare module '../../public/wasm/polystore_core.js' {
  const init: (
    input?:
      | RequestInfo
      | URL
      | Response
      | BufferSource
      | WebAssembly.Module
      | Promise<Response>
      | Promise<WebAssembly.Module>,
  ) => Promise<unknown>
  export default init

  export class PolyStoreWasm {
    constructor(trusted_setup_bytes: Uint8Array)
    static checked_retrieval_v3_range(file_start: bigint, file_length: bigint, range_start: bigint, range_length: bigint, user_mdus: bigint): Uint8Array
    static retrieval_v3_plan(first: bigint, last: bigint, population: bigint, providers_flat: Uint8Array): Uint8Array
    static retrieval_v3_session_id(chain: string, owner: Uint8Array, deal: bigint, generation: bigint, record: number, range_start: bigint, range_length: bigint, plan_hash: Uint8Array, nonce: bigint): Uint8Array
    static retrieval_v3_obligation_ack_hash(chain: string, session: Uint8Array, context: Uint8Array, plan: Uint8Array, slot: number, assigned: Uint8Array, payee: Uint8Array, blob_count: bigint, billed_encoded_bytes: bigint, integrity: Uint8Array): Uint8Array
    static retrieval_v3_context_hash(bytes: Uint8Array): Uint8Array
    static retrieval_v3_seed(bytes: Uint8Array, anchor: Uint8Array): Uint8Array
    static derive_retrieval_v3_challenges(bytes: Uint8Array, seed: Uint8Array): Uint8Array
    verify_fat_v3_header(bytes: Uint8Array, integrity_root: Uint8Array, integrity_leaf_count: bigint): number
    verify_integrity_v3_blob(mdu_index: bigint, leaf_index: number, position: bigint, leaf_count: bigint, blob: Uint8Array, path_flat: Uint8Array, expected_root: Uint8Array): boolean
    expand_file(data: Uint8Array): unknown
    expand_mdu_rs(data: Uint8Array, k: number, m: number): unknown
    expand_payload_rs_flat(data: Uint8Array, k: number, m: number): unknown
    expand_mdu_rs_flat_uncommitted(data: Uint8Array, k: number, m: number): unknown
    expand_payload_rs_flat_uncommitted(data: Uint8Array, k: number, m: number): unknown
    expand_mdu_rs_flat_committed(data: Uint8Array, k: number, m: number): unknown
    expand_payload_rs_flat_committed(data: Uint8Array, k: number, m: number): unknown
    expand_mdu_rs_flat_committed_profiled(data: Uint8Array, k: number, m: number): unknown
    expand_payload_rs_flat_committed_profiled(data: Uint8Array, k: number, m: number): unknown
    commit_mdu(mdu_bytes: Uint8Array): unknown
    commit_blobs(blob_bytes: Uint8Array): Uint8Array
    commit_blobs_profiled(blob_bytes: Uint8Array): unknown
    webgpu_g1_srs_lagrange(): Uint8Array
    webgpu_fold_g1_window_sums(window_sums: Uint8Array, bucket_width: number): Uint8Array
    compute_mdu_root(witness_bytes: Uint8Array): unknown
    compute_manifest(roots: Uint8Array): unknown
    set_pippenger_window_bits(bits: number): void
    set_wasm_msm_basis_mode(mode: 'blst' | 'projective' | 'affine'): void
  }

  export class WasmMdu0Builder {
    constructor(max_user_mdus: bigint)
    static new_with_commitments(max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder
    static load(data: Uint8Array, max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder
    append_file(path: string, size: bigint, start_offset: bigint): void
    append_file_with_flags(path: string, size: bigint, start_offset: bigint, flags: number): void
    bytes(): Uint8Array
    set_root(index: bigint, root: Uint8Array): void
    get_record_count(): number
    get_record(index: number): Uint8Array
    read_fat_range(offset: number, length: number): Uint8Array
    get_root(index: bigint): Uint8Array
    is_legacy_recovery(): boolean
    static load_legacy_recovery(data: Uint8Array, max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder
    static stage_v2_from_trusted_legacy(data: Uint8Array, max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder
    get_witness_count(): bigint
    free(): void
  }
}
