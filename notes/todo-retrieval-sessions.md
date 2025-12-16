# TODO: Retrieval Sessions (Blob-Indexed, Provider-Bound, User Completion Tx)

## Goal
Close the devnet/alpha grief mode where an SP can serve bytes but the user never submits an on-chain proof/receipt. The SP must be able to prove on-chain that:
1) the user authorized a retrieval of a specific contiguous blob interval (provider-bound), and
2) the SP served correct data for that interval (cryptographic proof), and
3) the user confirmed completion (on-chain confirmation).

This is mandated for now; later optimizations may reduce prompts/payloads.

## House Rules / Constraints
- Do **not** use `hash(bytes)` receipts; the receipt commitment must be derived from the protocol’s cryptographic system (blob/MDU proof semantics).
- Atomic unit for retrieval is **Blob** (128 KiB). Requests must be **blob-aligned** and expressed as a contiguous interval of blobs.
- Interval may span MDUs.
- Session must bind to a **specific deal** and **specific provider**.
- Gateway is treated as an extension of the client and may compute `start_blob`/`blob_count` from a user intent (file+byte range), but the SP only cares about `(deal_id, provider, start_blob, blob_count)`.

## Definitions
- `BLOB_SIZE_BYTES = 128 * 1024`
- `MDU_SIZE_BYTES = 8 * 1024 * 1024`
- `BLOBS_PER_MDU = MDU_SIZE_BYTES / BLOB_SIZE_BYTES = 64`
- `global_blob = mdu_index * BLOBS_PER_MDU + blob_index` (canonical global blob index)
- Blob-aligned interval:
  - `start_bytes = start_blob * BLOB_SIZE_BYTES`
  - `len_bytes   = blob_count * BLOB_SIZE_BYTES`
  - `blob_count > 0`

## Protocol (Target)

### 1) Open Session (User → Chain, MetaMask tx)
User opens a retrieval session on-chain, binding the authorization to:
- `deal_id`
- `provider` (bech32 provider address or canonical string)
- `start_blob` (u64)
- `blob_count` (u64)
- `expires_at` (height or unix time; prefer height)
- `nonce` (monotonic per owner)

Chain stores `RetrievalSession` with `status=OPEN`.

Session ID:
- `session_id = H(owner, deal_id, provider, manifest_root, start_blob, blob_count, nonce, expires_at)`

Expose via an EVM precompile method (preferred) so it’s a single “Confirm transaction” prompt:
- `openRetrievalSession(dealId, provider, startBlob, blobCount, expiresAt, nonce) -> sessionId`

### 2) Fetch (Browser → Gateway → Provider, HTTP)
- Browser requests download via the gateway, and includes `session_id`.
- Gateway routes to the provider and includes `session_id` (header or query param).
- Provider MUST validate on-chain:
  - session exists
  - `status` is not terminal/expired
  - `provider` matches itself
  - `(deal_id, start_blob, blob_count)` matches request
  - (optional) `owner` match derived from `session`
- Provider serves the blob interval (as one or multiple HTTP Range requests), generating proof metadata per blob.

### 3) Completion Confirm (User → Chain, MetaMask tx)
After the gateway completes the download, the user submits an on-chain confirmation bound to `session_id`:
- `confirmRetrievalSession(session_id)`

This is the protocol’s “proof of validation” that the user claims the retrieval completed successfully (and keeps the UX as a normal MetaMask “Confirm transaction” prompt, not `eth_signTypedData_v4`).

### 4) SP Submission (Provider → Chain)
Provider submits **Proof of Retrieval**: the cryptographic proofs for the exact blob interval (keyed by `session_id`).

The user confirmation and provider proof can arrive in either order; chain transitions status when both are present:
- `OPEN -> PROOF_SUBMITTED` (after proofs)
- `OPEN -> USER_CONFIRMED` (after user confirmation tx)
- `*_ -> COMPLETED` only once both are present and match the session.

## On-Chain Data Model (Sketch)
- `RetrievalSession`:
  - `session_id` (bytes32 or string)
  - `deal_id` (u64)
  - `owner` (bech32)
  - `provider` (bech32)
  - `start_blob` (u64)
  - `blob_count` (u64)
  - `opened_height` (u64)
  - `expires_height` (u64)
  - `status` (enum)
  - `proof_submitted` (bool) + metadata (bytes served, proof commitment)
  - `user_confirmed` (bool)

## Gateway / Provider Responsibilities
- Gateway (user side):
  - derives blob interval from file intent when needed
  - opens session via wallet tx (precompile)
  - performs the fetch (router → provider)
  - prompts user confirmation tx for session completion

- Provider:
  - refuses serving without valid `session_id`
  - serves bytes + generates proofs
  - submits proof-of-retrieval on-chain (session completes once the user confirmation tx is also present)

## UI
- Add a dashboard widget: “My Retrieval Sessions”
  - table columns: `session_id`, `deal_id`, `provider`, `start_blob`, `blob_count`, `start_bytes`, `len_bytes`, `status`, `expires`
  - actions: “Sign completion receipt” (when download completed locally but not yet confirmed on-chain)

## Notes / Future Optimization
Once stable, we can optimize toward the “happy path” where the SP may only need the user completion signature (or only one on-chain submission), but for now both are mandated.
