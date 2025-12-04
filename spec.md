# NilStore Core v 2.1

### Cryptographic Primitives & Proof System Specification

---

## Abstract

NilStore is a decentralized storage network that guarantees data availability and retrievability through a **Performance Market**. Instead of banning specific hardware architectures, the protocol incentivizes low-latency, high-reliability storage through a tiered reward system driven by **Block-Height Inclusion** and ensures diversity through **System-Defined Placement**.

It specifies, in a fully reproducible manner:

1. **System-Defined Placement** — Deterministic assignment of providers to ensure Anti-Sybil diversity.
2. **Performance Market (Tiered Rewards)** — Block-latency based rewards (Platinum/Gold/Silver).
3. **Retrieval Economy** — User-pays model with "Included Quota", spending caps, and verifiable, decaying-sample auditing.
4. **Chain-Derived Challenges** — Anti-precomputation via Epoch Beacons.

All constants and vectors in this specification are reproducible and accompanied by deterministic Known‑Answer Tests (Annex A–B).

---
## § 0 Notation, Dial System & Versioning

### 0.1 Symbols, Typography, and Conventions

| Markup                    | Meaning                                               | Example         |
| ------------------------- | ----------------------------------------------------- | --------------- |
| `u8`, `u16`, `u32`, `u64` | Little‑endian unsigned integers of the stated width   | `0x0100 → 256`  |
| `≡`                       | Congruence *mod q* unless another modulus is explicit | `a ≡ b (mod q)` |
| `‖`                       | Concatenation of byte strings                         | `x‖y`           |

### 0.2 Dial Parameters

A **dial profile** defines the core cryptographic parameters.

| Symbol | Description                                | Baseline "S‑512"                |
| ------ | ------------------------------------------ | ------------------------------- |
| `Curve`| Elliptic Curve (for KZG and VRF)           | **BLS12-381** (Mandatory)       |
| `r`    | BLS12-381 subgroup order                   | (See §5.1)                      |

### 0.3 Version Triple

Every on‑chain 32‑byte digest begins with a **version triple**

```
Version = {major : u8 = 0x02, minor : u8 = 0x01, patch : u8 = 0x00}
digest  = Blake2s‑256( Version ‖ DomainID ‖ payload )
```

---

## § 4 Consensus & Verification (The Performance Market) — Normative

### 4.0 Objective & Model

Attest, per epoch, that an SP stores the canonical bytes of their assigned DU intervals and can provide **low-latency proofs** of inclusion.

**Security anchors:** (i) DU **KZG commitment** `C_root` recorded at deal creation; (ii) BLS‑VRF epoch beacon for unbiased challenges; (iii) on‑chain **KZG multi‑open** pre‑compiles; (iv) Block-Height Tiered Rewards.

### 4.1 Chain-Derived Challenges (Anti-Precomputation)

To prevent pre-computation, the challenge point `Z` is unknown until the Epoch begins.

**Challenge Derivation:**
For a given `EpochID` and `DealID`:
`Beacon = Chain.GetEpochBeacon(EpochID)`
`Z = Hash(Beacon || DealID || ProviderAddress)`

*   **Implication:** An SP cannot compute `KZG_Open(C, Z)` until the block containing `Beacon` is finalized.

### 4.2 Tiered Rewards (Proof-of-Inclusion-Latency)

Instead of a strict wall-clock deadline, NilStore uses **Block-Height Tiered Rewards**.

**Let `H_challenge` be the block height where the Challenge is issued.**
**Let `H_proof` be the block height where the `MsgSubmitProof` is included.**
**Latency `L = H_proof - H_challenge`.**

| Tier | Latency (Blocks) | Reward Multiplier | Description |
| :--- | :--- | :--- | :--- |
| **Platinum** | `L <= 1` | **100%** | Immediate inclusion. Requires hot storage. |
| **Gold** | `L <= 5` | **80%** | Fast inclusion. Tolerates minor network jitter. |
| **Silver** | `L <= 10` | **50%** | Slow inclusion. Standard HDD or congested network. |
| **Fail** | `L > 20` | **0% + Slash** | "Cold" storage (Glacier) or offline. Treated as data loss. |

### 4.3 Prover Obligations per DU Interval

1) **PoUD — KZG‑PDP (content correctness):** Provide KZG **multi‑open** at the chosen `Z` indices proving membership in `C_root`.
2) **Submission:** Broadcast `MsgSubmitProof` immediately to secure the highest Tier.

---

## § 5 Nil‑VRF / Epoch Beacon (`nilvrf`)

We use a BLS12‑381‑based **verifiable random function (VRF)** to derive unbiased epoch randomness. (Standard BLS signatures on `hash_to_G2`).

The 32‑byte `beacon_t` feeds **§ 4.1** challenge derivation.

---

## § 6 Product‑Aligned Economics & Operations

### 6.0 System-Defined Placement (Anti-Sybil)

To prevent "Self-Dealing" (where an attacker acts as both client and provider), the protocol **enforces** provider selection. Clients cannot choose their SPs.

**Algorithm:**
1.  **Active Provider List:** The chain maintains a sorted list of active, bonded SPs.
2.  **Deterministic Slotting:** Upon `MsgCreateDeal`, the chain computes `N` distinct indices:
    `Idx_i = Hash(DealID || BlockHash || i) % AP_List.Length`
3.  **Diversity Constraint:** The selected set MUST satisfy diversity rules (e.g., distinct ASN/Subnet).

### 6.1 Retrieval Economy (User-Pays & Auto-Scaling)

Retrievals are initiated by the User (or their Edge delegates) and settled via the protocol.

#### 6.1.1 Bandwidth Escrow & Quota
*   **Included Quota:** Every `MsgCreateDeal` includes a `PrepaidBandwidth` amount (e.g., 1TB). This is added to the Deal's escrow.
*   **Spend Cap:** Users set a `MaxMonthlySpend`. The protocol rejects retrievals exceeding this cap unless explicitly authorized.
*   **Decryption:** Retrieval delivers **Ciphertext**. Users/Edge Nodes utilize the `FMK` (File Master Key) to decrypt client-side.

#### 6.1.2 Verifiable Retrieval & Decaying Sampling
To minimize gas costs while maintaining security, the protocol uses **Decaying Probabilistic Verification**.

1.  **Receipts:** Users sign `RetrievalReceipt(Bytes, Timestamp, ProviderID)` upon successful download.
2.  **Aggregation:** SPs aggregate receipts into a Merkle Root and submit `MsgClaimBandwidth(Root, TotalBytes)` once per epoch.
3.  **Sampling Logic:**
    *   The chain calculates a verification probability `P`.
    *   `P = BaseRate / (1 + log(TotalVerifiedBytes_SP))`.
    *   *Effect:* New or low-volume SPs face high audit rates (e.g., 10%). High-volume, trusted SPs face asymptotically lower rates (e.g., <0.1%), optimizing gas.
4.  **Challenge:** If sampled, the Chain requests specific receipts from the Merkle Tree.
5.  **Settlement:** Valid proofs unlock $STOR from the Deal Escrow to the SP.

#### 6.1.3 Automatic Scaling (Hot Replicas)
*   **Trigger:** If `ServedBytes > Threshold` for a specific DU in an epoch.
*   **Action:** The protocol automatically triggers `SystemPlacement` to assign **Hot Replicas** to additional high-performance SPs.
*   **Funding:** These replicas are funded from the Deal's "Surge Budget" (if enabled by User).

### 6.2 Deal Lifecycle

1.  **Creation:** User sends `MsgCreateDeal`. Chain runs **System-Defined Placement**. `DealCreated` event emitted.
2.  **Execution:** Every Epoch, chain derives `Z`. SPs submit proofs.
3.  **Retrieval:** Users fetch data. SPs accumulate receipts.
4.  **Settlement:** Validator verifies KZG and Bandwidth Receipts.
5.  **Expiry:** Deal ends, remaining escrow returned.

## Appendix A: Core Cryptographic Primitives

### A.3 File Manifest & Crypto Policy (Normative)

NilStore uses a content‑addressed file manifest.

  * **Root CID** = `Blake2s-256("FILE-MANIFEST-V1" || CanonicalCBOR(manifest))`.
  * **DU CID** = `Blake2s-256("DU-CID-V1" || ciphertext||tag)`.
