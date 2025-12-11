# Current State (December 10, 2025)

## System Status: Building Mode 2
- **Goal:** Implement "StripeReplica" (Mode 2) with "Thick Client" (WASM).
- **Core:** `nil_core` is now WASM-compatible!
    - **Change:** Swapped `c-kzg` for `kzg-rs` to fix `stdlib.h` issues in WASM.
    - **Status:** Compiles to `wasm32-unknown-unknown`. `kzg.rs` methods are currently STUBS.
- **Spec:** `spec.md` updated with § 8 "Mode 2: StripeReplica".
- **Todo:** `AGENTS.md` has a detailed "Winter Roadmap".

## Next Steps (Immediate)
1.  **Implement KZG Logic:** Fill in the stubs in `nil_core/src/kzg.rs` using `kzg-rs` and `bls12_381`.
    -   Implement `blob_to_commitment` (Map bytes -> Scalars -> Commit).
    -   Implement `load_from_file` (and `load_from_bytes`).
2.  **Implement Expansion:** Create `expand_mdu` in `nil_core` using `reed-solomon-erasure`.
3.  **Frontend:** Build the WasmWorker.

## Code Context
- `nil_core/src/kzg.rs`: The crypto wrapper. Currently contains stubs. NEEDS IMPLEMENTATION.
- `nil_core/Cargo.toml`: Dependencies updated for WASM (`kzg-rs`, `getrandom` feature).
- `SCOPE_STRIPEREPLICA.md`: Detailed scope of the current sprint.
