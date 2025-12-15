declare module '/wasm/nil_core.js' {
  const init: (input?: RequestInfo | URL | Response | BufferSource | WebAssembly.Module) => Promise<unknown>;
  export default init;
  export const NilWasm: unknown;
}
