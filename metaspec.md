# NilStore Meta-Specification (v2.3)

**Target:** Unified Liveness Protocol & Performance Market & Service Hints

## 1. Overview

This meta-spec defines the architecture for NilStore v2.3, adding **Service Hints** to the placement logic.

### 1.1 Core Tenets

1.  **Retrieval IS Storage.** A verified user retrieval acts as a storage proof.
2.  **The System is the User of Last Resort.** If no humans ask for the data, the chain asks for it.
3.  **Optimization via Hints.** Users hint at their needs (Hot/Cold); the System optimizes placement without giving up control.

---

## 2. The Deal Object

The `Deal` is the central state object.

*   **ID:** Unique uint64.
*   **CID:** Content Identifier.
*   **Placement:** System-assigned SP list.
*   **Escrow:** Combined Storage + Bandwidth balance.
*   **ServiceHint:** `Hot | Cold`.

## 3. Placement Algorithm

**Function:** `AssignProviders(DealID, BlockHash, ActiveSet, Hint)`

1.  **Filter:** `CandidateSet = ActiveSet.Filter(Hint)`.
2.  **Seed:** `S = Hash(DealID + BlockHash)`.
3.  **Selection:** Deterministic sampling from `CandidateSet`.
4.  **Diversity:** Enforce distinct ASN/Subnet rules.

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

1.  **L1 Chain:** `MsgCreateDeal` with `ServiceHint`.
2.  **L1 Chain:** `MsgRegisterProvider` with `Capabilities`.
3.  **L1 Chain:** Placement Logic & Diversity Keepers.
4.  **SDK:** Receipt generation must include KZG elements.
