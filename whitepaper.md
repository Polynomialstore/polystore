# NilStore Network: A Protocol for Decentralized, Verifiable, and Economically Efficient Storage

**(White Paper v2.3 - Dynamic Optimization)**

**Date:** 2025-12-04
**Authors:** NilStore Core Team

## Abstract

NilStore is a decentralized storage network that unifies storage and retrieval into a single **Demand-Driven Performance Market**. By treating user retrievals as valid storage proofs (**Unified Liveness**), the protocol eliminates wasted work. For cold data, the system acts as the "User of Last Resort." Placement is **System-Defined** but **Hint-Aware**, allowing users to signal "Hot" or "Cold" intent to optimize initial node selection (Archive vs Edge) while maintaining anti-Sybil guarantees.

## 1\. Introduction

### 1.1 The "Double-Pay" Problem

Legacy networks treat "Storage" (proving you have data) and "Retrieval" (sending data) as separate jobs. This is inefficient. NilStore unifies them.

### 1.2 Key Innovations

  * **Unified Liveness:** A user downloading a file *is* the storage audit.
  * **Synthetic Challenges:** The network automatically audits files that users aren't currently reading.
  * **Performance Market:** Rewards are based on speed (Platinum/Gold/Silver).
  * **Hint-Aware Placement:** Deterministic assignment respects user intent (Hot/Cold) to pair files with the right class of hardware.

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

---

## 3. The Performance Market (Tiered Rewards)

Time is Money.

| Tier | Response Time | Reward |
| :--- | :--- | :--- |
| **Platinum** | 1 Block (~5s) | **100%** |
| **Gold** | 5 Blocks (~25s) | **80%** |
| **Silver** | 10 Blocks (~50s) | **50%** |
| **Fail** | > 20 Blocks | **Slashing** |

---

## 4. The Lifecycle of a File

### Step 1: Ingestion & Placement
1.  **Deal Creation:** User submits `MsgCreateDeal(Hint: "Hot")`.
2.  **Filtering:** Chain filters for "General" and "Edge" providers.
3.  **Assignment:** Chain deterministically assigns 12 SPs from the filtered set.
4.  **Upload:** User uploads data.

### Step 2: The Liveness Loop
*   **Scenario 1 (Viral):** Users swarm the file. SPs submit user receipts.
*   **Scenario 2 (Archive):** File sits idle. Chain issues Beacon challenges.

### Step 3: Auto-Scaling (Dynamic Overlays)
*   If a "Cold" file suddenly goes viral and its "Archive" nodes struggle (dropping to Silver tier), the protocol triggers **System Placement** to recruit temporary **Hot Replicas** from the Edge pool to absorb the load.

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
3.  **Phase 3:** Implementation of **Deal Object**, **Provider Capabilities**, and **System Placement**.
