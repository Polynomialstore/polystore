# RFC: Retrieval Validation & The Deputy System

**Status:** Draft / Exploratory
**Scope:** Retrieval Markets, Proof of Delivery, Dispute Resolution
**Key Concepts:** Signed Receipts, Deputy Auditors, Indistinguishability

---

## 1. The Core Problem: "He Said, She Said"

In a trustless retrieval market, we have two fundamental actions we must prove:
1.  **Action A (Success):** The Storage Provider (SP) successfully sent the data to the Data User (DU). The SP wants to be paid/rewarded.
2.  **Action B (Failure):** The SP *failed* to send the data. The DU wants the SP penalized (or at least not paid).

This creates an adversarial game:
*   **Malicious SP:**
    *   **Wash Trading:** Pretends to serve data to themselves (fake DU) to earn inflation rewards.
    *   **Selective Service:** Serves high-paying users/auditors but ignores low-value users.
*   **Malicious DU:**
    *   **Free Riding:** Gets the data but refuses to sign the receipt.
    *   **Griefing:** Falsely claims the SP is offline to hurt their reputation.

We need a system that validates the **Happy Path** efficiently while robustly resolving the **Dispute Path**.

---

## 2. The Happy Path: Signed Receipts & Bandwidth Burn

When the system works, it relies on **Mutual Greed**.

### 2.1 The Retrieval Receipt
1.  **Request:** DU sends a request for Chunk $C$.
2.  **Response:** SP sends $C$ + KZG Proof.
3.  **Payment:** DU verifies the proof. If valid, DU signs a `RetrievalReceipt(SP, ChunkID, Timestamp)`.
4.  **Settlement:** SP submits the Receipt to the chain to claim rewards.

### 2.2 Countering Wash Trading (SP == DU)
If an SP creates a fake DU identity to sign receipts, they can drain the inflation pool.
**Solution:** The "Burn" Constraint.
*   Every `RetrievalReceipt` must act as a **Burn** of the DU's escrow tokens (Paying for bandwidth).
*   **Rule:** The cost to the DU (Bandwidth Fee) must be $>=$ The Reward to the SP.
*   *Result:* Wash trading becomes net-negative or cost-neutral. You cannot print money by talking to yourself.

---

## 3. The Dispute Path: The Deputy System

What happens when a DU says "I requested the file, but the SP timed out"?
We cannot trust the DU alone (they might be griefing). We cannot trust the SP (they might be lazy).

We introduce the **Deputy (or Mystery Shopper)**.

### 3.1 Concept
If a DU is unsatisfied, they cannot "slash" the SP directly. They can only **Escalate**.
Escalation triggers a random, disinterested 3rd party (a Deputy Node) to check the SP.

### 3.2 The Escalation Flow
1.  **Complaint:** DU broadcasts a `DisputeClaim(SP, ChunkID)` to the network (or a specific "Dispatcher" smart contract).
2.  **Selection:** The chain (via DRB) selects $K$ random **Deputies** from the active Validator/SP set.
3.  **The Sting Operation:**
    *   Each Deputy generates an ephemeral identity (new keypair).
    *   Each Deputy anonymously requests the *same* chunk from the target SP.
4.  **Verdict:**
    *   **Success:** If Deputies receive the data, the DU's claim is rejected. The DU is penalized (anti-griefing fee).
    *   **Failure:** If Deputies *also* timeout or receive bad data, the SP is considered proven faulty. The SP is slashed/penalized.

---

## 4. The Indistinguishability Requirement (Tor Inspiration)

For the Deputy system to work, the SP **must not know** they are being audited.
If an SP can distinguish a "Real User" from a "Deputy", they can implement **Split-Horizon DNS**:
*   "Serve the Deputy perfectly."
*   "Ignore the complainer."

### 4.1 Achieving Anonymity
We cannot easily use a full Tor network (too much latency/overhead). However, we can enforce **Protocol Uniformity**.

1.  **Ephemeral Keys:** Every retrieval request SHOULD use a fresh, ephemeral keypair.
    *   *Result:* SP sees a request from `0xRandom...`. They don't know if it's a long-term user or a one-time auditor.
2.  **Standardized Traffic:** "Audits" must look exactly like "User Traffic" on the wire (Packet size, timing).
3.  **Payment Channels:** Deputies must be able to fund the request without revealing their identity.
    *   *Challenge:* If the payment comes from `DeputyWallet`, the SP knows.
    *   *Solution:* **Blinded Vouchers** or a **Mixer**. The Protocol creates a pool of "Audit Credits." Deputies withdraw anonymous credits to pay for the sting operation.

### 4.2 The "Deputies as Proxies" Model
Alternatively, if the DU is failing to retrieve, they can ask a Deputy to **retrieve on their behalf**.
1.  DU fails to get file from SP.
2.  DU asks Deputy: "Get this for me."
3.  Deputy retrieves file from SP.
    *   If Success: Deputy forwards to DU (for a fee). *The system works, just routing around damage.*
    *   If Fail: Deputy generates a `ProofOfFailure` (signed attestation "I tried and failed").
4.  If the SP accumulates enough `ProofOfFailure` signatures from distinct Deputies, the chain slashes the SP.

---

## 5. Incentives

### 5.1 Why be a Deputy?
*   **Audit Rewards:** The protocol pays Deputies for performing checks.
*   **Audit Debt:** We can mandate that every SP *must* perform $N$ audits per epoch to remain eligible for rewards (Conscription).

### 5.2 Why not Collude?
*   **Random Selection:** If the set of Deputies is large and random, it's hard for a bad SP to bribe them all in real-time.
*   **Prisoner's Dilemma:** If one Deputy reports the truth while others lie, the liars (who contradict the majority or the crypto-evidence) risk slashing.

---

## 6. Summary of the Proposed Flow

1.  **Default:** Users pay SPs, sign receipts. Everyone is happy. Wash trading is expensive.
2.  **Failure:** User experiences timeout.
3.  **Escalation:** User requests a **Proxy Retrieval** from the Deputy Network.
4.  **Sting:** Deputies (using ephemeral keys and blinded credits) attempt to fetch the data.
5.  **Resolution:**
    *   **Deputy Success:** User gets their data (via Deputy). User pays a premium for the "Delivery Service." SP is verified.
    *   **Deputy Fail:** Deputy signs `ProofOfFailure`. SP is penalized.

This turns "Disputes" into "Routing." If direct connection fails, we switch to a "Tor-lite" proxy mode. If that *also* fails, the SP is dead.
