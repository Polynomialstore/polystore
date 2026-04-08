# RFC: Retrieval Access Control + Sponsored & Protocol Retrieval Sessions (Draft)

**Status:** Draft (pre‑alpha)  
**Last updated:** 2026-01-23  
**Scope:** Chain (`nilchain/`), Gateway/router (`polystore_gateway/`), Providers, UI (`polystore-website/`), and side projects (public explorers)
**Hard constraints respected:** does **not** change storage lock‑in pricing or the settlement semantics of **owner‑paid** retrieval sessions in `rfcs/rfc-pricing-and-escrow-accounting.md`; no off-chain oracles; deterministic on-chain behavior.

---

## 1. Motivation

NilStore needs retrieval authorization semantics that are both **product‑meaningful** and **protocol‑safe**:

- Some datasets should be **public**: anyone can pay to retrieve, enabling community mirroring and public explorers.
- Some datasets should be **restricted**: only the deal owner (and the protocol for health/audit/repair) can request retrievals.
- Many datasets want a middle ground:
  - allowlists (specific accounts can request retrievals),
  - one-time “voucher” retrieval authorizations (pay-to-download-once).

Separately, NilStore’s frozen accounting RFC currently assumes `MsgOpenRetrievalSession` is **owner‑paid** (fees charged against `Deal.escrow_balance`). If we simply allow “anyone can open a retrieval session” for public deals, strangers could drain the owner’s long‑term escrow. This RFC therefore introduces:

1) **Sponsored** session opens (requester pays), and  
2) **Protocol** session opens (audit/repair/healing; protocol budget pays),

while keeping the owner‑paid path unchanged.

---

## 2. Goals and non-goals

### Goals
1) Deterministic, consensus-safe **retrieval authorization** based on on-chain deal policy.
2) Support four user-facing retrieval modes:
   - **Restricted (owner-only)**: only the deal owner can request retrieval sessions.
   - **Allowlist**: owner + allowlisted accounts can request retrieval sessions.
   - **Voucher**: owner + anyone presenting a valid owner-signed one-time voucher can request retrieval sessions.
   - **Public**: anyone can request retrieval sessions by paying.
3) Support two additional protocol-facing modes:
   - **Protocol Audit**: protocol-assigned auditors can request sessions for liveness/audit work even if the deal is restricted.
   - **Protocol Repair**: protocol-authorized repair workers can request sessions for reconstruction/catch‑up even if the deal is restricted.
4) Preserve data-plane batching semantics:
   - one session may be consumed via multiple data-plane range requests,
   - clients may segment downloads arbitrarily within the session range.

### Non-goals
- Privacy guarantees. Data is not confidential by default; sensitive data MUST be encrypted by clients.
- Final audit-debt economics. This RFC defines the **hooks** and session authorization surface; deeper audit-debt economics are handled in the deputy/audit RFCs.
- Changing the frozen accounting RFC semantics for **owner-paid** sessions.

---

## 3. Definitions

- **Deal owner:** `Deal.owner`.
- **Requester:** the tx signer that opens a retrieval session.
- **Consumer:** the entity that downloads bytes using a `session_id` (bearer capability).
- **Session funding source:** which balance ultimately pays the session fees (deal escrow vs requester vs protocol).
- **Protocol retrieval:** retrieval requests initiated by protocol-defined roles (auditors, repair workers) to maintain availability and produce evidence, subject to deterministic assignment rules and budget caps.

---

## 4. On-chain state additions (minimal)

### 4.1 Deal: `retrieval_policy`

Add to `Deal`:

- `retrieval_policy.mode` (enum):
  - `OWNER_ONLY` (default)
  - `ALLOWLIST`
  - `VOUCHER`
  - `ALLOWLIST_OR_VOUCHER`
  - `PUBLIC`
- `retrieval_policy.allowlist_root` (bytes32, optional; only used for allowlist modes)
- `retrieval_policy.voucher_signer` (address, optional; default = `Deal.owner`)

**Rationale for merkle root:** constant-size state; clients provide proofs at session open.

**Important:** `retrieval_policy` controls who may open **user/sponsored** retrieval sessions. It does **not** block protocol sessions for audit/repair/healing. Restricted deals are not private; they only reduce casual third-party retrieval.

### 4.2 RetrievalSession: funding + purpose (small but required)

To support sponsored + protocol sessions without breaking owner-paid semantics, add two small fields to the session object:

- `session.purpose` (enum):
  - `USER` (default)
  - `PROTOCOL_AUDIT`
  - `PROTOCOL_REPAIR`
- `session.funding` (enum):
  - `DEAL_ESCROW` (owner-paid sessions)
  - `REQUESTER`   (sponsored sessions)
  - `PROTOCOL`    (protocol budget sessions)
- `session.payer` (address, optional):
  - required when `funding ∈ {REQUESTER, PROTOCOL}` (refund routing),
  - MAY be empty for `DEAL_ESCROW` sessions.

**Why this is necessary:** without these fields, refunds on non-completion would be ambiguous and could leak protocol/sponsor funds into deal escrow.

---

## 5. Message interfaces (additive)

This RFC is additive: it introduces new message(s) without changing the frozen accounting RFC’s semantics for `MsgOpenRetrievalSession`.

### 5.1 Owner-paid open (existing; unchanged semantics)
`MsgOpenRetrievalSession`

**Normative access rule (tightened):**
- MUST be **owner-only**: `creator == Deal.owner`.

**Funding:**
- `session.funding = DEAL_ESCROW`
- Fees are charged against `Deal.escrow_balance` per the frozen RFC.

**Refund on expiry/cancel (existing semantics):**
- Any refundable amount returns to `Deal.escrow_balance`.

### 5.2 Sponsored open (new): requester pays
`MsgOpenRetrievalSessionSponsored`

Fields (conceptual):
- `creator` (tx signer; pays)
- `deal_id`
- `provider` or `slot`
- `manifest_root`
- `start_mdu_index`, `start_blob_index`, `blob_count`, `expires_at`
- `auth` (oneof):
  - empty (public mode)
  - `AllowlistProof { leaf = creator_address, proof[] }`
  - `Voucher { typed_fields..., signature }`
- `max_total_fee` (uint256 coins) optional slippage guard

Handler semantics (normative):
1) Enforce deal ACTIVE + term coupling:
   - `current_height < Deal.end_block`
   - `expires_at <= Deal.end_block`
   - `manifest_root == Deal.manifest_root`
2) Enforce deal policy based on `Deal.retrieval_policy` (see §6.2).
3) Compute `base_fee` and `variable_fee` using the same fee schedule and rounding rules as the frozen RFC.
4) `total = base_fee + variable_fee`. If `max_total_fee` is set, reject unless `total <= max_total_fee`.
5) Transfer `total` from `creator` to the `nilchain` module account.
6) Create a session with:
   - `purpose = USER`
   - `funding = REQUESTER`
   - `payer = creator`
   - `locked_fee = variable_fee`
7) Settlement on completion uses the same burn/payout split as owner-paid sessions.
8) **Refund on expiry/cancel:** refundable amounts MUST be returned to `payer` (the requester), not to deal escrow.

Rationale:
- prevents public retrieval from draining long-term owner escrow,
- prevents refund leakage into deal escrow,
- preserves the same pricing schedule and settlement math.

### 5.3 Protocol open (new): audit/repair/healing hooks
`MsgOpenProtocolRetrievalSession`

Fields (conceptual):
- `creator` (protocol actor; e.g., auditor SP, repair candidate SP)
- `purpose` (enum): `PROTOCOL_AUDIT | PROTOCOL_REPAIR`
- `deal_id`
- `provider` or `slot` (the *serving* provider/slot for the bytes being fetched)
- `manifest_root`
- `start_mdu_index`, `start_blob_index`, `blob_count`, `expires_at`
- `auth` (oneof):
  - `AuditTaskRef { epoch, task_id }` (deterministic audit assignment; see §6.3)
  - `RepairAuth { deal_id, slot }`   (Mode 2 repair authorization; see §6.4)
- `max_total_fee` (optional)

Funding semantics (normative):
1) Fees are funded from a **protocol retrieval budget** module account (see §5.4).
2) The chain transfers `total` from the protocol budget module account into the `nilchain` module account and opens the session with:
   - `purpose = PROTOCOL_AUDIT` or `PROTOCOL_REPAIR`
   - `funding = PROTOCOL`
   - `payer = protocol_budget_module_account_address`
3) Settlement on completion uses the same burn/payout split as owner-paid sessions.
4) **Refund on expiry/cancel:** refundable amounts MUST return to the protocol budget module account (not to deal escrow).

Access semantics (normative):
- Protocol sessions bypass `Deal.retrieval_policy` (restricted deals still allow audit/repair),
- but are limited by deterministic authorization rules per purpose (§6.3–§6.4) and by budget caps (§5.4).

### 5.4 Protocol retrieval budget (deterministic; no oracle)

This RFC assumes the “Audit Budget (Option A)” posture from `ECONOMY.md`:

Define notional epoch slot rent:
```
epoch_slot_rent = storage_price * total_active_slot_bytes * epoch_len_blocks
```

Mint per epoch (bounded):
```
audit_budget_mint = min(
  ceil(audit_budget_bps / 10_000 * epoch_slot_rent),
  ceil(audit_budget_cap_bps / 10_000 * epoch_slot_rent)
)
```

Carryover:
- Unused budget MAY carry forward for up to `audit_budget_carryover_epochs` (recommend: 2 epochs).

This budget funds:
- protocol audit sessions (audit debt / liveness checking),
- protocol repair sessions (catch-up and reconstruction),
- protocol “healing” retrievals (system-driven verification when clients are inactive).

---

## 6. Authorization rules (normative)

### 6.1 Deal activity and term coupling (all session opens)
All opens MUST enforce:
- `current_height < Deal.end_block` (deal ACTIVE)
- `expires_at <= Deal.end_block`
- `manifest_root == Deal.manifest_root`
- provider/slot belongs to the deal assignment (Mode 2: slot binding must match current assignment)

### 6.2 Policy checks for sponsored opens (`MsgOpenRetrievalSessionSponsored`)

Let `req = creator`.

- `mode == PUBLIC`:
  - allow any `req`.
- `mode == OWNER_ONLY`:
  - reject (sponsored open is not allowed; owner must open an owner-paid session).
- `mode == ALLOWLIST`:
  - allow if merkle proof shows `req` ∈ allowlist, OR `req == owner`.
- `mode == VOUCHER`:
  - allow if a valid voucher is presented (see §7), OR `req == owner`.
- `mode == ALLOWLIST_OR_VOUCHER`:
  - allow if allowlist OR voucher OR owner.

### 6.3 Protocol audit authorization (hook; deterministic)

A protocol audit session is only valid if it is bound to a deterministic audit assignment.

**Normative model (v1 hook):**
- The chain maintains an `AuditTask` store keyed by `(epoch, task_id)`:
  - `assignee` (provider address)
  - `deal_id`, `slot/provider`, `manifest_root`
  - `(start_mdu_index, start_blob_index, blob_count)`
  - `expires_at` (bounded TTL)
- `MsgOpenProtocolRetrievalSession(purpose=PROTOCOL_AUDIT, auth=AuditTaskRef{epoch, task_id})` MUST enforce:
  - `creator == AuditTask.assignee`
  - all session fields match the stored task exactly
  - task not already executed (one-time), and not expired

**How tasks are created (deterministic; sketched):**
- In `BeginBlocker` at epoch start, derive tasks from epoch randomness and the active provider set.
- Tasks must be sized so `sum(task.blob_count)` is bounded by the epoch audit budget.

This closes the “restricted deals still allow protocol audit” story without requiring the UI to expose any special flow.

### 6.4 Protocol repair authorization (Mode 2; deterministic)

A protocol repair session is valid if it is opened by the replacement candidate while a slot is REPAIRING.

`MsgOpenProtocolRetrievalSession(purpose=PROTOCOL_REPAIR, auth=RepairAuth{deal_id, slot})` MUST enforce:
- Deal is Mode 2 and has `mode2_slots[slot]`
- `mode2_slots[slot].status == REPAIRING`
- `creator == mode2_slots[slot].pending_provider`
- The session `provider/slot` being fetched MUST be an **ACTIVE** slot provider for the same deal (source of truth bytes)
- Session term coupling (§6.1) still applies (`expires_at <= end_block`)

**Notes:**
- Repairs may require large transfers. Implementations SHOULD bound `blob_count` per session (e.g., `protocol_session_max_blobs`) and perform repairs as many sessions.
- If a deal expires during repair, repair sessions must fail once `height >= end_block` and providers are expected to GC per expiry policy.

---

## 7. Voucher format (one-time retrieval authorization)

### 7.1 Purpose
Vouchers enable “buy-to-download-once” flows without making a deal public.

A voucher is a signature from `voucher_signer` (default owner) authorizing a specific sponsored session open.

### 7.2 Typed fields (normative)
Voucher payload MUST include:

- `deal_id`
- `manifest_root`
- `provider/slot` binding (optional; if omitted, any assigned provider may be used)
- `start_mdu_index`, `start_blob_index`, `blob_count` (or an explicit max blob_count)
- `expires_at` (block height)
- `nonce`
- `redeemer` (optional; if set, only that address may redeem)

Signature scheme:
- EIP-712 typed data is recommended for MetaMask UX, but any deterministic signature verification supported by the chain is acceptable.

### 7.3 One-time semantics (state)
To prevent replay, the chain MUST track voucher consumption:
- `used_voucher_nonce[deal_id][nonce] = true`

State growth control (recommended):
- require bounded TTL: `expires_at - current_height <= voucher_max_ttl_blocks`
- allow pruning of expired used-nonces in a future state-pruning RFC.

---

## 8. Data-plane implications (sessions remain the gate)

With `rfcs/rfc-mandatory-retrieval-sessions-and-batching*.md`:

- **No session, no bytes.**
- Providers/gateways validate the session status and the requested range subset/alignment.
- Access control is enforced at **session open**, not per HTTP request.

Protocol retrieval sessions use the same data-plane gate: they produce a normal `session_id`.

---

## 9. Security analysis (selected)

1) **Escrow draining avoided:** public/third-party reads use sponsored sessions funded by the requester, not deal escrow.
2) **Refund leakage avoided:** sponsored/protocol sessions refund to `payer`, not to deal escrow.
3) **Voucher theft risk:** vouchers are bearer assets unless bound to `redeemer`. Recommend binding for paid downloads.
4) **Budget griefing:** protocol sessions are limited by deterministic task assignment and a capped audit budget.
5) **Over-broad protocol access:** protocol repair auth is limited to `pending_provider` while slot is REPAIRING; protocol audit auth is limited to stored tasks.
6) **Privacy confusion:** restricted deals are not private; policy only gates session opens. Encourage encryption.

---

## 10. Acceptance tests (DoD)

1) Owner-only deal: non-owner sponsored open fails.
2) Public deal: non-owner sponsored open succeeds; deal escrow does not change.
3) Sponsored session expiry/cancel refunds to sponsor (`payer`), not to deal escrow.
4) Voucher deal: invalid signature fails; valid voucher succeeds; replay fails.
5) Protocol repair: restricted deal + slot REPAIRING → pending provider can open protocol repair session; non-pending cannot.
6) Protocol audit (hook): restricted deal + stored audit task → assignee can open protocol audit session; non-assignee cannot.

---

## 11. Related documents

- `rfcs/rfc-pricing-and-escrow-accounting.md` (frozen: owner-paid session settlement + storage lock-in pricing)
- `rfcs/rfc-mandatory-retrieval-sessions-and-batching.md` (sessions required for all served bytes; batching preserved)
- `rfcs/rfc-mode2-onchain-state.md` (REPAIRING slots + pending_provider authorization)
- `rfc-retrieval-validation.md` (deputy/audit debt; will reference protocol sessions)
