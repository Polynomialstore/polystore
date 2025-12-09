# Technical Specification: The Triple Proof (Chained Verification)

This mechanism enables the blockchain to verify a specific byte of data (e.g., inside MDU #500) while storing only a single 48-byte commitment (`ManifestRoot`) for the entire Deal.

It uses a 3-layer hybrid architecture to balance storage efficiency (Merkle) with cryptographic agility (KZG).

### 1. The Data Model

We separate the state into **On-Chain Commitments** (what the chain knows) and **Transition Proofs** (what the SP submits).

#### A. On-Chain State (`Deal`)

The blockchain stores only the root of the "Map."

```protobuf
// The Financial Container stored in the KVStore
message Deal {
    uint64 id = 1;
    // The KZG Commitment to MDU #0 (The Manifest).
    // This is the anchor of trust for the entire file.
    // It commits to the polynomial P(x) where y = HashToFr(MDU_Merkle_Root).
    bytes manifest_root = 14; // 48-byte G1 Point
    uint64 total_mdus = 3;
    // ... other fields (owner, escrow, etc.)
}
```

#### B. Off-Chain State (`Manifest`)

The SP stores this as **MDU #0**. It is a vector of scalars (Field Elements) representing the Merkle Roots of all data MDUs.

```rust
// MDU #0: The "Map"
// Treated as a polynomial P(x) where:
// P(0) = HashToFr(MDU_Root_0)
// P(1) = HashToFr(MDU_Root_1)
// ...
struct Manifest {
    // List of Scalars (Fr) for all Data MDU Roots.
    // Each entry is a 32-byte BLS12-381 Scalar.
    mdu_roots_fr: Vec<Scalar>,
}
```

#### C. The Proof Object (`ChainedProof`)

When challenged, the SP constructs this object to bridge the gap between the Root and the Data in three hops.

```protobuf
// The input to MsgProveLiveness
message ChainedProof {
    // HOP 1: Deal -> MDU (KZG)
    // "I prove MDU #X is in the Manifest"
    uint64 mdu_index = 1;         // Index of the challenged MDU within the Manifest
    bytes  mdu_root_fr = 2;       // The field element (32-byte scalar) representing the MDU Merkle Root (after HashToFr)
    bytes  manifest_opening = 3;  // KZG Proof (48-byte G1 point) for ManifestRoot at mdu_index -> mdu_root_fr

    // HOP 2: MDU -> Blob (Merkle)
    // "I prove Blob #Y is in MDU #X"
    // (This uses the existing MDU Merkle structure)
    bytes challenged_kzg_commitment = 4;         // 48-byte G1 point (KZG commitment of the challenged 128 KiB blob)
    repeated bytes challenged_kzg_commitment_merkle_path = 5; // Merkle path (list of 32-byte hashes) from blob_commitment to mdu_merkle_root
    uint32 challenged_kzg_commitment_index = 6;  // Index of the challenged 128 KiB blob within the MDU (0-63)

    // HOP 3: Blob -> Data (KZG)
    // "I prove Data Byte Z is in Blob #Y"
    // (This uses the existing Blob KZG structure)
    bytes z_value = 7;                           // 32-byte scalar (challenge point for data in blob)
    bytes y_value = 8;                           // 32-byte scalar (evaluation at z)
    bytes kzg_opening_proof = 9;                 // 48-byte G1 point (KZG opening proof for the challenged blob)
}
```

-----

### 2. The Verification Algorithm

The verifier (Chain Node) executes this logic inside the `MsgProveLiveness` handler. The function `VerifyChainedProof` takes the `Deal` state, the random `Challenge`, and the `ChainedProof` input.

**Algorithm: `VerifyChainedProof(Deal, Challenge, Proof)`**

1.  **Input Sanity Check:**
      * Ensure `Proof.mdu_index` matches the MDU index requested in the `Challenge`.
      * Ensure `Proof.mdu_index < Deal.total_mdus`.

2.  **Hop 1: Verify Identity (The Map) [KZG]**
      * *Goal:* Prove that the SP isn't lying about the Merkle Root of the target MDU.
      * *Equation:* `VerifyKZG(Commitment, Point, Value, Proof)`
      * *Inputs:*
          * `Commitment` = `Deal.manifest_root` (From Chain State).
          * `Point` = `Proof.mdu_index` (The MDU Index).
          * `Value` = `Proof.mdu_root_fr` (The scalar value of the MDU root).
          * `Proof` = `Proof.manifest_opening`.
      * *Check:* If `VerifyKZG(...) == False`, **REJECT**.

3.  **Hop 2: Verify Structure (The MDU) [Merkle]**
      * *Goal:* Prove that the specific 128KB Blob is actually part of that MDU.
      * *Inputs:*
          * `Root` = `Proof.mdu_root_fr` (Must be converted back to bytes or verified against `HashToFr(MerkleRoot)`).
          * `Leaf` = `Hash(Proof.challenged_kzg_commitment)`.
          * `Path` = `Proof.challenged_kzg_commitment_merkle_path`.
      * *Check:* If `VerifyMerkleProof(...) == False`, **REJECT**.

4.  **Hop 3: Verify Data (The Blob) [KZG]**
      * *Goal:* Prove that the SP possesses the data inside that Blob.
      * *Equation:* `VerifyKZG(Commitment, Point, Value, Proof)`
      * *Inputs:*
          * `Commitment` = `Proof.challenged_kzg_commitment` (Authenticated in Hop 2).
          * `Point` = `Proof.z_value` (Derived from Challenge).
          * `Value` = `Proof.y_value` (The actual data evaluation).
          * `Proof` = `Proof.kzg_opening_proof`.
      * *Check:* If `VerifyKZG(...) == False`, **REJECT**.

5.  **Result:*
      * If all 3 hops pass, return **TRUE**. The SP has proven possession of the specific byte requested by the protocol.

-----

### 3. Why This Works (Hybrid Scaling)

This architecture solves the "Manifest Size" problem identified in earlier designs.

1.  **Scale Issue:** A 512 GB deal has ~4 million blobs. A Manifest listing 4 million KZG commitments (48 bytes each) would be ~200 MB. This is too big for the 8 MB "MDU #0" slot.
2.  **Solution:** We group blobs into 8 MB MDUs.
    *   **Layer 1 (Blob):** 128 KB. Identity = 48B Commitment.
    *   **Layer 2 (MDU):** 64 Blobs. Identity = 32B Merkle Root.
    *   **Layer 3 (Manifest):** List of MDU Roots.
3.  **Result:** A 512 GB deal has 65,536 MDUs.
    *   Manifest Size = $65,536 \times 32 \text{ bytes} \approx 2 \text{ MB}$.
    *   This fits comfortably in the 8 MB limit.
4.  **Security:** The chain of trust is unbroken.
    *   `Deal` locks the `Manifest`.
    *   `Manifest` locks the `MDU`.
    *   `MDU` locks the `Blob`.
    *   `Blob` locks the `Data`.