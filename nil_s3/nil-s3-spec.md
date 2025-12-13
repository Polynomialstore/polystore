# NilStore S3 Adapter & Gateway Specification (`nil_s3`)

**Component:** `nil_s3`
**Role:** Web2 Gateway, S3 Compatibility Layer, and Devnet Relayer.
**Language:** Go.

## 1. Overview

`nil_s3` is a dual-purpose service that acts as:
1.  **S3-Compatible Adapter:** Allows legacy applications to `PUT` and `GET` objects using standard S3 semantics, transparently handling NilStore sharding and on-chain storage.
2.  **Web2 Gateway:** Provides REST endpoints for the `nil-website` frontend (Thin Client) to offload heavy cryptographic operations (MDU packing, KZG commitments) and chain interactions.

In the current **Devnet** architecture, `nil_s3` serves as a critical bridge, allowing the browser-based frontend to function without a WASM implementation of the core cryptography.

## 2. Architecture

The service wraps two CLI tools to perform its duties:
*   **`nil_cli`:** Used for **Sharding** (erasure coding) and **KZG Commitment** generation.
*   **`nilchaind`:** Used for **Transaction Signing**, **Broadcasting**, and **Querying** the Cosmos SDK chain (NilChain).

### 2.1 Storage Model
*   **Local Buffer:** Files are uploaded to a local `uploads/` directory.
*   **Indexing (Legacy/Debug):** A simple `index.json` maps `manifest_root` -> `{ local_file_path, filename }`. This is used to serve the *file-level* `nil_cli shard` JSON via `/gateway/manifest/{cid}` and to support legacy CID-based flows.
*   **Slab Architecture:**
    *   **MDU #0 (Super-Manifest):** Stores the File Allocation Table (FAT) and Merkle Roots for all other MDUs.
    *   **Witness MDUs:** Store the KZG Blobs required for Triple Proof verification (replicated metadata).
    *   **User Data MDUs:** Store the raw file content slices.
    *   Files are committed to a `dealDir` (e.g., `uploads/<ManifestRoot>/`) containing `manifest.bin`, `mdu_0.bin`, and numbered `mdu_N.bin` files.

---

## 3. API Endpoints

### 3.1 S3 Compatibility (Legacy)
| Method | Path | Description |
|:---|:---|:---|
| `PUT` | `/api/v1/object/{key}` | Uploads a file, shards it, and stores it locally. Returns `CID`. |
| `GET` | `/api/v1/object/{key}` | Retrieves a file by its original key (filename). |

### 3.2 Gateway (Web Frontend Support)
These endpoints support the `nil-website` "Thin Client" flow.

#### Data Ingestion
*   **`POST /gateway/upload`**
    *   **Input:** Multipart form data (`file`, `owner`).
    *   **Logic:** Saves the file, then performs *canonical NilFS ingest* (MDU #0 + Witness MDUs + User MDUs + `manifest_root`) using `nil_cli` for sharding/KZG. Work is request-scoped: cancellation/timeouts propagate into `nil_cli` subprocesses.
    *   **Options:** Supports `deal_id` (append into an existing deal) and `max_user_mdus` (devnet sizing hint for witness region).
    *   **Output:** JSON `{ "cid": "0x...", "manifest_root": "0x...", "size_bytes": 123, "file_size_bytes": 123, "allocated_length": 3, "filename": "..." }`.
    *   **Role:** Offloads canonical ingest and commitment generation from the browser (until thick-client parity is complete).

#### Deal Management (EVM Bridge)
*   **`POST /gateway/create-deal-evm`**
    *   **Input:** JSON `{ "intent": { ... }, "evm_signature": "0x..." }`.
    *   **Logic:** Forwards the intent to `nilchaind tx nilchain create-deal-from-evm`.
    *   **Role:** Relays user-signed intents to the Cosmos chain.
*   **`POST /gateway/update-deal-content-evm`**
    *   **Input:** JSON `{ "intent": { ... }, "evm_signature": "0x..." }`.
    *   **Logic:** Forwards to `nilchaind tx nilchain update-deal-content-evm`.
    *   **Role:** Commits the CID (returned from upload) to the on-chain deal.

#### Data Retrieval & Proofs
*   **`GET /gateway/fetch/{cid}`**
    *   **Query Params:** `deal_id`, `owner`.
    *   **Logic:**
        1.  Verifies `deal_id` exists on-chain and matches `owner`.
        2.  **Critical:** Calls `submitRetrievalProof` to generate and broadcast a `MsgProveLiveness` transaction on behalf of the provider (system/faucet key).
        3.  Streams the file content to the response.
    *   **Role:** Acts as a "Retrieval Proxy" that ensures on-chain proof generation ("Unified Liveness") occurs even for web downloads.
    *   **NilFS Path Fetch:** If `file_path` is provided, the gateway resolves the file from `uploads/<manifest_root>/mdu_0.bin` (NilFS File Table) and streams the requested file bytes. Proof submission is done asynchronously to keep downloads responsive in devnet.

*   **`GET /gateway/list-files/{cid}`**
    *   **Query Params:** `deal_id`, `owner` (required for access control / deal-owner match).
    *   **Logic:** Reads `uploads/<manifest_root>/mdu_0.bin`, parses the NilFS File Table, and returns file entries and computed total size.
    *   **Role:** The authoritative source for the Deal Explorer “Files (NilFS)” list.

*   **`GET /gateway/manifest/{cid}`**
    *   **Logic:** Returns the JSON manifest produced by `nil_cli shard`.
    *   **Role:** Allows the frontend deal inspector to visualize *file-level* sharding output. This is not the slab layout (MDU #0 / Witness / User) and may be misleading for multi-file deals.

---

## 4. Devnet Shortcuts & "The Gap"

To facilitate the "Store Wars" Devnet without a full WASM client, `nil_s3` takes several shortcuts:

1.  **The "Faucet Relayer":**
    *   Transactions generated by the Gateway (like `create-deal-from-evm` or `submit-retrieval-proof`) are typically signed and broadcast by a local **`faucet`** key.
    *   This acts as a "Meta-Transaction" layer, sponsoring gas for web users.

2.  **Triple Proof Generation:**
    *   The `submitRetrievalProof` logic uses `nilchaind sign-retrieval-receipt --offline` to generate cryptographic proofs.
    *   It relies on the local presence of the uploaded file (or a zero-filled 8 MiB buffer) and the generated `manifest_blob_hex` to construct valid Triple Proofs.
    *   **Gap:** In a production "Thick Client", the browser would generate these proofs locally or verify them from a remote SP. Here, the Gateway generates *and* submits them, effectively simulating a "perfect" SP.

3.  **Local Storage:**
    *   The Gateway currently acts as the *sole* Storage Provider for the devnet web interface. It does not distribute data to other nodes; it merely simulates the lifecycle of a storage deal backed by its local filesystem.

## 5. Future Roadmap

1.  **WASM Migration:** Move `shardFile` and `manifest` generation logic into `nil_core` WASM bindings for the browser.
2.  **Decoupling:** Separate the "S3 Adapter" (Provider logic) from the "Gateway" (Client relay logic).
3.  **P2P Integration:** The Gateway should fetch data from the actual `nil_p2p` network rather than serving from local disk.
