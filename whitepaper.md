# NilStore Network: A Protocol for Decentralized, Verifiable, and Economically Efficient Storage

**(White Paper v2.2 - Unified Liveness)**

**Date:** 2025-12-04
**Authors:** NilStore Core Team

## Abstract

NilStore is a decentralized storage network that unifies storage and retrieval into a single **Demand-Driven Performance Market**. By treating user retrievals as valid storage proofs (**Unified Liveness**), the protocol eliminates wasted work: popular data audits itself. For cold data, the system acts as the "User of Last Resort," ensuring liveness via synthetic challenges. Rewards are tiered based on **Block-Height Latency**, incentivizing high-performance hardware over slow cloud archives.

## 1\. Introduction

### 1.1 The "Double-Pay" Problem

Legacy networks treat "Storage" (proving you have data) and "Retrieval" (sending data) as separate jobs. This is inefficient. NilStore unifies them.

### 1.2 Key Innovations

  * **Unified Liveness:** A user downloading a file *is* the storage audit.
  * **Synthetic Challenges:** The network automatically audits files that users aren't currently reading.
  * **Performance Market:** Rewards are based on speed (Platinum/Gold/Silver). S3 Glacier earns zero.
  * **System-Defined Placement:** Deterministic assignment prevents Sybil attacks.

---

## 2. The Unified Liveness Protocol

### 2.1 Hot Data (Path A)
1.  **User Request:** "I need chunk #50."
2.  **Service:** SP sends data + KZG Proof.
3.  **Receipt:** User signs the receipt.
4.  **Consensus:** SP submits the receipt to the chain.
5.  **Result:** SP earns **Storage Reward** (for proving liveness) AND **Bandwidth Fee** (for serving user).

### 2.2 Cold Data (Path B)
1.  **System Silence:** No user asks for data.
2.  **Beacon Challenge:** Chain issues "I need chunk #50" (Pseudo-random).
3.  **Service:** SP computes KZG Proof.
4.  **Consensus:** SP submits proof to chain.
5.  **Result:** SP earns **Storage Reward** (for proving liveness).

### 2.3 The Outcome
*   **Efficiency:** For popular files, 100% of the "Work" is useful data transfer. Zero cycles wasted on artificial audits.
*   **Incentives:** SPs want "Hot" data because it pays double (Storage + Bandwidth).

---

## 3. The Performance Market (Tiered Rewards)

Time is Money.

| Tier | Response Time | Reward |
| :--- | :--- | :--- |
| **Platinum** | 1 Block (~5s) | **100%** |
| **Gold** | 5 Blocks (~25s) | **80%** |
| **Silver** | 10 Blocks (~50s) | **50%** |
| **Fail** | > 20 Blocks | **Slashing** |

*   **S3 Standard:** Likely Gold/Silver.
*   **S3 Glacier:** Guaranteed Fail.
*   **Local NVMe:** Guaranteed Platinum.

---

## 4. The Lifecycle of a File

### Step 1: Ingestion & Placement
1.  **Deal Creation:** User submits `MsgCreateDeal`.
2.  **System Assignment:** Chain deterministically assigns 12 SPs.
3.  **Upload:** User uploads data.

### Step 2: The Liveness Loop
*   **Scenario 1 (Viral):** Users swarm the file. SPs submit user receipts. Chain verifies signature + KZG. SPs get rich.
*   **Scenario 2 (Archive):** File sits idle. Chain issues Beacon challenges. SPs submit proofs. SPs get base pay.

### Step 3: Auto-Scaling
*   If **Path A** activity exceeds a threshold, the Chain triggers **System Placement** to recruit more Platinum SPs to handle the load.

---

## 5. Security Analysis

| Threat | Mitigation |
| :--- | :--- |
| **Sybil Attack** | **System-Defined Placement.** |
| **Fake Traffic** | **Signed Receipts.** SP needs user signatures to claim bandwidth fees. |
| **Lazy Provider** | **Tiered Rewards.** Slow providers earn fraction of rewards. |
| **Dead Data** | **System Challenges.** Cold data is audited as rigorously as hot data. |

---

## 6. Roadmap

1.  **Phase 1:** Core Crypto & CLI (Completed).
2.  **Phase 2:** Local Testnet & Specs (Completed).
3.  **Phase 3:** Implementation of **Unified Liveness Message** (`MsgProveLiveness`) and **System Placement**.