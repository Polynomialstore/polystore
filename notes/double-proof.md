Here is the precise Data Model and Algorithm for the **Double Proof (Chained Verification)** mechanism.

This logic allows the blockchain to verify a specific byte of data (e.g., inside MDU \#500) while storing only a single 48-byte hash (`ManifestRoot`) for the entire Deal.

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
    bytes manifest_root = 2; 
    uint64 total_mdus = 3;
    // ... other fields (owner, escrow, etc.)
}
```

#### B. Off-Chain State (`Manifest`)

The SP stores this as **MDU \#0**. It is a vector of commitments treated as a polynomial.

```rust
// MDU #0: The "Map"
// Treated as a polynomial P(x) where:
// P(0) = CID_1
// P(1) = CID_2
// ...
struct Manifest {
    cids: Vec<Bytes32>, // List of all Data MDU commitments
}
```

#### C. The Proof Object (`DoubleProof`)

When challenged, the SP constructs this object to bridge the gap between the Root and the Data.

```protobuf
// The input to MsgProveLiveness
message DoubleProof {
    // LAYER 1: The Identity Proof
    // Proves that 'target_cid' is indeed at 'target_index' in the Manifest
    uint64 target_index = 1;
    bytes  target_cid = 2;        // The "Value" of the manifest polynomial at 'index'
    bytes  manifest_kzg_proof = 3; // The KZG opening proof for Layer 1

    // LAYER 2: The Data Proof
    // Proves that 'data_value' is at 'random_point' in the Data MDU
    bytes  data_value = 4;
    bytes  data_kzg_proof = 5;     // The KZG opening proof for Layer 2
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

      * *Goal:* Prove that the SP isn't lying about the CID of the target chunk.
      * *Equation:* `VerifyKZG(Commitment, Point, Value, Proof)`
      * *Inputs:*
          * `Commitment` = `Deal.manifest_root` (From Chain State).
          * `Point` = `Proof.target_index` (The MDU Index).
          * `Value` = `Proof.target_cid` (The intermediate CID).
          * `Proof` = `Proof.manifest_kzg_proof`.
      * *Check:* If `VerifyKZG(...) == False`, **REJECT**. (SP provided a fake map).

3.  **Layer 2: Verify Data (The Territory)**

      * *Goal:* Prove that the SP possesses the data inside that chunk.
      * *Inputs:*
          * `Commitment` = `Proof.target_cid` (Authenticated in Step 2).
          * `Point` = `Challenge.random_point` (From the Random Beacon).
          * `Value` = `Proof.data_value` (The actual byte/field element).
          * `Proof` = `Proof.data_kzg_proof`.
      * *Check:* If `VerifyKZG(...) == False`, **REJECT**. (SP has the map but not the data).

4.  **Result:**

      * If both pass, return **TRUE**. The SP has proven possession of the specific byte requested by the protocol.

### 3\. Why This Works (Cryptographic Binding)

The security relies on a strict chain of custody:

1.  **Chain -\> Manifest:** The SP cannot swap the Manifest because it must match `Deal.manifest_root`.
2.  **Manifest -\> CID:** The SP cannot swap the Chunk because KZG ensures that at `Index X`, the value *must* be `CID_X`. Any other value would fail the Layer 1 proof.
3.  **CID -\> Data:** The SP cannot fake the Data because it must open correctly against `CID_X`.

This effectively allows the blockchain to verify Petabytes of data while only holding a single 48-byte Root in its RAM.
