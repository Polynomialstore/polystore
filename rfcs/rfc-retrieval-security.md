# RFC: Retrieval Security & Economic Griefing Analysis

**Status:** Informational / Security Analysis
**Scope:** Retrieval Market, Game Theory
**Related:** `whitepaper.md`, `rfcs/rfc-blob-alignment-and-striping.md`

This document analyzes the security model of the NilStore Retrieval Market, specifically focusing on the "Fair Exchange" problem between Storage Providers (SPs) and Data Users.

---

## 1. The Happy Path (Unified Liveness)

In the standard flow, the **Retrieval Receipt** serves as the atomic settlement unit.

1.  **Request:** User requests data (MDU/Shard) from SP.
2.  **Delivery:** SP delivers Data + Triple Proof.
3.  **Verification:** User verifies `Proof` against on-chain `ManifestRoot`.
4.  **Settlement:** User signs `RetrievalReceipt`. SP submits to Chain.
5.  **Outcome:** SP gets paid/rewarded; User Escrow is debited.

---

## 2. Attack Vectors: The Malicious Provider

### A. The "Garbage Data" Attack
*   **Action:** SP sends random noise to save on disk reads.
*   **Defense:** **Triple Proof (Hybrid Merkle-KZG).**
    *   The User verifies the data against the `ManifestRoot`.
    *   Forgery is cryptographically impossible.
*   **Outcome:** User detects invalid data immediately and **DOES NOT** sign. SP wastes bandwidth for zero reward. **(Risk: None)**

### B. The "Ransom" Attack
*   **Action:** SP withholds data, demanding off-chain extortion.
*   **Defense:** **Erasure Coding (RS 12,8).**
    *   No single SP has a monopoly on the data.
    *   User simply downloads from the 11 other shards and reconstructs.
*   **Outcome:** SP loses business. System heals via parity. **(Risk: Low)**

---

## 3. Attack Vectors: The Malicious User (Economic Griefing)

The primary economic vulnerability in optimistic retrieval markets is the "Free Rider" problem.

### The "Free Rider" Attack (Dine and Dash)
*   **Mechanism:**
    1.  User requests 1 GB of data.
    2.  SP delivers 1 GB. (Bandwidth Cost Incurred).
    3.  User verifies data but **Refuses to Sign** the receipt.
*   **Impact:**
    *   **User:** Gets data for free (Escrow is never triggered).
    *   **SP:** Loses bandwidth costs. Earns no Liveness Reward.
*   **Vulnerability Root:** The **Atomic Gap** between delivery (Step 2) and settlement (Step 4).

### Mitigation: Incremental Signing (Tit-for-Tat)
To neutralize this risk, client SDKs and SPs MUST implement **Incremental Signing** (Chunked Delivery).

*   **Protocol:**
    1.  User requests 1 GB.
    2.  SP sends **Chunk 1** (e.g., 100 MB).
    3.  SP **Pauses**.
    4.  User must sign/send receipt for Chunk 1.
    5.  SP verifies signature -> Sends **Chunk 2**.
*   **Result:**
    *   The "At-Risk" capital is reduced from 100% of the file to `< 10%` (or smaller, depending on chunk size).
    *   A malicious user can only steal one small chunk before being cut off.

---

## 4. Conclusion

| Scenario | Defense Mechanism | Residual Risk |
| :--- | :--- | :--- |
| **Lying SP** | Cryptographic Verification (Triple Proof) | **Zero** |
| **Withholding SP** | Redundancy (Reed-Solomon) | **Low** |
| **Free Rider User** | **Incremental Signing** (Tit-for-Tat) | **Low** |
| **Wash Trading** | System-Defined Placement (Randomness) | **Low** |

The system relies on **Cryptography** for Integrity and **Incremental Settlement** for Fair Exchange.
