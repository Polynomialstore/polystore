# Retrieval Receipts v2 (Audit Hardening)

**Status:** Draft / In Progress
**Goal:** Make “retrievals show up on-chain” correspond to a cryptographically verified, user-authorized receipt that is tightly bound to the submitted proof and canonical deal state.

## 0. Current Auditor Findings (Why v2)

The current end-to-end “download → sign → `MsgProveLiveness`” flow has real cryptographic checks (Triple Proof + signature recovery), but has critical binding gaps:

1. **User signature does not commit to proof details.**
   - A user signature over `{deal_id, epoch_id, provider, bytes_served, nonce}` does not attest to the proof being submitted.
2. **Receipt fields are not enforced consistent with the transaction envelope.**
   - The chain must enforce `receipt.provider == msg.creator`, `receipt.deal_id == msg.deal_id`, `receipt.epoch_id == msg.epoch_id`.
3. **Client-side submission reliability is weak.**
   - “Fire-and-forget” or missing headers can lead to successful downloads without an accepted receipt (no heat increment).
4. **Consensus verification bypass exists.**
   - `SKIP_KZG_VERIFY` must not exist in any environment claiming cryptographic verification.

## 1. RetrievalReceipt v2: Signed Fields

We keep the on-chain `RetrievalReceipt` protobuf message shape, but define **v2 EIP-712 hashing** to include:

- `deal_id` (uint64)
- `epoch_id` (uint64)
- `provider` (string; bech32)
- `bytes_served` (uint64)
- `nonce` (uint64; strictly increasing per deal owner)
- `expires_at` (uint64; 0 allowed)
- `proof_hash` (bytes32): **keccak256 of the canonical `ChainedProof` encoding**

**Rationale:** Users sign a compact typed message, but the signature is cryptographically bound to the exact `proof_details` included on-chain.

## 2. Canonical `proof_hash`

`proof_hash := keccak256(encode(ChainedProof))` where `encode(ChainedProof)` is a deterministic byte encoding of the proof fields (no JSON).

Implementation requirement:
- Chain, gateway, and frontend MUST share identical `proof_hash` derivation (add cross-language golden vectors).

## 3. On-chain Invariants (Must-Fail)

In `MsgProveLiveness` (user receipt path), enforce:

1. `receipt.deal_id == msg.deal_id`
2. `receipt.epoch_id == msg.epoch_id`
3. `receipt.provider == msg.creator`
4. `receipt.provider` is assigned to the deal (already required via `msg.creator` check)
5. User signature verifies to `deal.owner` under **v2** hashing
6. `receipt.nonce` strictly increases per `deal.owner`
7. Triple Proof verifies against the on-chain `deal.manifest_root` (no bypass)

## 4. Nonce Read API (Required for Reliability)

To prevent client nonce drift across devices and resets, expose the last accepted nonce:

- `GET /nilchain/nilchain/v1/owners/{owner}/receipt-nonce` → `{ last_nonce: uint64 }`

Frontend rule:
- Always fetch `last_nonce` before signing; sign with `nonce = last_nonce + 1`.

## 5. UX / Observability Requirements

- The UI must show a “Receipt submitted / rejected” state (and allow retry).
- `DealHeatState.bytes_served_total` and `successful_retrievals_total` must be visible in the dashboard and deal detail views.

## 6. Milestones

### Phase 2 (Docs + TODO)
- Update specs to reflect v2 hashing, nonce query, and “must-fail” invariants.
- Expand this punch list into an implementation TODO list with test gates.
- Document migration: accept v1 + v2 on-chain for a short window (devnet), then remove v1.

### Phase 3 (Implementation + Tests)
- Remove `SKIP_KZG_VERIFY`.
- Add on-chain envelope/receipt consistency checks.
- Implement v2 EIP-712 hashing for retrieval receipts (with v1 fallback during migration).
- Add nonce query endpoint and wire frontend to it.
- Add unit tests in `nilchain` for v2 digest + invariants; add frontend unit test vectors (where available).

## 7. Phase 3 TODO (Concrete Checklist)

### 7.1 Chain (`nilchain`)
1. Delete `SKIP_KZG_VERIFY` bypass; verification must always run.
2. Enforce receipt/msg consistency:
   - `receipt.deal_id == msg.deal_id`
   - `receipt.epoch_id == msg.epoch_id`
   - `receipt.provider == msg.creator`
3. Add v2 EIP-712 hashing for retrieval receipts:
   - Include `expires_at` and `proof_hash` (computed from `receipt.proof_details`).
   - Keep v1 verification as a fallback temporarily (migration gate).
4. Add query endpoint: `GetReceiptNonce(owner)` returning `last_nonce`.

**Test gates (chain):**
- Unit test: valid v2 receipt increments heat; invalid signature fails.
- Unit test: mismatch `receipt.provider != msg.creator` fails.
- Unit test: nonce replay fails.
- Unit test: v1 receipts (if enabled) still verify during migration.

### 7.2 Gateway / Provider (`nil_s3`)
1. Ensure `/gateway/fetch` always returns a non-empty `X-Nil-Provider` when interactive receipts are enabled (or return a clear error).
2. Add `proof_hash` to the receipt intent headers (alongside `proof_details`).
3. (Optional) Validate basic receipt shape at `/sp/receipt` and return actionable errors (chain remains authoritative).

**Test gates (gateway):**
- Integration test: fetch response contains required headers; provider is non-empty.

### 7.3 Frontend (`nil-website`)
1. Update `RetrievalReceipt` typed-data to v2 fields (`expires_at`, `proof_hash`).
2. Replace local nonce counter with chain-derived nonce via `GET /owners/{owner}/receipt-nonce`.
3. Surface receipt submission success/failure in UI; retry queue (minimum: display error, do not silently ignore).
4. Ensure `bytes_served_total` is visible in core UI surfaces.

**Test gates (frontend):**
- Unit test: typed-data shape matches chain (golden vector).
- Smoke test: download triggers signature prompt and receipt submission; heat increments.
