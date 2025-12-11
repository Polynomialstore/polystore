# Current State (December 10, 2025)

## System Status: Building Mode 2
- **Core:** `nil_core` migrated to `kzg-rs` (Pure Rust).
    - **Logic:** `blob_to_commitment` (MSM), `verify_proof` implemented. `compute_proof` stubbed.
    - **WASM:** Compiles on Native. Fails on WASM target due to `sp1_bls12_381` error: `cannot find value MODULUS_LIMBS_32`.
- **Spec:** `spec.md` updated with § 8 "Mode 2".
- **Todo:** `AGENTS.md` updated.

## Next Steps (Immediate)
1.  **Fix WASM Build:** Resolve `MODULUS_LIMBS_32` error in `sp1_bls12_381`.
    -   Possible fix: Pin a different version, patch `kzg-rs`, or define target env vars.
2.  **Implement Expansion:** Create `expand_mdu` in `nil_core` using `reed-solomon-erasure`.
3.  **Frontend:** Build WasmWorker.

## Code Context
- `nil_core/src/kzg.rs`: Crypto logic using `kzg-rs` and `sp1_bls12_381`.
- `nil_core/Cargo.toml`: Deps.