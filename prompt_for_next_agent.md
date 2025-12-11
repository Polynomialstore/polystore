# Current State (December 10, 2025)

## System Status: Stable
- **KZG Slashing Issue:** RESOLVED.
    - **Fix:** Switched `nil_core` to use Big Endian for scalar serialization, matching `c-kzg` expectations.
    - **Verification:** `e2e_flow.sh` passes (valid proofs accepted). `e2e_slashing.sh` confirms invalid proofs are rejected client-side. `nil_core/tests/kzg_endianness_test.rs` prevents regression.
- **Website Refactor:** MERGED.
    - `website-refactor` branch merged into `main`.
    - Includes new Dashboard, Layout, and Deputy System pages.
- **NilS3 Architecture:** Filesystem on Slab (MDU #0) implemented and integrated.

## Architecture Highlights
- **Triple Proof:** Fully implemented. `nil_s3` generates Manifest Blobs and MDU #0. Chain verifies inclusion via `VerifyChainedProof`.
- **Deal Flow:** 2-Step Process (Capacity -> Content) fully supported by CLI and `nil_s3`.
- **EVM Bridge:** `GatewayCreateDealFromEvm` allows user-signed intents.

## Next Priorities
1.  **"Store Wars" Devnet Launch:** Prepare for public testnet.
    -   Deploy `nilchain` to a cloud server.
    -   Configure Faucet and Gateway public endpoints.
2.  **Wasm Client:** Compile `nil_core` to Wasm to enable client-side MDU packing in the browser (removing reliance on `nil_s3` gateway for privacy).
3.  **Mode 2 (StripeReplica):** Begin implementation of Erasure Coding across providers (RS 12,8) as per `rfc-blob-alignment-and-striping.md`.

## Code Context
- `nil_core/src/utils.rs`: Big Endian KZG utils.
- `nil_s3/main.go`: Gateway logic (now uses `IngestNewDeal`).
- `e2e_flow.sh`: Main "Happy Path" integration test.