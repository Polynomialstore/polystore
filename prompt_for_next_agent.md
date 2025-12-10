# Handoff: Triple Proofs Complete & Verified

The codebase has successfully completed the "Spring Roadmap - Phase 2". The **Triple Proof Architecture** is fully implemented, integrated, and **verified** via the `e2e_retrieval.sh` integration test.

## Current State
*   **Triple Proofs:** Implemented in `nil_core` (Rust), FFI, `nilchain` (Go), and `nil_cli`.
    *   **Verification:** `e2e_retrieval.sh` passes successfully. It shards a file, creates a deal, generates a Triple Proof (Manifest + Merkle + KZG), signs a receipt, and the chain verifies it, issuing rewards.
    *   **Encoding:** Fixed scalar encoding to 32-byte Big Endian with 1-byte zero padding to fit BLS12-381 modulus.
*   **Web UI:** Modernized with 2-step deal flow and `DealDetail` visualizations (Manifests/Heat).
*   **S3 Adapter:** Documentation updated to reflect the MDU/Manifest architecture.
*   **Testing:** `e2e_retrieval.sh` is the source of truth. It uses `nil_cli` to generate artifacts and `nilchaind` to verify them.

## Immediate Next Steps (Unified Liveness)
The next major protocol upgrade is **Unified Liveness** (Phase 3).
*   **Goal:** Transition from Random Audits to User-Driven Traffic verification (using the now-working Retrieval Receipts).
*   **Tasks:**
    1.  **Receipt Aggregation:** The chain handles 1 receipt per tx. We need aggregation to handle high throughput without spamming the mempool.
    2.  **Consensus Integration:** Adjust `AuditProbability` based on `DealHeatState`. High heat = low random audit.
    3.  **Gateway Integration:** The `nil_s3` gateway currently just uploads. It needs to capture user downloads, sign receipts, and batch-submit them.

## Pending Ops
*   **EVM Bridge:** The contract `NilBridge.sol` is ready but the local deployment script (`scripts/deploy_bridge_local.sh`) failed with "Connection Refused" in the last attempt (timing issue with `nilchaind` startup). Needs a retry.

## References
*   `e2e_retrieval.sh`: Main integration test (Passed).
*   `nil_cli/src/main.rs`: Reference for MDU/KZG scalar encoding.
*   `AGENTS.md`: Roadmap tracking.