declare module '/wasm/nil_core.js' {
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

  export class NilWasm {
    constructor(trusted_setup_bytes: Uint8Array)
    expand_file(data: Uint8Array): unknown
    commit_mdu(mdu_bytes: Uint8Array): unknown
    commit_blobs(blob_bytes: Uint8Array): Uint8Array
    compute_mdu_root(witness_bytes: Uint8Array): unknown
    compute_manifest(roots: Uint8Array): unknown
  }

  export class WasmMdu0Builder {
    constructor(max_user_mdus: bigint)
    append_file(path: string, size: bigint, start_offset: bigint): void
    bytes(): Uint8Array
    set_root(index: bigint, root: Uint8Array): void
    get_witness_count(): bigint
    free(): void
  }
}

