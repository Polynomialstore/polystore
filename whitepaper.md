# NilStore Network: A Protocol for Decentralized, Verifiable, and Economically Efficient Storage

**(White Paper v2.0 - Performance Market Edition)**

**Date:** 2025-12-04
**Authors:** NilStore Core Team

## Abstract

NilStore is a decentralized storage network designed to provide high-throughput, verifiable data storage. Unlike legacy protocols that rely on hardware-intensive "Sealing" or fragile timing checks, NilStore introduces a **Performance Market**: a tiered reward system that incentivizes providers to store data on high-performance, local media (NVMe/SSD) by paying premium rewards for fast proof inclusion (Block H+1). Combined with **System-Defined Placement** (deterministic slotting) and **Chain-Derived Challenges**, NilStore eliminates Sybil attacks and "Lazy Provider" vampirism while maintaining a permissionless, commodity-hardware friendly ecosystem.

## 1\. Introduction

### 1.1 Motivation

Decentralized storage promises resilience, but often suffers from two extremes:
1.  **Centralization:** High hardware requirements (GPUs for sealing) limit participation to data centers.
2.  **Vampirism:** "Lazy" providers simply proxy data to Amazon S3, undermining the network's redundancy goals.

NilStore solves this via **Incentive Design**, not "Physics Police." By tying rewards directly to **Inclusion Latency** (how many blocks it takes to respond to a challenge), we create a market where genuine, high-performance providers naturally out-compete slow S3 proxies.

### 1.2 Key Innovations

  * **Performance Market (Tiered Rewards):** Rewards are scaled based on response speed. "Platinum" (immediate) responses earn 100%; "Silver" (delayed) responses earn 50%; "Fail" (glacier-speed) earn 0%.
  * **System-Defined Placement:** Clients do not choose their providers. The network deterministically assigns shards to random, diverse providers (`Hash(Deal + Block)`), making Sybil attacks statistically impossible.
  * **Chain-Derived Challenges:** Challenges (`Z`) are derived from the unpredictable Epoch Beacon, preventing pre-computation attacks.
  * **$STOR-Only Economy:** A unified economic model using $STOR for capacity commitment, bandwidth settlement, and governance.

---

## 2. The Core Innovation: The Performance Market

Instead of a binary "Pass/Fail" based on a brittle 100ms timing window, NilStore uses **Block-Based Tiers** to enforce quality.

### The Logic
1.  **Challenge:** At Block `H`, the network issues a challenge.
2.  **Race:** Providers must fetch data, compute the KZG proof, and submit the transaction.
3.  **Reward:**
    *   **Platinum (Block H+1):** 100% Reward. (Requires Local NVMe/SSD).
    *   **Gold (Block H+2 to H+5):** 80% Reward. (Tolerates minor network jitter).
    *   **Silver (Block H+10):** 50% Reward. (Standard HDD / Congested Network).
    *   **Fail (Block H+20+):** 0% Reward + Slash. (Deep Freeze / Offline).

### The Outcome
*   **S3 Standard:** Might hit Gold or Silver tiers. Profitable, but less so than local hardware.
*   **S3 Glacier:** Will consistently miss the deadline (Fail). Unprofitable.
*   **Local Hardware:** Consistently hits Platinum/Gold. Maximum Profit.

This market mechanism aligns the provider's selfish profit motive with the network's need for fast, available data.

---

## 3. Architecture

### Layer 1: Consensus & Verification (Cosmos-SDK)
*   **Role:** The "Math Police."
*   **Function:** Manages the **Active Provider List**, executes **System-Defined Placement**, issues **Epoch Beacons**, and verifies **KZG Proofs**. It calculates reward tiers based on proof inclusion height.

### Layer 2: Settlement & Governance (EVM)
*   **Role:** The "Bank."
*   **Function:** Hosts the **$STOR** token, Deal NFTs, and DAO governance.

---

## 4. The Lifecycle of a File

### Step 1: Ingestion & Placement (System-Defined)
1.  **Deal Creation:** User submits `MsgCreateDeal(CID, Size)` to the L1 Chain.
2.  **System Assignment:** The Chain deterministically calculates the Provider Set: `SelectedNodes = Hash(DealID + BlockHash) % ActiveProviderList`.
3.  **Diversity Check:** The Chain ensures selected nodes are from distinct failure domains (IP/ASN).
4.  **Upload:** User streams data shards to the *assigned* providers.

### Step 2: Storage & Verification
1.  **Beacon:** The network generates a random `EpochBeacon`.
2.  **Derived Challenge:** Providers compute `Z = Hash(Beacon + DealID)`. They cannot know this `Z` in advance.
3.  **Proof Submission:** Providers compute `KZG_Open(Data, Z)` and broadcast the proof.

### Step 3: Settlement
1.  **Tier Calculation:** The L1 Validator receives the proof at Block `H_proof`. It compares this to the challenge block `H_challenge`.
2.  **Payout:** The Deal Escrow pays the Provider based on the Tier (Platinum/Gold/Silver).

---

## 5. Security Analysis

| Threat | Mitigation |
| :--- | :--- |
| **Sybil Attack** | **System-Defined Placement.** Attackers cannot self-assign deals. They must control >51% of the network to statistically capture a file. |
| **Lazy Provider (S3)** | **Performance Market.** S3 latency forces providers into lower reward tiers (Gold/Silver), reducing their competitive edge against local hardware. |
| **Pre-Computation** | **Chain-Derived Challenges.** `Z` is linked to the unpredictable Beacon. Deleting the file and keeping a "proof" is impossible. |
| **Glacier/Archive** | **Block Deadlines.** High-latency retrieval misses the 20-block window entirely, resulting in slashing. |

---

## 6. Roadmap

1.  **Phase 1:** Core Crypto & CLI (Completed).
2.  **Phase 2:** Local Testnet ("Store Wars").
3.  **Phase 3:** Implementation of **System-Defined Placement** module (In Progress).
4.  **Phase 4:** Mainnet Launch.