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

## § 1 Overview (Meta-Specification)

NilStore’s protocol design is guided by a small set of architectural tenets:

1.  **Retrieval IS Storage:** user retrieval receipts count as valid storage proofs.
2.  **The System is the User of Last Resort:** cold data is maintained via synthetic challenges when organic demand is low.
3.  **Optimization via Hints:** clients express intent (`Hot`/`Cold`) while the chain enforces system-defined placement and diversity.
4.  **Elasticity is User-Funded:** bandwidth and replication are increased only when the user’s escrow/budget can pay for it.

---

## § 2 The Deal Object (Conceptual)

The `Deal` is the central on-chain state object. This spec describes its semantics without requiring an exact protobuf layout.

Key fields:
*   **Identity:** `deal_id` (uint64), `owner` (address).
*   **Commitment Root:** `manifest_root` (48‑byte KZG commitment, BLS12‑381 G1 compressed). This is the protocol’s anchor for all proofs (§7.3).
*   **Provisioning:** thin-provisioned container with `total_mdus` (count) and `allocated_length` (bytes), expanded only via content commits (§6.0.3).
*   **Placement:** `providers[]` is the assigned provider set.
    *   **Mode 1:** unordered replica set; any single provider can satisfy retrievals.
    *   **Mode 2:** ordered slot list `slot → provider` of length `N = K+M` (§7.1.1, §8.1.3).
*   **Service Hint:** `Hot | Cold` informs placement/elasticity policy (§6.0.2).
*   **Economics:** `escrow` (combined storage + bandwidth), plus `max_monthly_spend` for user-funded elasticity (§6.1.2).
*   **Redundancy Mode:** Mode 1 (FullReplica) or Mode 2 (StripeReplica / RS(K,K+M)) (§6.2, §8).

Constants:
*   `MDU_SIZE = 8,388,608` bytes (8 MiB) is an immutable protocol constant.
*   `BLOB_SIZE = 128 KiB` is the cryptographic atom for KZG verification (§8.1.1).

---

## § 3 System-Defined Placement (Conceptual)

At a high level, provider selection is deterministic and anti-sybil:

**Function (conceptual):** `AssignProviders(deal_id, epoch_seed, active_set, hint)`

1.  **Filter:** select candidates consistent with the Deal’s `ServiceHint` and provider capabilities (§6.0.1–6.0.2).
2.  **Seed:** derive a deterministic seed from `(deal_id, chain randomness)`.
3.  **Select:** sample providers deterministically from the candidate set.
4.  **Diversity:** enforce distinct failure domains (e.g., ASN/subnet) subject to bootstrap constraints (§5.1).

This section is intentionally conceptual; concrete placement optimization is an RFC target (Appendix B).

---

## § 4 Economics & Flow Control (Conceptual)

NilStore’s economics combine a performance market with user-funded scaling:

### 4.1 Tiered Rewards (Parameters)
Providers are rewarded by observed inclusion/latency tiers (e.g., Platinum/Gold/Silver/Fail). Exact tier windows and multipliers are protocol parameters (Appendix B).

### 4.2 Saturation & Elasticity (Parameters)
Providers may signal saturation to trigger user-funded replica/overlay expansion, subject to damping and a minimum TTL to respect data gravity (§6.1–6.2).

### 4.3 Rotation (Planned)
The protocol anticipates rotation/rebalancing flows where an old provider is only released after a new provider proves readiness (“make-before-break”) (§5.3).

---

## § 5 System Constraints & Meta-Risks (Planned Safeguards)

This section documents accepted architectural risks and required safeguards.

### 5.1 Cold Start Fragility (Bootstrap Mode)
*   **Risk:** system-defined placement assumes a large, diverse active set. When the active set is small (early testnet), strict diversity constraints may be impossible to satisfy.
*   **Safeguard:** the chain SHOULD support a governance-gated **Bootstrap Mode** that relaxes diversity constraints until `ActiveSetSize > Threshold`.

### 5.2 Viral Debt Risk (Third-Party Sponsorship)
*   **Risk:** user-funded elasticity creates a hard stop; if escrow is depleted during a viral event, content throttles.
*   **Assessment:** this is an acceptable economic state (“you get what you pay for”), but the protocol SHOULD support **third-party sponsorship** (e.g., `MsgFundEscrow`) to let communities fund important content.

### 5.3 Data Gravity & Non-Atomic Migration (Make-Before-Break)
*   **Risk:** moving data takes time; when a provider is rotated or replaced, there is a gap before the new provider is ready.
*   **Safeguard:** migration MUST be overlapping: the old provider is not removed until the new provider submits an initial valid proof at the current generation (§8.4).

### 5.4 Economic Sybil Assumption (Wash-Traffic)
*   **Risk:** unified liveness could be exploited via fake traffic.
*   **Safeguard:** (1) retrieval receipts require Data Owner signatures; (2) data is stored as ciphertext; (3) protocol burn/debit ensures wash-trading has a real cost.

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

This section norms the retrieval path for **Mode 1 – FullReplica** in the current devnet implementation and defines the evidence model used for retrievability and accountability. Several subsections are explicitly marked as planned, forward-compatible extensions.

### 7.0 Core Invariants (Planned, North-Star)

NilStore’s retrieval system is designed to satisfy two invariants:

1.  **Retrievability / Accountability**
    *   For every `(Deal, Provider)` assignment, either:
        *   the encrypted data is reliably retrievable under protocol rules, **or**
        *   there exists high‑probability, verifiable evidence of failure that can be used to penalize and eventually evict the provider.
2.  **Self‑Healing Placement**
    *   Persistently underperforming or malicious providers SHOULD be detected via evidence/health metrics and replaced without manual intervention.

### 7.0.1 Challenge Families (Planned)

To support the invariants, the protocol uses three challenge families, all binding back to the Deal’s on‑chain commitments (§7.3):

1.  **Synthetic Storage Challenges (System‑Driven)**
    *   For each epoch `e` and `(Deal, Provider)`, the chain derives a finite set `S_e(D,P)` of `(mdu_index, blob_index)` pairs from epoch randomness `R_e`.
    *   Providers earn storage rewards by satisfying sufficient synthetic coverage over time (direct synthetic proofs or credited retrieval receipts).
2.  **Retrieval Liveness Challenges (Client / Auditor‑Driven)**
    *   Normal user reads, provider-initiated audits, and third‑party watchers all issue retrieval challenges.
    *   Each retrieval SHOULD map deterministically to a verifiable checkpoint so retrievals can satisfy synthetic demand when aligned with `S_e(D,P)`.
3.  **Escalated On‑Chain Challenges (Panic Mode)**
    *   Watchers MAY post explicit on‑chain challenges that force a provider to respond within a fixed block window; non‑response is hard evidence of unavailability (§7.5).

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
    *   After verifying the Triple Proof for a served byte-range, the Data Owner constructs a `RetrievalReceipt`:
        *   `{deal_id, epoch_id, provider, file_path, range_start, range_len, bytes_served, nonce, expires_at, proof_details (ChainedProof), user_signature}`.
    *   The signed message MUST be bound to the exact `proof_details` via `proof_hash = keccak256(encode(ChainedProof))` and MUST cover `(deal_id, epoch_id, provider, file_path, range_start, range_len, bytes_served, nonce, expires_at, proof_hash)` so SPs cannot forge, inflate, or replay receipts.
    *   `user_signature` is an EIP-712 typed-data signature under domain `{name: "NilStore", version: "1", chainId: Params.eip712_chain_id, verifyingContract: 0x0000000000000000000000000000000000000000}`. Devnet default is `eip712_chain_id = 31337`.
    *   `nonce` is a strictly increasing 64‑bit sequence number scoped to `(deal_id, file_path)` for the Deal Owner (or payer), enabling parallel downloads of different files within the same deal. `expires_at` is a block height or timestamp after which the receipt is invalid.
2.  **On‑Chain Submission (Provider):**
    *   The Provider wraps the receipt in `MsgProveLiveness{ ProofType = UserReceipt }` and submits it to the chain.
    *   The module verifies:
        *   Provider is assigned in `Deal.providers[]`.
        *   Receipt envelope consistency:
            *   `receipt.deal_id == msg.deal_id`
            *   `receipt.epoch_id == msg.epoch_id`
            *   `receipt.provider == msg.creator`
            *   `receipt.bytes_served == receipt.range_len` (range binding for accounting)
        *   `expires_at` has not passed.
        *   `nonce` is strictly greater than the last accepted nonce for `(deal_id, file_path)` (payer-scoped).
        *   KZG proof is valid for the challenged MDU chunk.
        *   `user_signature` matches the Deal Owner’s on‑chain key.
    *   The module MUST maintain persistent state `LastReceiptNonce[(deal_id, file_path)]` (or equivalent) and reject any receipt with `nonce ≤ LastReceiptNonce[(deal_id, file_path)]` as a replay.
3.  **Book‑Keeping & Rewards:**
    *   The keeper computes the latency tier from inclusion height (Platinum/Gold/Silver/Fail) and updates `ProviderRewards`.
    *   It debits `Deal.EscrowBalance` for the bandwidth component and records a lightweight `Proof` summary:
        *   `commitment = "deal:<id>/epoch:<epoch>/tier:<tier>"`.
    *   `Proof` entries are exposed via `Query/ListProofs` (LCD: `/nilchain/nilchain/v1/proofs`) for dashboards and analytics.

In the current devnet, the CLI (`sign-retrieval-receipt` / `submit-retrieval-proof`) and the Web Gateway (`/gateway/fetch`, `/gateway/prove-retrieval`) MAY drive receipt/proof submission as a convenience “meta‑transaction” layer. Web downloads that do not trigger on‑chain receipts are **non‑normative** and expected to be phased out; the intended end state is that retrievals always produce verifiable on‑chain liveness evidence derived from NilFS (MDU #0 + on-disk slab) and the Deal’s on‑chain commitments.

#### 7.2.1 Bundled session receipts (Implemented, UX + throughput)

To reduce wallet prompts and on-chain TX count, NilStore supports a session-level receipt that commits to many served chunks at once.

* **Per-chunk leaf commitment (normative):**
  * `proof_hash := keccak256(encode(ChainedProof))`
  * `leaf_hash := keccak256(uint64_be(range_start) || uint64_be(range_len) || proof_hash)`
* **Chunk root:** `chunk_leaf_root` is the Merkle root over `leaf_hash[i]` ordered by increasing `(range_start, range_len)` using duplicate-last padding (including the 1-leaf case) and `keccak256(left||right)` internal nodes.
* **Session receipt:** the client signs a `DownloadSessionReceipt` committing to:
  * `{deal_id, epoch_id, provider, file_path, total_bytes, chunk_count, chunk_leaf_root, nonce, expires_at}`
* **On-chain submission:** a provider MAY submit a single on-chain message that carries:
  * the signed `DownloadSessionReceipt`, and
  * the `chunk_count` per-chunk `ChainedProof` objects plus Merkle membership paths showing each chunk’s `leaf_hash` is included in `chunk_leaf_root`.

This preserves fair exchange (the user signs only after receiving bytes) while reducing signature prompts from `O(chunks)` to ~1 per download completion.

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

### 7.6 Proof Demand Policy (Planned, Parameters TBD)

The protocol requires an explicit policy for **how often** providers must prove possession and **how retrieval receipts reduce synthetic proof demand**.

This spec intentionally does not lock constants yet, but the target shape is:
* For each epoch `e` and assignment `(deal_id, provider_id)`, compute a required proof quota `required_e(D,P)` as a function of (at minimum) deal size (`Deal.total_mdus` / `allocated_length`), `ServiceHint` (Hot/Cold), and recent receipt volume.
* **Receipt credits:** Valid user retrieval receipts contribute credits toward `required_e(D,P)`, potentially weighted by `bytes_served` with caps to prevent one large transfer from satisfying an entire epoch indefinitely.
* **Synthetic fill:** If `credits < required_e(D,P)`, the chain derives and enforces `required_e(D,P) - credits` synthetic challenges for that epoch.
* **Penalties:** Invalid proofs are slashable immediately; failure to meet quota SHOULD degrade reputation and eventually lead to eviction (a slower penalty path than invalid proof slashing).

The normative requirement is that `required_e(D,P)` and the synthetic challenge derivation are deterministic and computable from on-chain state plus epoch randomness `R_e`.

### 7.7 Deputy / Proxy Retrieval (Planned, Anti-griefing Semantics)

NilStore anticipates a “Deputy” (proxy) pattern where a provider may delegate *data-plane* serving (bandwidth, caching, egress) to an untrusted helper, while keeping *control-plane* accountability on the assigned Provider slot.

Normative intent:
* **Accountability remains with the assigned Provider:** rewards, liveness, and slashing attach to the on-chain provider assignment, not to deputies.
* **Client verification is mandatory:** clients MUST verify Merkle/KZG proof material before signing a `RetrievalReceipt`, preventing deputies from serving arbitrary bytes.
* **Anti-griefing:** retrieval requests and receipts MUST be replay-protected (nonce/expiry) and SHOULD be rate-limited / optionally funded, so a third party cannot force unbounded work on providers or deputies.

Detailed deputy selection, advertisement, and any explicit on-chain delegation/compensation mechanism is out of scope for v2.4 and should be specified in a dedicated RFC.

### 7.8 SP Audit Debt & Coverage Scaling (Planned)

To ensure coverage scales with total stored data—even when clients are dormant—NilStore MAY introduce **audit debt** as a source of retrieval-style challenges.

Conceptual shape:
1.  **Audit Debt Definition**
    *   For each epoch `e` and Provider `P`, compute an obligation proportional to stored bytes:
        * `audit_debt_bytes(P,e) = α * stored_bytes(P,e)` where `α` is a protocol parameter.
2.  **Task Assignment**
    *   Using `R_e`, the chain deterministically assigns `P` a set of retrieval tasks targeting other `(Deal, Provider')` pairs, aggregating to ≈ `audit_debt_bytes(P,e)`.
3.  **Execution & Incentives**
    *   `P` executes these audits as an ordinary client.
    *   Misbehavior (bad proofs, non‑response) discovered can be converted into fraud proofs or escalated challenges (with potential bounties).
4.  **Enforcement**
    *   Failure to satisfy audit debt SHOULD reduce placement priority and/or rewards until `P` catches up (distinct from invalid-proof slashing).

### 7.9 Health Metrics & Self‑Healing Placement (Planned)

Self‑healing can be expressed via per‑assignment and per‑provider health metrics:

1.  **Per‑Assignment Health**
    *   For each `(Deal, Provider)`, track a rolling `HealthState` (e.g., synthetic success ratio, retrieval success ratio, bad data rate, and non‑slashable QoS latency metrics).
2.  **Eviction & Re‑Replication**
    *   If `(Deal, Provider)` remains unhealthy long enough, the placement engine recruits replacements, adds them in a pending state, and only removes the old provider after the new provider proves readiness (make‑before‑break, §5.3).
3.  **Global Provider Health**
    *   Providers with consistently poor health lose eligibility for new placements and may be jailed/removed by governance.

---

## Appendix B: Intentionally Underspecified (v2.4) / RFC Targets

This specification defines normative *interfaces* and verification rules but intentionally leaves several “policy” and “parameterization” areas underspecified for v2.4. The following items SHOULD be captured as dedicated RFCs before mainnet hardening:

1. **System Placement Algorithm:** deterministic provider selection/weighting, hint scoring, anti-correlation rules, and upgrade strategy without reshuffling failure domains unexpectedly.
2. **Mode 2 On-Chain Encoding:** explicit representation of `(K, M)`, ordered `slot → provider` mapping, overlay scaling state, and replacement triggers/authorization.
3. **Challenge Derivation Function:** exact mapping from `(deal_id, epoch_e, provider/slot)` to a finite challenge set with anti-grind properties and coverage guarantees.
4. **Penalty & Eviction Curve:** concrete slashing parameters, reputation decay, jail/unjail, and eviction thresholds; distinguish invalid-proof slashing vs quota non-compliance.
5. **Pricing & Escrow Accounting:** bandwidth pricing model, debit schedule, tier reward curves, and how user-funded elasticity is bounded/enforced.
6. **Write Semantics Beyond Append-Only:** pending-generation promotion rules, rewrite/compaction/delete behavior, and any on-chain finalization criteria.
7. **Deputy/Proxy Mechanics:** discovery, routing, compensation/delegation (if any), and additional griefing defenses beyond nonce/expiry and rate limits.
8. **Encryption & Key Management Details:** exact encryption constructions, key derivation/rotation, metadata leakage model, padding strategy, and client recovery UX.
9. **Transport/Wire Protocol:** concrete fetch/prove message formats, range/chunking rules, retry/backoff, and gateway/SP interoperability requirements.

---

## Appendix C: Devnet Alpha Target Matrix (Non-normative Profile)

This appendix defines a pragmatic “Devnet Alpha” scope meant to get a **multi-provider network** running with **low expectations** and minimal protocol surface.

### C.1 Guiding constraints

* **Mode 1 only:** Devnet Alpha does not attempt Mode 2 RS striping, repair, or rebalancing.
* **No protocol-level Mode 1 replication:** Mode 1 is treated as a single-provider deal. If a user wants redundancy today, they do it out-of-band.
* **Serving provider is the prover:** bytes and proof material MUST come from the provider that will be named in receipts (or from an explicit deputy, once specified).
* **Endpoint discovery is on-chain:** providers advertise transport endpoints as Multiaddrs; HTTP is used initially, libp2p is future-compatible.

### C.2 Target matrix

| Capability | Devnet Alpha Target | Notes |
|---|---:|---|
| Multiple providers registered | MUST | ≥ 3 providers on the devnet |
| On-chain provider endpoint discovery | MUST | `Provider.endpoints[]` as Multiaddr strings |
| HTTP transport | MUST | e.g. `/dns4/sp1.example.com/tcp/8080/http` |
| libp2p transport | DEFER | Multiaddr format reserved (`/p2p/<peerid>`) |
| Mode 1 replication (`providers[]` length > 1) | NO | Devnet Alpha uses `replicas=1` in `ServiceHint` |
| Mode 2 RS deals | NO | Separate milestone |
| Gateway role | MUST | routes/proxies to the assigned provider; SHOULD not read local deal bytes |
| Provider role | MUST | stores deal slab; serves bytes+proof headers; owns fetch/download session state |
| Upload/ingest | MUST | upload directed to the assigned provider for the deal |
| Retrieval by `file_path` + `Range` | MUST | chunked retrievals; max chunk ≤ one blob (`BLOB_SIZE`) |
| Receipt submission | MUST | per-chunk receipts or session receipts; provider submits to chain |
| Bundled session receipts | SHOULD | reduce wallet prompts / tx count |
| Synthetic challenges | DEFER | no hard quotas; receipts are still accepted evidence |
| Deputy / proxy routing | DEFER | tracked as an RFC / later sprint |
| Repair / rotation / rebalancing | NO | deferred to Mode 2 + deputy + policy |
| Docker/devnet orchestration | SHOULD | compose scripts to run 1 gateway + N providers |

### C.3 Definition of Done (Devnet Alpha)

Given 3–5 providers with advertised HTTP Multiaddrs:
1. Create a deal with `replicas=1`.
2. Upload content to the assigned provider and commit `Deal.manifest_root`.
3. Fetch a multi-chunk range through the gateway/router from that provider.
4. Submit a bundled session receipt (or batched receipts) and observe `MsgProveLiveness` succeed on-chain.
