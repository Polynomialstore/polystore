# Technical Review: The Triple Proof & NilFS Architecture

> **⚠️ STATUS: DEFERRED (FUTURE ROADMAP)**
> This document outlines the **V2 Specification** for the NilFS Layout (Detached Paths & Inodes).
> **Current Decision (Dec 2025):** The project is proceeding with the **V1 (Fixed Table)** layout for the Devnet phase to prioritize simplicity. The architecture described below (FileRecordV2) is reserved for the Mainnet upgrade path.

**Date:** 2025-12-10
**Target Document:** `@notes/triple-proof.md`
**Reviewer:** Gemini (Agent)

This document outlines a technical review of the "Filesystem on Slab" (NilFS) architecture proposed for the Triple Proof system. While the core cryptographic architecture (Hybrid Merkle-KZG) is sound and elegant, there are significant practical limitations in the proposed "File Table" structure that may hinder the usability of the Wholesale Slab (512GB) product.

---

## 1. Critical Design Constraints

### A. The "Inode Exhaustion" Problem
The specification allocates a fixed region of **6 MB** for the File Table in `MDU #0` (Blobs 16-63).

*   **Fixed Capacity:** `6 MB` / `64 bytes per record` = **98,304 files (inodes)**.
*   **The Constraint:** For a **512GB Slab**, this imposes a rigid lower bound on average file size to utilize the full capacity.
    *   `512 GB / 98,304` ≈ **5.46 MB per file**.
*   **Real-World Impact:**
    *   If a developer uses the slab for source code, node modules, or documents (averaging ~50KB - 100KB), they will exhaust the 98k inode limit after storing only **~5GB to 10GB** of data.
    *   **Result:** The remaining ~500GB of the paid slab becomes unusable/unaddressable. The "Wholesale" proposition fails for "many small files" workloads.

**Recommendations:**
1.  **Linked Manifests (Pagination):** Allow `MDU #0` to point to an "Overflow Manifest MDU" when the table is full.
2.  **Directory Structure:** Adopt a true filesystem approach where directories are themselves files containing lists of inodes, allowing the file tree to grow dynamically within the User Data area.

### B. The `path` Constraint (Length & Privacy)
The `FileRecordV1` struct allocates a fixed **40-byte** array for the `path`.

```rust
path: [u8; 40],    // 40 bytes
```

*   **Length Limit:** 40 bytes is insufficient for modern file paths or even moderate nesting (e.g., `projects/frontend/src/components/List.tsx` is > 40 chars). This forces a "Flat Namespace" which contradicts the "Filesystem" abstraction.
*   **Privacy Leak:** The `whitepaper.md` promises a **Zero-Knowledge Cloud**. Storing plaintext filenames (e.g., `payroll_2025.csv` or `health_scan.pdf`) in `MDU #0` is a metadata leak.
*   **Encryption Incompatibility:** If the intention is to store *encrypted* paths:
    *   Authenticated Encryption (AES-GCM) requires IV + Tag (~28 bytes overhead).
    *   This leaves only **12 bytes** for the actual encrypted filename. This is structurally impossible for meaningful names.

**Recommendations:**
1.  **Hashed References:** Store a 32-byte `Hash(Path)` or a numeric `InodeID` in the fixed record.
2.  **Detached Metadata:** Store the actual (encrypted) filenames and directory hierarchy in a special "Metadata File" (e.g., Inode 1) stored within the User Data MDUs. This allows for arbitrary path lengths and full encryption.

---

## 2. Architecture Characterization

### The Mental Model: "NILFS"
The proposal effectively moves the filesystem logic into "User Space" (or rather, "Deal Space"). The "Disk" is the Deal (Slab). `MDU #0` acts as the **Superblock + Inode Table**.
*   **Pros:** This is excellent for portability. The entire filesystem structure moves with the data. It allows "Lazy Filling" (Thin Provisioning), where users pay for the *reservation* (512GB) but only prove/store the *allocation*.
*   **Cons:** It inherits the rigidity of old-school filesystems (like FAT16/FAT32) regarding fixed table sizes.

### The "Witness MDU" Cache
The concept of **Witness MDUs** (storing pre-computed KZG Blob Commitments) is a smart optimization.
*   **Purpose:** It acts as a persistent, on-chain-verifiable "cache" of the Merkle Leaves.
*   **Benefit:** Without this, generating a proof for `Byte X` would require reading the entire 8MB MDU to re-compute the Blob Commitment on the fly. With Witness MDUs, the SP just does an O(1) lookup.

---

## 3. Cryptographic Verification Path (Clarification)

The `VerifyChainedProof` algorithm needs precise definition regarding the role of Witness MDUs.

*   **My Understanding:**
    *   **Hop 1 (Map):** `Manifest_Root` -> verifies -> `User_MDU_Root`.
    *   **Hop 2 (Molecule):** `User_MDU_Root` -> verifies -> `Blob_Commitment`.
    *   **Hop 3 (Atom):** `Blob_Commitment` -> verifies -> `Data_Byte`.
*   **Observation:** The **Witness MDU** itself is *not* strictly in the cryptographic verification chain for the data. It is a storage mechanism for the *Prover* to efficiently find the `Blob_Commitment` needed for Hop 2.
    *   *Correction Check:* Unless the `User_MDU_Root` is actually a root of the *Witness MDU*? No, the spec says `RootTable[i]` stores the Merkle Root of `MDU #(i)`.
    *   **Conclusion:** The Witness MDUs are purely an "Acceleration Structure". The Chain verifies `Proof.blob_commitment` against `Proof.mdu_root`. It does not care *where* the Prover got the commitment from, as long as the Merkle Path is valid.

---

## 4. Proposed Schema Updates

To address the limitations in Section 1, I propose iterating on the `FileRecord` structure.

**Draft Proposal: `FileRecordV2` (Detached Filenames)**

```rust
struct FileRecordV2 {
    // 1. Location (8 bytes)
    start_offset: u64, 
    
    // 2. Metadata (8 bytes)
    // - Length (56 bits)
    // - Flags (8 bits): Encrypted, Hidden, Compression
    length_and_flags: u64, 
    
    // 3. Time (8 bytes)
    timestamp: u64, 
    
    // 4. Identity (32 bytes)
    // A stable identifier for the file. 
    // Could be Hash(EncryptedPath) or a UUID.
    // The actual human-readable Name/Path is stored in a separate
    // hidden file (e.g. Inode #0 of the User Data) that maps 
    // file_hash -> encrypted_path_string.
    file_hash: [u8; 32], 

    // Padding (8 bytes) to reach 64 bytes? 
    // Or just use 56 bytes to pack more records?
    // Current V1 is 64 bytes. 
}
```

*   **Trade-off:** This adds complexity. The client must read/write a "Manifest File" inside the data slab to resolve paths.
*   **Benefit:** Unlimited path lengths, full privacy, and decoupling of "Physical Storage Layout" (Offset/Length) from "Logical Directory Structure" (Names/Folders).
