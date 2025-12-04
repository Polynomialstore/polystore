# NilStore Core v 2.3

### Cryptographic Primitives & Proof System Specification

---

## Abstract

NilStore is a decentralized storage network that unifies **Storage** and **Retrieval** into a single **Demand-Driven Performance Market**. Instead of treating storage audits and user retrievals as separate events, NilStore implements a **Unified Liveness Protocol**: user retrievals *are* storage proofs.

It specifies:
1.  **Unified Liveness:** Organic user retrieval receipts act as valid storage proofs.
2.  **Synthetic Challenges:** The system acts as the "User of Last Resort" for cold data.
3.  **Tiered Rewards:** Storage rewards are tiered by latency, regardless of whether the trigger was Organic or Synthetic.
4.  **System-Defined Placement:** Deterministic assignment to ensure diversity, optimized by **Service Hints**.

---

## § 6 Product-Aligned Economics

### 6.0 System-Defined Placement (Anti-Sybil & Hints)

To prevent "Self-Dealing," clients cannot choose their SPs. However, to optimize performance, the selection algorithm respects **Service Hints**.

#### 6.0.1 Provider Capabilities
When registering, SPs declare their intended service mode via `MsgRegisterProvider(Capabilities)`:
*   **Archive:** High capacity, standard latency. Optimized for long-term persistence.
*   **General (Default):** Balanced storage and bandwidth.
*   **Edge:** Low capacity, ultra-low latency. Optimized for caching and burst traffic.

#### 6.0.2 Deal Hints
`MsgCreateDeal` includes a `ServiceHint`:
*   **Cold:** Protocol biases selection towards `Archive` and `General` nodes. (Lower Escrow Cost).
*   **Hot:** Protocol biases selection towards `General` and `Edge` nodes. (Higher Escrow Cost).

#### 6.0.3 Selection Algorithm
`Idx_i = Hash(DealID || BlockHash || i) % AP_List.Length`
*   *Filter:* The `AP_List` is pre-filtered to include only nodes matching the `ServiceHint`.
*   *Fallback:* If insufficient matching nodes exist, the protocol expands the filter to include `General` nodes.

### 6.1 The Unified Market

*   **Storage Income:** Earned by satisfying liveness (via Path A or Path B).
*   **Bandwidth Income:** Earned ONLY via Path A (User Receipts).
*   **Incentive Alignment:** "Hot" files are more profitable (Double Income). "Cold" files pay only Storage Income. This naturally aligns SPs to desire popular content and optimize for retrieval speed.

### 6.2 Auto-Scaling (Dynamic Overlays)

Even with Hints, demand can change.
*   **Trigger:** If `ServedBytes` for a DU exceeds the capacity of its `Base` nodes (e.g., latency degrades to Silver/Gold).
*   **Action:** The protocol triggers **System Placement** to recruit temporary **Hot Replicas** from the `Edge` pool.
*   **Result:** Traffic shifts to the Overlay Layer. Base nodes revert to simple Storage Rewards.
