/* tslint:disable */
/* eslint-disable */

export class PolyStoreWasm {
  free(): void;
  [Symbol.dispose](): void;
  static checked_retrieval_v3_range(file_start: bigint, file_length: bigint, range_start: bigint, range_length: bigint, user_mdus: bigint): Uint8Array;
  static retrieval_v3_plan(first: bigint, last: bigint, population: bigint, providers_flat: Uint8Array): Uint8Array;
  static retrieval_v3_session_id(chain: string, owner: Uint8Array, deal: bigint, generation: bigint, record: number, range_start: bigint, range_length: bigint, plan_hash: Uint8Array, nonce: bigint): Uint8Array;
  static retrieval_v3_obligation_ack_hash(chain: string, session: Uint8Array, context: Uint8Array, plan: Uint8Array, slot: number, assigned: Uint8Array, payee: Uint8Array, blob_count: bigint, billed_encoded_bytes: bigint, integrity: Uint8Array): Uint8Array;
  static retrieval_v3_context_hash(bytes: Uint8Array): Uint8Array;
  static retrieval_v3_seed(bytes: Uint8Array, anchor: Uint8Array): Uint8Array;
  static derive_retrieval_v3_challenges(bytes: Uint8Array, seed: Uint8Array): Uint8Array;
  verify_fat_v3_header(bytes: Uint8Array, expected_integrity_root: Uint8Array, expected_leaf_count: bigint): number;
  verify_integrity_v3_blob(mdu_index: bigint, leaf_index: number, position: bigint, leaf_count: bigint, blob: Uint8Array, path_flat: Uint8Array, expected_root: Uint8Array): boolean;
  verify_polyfs_session_batch(input: Uint8Array): boolean;
  static challenge_context_hash(bytes: Uint8Array): Uint8Array;
  static derive_challenges(bytes: Uint8Array, seed: Uint8Array): Uint8Array;
  static validate_trusted_setup(bytes: Uint8Array): void;
  commit_received_blob(blob: Uint8Array): Uint8Array;
  static validate_packed_payload(encoded: Uint8Array, raw_len: number): void;
  /**
   * Recover only the 8MiB data MDU from exactly K authenticated shards.
   * Authentication belongs to the caller. Exact-K admission caps supplied
   * bytes at 8MiB, missing data at another 8MiB and the Rust output at 8MiB;
   * absent parity remains absent even for K=1/M=255.
   */
  static reconstruct_mdu_from_shards(input: Array<any>, k: number, m: number): Uint8Array;
  constructor(trusted_setup_bytes: Uint8Array);
  expand_file(data: Uint8Array): any;
  expand_mdu_rs(mdu_bytes: Uint8Array, k: number, m: number): any;
  expand_payload_rs_flat(payload_bytes: Uint8Array, k: number, m: number): any;
  expand_mdu_rs_flat_uncommitted(mdu_bytes: Uint8Array, k: number, m: number): any;
  expand_payload_rs_flat_uncommitted(payload_bytes: Uint8Array, k: number, m: number): any;
  expand_payload_rs_flat_committed_profiled(payload_bytes: Uint8Array, k: number, m: number): any;
  expand_payload_rs_flat_committed(payload_bytes: Uint8Array, k: number, m: number): any;
  commit_mdu(mdu_bytes: Uint8Array): any;
  commit_blobs(blobs_flat: Uint8Array): Uint8Array;
  commit_blobs_profiled(blobs_flat: Uint8Array): any;
  webgpu_g1_srs_lagrange(): Uint8Array;
  webgpu_fold_g1_window_sums(window_sums: Uint8Array, bucket_width: number): Uint8Array;
  expand_mdu_rs_flat_committed_profiled(mdu_bytes: Uint8Array, k: number, m: number): any;
  expand_mdu_rs_flat_committed(mdu_bytes: Uint8Array, k: number, m: number): any;
  compute_manifest(roots_flat: Uint8Array): any;
  compute_mdu_root(witness_flat: Uint8Array): any;
  set_pippenger_window_bits(bits: number): void;
  set_wasm_msm_basis_mode(mode: string): void;
}

export class WasmMdu0Builder {
  free(): void;
  [Symbol.dispose](): void;
  constructor(max_user_mdus: bigint);
  static new_with_commitments(max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder;
  static load(data: Uint8Array, max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder;
  static load_legacy_recovery(data: Uint8Array, max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder;
  static stage_v2_from_trusted_legacy(data: Uint8Array, max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder;
  append_file(path: string, size: bigint, start_offset: bigint): void;
  append_file_with_flags(path: string, size: bigint, start_offset: bigint, flags: number): void;
  bytes(): Uint8Array;
  set_root(index: bigint, root: Uint8Array): void;
  get_record_count(): number;
  is_legacy_recovery(): boolean;
  get_record(index: number): Uint8Array;
  read_fat_range(offset: number, len: number): Uint8Array;
  /**
   * Returns the stored cell, not the original digest supplied to set_root.
   */
  get_root(index: bigint): Uint8Array;
  get_witness_count(): bigint;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_polystorewasm_free: (a: number, b: number) => void;
  readonly polystorewasm_checked_retrieval_v3_range: (a: any, b: any, c: any, d: any, e: any) => [number, number, number];
  readonly polystorewasm_retrieval_v3_plan: (a: any, b: any, c: any, d: number, e: number) => [number, number, number];
  readonly polystorewasm_retrieval_v3_session_id: (a: any, b: number, c: number, d: any, e: any, f: number, g: any, h: any, i: number, j: number, k: any) => [number, number, number];
  readonly polystorewasm_retrieval_v3_obligation_ack_hash: (a: any, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: any, n: any, o: number, p: number) => [number, number, number];
  readonly polystorewasm_retrieval_v3_context_hash: (a: number, b: number) => [number, number, number];
  readonly polystorewasm_retrieval_v3_seed: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly polystorewasm_derive_retrieval_v3_challenges: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly polystorewasm_verify_fat_v3_header: (a: number, b: number, c: number, d: number, e: number, f: any) => [number, number, number];
  readonly polystorewasm_verify_integrity_v3_blob: (a: number, b: any, c: number, d: any, e: any, f: number, g: number, h: number, i: number, j: number, k: number) => [number, number, number];
  readonly polystorewasm_verify_polyfs_session_batch: (a: number, b: number, c: number) => [number, number, number];
  readonly polystorewasm_challenge_context_hash: (a: number, b: number) => [number, number, number];
  readonly polystorewasm_derive_challenges: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly polystorewasm_validate_trusted_setup: (a: number, b: number) => [number, number];
  readonly polystorewasm_commit_received_blob: (a: number, b: number, c: number) => [number, number, number];
  readonly polystorewasm_validate_packed_payload: (a: number, b: number, c: number) => [number, number];
  readonly polystorewasm_reconstruct_mdu_from_shards: (a: any, b: number, c: number) => [number, number, number];
  readonly polystorewasm_new: (a: number, b: number) => [number, number, number];
  readonly polystorewasm_expand_file: (a: number, b: number, c: number) => [number, number, number];
  readonly polystorewasm_expand_mdu_rs: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly polystorewasm_expand_payload_rs_flat: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly polystorewasm_expand_mdu_rs_flat_uncommitted: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly polystorewasm_expand_payload_rs_flat_uncommitted: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly polystorewasm_expand_payload_rs_flat_committed_profiled: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly polystorewasm_expand_payload_rs_flat_committed: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly polystorewasm_commit_mdu: (a: number, b: number, c: number) => [number, number, number];
  readonly polystorewasm_commit_blobs: (a: number, b: number, c: number) => [number, number, number];
  readonly polystorewasm_commit_blobs_profiled: (a: number, b: number, c: number) => [number, number, number];
  readonly polystorewasm_webgpu_g1_srs_lagrange: (a: number) => [number, number, number];
  readonly polystorewasm_webgpu_fold_g1_window_sums: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly polystorewasm_expand_mdu_rs_flat_committed_profiled: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly polystorewasm_expand_mdu_rs_flat_committed: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly polystorewasm_compute_manifest: (a: number, b: number, c: number) => [number, number, number];
  readonly polystorewasm_compute_mdu_root: (a: number, b: number, c: number) => [number, number, number];
  readonly polystorewasm_set_pippenger_window_bits: (a: number, b: number) => [number, number];
  readonly polystorewasm_set_wasm_msm_basis_mode: (a: number, b: number, c: number) => [number, number];
  readonly __wbg_wasmmdu0builder_free: (a: number, b: number) => void;
  readonly wasmmdu0builder_new: (a: any) => [number, number, number];
  readonly wasmmdu0builder_new_with_commitments: (a: any, b: any) => [number, number, number];
  readonly wasmmdu0builder_load: (a: number, b: number, c: any, d: any) => [number, number, number];
  readonly wasmmdu0builder_load_legacy_recovery: (a: number, b: number, c: any, d: any) => [number, number, number];
  readonly wasmmdu0builder_stage_v2_from_trusted_legacy: (a: number, b: number, c: any, d: any) => [number, number, number];
  readonly wasmmdu0builder_append_file: (a: number, b: any, c: any, d: any) => [number, number];
  readonly wasmmdu0builder_append_file_with_flags: (a: number, b: any, c: any, d: any, e: number) => [number, number];
  readonly wasmmdu0builder_bytes: (a: number) => [number, number];
  readonly wasmmdu0builder_set_root: (a: number, b: any, c: number, d: number) => [number, number];
  readonly wasmmdu0builder_get_record_count: (a: number) => number;
  readonly wasmmdu0builder_is_legacy_recovery: (a: number) => number;
  readonly wasmmdu0builder_get_record: (a: number, b: number) => [number, number, number, number];
  readonly wasmmdu0builder_read_fat_range: (a: number, b: number, c: number) => [number, number, number, number];
  readonly wasmmdu0builder_get_root: (a: number, b: any) => [number, number, number, number];
  readonly wasmmdu0builder_get_witness_count: (a: number) => bigint;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
