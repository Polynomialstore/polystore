# NilGateway — S3 Adapter & Web2 Gateway Specification (`nil_gateway`)

**Component:** `nil_gateway`
**Role:** Web2 Gateway, S3 Compatibility Layer, and Devnet Relayer.
**Language:** Go.

## 1. Overview

`nil_gateway` is a dual-purpose service that acts as:
1.  **S3-Compatible Adapter:** Allows legacy applications to `PUT` and `GET` objects using standard S3 semantics, transparently handling NilStore sharding and on-chain storage.
2.  **Optional Web Gateway:** Provides REST endpoints for the `nil-website` frontend to offload heavy cryptographic operations (MDU packing, KZG commitments) and to relay provider proofs.

In the current **Devnet** architecture, the browser can operate without a local gateway (direct SP + MetaMask). The gateway is an **optional sidecar** that improves performance and UX, but it is not a signing authority.

## 2. Architecture

The service wraps a mix of native libraries and CLI tools:
*   **`nil_core` (FFI):** NilFS layout helpers (MDU #0 builder, record parsing) and cryptographic helpers shared with Rust.
*   **`nil_cli`:** Used for **Sharding** (erasure coding) and **KZG Commitment** generation in devnet flows.
*   **`nilchaind`:** Used for **Querying** and for relaying on-chain transactions that already carry user signatures (e.g., EVM precompile intents). The gateway does **not** replace MetaMask for user authorization.

### 2.1 Storage Model
*   **Local Buffer:** Files are uploaded to a local `uploads/` directory.
*   **Slab Architecture:**
    *   **MDU #0 (Super-Manifest):** Stores the File Allocation Table (FAT) and Merkle Roots for all other MDUs.
    *   **Witness MDUs:** Store the KZG Blobs required for Triple Proof verification (replicated metadata).
    *   **User Data MDUs:** Store the raw file content slices.
    *   Files are committed to a **deal-scoped directory** (recommended):
        *   `uploads/deals/<deal_id>/<manifest_root_key>/`
        *   where `manifest_root_key` is lowercase hex **without** `0x` (96 chars), derived by decoding the 48-byte `manifest_root` then re-encoding (not by string trimming alone).
        *   This avoids collisions across deals and allows multiple roots per deal over time.
        *   Any extra debug artifacts (e.g., shard JSON, `manifest_blob_hex`) are optional and must not be required for fetch/prove.
*   **NilFS is the Source of Truth (Target End State):**
    *   The gateway MUST be able to list files, fetch bytes, and generate proofs by reading `uploads/deals/<deal_id>/<manifest_root_key>/mdu_0.bin` (File Table) and the on-disk `mdu_*.bin` slab — without any auxiliary index or in-memory state.

---

## 3. API Endpoints

### 3.1 S3 Compatibility (Legacy)
| Method | Path | Description |
|:---|:---|:---|
| `PUT` | `/api/v1/object/{key}` | **Legacy:** saves a raw object to disk for quick demos (not deal-backed). **Target:** treats `{key}` as a NilFS `file_path` within a Deal and ingests it into NilFS, returning `manifest_root` (legacy alias: `cid`). |
| `GET` | `/api/v1/object/{key}` | **Legacy:** serves a raw object by filename. **Target:** resolves and streams from NilFS by `file_path` (no `uploads/index.json` dependency). |

#### 3.1.1 Path-Style S3 (Deal-Backed Buckets) — Devnet/Enterprise
The gateway also exposes a **minimal, path-style S3 surface** at the HTTP root for compatibility with standard tooling (`aws-cli`, `rclone`):

- **Bucket naming convention:** `deal-<deal_id>` (example: `deal-0`)
- **Bucket semantics:** a bucket maps 1:1 to an on-chain Deal.
- **Key semantics:** the object key maps to a NilFS `file_path` inside that deal.

| Method | Path | Description |
|:---|:---|:---|
| `GET` | `/` | List buckets (on-chain deals) as `deal-<id>` names. |
| `HEAD` | `/{bucket}` | Bucket existence check (Deal exists on chain). |
| `GET` | `/{bucket}` | List objects (NilFS file table) for the Deal’s current `manifest_root`. |
| `GET` / `HEAD` | `/{bucket}/{key...}` | Fetch an object from NilFS by `file_path` (supports explicit `Range: bytes=start-end`). |
| `PUT` | `/{bucket}/{key...}` | Upload an object, ingest via Mode 2, upload to providers, and **commit** via `update-deal-content` (devnet: requires a faucet-authorized deal). |
| `DELETE` | `/{bucket}/{key...}` | Not implemented yet (NilFS tombstoning still needs wiring). |

### 3.2 Gateway (Web Frontend Support)
These endpoints support the `nil-website` "Thin Client" flow.

**Naming note:** Some handlers and routes still name the path parameter `{cid}`. In all gateway APIs, `cid` is a **legacy alias** for the deal-level `manifest_root` (48-byte KZG commitment) — it is never a file identifier and must not be used as a lookup key into `uploads/index.json`.

#### Data Ingestion
*   **`POST /gateway/upload`**
    *   **Input:** Multipart form data (`file`, `owner`, optional `file_path`).
*   **Logic:** Saves the file, then performs *canonical NilFS ingest* (MDU #0 + Witness MDUs + User MDUs + `manifest_root`). Sharding/KZG uses `nil_cli`; NilFS table construction uses `nil_core` FFI. Work is request-scoped: cancellation/timeouts propagate into `nil_cli` subprocesses.
    *   **Options:** Supports `deal_id` (append into an existing deal), `max_user_mdus` (devnet sizing hint for witness region), and `file_path` (NilFS-relative destination path; default is a sanitized `filename`).
        *   **NilFS path rules (target):** Decode at most once (HTTP frameworks already decode query/form values); reject empty/whitespace-only, leading `/`, `..` traversal, `\\` separators, NUL bytes, and control characters. Matching is case-sensitive and byte-exact (no `path.Clean` / no double-unescape).
        *   **Uniqueness (target):** `file_path` MUST be unique within a deal. If `deal_id` is provided and the target `file_path` already exists, the gateway MUST overwrite deterministically (update-in-place or tombstone + replace) so later fetch/prove cannot return stale bytes.
        *   **Encoding note:** Go’s query parser treats `+` as space. Clients should encode spaces as `%20` (JS `encodeURIComponent`) and servers should treat decoded strings as canonical.
    *   **Output (target):** JSON `{ "manifest_root": "0x...", "size_bytes": 123, "file_size_bytes": 123, "total_mdus": 3, "witness_mdus": 1, "file_path": "dir/file.txt", "filename": "file.txt" }`.
        *   **Compatibility:** Current responses may include legacy aliases: `cid == manifest_root` and `allocated_length == total_mdus`.
    *   **Role:** Offloads canonical ingest and commitment generation from the browser (until thick-client parity is complete).

*   **`POST /sp/upload_shard`** *(Mode 2 Provider API)*
    *   **Input:** Raw shard bytes (body) with headers:
        * `X-Nil-Deal-ID` (uint64), `X-Nil-Mdu-Index` (uint64), `X-Nil-Slot` (uint64), `X-Nil-Manifest-Root` (`0x` + 96 hex).
    *   **Logic:** Stores the shard as `mdu_<index>_slot_<slot>.bin` under `uploads/<manifest_root_key>/`.
    *   **Role:** Slot-specific shard ingestion for Mode 2 (StripeReplica).
        *   **Provider is a dumb pipe:** the server does not need to understand Mode 1 vs Mode 2 beyond writing/serving bytes addressed by the headers.
        *   Metadata MDUs (MDU #0 + Witness) remain replicated to all slots via `/sp/upload_mdu`.

*   **`POST /gateway/mirror_mdu` / `/gateway/mirror_manifest` / `/gateway/mirror_shard`** *(Gateway mirror helpers)*
    *   **Input:** Same headers/payloads as `/sp/upload_mdu`, `/sp/upload_manifest`, `/sp/upload_shard`.
    *   **Role:** Optional browser-side mirroring into a local gateway/router cache (used when the gateway is running in router mode and `/sp/*` endpoints are not exposed).

#### Health & Status
*   **`GET /health`**
    *   **Role:** Lightweight liveness probe (200 if gateway is reachable).
*   **`GET /status`**
    *   **Role:** Returns gateway capabilities and mode (used by the web UI “green dot” and to prefer gateway Mode 2 when available).
    *   **Target fields (recommended):**
        *   `capabilities.mode2_rs = true|false`
        *   `extra.rs_profile = "8+4"` (or similar)
        *   `extra.artifact_spec = "mode2-artifacts-v1"`
            *   Canonical contract: `notes/mode2-artifacts-v1.md`

#### Deal Management (EVM Bridge, Optional Relay)
*   **`POST /gateway/create-deal-evm`**
    *   **Input:** JSON `{ "intent": { ... }, "evm_signature": "0x..." }`.
*   **Logic:** Forwards the intent to `nilchaind tx nilchain create-deal-from-evm`.
*   **Role:** Relays user‑signed intents to the chain for clients that cannot call the precompile directly (MetaMask is the preferred path).
    *   **Semantics (target):** Creates a **thin-provisioned** deal (`manifest_root = empty`, `size = 0`, `total_mdus = 0`) until the first `update-deal-content-evm` commit.
        *   **No tiers:** Capacity-tier fields are deprecated and must not be required by the gateway; if accepted during transition they must be ignored.
*   **`POST /gateway/update-deal-content-evm`**
    *   **Input:** JSON `{ "intent": { ... }, "evm_signature": "0x..." }`.
*   **Logic:** Forwards to `nilchaind tx nilchain update-deal-content-evm`.
*   **Role:** Commits the Deal `manifest_root` (returned from upload) to the on-chain deal when clients opt into the relay.

#### Data Retrieval & Proofs
*   **`GET /gateway/plan-retrieval-session/{manifest_root}`**
    *   **Query Params:** `deal_id`, `owner`, `file_path` (required; optional `range_start`, `range_len`).
    *   **Logic:** Resolves NilFS offsets and returns a blob-range plan (`start_mdu_index`, `start_blob_index`, `blob_count`) plus the selected provider.
    *   **Role:** Planning helper for browser/CLI clients before they open a retrieval session on-chain.

*   **`GET /gateway/fetch/{manifest_root}`**
    *   **Query Params (target):** `deal_id`, `owner`, `file_path` (**required**).
    *   **Logic:**
        1.  Verifies `deal_id` exists on-chain and matches `owner`.
        2.  Enforces retrieval sessions when enabled: requests MUST include `X‑Nil‑Session‑Id`, and ranges must be within the opened session.
        3.  Records per-blob proof artifacts for later submission.
        4.  Streams the file content to the response and sets `X‑Nil‑Provider`.
    *   **Role:** Acts as a retrieval proxy and proof recorder; it does **not** sign user transactions.
    *   **Mode 2 behavior:** If the local slab is missing a user MDU, the gateway may fetch `K` shards from providers (slot 0..K-1 by default) via `/sp/shard`, reconstruct the MDU with RS decoding, and stream the requested range. Ranges must be slot-aligned (single-slot blob ranges).
    *   **NilFS Path Fetch (target end state):**
        *   `file_path` is **required**. Missing/empty `file_path` returns `400` with a remediation message (no CID/index fallback).
        *   Invalid/unsafe `file_path` returns `400` (reject traversal `..`, absolute `/` prefix, `\\` separators, whitespace-only, NUL bytes, and control characters).
        *   Unknown `file_path` (or tombstone record) returns `404`.
        *   Duplicate/ambiguous `file_path` entries in the on-disk File Table should fail fast with a clear non-200 (prefer `409`) rather than serving potentially stale bytes.
        *   `manifest_root` is a 48-byte compressed BLS12‑381 G1 commitment (96 hex chars; optional `0x` prefix). Invalid encodings and invalid subgroup points return `400`.
        *   Owner mismatch (or invalid owner format) should return a clear non-200 (prefer `403`) as JSON.
        *   If `manifest_root` does not match the on-chain deal state for `deal_id`, return a clear non-200 (prefer `409`) to surface stale roots.
        *   The gateway MUST canonicalize `manifest_root` consistently (decode → re-encode) for filesystem paths and logs to avoid duplicate deal directories.
        *   The gateway resolves the file from `uploads/<manifest_root_key>/mdu_0.bin` (NilFS File Table) and streams the requested bytes. Proof submission is performed separately via `/gateway/session-proof` or `/sp/session-proof`.
        *   Non-200 responses MUST be JSON with a short remediation hint (even though the success path is a byte stream) and set `Content-Type: application/json`, e.g. `{ "error": "...", "hint": "..." }`.

*   **`POST /gateway/session-proof`**
    *   **Input:** `{ "session_id": "0x..." }`.
    *   **Logic:** Aggregates recorded per-blob proofs for the session and forwards them to `/sp/session-proof` (provider submission).
    *   **Role:** Relay helper for browsers that cannot submit provider proofs directly.

*   **`POST /sp/session-proof`** *(Provider API)*
    *   **Input:** `{ "session_id": "0x..." }`.
    *   **Logic:** Provider submits `MsgSubmitRetrievalSessionProof` on-chain.
    *   **Role:** Canonical proof submission path.

*   **`GET /sp/shard`** *(Mode 2 Provider API)*
    *   **Query Params:** `deal_id`, `manifest_root`, `mdu_index`, `slot`.
    *   **Logic:** Streams `mdu_<index>_slot_<slot>.bin` from the provider’s storage root.
    *   **Role:** Used by gateways/clients to reconstruct Mode 2 MDUs when local shards are missing.

*   **`POST /gateway/prove-retrieval`** *(Devnet helper; subject to change)*
    *   **Input (target):** JSON `{ "deal_id": 123, "epoch_id": 1, "manifest_root": "0x...", "file_path": "video.mp4" }`.
    *   **Logic (target):**
        1. Resolve the file from NilFS (`mdu_0.bin` + on-disk slab) using `file_path`.
        2. Generate and submit `MsgProveLiveness` using the gateway/provider key.
    *   **Notes (target):** `file_path` in JSON is already an unescaped string; gateways must not URL-decode it again (no double-unescape).
    *   **Compatibility:** Legacy request bodies that only include `cid` are deprecated; do not rely on `uploads/index.json` lookups.
        *   Missing/invalid params return `400`; tombstone/not-found returns `404`; stale `manifest_root` (doesn’t match chain deal state) should be a clear non-200 (prefer `409`).
        *   Non-200 responses should follow the same JSON error contract: `{ "error": "...", "hint": "..." }`.

*   **`GET /gateway/list-files/{manifest_root}`**
    *   **Query Params:** `deal_id`, `owner` (required for access control / deal-owner match).
    *   **Logic:** Reads `uploads/<manifest_root_key>/mdu_0.bin`, parses the NilFS File Table, and returns a deduplicated list of active files (latest non-tombstone record per `file_path`) plus computed total size.
    *   **Response (target):** `{ "manifest_root": "0x...", "total_size_bytes": 123, "files": [{ "path": "dir/file.txt", "size_bytes": 123, "start_offset": 0, "flags": 0 }] }`.
    *   **Role:** The authoritative source for the Deal Explorer “Files (NilFS)” list.
    *   **Errors (target):** Missing/invalid params return `400`; owner mismatch returns a clear non-200 (prefer `403`); stale `manifest_root` should return a clear non-200 (prefer `409`).

*   **`GET /gateway/slab/{manifest_root}`**
    *   **Query Params:** `deal_id`, `owner` (optional; enforced together for access control / deal-owner match).
    *   **Logic:** Reads `uploads/<manifest_root_key>/mdu_0.bin` and the on-disk `mdu_*.bin` set to return a slab summary:
        * total MDUs, witness MDUs, user MDUs, and segment ranges (MDU #0 / Witness / User).
    *   **Role:** Powers the Deal Explorer “Manifest” tab to show the real slab layout (not the legacy shard JSON debug output).

*   **`GET /gateway/manifest-info/{manifest_root}`**
    *   **Query Params:** `deal_id`, `owner` (optional; enforced together for access control / deal-owner match).
    *   **Logic:** Returns *debug* manifest details needed for visualization:
        * the ordered vector of per‑MDU roots committed by `manifest_root`,
        * and (optionally) the manifest polynomial blob/openings if persisted by the gateway.
    *   **Role:** Educational/visualization endpoint; **not** required for fetch/prove.

*   **`GET /gateway/mdu-kzg/{manifest_root}/{mdu_index}`**
    *   **Query Params:** `deal_id`, `owner` (optional; enforced together for access control / deal-owner match).
    *   **Logic:** Returns the 64 blob commitments for the specified MDU index (derived from Witness MDUs) and the derived MDU root.
    *   **Role:** Educational/visualization endpoint; **not** required for fetch/prove.

*   **`GET /gateway/manifest/{cid}`** *(Deprecated)*
    *   **Role:** Legacy debug endpoint for per-upload artifacts. It MUST NOT be required for fetch/prove flows and is expected to be removed once NilFS-only flows are fully enforced.
    *   **Compatibility:** If still present, `{cid}` MUST be treated as an alias for `manifest_root` only; callers should migrate to `/gateway/slab/{manifest_root}` and `/gateway/list-files/{manifest_root}`.

---

## 4. Devnet Shortcuts & "The Gap"

To facilitate the "Store Wars" Devnet without a full WASM client, `nil_gateway` takes several shortcuts:

1.  **The "Faucet Relayer":**
    *   The gateway can relay user‑signed intents (e.g., `create-deal-from-evm`, `update-deal-content-evm`) and submit provider proofs using a local key.
    *   This acts as a "Meta-Transaction" layer, sponsoring gas for web users while keeping user authorization in MetaMask.

2.  **Triple Proof Generation:**
    *   Session‑proof submission uses on‑disk NilFS slabs to build `ChainedProof` objects for the requested blob range.
    *   **Target (NilFS SSoT):** Proof inputs are derived from the on-disk slab (`uploads/<manifest_root_key>/mdu_0.bin` + `mdu_*.bin`) plus on-chain deal state — with **no dependency** on per-upload shard JSON, `manifest_blob_hex`, or `uploads/index.json`. Any such artifacts may exist for debugging but are non-normative.
    *   **Gap:** In a production "Thick Client", the browser would generate or verify these proofs locally. Here, the Gateway can generate and relay them, effectively simulating a "perfect" SP.

3.  **Local Storage:**
    *   The Gateway currently acts as the *sole* Storage Provider for the devnet web interface. It does not distribute data to other nodes; it merely simulates the lifecycle of a storage deal backed by its local filesystem.

## 5. Future Roadmap

1.  **WASM Migration:** Move `shardFile` and `manifest` generation logic into `nil_core` WASM bindings for the browser.
2.  **Decoupling:** Separate the "S3 Adapter" (Provider logic) from the "Gateway" (Client relay logic).
3.  **P2P Integration:** The Gateway should fetch data from the actual `nil_p2p` network rather than serving from local disk.
