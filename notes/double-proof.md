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




### 4\. Disk Storage Breakdown

This breakdown calculates the exact storage footprint for the Blockchain, the Data Unit, and the Storage Provider at every layer of the architecture.



### Layer 1: The Atom (`Blob`)
* **Unit Size:** 128 KiB ($2^{17}$ bytes)
* **Identity:** KZG Commitment (48 bytes)

| Location | What is Stored? | Size Impact |
| :--- | :--- | :--- |
| **On-Chain** | **Nothing.** | 0 bytes. |
| **Inside DU** | **Raw Data.** The 128 KiB of user file data. | 128 KiB per blob. |
| **SP Side** | **Raw Data + Commitment.** The SP stores the blob data and its calculated commitment to generate proofs. | ~128.05 KiB (128KB Data + 48B Commitment). |

---

### Layer 2: The Brick (`MDU`)
* **Unit Size:** 8 MiB ($2^{23}$ bytes)
* **Composition:** 64 Blobs.
* **Identity:** Merkle Root (32 bytes).

| Location | What is Stored? | Size Impact |
| :--- | :--- | :--- |
| **On-Chain** | **Nothing.** | 0 bytes. |
| **Inside DU** | **Nothing.** The MDU *is* the container for the Blobs. | N/A |
| **SP Side** | **Merkle Tree Overhead.** The SP must store the intermediate hashes of the Merkle Tree to generate proofs quickly. | **~2 KB per MDU.** (64 leaves + intermediate nodes $\approx$ 127 hashes $\times$ 32 bytes). |

---

### Layer 3: The Warehouse (`Deal`)
* **Unit Size:** Variable (4 GB, 32 GB, 512 GB).
* **Identity:** Manifest Root (48-byte KZG Commitment).

| Location | What is Stored? | Size Impact |
| :--- | :--- | :--- |
| **On-Chain** | **The Manifest Root.** The single 48-byte anchor. | **Constant (48 bytes)** per Deal. |
| **Inside DU** | **The Manifest (MDU #0).** A reserved MDU containing the list of Layer 2 Merkle Roots. | **Variable** (depends on Deal Size). See SP Side below. |
| **SP Side** | **The Manifest File.** The SP stores MDU #0 which lists every MDU Root. | **Variable.** (See Calculation below). |

---

### Scale Analysis: On-Chain Storage
*Assumption:* We are scaling to **3 Exabytes (3 EiB)** of total network storage.
*Constraint:* The blockchain state database (`KVStore`) must fit in RAM/SSD.

**Calculation:**
* **Total Capacity:** $3 \text{ EiB} = 3,458,764,513,820,540,928$ bytes.
* **Struct Overhead:** Each Deal record is ~300 bytes (ID + Owner + Root + Metadata).

| Deal Size Tier | Number of Deals (Items) | Total Chain State Size | Feasibility |
| :--- | :--- | :--- | :--- |
| **4 GiB** | 805 Million | **~241 GB** | **High Load.** (Requires sharding/high-spec nodes). |
| **32 GiB** | 100 Million | **~30 GB** | **Healthy.** (Standard Cosmos chain load). |
| **512 GiB** | 6.2 Million | **~1.8 GB** | **Trivial.** (Extremely lightweight). |

**Conclusion:** We must incentivize users to aggregate into 32GB+ deals. If everyone uses 4GB deals, the chain state becomes heavy (240GB).

---

### Scale Analysis: Storage Provider (SP) Overhead
*Assumption:* The SP stores the "Manifest MDU" (MDU #0) to map the file. How big is this map?

**Constants:**
* Each MDU (8 MiB) requires 1 Merkle Root (32 bytes) in the map.
* Manifest Entry Size = 32 bytes.

**1. The 4 GiB Deal**
* **MDUs:** $4 \text{ GB} / 8 \text{ MB} = 512 \text{ MDUs}$.
* **Manifest Size:** $512 \times 32 \text{ bytes} = \mathbf{16 \text{ KB}}$.
* **Fit:** Fits easily in MDU #0 (8 MB capacity). 99.8% empty space.

**2. The 32 GiB Deal (Standard)**
* **MDUs:** $32 \text{ GB} / 8 \text{ MB} = 4,096 \text{ MDUs}$.
* **Manifest Size:** $4,096 \times 32 \text{ bytes} = \mathbf{131 \text{ KB}}$.
* **Fit:** Fits easily in MDU #0.

**3. The 512 GiB Deal (Wholesale)**
* **MDUs:** $512 \text{ GB} / 8 \text{ MB} = 65,536 \text{ MDUs}$.
* **Manifest Size:** $65,536 \times 32 \text{ bytes} = \mathbf{2 \text{ MB}}$.
* **Fit:** Fits comfortably in MDU #0 (25% utilization of the 8 MB reserved slot).

**Conclusion:** Even for the largest supported deal size (512 GB), the metadata overhead (The Map) is only **2 MB**. This is negligible compared to the 512 GB of data being stored.

### Summary Table

| Component | **On-Chain** (Global State) | **SP Side** (Per 32GB Deal) |
| :--- | :--- | :--- |
| **Layer 1 (Blob)** | 0 bytes | 32 GB (Raw Data) |
| **Layer 2 (MDU)** | 0 bytes | ~8 MB (Merkle Tree Hashes) |
| **Layer 3 (Deal)** | **48 bytes** (Manifest Root) | **131 KB** (Manifest File / MDU #0) |
| **Total** | **48 bytes** | **~32.01 GB** (Data + Metadata) |
