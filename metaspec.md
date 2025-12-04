# NilStore Meta-Specification (v2.0)

**Target:** System-Defined Placement & Performance Market

## 1. Overview

This meta-spec defines the architectural pivot from a "physics-policed" network to a "market-incentivized" one. The core change is the introduction of **Block-Tiered Rewards** to measure performance and **System-Defined Placement** to guarantee diversity.

### 1.1 Core Tenets

1.  **Diversity is enforced by the System.** Clients do not choose providers. The chain chooses.
2.  **Speed is incentivized by the Market.** Faster proofs earn more. Slower proofs (S3 Glacier) earn nothing.
3.  **Challenges are derived from Entropy.** Users cannot game the verification.

---

## 2. The Deal Object

The `Deal` is the central state object.

*   **ID:** Unique uint64.
*   **CID:** Content Identifier (Root).
*   **Placement:** Deterministically assigned list of SPs.
*   **Escrow:** $STOR balance.

## 3. Placement Algorithm

**Function:** `AssignProviders(DealID, BlockHash, ActiveSet)`

1.  **Seed:** `S = Hash(DealID + BlockHash)`.
2.  **Selection:**
    ```python
    Selected = []
    while len(Selected) < 12:
        S = Hash(S)
        Candidate = ActiveSet[ S % len(ActiveSet) ]
        if IsDiverse(Candidate, Selected):
            Selected.append(Candidate)
    ```
3.  **Diversity Rule:** No two providers in `Selected` may share an ASN or /24 Subnet.

## 4. Verification & Economics

### 4.1 The Performance Tiering

*   **Platinum (H+1):** 100% Reward.
*   **Gold (H+5):** 80% Reward.
*   **Silver (H+10):** 50% Reward.
*   **Fail (>H+20):** Slash.

This replaces the previous "1.1s Argon2id" hard requirement.

### 4.2 Challenge Derivation

*   `Z = Hash(EpochBeacon + DealID + ProviderAddress)`
*   `EpochBeacon` is generated every 100 blocks via BLS-VRF.

---

## 5. Implementation Gaps (To Be Built)

1.  **L1 Chain:** Implement `MsgCreateDeal` and the `ActiveProviderList` keeper.
2.  **L1 Chain:** Implement the deterministic placement logic in Go.
3.  **L1 Chain:** Update `EndBlocker` to check for expired proofs and apply tiered rewards.
4.  **Client SDK:** Update to listen for `DealCreated` events to know where to upload data.