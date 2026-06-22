# Technical Specification: The Triple Proof (PolyFS Volume Architecture)

This mechanism enables the blockchain to verify a specific blob of data (e.g., inside file "video.mp4", MDU #500) while storing only a single deal root for the entire Deal.

It uses a **Hybrid Merkle-KZG** architecture to support efficient filesystem mapping and large slab verification.

**Normative root contract:** `rfcs/rfc-polyfs-root-contract.md` is the source of truth for the MDU #0 trust root migration tracked by issue #212. This note describes the resulting architecture.

### 0. Naming & API Implications (PolyFS SSoT)

*   **`polyfs_root` is deal-level:** A 32-byte Merkle root over the 64 KZG commitments of MDU #0. This root anchors the entire slab because MDU #0 contains the root table for all other MDUs. Some transitional codepaths may still label this value `manifest_root` or `cid`; those names are legacy aliases and MUST NOT imply the retired 48-byte flat-manifest KZG root.
    *   Canonical string form for logs/responses: `0x` + lowercase hex (64 chars).
    *   Canonical on-disk directory key `polyfs_root_key`: lowercase hex **without** `0x` (64 chars), derived by decoding then re-encoding (not by string trimming alone).
    *   Parsing must be strict: reject non-hex, wrong-width, or legacy 96-hex roots for new committed deals (return `400` in gateway APIs).
*   **`file_path` is file-level:** The authoritative identifier for a file *within* a deal. Retrieval/proof APIs must be keyed by `(deal_id, polyfs_root, file_path)` and resolved from PolyFS (`uploads/deals/<deal_id>/<polyfs_root_key>/mdu_0.bin` + on-disk `mdu_*.bin`), with no fallback to `uploads/index.json` or “single-file deal” heuristics.
    *   `file_path` MUST be unique within a deal. If an upload targets an existing `file_path`, the gateway must overwrite deterministically (update-in-place or tombstone + replace) so fetch/prove cannot return stale bytes.
    *   `GET /gateway/list-files/...` should return a deduplicated view (latest non-tombstone record per `file_path`). If the on-disk File Table contains ambiguous duplicates, fail fast with a clear non-200 (prefer `409`) until repaired.
*   **`owner` is access control (gateway):** Gateway REST APIs that serve or prove deal content (e.g., `/gateway/fetch`, `/gateway/list-files`, `/gateway/prove-retrieval`) MUST require the deal owner (`owner`, PolyStore Chain bech32) alongside `deal_id` and verify `(deal_id, owner)` against chain state. Owner mismatches must return a clear non-200 (prefer `403`) as JSON.
*   **`file_path` must be canonical:** Treat it as a relative, slash-separated path (no leading `/`, no `..` traversal, no `\\` separators, reject empty/whitespace-only). Gateways must decode **at most once** (URL query params are decoded by the HTTP stack; JSON bodies are already-decoded strings) and match case-sensitively against PolyFS File Table entries.
    *   Beware `+` vs `%20`: Go’s query parser treats `+` as space. Clients MUST use `%20` for spaces (JS `encodeURIComponent`) and servers should treat decoded strings as canonical.
*   **Gateway error contract (target):** Missing/empty/unsafe `file_path` is a hard `400` with a remediation hint; tombstone/not-found is `404`; stale `polyfs_root` (doesn’t match chain deal state, including the thin-provisioned “empty root” case) should be a clear non-200 (prefer `409`). Errors MUST be JSON (and set `Content-Type: application/json`) even when the success path is a byte stream.
    *   If the PolyFS File Table is internally inconsistent (e.g., ambiguous duplicate `file_path` entries), the gateway should return a clear non-200 (prefer `409`) rather than serving potentially stale bytes.

### 1. The Data Model: "Elastic Filesystem on Slab"

We treat the Deal as an **Elastic Volume** (Slab) with a structured layout: **Super-Manifest (MDU #0)**, followed by **Witness MDUs**, and then **User Data MDUs**.

*   **Thin provisioning (no tiers):** Deals are created with `polyfs_root = empty`, `size = 0`, `total_mdus = 0` until the first `MsgUpdateDealContent*` commits the initial slab root. Any sizing inputs (e.g., `max_user_mdus` used to size the Witness region) are devnet policy parameters, not user-selected tiers.
*   **High-water mark:** Once enforced, `Deal.total_mdus` is the on-chain upper bound for valid `(mdu_index, ...)` challenges/receipts. Some gateway APIs may surface this as `allocated_length` / `total_mdus` in responses.

#### A. On-Chain State (`Deal`)

The blockchain stores `polyfs_root`, the Merkle root of MDU #0's 64 KZG commitments, and tracks the "High Water Mark" of the slab in MDUs.

```protobuf
message Deal {
    uint64 id = 1;
    // 32-byte Merkle root over the 64 KZG commitments for MDU #0.
    // MDU #0's root table commits to the list of per-MDU roots after MDU #0.
    bytes polyfs_root = 2;

    // Current size of committed content in bytes (mutable).
    uint64 size = 3;

    // High-water mark for the slab in 8 MiB MDUs (includes MDU #0, Witness MDUs, User Data MDUs).
    // Challenges and receipts must satisfy: mdu_index < total_mdus.
    uint64 total_mdus = 14;
}
```

#### B. MDU #0: The Super-Manifest (Layout)

MDU #0 is an 8 MiB unit strictly partitioned into two regions:

| Blob Range | Content | Format | Capacity |
| :--- | :--- | :--- | :--- |
| **0 - 15** | **Root Table** | `[Scalar; 65536]` | Roots for MDUs #1..#65536 |
| **16 - 63** | **File Table** | Header + `[FileRecord; N]` | ~98k Files |

**1. The Root Table (Blobs 0-15)**
A contiguous array of 32-byte BLS12-381 Scalars.
*   **Indexing:** `RootTable[i]` stores the deterministic field binding for the per-MDU root of `MDU #(i+1)` in slab order. `RootTable[0]` refers to `MDU #1` (first Witness MDU) and `RootTable[W]` refers to `MDU #(W+1)` (first User Data MDU).
*   **Addressing:** `Root(i)` is located at `Offset = i * 32` within the 2MB region of MDU #0.
*   **Encoding:** For each target MDU root, compute `mdu_root_fr = ReduceMduRootToFr(mdu_root)` and store `FrToBytesBE(mdu_root_fr)`. The exact reduction is frozen in `rfcs/rfc-polyfs-root-contract.md`; implementations must not silently choose a different reduction.
*   **Purpose:** The on-disk "map" for mounting the slab and generating proofs. The chain verifies root-table openings against the MDU #0 DU commitment that is Merkle-included under `Deal.polyfs_root`, not by reading `RootTable` directly.

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
    *   For a *planned* maximum of `N_user_mdus`, total blob commitments = `N_user_mdus * commitments_per_user_mdu`.
    *   `commitments_per_user_mdu` is the target MDU root profile leaf count selected by the committed deal mode/profile. Replicated user MDUs use 64. Mode 2 striped user SP-MDUs use `L = (K+M)*(64/K)`; the default `K=8`, `M=4` profile uses 96.
    *   Total size of commitments = `N_user_mdus * commitments_per_user_mdu * 48 bytes`.
    *   `W = ceil( (N_user_mdus * commitments_per_user_mdu * 48) / (8 * 1024 * 1024) )`.
    *   A Mode 2 gateway/client MUST NOT reserve Witness MDUs with the old `N_user_mdus * 64` formula, because that omits parity-slot commitments and prevents proofs for leaves `64..95`.
    *   **Devnet note:** `N_user_mdus` is currently an off-chain input (e.g., a gateway/client parameter). The on-chain Deal does not store this reservation.
*   **Structure:** Witness MDUs are a packed, contiguous array of 48-byte G1 Points (Compressed).
*   **Indexing:** The `kzg_commitment` for `User_Data_MDU_X, Blob_Y` is located at a deterministic offset within the Witness MDUs.

#### D. MDU #(W+1)..(total_mdus-1): The User Data MDUs

These are the MDUs that store the actual file content after scalar packing.
Each 8 MiB encoded user MDU carries `(8 MiB / 32) * 31 = 8,126,464`
raw payload bytes. Content admission and `size_bytes` validation must use this
raw payload capacity, not `user_data_mdus * 8 MiB`.

---

### 2. The Verification Algorithm

**Algorithm: `VerifyChainedProof(Deal, Challenge, Proof)`**

1.  **Context Derivation:**
    *   From `Challenge`, derive `Target_MDU_Index` (the 0-indexed MDU number being challenged, starting from MDU #0).
    *   **Safety Check:** `Target_MDU_Index` must be < `Deal.total_mdus`.
    *   **Content-proof Check:** Retrieval and liveness challenges MUST target a user-data MDU: `Target_MDU_Index > W`. MDU #0 and Witness MDUs are metadata regions, not content-proof targets.

2.  **Determine MDU Type:**
    *   If `Target_MDU_Index == 0`: reject this proof shape. A future metadata proof for bytes inside MDU #0 needs the separate direct path `Deal.polyfs_root -> MDU0.DU commitment -> KZG opening`, not the root-table path below.
    *   If `Target_MDU_Index > 0` and `Target_MDU_Index <= W`: reject this content-proof shape. Witness MDUs cache replicated metadata for proof generation; they must not satisfy retrieval or liveness challenges for user data.
    *   If `Target_MDU_Index > W`: User Data MDU. Hop 2 is to find a Data Blob.

3.  **Hop 1a: Verify The Super-Manifest DU (Deal Root -> Root-Table DU Commitment) [Merkle]**
    *   Because `Target_MDU_Index == 0` was rejected above, compute `root_table_index = Target_MDU_Index - 1`, `root_table_du = root_table_index / 4096`, and `root_table_cell = root_table_index % 4096`.
    *   *Merkle Check:* Verify the supplied root-table DU commitment is included in `Deal.polyfs_root` at `root_table_du`.

4.  **Hop 1b: Verify The Map Cell (Root-Table DU -> Target MDU Root) [KZG]**
    *   Derive `mdu_root_fr = ReduceMduRootToFr(Proof.mdu_root)`.
    *   *KZG Check:* Verify the root-table DU KZG opening at `root_table_cell` returns `mdu_root_fr`.
    *   *Result:* We now trust `Proof.mdu_root` is the true root for `Proof.mdu_index`.

5.  **Hop 2: Verify The Molecule (MDU Root -> Blob Commitment) [Merkle]**
    *   The prover supplies `Proof.blob_commitment` (48 bytes) and `Proof.merkle_path`.
    *   *Merkle Check:* Select the target MDU root profile from the committed deal mode/profile and MDU kind, reject `Proof.blob_index` outside that profile's leaf count, then verify `VerifyMerkle(Proof.mdu_root, Proof.blob_commitment, Proof.merkle_path)` at `Proof.blob_index`.
    *   *Leaf Count:* MDU #0, Witness MDUs, and Mode 1 replicated user MDUs use 64 leaves. Mode 2 striped user SP-MDUs use the slot-major `leaf_index` and `L = (K+M)*(64/K)` leaves from `rfcs/rfc-blob-alignment-and-striping.md` (96 leaves for the default `K=8`, `M=4` profile).
    *   **Note:** Witness MDUs are an acceleration structure for the prover to *find* `blob_commitment`; they are not required in the on-chain verification chain.

6.  **Hop 3: Verify The Atom (Blob Commitment -> Data Byte) [KZG]**
    *   *KZG Check:* Verify `VerifyKZG(Proof.blob_commitment, Proof.z_value, Proof.y_value, Proof.kzg_opening_proof)`.
    *   *Result:* The data byte is valid.

-----

### 3. Lifecycle & Filesystem Logic

#### 3.1 Initialization (Lazy Fill)
*   **CreateDeal (thin):** `polyfs_root = empty`, `size = 0`, `total_mdus = 0`. No content challenges are meaningful until a root is committed.
*   **First Commit (gateway/provider):**
    1. Initialize a slab as `MDU #0 + W Witness MDUs` (all zero-filled/empty) plus any required User Data MDUs.
    2. Compute the new `polyfs_root`.
*   **Chain:** User signs `MsgUpdateDealContent*` to set `Deal.polyfs_root`, `Deal.size`, and advance `Deal.total_mdus` to reflect the committed slab. Challenges for newly added MDUs become valid when `mdu_index < total_mdus`.

#### 3.2 Sequential Write (Expansion)
*   **Scenario:** User uploads 1GB file.
*   **Gateway:**
    1.  Packs data into ~125 User Data MDUs.
    2.  Updates `Root Table` in MDU #0 for these User Data MDUs.
    3.  Updates **Witness MDUs** with the KZG Blob Commitments for these User Data MDUs.
    4.  Appends `FileRecord` to `File Table` in MDU #0.
*   **Chain:** User signs `MsgUpdateDealContent` updating `polyfs_root`, `size`, and setting `total_mdus = 1 + W + 125`.
*   **Safety:** Challenges for newly added User Data MDUs are now valid (`mdu_index < total_mdus`).

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
