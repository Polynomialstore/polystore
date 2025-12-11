# Scope: StripeReplica & Thick Client (Mode 2)

**Status:** Proposed
**Date:** December 10, 2025

## 1. Objective
Enable the browser to act as a full "Thick Client" capable of client-side encryption, erasure coding (Reed-Solomon), and KZG commitment generation. This unlocks the "Mode 2" (StripeReplica) architecture where files are striped across 12 providers.

## 2. Technical Scope

### 2.1 Core Cryptography (`nil_core` - Rust)
*   **WASM Support:** Update dependencies (`getrandom`, `c-kzg`) to compile to `wasm32-unknown-unknown`.
*   **Erasure Coding:** Implement `reed-solomon-erasure` (RS 12,8) to split 8 MiB MDUs into 12 stripes (1 MiB each).
*   **Expansion Pipeline:** Implement the full `expand_mdu(bytes)` function:
    *   Split Data -> 64 Blobs.
    *   RS Encode -> 32 Parity Blobs.
    *   KZG Commit -> 96 Commitments (Witness).
    *   Output -> 12 Shard Buffers + 1 Witness Buffer.
*   **Trusted Setup:** Refactor loading to accept raw bytes (passed from JS) instead of file paths.

### 2.2 Frontend (`nil-website` - React/TS)
*   **WasmWorker:** Create a Web Worker to run the heavy `expand_mdu` WASM function off the main thread.
*   **Integration:** Replace the mock `FileSharder.tsx` with the real WASM pipeline.
*   **Asset Management:** Serve the `trusted_setup.txt` (or binary) as a static asset to be fetched and passed to WASM.

### 2.3 CLI (`nil-cli`)
*   Align `nil-cli shard` to use the same `expand_mdu` Rust function, ensuring identical behavior between CLI and Web.

## 3. Implementation Phases

### Phase 1: Preparation (Specs & Todos)
*   Update `spec.md` with Mode 2 algorithms.
*   Update `AGENTS.md` with granular Todo list.

### Phase 2: WASM Foundation
*   Fix `nil_core` WASM build.
*   Implement `load_trusted_setup_bytes`.
*   Expose basic KZG to JS.

### Phase 3: Mode 2 Logic
*   Add `reed-solomon-erasure`.
*   Implement `expand_mdu`.
*   Update Frontend to use WasmWorker.
