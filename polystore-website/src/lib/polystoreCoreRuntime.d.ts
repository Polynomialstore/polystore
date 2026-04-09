declare const init: (
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
  get_witness_count(): bigint
  free(): void
}
