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
*(This section, particularly regarding Deal Sizing and economics, is formally defined and superseded by [RFC: Data Granularity & Economic Model](rfcs/rfc-data-granularity-and-economics.md).)*

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

#### 6.0.3 Deal Sizing (Normative via RFC: Data Granularity)
To manage chain state and prevent database dust, NilStore deals are created in specific, governance-approved increments, as defined in `rfcs/rfc-data-granularity-and-economics.md`. This separates the Financial Ledger Unit (`DEAL_SIZE`) from the Physical Retrieval Unit (`MDU_SIZE`).

**Approved Tiers for `DEAL_SIZE`:**
*   **Tier 1: Developer Slab (4 GiB):** Entry-level capacity for testing.
*   **Tier 2: Standard Slab (32 GiB):** The baseline network unit, aligned with Filecoin sectors.
*   **Tier 3: Wholesale Slab (512 GiB):** High-volume tier for Enterprise/Archive use cases.

The `MDU_SIZE` (Mega-Data Unit) remains an immutable protocol constant of **8,388,608 bytes (8 MiB)**, as it is tied to cryptographic safety (KZG Trusted Setup).

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
        *   `{deal_id, epoch_id, provider, bytes_served, nonce, expires_at, proof_details (KzgProof), user_signature}`.
    *   The signed message MUST cover `(deal_id, epoch_id, provider, bytes_served, nonce, expires_at)` so SPs cannot forge or replay receipts.
    *   `nonce` is a strictly increasing 64‑bit sequence number scoped to the Deal Owner (or payer). `expires_at` is a block height or timestamp after which the receipt is invalid.
2.  **On‑Chain Submission (Provider):**
    *   The Provider wraps the receipt in `MsgProveLiveness{ ProofType = UserReceipt }` and submits it to the chain.
    *   The module verifies:
        *   Provider is assigned in `Deal.providers[]`.
        *   `expires_at` has not passed.
        *   `nonce` is strictly greater than the last accepted nonce for this Deal Owner (or payer).
        *   KZG proof is valid for the challenged MDU chunk.
        *   `user_signature` matches the Deal Owner’s on‑chain key.
    *   The module MUST maintain persistent state `LastReceiptNonce[owner_address]` (or equivalent) and reject any receipt with `nonce ≤ LastReceiptNonce[owner_address]` as a replay.
3.  **Book‑Keeping & Rewards:**
    *   The keeper computes the latency tier from inclusion height (Platinum/Gold/Silver/Fail) and updates `ProviderRewards`.
    *   It debits `Deal.EscrowBalance` for the bandwidth component and records a lightweight `Proof` summary:
        *   `commitment = "deal:<id>/epoch:<epoch>/tier:<tier>"`.
    *   `Proof` entries are exposed via `Query/ListProofs` (LCD: `/nilchain/nilchain/v1/proofs`) for dashboards and analytics.

In the current devnet, the CLI (`sign-retrieval-receipt` and `submit-retrieval-proof`) drives receipt creation and submission. Web flows may fetch data over HTTP without yet emitting on‑chain receipts; this is considered **non‑normative** and will be aligned with this section as the EVM→Cosmos bridge and user‑signed deals mature.

### 7.3 Data Commitment Binding (Normative)

To prevent proofs over arbitrary data, all Mode 1 retrieval and storage proofs MUST be bound to the Deal’s on‑chain data commitment:

1.  **Deal Commitments:** For each `Deal`, the chain MUST store one or more cryptographic commitments to the encrypted data, e.g.:
    *   A Root CID for the File Manifest (as defined in Appendix A.3).
    *   One or more MDU‑level Merkle roots over KZG blob commitments corresponding to the stored ciphertext.
2.  **Proof Binding:** Any `KzgProof` used in `MsgProveLiveness` (either `system_proof` or `user_receipt.proof_details`) MUST be verified against the commitment(s) recorded in the corresponding `Deal`. A proof whose `mdu_merkle_root` does not match one of the Deal’s registered roots MUST be rejected.
3.  **Forward Compatibility:** In future redundancy modes (StripeReplica), additional per‑stripe or overlay commitments MAY be added, but the binding rule remains: all KZG proofs MUST verify against the Deal’s active on‑chain commitments.

### 7.4 Valid Retrieval Challenge (Mode 1 Mainnet Target)

For mainnet Mode 1, NilStore formalizes what it means for a retrieval to be a **valid challenge** against a particular `(Deal, Provider)` pair. This definition underpins both rewards and slashing.

1.  **Epoch‑Scoped Randomness:** Each block epoch `e` has a randomness beacon `R_e` derived from consensus. SPs MUST NOT be able to bias or predict `R_e` far in advance.
2.  **Challenge Tuple:** A retrieval initiated against `(deal_id, provider_id)` in epoch `e` is a valid challenge if it carries the tuple:
    *   `deal_id`, `provider_id`
    *   `epoch_e`
    *   `offset`, `length` (byte range within the file)
    *   `channel_id` (opaque payment channel identifier bound on‑chain to `(deal_id, provider_id)`)
    *   `session_nonce` (fresh 32‑byte random chosen by the client)
3.  **Deterministic KZG Checkpoint:** Both client and Provider derive a single KZG checkpoint for this retrieval:

    ```text
    (mdu_index, blob_index, eval_x) =
        DeriveCheckPoint(R_e, deal_id, channel_id, session_nonce, offset, length)
    ```

    *   `DeriveCheckPoint` is a public, deterministic function (e.g. a domain‑separated hash / PRF) whose exact encoding is specified in the implementation, but whose inputs MUST include `R_e`, `deal_id`, `channel_id`, `session_nonce`, and the requested range.
    *   The Provider MUST return data plus a KZG proof that opens the committed blob at `(mdu_index, blob_index)` at point `eval_x`.
4.  **Assignment & Capability Checks:** A retrieval counts as a valid protocol challenge only if:
    *   `provider_id ∈ Deal.providers[]` at the time of the challenge, and
    *   `channel_id` refers to a live on‑chain channel capability bound to `(deal_id, provider_id)` with sufficient remaining `limit_bytes` and a non‑expired `expiry_epoch`.
5.  **Devnet/Testnet Approximation:** Current devnet/testnet flows MAY approximate `DeriveCheckPoint` (e.g. fixed `mdu_index = 0`) and avoid explicit `channel_id`s, but MUST evolve towards this definition. Any such approximations MUST be clearly documented in `AGENTS.md` and treated as temporary.

This definition ensures that every retrieval has the **potential** to be used as a storage proof, and that SPs cannot know in advance which requests will later be used as evidence.

### 7.5 Evidence Types & Fraud Proofs

NilStore recognizes several classes of evidence derived from retrievals and synthetic checks. All evidence MUST ultimately be verifiable against the Deal’s on‑chain commitments (Section 7.3) and attributable to a specific `(deal_id, provider_id, epoch_e, mdu_index, blob_index)`.

1.  **Synthetic Storage Proofs (System‑Initiated):**
    *   For each epoch `e` and assignment `(deal_id, provider_id)`, the protocol derives a finite challenge set `S_e(D,P)` of `(mdu_index, blob_index)` pairs from `R_e`.
    *   A `SyntheticStorageProof` message carries:
        *   `(deal_id, provider_id, epoch_e, mdu_index, blob_index, eval_x, eval_y, kzg_commitment, kzg_proof, merkle_paths…)`.
    *   On‑chain verification MUST check:
        *   `(mdu_index, blob_index) ∈ S_e(D,P)`,
        *   Merkle paths reconstruct the Deal’s commitment(s),
        *   KZG opening is valid at `(eval_x, eval_y)`.
    *   A satisfied synthetic challenge contributes to storage rewards and positive health for `(D,P)`.
2.  **Retrieval‑Based Proofs (Client‑Initiated):**
    *   A `RetrievalReceipt` formed as in § 7.2, whose checkpoint matches `DeriveCheckPoint(…)`, MAY be submitted on‑chain as a `RetrievalProof`.
    *   Verification MUST:
        *   Recompute `DeriveCheckPoint` and match `(mdu_index, blob_index, eval_x)`,
        *   Verify Merkle + KZG against the Deal’s commitments,
        *   Verify `user_signature` and anti‑replay checks (nonce, expiry),
        *   Ensure `(mdu_index, blob_index) ∈ S_e(D,P)` if the receipt is to satisfy a synthetic challenge.
    *   Successful retrieval proofs count equivalently to synthetic proofs for storage reward and health.
3.  **Fraud Proofs (Wrong Data):**
    *   If a client or auditor receives a response whose KZG/Merkle proof fails against `root_cid(deal_id)`, they MAY construct a `FraudProof` that includes:
        *   The offending `RetrievalReceipt` and, optionally, the Provider’s signed response.
    *   On‑chain verification MUST:
        *   Re‑run Merkle/KZG checks and confirm failure relative to the stored commitments.
    *   A confirmed fraud proof MUST trigger slashing for the implicated `(deal_id, provider_id)` and degrade the Provider’s global health.
4.  **On‑Chain Challenge Non‑Response (Liveness Panic Path):**
    *   In extreme cases, a watcher MAY post an explicit on‑chain challenge (referencing a specific `(deal_id, provider_id, epoch_e, mdu_index, blob_index, eval_x)`).
    *   The chain MUST enforce a bounded response window; failure by the Provider to submit a corresponding `SyntheticStorageProof` within that window is treated as hard evidence of unavailability and MUST be slashable.

These evidence types collectively support the retrievability invariant: for each `(Deal, Provider)`, data is either retrievable under protocol rules or there exists high‑probability, verifiable evidence of failure that can be used to punish and eventually evict the Provider.
