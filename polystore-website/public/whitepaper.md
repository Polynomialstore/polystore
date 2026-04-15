# PolyStore Network: A Protocol for Decentralized, Verifiable, and Economically Efficient Storage

**(White Paper v2.8 - Striped Retrieval Sessions)**

**Date:** 2026-04-15
**Authors:** PolyStore Core Team

## Abstract

PolyStore is a decentralized storage network that unifies storage and retrieval into a single **Demand-Driven Performance Market**. By treating validated user retrievals as storage proofs (**Unified Liveness**), the protocol eliminates wasted work. Placement is **System-Defined** but **Hint-Aware**. The network stores data as **8 MiB Mega-Data Units (MDUs)** in a canonical striped RS(`K`,`K+M`) layout, and scales demand with **additional slot-aligned placements**, ensuring viral content remains available without punishing successful nodes.

## 1. Introduction

### 1.1 The "Double-Pay" Problem

Legacy networks treat "Storage" and "Retrieval" as separate jobs. This is inefficient. PolyStore unifies them.

### 1.2 Key Innovations

*   **Unified Liveness:** A validated user retrieval is storage evidence.
*   **Synthetic Challenges:** The network audits cold data automatically.
*   **Performance Market:** Rewards are based on speed (Platinum/Gold/Silver).
*   **Elasticity:** The network automatically scales demand with **additional slot-aligned placements** funded by the user's prepaid escrow.

---

## 2. The Unified Liveness Protocol

### 2.1 Hot Data (Path A)
1.  **User Request:** "I need chunk #50."
2.  **Session Open (MetaMask):** User opens a retrieval session on-chain, locking a per-blob fee and burning a base fee.
3.  **Service:** A slot-assigned Provider sends data + KZG proof material bound to the `session_id`.
4.  **Session Confirm (MetaMask):** User confirms the session on-chain after a successful download.
5.  **Consensus:** Provider submits proof-of-retrieval for the session; the chain settles payment.
6.  **Result:** Provider earns **Storage Reward** (for liveness) and **Bandwidth Fee** (less a protocol burn).

### 2.2 Cold Data (Path B)
1.  **System Silence:** No user asks for data.
2.  **Beacon Challenge:** Chain issues "I need chunk #50" (pseudo-random).
3.  **Service:** A slot-assigned Provider computes the required proof.
4.  **Consensus:** Provider submits proof to chain.
5.  **Result:** Provider earns **Storage Reward** (for proving liveness).

### 2.3 On-Chain Observability

Retrieval events are surfaced on-chain via **Retrieval Sessions**:

*   **User Authorization:** The Data Owner or authorized requester opens and confirms a retrieval session on-chain (EVM precompile / MetaMask).
*   **Provider Submission:** The Storage Provider submits a session-bound `MsgSubmitRetrievalSessionProof` containing chained proofs for the served blob range. The module verifies:
    *   The Provider is assigned to the relevant slot family for the Deal.
    *   The proof is valid for the declared blob range.
    *   The session is `OPEN` and later confirmed by the requester.
*   **Proof Stream:** The chain aggregates a compact stream of `Proof` summaries (`deal:<id>/epoch:<epoch>/tier:<tier>`) which can be rendered in dashboards to show liveness and performance over time.

Because the layout is striped and slot-aware, multiple Providers can contribute retrieval sessions for different stripes of the same Deal under one canonical commitment.

### 2.4 Retrievability & Self-Healing Invariants

PolyStore's long-term design is anchored on two invariants:

*   **Retrievability / Accountability:** For every `(Deal, Slot)` assignment, either the encrypted data is reliably retrievable under the protocol's rules, or there exists high-probability, verifiable evidence of failure that can be used to punish and eventually replace the accountable Provider.
*   **Self-Healing Placement:** Persistently underperforming or malicious Providers are automatically detected, de-rewarded or slashed, and replaced by healthier Providers, so the network tends toward a state where Deals are held only by SPs that actually serve data.

To support these invariants, PolyStore extends the Unified Liveness protocol with:

*   **Valid Retrieval Challenges:** Every retrieval against `(Deal, Slot)` in epoch `e` is tagged with randomness `R_e` and a session nonce, and both client and Provider derive a deterministic KZG checkpoint inside the requested range. This makes each retrieval a potential storage proof.
*   **Synthetic Storage Challenges:** For each epoch and `(Deal, Slot)`, the chain selects a small set of blob indices to probe purely from `R_e`. Providers that wish to earn storage rewards must satisfy these either via synthetic proofs or retrieval-based proofs.
*   **SP Audit Debt:** Each SP accumulates an "audit debt" proportional to the total bytes it stores; it must act as a mystery shopper for other Providers' Deals, issuing retrieval challenges and reporting misbehavior.
*   **HealthState & Eviction:** The chain maintains rolling health metrics per `(Deal, Slot)` (success ratios, fraud rate, basic latency). When an assignment is clearly unhealthy, the placement engine recruits replacements and evicts the bad Provider once new placements prove themselves.

The north star is simple: **data is either retrievable or the chain can prove that a specific Provider failed and punish them accordingly**.

---

## 3. Traffic Management (Elasticity)

### 3.1 The Saturation Signal
If a Platinum-tier Provider is overwhelmed by traffic on a slot family, it can submit a **Saturation Signal** to the chain.

*   **Condition:** The Provider must be in good standing (Platinum/Gold) and show high retrieval session volume on the affected slots.
*   **Response:** The chain verifies the user has **Budget Available** in escrow.
*   **Action:** The chain authorizes **additional slot-aligned placements** on new edge nodes to absorb the load. The original Provider is *not* penalized.

### 3.2 User Controls
*   **Budget Cap:** Users set a `MaxMonthlySpend`. The protocol will never authorize additional placements if doing so would exceed this cap.
*   **Result:** "Viral" content scales automatically. "Budget" content is rate-limited.

---

## 4. The Lifecycle of a File

PolyStore uses one canonical storage layout:

*   **Striped RS(`K`,`K+M`) Layout:** The chain assigns an ordered slot list of size `N = K+M`. Metadata MDUs are replicated across all slots. User data MDUs are striped per slot family and reconstructed from any valid `K` shards.

Clients may run fully in-browser using WASM and OPFS for local slab storage, or use the Go gateway/S3 adapter and CLI. The gateway is optional routing + caching infrastructure and never signs on behalf of the user; all on-chain actions require a wallet signature.

*Devnet note:* a faucet-backed relay can be enabled for demos (sponsoring gas while preserving MetaMask authorization), but it is disabled by default in the mainnet-parity posture.

### Step 1: Ingestion & Placement
1.  **Deal Creation:** User submits `MsgCreateDeal` with service intent and spend controls, creating a thin-provisioned container.
2.  **Assignment:** The chain deterministically assigns an ordered slot list of size `N = K+M`.
3.  **Upload:** The client performs RS(`K`,`K+M`) encoding per SP-MDU (WASM/CLI) and uploads per-slot shards directly to the assigned Providers. A gateway may optionally mirror/cache, but it is not required for correctness.
4.  **Commit Content:** After upload, the user commits the returned `manifest_root` via `MsgUpdateDealContent` (the Deal is empty until this commit).

### Step 2: The Liveness Loop
*   **Scenario 1 (Viral):** Users swarm the file via retrieval sessions. Providers signal saturation. Chain checks `MaxSpend` and authorizes **additional slot-aligned placements** for the affected slot families.
*   **Scenario 2 (Archive):** File sits idle. Chain issues Beacon challenges.

---

## 5. Security Analysis

| Threat | Mitigation |
| :--- | :--- |
| **Sybil Attack** | **System-Defined Placement.** |
| **Constraint Attack** | **Rebalancing Fees.** Providers pay to rotate off constrained placements early. |
| **Billing Runaway** | **Spend Caps.** Protocol strictly enforces user-defined limits. |

---

## 6. Enterprise Features: Privacy & Deletion

PolyStore is built for **Zero-Trust** environments.

### 6.1 Zero-Knowledge Cloud
*   **Encryption:** Data is encrypted client-side (`AES-256-GCM`) before it ever touches the network.
*   **Blind Replication:** When the network scales up with **additional slot-aligned placements**, it copies **8 MiB encrypted MDUs** as ciphertext. Providers act as blind mules; they store and serve data they cannot read.
*   **Zero-Touch Scaling:** Because the network replicates already-encrypted ciphertext, it can expand placement autonomously. The Data Owner does **not** need to be online to re-encrypt data for new nodes.

### 6.2 Proof of Deletion (Crypto-Erasure)
Regulatory compliance (GDPR/CCPA) requires the ability to delete data.

*   **The Problem:** You cannot prove a remote server wiped a hard drive.
*   **The Solution:** Rely on **Crypto-Erasure**.
*   **Mechanism:** The User holds the **File Master Key (FMK)**. To "delete" the data globally, the User destroys the FMK. The encrypted data remaining on the network becomes mathematically irretrievable garbage.

---

## 7. Roadmap

1.  **Phase 1:** Core Crypto & CLI.
2.  **Phase 2:** Multi-provider striped devnet with direct retrieval sessions.
3.  **Phase 3:** Elasticity, self-healing, and retrieval market hardening.
4.  **Phase 4:** Mainnet launch.
