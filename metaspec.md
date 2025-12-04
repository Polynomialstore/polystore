# NilStore Meta-Specification (v2.1)

**Target:** System-Defined Placement & Performance Market & Retrieval Economy

## 1. Overview

This meta-spec defines the architecture for NilStore v2.1.

### 1.1 Core Tenets

1.  **Diversity is enforced by the System.** Clients do not choose providers.
2.  **Speed is incentivized by the Market.** Faster proofs earn more.
3.  **Retrieval is User-Centric.** Users pay, control keys, and define quotas.

---

## 2. The Deal Object

The `Deal` is the central state object.

*   **ID:** Unique uint64.
*   **CID:** Content Identifier.
*   **Placement:** System-assigned SP list.
*   **Escrow:** Combined Storage + Bandwidth balance.
*   **Quotas:** `PrepaidBandwidth`, `MaxMonthlySpend`.

## 3. Placement Algorithm

**Function:** `AssignProviders(DealID, BlockHash, ActiveSet)`

1.  **Seed:** `S = Hash(DealID + BlockHash)`.
2.  **Selection:** Deterministic sampling from `ActiveSet`.
3.  **Diversity:** Enforce distinct ASN/Subnet rules.

## 4. Verification & Economics

### 4.1 Performance Tiering (Storage)
*   **Platinum (H+1):** 100%
*   **Fail (>H+20):** Slash

### 4.2 Retrieval Verification (Bandwidth)
*   **Receipts:** Signed by User.
*   **Submission:** Aggregated Merkle Root.
*   **Sampling:** `Probability = Base / (1 + log(TotalBytes))`. Decays with volume.

## 5. Implementation Gaps

1.  **L1 Chain:** `MsgCreateDeal` (Storage).
2.  **L1 Chain:** `MsgClaimBandwidth` (Retrieval).
3.  **L1 Chain:** Placement Logic & Diversity Keepers.
4.  **SDK:** Receipt signing & Edge Node decryption logic.
