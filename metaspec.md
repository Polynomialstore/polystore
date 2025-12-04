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

1.  **L1 Chain:** `MsgCreateDeal` with Hints & Caps.
2.  **L1 Chain:** `MsgSignalSaturation` & `MsgRotateShard`.
3.  **L1 Chain:** Dynamic Replication Logic (`Current` vs `Base`).
4.  **SDK:** Receipt generation must include KZG elements.