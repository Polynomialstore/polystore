# NilStore Meta-Specification (v2.2)

**Target:** Unified Liveness Protocol & Performance Market

## 1. Overview

This meta-spec defines the architecture for NilStore v2.2, merging the "Storage" and "Retrieval" markets into a single **Unified Liveness** flow.

### 1.1 Core Tenets

1.  **Retrieval IS Storage.** A verified user retrieval acts as a storage proof.
2.  **The System is the User of Last Resort.** If no humans ask for the data, the chain asks for it.
3.  **Speed is Value.** Faster responses earn more, regardless of who asked.

---

## 2. The Deal Object

The `Deal` is the central state object.

*   **ID:** Unique uint64.
*   **CID:** Content Identifier.
*   **Placement:** System-assigned SP list.
*   **Escrow:** Combined Storage + Bandwidth balance.

## 3. The Unified Proof

One message type covers both organic and synthetic activity.

```protobuf
message MsgProveLiveness {
  uint64 deal_id = 1;
  uint64 epoch_id = 2;
  oneof proof_type {
    RetrievalReceipt user_receipt = 3;  // Path A (Hot)
    KzgProof system_proof = 4;          // Path B (Cold)
  }
}
```

## 4. Economics

### 4.1 Tiered Storage Rewards
Paid from `Deal.Escrow` to SP for **Liveness**.
*   **Platinum (H+1):** 100%
*   **Gold (H+5):** 80%
*   **Fail (>H+20):** 0% + Slash

### 4.2 Bandwidth Payments
Paid from `Deal.Escrow` to SP for **Traffic**.
*   **Condition:** `proof_type == user_receipt`.
*   **Amount:** `Bytes * BaseFee`.

## 5. Implementation Gaps

1.  **L1 Chain:** `MsgProveLiveness` handling both types.
2.  **L1 Chain:** Logic to distinguish Organic vs Synthetic for Bandwidth Payouts.
3.  **L1 Chain:** Deterministic Placement.
4.  **SDK:** Receipt generation must include KZG elements.