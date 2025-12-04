# NilStore Core v 2.2

### Cryptographic Primitives & Proof System Specification

---

## Abstract

NilStore is a decentralized storage network that unifies **Storage** and **Retrieval** into a single **Demand-Driven Performance Market**. Instead of treating storage audits and user retrievals as separate events, NilStore implements a **Unified Liveness Protocol**: user retrievals *are* storage proofs.

It specifies:
1.  **Unified Liveness:** Organic user retrieval receipts act as valid storage proofs.
2.  **Synthetic Challenges:** The system acts as the "User of Last Resort" for cold data.
3.  **Tiered Rewards:** Storage rewards are tiered by latency, regardless of whether the trigger was Organic or Synthetic.
4.  **System-Defined Placement:** Deterministic assignment to ensure diversity.

---

## § 4 Consensus & Verification (Unified Liveness) — Normative

### 4.0 Objective & Model

The protocol does not distinguish between "Verification" and "Retrieval." Both are cryptographic attestations of data possession delivered within a time window.

**The Rule:** Every Epoch, an SP must prove liveness for every assigned DU.
*   **Path A (Hot):** Submit a signed **Retrieval Receipt** from a User.
*   **Path B (Cold):** Submit a response to the **System Challenge** (Synthetic).

### 4.1 The Retrieval Receipt (Dual-Purpose)

To serve as a storage proof, a receipt must bind the delivery to the underlying crypto-commitments.

```protobuf
message RetrievalReceipt {
  uint64 deal_id = 1;
  uint64 epoch_id = 2;
  bytes kzg_proof = 3;          // 48-byte G1 point (Proof of Chunk)
  bytes y_value = 4;            // 32-byte chunk data hash
  bytes signature = 5;          // User's Ed25519 signature
}
```

*   **Consensus Rule:** A valid `RetrievalReceipt` is cryptographically equivalent to a `MsgSubmitProof` for the purpose of Storage Rewards.

### 4.2 The System Challenge (User of Last Resort)

If a DU receives zero user traffic in an epoch, the protocol generates a **Synthetic Request**.

*   **Trigger:** SP has no `RetrievalReceipt` for `DealID` in `Epoch_N`.
*   **Challenge:** `Z = Hash(EpochBeacon + DealID)`.
*   **Action:** SP computes `KZG_Open(C, Z)` and submits it.
*   **Reward:** Unlocks **Storage Reward** (Tiered) but **Zero Bandwidth Payment**.

### 4.3 Tiered Rewards (Latency)

Rewards are based on the **Inclusion Latency** of the proof, regardless of source.

**Latency `L = H_proof - H_request`.**
(For Path A, `H_request` is the block the user initiated the stream. For Path B, it is the Beacon block).

| Tier | Latency (Blocks) | Reward Multiplier | Description |
| :--- | :--- | :--- | :--- |
| **Platinum** | `L <= 1` | **100%** | Immediate service (Hot / NVMe). |
| **Gold** | `L <= 5` | **80%** | Fast service. |
| **Silver** | `L <= 10` | **50%** | Slow service. |
| **Fail** | `L > 20` | **0% + Slash** | Offline / Glacier. |

### 4.4 Prover Obligations

1.  **Monitor Traffic:** If user requests data, serve it and cache the `RetrievalReceipt`.
2.  **Monitor Beacon:** If no user requests data, compute the System Challenge.
3.  **Submit Best:** Broadcast the proof with the best latency tier to the chain.

---

## § 6 Product-Aligned Economics

### 6.0 System-Defined Placement (Anti-Sybil)

(Unchanged from v2.1 - Deterministic Slotting).

### 6.1 The Unified Market

*   **Storage Income:** Earned by satisfying liveness (via Path A or Path B).
*   **Bandwidth Income:** Earned ONLY via Path A (User Receipts).
*   **Incentive Alignment:** "Hot" files are more profitable (Double Income). "Cold" files pay only Storage Income. This naturally aligns SPs to desire popular content and optimize for retrieval speed.

### 6.2 Auto-Scaling

*   If `UniqueUsers(Path A) > Threshold`, the protocol triggers **System Placement** to replicate the DU to more Platinum-tier nodes.