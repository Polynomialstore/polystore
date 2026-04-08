# PolyStore UI/UX Spec Notes — Retrieval Policies (Public/Restricted/Allowlist/Voucher) + Compression

Last updated: 2026-01-23

This document is intentionally **implementation-oriented** for `polystore-website/` and `polystore_gateway/` and aligns with:

- `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers_PROTOCOL_HOOKS.md`
- `rfcs/rfc-mandatory-retrieval-sessions-and-batching_ACCESS_CONTROL_PROTOCOL_HOOKS.md`
- `rfcs/rfc-content-encoding-and-compression.md`

---

## 1) Deal creation: retrieval access step

Add a required field in the “Create Deal” flow:

### 1.1 Retrieval access mode (radio)
1) **Restricted (Owner only)** *(default)*
   - Copy: “Only the deal owner can request retrievals. The protocol may still retrieve for audit/repair.”
   - UI note: in Deal Details, show an **Activity / Audit log** (optional in v1) that lists protocol retrieval sessions (audit/repair) so users understand these are expected and budget-limited.
2) **Allowlist**
   - Copy: “Only specified accounts can request retrievals (plus owner).”
3) **Voucher-protected**
   - Copy: “Anyone with a one-time voucher can retrieve (plus owner). Use this for pay-to-download links.”
4) **Public**
   - Copy: “Anyone can retrieve by paying for retrieval sessions. Suitable for public datasets.”

### 1.2 Allowlist editor (Allowlist / AllowlistOrVoucher)
- UI input: add/remove addresses.
- Show a hard cap for v1 (e.g., 256 addresses) if implementing a merkle root.
- On save:
  - build the merkle tree client-side,
  - store/display `allowlist_root` (bytes32),
  - submit `MsgSetDealRetrievalPolicy` (or include in create deal).

### 1.3 Voucher signer (advanced)
- Default: Deal owner.
- Optional: allow setting a separate voucher signer (hot key) so the owner can keep custody of the main account.

---

## 2) Retrieval UX: sessions are mandatory

Protocol audit/repair retrievals are not initiated from the UI in v1, but the UI SHOULD be able to *display* them (read-only) via session/event queries.

### 2.1 Preflight quote (must-have)
Before asking the user to sign an “Open session” tx:
- query current `retrieval_price_per_blob` and base fee,
- estimate `blob_count` from range length,
- display:
  - base fee,
  - variable fee,
  - total,
  - provider target (or “auto”).

### 2.2 Owner retrieval flow
- Call `MsgOpenRetrievalSession` (owner-paid).
- Then download using `X-Nil-Session-Id`.

### 2.3 Non-owner flow (Public / Allowlist / Voucher)
- Call `MsgOpenRetrievalSessionSponsored` so the requester pays.
- Provide an optional “max total fee” slippage guard.

### 2.4 Voucher redemption UX (Voucher modes)
- The “Download link” contains:
  - deal_id, manifest_root
  - range (start, blob_count)
  - expires_at
  - nonce
  - signature
  - (optional) redeemer binding

A “Redeem voucher” screen should:
- display what you’re redeeming (deal, size, expiry),
- open a sponsored session,
- proceed to download.

---

## 3) Compression UX (upload + download)

### 3.1 Upload toggle
Add an upload option (default ON):
- “Compress before upload (recommended)”
- Tooltip: “Compression happens before encryption and reduces storage + retrieval costs if your data is compressible.”

### 3.2 Upload preview
Show:
- original size
- estimated stored size
- estimated storage lock-in cost delta (based on current `storage_price`)

### 3.3 Download behavior
- Downloads should transparently return the **original bytes**:
  - retrieve ciphertext,
  - verify proofs,
  - decrypt,
  - parse PolyCE header,
  - decompress if needed.

Advanced option (optional):
- “Download raw encoded bytes” for debugging.

---

## 4) Public data explorer UX (separate side project)

The explorer is not required in core UI, but PolyStore should link to it and support it via queries/events.

Minimum explorer screens:
- “Public deals” list
- “Deal details” (files, sizes, optional previews)
- “Pay to retrieve” flow (sponsored session open)

---

## 5) Copy to avoid privacy confusion (recommended)

Whenever a user selects anything other than Owner-only:
- show a warning:

> “PolyStore does not provide confidentiality by default. If your data is sensitive, encrypt it before upload. Retrieval access policies control who can *request* retrieval sessions, not who can theoretically obtain bytes.”

