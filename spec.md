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

### 6.2 Auto-Scaling (Dynamic Overlays)

Even without signals, the chain protects performance.
*   **Trigger:** If `ServedBytes` for a DU exceeds the capacity of its `Base` nodes (e.g., latency degrades to Silver/Gold).
*   **Action:** The protocol triggers **System Placement** to recruit temporary **Hot Replicas** from the `Edge` pool.
*   **Result:** Traffic shifts to the Overlay Layer. Base nodes revert to simple Storage Rewards.