# NilGateway & NilProvider Separation Specification

**Status:** Draft (Phase 1)
**Target:** "Store Wars" Devnet (Retrieval Separation)

## 1. Overview

This specification defines the architectural split of the legacy combined gateway/provider service into two distinct logical roles:
1.  **`nil_provider` (Storage Provider):** A passive, "dumb" storage server that holds raw data (MDUs) and submits proofs to the chain upon receiving valid receipts. It holds the **Provider Key**.
2.  **`nil_gateway` (User Daemon):** An intelligent user agent (Thick Client helper) that performs cryptographic verification, packing, and serves the frontend. It does **not** hold user keys (for the main flow); it delegates signing to the Client (Browser/CLI).

## 2. Architecture & Roles

### 2.1 `nil_provider` (The Storage Provider)
*   **Role:** Passive Server.
*   **Key:** `NIL_PROVIDER_KEY` (e.g., `faucet` or a dedicated SP key).
*   **Responsibility:**
    *   **Store:** Accept raw MDUs via `PUT`.
    *   **Serve:** Serve raw MDUs via `GET`.
    *   **Prove:** Accept signed `RetrievalReceipts` via `POST`, validate them, and batch-submit `MsgProveLiveness` to NilChain.
*   **State:**
    *   `uploads/<manifest_root_key>/` (The Slab).
    *   `receipts.db` (Buffer of unsubmitted receipts).

### 2.2 `nil_gateway` (The User Daemon)
*   **Role:** Active Client Helper / "Thick Client" Daemon.
*   **Key:** None (Delegates to Frontend/CLI). *Exception: E2E testing mode.*
*   **Responsibility:**
    *   **Upload (Packer):** Accept files -> Generate MDUs (NilFS) -> Push to `nil_provider`.
    *   **Download (Verifier):** Fetch MDUs from `nil_provider` -> Verify (Triple Proof) -> Stream to User -> **Proxy Receipt to Provider**.
*   **State:**
    *   Stateless (mostly). May cache `trusted_setup` or temporary artifacts.

---

## 3. The Interactive Retrieval Protocol

This flow replaces the "Simulated Liveness" where the Gateway signed receipts on behalf of the user.

**Normative (v2 hardening):** A successful on-chain retrieval MUST be backed by a receipt whose user signature is bound to the submitted `proof_details` (via `proof_hash`) and whose fields are consistent with the transaction envelope.

### 3.1 Flow Diagram

```text
User (Browser)        Gateway (Daemon)      Provider (SP)       NilChain
      |                      |                    |                 |
      |-- 1. GET File ------>|                    |                 |
      |                      |-- 2. Fetch MDU --->|                 |
      |                      |<-- 3. Raw Bytes ---|                 |
      |                      |                    |                 |
      |<-- 4. Stream Bytes --|                    |                 |
      |   + Receipt Payload  |                    |                 |
      |                      |                    |                 |
      |-- 5. Sign Receipt -->|                    |                 |
      |      (EIP-712)       |                    |                 |
      |                      |-- 6. POST Receipt >|                 |
      |                      |                    |-- 7. Verify --->|
      |                      |                    |   (Sig check)   |
      |                      |                    |-- 8. Submit --->| MsgProveLiveness
      |                      |                    |                 | (Update Heat)
```

### 3.2 Protocol Details

#### Step 1-4: Fetch & Serve
*   **Browser:** Requests `GET /gateway/fetch/...`
*   **Gateway:**
    *   Fetches MDU from Provider (currently `localhost` or via P2P).
    *   (Future) Verifies KZG Proof.
    *   Streams bytes to Browser.
    *   **Crucial Change:** The Gateway response headers MUST include the **Receipt Metadata** needed for the client to sign.
        *   `X-Nil-Deal-ID`: `<uint64>`
        *   `X-Nil-Epoch`: `<uint64>`
        *   `X-Nil-Bytes-Served`: `<uint64>`
        *   `X-Nil-Provider`: `<bech32_address>`
        *   `X-Nil-Proof-JSON`: base64 JSON wrapper containing `proof_details` (and optionally `proof_hash`).
        *   `X-Nil-Proof-Hash`: `0x` + 32-byte keccak256 of canonical `ChainedProof` encoding.

#### Step 5: Client Signing
*   **Browser:**
    *   Reads headers.
    *   Prompts user (or auto-signs if authorized) to sign a `RetrievalReceipt` (EIP-712 v2).
    *   **Payload:**
        *   `deal_id`: from header.
        *   `epoch_id`: from header.
        *   `provider`: from header.
        *   `file_path`: from request context.
        *   `range_start`, `range_len`: from request context (range binding).
        *   `bytes_served`: from header.
        *   `nonce`: fetched from chain (recommended): `nonce = last_nonce + 1` scoped to `(deal_id, file_path)`.
        *   `expires_at`: optional; `0` allowed.
        *   `proof_hash`: from header (must match the submitted `proof_details`).

#### Step 6: Receipt Submission
*   **Browser:** Sends `POST /gateway/receipt` with the signed payload.
*   **Gateway:** Proxies this to the Provider's `POST /sp/receipt`.

---

## 4. API Specification

### 4.1 Provider API (`nil_provider`)

*   **`POST /sp/receipt`**
    *   **Input:** JSON `RetrievalReceipt` (Signed).
    *   **Logic:**
        1.  Parse `deal_id`, `epoch_id`, `provider` (must match self), `bytes_served`, `proof_details`, `user_signature`, `nonce`, `expires_at`.
        2.  Fetch Deal from Chain (to get Owner).
        3.  Verify `user_signature` matches Deal Owner (chain also enforces this).
        4.  Store in `receipts.db` (or submit immediately for Devnet).
        5.  **Devnet Shortcut:** Immediately submit `MsgProveLiveness` via `nilchaind`.
    *   **Response:** `200 OK` `{ "tx_hash": "..." }`.

*   **`GET /sp/mdu/{manifest_root_key}/{mdu_index}`**
    *   **Logic:** Serves raw MDU bytes from disk.

### 4.2 Gateway API (`nil_gateway`)

*   **`GET /gateway/fetch/{manifest_root}`** (Updated)
    *   **Behavior:** Streams file.
    *   **Headers:** Adds `X-Nil-Receipt-*` headers.
    *   **Logic:** Does **NOT** auto-submit proofs anymore.

*   **`POST /gateway/receipt`** (New)
    *   **Input:** JSON `RetrievalReceipt` (Signed).
    *   **Logic:** Forwards to configured Provider URL (`POST /sp/receipt`).

---

## 8. Bundled Session Receipts (Phase 2, Planned)

To reduce MetaMask popups and on-chain TX count, the preferred UX is to sign a **single** “download session receipt” after the bytes are received:

1. Browser opens a *download session* with a signed retrieval request (one signature).
2. Browser fetches chunk ranges using the session (no additional signatures).
3. Gateway returns per-chunk `proof_hash` values; the browser computes a `chunk_leaf_root`.
4. Browser signs `DownloadSessionReceipt{deal_id, epoch_id, provider, file_path, total_bytes, chunk_count, chunk_leaf_root, nonce, expires_at}` (one signature).
5. Provider submits a single on-chain message containing the session receipt + all chunk proofs and Merkle membership paths.

This preserves “fair exchange” while reducing signatures from `O(chunks)` → `O(1)` per download completion.

---

## 5. Test Plan

### 5.1 E2E Browser Test (Playwright)
*   **Scenario:** "Authenticated Fetch".
*   **Steps:**
    1.  Create Deal & Upload File (Standard flow).
    2.  Wait for Commit.
    3.  **Fetch:** Click "Download".
    4.  **Intercept:** Browser intercepts response headers.
    5.  **Sign:** Mock Wallet signs the receipt.
    6.  **Submit:** Browser POSTs receipt.
    7.  **Verify:** Check `nilchain` for `MsgProveLiveness` event and Deal Heat increment.

### 5.2 E2E Headless Test (CLI/Script)
*   **Script:** `e2e_authenticated_fetch.sh`.
*   **Logic:**
    1.  `curl` the file.
    2.  Extract headers.
    3.  Use `nil_cli` (or a helper script) to sign the receipt with the `User Key`.
    4.  `curl POST` the receipt to the Gateway.
    5.  Assert success.

---

## 6. Migration Steps (Phase 2)

1.  **Refactor `nil_gateway`:**
    *   Add `--mode provider` and `--mode gateway` flags (default to "combined" for backward compat if needed, but prefer split).
    *   Implement `POST /sp/receipt` handler.
    *   Update `GatewayFetch` to stop auto-submitting and start setting headers.
2.  **Frontend Update:**
    *   Modify `useFetch` (or download handler) to detect headers and trigger signature flow.
3.  **Deprecation:**
    *   Remove `submitRetrievalProof` auto-call from `GatewayFetch`.

## 7. Chain-Side “Must-Fail” Invariants (Phase 3)

When `MsgProveLiveness.proof_type = user_receipt`, the chain MUST enforce:

1. `receipt.deal_id == msg.deal_id`
2. `receipt.epoch_id == msg.epoch_id`
3. `receipt.provider == msg.creator`
4. `proof_details` verifies against on-chain `deal.manifest_root` (no bypass)
5. `user_signature` verifies to `deal.owner` using v2 EIP-712 hash that includes `proof_hash`
6. `nonce` strictly increases per `deal.owner`
