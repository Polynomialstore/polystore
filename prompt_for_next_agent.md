# Handoff: Triple Proof & Web UI Modernization

The codebase is in the middle of implementing the "Triple Proof" (Chained Verification) architecture for scalable retrieval proofs.

## Current State
*   **Proto:** `Deal` uses `ManifestRoot` (48-byte KZG Commitment). `ProveLiveness` accepts `ChainedProof` (3-Hop).
*   **Keeper (`nilchain`):** `msg_server.go` is updated to handle new types. Verification is **STUBBED** (`valid := true`) pending Core FFI updates.
*   **Core (`nil_core`):** `compute_manifest_commitment` is implemented and exposed via FFI (generates Manifest from list of MDU roots).
*   **Tests:** Keeper tests are refactored and passing (verifying structure, not crypto).

## Next Immediate Tasks (Step 1.C - Chain Verification)
1.  **Implement `verify_manifest_inclusion` in `nil_core` (Rust):**
    *   This is "Hop 1". Verify that `mdu_root_fr` is the value of the Manifest Polynomial at index `mdu_index`.
    *   **Challenge:** Mapping `mdu_index` (integer) to KZG evaluation point `z` (Root of Unity). You need to investigate how `c-kzg` handles evaluation points for Blobs.
    *   Implement `verify_chained_proof` FFI that wraps:
        *   Hop 1: Manifest Inclusion (KZG).
        *   Hop 2: Blob Inclusion (Merkle - already exists as `verify_mdu_merkle_proof`).
        *   Hop 3: Data Inclusion (KZG - already exists as `verify_proof`).
2.  **Expose FFI in Go (`nilchain/x/crypto_ffi`):**
    *   Update `crypto_ffi.go` to call the new Rust functions.
3.  **Wire into Keeper (`nilchain/x/nilchain/keeper/msg_server.go`):**
    *   Replace the `valid := true` stub in `ProveLiveness` with the actual `crypto_ffi.VerifyChainedProof` call.

## Parallel Track (Web UI)
*   The `nil-website` needs to be updated to support the new "Capacity vs Content" deal flow.
*   See `AGENTS.md` for details (Step 2: Web UI Modernization).

## References
*   `AGENTS.md` (Updated Roadmap).
*   `spec.md` & `metaspec.md` (Triple Proof Definitions).
*   `nil_core/src/kzg.rs` (Core Logic).