# NilStore Network: A Protocol for Decentralized, Verifiable, and Economically Efficient Storage

**(White Paper v2.7 - Retrieval Sessions)**

**Date:** 2025-12-18
**Authors:** NilStore Core Team

## Abstract

NilStore is a decentralized storage network that unifies storage and retrieval into a single **Demand-Driven Performance Market**. By treating user retrievals as valid storage proofs (**Unified Liveness**), the protocol eliminates wasted work. Placement is **System-Defined** but **Hint-Aware**. Crucially, the network supports **User-Funded Elasticity** with **8 MiB Mega-Data Units (MDUs)** and **Stripe-Aligned Scaling**, ensuring viral content remains available without punishing successful nodes.

## 1\. Introduction

### 1.1 The "Double-Pay" Problem

Legacy networks treat "Storage" and "Retrieval" as separate jobs. This is inefficient. NilStore unifies them.

### 1.2 Key Innovations

  * **Unified Liveness:** A user downloading a file *is* the storage audit.
  * **Synthetic Challenges:** The network audits cold data automatically.
  * **Performance Market:** Rewards are based on speed (Platinum/Gold/Silver).
  * **Elasticity:** The network automatically scales replication using **Stripe-Aligned Scaling** to meet demand, funded by the user's prepaid escrow.

---

## 2. The Unified Liveness Protocol

### 2.1 Hot Data (Path A)
1.  **User Request:** "I need chunk #50."
2.  **Session Open (MetaMask):** User opens a retrieval session on-chain, locking a per-blob fee and burning a base fee.
3.  **Service:** SP sends data + KZG Proof bound to the `session_id`.
4.  **Session Confirm (MetaMask):** User confirms the session on-chain after a successful download.
5.  **Consensus:** SP submits proof-of-retrieval for the session; the chain settles payment.
6.  **Result:** SP earns **Storage Reward** (for liveness) AND **Bandwidth Fee** (less a protocol burn).

### 2.2 Cold Data (Path B)
1.  **System Silence:** No user asks for data.
2.  **Beacon Challenge:** Chain issues "I need chunk #50" (Pseudo-random).
3.  **Service:** SP computes KZG Proof.
4.  **Consensus:** SP submits proof to chain.
5.  **Result:** SP earns **Storage Reward** (for proving liveness).

### 2.3 On-Chain Observability (Modes 1 + 2)

Retrieval events are surfaced on-chain via **Retrieval Sessions** in both redundancy modes:

*   **User Authorization:** The Data Owner opens and confirms a retrieval session on-chain (EVM precompile / MetaMask).
*   **Provider Submission:** The Storage Provider submits a session-bound `MsgSubmitRetrievalSessionProof` containing chained proofs for the served blob range. The module verifies:
    *   Provider is assigned to the Deal.
    *   The proof is valid for the declared blob range.
    *   The session is `OPEN` and later confirmed by the owner.
*   **Proof Stream:** The chain aggregates a compact stream of `Proof` summaries (`deal:<id>/epoch:<epoch>/tier:<tier>`) which can be rendered in dashboards to show liveness and performance over time.

Mode 2 uses the same session flow but proofs are slot-aware: multiple Providers can contribute sessions for different stripes under the same Deal.

### 2.4 Retrievability & Self-Healing Invariants

NilStore’s long-term design is anchored on two invariants:

*   **Retrievability / Accountability:** For every `(Deal, Provider)` assignment, either the encrypted data is reliably retrievable under the protocol’s rules, or there exists high‑probability, verifiable evidence of SP failure that can be used to punish and eventually evict that Provider.
*   **Self-Healing Placement:** Persistently underperforming or malicious Providers are automatically detected, de‑rewarded or slashed, and replaced by healthier Providers, so the network tends toward a state where Deals are held only by SPs that actually serve data.

To support these invariants, the mainnet Mode 1 design extends the Unified Liveness protocol with:

*   **Valid Retrieval Challenges:** Every retrieval against `(Deal, Provider)` in epoch `e` is tagged with randomness `R_e` and a session nonce, and both client and SP derive a single deterministic KZG checkpoint inside the requested range. This makes each retrieval a potential storage proof.
*   **Synthetic Storage Challenges:** For each epoch and `(Deal, Provider)`, the chain selects a small set of blob indices to probe purely from `R_e`. SPs that wish to earn storage rewards must satisfy these either via synthetic proofs or retrieval-based proofs.
*   **SP Audit Debt:** Each SP accumulates an “audit debt” proportional to the total bytes they store; they must act as mystery shoppers for other SPs’ Deals, issuing retrieval challenges and reporting misbehavior.
*   **HealthState & Eviction:** The chain maintains rolling health metrics per `(Deal, Provider)` (success ratios, fraud rate, basic latency). When an assignment is clearly unhealthy, the placement engine recruits replacements and evicts the bad SP once new replicas prove themselves.

Devnet and testnet implementations approximate this model (e.g., simpler challenge selection and health scoring), but the north star is that **data is either retrievable or the chain can prove that a specific SP failed and punish them accordingly**.

---

## 3. Traffic Management (Elasticity)

### 3.1 The Saturation Signal
If a Platinum-tier Provider is overwhelmed by traffic, they can submit a **Saturation Signal** to the chain.
*   **Condition:** The SP must be in good standing (Platinum/Gold) and show high retrieval session volume.
*   **Response:** The Chain verifies the user has **Budget Available** in their escrow.
*   **Action:** The Chain spawns **Hot Replicas** on new Edge nodes to absorb the load. The original SP is *not* penalized.

### 3.2 User Controls
*   **Budget Cap:** Users set a `MaxMonthlySpend`. The protocol will never spawn replicas if it would exceed this cap.
*   **Result:** "Viral" content scales automatically. "Budget" content is rate-limited.

---

## 4. The Lifecycle of a File

NilStore supports two redundancy modes conceptually:

*   **Mode 1 – FullReplica (Alpha, Implemented):** Each assigned Provider stores a full copy of the file. Elasticity is expressed as changing the number of full replicas.
*   **Mode 2 – StripeReplica (Implemented):** The file is striped across shard indices; each stripe has its own overlay provider set. Elasticity operates at the stripe layer (RS(K, K+M)).

Clients may run fully in-browser using WASM and OPFS for local slab storage, or use the Go gateway/S3 adapter and CLI. The gateway is optional routing + caching infrastructure and never signs on behalf of the user; all on-chain actions require a wallet signature.

### Step 1: Ingestion & Placement
1.  **Deal Creation:** User submits `MsgCreateDeal(Hint: "Hot", MaxSpend: 100 NIL)` which creates a thin-provisioned container.
1.  **Commit Content:** After upload, the user commits the returned `manifest_root` via `MsgUpdateDealContent` (the Deal is empty until this commit).
2.  **Assignment:**
    *   In the current **FullReplica (Mode 1)** implementation, the chain deterministically assigns a set of SPs to hold *full replicas* of the file (targeting 12 in the general case, capped by the number of available providers).
    *   In **StripeReplica (Mode 2)**, the chain assigns an ordered slot list of size `N = K+M` (e.g., 8+4). Metadata MDUs are replicated to all slots, while user data MDUs are striped per slot.
3.  **Upload:** 
    *   **Mode 1:** upload via gateway/CLI or browser; any assigned Provider can accept the full MDU stream.
    *   **Mode 2:** the client performs RS(K, K+M) encoding per SP‑MDU (WASM/CLI) and uploads per‑slot shards directly to assigned Providers. A gateway may optionally mirror/cache, but it is not required for correctness.

### Step 2: The Liveness Loop
*   **Scenario 1 (Viral):** Users swarm the file via retrieval sessions. SPs signal saturation. Chain checks `MaxSpend`.
    *   In **Mode 1**, the chain increases `Deal.CurrentReplication` and assigns additional Providers to store full replicas.
    *   In **Mode 2**, the chain spawns additional **Stripe-Aligned** overlays, recruiting new Providers per shard index.
*   **Scenario 2 (Archive):** File sits idle. Chain issues Beacon challenges.

---

## 5. Security Analysis

| Threat | Mitigation |
| :--- | :--- |
| **Sybil Attack** | **System-Defined Placement.** |
| **Constraint Attack** | **Rebalancing Fees.** SPs pay to rotate off shards early. |
| **Billing Runaway** | **Spend Caps.** Protocol strictly enforces user-defined limits. |

---

## 6. Enterprise Features: Privacy & Deletion

NilStore is built for **Zero-Trust** environments.

### 6.1 Zero-Knowledge Cloud
*   **Encryption:** Data is encrypted client-side (`AES-256-GCM`) before it ever touches the network.
*   **Blind Replication:** When the network scales up "Hot Replicas," it copies **8 MiB Encrypted MDUs** as ciphertext. Providers act as blind mules; they store and serve data they cannot read.
*   **Zero-Touch Scaling:** Because the encryption is deterministic, the network can replicate data autonomously. The Data Owner does **not** need to be online to re-encrypt data for new nodes.

### 6.2 Proof of Deletion (Crypto-Erasure)
Regulatory compliance (GDPR/CCPA) requires the ability to delete data.
*   **The Problem:** You cannot prove a remote server wiped a hard drive.
*   **The Solution:** We rely on **Crypto-Erasure**.
*   **Mechanism:** The User holds the **File Master Key (FMK)**. To "delete" the data globally, the User destroys the FMK. The encrypted data remaining on the network becomes mathematically irretrievable garbage.

---

## 7. Roadmap

1.  **Phase 1:** Core Crypto & CLI (Completed).
2.  **Phase 2:** Local Testnet & Specs (Completed).
3.  **Phase 3:** Implementation of **Deal Object**, **Provider Capabilities**, and **System Placement**.
4.  **Phase 4:** **Retrieval Market** & Edge SDK.
