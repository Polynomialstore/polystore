# Scope: StripeReplica & Thick Client (Mode 2)

**Status:** Historical / Non-normative (Scope Snapshot)
**Date:** December 10, 2025

**Note:** The canonical Mode 2 protocol definition lives in `spec.md` (§8) and `rfcs/rfc-blob-alignment-and-striping.md`. This file is an implementation-scope snapshot and may lag the canonical spec.

## 1. Objective
Enable the browser to act as a full "Thick Client" capable of client-side encryption, erasure coding (Reed‑Solomon), and KZG commitment generation. This unlocks "Mode 2" (StripeReplica) where each 8 MiB SP‑MDU is encoded under RS(K, K+M) across `N = K+M` provider slots (default `K=8`, `M=4`, `N=12`).

## 2. Technical Scope

### 2.1 Core Cryptography (`nil_core` - Rust)
*   **WASM Support:** Update dependencies (`getrandom`, `c-kzg`) to compile to `wasm32-unknown-unknown`.
*   **Erasure Coding:** Implement `reed-solomon-erasure` for RS(K, K+M) (default `K=8`, `M=4`). Each slot stores `8 MiB / K` bytes per SP‑MDU (default 1 MiB when `K=8`).
*   **Expansion Pipeline:** Implement the full `expand_mdu(bytes)` function:
    *   Split Data -> 64 Blobs.
    *   RS Encode (row-by-row) -> `rows*M` Parity Blobs where `rows = 64/K`.
    *   KZG Commit -> `L = (K+M) * (64/K)` Commitments (Witness) (default `L=96` at `K=8`, `M=4`).
    *   Output -> `N = K+M` Slot Buffers + Witness commitments buffer.
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
