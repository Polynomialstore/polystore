# RFC: Mandatory Retrieval Sessions for All Served Bytes + Batching Semantics (Access Control + Protocol Hooks) (Draft)

**Status:** Implemented on primary fetch paths / endpoint audit pending
**Last updated:** 2026-01-23
**Scope:** Providers, Gateway/router, UI client, deputies/proxies, and protocol audit/repair paths
**Hard constraints respected:** does **not** modify `rfcs/rfc-pricing-and-escrow-accounting.md` (owner-paid settlement semantics); no oracles; deterministic on-chain state.

---

## 1. Motivation

PolyStore’s “Retrieval IS Storage” model only works if **served bytes are accountable**:

- retrieval fees settle deterministically through the chain,
- liveness/credits are attributable to specific providers/slots,
- there is no “free retrieval” path that bypasses accounting,
- and protocol operations (audit/repair/healing) cannot bypass enforcement.

This RFC makes retrieval sessions **mandatory for all served bytes**, while explicitly preserving **batching/segmentation flexibility** so clients can optimize latency/throughput and gas costs without changing economics.

This updated draft also clarifies how session gating composes with:

- retrieval access control (restricted/public/allowlist/voucher),
- **protocol retrieval sessions** (audit/repair hooks that must work even for restricted deals).

---

## 2. Definitions

- **Blob:** accounting atom of size `BLOB_SIZE = 128 KiB`.
- **Blob-address:** `(mdu_index, blob_index)`; in the striped layout this uses aligned `leaf_index`.
- **Session range:** a contiguous blob range defined at session open by:
  - `start_mdu_index`, `start_blob_index`, `blob_count`
- **Served bytes:** any response payload containing Deal bytes, regardless of whether delivered directly by the provider, proxied by a gateway, or relayed by a deputy.
- **Session purpose (conceptual):**
  - `USER` (owner-paid or sponsored)
  - `PROTOCOL_AUDIT` (audit debt / liveness checks)
  - `PROTOCOL_REPAIR` (repair/catch-up reconstruction)
- **Data-plane endpoint:** any HTTP/gRPC/P2P method that returns Deal bytes.

---

## 3. Normative requirements

### R1 — Session binding is mandatory

Any node that serves Deal bytes (provider, gateway proxy, deputy) MUST require an on-chain `OPEN` retrieval session:

- inbound requests MUST include `X-PolyStore-Session-Id = session_id`,
- the server MUST refuse to serve bytes if:
  - the header is missing, or
  - the referenced session is not `OPEN` at the current chain height.

**Dev-only exception:** local-only developer endpoints MAY bypass this behind an explicit “unsafe dev mode” flag; MUST be disabled by default for testnet/mainnet.

### R2 — Access control happens at session open (not on the data-plane)

Serving nodes MUST NOT attempt to re-implement deal authorization policy. They only enforce:

- session existence + `OPEN` status,
- session ↔ deal/provider/slot binding,
- deal term coupling (`expires_at ≤ deal.end_block`),
- and range subset/alignment.

Authorization policy is enforced at **session open** via chain rules in:
- `MsgOpenRetrievalSession` (owner-paid; owner-only),
- `MsgOpenRetrievalSessionSponsored` (requester-paid; public/allowlist/voucher),
- `MsgOpenProtocolRetrievalSession` (protocol-paid; audit/repair hooks).
See: `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md`.

### R3 — Session validation procedure

Before serving bytes, the serving node MUST validate (by querying chain state):

1) `session.status == OPEN` and `current_height <= session.expires_at`
2) `session.deal_id == requested_deal_id`
3) `session.manifest_root == Deal.manifest_root` (content pin)
4) **Provider binding**
   - For legacy full-replica compatibility, `session.provider` MUST be a member of `Deal.providers[]`.
   - For striped deals, `session.slot` MUST match the slot assignment for the provider serving the bytes.
5) **Deal term coupling**
   - `current_height < Deal.end_block` (deal ACTIVE), and
   - `session.expires_at ≤ Deal.end_block` (sessions cannot outlive the paid term).

If any check fails, the server MUST reject the request (recommended: `403` invalid session; `410` expired deal).

**Important:** the data-plane does not care whether the session is user/sponsored/protocol. If it is `OPEN` and correctly bound, bytes may be served.

### R4 — Range subset rule + blob alignment

Within an `OPEN` session, a server MUST only serve bytes that are:

- **Blob-aligned:** start offset on a `BLOB_SIZE` boundary and length is a multiple of `BLOB_SIZE`.
- **Subset of the session range:** the requested blob span MUST be fully contained within the session’s declared blob-range.

This keeps:
- accounting deterministic (the chain reasons about blobs),
- and batching compatible (clients choose segmentation freely).

### R5 — Batching and segmentation are implementation choices

A client MAY satisfy a single session via any segmentation strategy, including:

- sequential `Range` requests for small spans,
- parallel subrange requests,
- a single request returning multiple contiguous blobs (e.g., 8 MiB MDU reads = 64 blobs),
- streaming responses, provided blob boundaries are preserved and the subset rule is enforced.

Servers MUST NOT assume “one request == one blob.”

### R6 — Gateway and deputy compatibility

- A gateway acting as a router MUST enforce “no session, no bytes” on any download endpoint.
- Deputies/proxies are permitted, but MUST still present a valid session id to the assigned provider and must not create a shadow payment channel that bypasses chain settlement.
- Deputies may operate as **consumers** of a user-opened session id (bearer capability). No special “deputy session” is required.

### R7 — Protocol repair/audit compatibility (explicit)

Protocol operations that fetch bytes (audit debt, repair catch-up, healing reads) MUST use protocol retrieval sessions:

- protocol actors open sessions via `MsgOpenProtocolRetrievalSession`,
- providers serve bytes only if presented with a valid `session_id`,
- restricted deals do not block these protocol sessions (authorization is enforced at session open, not at serve-time).

---

## 4. Acceptance tests (DoD)

1) Provider rejects out-of-session reads (missing header).
2) Provider rejects misaligned ranges.
3) Provider serves multiple range requests within one session (segmented download succeeds).
4) Gateway proxy endpoints also reject out-of-session reads.
5) Session cannot outlive deal term (`expires_at ≤ end_block`) and provider refuses to serve once the deal is expired.
6) Protocol repair path: pending provider opens a protocol repair session, fetches blobs from ACTIVE slots, and providers serve those blobs only in-session.

---

## 5. Notes on future batching optimizations (non-normative)

This RFC intentionally limits stable invariants to:

1) session binding, and
2) blob-aligned subset-of-range delivery.

Future optimizations that remain compatible:
- **Batch open:** open multiple ranges in one tx to amortize base fees.
- **Append/extend:** extend a session’s range without charging another base fee.
- **Proof aggregation:** compact aggregated proofs for ranges.
- **Session proof batching:** batch submit proof for multiple sessions in one tx.

Any such optimization MUST preserve the frozen owner-paid settlement semantics.
