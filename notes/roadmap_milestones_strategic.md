# Strategic Roadmap: Path to Mainnet

**Date:** 2025-12-15
**Status:** Strategic Advisory / Consulting Report
**Context:** Post-Sprint 4 (Retrieval Sessions Implemented)

## Executive Summary

NilStore has successfully demonstrated the core cryptographic primitives (Triple Proof, NilFS) and the interaction model (Gateway, Retrieval Sessions) in a "Mode 1" (Full Replica) environment. The critical path to Mainnet requires solving three major challenges:
1.  **Trustlessness:** Removing the Gateway as a custodian of user keys (Devnet Gamma).
2.  **Throughput:** Overcoming the CPU-bound KZG generation bottleneck to match S3 upload speeds.
3.  **Efficiency:** Transitioning from Mode 1 (12x overhead) to Mode 2 (1.5x overhead via Erasure Coding).

This document outlines the milestones required to execute this transition.

---

## Milestone 1: Devnet Gamma (The "Trustless" Pivot)
**Goal:** Eliminate the "Faucet/Provider-Pays" model. Users must pay for their own storage and retrieval using their own wallets (MetaMask).

*   **Consulting Analysis:** Currently, the Gateway signs transactions on behalf of users or the faucet. This masks gas costs and creates a central point of failure/custody. Before scaling, the system must prove it works when the *user* holds the keys and pays the gas.
*   **Key Deliverables:**
    *   **User-Signed Uploads:** Update the Web UI to use the `createDeal` and `updateDealContent` EVM precompiles directly. The Gateway becomes a "dumb pipe" for bytes, not a transaction signer.
    *   **User-Signed Retrievals:** Fully integrate `openRetrievalSession` and `confirmRetrievalSession` into the frontend. The browser initiates the session transaction, not the gateway.
    *   **"Become a Provider" UX:** A self-service web flow for onboarding new SPs without manual CLI intervention (generating keys, registering endpoints).

## Milestone 2: The "Velocity" Upgrade (GPU & WASM)
**Goal:** Reduce 512GB upload times from ~18 hours (CPU) to <40 minutes to make the "Wholesale" proposition viable.

*   **Consulting Analysis:** The `kzg_upload_bottleneck_report.md` is a critical red flag. CPU-based KZG generation (~8MB/s) is insufficient for the protocol's target use case. We cannot launch Mainnet with "dial-up" upload speeds for "broadband" data.
*   **Key Deliverables:**
    *   **GPU Acceleration (Icicle):** Integrate CUDA-accelerated KZG (e.g., Ingonyama's Icicle) into `nil_cli` and `nil_gateway`. Target >500 MB/s throughput.
    *   **Thick Client (WASM) Finalization:** Complete the Rust-to-WASM compilation pipeline (`nil_core`) so that small files (<100MB) can be sharded and committed directly in the browser, bypassing the Gateway for small deals.
    *   **Parallel Ingest:** Refactor the Gateway ingest pipeline to handle parallel blob commitment generation across multiple GPU streams.

## Milestone 3: Mode 2 Implementation (StripeReplica)
**Goal:** Enable Erasure Coding to reduce storage overhead and allow self-healing. This is the architectural differentiator against basic replication.

*   **Consulting Analysis:** Mode 1 (Full Replica) is expensive and brittle. Mode 2 allows the network to survive node failures mathematically rather than just via redundancy. This is the most complex engineering phase.
*   **Key Deliverables:**
    *   **Slot-Major Indexing:** Implement the "Slot-Major" leaf ordering defined in `mode2-framing.md`. This ensures providers can serve data efficiently (contiguous reads) while still supporting distributed repairs.
    *   **Virtual Stripes on Chain:** Update `nilchain` to track `VirtualStripe` assignments (slot -> provider mapping).
    *   **Client-Side Reconstruction:** Update the Fetch logic to query `K` providers in parallel and perform Reed-Solomon reconstruction on the fly if some fail.
    *   **Parity Accountability:** Implement "Design A" from the framing notes: Parity shards must be committed and provable just like data shards (using Triple Proofs).

## Milestone 4: Testnet "Store Wars" (Incentivized)
**Goal:** Stress-test the economics and adversarial resistance.

*   **Consulting Analysis:** Once Mode 2 is functional, the system needs chaos. We need to verify that "Heat" correctly routes traffic and that Slashing actually deters laziness.
*   **Key Deliverables:**
    *   **Economic Parameters:** Finalize the "Tiered Reward" curves (Platinum/Gold/Silver) based on latency.
    *   **Slashing & Jailing:** Enable automatic slashing for failed proofs and missing Retrieval Session completions.
    *   **The "Heat" Oracle:** Fully implement the on-chain Heat tracking to dynamically adjust provider rewards based on proven throughput.
    *   **Adversarial Bots:** Build bots that try to submit fake proofs, withhold data, or flood the network, to verify the chain's defenses.

## Milestone 5: Mainnet Launch (Enterprise Ready)
**Goal:** Production hardening and "Web2" compatibility.

*   **Consulting Analysis:** To capture non-crypto native demand (the "Enterprise User" archetype), the system needs to look like S3 but behave like crypto.
*   **Key Deliverables:**
    *   **S3 Adapter V1:** Polish the `nil_gateway` S3-compatible API to support standard tools like `aws-cli` or `rclone` for uploads/downloads.
    *   **Upload Delegations:** Implement the "Third-Party Uploader" pattern (from `launch_todos.md`) allowing an enterprise to fund a temporary key for a specific upload job without exposing their main wallet.
    *   **Audits:**
        *   **Cryptographic Audit:** Verify the KZG Trusted Setup and Triple Proof circuit logic.
        *   **Chain Audit:** Verify the Cosmos SDK module logic and Precompile safety.
    *   **Genesis Block:** Launch the DAO and initial validator set.

## Timeline Estimate (Aggressive)

1.  **Month 1:** Devnet Gamma (Trustless UX) & GPU Integration.
2.  **Month 2-3:** Mode 2 (StripeReplica) Implementation & Internal Alpha.
3.  **Month 4:** Incentivized Testnet (Store Wars).
4.  **Month 5:** Audits & S3 Adapter Polish.
5.  **Month 6:** Mainnet Launch.

## Technical Recommendation: Immediate Next Step

**Do not start Mode 2 yet.** The immediate friction point is the **Developer Experience (DX)** regarding keys and funding. Prioritize **Milestone 1 (Devnet Gamma)**.

**Action Item:** Create the `Become a Provider` web wizard and ensure the `nil-website` can drive the entire lifecycle (Deal -> Upload -> Session -> Retrieve) using *only* the user's MetaMask, with zero reliance on the Gateway holding a funded key. This validates the "Trustless" aspect of the product before adding the complexity of Erasure Coding.
