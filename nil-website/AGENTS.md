# Website Specification Expansion Plan

This document outlines the high-level tasks required to expand `website-spec.md` into a comprehensive, file-by-file specification of the `nil-website` project.

**Status:** ALL TASKS COMPLETED (Spec updated to include all items below).

## 1. Core Configuration & Environment
- [x] **Build & Environment Spec:** Define exact configurations for `vite.config.ts`, `tsconfig.json`, and `tailwind.config.js`.
- [x] **Environment Variables:** Document all required `VITE_` env vars and their mapping in `src/config.ts`.
- [x] **Project Constants:** List all hardcoded constants (chain IDs, contract addresses, default endpoints).

## 2. Type System & Data Models
- [x] **Domain Interfaces:** Create a dedicated section defining TypeScript interfaces for core entities (`Deal`, `Provider`, `Proof`).
- [x] **API Response Types:** Specify the exact JSON shape returned by LCD and Gateway.
- [x] **Simulation Data Models:** Document the structure of JSON files in `src/data/`.

## 3. Global State (Context Providers)
- [x] **ProofContext:** Detail the streaming logic, polling intervals, and `addSimulatedProof` mechanism.
- [x] **ThemeContext:** Document the exact logic for system preference detection vs. manual override.
- [x] **Web3Provider:** detailed Wagmi/Viem configuration.

## 4. Hooks (Logic Layer)
- [x] **Transaction Hooks:** Fully specify `useCreateDeal` and `useUpdateDealContent` (EIP-712 Typed Data).
- [x] **Data Hooks:** `useUpload` (FormData), `useFaucet`, `useNetwork`.

## 5. UI Component Specifications
- [x] **Core/Layout:** `Layout.tsx`, `StatusBar.tsx`, `ConnectWallet.tsx`, `ModeToggle.tsx`.
- [x] **Dashboard Components:** `Dashboard`, `DealDetail`, `DealLivenessHeatmap`, `FileSharder`, `FaucetWidget`.
- [x] **Educational/Deep Dives:** `LatticeMap`.

## 6. Page Specifications
- [x] **Pages:** `AdversarialSimulation`, `Home`, `Leaderboard`, `Papers`, `ProofsDashboard`, `Technology`, `TestnetDocs`.

## 7. Utilities & Libraries
- [x] **Utils:** `src/lib/` function specs (`address.ts`, `status.ts`, `cn`).

## 8. Gap Analysis: Frontend vs. Protocol Spec

Future agents utilizing this documentation must be aware of the following architectural divergence detected during the review of `@spec.md` and `@nil-website/**`:

- **Triple Proof Model:** The frontend **does not** currently implement the Triple Proof verification logic described in `@notes/triple-proof.md`. It relies on the Gateway (`nil_gateway` / `nil_s3`) to perform these checks.
- **MDU Packing:** The frontend **does not** pack files into MDUs (as defined in `@spec.md`). It streams raw bytes to the Gateway via `useUpload`.
- **Simulation vs. Reality:** The `FileSharder.tsx` component is a visual simulation using SHA-256 and is **not** part of the actual transaction pipeline.
- **Action Item:** Future work involves compiling the Rust `nil_core` crate to Wasm to enable true "Thick Client" functionality (Local KZG generation, MDU packing, and autonomous SP negotiation) directly in the browser.

## 9. `nil_s3` Refactor: Implementing Filesystem on Slab (TDD Plan)

This section outlines the Test-Driven Development (TDD) plan for refactoring the `nil_s3` Gateway to implement the "Filesystem on Slab" architecture as defined in `notes/triple-proof.md`. Each step includes specific tests to pass before considering the task complete.

### 9.1 Task 1: Define Go Structs for MDU #0 Layout

**Description:** Define Go structs (`FileTableHeader`, `FileRecordV1`) for the MDU #0 Super-Manifest layout in a new package `nil_s3/pkg/layout`. This includes bit-packing logic for `length_and_flags`.

**TDD Plan:** Create `nil_s3/pkg/layout/layout_test.go` first.

1.  **`TestBitPacking`**:
    *   **Input:** A `length` value (e.g., 100), and specific `flags` (e.g., `Encrypted | Gzip`).
    *   **Expected Output:** A `u64` representing `length_and_flags` with the correct bit-packing.
    *   **Verification:** Decode the `u64` back into `length` and `flags`, asserting they match the input.
2.  **`TestStructAlignment`**:
    *   Use `unsafe.Sizeof` to assert that `FileRecordV1` is exactly 64 bytes.
    *   Assert that `FileTableHeader` is exactly 128 bytes.
3.  **`TestSerialization`**:
    *   Create an instance of `FileRecordV1` with sample data.
    *   Serialize it to a `[]byte`.
    *   Deserialize the `[]byte` back into a new `FileRecordV1` instance.
    *   Assert that the deserialized instance is deep-equal to the original.
    *   Repeat for `FileTableHeader`.

**Definition of Done:** `go test ./pkg/layout` passes with 100% coverage of struct definition and serialization/deserialization logic. All bit-packing and size assertions are correct.

### 9.2 Task 2: Implement `Mdu0Builder` Logic

**Description:** Develop a `Mdu0Builder` module responsible for initializing, modifying, and serializing the 8MB MDU #0 buffer. This builder must account for the Root Table containing roots for MDU #0 itself, **Witness MDUs**, and User Data MDUs.

**TDD Plan:** Create `nil_s3/pkg/builder/builder_test.go` first.

1.  **`TestInitEmptyMdu0`**:
    *   Create a new `Mdu0Builder` instance with `max_user_mdus` (e.g., 65536).
    *   Assert that the internal 8MB buffer is initialized correctly:
        *   The `FileTableHeader` has `magic="NILF"`, `version=1`, `record_size=64`, `record_count=0`.
        *   The Root Table region (Blobs 0-15) is zeroed.
        *   The File Table region (Blobs 16-63) is mostly zeroed (except header).
        *   **Verify `W` calculation**: Ensure `W` (Witness MDUs count) is correctly derived based on `max_user_mdus`.
2.  **`TestAppendFileRecord`**:
    *   Initialize an `Mdu0Builder`.
    *   Add a `FileRecordV1` for "file1.txt" (1KB at logical offset 0).
    *   Assert that `FileTableHeader.record_count` increments.
    *   Assert that `FileTable` entry at index 0 matches the input record.
    *   Add a second `FileRecordV1` for "file2.txt". Assert `record_count` is 2 and the second entry is correct.
3.  **`TestAddRoot`**:
    *   Initialize an `Mdu0Builder`.
    *   Add a dummy 32-byte root (e.g., all `0xAA`) for `MDU #1` (index 0).
    *   Assert that the Root Table region at the correct offset (Blob 0, Offset 0) contains this root.
    *   **Crucial:** This root corresponds to `MDU #1` (first Witness MDU).
4.  **`TestLoadAndModify`**:
    *   Initialize an `Mdu0Builder`, add a file record and a root.
    *   Serialize the builder's buffer to a `[]byte`.
    *   Create a *new* `Mdu0Builder` and `Load()` it from the `[]byte`.
    *   Add another file record and root.
    *   Assert that `record_count` and new root are correctly applied to the loaded state.
5.  **`TestFindFreeSpace_TombstoneSplitting`**: (Covers deletion/reuse logic)
    *   Initialize builder. Add a 100KB file. Delete it (mark as tombstone).
    *   Add a 30KB file. Assert that the 100KB tombstone is reused (partially), and a new 70KB tombstone is appended.
    *   Assert File Table count is correct.

**Definition of Done:** `go test ./pkg/builder` passes, creating valid 8MB binary images, and correctly handling the Root Table indexing for Witness and User Data MDUs.

### 9.3 Task 3: Refactor `GatewayUpload` (Service Layer)

**Description:** Modify the `GatewayUpload` handler (`nil_s3/main.go`) to utilize the `Mdu0Builder` and the new "Filesystem on Slab" logic, including the generation and storage of **Witness MDUs**.

**TDD Plan:** Create `nil_s3/main_test.go` (or a dedicated integration test package for handlers).

1.  **`TestUploadNewDealLifecycle`**:
    *   Mock `nil_cli` `shardFile` call to return dummy MDUs and roots for user data.
    *   Call `GatewayUpload` for "file_A.txt" (no `deal_id` provided, `max_user_mdus` specified).
    *   **Assert:** The response includes a *newly generated* `deal_id` (simulated) and the initial `manifest_root` for MDU #0.
    *   **Crucial:** `nil_s3` must now:
        *   Generate the actual content for MDU #0 (empty FAT, roots for Witness and User Data MDUs set to zeros/dummies).
        *   Generate **Witness MDUs** (filled with zeros initially).
        *   Store these `(1 + W)` initial MDUs to disk.
    *   Simulate subsequent `GatewayUpdateDealContent` call to commit this.
2.  **`TestUploadAppendToExistingDeal`**:
    *   Pre-populate deal state: an existing `deal_id` on chain, and on-disk representations for MDU #0, Witness MDUs, and existing User Data MDUs.
    *   Call `GatewayUpload` for "file_B.txt", providing the `deal_id`.
    *   **Assert:** The response contains the `manifest_root` reflecting "file_B.txt" appended to the File Table, and the new `allocated_length`.
    *   **Verification:** `nil_s3` must:
        *   Read the existing MDU #0 and Witness MDUs.
        *   Pack "file_B.txt" into new User Data MDUs.
        *   Generate/update corresponding roots in MDU #0.
        *   Generate/update corresponding Blob Commitments in Witness MDUs.
        *   Store updated MDU #0, Witness MDUs, and new User Data MDUs.
3.  **`TestUploadTombstoneReuse`**:
    *   Pre-populate deal with a deleted file.
    *   Call `GatewayUpload` for a new file that fits the deleted slot.
    *   **Assert:** `MDU #0` (and Witness MDUs) are updated reflecting reuse (and splitting if necessary).
4.  **`TestUploadLargeFileExpansion`**:
    *   Upload a file spanning multiple User Data MDUs.
    *   **Assert:** `Mdu0Builder` correctly adds multiple roots to the Root Table and `allocated_length` is updated correctly.
    *   **Verification:** Ensure Witness MDUs are correctly updated for all new User Data MDUs.

**Definition of Done:** The `GatewayUpload` handler correctly processes new file uploads, managing the MDU #0 and Witness MDUs states locally, and returning the necessary information for `MsgUpdateDealContent` (new `ManifestRoot`, `allocated_length`).

### 9.4 Task 4: Refactor `GatewayFetch` (Filesystem Resolution)

**Description:** Update the `GatewayFetch` handler to resolve files by their path within a Deal, rather than requiring a direct CID for a single file. This involves reading MDU #0 and retrieving Blob Commitments from Witness MDUs for proof generation.

**TDD Plan:** Extend `nil_s3/main_test.go` (or a dedicated integration test package for handlers).

1.  **`TestFetchByExistingPath`**:
    *   Setup deal state (MDU #0, Witness MDUs, User Data MDUs) with "video.mp4" via `Mdu0Builder`.
    *   Call `GatewayFetch(deal_id, path="video.mp4")`.
    *   **Assert:** `MDU #0` is correctly read and parsed to locate the `FileRecord`.
    *   **Crucial:** Assert Blob Commitments are correctly retrieved from **Witness MDUs** for the relevant User Data MDUs.
    *   Mock retrieval of the actual User Data MDUs. Assert the correct bytes are streamed back (e.g., via `httptest.ResponseRecorder`).
2.  **`TestFetchPathNotFound`**:
    *   Call `GatewayFetch` for non-existent path. Assert 404.
3.  **`TestFetchFromDeletedFile`**:
    *   Setup deal state with a file marked as a Tombstone.
    *   Call `GatewayFetch` for that path. Assert a 404.
4.  **`TestFetchOffsetMapping`**:
    *   Upload a file spanning multiple User Data MDUs.
    *   Request specific byte ranges within the file.
    *   **Assert:** Internal logic correctly maps `Logical_Offset` to `User_Data_MDU_Index` and `Offset_within_MDU`, and correctly retrieves commitments from Witness MDUs.

**Definition of Done:** `GatewayFetch` correctly resolves file paths, retrieves `FileRecord`s, reads Blob Commitments from Witness MDUs, and streams the correct byte ranges from the User Data MDUs.

### 9.5 Task 5: Implement `GatewayUpdateDealContent` Refactor (Chain Interaction)

**Description:** Modify `GatewayUpdateDealContentFromEvm` (and potentially `GatewayUpdateDealContent`) to properly handle the `allocated_length` field and ensure the on-chain representation matches the `nil_s3`'s understanding of the Deal's state.

**TDD Plan:** Create an integration test script (`test_lifecycle.sh`) that orchestrates chain operations.

1.  **`TestFullDealLifecycle_E2E`**:
    *   **Phase 1: Setup:** Start local `nilchaind` and `nil_s3`.
    *   **Phase 2: Create Deal:** Use `GatewayCreateDealFromEvm` (with `max_user_mdus` to imply max capacity) to establish a base deal.
        *   **Assertion:** Verify `allocated_length` on-chain equals `1 + W` (MDU #0 + Witness MDUs).
    *   **Phase 3: Upload File 1 (Expansion):**
        *   Call `GatewayUpload` for "first.txt" (e.g., 100KB).
        *   Capture the returned `manifest_root` and `new_allocated_length`.
        *   Call `GatewayUpdateDealContentFromEvm` with this data.
        *   **Assertion:** Query `nilchaind` to verify that the Deal on-chain now has the correct `manifest_root` and `allocated_length`.
    *   **Phase 4: Upload File 2 (Append):**
        *   Call `GatewayUpload` for "second.txt".
        *   Capture new `manifest_root` and `new_allocated_length`.
        *   Call `GatewayUpdateDealContentFromEvm`.
        *   **Assertion:** Query `nilchaind` to verify that the Deal on-chain has updated again.
    *   **Phase 5: Fetch & Verify:** Call `GatewayFetch` for "first.txt" and "second.txt". Assert content is correct.
    *   **Phase 6: Deletion & Reupload:** Simulate deletion, then re-upload a file to reuse space. Assert `manifest_root` updates correctly and `allocated_length` remains stable (if no new User Data MDUs were needed).

**Definition of Done:** The end-to-end chain interaction correctly updates the `Deal.manifest_root` and `Deal.allocated_length` on-chain, and these changes are reflected accurately when querying the chain.

---
