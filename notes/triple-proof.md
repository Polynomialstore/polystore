# Technical Specification: The Triple Proof (NilFS Volume Architecture)

This mechanism enables the blockchain to verify a specific byte of data (e.g., inside file "video.mp4", MDU #500) while storing only a single 32-byte commitment (`ManifestRoot`) for the entire Deal.

It uses a **Hybrid Merkle-KZG** architecture to support efficient filesystem mapping and petabyte scalability.

### 1. The Data Model: "Elastic Filesystem on Slab"

We treat the Deal as an **Elastic Volume** (Slab). `MDU #0` is reserved as the **Super-Manifest**, containing the File Allocation Table (FAT) and the Sector Map. The Deal grows lazily: users pay for a Cap (e.g., 512GB) but only verify/store `AllocatedLength` MDUs initially.

#### A. On-Chain State (`Deal`)

The blockchain stores the Merkle Root of the reserved first MDU and tracks the "High Water Mark" of allocation.

```protobuf
message Deal {
    uint64 id = 1;
    // The Merkle Root of MDU #0 (The Super-Manifest).
    // MDU #0 is an 8MB unit containing the File Table and MDU Roots.
    bytes manifest_root = 14; // 32-byte Merkle Root (Poseidon/Sha256)
    
    // The Reservation (Max Capacity).
    uint64 total_mdus = 3;    // e.g. 65536 for 512GB.
    
    // The Working Set (High Water Mark).
    // Challenges are bounded to [0, allocated_length].
    // Updates require MsgUpdateDealContent.
    uint64 allocated_length = 4; // e.g. 10 (MDU #0 + 9 Data MDUs)
}
```

#### B. Off-Chain State (MDU #0: The Super-Manifest)

MDU #0 is an 8 MiB unit strictly partitioned into two regions:

| Blob Range | Content | Format | Capacity |
| :--- | :--- | :--- | :--- |
| **0 - 15** | **Root Table** | `[Scalar; 65536]` | Roots for 512GB |
| **16 - 63** | **File Table** | Header + `[FileRecord; N]` | ~98k Files |

**1. The Root Table (Blobs 0-15)**
A contiguous array of 32-byte BLS12-381 Scalars.
*   **Indexing:** `RootTable[i]` corresponds to the Merkle Root of Data MDU #`i+1`.
*   **Addressing:** `Root(i)` is located at `Offset = i * 32` within the 2MB region.
*   **Purpose:** Enables the Triple Proof. Proving `Root_i` exists in `Blob_k` of MDU #0 allows the chain to verify data in MDU `i+1`.

**2. The File Table (Blobs 16-63)**
A metadata region describing the files stored within the Data Slab (MDUs 1+).

**Header (Blob 16, Offset 0):**
```rust
struct FileTableHeader {
    magic: [u8; 4],      // "NILF" (0x4E494C46)
    version: u8,         // Version of this Header format (e.g., 1)
    record_size: u16,    // Size of each FileRecord in bytes (e.g., 64)
    record_count: u32,   // Number of active records
    _reserved: [u8; 117] // Padding
}
```

**Records (Blob 16+, Offset 128):**
```rust
struct FileRecordV1 {
    // Global byte offset from start of Data Slab (MDU #1).
    // This is the Logical Address in the Slab.
    start_offset: u64, // 8 bytes (Little Endian). Must be 32-byte aligned.

    // Exact length of the file in bytes (lower 56 bits).
    // Top 8 bits (MSB) are used for Flags (see below).
    length_and_flags: u64, // 8 bytes (Little Endian)

    // Unix epoch timestamp (seconds). 0 if unknown.
    timestamp: u64,    // 8 bytes (Little Endian)

    // Null-terminated filename/path. Padded with 0x00.
    // If path[0] == 0x00, the record is a TOMBSTONE (Deleted/Free).
    path: [u8; 40],    // 40 bytes
}
// Total Size: 64 Bytes.

// Flags (Top 8 bits of length_and_flags):
// Bit 7 (0x80): ENCRYPTED (1 if client-side encrypted, 0 otherwise)
// Bit 6 (0x40): HIDDEN / SYSTEM FILE (1 if not to be shown in normal listings)
// Bits 3-0 (0x0F): COMPRESSION_TYPE (Enum: 0=None, 1=Gzip, 2=Zstd, 3=Brotli, ...)
// Example: Encrypted & Zstd compressed file: (0x80 | 0x02) = 0x82.

```

#### C. The Proof Object (`ChainedProof`)

When challenged for `(MDU_Index, Blob_Index, Byte_Index)`, the SP provides:

```protobuf
message ChainedProof {
    // HOP 1: Manifest -> MDU Root (Merkle + KZG)
    // "I prove the Root for MDU #X is in MDU #0"
    bytes  manifest_blob_commitment = 1; // The KZG commit of the specific blob in MDU #0 containing the root list
    bytes[] manifest_merkle_path = 2;    // Path from ManifestRoot -> manifest_blob_commitment
    bytes  mdu_root_scalar = 3;          // The actual scalar value (the root of MDU #X)
    bytes  manifest_kzg_opening = 4;     // KZG Proof: manifest_blob(index) = mdu_root_scalar

    // HOP 2: MDU Root -> Data Blob (Merkle)
    // "I prove Data Blob #Y is in MDU #X"
    bytes  data_blob_commitment = 5;     // The KZG commit of the target data blob
    bytes[] mdu_merkle_path = 6;         // Path from mdu_root_scalar -> data_blob_commitment

    // HOP 3: Data Blob -> Byte (KZG)
    // "I prove Data Byte Z is in Blob #Y"
    bytes  z_value = 7;                  // Challenge point (derived)
    bytes  y_value = 8;                  // Evaluation (Data Byte)
    bytes  data_kzg_opening = 9;         // KZG Proof: data_blob(z) = y
}
```

-----

### 2. The Verification Algorithm

**Algorithm: `VerifyChainedProof(Deal, Challenge, Proof)`**

1.  **Context Derivation:**
    *   From `Challenge`, derive `Target_MDU_Index`.
    *   **Safety Check:** `Target_MDU_Index` must be < `Deal.allocated_length`.
    *   Calculate `Root_Table_Index` = `Target_MDU_Index - 1`. (Since RootTable[0] -> MDU#1).
    *   Calculate `Root_Table_Blob_Index` = `Root_Table_Index / 4096`.
    *   Calculate `Scalar_Offset` = `Root_Table_Index % 4096`.

2.  **Hop 1: Verify The Map (Manifest -> MDU Root)**
    *   *Merkle Check:* Verify `Proof.manifest_merkle_path` links `Proof.manifest_blob_commitment` to `Deal.manifest_root` at index `Root_Table_Blob_Index`.
    *   *KZG Check:* Verify `VerifyKZG(Proof.manifest_blob_commitment, Scalar_Offset, Proof.mdu_root_scalar, Proof.manifest_kzg_opening)`.
    *   *Result:* We now trust `Proof.mdu_root_scalar` is the true Merkle Root of the target MDU.

3.  **Hop 2: Verify The Molecule (MDU Root -> Data Blob)**
    *   *Merkle Check:* Verify `Proof.mdu_merkle_path` links `Proof.data_blob_commitment` to `Proof.mdu_root_scalar`.
    *   *Result:* We now trust `Proof.data_blob_commitment` is the true blob holding the data.

4.  **Hop 3: Verify The Atom (Data Blob -> Data Byte)**
    *   *KZG Check:* Verify `VerifyKZG(Proof.data_blob_commitment, Proof.z_value, Proof.y_value, Proof.data_kzg_opening)`.
    *   *Result:* The data byte is valid.

-----

### 3. Lifecycle & Filesystem Logic

#### 3.1 Initialization (Lazy Fill)
*   **Action:** User creates a Deal with `TotalMDUs = 65536` (512GB) but `AllocatedLength = 1` (Just MDU #0).
*   **State:** MDU #0 exists but is full of zeros (empty Root Table, empty File Table).
*   **Chain:** Verification challenges for MDU #0 are valid. Challenges for MDU #1+ are invalid (out of bounds).

#### 3.2 Sequential Write (Expansion)
*   **Scenario:** User uploads 1GB file.
*   **Gateway:**
    1.  Packs data into ~125 MDUs.
    2.  Updates `Root Table` in MDU #0 (indices 0..124).
    3.  Appends `FileRecord` to `File Table` in MDU #0.
*   **Chain:** User signs `MsgUpdateDealContent` updating `ManifestRoot` and setting `AllocatedLength = 126`.
*   **Safety:** Challenges for MDUs 1..125 are now valid.

#### 3.3 Deletion & Fragmentation (Tombstones)
*   **Scenario:** Delete a 64KB file.
*   **Action:** Gateway updates the `FileRecord` setting `path[0] = 0x00` (Tombstone). `start_offset` and `length` are preserved.
*   **Reuse (Splitting):** If a new 32KB file is uploaded:
    1.  Gateway finds the 64KB Tombstone.
    2.  Overwrites it with the new 32KB `FileRecord`.
    3.  Appends a *new* Tombstone record for the remaining 32KB hole at the end of the File Table.
    
#### 3.4 Compaction (Garbage Collection)
*   **Scenario:** File Table is full of fragmented Tombstones.
*   **Action:** Gateway reads all valid files, repacks them into a *fresh* Slab (starting at MDU #1), generates a clean MDU #0, and updates the Deal. This is computationally expensive but restores linearity.

*   **Extensibility:** Future versions can increase `record_size` (e.g., to add signatures) or update `FileTableHeader.version` without breaking the Root Table partition.

### Appendix E: Forward Compatibility - Mode 2 (Horizontal Erasure)

**Status:** Provisional / Design Note. Not implemented in v1.

While Mode 1 relies on full replication of the Slab, **Mode 2** enables high-throughput, fault-tolerant storage via **Horizontal Erasure Coding**.

#### 1. Concept: The Distributed Slab
In Mode 2, the 512GB "Slab" is not stored on one node. It is a **Virtual Volume** constructed on the fly from shards scattered across the network.

*   **Unit of Erasure:** The 8 MiB MDU.
*   **Algorithm:** Reed-Solomon $(k, n)$.
*   **Result:** Each MDU is split into $n$ fragments. Any $k$ fragments are sufficient to reconstruct the original MDU.

#### 2. On-Chain State (`Deal`)
The Deal object acts as the "RAID Controller".

```protobuf
message StripedDeal {
    // Erasure Constants
    uint32 data_shards = 1;   // k (e.g., 10)
    uint32 total_shards = 2;  // n (e.g., 30)
    
    // The Shard Map
    // List of Provider IDs (or Shard-Deal IDs) holding the fragments.
    repeated string shard_providers = 3; 
}
```

#### 3. Client Logic (The "Thick" Reader)
Retrieval becomes a parallel, distributed operation.

1.  **Resolve Topology:** Client queries chain for `k`, `n`, and `shard_providers`.
2.  **Mount Volume (Fetch MDU #0):**
    *   Client requests "Fragment #0" from $k$ different providers in parallel.
    *   Client performs **RS-Decode** to reconstruct the 8 MiB **Super-Manifest** (MDU #0) in memory.
    *   Client parses the **File Table** (see Appendix D) to map `video.mp4` -> `MDU Range`.
3.  **Fetch Data:**
    *   To read `MDU #50`, Client requests "Fragment #50" from $k$ providers.
    *   Client **RS-Decodes** to restore the data bytes.

#### 4. Uniformity
Crucially, the **File System Structure (FAT)** defined in Appendix D remains unchanged. The `FileRecord` points to offsets in the *Reconstructed Logical Volume*. The application layer (Filesystem) is agnostic to whether the underlying storage is a single local disk (Mode 1) or a distributed erasure-coded array (Mode 2).