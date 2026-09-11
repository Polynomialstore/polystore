# RFC: Mandatory Retrieval Sessions for All Served Bytes + Batching Semantics (Access Control + Protocol Hooks) (Draft)

**Status:** V2 implementation; inactive by default, integrated qualification pending
**Last updated:** 2026-09-07
**Scope:** provider-daemon, user-gateway, browser/CLI clients, deputies, and protocol audit/repair paths
**Hard constraints respected:** does **not** modify `rfcs/rfc-pricing-and-escrow-accounting.md` (owner-paid settlement semantics); no oracles; deterministic on-chain state.

---

## V3 large native session amendment (contract only)

The [retrieval v3 large-session profile](../docs/retrieval-v3-large-session-profile.md)
defines one funded logical-range session with at most eight systematic K8 provider
obligations, one session-wide sample population and explicit per-obligation
settlement. It preserves current per-blob pricing and the 64-opening envelope;
splitting proof messages does not split the session, base fee or liability. V3 is
disabled, adds no keeper acceptance in this RFC change, and requires independent
contract approval before implementation. V2 below is unchanged.

## V2 SESSION integration (inactive by default)

The [versioned session profile](../docs/retrieval-v2-session-profile.md) is normative
for version-2 chain sessions and supersedes legacy current-root/current-slot
admission. It binds the immutable generation and explicitly authorized proof
payee at open, requires the fixed H+1 seed and responses from H+2, proves every
opened blob, and separates completion activity from independent storage audits.
Provider/browser integration is described in the
[operator and client contract](../polystore_gateway/polystore-gateway-spec.md#33-retrieval-v2-client-and-operator-contract).
Integrated qualification remains an activation gate; this document makes no
throughput or completed end-to-end qualification claim.
Historical generation reads must preserve their pinned directory and must not
change `.active_generation`; current deal updates cannot redirect old sessions.
Funded windows split at slot/MDU boundaries and preserve each session's ID and fresh z.
A transaction may contain several complete session messages without merging their
challenge contexts, proof lists or accounting.
The profile documents native/EVM fields, exact query bytes, funding and recovery.

The [internal v2 verifier contract](../docs/retrieval-v2-crypto.md) specifies the
bounded PSB1 transport, exact transcript and weighted KZG equation. One synchronous
native call verifies each complete admitted list, including singleton input, after
all cheap checks and full crypto prepayment. The 64-proof/60522-byte internal
ceiling does not relax public slot/MDU limits or aggregate separate sessions.
There is no gas discount or recursive isolation on failure. Both membership hops,
fresh expected z and the authenticated setup remain mandatory. Consumers must use
the strict full received-blob commitment boundary before decoding and confirmation.

## 1. Motivation

PolyStore’s “Retrieval IS Storage” model only works if **served bytes are accountable**:

- retrieval fees settle deterministically through the chain,
- completion activity is attributable to its frozen payee, while independent C4 audits determine storage credits,
- user-data delivery cannot bypass session accounting,
- and protocol operations (audit/repair/healing) cannot bypass enforcement.

This RFC makes retrieval sessions **mandatory for user-data delivery**, with the
bounded metadata exception in R1. It preserves **batching/segmentation flexibility**
without changing per-session economics.

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

### R1 — Session binding is mandatory for user-data delivery

User-data requests require `X-PolyStore-Session-Id` and an on-chain session eligible
for delivery. V2 permits `OPEN`, `USER_CONFIRMED` or `PROOF_SUBMITTED` during the
frozen response window; `COMPLETED` sessions do not reopen delivery. These states
allow retrying an interrupted response without acknowledging unverified bytes.
Legacy admission remains version-specific and cannot bypass v2 activation.

Committed MDU #0 and witness MDUs are the bounded pre-funding metadata exception.
Their endpoint checks the committed deal/root at the requested `committed_height`
and serves only metadata indices. Clients must cryptographically authenticate
these bytes before using their file table, roots or commitments. This exception
never permits reading a user MDU without its funded session.

### R2 — Access control happens at session open

Chain open rules enforce authorization and funding:

- `MsgOpenRetrievalSession`: owner-authorized, deal-escrow funded;
- `MsgOpenRetrievalSessionSponsored`: requester funded, subject to the deal's public/allowlist/voucher policy;
- `MsgOpenProtocolRetrievalSession`: protocol funded and restricted to the corresponding task authority.

See the [access-control RFC](rfc-retrieval-access-control-public-deals-and-vouchers.md).
Serving nodes validate the frozen session and actual signing identity; they must
not reinterpret current deal policy or replace the promised payee after open.

### R3 — Frozen authority and exact challenge validation

Before v2 delivery, the serving node checks committed session state, canonical
context/hash and seed, funding identity, eligible status and response height. The
request's deal, root, MDU and window must match that context. Its actual configured
provider key must equal `authorized_proof_provider`; an address override, routing
hint or copied public proof supplies no authority.

The context fixes the generation, assigned provider/slot, effective proof payee,
layout, range and deal end. A later content update, assignment rotation or registry
change cannot redirect a live funded session. Read its retained directory without
changing `.active_generation`. Missing retained bytes, unavailable historical
chain state or a missing fixed seed cause rejection, never a current-generation
or later-seed fallback. A not-yet-available challenge may be retried; delivery and
proofs cannot start before H+2 for an open committed at H.

### R4 — Blob coverage and bounded response

A v2 session covers 1–64 encoded 128 KiB blobs in one user MDU and one assigned
slot; the layout may impose a smaller limit (eight blobs for K=8, M=4). Every
opened blob needs its ordered `(mdu, leaf, z)` proof. The current v2 multipart
endpoint returns the complete frozen window, with bounded proof metadata and
exactly `blob_count * 131072` bytes. It does not reinterpret an HTTP range or
logical file length as a smaller payable proof obligation.

Clients verify both membership hops, fresh challenge points and the commitment
of every complete received blob before decoding, writing and confirming. Current
file clients support the canonical untransformed allocation profile. Unsupported
transformed/encrypted ranges, ambiguous packing, unavailable bounded output
storage and unauthenticated metadata must fail before funding.

### R5 — Keep three batching boundaries distinct

| Boundary | Supported behavior | Invariant |
| --- | --- | --- |
| Transport | Choose legal funded windows; HTTP/P2P framing may split their response bytes | Reassemble and verify the complete window before ACK; packet boundaries do not change coverage |
| Per-session crypto | One PSB1 verifier call for the complete admitted proof list of one message | One immutable context/seed; full per-proof gas prepayment; no cross-session KZG aggregation |
| Native transaction | Explicit ordered `sessions` list becomes several existing `MsgSubmitRetrievalSessionProof` messages in one signed transaction | One actual signer authorized by every session; each message retains its identity, proofs, fees and rounding |

A failure in a later native message rolls back earlier application changes in
that transaction. Normal ante fee/sequence changes remain. An acknowledged
broadcast is not proof of committed success; operators must reconcile its result.

### R6 — user-gateway and deputy compatibility

The user-gateway relays the same frozen session to its authorized serving payee.
Changing HTTP/P2P routes cannot change that payee. A deputy that proves or receives
payment must be explicitly authorized at open; possession of a session ID is not
proof-submission authority. Voucher provider restrictions still apply.

Recovery can open new, separately funded sessions for authorized active data or
parity slots. It must authenticate witness commitments and reconstructed bytes
before ACK. A failed slot's old session/proof cannot be relabeled for another
provider, slot or generation. Voucher recovery requires fresh matching authority.

### R7 — Protocol repair/audit compatibility (explicit)

Protocol operations that fetch bytes (audit debt, repair catch-up, healing reads) MUST use protocol retrieval sessions:

- protocol actors open sessions via `MsgOpenProtocolRetrievalSession`,
- providers serve bytes only if presented with a valid `session_id`,
- restricted deals do not block these protocol sessions (authorization is enforced at session open, not at serve-time).

---

## 4. Acceptance requirements

1. Reject missing, mismatched, expired, unsupported-version or unauthorized user-data sessions.
2. Reject wrong generation, metadata root, proof order/position/z, received bytes, padding and incomplete responses before ACK.
3. Preserve one session's context and payee across route retries and retained-generation reads.
4. Reject unsupported file transformations and ambiguous allocation before funding; require bounded verified reconstruction for parity recovery.
5. Preserve all per-session settlement and rollback rules when one native transaction contains several sessions from different owners/deals but one authorized signer.
6. Persist submission intent and known transaction hashes before reporting pending outcomes; reconcile the original ordered IDs without blind rebroadcast.
7. Keep protocol task authority and independent C4 storage audits separate from user-session completion.

These requirements are not a claim that deployment, CI or end-to-end qualification
has completed. The parent execution tracker retains those gates.

## 5. Batching economics and operator submission

Combining opens or proofs in one transaction can reduce repeated transaction
signatures and envelopes. **Every opened session still pays its own base fee.**
Neither this CLI nor the provider API discounts session funding or crypto gas.

For each session, open debits `B + L`, burns base fee `B`, and locks variable fee
`L`. Completion independently burns `ceil(L * burn_bps / 10000)` and pays the
remainder to that session's frozen payee. For example, two sessions with `L=17`
and `burn_bps=3333` each burn 6 and pay 11. Combining their transaction does not
replace those two rounded amounts with one rounding of their sum. Cancellation
returns only the remaining variable fee to its original funding source.

Use the existing `submit-retrieval-proof` CLI with an explicit `sessions` JSON
list, or the provider's `session_ids` HTTP list. The singular forms remain
compatible. Lists contain 1–64 unique session IDs and require one actual signer;
size, gas and public session-range bounds still apply. See the
[exact inputs and pending-result recovery](../polystore_gateway/polystore-gateway-spec.md#33-retrieval-v2-client-and-operator-contract).

The browser uses singular proof requests after verified output is flushed and
owner confirmation commits. An available trusted local user-gateway forwards
each request to the session's frozen payee, preserving provider authentication.
This also follows direct HTTP, P2P and recovery downloads. A pending or unknown
HTTP outcome, rejection or unavailable gateway remains visible without discarding
the verified file or its ACK. The browser does not retry, create proof batches,
or add another wallet action; operator reconciliation uses the original IDs.

Append/extend, cross-session cryptographic aggregation, automatic batching queues
and session base-fee amortization are not implemented by this contract. A new
range requires a new funded session and challenge.

## 6. Chain proof admission and finite qualification profile (#255)

These consensus validation changes require a coordinated binary upgrade. Merging
them does not activate challenge v2 or qualify the data-plane requirements above.

| Boundary | Limit / behavior |
| --- | --- |
| Raw native/EVM-wrapped transaction | 1 MiB, checked by BaseApp's decoder before protobuf materialization |
| Proposal transaction body | Check every raw transaction and the aggregate protobuf-framed size against consensus `block.max_bytes` before the first transaction decode; CometBFT separately bounds the complete block |
| Declared proof list | 1–64 proofs, at most 128 KiB of admitted proof/receipt envelope |
| Session open | Owner, sponsored and protocol opens share the same 1–64 blob bound before billing; larger Mode 1 ranges require multiple sessions |
| Precompile ABI | 256 KiB calldata body; arrays at most 64 elements; bytes/string values at most 4096 bytes; at most 8192 visited values before geth decoding |
| ABI dynamic tails | Contiguous in declaration order, with no aliasing, repeated tails or unused trailing bytes; the existing ABI encoders generate this shape |
| Merkle witnesses | Exactly the siblings consumed for the actual leaf count and index, including odd-node promotion; unused trailing siblings are rejected |
| User MDU | `WitnessMdus < mdu_index < TotalMdus`; missing/zero legacy `TotalMdus` requires an explicit valid content commit before proving |

After cheap admission of the whole declared list, reserve **500,000 SDK gas per
proof before the first FFI call**. This covers the crypto component for two KZG
verification hops and Merkle verification. Invalid-first/middle/last positions
pay the same crypto component. Authenticated no-op retries do no crypto; there
are no duplicate, cache or batching discounts. Native KV/bank work is additional.
The EVM static charge remains `200000 + 64 * len(input)`; the native-action wrapper
then meters actual native work against the child's remaining gas and charges it
once, including failures. A budget covering only static work cannot enter FFI.

Enabled legacy receipts retain `ceil(bytes/1024)` pricing using division and
remainder. One proof can claim only 1–126,976 payload bytes, with checked range
end within committed content. Their envelope lacks an authenticated file-table
offset, so these bounds cannot prove exact file-to-blob mapping. Versioned
activation must quarantine these unbound routes; they are not a substitute for
the all-opened-blob challenge session contract in #254.

`scripts/retrieval_consensus_profile.json` is the canonical fresh-genesis profile:
positive finite **2 MiB block bytes / 192,000,000 block gas**. Devnet bootstrap,
install-time health checks and benchmark defaults load this file strictly. A
benchmark sweep may explicitly override gas up to the compiled 448,000,000
activation ceiling while retaining the 2 MiB byte limit. The separate 64,000,000
bound remains the maximum estimated gas admitted for one retrieval transaction.
The candidate gas rate and block limits are preliminary bounds, not a throughput
or permissionless-security claim. #260 must measure honest generation/admission
and admitted-state maxima, including the separate fixed audit demand, before
coordinated activation. Run focused checks with `scripts/chain_go.sh test -p 2
./app ./precompiles/polystore ./x/polystorechain/keeper` and the real entrypoint
regressions with `python3 scripts/test_bench_retrieval_sessions.py`.
