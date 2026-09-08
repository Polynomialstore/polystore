/* tslint:disable */
/* eslint-disable */

export class PolyStoreWasm {
  free(): void;
  [Symbol.dispose](): void;
  verify_polyfs_session_batch(input: Uint8Array): boolean;
  static challenge_context_hash(bytes: Uint8Array): Uint8Array;
  static derive_challenges(bytes: Uint8Array, seed: Uint8Array): Uint8Array;
  static validate_trusted_setup(bytes: Uint8Array): void;
  commit_received_blob(blob: Uint8Array): Uint8Array;
  static validate_packed_payload(encoded: Uint8Array, raw_len: number): void;
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
  append_file(path: string, size: bigint, start_offset: bigint): void;
  append_file_with_flags(path: string, size: bigint, start_offset: bigint, flags: number): void;
  bytes(): Uint8Array;
  set_root(index: bigint, root: Uint8Array): void;
  get_witness_count(): bigint;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_polystorewasm_free: (a: number, b: number) => void;
  readonly polystorewasm_verify_polyfs_session_batch: (a: number, b: number, c: number) => [number, number, number];
  readonly polystorewasm_challenge_context_hash: (a: number, b: number) => [number, number, number];
  readonly polystorewasm_derive_challenges: (a: number, b: number, c: number, d: number) => [number, number, number];
  readonly polystorewasm_validate_trusted_setup: (a: number, b: number) => [number, number];
  readonly polystorewasm_commit_received_blob: (a: number, b: number, c: number) => [number, number, number];
  readonly polystorewasm_validate_packed_payload: (a: number, b: number, c: number) => [number, number];
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
  readonly wasmmdu0builder_new: (a: bigint) => number;
  readonly wasmmdu0builder_new_with_commitments: (a: bigint, b: bigint) => number;
  readonly wasmmdu0builder_load: (a: number, b: number, c: bigint, d: bigint) => [number, number, number];
  readonly wasmmdu0builder_append_file: (a: number, b: number, c: number, d: bigint, e: bigint) => [number, number];
  readonly wasmmdu0builder_append_file_with_flags: (a: number, b: number, c: number, d: bigint, e: bigint, f: number) => [number, number];
  readonly wasmmdu0builder_bytes: (a: number) => [number, number];
  readonly wasmmdu0builder_set_root: (a: number, b: bigint, c: number, d: number) => [number, number];
  readonly wasmmdu0builder_get_witness_count: (a: number) => bigint;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_externrefs: WebAssembly.Table;
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
