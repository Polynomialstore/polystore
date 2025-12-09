# RFC: Blob Alignment & Parity Striping

**Status:** Proposed Normative
**Scope:** Core Cryptography / Networking / Erasure Coding
**Depends on:** `spec.md`, `rfc-data-granularity-and-economics.md`

-----

## 1\. Motivation: The "Stripe Mismatch"

We face a critical friction point where the Cryptographic Layer (KZG) collides with the Networking Layer (Erasure Coding).

  * **Current Spec:** The Atomic Unit is the **MDU** (8 MiB).
  * **The Conflict:** In Mode 2 (StripeReplica), we intend to split this MDU across 12 providers using Reed-Solomon (RS 12,8).
      * Splitting an 8 MiB MDU implies 8 Data Shards of 1 MiB each.
      * **The Problem:** KZG commitments bind to a specific polynomial. You cannot simply "cut" a polynomial into 8 pieces and expect the pieces to be valid, independently verifiable KZG commitments.
      * **The Failure Mode:** If the MDU is the atomic KZG unit, an SP holding 1/8th of the data cannot verify their own shard without the other 7/8ths. This defeats the purpose of distributed striping.

**Decision:** We must align our atomic units with the physics of the underlying cryptography.

-----

## 2\. The Solution: "The Blob is the Atom"

We align NilStore with Ethereum's **EIP-4844** standard. This allows us to leverage existing hardware acceleration (ZK-ASIC) and optimized libraries (Gnark, Halo2).

### 2.1 The New Physics

1.  **The Cryptographic Atom (`BLOB`):** The 128 KiB Blob.
      * This is the smallest unit of KZG verification.
      * It corresponds to a polynomial of degree 4096 ($2^{12}$).
2.  **The Retrieval Unit (`MDU`):** A Vector of 64 Blobs.
      * $64 \times 128 \text{ KiB} = 8 \text{ MiB}$.
      * This preserves the 8 MiB "Shoebox" size for efficient networking, but internally it is composed of standard crypto-primitives.

-----

## 3\. The "Aligned" Striping Model (Mode 2)

We solve the striping issue by treating the MDU as a deck of cards (Blobs) rather than a single solid block.

**Configuration:** RS(12, 8) – 8 Data Shards, 4 Parity Shards.

### 3.1 The "Card Dealing" Algorithm

We have 64 Blobs ($B_0 \dots B_{63}$) that make up one 8 MiB MDU. We distribute them to 8 Data Providers ($SP_0 \dots SP_7$).

Instead of splitting blobs, we distribute complete blobs:

  * **$SP_0$ receives:** $B_0, B_8, B_{16}, \dots, B_{56}$ (Total 8 Blobs = 1 MiB).
  * **$SP_1$ receives:** $B_1, B_9, B_{17}, \dots, B_{57}$ (Total 8 Blobs = 1 MiB).
  * ...
  * **$SP_7$ receives:** $B_7, B_{15}, B_{23}, \dots, B_{63}$ (Total 8 Blobs = 1 MiB).

**Verification Benefit:** Since $SP_0$ holds 8 complete 128 KiB Blobs, they can verify each one individually using standard KZG. No cross-network chatter is required for self-verification.

### 3.2 Parity Calculation

To generate the 4 Parity Shards ($P_0 \dots P_3$):

  * We treat the Blobs as symbols in the Reed-Solomon encoding.
  * $P_0$ is calculated across the "row" of blobs ($B_0, B_1 \dots B_7$).
  * **Homomorphic Property:** Because KZG commitments are homomorphic, the Parity Shards are *also* valid 1 MiB chunks composed of valid 128 KiB KZG polynomials.
  * *Result:* Parity Nodes are indistinguishable from Data Nodes in terms of verification logic.

-----

## 4\. The Nested Architecture

We define a strict hierarchy to ensure alignment across the stack.

### Level 1: The Cryptographic Atom

  * **Name:** `BLOB`
  * **Size:** **131,072 bytes (128 KiB)**
  * **Property:** Has exactly 1 KZG Commitment (48 bytes).
  * **Why:** Aligns with EIP-4844. Maximizes compatibility with ZK-ASICs.

### Level 2: The Network Atom

  * **Name:** `SHARD`
  * **Size:** **8 BLOBs (1 MiB)**
  * **Property:** The unit of storage and transfer for a single SP in Mode 2.
  * **Why:** 1 MiB is the optimal UDP packet blast size for high-throughput P2P networking.

### Level 3: The Retrieval Unit

  * **Name:** `MDU` (Mega-Data Unit)
  * **Size:** **8 Data SHARDs + 4 Parity SHARDs (12 SHARDs Total)**
  * **Property:** The smallest unit of "Useful Data" requested by the User.
  * **Why:** 8 MiB payload matches the file system "Block" size for performance markets.

-----

## 5\. Specification Directives

### 5.1 Protocol Constants

```go
const BLOB_SIZE = 131072        // 128 KiB
const SHARD_SIZE = 1048576      // 1 MiB (8 Blobs)
const MDU_PAYLOAD_SIZE = 8388608 // 8 MiB (64 Blobs)
```

### 5.2 Protocol Layout (RS 12,8)

  * **Data Layout:** The 8 MiB MDU is sliced into 8 **Shards** of 1 MiB each.
  * **Shard Composition:** Each 1 MiB Shard contains 8 interleaved `BLOBs`.
  * **Parity:** 4 Parity Shards are generated. Each is 1 MiB (8 Blobs).
  * **Storage:** Each SP stores exactly **1 Shard (1 MiB)** per MDU.

### 6\. Conclusion

This architecture resolves the "Math Friction."

1.  **Standard Crypto:** We use standard EIP-4844 libraries without modification.
2.  **Clean Striping:** We stripe at the Blob level, ensuring every shard is a collection of valid polynomials.
3.  **Efficient I/O:** 1 MiB per SP is efficient for disk I/O, while 8 MiB per MDU is efficient for user retrieval.
