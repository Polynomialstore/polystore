# NilStore Core v 2.0

### Cryptographic Primitives & Proof System Specification

---

## Abstract

NilStore is a decentralized storage network that guarantees data availability and retrievability through a **Performance Market**. Instead of banning specific hardware architectures, the protocol incentivizes low-latency, high-reliability storage through a tiered reward system driven by **Block-Height Inclusion** and ensures diversity through **System-Defined Placement**.

It specifies, in a fully reproducible manner:

1. **System-Defined Placement** — Deterministic assignment of providers to ensure Anti-Sybil diversity.
2. **Performance Market (Tiered Rewards)** — Block-latency based rewards (Platinum/Gold/Silver) replacing strict timing failures.
3. **Chain-Derived Challenges** — Anti-precomputation via Epoch Beacons.
4. **BLS VRF** and BATMAN aggregation for unbiased epoch beacons.

All constants and vectors in this specification are reproducible and accompanied by deterministic Known‑Answer Tests (Annex A–B).

---
## § 0 Notation, Dial System & Versioning ( Baseline Profile “S‑512” )

### 0.1 Symbols, Typography, and Conventions

| Markup                    | Meaning                                               | Example         |
| ------------------------- | ----------------------------------------------------- | --------------- |
| `u8`, `u16`, `u32`, `u64` | Little‑endian unsigned integers of the stated width   | `0x0100 → 256`  |
| `≡`                       | Congruence *mod q* unless another modulus is explicit | `a ≡ b (mod q)` |
| `‖`                       | Concatenation of byte strings                         | `x‖y`           |
| `Σ`, `Π`                  | Field‑sum / product in 𝔽\_q (wrap at *q*)            | `Σ_i x_i mod q` |
| `NTT_k`                   | Length‑*k* forward Number‑Theoretic Transform         | `ntt64()`       |

All integers, vectors, and matrices are interpreted **little‑endian** unless indicated otherwise.

### 0.2 Dial Parameters

A **dial profile** defines the core cryptographic parameters.

| Symbol | Description                                | Baseline "S‑512"                |
| ------ | ------------------------------------------ | ------------------------------- |
| `Curve`| Elliptic Curve (for KZG and VRF)           | **BLS12-381** (Mandatory)       |
| `r`    | BLS12-381 subgroup order                   | (See §5.1)                      |

### 0.3 Version Triple

Every on‑chain 32‑byte digest begins with a **version triple**

```
Version = {major : u8 = 0x02, minor : u8 = 0x00, patch : u8 = 0x00}
digest  = Blake2s‑256( Version ‖ DomainID ‖ payload )
```

### 0.4 Domain Identifiers

`DomainID : u16` partitions digests by purpose.

| ID (hex)  | Domain                             | Source section |
| --------- | ---------------------------------- | -------------- |
|  `0x0000` | Internal primitives                | § 2–5          |
|  `0x0300` | Nil‑VRF transcripts                | § 5            |

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

Instead of a strict "1.1 second" wall-clock deadline, NilStore uses **Block-Height Tiered Rewards**.

**Let `H_challenge` be the block height where the Challenge is issued.**
**Let `H_proof` be the block height where the `MsgSubmitProof` is included.**
**Latency `L = H_proof - H_challenge`.**

| Tier | Latency (Blocks) | Reward Multiplier | Description |
| :--- | :--- | :--- | :--- |
| **Platinum** | `L <= 1` | **100%** | Immediate inclusion. Requires hot storage and low network latency. |
| **Gold** | `L <= 5` | **80%** | Fast inclusion. Tolerates minor network jitter. |
| **Silver** | `L <= 10` | **50%** | Slow inclusion. Standard HDD or congested network. |
| **Fail** | `L > 20` | **0% + Slash** | "Cold" storage (Glacier) or offline. Treated as data loss. |

### 4.3 Prover Obligations per DU Interval

1) **PoUD — KZG‑PDP (content correctness):** Provide KZG **multi‑open** at the chosen `Z` indices proving membership in `C_root`.
2) **Submission:** Broadcast `MsgSubmitProof` immediately to secure the highest Tier.

### 4.4 Verifier (On‑chain)

* **On‑chain:** Verify **KZG multi‑open** against `C_root` at point `Z`.
* **Tiering:** Calculate `Latency` based on inclusion height and award tokens/slashing accordingly.

---

## § 5 Nil‑VRF / Epoch Beacon (`nilvrf`)

We use a BLS12‑381‑based **verifiable random function (VRF)** to derive unbiased epoch randomness.

### 5.1 Notation & Parameters

| Object | Group | Encoding   | Comment                             |
| ------ | ----- | ---------- | ----------------------------------- |
| `pk`   | `G1`  | 48 B comp. | `pk = sk·G₁`                        |
| `π`    | `G2`  | 96 B comp. | Proof (BLS signature)               |
| `H`    | `G2`  | 96 B       | `H = hash_to_G2("BLS12381G2_XMD:SHA-256_SSWU_RO_NIL_VRF_H2G", msg)` |
| `e`    | —     | —          | Optimal Ate pairing `e: G1×G2→G_T`  |
| `Hash` | —     | 32 B       | Blake2s‑256, domain `"NIL_VRF_OUT"` |

Curve: **BLS12‑381**; subgroup order
`r = 0x73EDA753299D7D483339D80809A1D80553BDA402FFFE5BFEFFFFFFFF00000001`.

### 5.3 Epoch Beacon

For epoch counter `ctr`:

```
(y, π)   = vrf_eval(sk, pk, int_to_bytes_le(ctr, 8));
beacon_t = Blake2s‑256("NIL_BEACON" ‖ y);
```

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

### 6.1 Deal Lifecycle

1.  **Creation:** User sends `MsgCreateDeal`. Chain runs **System-Defined Placement**. `DealCreated` event emitted with assigned SPs.
2.  **Execution:** Every Epoch, chain derives new `Z` challenges. SPs submit proofs.
3.  **Settlement:** Validator verifies KZG, calculates **Tier** based on inclusion height, credits SP balance from Deal Escrow.

## Appendix A: Core Cryptographic Primitives

### A.3 File Manifest & Crypto Policy (Normative)

NilStore uses a content‑addressed file manifest.

  * **Root CID** = `Blake2s-256("FILE-MANIFEST-V1" || CanonicalCBOR(manifest))`.
  * **DU CID** = `Blake2s-256("DU-CID-V1" || ciphertext||tag)`.