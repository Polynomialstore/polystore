# NilStore Core v 2.4

### Cryptographic Primitives & Proof System Specification

---

## Abstract

NilStore is a decentralized storage network that unifies **Storage** and **Retrieval** into a single **Demand-Driven Performance Market**. Instead of treating storage audits and user retrievals as separate events, NilStore implements a **Unified Liveness Protocol**: user retrievals *are* storage proofs.

It specifies:
1.  **Unified Liveness:** Organic user retrieval receipts act as valid storage proofs.
2.  **Synthetic Challenges:** The system acts as the "User of Last Resort" for cold data.
3.  **Tiered Rewards:** Storage rewards are tiered by latency.
4.  **System-Defined Placement:** Deterministic assignment to ensure diversity, optimized by **Service Hints**.
5.  **Traffic Management:** User-funded **Elastic Scaling** triggered by **Saturation Signals** from Providers.

---

## § 6 Product-Aligned Economics

### 6.0 System-Defined Placement (Anti-Sybil & Hints)

To prevent "Self-Dealing," clients cannot choose their SPs. However, to optimize performance, the selection algorithm respects **Service Hints**.

#### 6.0.1 Provider Capabilities
When registering, SPs declare their intended service mode via `MsgRegisterProvider(Capabilities)`:
*   **Archive:** High capacity, standard latency.
*   **General (Default):** Balanced.
*   **Edge:** Low capacity, ultra-low latency.

#### 6.0.2 Deal Hints
`MsgCreateDeal` includes a `ServiceHint`:
*   **Cold:** Biased towards `Archive` / `General`.
*   **Hot:** Biased towards `General` / `Edge`.

### 6.1 The Unified Market & Elasticity

#### 6.1.1 Traffic Management (Saturation)
To prevent punishment of high-performing nodes during viral events, the protocol supports **Pre-emptive Scaling**.

1.  **Saturation Signal:** An SP submits `MsgSignalSaturation(DealID)`.
    *   *Condition:* SP must be currently **Platinum/Gold** and have high `ReceiptVolume`.
2.  **Action:** The Chain increases `Deal.CurrentReplication` (e.g., 12 -> 15) and triggers `SystemPlacement` to recruit **Edge** nodes.
3.  **Incentive:** The signaling SP is NOT penalized. They maintain their tier on manageable traffic, while overflow is routed to new replicas.

#### 6.1.2 User-Funded Elasticity
Scaling is not free. It is strictly constrained by the User's budget.

*   **Funding Source:** `Deal.Escrow`.
*   **Budget Cap:** `Deal.MaxMonthlySpend`.
*   **Logic:**
    *   If `Escrow > Cost(NewReplica)` AND `Spend < Cap`: **Spawn Replica.**
    *   Else: **Reject Scaling.** The file becomes rate-limited naturally.

### 6.2 Auto-Scaling (Stripe-Aligned Elasticity)

NilStore supports two redundancy modes at the policy level:

*   **Mode 1 – FullReplica (Alpha, Implemented):** Each `Deal` is replicated in full across `CurrentReplication` providers. Scaling simply adds or removes full replicas. Retrieval is satisfied by any single provider in `Deal.providers[]`. This is the current implementation and the default for the devnet.
*   **Mode 2 – StripeReplica (Planned):** Each `Deal` is split into **Stripes** (e.g., RS(12,8) across shard indices). Scaling operates at the stripe layer: for each stripe index, the protocol recruits additional overlay providers. Retrieval can aggregate bandwidth across multiple providers in parallel.

For v2.4, **Mode 1** is normative and **Mode 2** is specified as a forward-compatible extension.

To ensure effective throughput scaling, the protocol avoids "bottlenecking" by scaling the entire dataset uniformly.

#### 6.2.1 The Stripe Unit
*   **Principle:** Increasing the capacity of Shard #1 does not help if Shards #2-12 are saturated.
*   **Mechanism (Mode 2 – Planned):** Scaling operations occur in **Stripe Units**. When triggered, the protocol recruits `n` (e.g., 12) new Overlay Providers, creating one new replica for *each* shard index. In Mode 1, this is approximated by adding `n` full replicas (additional providers in `Deal.providers[]`) without per-stripe awareness.

#### 6.2.2 Damping & Hysteresis (Intelligent Triggers)
To prevent oscillation (rapidly spinning nodes up and down) and account for the cost of data transfer:
1.  **Trigger:** The protocol tracks the **Exponential Moving Average (EMA)** of `ReceiptVolume`.
    *   **Scale Up:** If `Load > 80%` of current capacity.
    *   **Scale Down:** If `Load < 30%` of current capacity.
2.  **Minimum TTL (Data Gravity):** New Overlay Replicas have a mandatory **Minimum TTL** (e.g., 24 hours).
    *   *Rationale:* Moving data consumes network resources. Spawning a replica is an "investment" that must be amortized over a minimum service period.
    *   *Cost:* The User's escrow is debited for this minimum period upon spawn.

### 6.3 Deletion (Crypto-Erasure)
*   **Mechanism:** True physical deletion cannot be proven. NilStore relies on **Crypto-Erasure**.
*   **Process:** To "delete" a file, the Data Owner destroys their copy of the `FMK`. Without this key, the stored ciphertext is statistically indistinguishable from random noise.
*   **Garbage Collection:** When a Deal is cancelled (`MsgCancelDeal`) or expires, SPs act economically: they delete the data to free up space for paying content.

## Appendix A: Core Cryptographic Primitives

### A.3 File Manifest & Crypto Policy (Normative)

NilStore uses a content‑addressed file manifest.

  * **Root CID** = `Blake2s-256("FILE-MANIFEST-V1" || CanonicalCBOR(manifest))`.
  * **DU CID** = `Blake2s-256("DU-CID-V1" || ciphertext||tag)`.
  * **Encryption:** All data is encrypted client-side before ingress.
  * **Deletion:** Achieved via key destruction (Crypto-Erasure).

## § 7 Retrieval Semantics (Mode 1 Implementation)

This section norms the retrieval path for **Mode 1 – FullReplica** in the current devnet implementation.

### 7.1 Data Plane: Fetching From Providers

1.  **Lookup:** Given a Root CID, the client resolves the corresponding `Deal` (via LCD/CLI or an index) and reads `Deal.providers[]`.
2.  **Selection:** The client selects a single Provider from `Deal.providers[]` (e.g., the nearest or least loaded). In Mode 1, each Provider holds a full replica, so any assigned Provider is sufficient.
3.  **Delivery:** The client fetches the file (or an 8 MiB MDU) from that Provider using an application‑level protocol (HTTP/S3 adapter, gRPC, or a custom P2P layer). The data is served as encrypted MDUs with accompanying KZG proof material.

In Mode 1, bandwidth aggregation across multiple Providers is **not** required. The protocol only assumes that at least one assigned Provider can serve a valid chunk per retrieval. Mode 2 will extend this to true parallel, stripe‑aware fetching.

### 7.2 Control Plane: Retrieval Receipts & On‑Chain State

NilStore tracks retrieval events via **Retrieval Receipts** and the **Unified Liveness** handler:

1.  **Receipt Construction (Client):**
    *   After verifying the KZG proof for a served chunk, the Data Owner constructs a `RetrievalReceipt`:
        *   `{deal_id, epoch_id, provider, bytes_served, proof_details (KzgProof), user_signature}`.
    *   The signed message covers `(deal_id, epoch_id, provider, bytes_served)` so SPs cannot forge receipts.
2.  **On‑Chain Submission (Provider):**
    *   The Provider wraps the receipt in `MsgProveLiveness{ ProofType = UserReceipt }` and submits it to the chain.
    *   The module verifies:
        *   Provider is assigned in `Deal.providers[]`.
        *   KZG proof is valid for the challenged MDU chunk.
        *   `user_signature` matches the Deal Owner’s on‑chain key.
3.  **Book‑Keeping & Rewards:**
    *   The keeper computes the latency tier from inclusion height (Platinum/Gold/Silver/Fail) and updates `ProviderRewards`.
    *   It debits `Deal.EscrowBalance` for the bandwidth component and records a lightweight `Proof` summary:
        *   `commitment = "deal:<id>/epoch:<epoch>/tier:<tier>"`.
    *   `Proof` entries are exposed via `Query/ListProofs` (LCD: `/nilchain/nilchain/v1/proofs`) for dashboards and analytics.

In the current devnet, the CLI (`sign-retrieval-receipt` and `submit-retrieval-proof`) drives receipt creation and submission. Web flows may fetch data over HTTP without yet emitting on‑chain receipts; this is considered **non‑normative** and will be aligned with this section as the EVM→Cosmos bridge and user‑signed deals mature.
