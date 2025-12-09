# NilStore Meta-Specification (v2.4)

**Target:** Unified Liveness Protocol & Performance Market & Service Hints & Elasticity

## 1. Overview

This meta-spec defines the architecture for NilStore v2.4, adding **Traffic Management** and **User-Funded Elasticity**.

### 1.1 Core Tenets

1.  **Retrieval IS Storage.**
2.  **The System is the User of Last Resort.**
3.  **Optimization via Hints.**
4.  **Elasticity is User-Funded.** You get the bandwidth (and replication) you pay for.

---

## 2. The Deal Object

The `Deal` is the central state object.

*   **ID:** Unique uint64.
*   **CID:** Content Identifier (Root).
*   **Placement:** System-assigned SP list.
*   **Escrow:** Combined Storage + Bandwidth balance.
*   **ServiceHint:** `Hot | Cold`.
*   **Replication (Redundancy Modes):**
    *   **Mode 1 – FullReplica (Implemented):**
        *   `Base`: Target replica count for full copies of the file (e.g., 12 Providers per Deal).
        *   `Current`: Dynamic number of full replicas (e.g., 1 to 24), tracked on-chain as `Deal.CurrentReplication`.
    *   **Mode 2 – StripeReplica (Planned):**
        *   `Base`: Fixed stripe width (e.g., 12 for RS(12,8)).
        *   `Current`: Number of overlay stripes currently allocated across shard indices.
        *   `Max`: User-Defined Cap (e.g., 50 stripes or equivalent replica budget).
*   **Budget:** `MaxMonthlySpend`.
*   **MDU Size:** 8 MiB (8,388,608 bytes).
*   **Shard Size:** 1 MiB (1,048,576 bytes).

## 3. Placement Algorithm

**Function:** `AssignProviders(DealID, BlockHash, ActiveSet, Hint)`

1.  **Filter:** `CandidateSet = ActiveSet.Filter(Hint)`.
2.  **Seed:** `S = Hash(DealID + BlockHash)`.
3.  **Selection:** Deterministic sampling from `CandidateSet`.
4.  **Diversity:** Enforce distinct ASN/Subnet rules.

## 4. Economics & Flow Control

### 4.1 Tiered Storage Rewards
*   **Platinum (H+1):** 100%
*   **Gold (H+5):** 80%
*   **Fail (>H+20):** 0% + Slash

### 4.2 Saturation & Scaling
*(Further details on measuring and utilizing dynamic demand ("Heat") are specified in [RFC: Heat & Dynamic Placement for Mode 1](rfcs/rfc-heat-and-dynamic-placement.md).)*
*   **Signal:** `MsgSignalSaturation` or Protocol-Detected High Load (EMA).
*   **Strategy (Mode 2 – Planned):** **Stripe-Aligned Scaling.** When increasing replication, add `n` new Overlay Providers simultaneously, each hosting a replica of a distinct shard index.
*   **Mode 1 Approximation (Current Implementation):** `MsgSignalSaturation` increases `Deal.CurrentReplication` and appends additional providers to `Deal.providers[]`. Each new provider is expected to store a full copy of the file, so elasticity is expressed as “more full replicas” rather than per-stripe overlays.
*   **Damping:** Use Hysteresis (80% Up / 30% Down) based on EMA of `ReceiptVolume`.
*   **Gravity:** Enforce **Minimum TTL** (e.g., 24h) on new Overlay Replicas.

### 4.3 Rotation
*   `MsgRotateShard` (Voluntary Downgrade) incurs `RebalancingFee`.

## 5. Implementation Gaps

This section tracks implementation details specific to the current **Mode 1 – FullReplica** devnet.

### 5.1 Retrieval Receipts (Mode 1 Path)

*   **Client‑Side Flow:**
    *   Users fetch encrypted MDUs from a single assigned Provider (HTTP/S3 gateway or P2P).
    *   After verifying the KZG proof for the served chunk, the Data Owner constructs a `RetrievalReceipt` containing:
        *   `deal_id`, `epoch_id`, `provider`, `bytes_served`, `nonce`, `expires_at`, `proof_details` (ChainedProof), and `user_signature`.
        *   `nonce` is a strictly increasing counter scoped to the Deal Owner (or payer). `expires_at` bounds the receipt’s validity in time or blocks.
*   **On‑Chain Flow:**
    *   Providers submit receipts via `MsgProveLiveness{ ProofType = UserReceipt }`.
    *   The keeper verifies:
        *   Provider ∈ `Deal.providers[]`.
        *   `expires_at` has not passed.
        *   `nonce` is strictly greater than the last accepted nonce for this owner (or payer), using persistent state (e.g. `LastReceiptNonce[owner_address]`).
        *   `proof_details` (ChainedProof) successfully opens the `Deal.manifest_root` (3-hop verification: Manifest -> MDU -> Blob -> Data).
        *   `user_signature` corresponds to the Deal Owner’s account (prevents SP‑only self‑dealing).
    *   Rewards and observability:
        *   Storage reward is computed with an inflationary decay schedule and latency‑tier multiplier.
        *   Bandwidth payment is debited from `Deal.EscrowBalance`.
        *   A compact `Proof` record is appended for UI consumption (`commitment = "deal:<id>/epoch:<epoch>/tier:<tier>"`).

In this phase, retrieval receipts are primarily driven by CLI tooling. Web‑based downloads are treated as an auxiliary path until user‑signed EVM→Cosmos flows are available.

## 6. System Constraints & Meta-Risks

This section documents accepted architectural risks and necessary safeguards.

### 6.1 The "Cold Start" Fragility
*   **Risk:** System-Defined Placement assumes a large, diverse `ActiveProviderList`. When `N` is small (Testnet), diversity rules (distinct ASN) may be impossible to satisfy, causing placement failures.
*   **Safeguard:** The chain MUST support a **Bootstrap Mode** (governance-gated) that relaxes diversity constraints until `N > Threshold`.

### 6.2 The "Viral Debt" Risk
*   **Risk:** User-Funded Elasticity creates a hard stop. If a creator runs out of escrow during a viral event, the content throttles.
*   **Assessment:** This is a valid economic state ("You get what you pay for"). However, to improve UX, the Protocol SHOULD support **Third-Party Sponsorship** (`MsgFundEscrow`) to allow communities to rescue vital content.

### 6.3 Data Gravity & Non-Atomic Migration
*   **Risk:** Moving data takes time. When an SP is rotated (due to saturation or failure), there is a latency gap before the new SP is ready.
*   **Safeguard:** Migration MUST be **Overlapping**. The Old SP is not released (unbonded) until the New SP submits their first valid **Platinum** proof. During this transition, `ReplicaCount` effectively increases by 1.

### 6.4 Economic Sybil Assumption
*   **Risk:** Unified Liveness allows SPs to "self-audit" by generating fake traffic.
*   **Safeguard:**
    1.  **Signatures:** A valid `RetrievalReceipt` requires a signature from the **Data Owner**. An SP cannot forge this.
    2.  **Encryption:** Data is stored as ciphertext. An SP cannot effectively "use" the data to mimic real user behavior.
    3.  **Burn Rate:** The `BurnRate > 0` ensures that even if an SP colludes with a Data Owner, wash-trading costs money.

## 7. Retrievability, Auditing, and Self‑Healing
*(This section, particularly concerning Audit Debt and the core mechanisms of retrievability validation and self-healing, is elaborated upon in [RFC: Retrieval Validation & The Deputy System](rfcs/rfc-retrieval-validation.md).)*

This section captures the long‑term Mode 1 mainnet design for retrievability and SP accountability. It is informed by `retrievability-memo.md` and the Mode 1 challenge/receipt design, and acts as the north‑star for devnet/testnet evolution.

### 7.1 Core Invariants

NilStore’s retrieval system is designed to satisfy two invariants:

1.  **Retrievability / Accountability**
    *   For every `(Deal, Provider)` assignment, either:
        *   The encrypted data is reliably retrievable under the protocol’s rules (within defined latency and timeout bounds), **or**
        *   There exists high‑probability, verifiable evidence of SP failure that can be used to punish the Provider and ultimately remove them from the replica set.
2.  **Self‑Healing Placement**
    *   Persistently underperforming or malicious Providers MUST be automatically:
        *   Detected via health metrics,
        *   Slashed or de‑rewarded according to clear rules, and
        *   Evicted from the Deal’s provider set and replaced by healthier Providers.

All concrete mechanisms (synthetic challenges, retrieval receipts, SP audit debt, onion routing, etc.) are evaluated by how well they help maintain these two invariants over time.

### 7.2 Challenge Families

To support the invariants, the protocol uses three challenge families, all ultimately binding back to the Deal’s on‑chain commitments:

1.  **Synthetic Storage Challenges (System‑Driven)**
    *   For each epoch `e` and `(Deal, Provider)`, the chain derives a finite set `S_e(D,P)` of `(mdu_index, blob_index)` pairs from the randomness beacon `R_e`.
    *   Providers that wish to earn storage reward for epoch `e` MUST satisfy a sufficient fraction of these challenges by submitting valid KZG/Merkle openings (either directly or via retrieval receipts).
2.  **Retrieval Liveness Challenges (Client / Auditor‑Driven)**
    *   Normal user reads, SP‑initiated audits (audit debt), and third‑party watchers all issue **retrieval challenges** using the Mode 1 retrieval protocol.
    *   Every retrieval includes exactly one deterministic KZG checkpoint derived from `(R_e, deal_id, channel_id, session_nonce, offset, length)`, so any retrieval can potentially serve as a storage proof.
    *   The scheduler’s goal is to ensure that, over time, each `(Deal, Provider)` receives enough retrieval‑style challenges to build a robust picture of liveness.
3.  **Escalated On‑Chain Challenges (Panic Mode)**
    *   In rare “very sad” cases, watchers MAY post explicit on‑chain challenges that force a Provider to respond with a specific synthetic proof within a fixed block window.
    *   Non‑response within this window is treated as hard evidence of unavailability and MUST carry strong slashing penalties.

Devnet/testnet deployments MAY implement only a subset of these (e.g., retrieval receipts without synthetic scheduling), but should evolve toward this three‑tier model.

### 7.3 Evidence Model & Slashing (Triple Proof Architecture)

Evidence is always interpreted relative to a specific `(deal_id, provider_id, epoch_e, mdu_index, blob_index)` and the Deal’s commitments. To ensure scalability, NilStore uses a **Triple Proof** architecture (normatively defined in `spec.md` § 7.3) that chains verification from the Deal Root down to the specific Data Byte.

1.  **Chained Storage Proofs**
    *   Any proof of possession (whether synthetic or retrieval-based) MUST provide a `ChainedProof` that satisfies the 3-hop verification:
        *   **Hop 1 (Identity):** Authenticates the MDU Merkle Root against the Deal's Manifest Root (KZG).
        *   **Hop 2 (Structure):** Authenticates the Blob Commitment against the MDU Merkle Root (Merkle).
        *   **Hop 3 (Data):** Authenticates the Data Byte against the Blob Commitment (KZG).
2.  **Retrieval‑Based Proofs**
    *   User or auditor retrievals that produce a valid `RetrievalReceipt` can be submitted as on‑chain `RetrievalProof`s.
    *   The receipt MUST contain the full `ChainedProof` required to traverse the 3 hops.
    *   When the derived checkpoint lies in `S_e(D,P)` and verification succeeds, the retrieval also satisfies a synthetic challenge.
3.  **Fraud Proofs (Wrong Data)**
    *   If a retrieval response fails verification at any of the 3 hops (e.g., MDU Root doesn't match Manifest, or Data Byte doesn't match Blob), the client can submit a `FraudProof`.
    *   A confirmed fraud proof MUST result in slashing for the implicated `(Deal, Provider)` and a sharp degradation of that Provider’s global health.
4.  **Non‑Response Evidence**
    *   Failure to answer an explicit on‑chain challenge, or a sustained pattern of missed synthetic/retrieval challenges, is treated as evidence of unavailability.
    *   Non‑response can justify both slashing (when formal on‑chain challenges are used) and eviction (via health thresholds).

The meta‑rule is: **only cryptographically verifiable or protocol‑observable behavior** (not mere gossip or reputation) can trigger slashing. Soft metrics (latency percentiles, UX complaints) feed into health scoring and placement, not direct slashing.

### 7.4 SP Audit Debt & Coverage Scaling

To ensure coverage scales with total stored data—even when clients are dormant—NilStore introduces **SP audit debt**:

1.  **Audit Debt Definition**
    *   For each epoch `e` and Provider `P`, the protocol computes:

        ```text
        stored_bytes(P, e) = sum over Deals D where P ∈ providers(D) of file_size(D)
        audit_factor α      = protocol parameter (e.g. 1/10,000 .. 1/1,000)
        audit_debt(P, e)   = α * stored_bytes(P, e)
        ```

    *   Units: bytes that `P` must retrieve from *other* Providers as a “mystery shopper.”
2.  **Task Assignment**
    *   Using `R_e`, the chain deterministically assigns `P` a set of audit tasks targeting other `(Deal, Provider')` pairs where `Provider' ≠ P`.
    *   Aggregate requested bytes across assigned tasks ≈ `audit_debt(P, e)`.
3.  **Execution & Incentives**
    *   `P` executes these audits as an ordinary client using delegated capabilities or protocol‑funded channels.
    *   Correct responses from `Provider'` improve `Provider'`’s health and may earn small audit rewards for `P`.
    *   Misbehavior (bad proofs, non‑response) discovered by `P` can be turned into fraud proofs or escalated challenges, earning whistleblower bounties.
4.  **Enforcement**
    *   The protocol tracks `completed_audit_bytes(P, e)` and defines an `audit_ok(P, e)` predicate (e.g. completion ≥ β·`audit_debt(P,e)`).
    *   Failure to satisfy audit debt leads to reduced storage rewards, diminished placement priority, or other economic penalties until `P` catches up.

This design ensures that as the network’s total stored bytes grow, so does the aggregate volume of retrieval‑style audits, independent of end‑user activity.

### 7.5 Health Metrics & Self‑Healing Placement

Self‑healing is implemented via per‑(Deal, Provider) and per‑Provider health metrics:

1.  **Per‑Assignment Health**
    *   For each `(D,P)`, the protocol maintains a `HealthState` over a rolling window of epochs, including:
        *   `storage_ok_ratio` — fraction of synthetic/storage challenges satisfied.
        *   `retrieval_success_ratio` — fraction of valid retrieval challenges that succeeded.
        *   `bad_data_rate` — fraction of challenges resulting in confirmed fraud proofs.
        *   `qos_latency_score` — smoothed latency metrics (non‑slashable, but used for ranking/placement).
    *   Thresholds `T_storage`, `T_retrieval`, `T_bad_data`, and `T_qos` classify assignments as **Healthy**, **Degraded**, or **Unhealthy**.
2.  **Eviction & Re‑Replication**
    *   When `(D,P)` is Unhealthy for long enough or in a sufficiently severe way:
        *   The placement engine recruits replacement Providers `P_new` via the existing system‑defined placement algorithm.
        *   Data is replicated to `P_new` from other replicas or the deal owner.
        *   Once `P_new` passes initial synthetic/retrieval checks, `P` is removed from `providers(D)` and ceases to earn reward on that Deal.
3.  **Global Provider Health**
    *   Aggregating over all Deals, Providers with consistently poor health:
        *   Lose eligibility for new placements,
        *   May have maximum storage caps reduced,
        *   Can eventually be jailed or removed from the active set via governance.

Devnet/testnet implementations MAY initially approximate health with simpler indicators (e.g. “last successful proof height” per `(D,P)`), but MUST converge toward a HealthState‑based, self‑healing placement policy for mainnet.
