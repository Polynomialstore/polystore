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
*(This section’s economic rationale is expanded in [RFC: Data Granularity & Economic Model](rfcs/rfc-data-granularity-and-economics.md). Legacy “capacity tiers / DealSize” language is deprecated; the normative semantics are **thin provisioning** with a per‑deal hard cap.)*

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

#### 6.0.3 Deal Sizing (Dynamic)
NilStore utilizes **Dynamic Thin Provisioning** for all storage deals.

*   **No Tiers:** Users do not pre-select a capacity tier.
*   **Dynamic Expansion:** Deals start with minimal state and automatically expand as content is added via `MsgUpdateDealContent`.
*   **Thin-Provision Semantics:** `MsgCreateDeal*` creates a deal with `manifest_root = empty`, `size = 0`, and `total_mdus = 0` until the first `MsgUpdateDealContent*` commits content.
*   **Hard Cap:** The protocol enforces a maximum capacity of **512 GiB** per Deal ID to prevent state bloat and ensure manageable failure domains. Large datasets should be split across multiple Deals.

The `MDU_SIZE` (Mega-Data Unit) remains an immutable protocol constant of **8,388,608 bytes (8 MiB)**.

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
*   **Mode 2 – StripeReplica (Planned):** Each `Deal` is encoded per SP‑MDU under **RS(K, K+M)** (K data slots, M parity slots; default `K=8`, `M=4`, with `K | 64`). Providers store per‑slot shard Blobs for each SP‑MDU, and scaling operates at the stripe layer. This mode uses the **Blob‑Aligned Striping** model defined in **§ 8**.

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

## § 8 Mode 2: StripeReplica & Erasure Coding (Normative Extension)

This section norms the **Blob-Aligned Striping** model required for Mode 2 operation, resolving the conflict between cryptographic verification (KZG) and network distribution (Erasure Coding).

### 8.1 The "Aligned" Striping Model

To enable **Shared-Nothing Verification** (where a provider can verify their own shard without network communication), the atomic unit of striping must match the atomic unit of KZG verification: the **Blob**.

#### 8.1.1 Constants
*   **Blob (Atom):** 128 KiB ($2^{12}$ field elements).
*   **MDU (Retrieval Unit):** 8 MiB (64 Blobs).
*   **Erasure Configuration (Mode 2):** RS(K, K+M) with default `K=8`, `M=4`, and constraint `K | 64`.

#### 8.1.2 The "Card Dealing" Algorithm
An 8 MiB SP‑MDU consists of 64 **data Blobs**. Conceptually, these are a deck of cards (`data_blob_id ∈ [0..63]`) and Mode 2 “deals” them into `K` data slots in *rows* so striping aligns with the Blob‑level KZG atom.

Let:
* `K` = data slots, `M` = parity slots, `N = K+M`
* `rows = 64 / K` (requires `K | 64`)

Define a conceptual matrix of data Blobs `D[row][col]` with:
* `row ∈ [0..rows-1]`, `col ∈ [0..K-1]`
* `data_blob_id = row*K + col`

For each `row`, apply RS(K, K+M) across slots to produce `N` shard Blobs `S[slot][row]`:
* Data slots: `slot ∈ [0..K-1]` correspond to the original `D[row][col]` blobs.
* Parity slots: `slot ∈ [K..N-1]` are parity Blobs derived from the row.

**Benefit:** Each provider stores complete 128 KiB Blobs (its `rows` shards per SP‑MDU), so it can verify and prove each Blob individually using standard KZG.

#### 8.1.3 Locked: Slot-major `leaf_index` ordering

To prioritize the hot-path (serving/proving), Mode 2 uses a **slot-major** canonical leaf ordering for the per-SP‑MDU Merkle tree.

Index spaces:
* `data_blob_id ∈ [0..63]` refers to the 64 logical data Blobs inside the unencoded SP‑MDU (conceptual packing only).
* `leaf_index ∈ [0..L-1]` refers to the Merkle leaf index for the encoded per‑slot shard Blobs.
* In **Mode 2**, `ChainedProof.blob_index` MUST be interpreted as `leaf_index`.

Definitions:
*   `K` = data slots
*   `M` = parity slots
*   `N = K+M` = total slots/providers
*   Constraint: `K | 64` (so `rows` are integral)
*   `rows = 64 / K`
*   `L = N * rows` (Merkle leaves per SP‑MDU in Mode 2)

Leaf mapping (canonical):
*   `leaf_index = slot * rows + row`
*   `slot = leaf_index / rows`
*   `row  = leaf_index % rows`

In this ordering, each provider slot owns a contiguous range of leaf indices for each SP‑MDU, which simplifies witness lookup and on-chain enforcement.

### 8.2 Parity & Homomorphism
To generate the `M` parity Blobs for each `row`:
*   Parity is calculated across the row’s `K` data Blobs (`D[row][0..K-1]`).
*   Due to the homomorphic property of KZG, the Parity Shards are also composed of valid 128 KiB KZG polynomials.
*   Parity Nodes are indistinguishable from Data Nodes in terms of verification logic.

**Determinism (Normative):** For a fixed `(K, M)` profile and the canonical leaf ordering (§8.1.3), RS encoding/decoding MUST be deterministic, so that repairing a missing slot reconstructs a bit‑identical shard Blob to what the evicted provider stored for the same `(mdu_index, leaf_index)`.

### 8.3 Replicated Metadata Policy
To support this model, the "Map" must be fully replicated:
*   **User Data MDUs:** **Striped** (1 slot shard per Provider).
*   **Metadata MDUs (MDU #0 + Witness):** **Fully Replicated** (Copy on All `N = K+M` Providers).

**Witness Expansion:** For each data‑bearing SP‑MDU, the Witness MDUs MUST contain KZG commitments for **ALL `L = (K+M) * (64/K)` shard Blobs** (data + parity). This allows any provider (data or parity) to prove its holding against the global root. (Default `K=8`, `M=4` gives `L=96`.)

**MDU index convention (Mode 2):** NilFS metadata occupies the lowest `mdu_index` values (`MDU #0` first, followed by the Witness MDUs). Synthetic challenges MUST be derived only over striped user‑data MDUs; metadata MDUs are replicated and are not used for per‑slot accountability.

### 8.4 Deal Generations & Repair Mode (Planned, Forward-Compatible)

Mode 2 requires the chain to represent “where the deal is in time” so repairs, reads, and writes can safely overlap.

#### 8.4.1 Deal generation fields (conceptual)
A Mode 2 Deal is associated with a monotonic **generation**:
* `Deal.current_gen` (monotonic counter)
* `Deal.manifest_root` and `Deal.total_mdus` are interpreted as the **current generation**’s committed state.

Any on-chain update that changes `Deal.manifest_root` MUST increment `Deal.current_gen`.

#### 8.4.2 Repair mode (maintenance)
The chain MAY mark one or more provider slots as being in repair:
* `slot_status[slot] ∈ { ACTIVE, REPAIRING }`

While `slot_status[slot] = REPAIRING`:
* **Reads** remain valid and SHOULD route around the repairing slot (fetch any `K` healthy slots per SP‑MDU).
* **Synthetic challenges** MUST NOT target repairing slots; per-slot accountability applies only to ACTIVE slots.
* A liveness proof submitted by a REPAIRING slot MUST be rejected for reward/health accounting (but the underlying proof format remains valid against `Deal.manifest_root`).

When the replacement provider has reconstructed and stored its shard Blobs up to the current generation, the chain transitions the slot back to ACTIVE.

#### 8.4.3 Append-only writes during repair (near-term rule)
To avoid write/repair races while keeping the system usable, Mode 2 supports **append-only** deal updates even while one or more slots are REPAIRING.

An update is append-only iff:
* `new_total_mdus >= old_total_mdus`, and
* for all `mdu_index < old_total_mdus`, the committed MDU roots for those indices are unchanged (only new MDU indices are added).

Append-only updates advance `Deal.current_gen` and `Deal.manifest_root`. Repairing slots simply catch up by reconstructing the newly appended shard Blobs before rejoining ACTIVE.

#### 8.4.4 Future: full versioned writes
In future versions, non-append mutations (rewrite, delete/GC, compaction) SHOULD be represented as a new “pending generation” promoted to current only once placement conditions are met. This generalizes the append-only rule without changing the read/repair model.

## Appendix A: Core Cryptographic Primitives

### A.3 File Manifest & Crypto Policy (Normative)

NilStore MAY use a content‑addressed *file* manifest at the application layer (encryption metadata, UX-level references). This is distinct from the protocol-level Deal commitment (`Deal.manifest_root`, the 48‑byte KZG root used by the Triple Proof) and NilFS path addressing.

**Gateway/API note:** Some app codepaths may still label the deal commitment as a `cid`. In all protocol-facing APIs:

*   `cid` is a legacy alias for the *deal-level* `Deal.manifest_root` (not the Root/DU CIDs below).
*   For REST/path params, `manifest_root` parsing is strict: 48‑byte compressed BLS12‑381 G1 (96 hex chars, optional `0x` prefix), rejecting invalid encodings and invalid subgroup points (return `400`).
*   Retrieval/proof flows are keyed by NilFS `file_path` and validated against `Deal.manifest_root` (no `uploads/index.json` or “single-file deal” fallbacks).
*   `file_path` is **mandatory** and MUST be unique within a deal; uploads to an existing path overwrite deterministically and `GET /gateway/list-files/{manifest_root}` returns a deduplicated view (latest non-tombstone record per path).
*   `file_path` decoding is strict: decode at most once, reject traversal/absolute paths, and beware `+` vs `%20` (clients should use JS `encodeURIComponent`).
*   For devnet convenience endpoints (e.g., `/gateway/fetch/{manifest_root}`, `/gateway/list-files/{manifest_root}`, `/gateway/prove-retrieval`), the gateway MUST (a) require `deal_id` + `owner` for access control and (b) reject stale `manifest_root` values that do not match on-chain deal state (prefer `409`).
*   Non-200 responses MUST be JSON `{ "error": "...", "hint": "..." }` (even if the success path is a byte stream). Missing/invalid `file_path` returns `400` with a remediation hint (call `/gateway/list-files/{manifest_root}` to discover valid paths).

  * **Root CID** = `Blake2s-256("FILE-MANIFEST-V1" || CanonicalCBOR(manifest))`.
  * **DU CID** = `Blake2s-256("DU-CID-V1" || ciphertext||tag)`.
  * **Encryption:** All data is encrypted client-side before ingress. Deal commitments (and KZG proofs) bind to the **ciphertext bytes**; decryption is purely a client concern.
  * **Metadata confidentiality (optional):** NilFS metadata (MDU #0 and higher-level manifests) MAY be encrypted the same way as file data. If metadata is encrypted, SPs remain oblivious (they store bytes), while clients decrypt after verifying against `Deal.manifest_root`.
  * **Deletion:** Achieved via key destruction (Crypto-Erasure).

## § 7 Retrieval Semantics (Mode 1 Implementation)

This section norms the retrieval path for **Mode 1 – FullReplica** in the current devnet implementation.

### 7.1 Data Plane: Fetching From Providers

1.  **Lookup (Deal):** Given a `deal_id`, the client queries chain state for the corresponding `Deal` and reads `Deal.providers[]`.
2.  **Resolve (NilFS):** The requested file within the Deal is identified by `file_path` (NilFS). The client mounts the Deal’s NilFS File Table (MDU #0) to map `file_path` → byte offsets / MDU ranges.
3.  **Selection:** The client selects a single Provider from `Deal.providers[]` (e.g., the nearest or least loaded). In Mode 1, each Provider holds a full replica, so any assigned Provider is sufficient.
4.  **Delivery:** The client fetches the file (or an 8 MiB MDU) from that Provider using an application‑level protocol (HTTP/S3 adapter, gRPC, or a custom P2P layer). The data is served as encrypted MDUs with accompanying KZG proof material.

In Mode 1, bandwidth aggregation across multiple Providers is **not** required. The protocol only assumes that at least one assigned Provider can serve a valid chunk per retrieval. Mode 2 will extend this to true parallel, stripe‑aware fetching.

#### 7.1.1 Mode 2 (Planned): Stripe-aware retrieval & challenges

For Mode 2, `Deal.providers[]` is interpreted as an ordered slot list `slot → provider` of length `N = K+M`.

* **Retrieval (hot path):** for each required SP‑MDU, the client fetches shard Blobs for any `K` slots (typically the fastest responders), verifies each received shard against `Deal.manifest_root` using a `ChainedProof` (with `Proof.blob_index = leaf_index` per §8.1.3), then RS‑decodes to reconstruct the SP‑MDU bytes.
* **Synthetic challenges (accountability):** the protocol derives challenges keyed by `(deal_id, slot)` so every slot is independently accountable. In a Mode 2 proof, the chain enforces that the submitting provider matches the challenged `slot` (see §7.4).

#### 7.1.2 Client bootstrap & caching (Non-normative guidance)

Clients (Gateways, CLIs, browsers) SHOULD treat NilStore as a content-addressed system at the deal layer and cache aggressively:
* **Bootstrap:** given `(deal_id, owner)` and the on-chain `Deal.manifest_root`, a client MUST be able to fetch and verify NilFS metadata (MDU #0 + Witness MDUs) and enumerate valid `file_path` entries without any out-of-band index.
* **Metadata caching:** cache verified metadata by `(deal_id, Deal.current_gen, mdu_index)`; in Mode 2 this is not per-provider because metadata MDUs are replicated and bit-identical across all slots.
* **Data caching:** cache reconstructed plaintext files (or reconstructed SP‑MDUs) behind an LRU keyed by `(deal_id, Deal.current_gen, file_path, byte_range)` to avoid repeated network fetches; revalidation can be performed by re-checking on-chain `Deal.manifest_root` and (optionally) re-verifying proofs on cache fill.

### 7.2 Control Plane: Retrieval Receipts & On‑Chain State

NilStore tracks retrieval events via **Retrieval Receipts** and the **Unified Liveness** handler:

1.  **Receipt Construction (Client):**
    *   After verifying the KZG proof for a served chunk, the Data Owner constructs a `RetrievalReceipt`:
        *   `{deal_id, epoch_id, provider, bytes_served, nonce, expires_at, proof_details (ChainedProof), user_signature}`.
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

In the current devnet, the CLI (`sign-retrieval-receipt` / `submit-retrieval-proof`) and the Web Gateway (`/gateway/fetch`, `/gateway/prove-retrieval`) MAY drive receipt/proof submission as a convenience “meta‑transaction” layer. Web downloads that do not trigger on‑chain receipts are **non‑normative** and expected to be phased out; the intended end state is that retrievals always produce verifiable on‑chain liveness evidence derived from NilFS (MDU #0 + on-disk slab) and the Deal’s on‑chain commitments.

### 7.3 Data Commitment Binding (Normative: The Triple Proof)

To prevent proofs over arbitrary data while enabling scalability to Petabyte datasets, all Mode 1 retrieval and storage proofs MUST use the **Triple Proof (Chained Verification)** architecture. This mechanism enables the blockchain to verify a specific byte of data while storing only a single 48-byte commitment (`ManifestRoot`) for the entire Deal.

1.  **Deal Commitments:** For each `Deal`, the chain stores only the **Manifest Root** (48-byte KZG Commitment). This root commits to a Manifest Polynomial $P(x)$ where each evaluation $y = P(i)$ corresponds to the scalar field representation of the Merkle Root of MDU $i$.
    *   `Deal.manifest_root` is the anchor of trust for the entire file.
2.  **Chained Proof Binding:** Any proof used in `MsgProveLiveness` (specifically `ChainedProof`) MUST bridge the gap from `Deal.manifest_root` to the specific data byte in three hops:
    *   **Hop 1 (Identity - KZG):** Prove that the MDU Merkle Root (as a scalar `mdu_root_fr`) is committed in the Manifest Polynomial at the correct `mdu_index`.
        *   `VerifyKZG(Deal.manifest_root, mdu_index, mdu_root_fr, manifest_opening)`
    *   **Hop 2 (Structure - Merkle):** Prove that the 128KB Blob Commitment is a leaf in the MDU's Merkle Tree.
        *   `VerifyMerkle(mdu_root_fr, blob_commitment, merkle_path)`
    *   **Hop 3 (Data - KZG):** Prove that the Data Byte is the evaluation of the Blob Polynomial at the challenge point.
        *   `VerifyKZG(blob_commitment, z_value, y_value, kzg_opening_proof)`

### 7.4 The Verification Algorithm

The verifier (Chain Node) executes the following logic inside the `MsgProveLiveness` handler to validate a `ChainedProof`.

**Algorithm: `VerifyChainedProof(Deal, Challenge, Proof)`**

1.  **Input Sanity Check:**
      * Ensure `Proof.mdu_index` matches the MDU index derived from `Challenge`.
      * Ensure `Proof.mdu_index < Deal.total_mdus`.
      * Ensure `Proof.blob_index` is in range for the Deal’s redundancy mode:
          * **Mode 1:** require `Proof.blob_index < 64`.
          * **Mode 2:** compute `rows = 64 / K`, `L = (K+M) * rows`, require `Proof.blob_index < L`, and for striped user‑data MDUs require `slot(Proof.blob_index) == slot(msg.creator)` using `slot(i) = i / rows`.

2.  **Hop 1: Verify Identity (The Map) [KZG]**
      * *Goal:* Prove that the SP isn't lying about the Merkle Root of the target MDU.
      * *Check:* `VerifyKZG(Deal.manifest_root, Proof.mdu_index, Proof.mdu_root_fr, Proof.manifest_opening)` MUST return TRUE.

3.  **Hop 2: Verify Structure (The MDU) [Merkle]**
      * *Goal:* Prove that the specific 128KB Blob is actually part of that MDU.
      * *Check:* `VerifyMerkle(Proof.mdu_root_fr, Proof.blob_commitment, Proof.merkle_path)` MUST return TRUE.
      * *Note:* `Proof.mdu_root_fr` is a scalar; it must be converted or hashed to match the Merkle root format.

4.  **Hop 3: Verify Data (The Blob) [KZG]**
      * *Goal:* Prove that the SP possesses the data inside that Blob.
      * *Check:* `VerifyKZG(Proof.blob_commitment, Proof.z_value, Proof.y_value, Proof.kzg_opening_proof)` MUST return TRUE.

5.  **Result:**
      * If all 3 hops pass, the proof is valid. The SP has proven possession of the specific byte requested by the protocol.

### 7.5 Evidence Types & Fraud Proofs

NilStore recognizes several classes of evidence derived from retrievals and synthetic checks. All evidence MUST ultimately be verifiable against the Deal’s on‑chain commitments (Section 7.3) and attributable to a specific `(deal_id, provider_id, epoch_e, mdu_index, blob_index)` (Mode 2: `blob_index = leaf_index`, §8.1.3).

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
