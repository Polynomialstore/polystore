# RFC: Blob Alignment & Parity Striping (Mode 2)

**Status:** Proposed Normative
**Scope:** Core Cryptography / Networking / Erasure Coding
**Depends on:** `spec.md`, `rfc-data-granularity-and-economics.md`, `notes/triple-proof.md`

-----

## 1. Motivation: The "Stripe Mismatch"

We face a critical friction point where the Cryptographic Layer (KZG) collides with the Networking Layer (Erasure Coding).

  * **Current Spec:** The Atomic Unit is the **MDU** (8 MiB).
  * **The Conflict:** In Mode 2 (StripeReplica), we split each 8 MiB SP‑MDU across `N = K+M` providers using Reed‑Solomon (RS(K, K+M), default `K=8`, `M=4`).
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

**Configuration:** RS(K, K+M) – `K` data slots, `M` parity slots, `N = K+M` total. Default profile: `K=8`, `M=4`, with constraint `K | 64`.

### 3.1 The "Card Dealing" Algorithm

We have 64 **data Blobs** (`data_blob_id ∈ [0..63]`) that make up one 8 MiB SP‑MDU.

Instead of splitting Blobs, we stripe by rows:

Let `rows = 64 / K` (requires `K | 64`) and define conceptual data Blobs `D[row][col]` with:
* `row ∈ [0..rows-1]`, `col ∈ [0..K-1]`
* `data_blob_id = row*K + col`

For each `row`, apply RS(K, K+M) across slots to produce shard Blobs `S[slot][row]` for all `slot ∈ [0..N-1]`. Each provider slot stores `rows` complete 128 KiB Blobs per SP‑MDU.

**Verification Benefit:** Since each provider holds complete 128 KiB Blobs, it can verify each one individually using standard KZG. No cross-network chatter is required for self-verification.

### 3.3 Locked: Slot-major `leaf_index` ordering (serve-first)

To prioritize serving/proving, Mode 2 defines the canonical Merkle leaf ordering for one SP‑MDU as **slot-major**.

Let:
* `K` = data slots, `M` = parity slots, `N = K+M`
* Constraint: `K | 64`
* `rows = 64 / K`
* `L = N * rows` (Merkle leaves per SP‑MDU)

Canonical mapping:
* `leaf_index = slot * rows + row`
* `slot = leaf_index / rows`
* `row  = leaf_index % rows`

In Mode 2, `ChainedProof.blob_index` MUST be interpreted as `leaf_index`. This makes the leaf ranges per provider slot contiguous (good for the hot path). RS repair still operates row-by-row but becomes strided in this ordering.

### 3.2 Parity Calculation & Homomorphism

To generate the `M` parity Blobs for each `row`:

  * We treat the Blobs as symbols in the Reed-Solomon encoding.
  * Parity is calculated across the row’s `K` data Blobs (`D[row][0..K-1]`).
  * **Homomorphic Property:** Because KZG commitments are homomorphic, the parity Blobs are also valid 128 KiB KZG polynomials with valid commitments.
  * *Result:* Parity Nodes are indistinguishable from Data Nodes in terms of verification logic. They hold valid Blobs with valid Commitments.

-----

## 4. The Replicated Metadata Policy (Crucial)

To enable **Shared-Nothing Verification** (where $SP_i$ can prove their shard without contacting others), we must replicate the "Map" to every node.

### 4.1 The Metadata MDUs

1.  **MDU #0 (Super-Manifest):** The Filesystem Inode/Root table.
2.  **Witness MDUs:** The array of all KZG Blob Commitments.

### 4.2 Replication Rule
For any Deal in Mode 2:
*   **User Data MDUs:** **Striped** (one slot’s shard Blobs per Provider).
*   **Metadata MDUs (MDU #0 + Witness):** **Fully Replicated** (Full Copy on All `N = K+M` Providers).

### 4.3 Witness Expansion (Parity Commitments)
For each data‑bearing SP‑MDU, the Witness MDUs MUST contain commitments for **ALL `L = (K+M) * (64/K)` shard Blobs** (data + parity).
* Default `K=8`, `M=4` gives `L=96` commitments per SP‑MDU.

This allows the Chain to challenge a Parity Node ($SP_9$) for a specific byte, and $SP_9$ can find the corresponding Commitment in their local Witness MDU to generate the proof.

-----

## 5. The Lifecycle & Verification Flow

This section defines the normative flow for a file "Life Cycle" in Mode 2.

### 5.1 Phase 1: Expansion (Client-Side)
1.  **Input:** 8 MiB user data (64 data Blobs).
2.  **Compute:** For each `row`, calculate `M` parity Blobs via RS‑encode (total parity Blobs = `rows*M`).
3.  **Commit:** Calculate KZG commitments for all shard Blobs (data + parity), total `L = (K+M)*(64/K)`.
4.  **Pack:** Store all `L` commitments in the Witness MDUs.

### 5.2 Phase 2: Distribution (Upload)
1.  **Deal:** Send Shard $i$ to $SP_i$.
2.  **Broadcast:** Send **Full Witness MDU** to all $SP_{0 \dots 11}$.

### 5.3 Phase 3: Challenge (Unified Liveness)
**Scenario:** Chain challenges $SP_1$ for `MDU #100, Blob #13`.
1.  **Routing:** Using the slot-major mapping, the chain computes `rows = 64 / K` and `slot = leaf_index / rows`. For default `K=8`, `rows = 8`, so `slot = 13 / 8 = 1`, therefore $SP_1$ is responsible.
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
const MDU_PAYLOAD_SIZE = 8388608 // 8 MiB (64 Blobs)
// Mode 2 parameters:
//   N = K+M
//   rows = 64 / K   (requires K | 64)
//   LEAVES_PER_MDU = N * rows
```

### 6.2 The Nested Hierarchy

1.  **Level 1 (Atom):** `BLOB` (128 KiB). The Unit of Cryptography.
2.  **Level 2 (Network):** `SLOT‑BLOBS` (a set of `rows` Blobs). The Unit of storage per provider slot for one SP‑MDU.
3.  **Level 3 (Retrieval):** `MDU` / `SP‑MDU` (8 MiB). The Unit of User Value.

## 7. Conclusion

This architecture resolves the "Math Friction" via **Alignment** and the "Verification Friction" via **Replicated Metadata**.

1.  **Standard Crypto:** We use standard EIP-4844 libraries.
2.  **Clean Striping:** We stripe at the Blob level.
3.  **Shared-Nothing Verification:** Every node has the global map (Witness) to prove their local fragment.
