# Technical Specification: The Triple Proof (NilFS Volume Architecture)

This mechanism enables the blockchain to verify a specific byte of data (e.g., inside file "video.mp4", MDU #500) while storing only a single 32-byte commitment (`ManifestRoot`) for the entire Deal.

It uses a **Hybrid Merkle-KZG** architecture to support efficient filesystem mapping and petabyte scalability.

### 1. The Data Model: "Elastic Filesystem on Slab"

We treat the Deal as an **Elastic Volume** (Slab) with a structured layout: **Super-Manifest (MDU #0)**, followed by **Witness MDUs**, and then **User Data MDUs**. The Deal grows lazily: users pay for a Cap (e.g., 512GB) but only verify/store `AllocatedLength` MDUs initially.

#### A. On-Chain State (`Deal`)

The blockchain stores the Merkle Root of the reserved first MDU and tracks the "High Water Mark" of allocation.

```protobuf
message Deal {
    uint64 id = 1;
    // The Merkle Root of MDU #0 (The Super-Manifest).
    // MDU #0 is an 8MB unit containing the File Table and MDU Roots.
    bytes manifest_root = 14; // 32-byte Merkle Root (Poseidon/Sha256)
    
    // The Reservation (Max Capacity) for User Data MDUs.
    // E.g. 65536 for 512GB of user data.
    uint64 max_user_mdus = 3;    
    
    // The Working Set (High Water Mark) of ALL MDUs, including MDU #0 and Witness MDUs.
    // Challenges are bounded to [0, allocated_length).
    // Updates require MsgUpdateDealContent.
    uint64 allocated_length = 4;
}
```

#### B. MDU #0: The Super-Manifest (Layout)

MDU #0 is an 8 MiB unit strictly partitioned into two regions:

| Blob Range | Content | Format | Capacity |
| :--- | :--- | :--- | :--- |
| **0 - 15** | **Root Table** | `[Scalar; 65536]` | Roots for 512GB |
| **16 - 63** | **File Table** | Header + `[FileRecord; N]` | ~98k Files |

**1. The Root Table (Blobs 0-15)**
A contiguous array of 32-byte BLS12-381 Scalars.
*   **Indexing:** `RootTable[i]` stores the Merkle Root of `MDU #(i)`. Note: MDU #0's root is not stored here (it's `Deal.manifest_root`). `RootTable[0]` refers to `MDU #1`, `RootTable[W]` refers to `MDU #(W+1)` (first User Data MDU).
*   **Addressing:** `Root(i)` is located at `Offset = i * 32` within the 2MB region of MDU #0.
*   **Purpose:** Enables the Triple Proof. Proving `Root_i` exists in `Blob_k` of MDU #0 allows the chain to verify data in MDU `i`.

**2. The File Table (Blobs 16-63)**
A metadata region describing the files stored within the User Data Slab.

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
    // Global byte offset from start of the FIRST USER DATA MDU.
    // I.e., `start_offset` = 0 means the first byte of MDU #(1+W).
    start_offset: u64, // 8 bytes (Little Endian)

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
// Bit 6 (0x40): HIDDEN / SYSTEM FILE (1 if not to be shown in standard listings)
// Bits 3-0 (0x0F): COMPRESSION_TYPE (Enum: 0=None, 1=Gzip, 2=Zstd, 3=Brotli, ...)
```

#### C. MDU #1..W: The Witness Data

This contiguous block of MDUs (immediately following MDU #0) stores the KZG Blob Commitments required for Hop 2 of the Triple Proof.

*   **Calculation of W (Number of Witness MDUs):**
    *   For `N` max_user_mdus, total blob commitments = `N * 64`.
    *   Total size of commitments = `N * 64 * 48 bytes`.
    *   `W = ceil( (N * 64 * 48) / (8 * 1024 * 1024) )`.
    *   Example: For `max_user_mdus = 65536` (512GB), `W = 24` MDUs.
*   **Structure:** Witness MDUs are a packed, contiguous array of 48-byte G1 Points (Compressed).
*   **Indexing:** The `kzg_commitment` for `User_Data_MDU_X, Blob_Y` is located at a deterministic offset within the Witness MDUs.

#### D. MDU #(W+1)..AllocatedLength-1: The User Data MDUs

These are the MDUs that store the actual file content (raw bytes).

---

### 2. The Verification Algorithm

**Algorithm: `VerifyChainedProof(Deal, Challenge, Proof)`**

1.  **Context Derivation:**
    *   From `Challenge`, derive `Target_MDU_Index` (the 0-indexed MDU number being challenged, starting from MDU #0).
    *   **Safety Check:** `Target_MDU_Index` must be < `Deal.allocated_length`.

2.  **Determine MDU Type:**
    *   If `Target_MDU_Index == 0`: MDU #0 (Super-Manifest). Hop 2 is to find a Root within its Root Table.
    *   If `Target_MDU_Index > 0` and `Target_MDU_Index <= W`: Witness MDU. Hop 2 is to find a Blob commitment for a Data MDU.
    *   If `Target_MDU_Index > W`: User Data MDU. Hop 2 is to find a Data Blob.

3.  **Hop 1: Verify The Map (MDU #0 Root -> Target MDU Root)**
    *   *Merkle Check:* Verify `Proof.manifest_merkle_path` links `Proof.manifest_blob_commitment` to `Deal.manifest_root` (the root of MDU #0) at `Root_Table_Blob_Index`.
    *   *KZG Check:* Verify `VerifyKZG(Proof.manifest_blob_commitment, Scalar_Offset, Proof.mdu_root_scalar, Proof.manifest_kzg_opening)`.
    *   *Result:* We now trust `Proof.mdu_root_scalar` is the true Merkle Root of `Target_MDU_Index`.

4.  **Hop 2: Verify The Molecule (Target MDU Root -> Data Blob Commitment)**
    *   **If `Target_MDU_Index` is a User Data MDU:**
        *   The SP needs to provide the KZG commitment for `User_Data_MDU_X, Blob_Y`.
        *   This commitment *must* be fetched from the appropriate offset within the **Witness MDUs**.
        *   *Merkle Check:* Verify `Proof.mdu_merkle_path` links this Witness-derived commitment to `Proof.mdu_root_scalar` (the root of the User Data MDU).
    *   **If `Target_MDU_Index` is MDU #0 or a Witness MDU:** (Simplified)
        *   The content of these MDUs is deterministic or derived.
        *   The Merkle Check would involve proving a fragment of the MDU itself. (This is a detail for a lower-level specification of witness MDUs).
    *   *Result:* We now trust `Proof.data_blob_commitment` is the true blob holding the data.

5.  **Hop 3: Verify The Atom (Data Blob Commitment -> Data Byte)**
    *   *KZG Check:* Verify `VerifyKZG(Proof.data_blob_commitment, Proof.z_value, Proof.y_value, Proof.data_kzg_opening)`.
    *   *Result:* The data byte is valid.

-----

### 3. Lifecycle & Filesystem Logic

#### 3.1 Initialization (Lazy Fill)
*   **Action:** User creates a Deal with `max_user_mdus = 65536` (512GB) but `allocated_length = 1 + W` (MDU #0 + Witness MDUs). `W` is derived from `max_user_mdus`.
*   **State:** MDU #0 (empty FAT, roots for MDU #1..W filled with zeros) and Witness MDUs (all zeros).
*   **Chain:** Verification challenges for MDU #0 and Witness MDUs are valid. Challenges for User Data MDUs are invalid (out of bounds).

#### 3.2 Sequential Write (Expansion)
*   **Scenario:** User uploads 1GB file.
*   **Gateway:**
    1.  Packs data into ~125 User Data MDUs.
    2.  Updates `Root Table` in MDU #0 for these User Data MDUs.
    3.  Updates **Witness MDUs** with the KZG Blob Commitments for these User Data MDUs.
    4.  Appends `FileRecord` to `File Table` in MDU #0.
*   **Chain:** User signs `MsgUpdateDealContent` updating `ManifestRoot` and setting `allocated_length = 1 + W + 125`.
*   **Safety:** Challenges for newly added User Data MDUs are now valid.

#### 3.3 Deletion & Fragmentation (Tombstones)
*   **Scenario:** Delete a 64KB file.
*   **Action:** Gateway updates the `FileRecord` setting `path[0] = 0x00` (Tombstone). `start_offset` and `length` are preserved.
*   **Reuse (Splitting):** If a new 32KB file is uploaded:
    1.  Gateway finds the 64KB Tombstone.
    2.  Overwrites it with the new 32KB `FileRecord`.
    3.  Appends a *new* Tombstone record for the remaining 32KB hole at the end of the File Table.
    
#### 3.4 Compaction (Garbage Collection)
*   **Scenario:** File Table is full of fragmented Tombstones.
*   **Action:** Gateway reads all valid files, repacks them into a *fresh* block of User Data MDUs (starting at MDU #(W+1)), generates clean MDU #0 and Witness MDUs, and updates the Deal. This is computationally expensive but restores linearity.

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
