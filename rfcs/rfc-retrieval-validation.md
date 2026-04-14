# RFC: Retrieval Validation, Deputies, and Audit Debt (Sessions-First) (Draft)

**Status:** Draft / Normative Candidate  
**Last updated:** 2026-01-23  
**Scope:** Deputy/proxy paths, audit debt, failure evidence; aligned with mandatory retrieval sessions and protocol retrieval hooks.

---

## 1. Why we need this

PolyStore has two fundamental goals that are in tension:

1) Users must be able to reliably retrieve bytes (“service works”).  
2) The protocol must be able to **attribute failures** without trusting off-chain claims (“service is accountable”).

Classic “he said / she said” disputes (user claims provider is offline; provider claims user is lying) are a trap unless the protocol has a logistics system that can **route around disputes** and generate verifiable evidence.

PolyStore’s approach is:

- **Mandatory retrieval sessions** for all served bytes (no session, no bytes).  
- A **deputy/proxy market** for the user “sad path” (user can’t retrieve directly).  
- **Audit debt** to ensure deputies exist even when organic traffic is low.

---

## 2. Key primitives (aligned with other RFCs)

### 2.1 Retrieval sessions are the gate
Every served byte is covered by an on-chain session id:

- `MsgOpenRetrievalSession` (owner-paid; owner-only; frozen settlement semantics),
- `MsgOpenRetrievalSessionSponsored` (requester-paid; public/allowlist/voucher),
- `MsgOpenProtocolRetrievalSession` (protocol-paid; audit/repair/healing).

See:
- `rfcs/rfc-mandatory-retrieval-sessions-and-batching.md`
- `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md`

### 2.2 Consumers vs requesters
The session opener (“requester”) is not necessarily the byte consumer:

- a deputy can consume an owner-opened session id (bearer capability),
- a gateway can proxy a client using the same session id,
- protocol repair workers can consume protocol sessions.

This is intentional. It enables routing and batching without changing accounting.

---

## 3. Deputy system (proxy retrieval)

### 3.1 UX-first workflow (happy + sad path)

**Happy path**
1) The user opens a session (or a sponsored session for public deals).
2) The user (or their gateway) downloads bytes from an assigned provider using `X-PolyStore-Session-Id`.

**Sad path**
1) The user opens a session as usual, but direct retrieval fails (timeouts/connection errors/invalid responses).
2) The user broadcasts a P2P request:
   - “I have session `S` for `(deal_id, slot/provider, range)`. I will pay `premium` for a deputy to complete it.”
3) A deputy accepts and attempts to retrieve from the assigned provider using the same session id.
4) Outcomes:
   - **Success:** deputy forwards bytes; user confirms the session completion; deputy is paid premium (off-chain payment channel or on-chain settlement, TBD).
   - **Failure:** deputy produces failure evidence bound to the session id.

### 3.2 Why this works (incentives)
- Providers cannot easily distinguish “the user” from “a deputy” at the network layer.
- If a provider wants to get paid, it must serve any valid session id for bytes it is assigned to serve.
- Refusing service risks accumulating credible evidence of failure.

**Note:** This does not require confidentiality. Deputies see ciphertext bytes and can forward them.

---

## 4. Audit debt (ensure deputies exist)

### 4.1 Rule
To earn storage rewards, providers must demonstrate they are periodically checking neighbor availability:

> “To get paid for storing data, you must also prove you are helping keep the network live.”

### 4.2 How audits are funded and authorized (sessions-first)
Audit traffic must not:
- drain deal owner escrows, and
- bypass access control of restricted deals.

Therefore audits use **protocol retrieval sessions**:

- The chain derives `AuditTask`s deterministically each epoch.
- The assignee SP opens a `MsgOpenProtocolRetrievalSession(purpose=PROTOCOL_AUDIT, auth=AuditTaskRef{...})`.
- Fees are funded from the protocol audit budget (Option A) and settle normally:
  - completion burns + pays the serving provider,
  - non-completion refunds back to the audit budget (base fee burned).

Restricted deals still allow audits because protocol sessions bypass `Deal.retrieval_policy` but are constrained by the deterministic task assignments.

---

## 5. Failure evidence and dispute minimization

When a deputy or auditor cannot retrieve bytes for a valid session:

1) They construct a `ProofOfFailure` including:
   - `session_id`
   - target provider/slot
   - timestamp / height range
   - transcript hash (request attempts, responses, error codes)
   - deputy signature

2) The chain tracks failure evidence over a window:
   - single failures are not enough to slash,
   - repeated failures from distinct actors can convict/jail/evict.

**Normative principle:** evidence must be session-bound. The chain should not accept vague “provider is down” claims that are not tied to a specific session and range.

---

## 6. Repair / healing interaction

Repairs require moving bytes without requiring the deal owner to be online.

- When a striped slot enters `REPAIRING`, the `pending_provider` must catch up by fetching shards from ACTIVE slots.
- These transfers MUST be session-accounted via `MsgOpenProtocolRetrievalSession(purpose=PROTOCOL_REPAIR, auth=RepairAuth{deal_id, slot})`.
- This closes the “restricted deals still allow repair” story: restricted deals do not block protocol repair sessions.

---

## 7. Implementation phases (suggested)

**Phase 1 (testnet MVP): sessions-first deputy UX**
- deputy consumes user-opened sessions,
- simple P2P discovery and payment out of scope (can use a centralized relay for MVP).

**Phase 2 (audit debt): protocol audit sessions**
- deterministic audit task derivation in BeginBlocker,
- protocol audit budget minting and accounting.

**Phase 3 (slashing/evidence): on-chain failure evidence**
- `MsgSubmitFailureEvidence(session_id, transcript_hash, ...)`,
- conviction ladder and eviction triggers.

---

## 8. Summary

This RFC is a “logistics system,” not a court system:

- Users: if you can’t retrieve, a deputy can complete your session.
- Network: even when users are inactive, protocol audit sessions ensure continuous liveness checks.
- Protocol: restricted deals still allow audit/repair because protocol sessions are deterministic and budget-limited, not arbitrary public access.
