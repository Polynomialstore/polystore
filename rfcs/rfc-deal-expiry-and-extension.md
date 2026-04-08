# RFC: Deal Expiry, Renewal (ExtendDeal), and Provider Garbage Collection (Draft)

**Status:** Draft (pre‑alpha)  
**Last updated:** 2026-01-23

**Scope:** Chain (`polystorechain/`), Gateway (`polystore_gateway/`), Providers, UI (`polystore-website/`)

**Hard constraints respected**
- Does **not** modify the frozen escrow/retrieval settlement contract in `rfcs/rfc-pricing-and-escrow-accounting.md`.
- No off‑chain oracles.
- Deterministic and consensus-safe: all checks are functions of chain height and on‑chain state.

---

## 1. Problem statement

PolyStore’s docs already reference that “deals can expire” and providers should garbage-collect expired data, but the protocol lacks:

1) **Enforcement**: chain-side checks that prohibit mutations / sessions / proofs after deal expiry.  
2) **Renewal**: a deterministic `ExtendDeal` path that charges **spot storage_price at extension time** for the next period.  
3) **Operational deletion**: provider/gateway behavior for post-expiry deletion (crypto-erasure + garbage collection).

This RFC makes “deal end” real, without changing escrow settlement semantics.

---

## 2. Definitions

### 2.1 Deal time bounds

Each `Deal` has:
- `start_block` (uint64): creation height (immutable).
- `end_block` (uint64): the first block height at which the deal is considered **expired**.

**Active predicate (normative):**
- `ACTIVE(deal, h) := (h < deal.end_block) AND (deal.cancelled == false)`  
  (i.e., end_block is **exclusive**).

### 2.2 Renewal grace (retention window)

To avoid “one missed renewal = instant deletion,” define a single global parameter:

- `deal_extension_grace_blocks` (uint64)

Interpretation:
- A deal is **renewable** if `h ≤ deal.end_block + deal_extension_grace_blocks`.
- Providers SHOULD retain data until `delete_after = deal.end_block + deal_extension_grace_blocks`.
- After `delete_after`, providers MAY garbage-collect the deal data.

This is not a cryptographic deletion guarantee; it is an operational norm + incentive alignment.

---

## 3. New message: MsgExtendDeal (normative)

### 3.1 Message shape

`MsgExtendDeal { deal_id, additional_duration_blocks }`

- `creator` MUST be the deal owner.
- `additional_duration_blocks > 0`.

### 3.2 End block update rule

Let `h = ctx.BlockHeight()`.

Define:
- `base = max(deal.end_block, h)`  
- `new_end = base + additional_duration_blocks`

Update:
- `deal.end_block = new_end`

This supports:
- extending **before** expiry (appends after the current end), and
- renewing **after** expiry (within grace) without paying for “dead time.”

### 3.3 Pricing rule (active pricing at extension time)

At `MsgExtendDeal`, charge for **existing committed bytes**:

- `size = deal.size_bytes` (logical bytes)
- `P = storage_price` (current on-chain value, `Dec` per byte per block)

Compute:
- `extension_cost = ceil(P * size * additional_duration_blocks)`

Accounting:
- transfer `extension_cost` from `deal.owner` to the `polystorechain` module account
- increase `deal.escrow_balance += extension_cost`

Rounding:
- use deterministic `ceil` in the same manner as `MsgUpdateDealContent` in the frozen pricing RFC.

### 3.4 Renewal gating

`MsgExtendDeal` MUST fail if:
- deal is cancelled, OR
- `h > deal.end_block + deal_extension_grace_blocks`.

### 3.5 Storage lock-in for NEW bytes after extension (minimal addendum)

**Why this exists:** If `end_block` changes, a naïve “duration = end_block - start_block” causes new bytes added after renewal to be charged for already-elapsed time.

Minimal remedy:
- Add a single field to `Deal`: `pricing_anchor_block` (uint64).

Rules:
- On `MsgCreateDeal`: `pricing_anchor_block = start_block`.
- On `MsgExtendDeal`: `pricing_anchor_block = h` (the block at which renewal pricing was locked).
- On `MsgUpdateDealContent`: use `duration = deal.end_block - deal.pricing_anchor_block` when computing storage_cost for the **delta bytes**.

This preserves the frozen semantics for non-extended deals, while preventing pathological overcharging once renewal exists.

---

## 4. Deal expiry enforcement (normative)

The chain MUST enforce `ACTIVE(deal,h)` at these state transitions:

### 4.1 Content updates
- `MsgUpdateDealContent*` MUST reject if the deal is not ACTIVE.

### 4.2 Retrieval sessions
- `MsgOpenRetrievalSession` and `MsgOpenRetrievalSessionSponsored` MUST reject if deal is not ACTIVE.
- Additionally, enforce: `session.expires_at ≤ deal.end_block`  
  (sessions cannot outlive the paid storage term).

Cancellation/refund path:
- `MsgCancelRetrievalSession` MAY be allowed after deal expiry (to unlock refundable variable fee), because it does not extend storage service.

### 4.3 Liveness proofs & quotas
- `MsgProveLiveness` MUST reject if deal is not ACTIVE.
- Challenge derivation MUST exclude expired deals (otherwise providers would be penalized for proofs that are no longer allowed).

### 4.4 Repairs and REPAIRING exclusions
- If a deal is expired, repair workflows SHOULD NOT initiate new repairing work for it.
- REPAIRING slots remain excluded from quotas/rewards as already intended.

---

## 5. Provider & gateway behavior (operational, normative-ish)

### 5.1 Provider garbage collection

Providers SHOULD implement a periodic GC loop:

For each `(deal_id, slot)` assigned:
1) Query chain for `Deal.end_block`, `Deal.cancelled`.
2) If `cancelled == true`, schedule deletion immediately.
3) Else if `h > deal.end_block + deal_extension_grace_blocks`, schedule deletion.
4) Delete local deal shards + metadata (MDU #0, witness MDUs, user MDUs, caches).
5) Emit a local log line and metrics counter (`polystore_gc_deletes_total`).

Providers MUST enforce **retrieval-session gating** on the data plane:
- providers MUST refuse to serve Deal bytes unless the request is bound to an on-chain `OPEN` retrieval session (`X-PolyStore-Session-Id`),
- requests MUST be blob-aligned and a subset of the session’s declared blob-range,
- this applies even while the deal is ACTIVE (not only after expiry).

Rationale: ensures **all served bytes** are fee-accounted and liveness-attributable, and prevents “free reads” that bypass settlement.

Providers SHOULD also stop serving reads for expired deals:
- return `410 Gone` (or protocol-equivalent) once expired.

### 5.2 Gateway behavior

- Gateways MUST refuse uploads/commit orchestration if deal is expired (client should be told to renew first).
- Gateways MUST enforce retrieval-session gating on any download/proxy endpoints that return Deal bytes (no out-of-session serving).
- Gateways SHOULD surface “time remaining” and “renewable until” in API responses to enable UX.

---

## 6. Parameter defaults (draft)

- `deal_extension_grace_blocks = MONTH_LEN_BLOCKS` (≈ 30 days)

Rationale:
- aligns with the desired “monthly renewal” mental model,
- provides a non-punitive renewal window,
- provides a clear provider retention expectation.

---

## 7. Risks & mitigations

1) **Renewal grief (renew late, data GC’d):** mitigated by grace window + provider policy.
2) **Overcharging new bytes after renewal:** mitigated by `pricing_anchor_block`.
3) **Serving beyond term via retrieval sessions:** mitigated by `expires_at ≤ end_block`.
4) **Provider moral hazard (keep serving expired deals for side-payments):** mitigated by protocol rewards/credits excluding expired deals AND mandatory session gating for any served bytes (out-of-session reads are rejected).
5) **State bloat:** expiry does not automatically prune state; pruning can be addressed in a later RFC (`MsgFinalizeDeal` / state TTL).

---

## 8. Acceptance criteria (implementation DoD)

- Unit tests: all handlers reject on expired deals as specified.
- e2e: create deal → upload → advance chain beyond end → retrieval open fails → renew within grace → retrieval works again.
- Provider GC test: assigned provider deletes data after `delete_after`.
- UI: shows end date, renewable until, and “Extend” action.


---

## 9. Related RFCs

- `rfcs/rfc-mandatory-retrieval-sessions-and-batching.md` (data-plane enforcement + batching invariants)
