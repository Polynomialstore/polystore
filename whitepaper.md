# NilStore Network: A Protocol for Decentralized, Verifiable, and Economically Efficient Storage

**(White Paper v2.1 - User-Centric Economy)**

**Date:** 2025-12-04
**Authors:** NilStore Core Team

## Abstract

NilStore is a decentralized storage network designed to provide high-throughput, verifiable data storage. It introduces a **Performance Market** (tiered rewards for speed), **System-Defined Placement** (anti-Sybil distribution), and a **User-Centric Retrieval Economy** where users control encryption, bandwidth quotas, and edge caching.

## 1\. Introduction

### 1.1 Motivation

Decentralized storage often fails on two fronts: **Latency** (slow retrieval) and **Complexity** (users managing payment channels). NilStore solves this by treating **Retrieval as a First-Class Citizen**.

### 1.2 Key Innovations

  * **Performance Market:** Rewards are scaled based on response speed (Block Latency).
  * **System-Defined Placement:** Deterministic assignment ensures diversity and prevents self-dealing.
  * **Included Quota:** Deals come with prepaid bandwidth, simplifying the UX to "Pay Once, Store & Serve."
  * **Edge-Ready:** Data is stored as encrypted ciphertext, decryptable only by the User or their authorized Edge Nodes (e.g., Cloudflare Workers), enabling true CDN functionality.

---

## 2. The Performance Market (Incentivized Speed)

Instead of banning S3, we out-compete it.

### The Logic
1.  **Challenge:** At Block `H`, the network issues a challenge.
2.  **Reward:**
    *   **Platinum (Block H+1):** 100% Reward. (Requires Local NVMe).
    *   **Gold (Block H+5):** 80% Reward.
    *   **Fail (Block H+20):** 0% Reward. (Glacier/Offline).

---

## 3. The Retrieval Economy

NilStore automates the "CDN" experience through the protocol.

### 3.1 User-Pays & Included Quota
*   **Prepaid Model:** When creating a deal, users fund an **Escrow** that covers both storage (Space) and retrieval (Bandwidth).
*   **Quotas:** Users set a `MaxMonthlySpend`. The protocol enforces this cap, preventing billing runaways.

### 3.2 Auto-Scaling (Hot Replicas)
*   **Viral Content:** If a file is requested frequently, the protocol automatically detects the heat.
*   **Reaction:** The chain assigns **Hot Replicas** to additional, high-performance nodes to meet demand.
*   **Decay:** As demand cools, these replicas are spun down to save costs.

### 3.3 Efficient Auditing
*   **Decaying Sampling:** To keep gas costs low, the network audits high-volume providers *less frequently* over time as they build reputation, while maintaining strict checks on new providers.

---

## 4. The Lifecycle of a File

### Step 1: Ingestion & Placement
1.  **Deal Creation:** User submits `MsgCreateDeal`. Chain deterministically assigns 12 distinct Providers.
2.  **Upload:** User streams encrypted shards to the assigned IPs.

### Step 2: Storage & Verification
1.  **Challenge:** Chain issues `Z` from Epoch Beacon.
2.  **Proof:** Providers submit KZG proofs.
3.  **Tiering:** Faster proofs earn Platinum rewards.

### Step 3: Retrieval & Consumption
1.  **Request:** User (or Edge Node) requests shards.
2.  **Service:** SP streams ciphertext. User signs a **Micro-Receipt**.
3.  **Settlement:** SP batches receipts. Chain verifies a random sample and debits User Escrow.

---

## 5. Security Analysis

| Threat | Mitigation |
| :--- | :--- |
| **Sybil Attack** | **System-Defined Placement.** Attackers cannot self-assign deals. |
| **Lazy Provider** | **Performance Market.** Slow retrieval = Low/No Reward. |
| **Fake Traffic** | **Signed Receipts.** Providers cannot fake bandwidth claims without User signatures. |
| **Billing Runaway** | **Spend Caps.** Protocol strictly enforces user-defined limits. |

---

## 6. Roadmap

1.  **Phase 1:** Core Crypto & CLI (Completed).
2.  **Phase 2:** Local Testnet & Specs.
3.  **Phase 3:** Implementation of **Deal Object** and **System Placement**.
4.  **Phase 4:** **Retrieval Market** & Edge SDK.
