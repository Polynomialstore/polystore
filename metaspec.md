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
        *   `deal_id`, `epoch_id`, `provider`, `bytes_served`, `KzgProof`, and `user_signature`.
*   **On‑Chain Flow:**
    *   Providers submit receipts via `MsgProveLiveness{ ProofType = UserReceipt }`.
    *   The keeper verifies:
        *   Provider ∈ `Deal.providers[]`.
        *   KZG proof is valid (trusted setup + Merkle path).
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
