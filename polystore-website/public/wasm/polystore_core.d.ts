/* tslint:disable */
/* eslint-disable */

export class PolyStoreWasm {
  free(): void;
  [Symbol.dispose](): void;
  commit_mdu(mdu_bytes: Uint8Array): any;
  expand_file(data: Uint8Array): any;
  commit_blobs(blobs_flat: Uint8Array): Uint8Array;
  expand_mdu_rs(mdu_bytes: Uint8Array, k: number, m: number): any;
  compute_manifest(roots_flat: Uint8Array): any;
  compute_mdu_root(witness_flat: Uint8Array): any;
  commit_blobs_profiled(blobs_flat: Uint8Array): any;
  expand_payload_rs_flat(payload_bytes: Uint8Array, k: number, m: number): any;
  set_wasm_msm_basis_mode(mode: string): void;
  set_pippenger_window_bits(bits: number): void;
  expand_mdu_rs_flat_committed(mdu_bytes: Uint8Array, k: number, m: number): any;
  expand_mdu_rs_flat_uncommitted(mdu_bytes: Uint8Array, k: number, m: number): any;
  expand_payload_rs_flat_committed(payload_bytes: Uint8Array, k: number, m: number): any;
  expand_payload_rs_flat_uncommitted(payload_bytes: Uint8Array, k: number, m: number): any;
  expand_mdu_rs_flat_committed_profiled(mdu_bytes: Uint8Array, k: number, m: number): any;
  constructor(trusted_setup_bytes: Uint8Array);
  expand_payload_rs_flat_committed_profiled(payload_bytes: Uint8Array, k: number, m: number): any;
}

export class WasmMdu0Builder {
  free(): void;
  [Symbol.dispose](): void;
  append_file(path: string, size: bigint, start_offset: bigint): void;
  get_witness_count(): bigint;
  static new_with_commitments(max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder;
  append_file_with_flags(path: string, size: bigint, start_offset: bigint, flags: number): void;
  constructor(max_user_mdus: bigint);
  static load(data: Uint8Array, max_user_mdus: bigint, commitments_per_mdu: bigint): WasmMdu0Builder;
  bytes(): Uint8Array;
  set_root(index: bigint, root: Uint8Array): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_nilwasm_free: (a: number, b: number) => void;
  readonly __wbg_wasmmdu0builder_free: (a: number, b: number) => void;
  readonly nilwasm_commit_blobs: (a: number, b: number, c: number) => [number, number, number];
  readonly nilwasm_commit_blobs_profiled: (a: number, b: number, c: number) => [number, number, number];
  readonly nilwasm_commit_mdu: (a: number, b: number, c: number) => [number, number, number];
  readonly nilwasm_compute_manifest: (a: number, b: number, c: number) => [number, number, number];
  readonly nilwasm_compute_mdu_root: (a: number, b: number, c: number) => [number, number, number];
  readonly nilwasm_expand_file: (a: number, b: number, c: number) => [number, number, number];
  readonly nilwasm_expand_mdu_rs: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly nilwasm_expand_mdu_rs_flat_committed: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly nilwasm_expand_mdu_rs_flat_committed_profiled: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly nilwasm_expand_mdu_rs_flat_uncommitted: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly nilwasm_expand_payload_rs_flat: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly nilwasm_expand_payload_rs_flat_committed: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly nilwasm_expand_payload_rs_flat_committed_profiled: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly nilwasm_expand_payload_rs_flat_uncommitted: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
  readonly nilwasm_new: (a: number, b: number) => [number, number, number];
  readonly nilwasm_set_pippenger_window_bits: (a: number, b: number) => [number, number];
  readonly nilwasm_set_wasm_msm_basis_mode: (a: number, b: number, c: number) => [number, number];
  readonly wasmmdu0builder_append_file: (a: number, b: number, c: number, d: bigint, e: bigint) => [number, number];
  readonly wasmmdu0builder_append_file_with_flags: (a: number, b: number, c: number, d: bigint, e: bigint, f: number) => [number, number];
  readonly wasmmdu0builder_bytes: (a: number) => [number, number];
  readonly wasmmdu0builder_get_witness_count: (a: number) => bigint;
  readonly wasmmdu0builder_load: (a: number, b: number, c: bigint, d: bigint) => [number, number, number];
  readonly wasmmdu0builder_new: (a: bigint) => number;
  readonly wasmmdu0builder_new_with_commitments: (a: bigint, b: bigint) => number;
  readonly wasmmdu0builder_set_root: (a: number, b: bigint, c: number, d: number) => [number, number];
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
