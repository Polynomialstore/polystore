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
*   **Slab Architecture:**
    *   **MDU #0 (Super-Manifest):** Stores the File Allocation Table (FAT) and Merkle Roots for all other MDUs.
    *   **Witness MDUs:** Store the KZG Blobs required for Triple Proof verification (replicated metadata).
    *   **User Data MDUs:** Store the raw file content slices.
    *   Files are committed to a `dealDir` (e.g., `uploads/<manifest_root>/`) containing `mdu_0.bin` and numbered `mdu_N.bin` slab files.
        *   Any extra debug artifacts (e.g., shard JSON, `manifest_blob_hex`) are optional and must not be required for fetch/prove.
*   **NilFS is the Source of Truth (Target End State):**
    *   The gateway MUST be able to list files, fetch bytes, and generate proofs by reading `uploads/<manifest_root>/mdu_0.bin` (File Table) and the on-disk `mdu_*.bin` slab — without any auxiliary index or in-memory state.

---

## 3. API Endpoints

### 3.1 S3 Compatibility (Legacy)
| Method | Path | Description |
|:---|:---|:---|
| `PUT` | `/api/v1/object/{key}` | **Legacy:** saves a raw object to disk for quick demos (not deal-backed). **Target:** treats `{key}` as a NilFS `file_path` within a Deal and ingests it into NilFS, returning `manifest_root` (legacy alias: `cid`). |
| `GET` | `/api/v1/object/{key}` | **Legacy:** serves a raw object by filename. **Target:** resolves and streams from NilFS by `file_path` (no `uploads/index.json` dependency). |

### 3.2 Gateway (Web Frontend Support)
These endpoints support the `nil-website` "Thin Client" flow.

#### Data Ingestion
*   **`POST /gateway/upload`**
    *   **Input:** Multipart form data (`file`, `owner`).
    *   **Logic:** Saves the file, then performs *canonical NilFS ingest* (MDU #0 + Witness MDUs + User MDUs + `manifest_root`) using `nil_cli` for sharding/KZG. Work is request-scoped: cancellation/timeouts propagate into `nil_cli` subprocesses.
    *   **Options:** Supports `deal_id` (append into an existing deal) and `max_user_mdus` (devnet sizing hint for witness region).
    *   **Output (target):** JSON `{ "manifest_root": "0x...", "size_bytes": 123, "file_size_bytes": 123, "total_mdus": 3, "file_path": "dir/file.txt", "filename": "file.txt" }`.
        *   **Compatibility:** Current responses may include legacy aliases: `cid == manifest_root` and `allocated_length == total_mdus`.
    *   **Role:** Offloads canonical ingest and commitment generation from the browser (until thick-client parity is complete).

#### Deal Management (EVM Bridge)
*   **`POST /gateway/create-deal-evm`**
    *   **Input:** JSON `{ "intent": { ... }, "evm_signature": "0x..." }`.
    *   **Logic:** Forwards the intent to `nilchaind tx nilchain create-deal-from-evm`.
    *   **Role:** Relays user-signed intents to the Cosmos chain.
*   **`POST /gateway/update-deal-content-evm`**
    *   **Input:** JSON `{ "intent": { ... }, "evm_signature": "0x..." }`.
    *   **Logic:** Forwards to `nilchaind tx nilchain update-deal-content-evm`.
    *   **Role:** Commits the Deal `manifest_root` (returned from upload) to the on-chain deal.

#### Data Retrieval & Proofs
*   **`GET /gateway/fetch/{manifest_root}`**
    *   **Query Params (target):** `deal_id`, `owner`, `file_path` (**required**).
    *   **Logic:**
        1.  Verifies `deal_id` exists on-chain and matches `owner`.
        2.  **Critical:** Calls `submitRetrievalProof` to generate and broadcast a `MsgProveLiveness` transaction on behalf of the provider (system/faucet key).
        3.  Streams the file content to the response.
    *   **Role:** Acts as a "Retrieval Proxy" that ensures on-chain proof generation ("Unified Liveness") occurs even for web downloads.
    *   **NilFS Path Fetch (target end state):**
        *   `file_path` is **required**. Missing/empty `file_path` returns `400` with a remediation message (no CID/index fallback).
        *   `manifest_root` is a 48-byte commitment (96 hex chars; optional `0x` prefix). Invalid roots return `400`.
        *   The gateway resolves the file from `uploads/<manifest_root>/mdu_0.bin` (NilFS File Table) and streams the requested bytes. Proof submission may be async in devnet to keep downloads responsive.

*   **`POST /gateway/prove-retrieval`** *(Devnet helper; subject to change)*
    *   **Input (target):** JSON `{ "deal_id": 123, "epoch_id": 1, "manifest_root": "0x...", "file_path": "video.mp4" }`.
    *   **Logic (target):**
        1. Resolve the file from NilFS (`mdu_0.bin` + on-disk slab) using `file_path`.
        2. Generate and submit `MsgProveLiveness` using the gateway/provider key.
    *   **Compatibility:** Legacy request bodies that only include `cid` are deprecated; do not rely on `uploads/index.json` lookups.

*   **`GET /gateway/list-files/{manifest_root}`**
    *   **Query Params:** `deal_id`, `owner` (required for access control / deal-owner match).
    *   **Logic:** Reads `uploads/<manifest_root>/mdu_0.bin`, parses the NilFS File Table, and returns file entries and computed total size.
    *   **Role:** The authoritative source for the Deal Explorer “Files (NilFS)” list.

*   **`GET /gateway/slab/{manifest_root}`**
    *   **Query Params:** `deal_id`, `owner` (optional; enforced together for access control / deal-owner match).
    *   **Logic:** Reads `uploads/<manifest_root>/mdu_0.bin` and the on-disk `mdu_*.bin` set to return a slab summary:
        * total MDUs, witness MDUs, user MDUs, and segment ranges (MDU #0 / Witness / User).
    *   **Role:** Powers the Deal Explorer “Manifest” tab to show the real slab layout (not the file-level shard JSON).

*   **`GET /gateway/manifest/{cid}`** *(Deprecated)*
    *   **Role:** Legacy debug endpoint for file-level `nil_cli shard` output. It MUST NOT be required for fetch/prove flows and is expected to be removed once NilFS-only flows are fully enforced.

---

## 4. Devnet Shortcuts & "The Gap"

To facilitate the "Store Wars" Devnet without a full WASM client, `nil_s3` takes several shortcuts:

1.  **The "Faucet Relayer":**
    *   Transactions generated by the Gateway (like `create-deal-from-evm` or `submit-retrieval-proof`) are typically signed and broadcast by a local **`faucet`** key.
    *   This acts as a "Meta-Transaction" layer, sponsoring gas for web users.

2.  **Triple Proof Generation:**
    *   The `submitRetrievalProof` logic uses `nilchaind sign-retrieval-receipt --offline` to generate cryptographic proofs.
    *   **Target (NilFS SSoT):** Proof inputs are derived from the on-disk slab (`uploads/<manifest_root>/mdu_0.bin` + `mdu_*.bin`) plus on-chain deal state — with **no dependency** on per-upload shard JSON, `manifest_blob_hex`, or `uploads/index.json`. Any such artifacts may exist for debugging but are non-normative.
    *   **Gap:** In a production "Thick Client", the browser would generate these proofs locally or verify them from a remote SP. Here, the Gateway generates *and* submits them, effectively simulating a "perfect" SP.

3.  **Local Storage:**
    *   The Gateway currently acts as the *sole* Storage Provider for the devnet web interface. It does not distribute data to other nodes; it merely simulates the lifecycle of a storage deal backed by its local filesystem.

## 5. Future Roadmap

1.  **WASM Migration:** Move `shardFile` and `manifest` generation logic into `nil_core` WASM bindings for the browser.
2.  **Decoupling:** Separate the "S3 Adapter" (Provider logic) from the "Gateway" (Client relay logic).
3.  **P2P Integration:** The Gateway should fetch data from the actual `nil_p2p` network rather than serving from local disk.
