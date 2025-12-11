# RFC: Blob Alignment & Parity Striping (Mode 2)

**Status:** Proposed Normative
**Scope:** Core Cryptography / Networking / Erasure Coding
**Depends on:** `spec.md`, `rfc-data-granularity-and-economics.md`, `notes/triple-proof.md`

-----

## 1. Motivation: The "Stripe Mismatch"

We face a critical friction point where the Cryptographic Layer (KZG) collides with the Networking Layer (Erasure Coding).

  * **Current Spec:** The Atomic Unit is the **MDU** (8 MiB).
  * **The Conflict:** In Mode 2 (StripeReplica), we split this MDU across 12 providers using Reed-Solomon (RS 12,8).
      * Splitting an 8 MiB MDU implies 8 Data Shards of 1 MiB each.
      * **The Problem:** KZG commitments bind to a specific polynomial. You cannot simply "cut" a polynomial into 8 pieces and expect the pieces to be valid, independently verifiable KZG commitments.
      * **The Failure Mode:** If the MDU is the atomic KZG unit, an SP holding 1/8th of the data cannot verify their own shard without the other 7/8ths. This defeats the purpose of distributed striping.

**Decision:** We must align our atomic units with the physics of the underlying cryptography.

-----

## 2. The Solution: "The Blob is the Atom"

We align NilStore with Ethereum's **EIP-4844** standard. This allows us to leverage existing hardware acceleration (ZK-ASIC) and optimized libraries (Gnark, Halo2).

### 2.1 The New Physics

1.  **The Cryptographic Atom (`BLOB`):** The 128 KiB Blob.
      * This is the smallest unit of KZG verification.
      * It corresponds to a polynomial of degree 4096 ($2^{12}$).
2.  **The Retrieval Unit (`MDU`):** A Vector of 64 Blobs.
      * $64 \times 128 \text{ KiB} = 8 \text{ MiB}$.
      * This preserves the 8 MiB "Shoebox" size for efficient networking, but internally it is composed of standard crypto-primitives.

-----

## 3. The "Aligned" Striping Model (Mode 2)

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

### 3.2 Parity Calculation & Homomorphism

To generate the 4 Parity Shards ($P_0 \dots P_3$):

  * We treat the Blobs as symbols in the Reed-Solomon encoding.
  * $P_0$ is calculated across the "row" of blobs ($B_0, B_1 \dots B_7$).
  * **Homomorphic Property:** Because KZG commitments are homomorphic, the Parity Shards are *also* valid 1 MiB chunks composed of valid 128 KiB KZG polynomials.
  * *Result:* Parity Nodes are indistinguishable from Data Nodes in terms of verification logic. They hold valid Blobs with valid Commitments.

-----

## 4. The Replicated Metadata Policy (Crucial)

To enable **Shared-Nothing Verification** (where $SP_i$ can prove their shard without contacting others), we must replicate the "Map" to every node.

### 4.1 The Metadata MDUs

1.  **MDU #0 (Super-Manifest):** The Filesystem Inode/Root table.
2.  **Witness MDUs:** The array of all KZG Blob Commitments.

### 4.2 Replication Rule
For any Deal in Mode 2:
*   **User Data MDUs:** **Striped** (1 Shard per Provider).
*   **Metadata MDUs (MDU #0 + Witness):** **Fully Replicated** (Full Copy on All 12 Providers).

### 4.3 Witness Expansion (Parity Commitments)
The **Witness MDU** MUST contain commitments for **ALL 12 SHARDS** (Data + Parity).
*   **Data Blobs:** 64 Commitments.
*   **Parity Blobs:** 32 Commitments.
*   **Total:** 96 Commitments per User MDU.

This allows the Chain to challenge a Parity Node ($SP_9$) for a specific byte, and $SP_9$ can find the corresponding Commitment in their local Witness MDU to generate the proof.

-----

## 5. The Lifecycle & Verification Flow

This section defines the normative flow for a file "Life Cycle" in Mode 2.

### 5.1 Phase 1: Expansion (Client-Side)
1.  **Input:** 8 MiB User Data (64 Blobs).
2.  **Compute:** Calculate 32 Parity Blobs via RS-Encode.
3.  **Commit:** Calculate KZG Commitments for **all 96 Blobs** (Data + Parity).
4.  **Pack:** Store all 96 Commitments in the **Witness MDU**.

### 5.2 Phase 2: Distribution (Upload)
1.  **Deal:** Send Shard $i$ to $SP_i$.
2.  **Broadcast:** Send **Full Witness MDU** to all $SP_{0 \dots 11}$.

### 5.3 Phase 3: Challenge (Unified Liveness)
**Scenario:** Chain challenges $SP_1$ for `MDU #100, Blob #13`.
1.  **Routing:** Chain determines `Blob_Index % 12 == 1`, so $SP_1$ is responsible.
2.  **Lookup:** $SP_1$ reads local **Witness MDU** to find `Commitment #13` and sibling commitments.
3.  **Proof Gen:**
    *   **Hop 1:** Verify `MDU_Root` vs `Manifest`.
    *   **Hop 2:** Verify `Commitment #13` vs `MDU_Root` (Merkle Proof using Witness data).
    *   **Hop 3:** Verify `Byte` vs `Commitment #13` (KZG Opening using local Data).
4.  **Submit:** $SP_1$ sends the chained proof. Chain verifies without knowing about striping.

### 5.4 Phase 4: Self-Healing (Repair)
**Scenario:** $SP_5$ fails. $SP_{New}$ assigned.
1.  **Fetch Map:** $SP_{New}$ downloads **Witness MDU** from any peer.
2.  **Fetch Shards:** $SP_{New}$ requests Row $X$ shards from $k$ peers.
3.  **Validate:** $SP_{New}$ checks each incoming shard against the **Witness MDU** (Trustless).
4.  **Reconstruct:** $SP_{New}$ runs RS-Decode to rebuild `Blob #5`.
5.  **Save:** $SP_{New}$ stores the recovered shard.

-----

## 6. Protocol Constants & Layout

### 6.1 Constants
```go
const BLOB_SIZE = 131072        // 128 KiB
const SHARD_SIZE = 1048576      // 1 MiB (8 Blobs)
const MDU_PAYLOAD_SIZE = 8388608 // 8 MiB (64 Blobs)
const STRIPE_WIDTH_N = 12       // Total Shards
const STRIPE_WIDTH_K = 8        // Data Shards
const WITNESS_BLOBS_PER_MDU = 96 // 64 Data + 32 Parity
```

### 6.2 The Nested Hierarchy

1.  **Level 1 (Atom):** `BLOB` (128 KiB). The Unit of Cryptography.
2.  **Level 2 (Network):** `SHARD` (1 MiB). The Unit of Storage per SP.
3.  **Level 3 (Retrieval):** `MDU` (8 MiB). The Unit of User Value.

## 7. Conclusion

This architecture resolves the "Math Friction" via **Alignment** and the "Verification Friction" via **Replicated Metadata**.

1.  **Standard Crypto:** We use standard EIP-4844 libraries.
2.  **Clean Striping:** We stripe at the Blob level.
3.  **Shared-Nothing Verification:** Every node has the global map (Witness) to prove their local fragment.
