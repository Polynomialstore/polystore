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
*   **CID:** Content Identifier.
*   **Placement:** System-assigned SP list.
*   **Escrow:** Combined Storage + Bandwidth balance.
*   **ServiceHint:** `Hot | Cold`.
*   **Replication:**
    *   `Base`: Fixed (e.g., 12).
    *   `Current`: Dynamic (e.g., 15).
    *   `Max`: User-Defined Cap (e.g., 50).
*   **Budget:** `MaxMonthlySpend`.

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
*   **Signal:** `MsgSignalSaturation`.
*   **Logic:** `If (GoodStanding && HighTraffic && BudgetAvailable) { SpawnReplica() }`.
*   **Rotation:** `MsgRotateShard` (Voluntary Downgrade) incurs `RebalancingFee`.

## 5. Implementation Gaps

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