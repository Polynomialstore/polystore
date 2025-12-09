# Technical Specification: The Double Proof (Chained Verification)

This mechanism enables the blockchain to verify a specific byte of data (e.g., inside MDU \#500) while storing only a single 48-byte commitment (`ManifestRoot`) for the entire Deal.

### 1\. The Data Model

We separate the state into **On-Chain Commitments** (what the chain knows) and **Transition Proofs** (what the SP submits).

#### A. On-Chain State (`Deal`)

The blockchain stores only the root of the "Map."

```protobuf
// The Financial Container stored in the KVStore
message Deal {
    uint64 id = 1;
    // The KZG Commitment to MDU #0 (The Manifest).
    // This is the anchor of trust for the entire file.
    bytes manifest_root = 2; // 48-byte G1 Point
    uint64 total_mdus = 3;
    // ... other fields (owner, escrow, etc.)
}
```

#### B. Off-Chain State (`Manifest`)

The SP stores this as **MDU \#0**. It is a vector of KZG commitments treated as a polynomial.

```rust
// MDU #0: The "Map"
// Treated as a polynomial P(x) where:
// P(0) = Commitment_1
// P(1) = Commitment_2
// ...
struct Manifest {
    // List of KZG Commitments for all Data MDUs.
    // Each entry is a 48-byte BLS12-381 G1 Point.
    commitments: Vec<G1Point>, 
}
```

#### C. The Proof Object (`DoubleProof`)

When challenged, the SP constructs this object to bridge the gap between the Root and the Data.

```protobuf
// The input to MsgProveLiveness
message DoubleProof {
    // LAYER 1: The Identity Proof
    // Proves that 'target_commitment' is indeed at 'target_index' in the Manifest
    uint64 target_index = 1;
    bytes  target_commitment = 2;   // The "Value" of the manifest polynomial at 'index' (48 bytes)
    bytes  manifest_kzg_proof = 3;  // The KZG opening proof for Layer 1 (48 bytes)

    // LAYER 2: The Data Proof
    // Proves that 'data_value' is at 'random_point' in the Data MDU
    bytes  data_value = 4;          // The scalar field element (32 bytes)
    bytes  data_kzg_proof = 5;      // The KZG opening proof for Layer 2 (48 bytes)
}
```

-----

### 2\. The Verification Algorithm

The verifier (Chain Node) executes this logic inside the `MsgProveLiveness` handler. The function `VerifyDoubleProof` takes the `Deal` state, the random `Challenge`, and the `DoubleProof` input.

**Algorithm: `VerifyDoubleProof(Deal, Challenge, Proof)`**

1.  **Input Sanity Check:**

      * Ensure `Proof.target_index` matches the index requested in the `Challenge`.
      * Ensure `Proof.target_index < Deal.total_mdus`.

2.  **Layer 1: Verify Identity (The Map)**

      * *Goal:* Prove that the SP isn't lying about the KZG Commitment of the target chunk.
      * *Equation:* `VerifyKZG(Commitment, Point, Value, Proof)`
      * *Inputs:*
          * `Commitment` = `Deal.manifest_root` (From Chain State).
          * `Point` = `Proof.target_index` (The MDU Index).
          * `Value` = `Proof.target_commitment` (The intermediate G1 Point).
          * `Proof` = `Proof.manifest_kzg_proof`.
      * *Check:* If `VerifyKZG(...) == False`, **REJECT**. (SP provided a fake map).

3.  **Layer 2: Verify Data (The Territory)**

      * *Goal:* Prove that the SP possesses the data inside that chunk.
      * *Equation:* `VerifyKZG(Commitment, Point, Value, Proof)`
      * *Inputs:*
          * `Commitment` = `Proof.target_commitment` (Authenticated in Step 2).
          * `Point` = `Challenge.random_point` (From the Random Beacon).
          * `Value` = `Proof.data_value` (The actual byte/scalar).
          * `Proof` = `Proof.data_kzg_proof`.
      * *Check:* If `VerifyKZG(...) == False`, **REJECT**. (SP has the map but not the data).

4.  **Result:**

      * If both pass, return **TRUE**. The SP has proven possession of the specific byte requested by the protocol.

-----

### 3\. Why This Works (Cryptographic Binding)

The security relies on a strict chain of custody:

1.  **Chain -\> Manifest:** The SP cannot swap the Manifest because it must match `Deal.manifest_root`.
2.  **Manifest -\> Commitment:** The SP cannot swap the Chunk because KZG ensures that at `Index X`, the value *must* be `Commitment_X`. Any other value would fail the Layer 1 proof.
3.  **Commitment -\> Data:** The SP cannot fake the Data because it must open correctly against `Commitment_X`.

This effectively allows the blockchain to verify Petabytes of data while only holding a single 48-byte Root in its RAM.

