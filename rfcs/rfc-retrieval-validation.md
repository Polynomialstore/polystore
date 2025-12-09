# RFC: Retrieval Validation & The Deputy System

**Status:** Draft / Normative Candidate
**Scope:** Retrieval Markets, Proof of Delivery, Dispute Resolution
**Key Concepts:** Proxy Relay, Audit Debt, Ephemeral Identity

---

## 1. The Core Problem: "He Said, She Said"

In a trustless retrieval market, we must distinguish between:
1.  **Service Failure:** The SP is offline or malicious.
2.  **Griefing:** The User claims the SP is offline, but the SP is actually fine.

We solve this not by "Judging" the dispute, but by **Routing Around It**.

---

## 2. The Solution: The Deputy (Proxy) System

Instead of a complex "Court System," we implement a **"CDN of Last Resort."**

### 2.1 The "Proxy" Workflow (UX-First)
When a Data User (DU) fails to retrieve a file from their assigned Storage Provider (SP):

1.  **Escalation:** The DU broadcasts a P2P request: *"I need Chunk X from SP Y. I will pay MarketRate + Premium."*
2.  **The Deputy:** A random third-party Node (The Deputy) accepts the job.
3.  **The Relay:**
    *   The Deputy connects to the SP using a fresh, **Ephemeral Keypair** (acting as a new customer).
    *   The Deputy retrieves the chunk and pays the SP.
    *   The Deputy forwards the chunk to the DU and collects the `MarketRate + Premium`.
4.  **Outcome:**
    *   **Success:** The DU gets their file. The SP gets paid (unknowingly serving a proxy). The Deputy earns a fee.
    *   **Failure:** If the SP refuses/fails to serve the Deputy, the Deputy signs a `ProofOfFailure`.

### 2.2 Why This Works (Indistinguishability)
We do **not** need complex privacy mixers or ZK-Vouchers.
*   **Rationality Assumption:** A Rational SP wants to earn money.
*   **The Trap:** When the Deputy connects with an ephemeral key, the SP sees a **New Paying Customer**.
    *   If SP serves: They avoid slashing, but the DU gets the data (Goal achieved).
    *   If SP refuses: They lose revenue AND generate a `ProofOfFailure` (Slashing Risk).

---

## 3. "Audit Debt": The Engine of Honesty

How do we ensure there are enough Deputies? We **Conscript** them.

### 3.1 The Rule
**"To earn Storage Rewards, you must prove you are checking your neighbors."**

### 3.2 The Mechanism
1.  **Assignment:** The Protocol deterministically assigns `AuditTargets` to every SP based on the Random Beacon (DRB).
2.  **The Job:** The SP must act as a Deputy/Mystery Shopper for these targets.
3.  **The Reward Gate:**
    *   `ClaimableReward = min(BaseInflationReward, AuditWorkDone * Multiplier)`
    *   If an SP stores 1PB of data but performs 0 audits, their **Effective Reward** is 0.
4.  **Proof of Audit:** The SP submits the `RetrievalReceipt` they obtained from the Target SP.
    *   *Side Effect:* This generates a constant hum of "Organic Traffic" that proves the network is live, even when real users are asleep.

---

## 4. The Sad Path: Verified Failure

If a Deputy attempts to retrieve a chunk (for a User or for Audit Debt) and fails:

1.  **Evidence:** Deputy creates a `ProofOfFailure` (signed attestation + transcript hash).
2.  **Accumulation:** The Chain tracks `FailureCount(SP)`.
3.  **Slashing:**
    *   If `FailureCount > Threshold` within `Window`, the SP is jailed/slashed.
    *   *Safety:* A single malicious Deputy cannot slash an SP. It requires a consensus of failures from distinct, randomly selected Deputies.

---

## 5. Implementation Strategy (MVP)

**Phase 1: The Proxy (Client-Side Only)**
*   Implement the P2P `AskForProxy` message.
*   No consensus changes. Just networking logic.

**Phase 2: Audit Debt (Consensus)**
*   Add `AuditDebt` tracking to the `StorageProvider` struct.
*   Update `BeginBlocker` to check Audit compliance before minting rewards.

**Phase 3: Slashing**
*   Implement `MsgSubmitFailureEvidence`.

---

## 6. Summary

This RFC moves the protocol from a "Legal System" (Disputes) to a "Logistics System" (Relays).
*   **User Problem:** "I can't get my file." -> **Solution:** "A Deputy gets it for you."
*   **Network Problem:** "Are nodes online?" -> **Solution:** "Nodes must audit each other to get paid."