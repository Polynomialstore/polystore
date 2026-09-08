# Retrieval v2 session profile and recovery contract

Status: SESSION implementation candidate for #255. Network activation remains
**disabled by default**. Merging this code does not qualify activation. Independent
C4 audits, native setup enforcement and prover support (#256), provider/browser
integration (#257), and integrated resource/security qualification (#260) must
pass first. #254 remains the authority for outstanding deployment dispositions.

## Wire and immutable authority

Native owner, sponsored and protocol opens append `challenge_version` and
`authorized_proof_provider`. Version 0 selects the historical wire; version 2
selects this contract. Unsupported versions fail. Version 2 is refused before
activation, and version 0 opens are refused after activation. Empty authorized
provider defaults to the assigned provider. Addresses normalize to canonical
20-byte account identities before deriving the ID. Native signer and EVM caller
must equal the frozen effective payee when submitting a proof.

The authenticated open records `Deal.CurrentGen`, root, chain ID, setup digest,
layout, K/M, slot, metadata/user MDU counts, deal end, range, heights and both
assigned/effective provider addresses. A deputy must be explicitly authorized.
Registration is required at open; later registry deletion, assignment rotation or
content updates cannot change the funded statement or payee. Protocol task/repair
authority does not authorize a deputy override. Voucher provider restrictions
remain enforced; an unrestricted voucher cannot authorize an unassigned deputy.

The exact setup identity is SHA-256
`d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7` of the checked-in
chain/browser setup. The native loader must authenticate this identity under #256;
a matching context field alone does not establish native-loader compatibility.

Let `legacy_id` be the existing 32-byte `HashRetrievalSessionID` result. The opaque
v2 session ID is:

```text
Keccak256(
  ASCII("polystore/retrieval-session/v2") || 0x00 || U32BE(2) ||
  U32BE(len(chain_id_utf8)) || chain_id_utf8 || legacy_id || payee_raw20
)
```

Chain IDs are valid UTF-8, 1–50 bytes, without NUL. The existing nonce scope
(owner, deal, assigned provider) remains monotonic across versions; changing a
payee cannot reuse a consumed nonce. These IDs must not be interpreted as v1 IDs.
The challenge context is separately SHA-256 hashed under the exact transcript in
[the challenge RFC](../rfcs/rfc-challenge-derivation-and-quotas.md). The nested
snapshot is authoritative; canonical bytes/hash are derived, never independently
editable state. `GetRetrievalSession` returns `challenge_context`,
`challenge_context_hash`, and `challenge_seed`. Missing seed means unavailable.
Clients retain uint64 values as integers/BigInt, never JavaScript Number.

The existing EVM selectors remain available for legacy operation. V2 overloads
append `string authorizedProofProvider` to `openRetrievalSession` and to each
input tuple for `openRetrievalSessions`, `openRetrievalSessionsSponsored`,
`computeRetrievalSessions` and `computeRetrievalSessionIds`. The selector fixes
version 2 even when that field is empty. Native and EVM computations use the same
normalized payee and ID. `submitRetrievalSessionProof(bytes32,ChainedProof[])`
forwards the EVM caller as native signer; it has no caller-supplied provider field.
Its tuple order is the existing proof layout:

```text
(uint64 mduIndex, bytes mduRootFr, bytes manifestOpening,
 bytes rootTableDuCommitment, bytes[] rootTableDuMerklePath,
 bytes blobCommitment, bytes[] merklePath, uint32 blobIndex,
 bytes zValue, bytes yValue, bytes kzgOpeningProof)
```

Public EVM dispatch applies the shared bounded ABI admission before geth unpack.
Applications must select the complete overloaded signature, not assume an ABI
library's synthetic overloaded method-map name is a stable wire identifier.

## Fixed seed and exact coverage

An open at H fixes anchor H+1 and accepts proofs H+2 through `expires_at`
inclusively, with `H+2 <= expires_at <= frozen deal_end`. In pinned ABCI2 BaseApp,
`LastBlockId` is absent from the constructed header. BeginBlock H+1 therefore
captures `ctx.HeaderHash()` (the authenticated `RequestFinalizeBlock.Hash`) in
that block's cache. A versioned committed query exposes it only once H+1 commits.
Missing or malformed hashes remain unavailable permanently for that anchor; a
later block never supplies a replacement. This trusted-devnet source assumes
non-grinding proposers. Permissionless unbiased randomness remains unqualified.

Every opened blob requires its expected ordered `(mdu, leaf, z)` proof. A session
stays within one user MDU and one slot. For K=8, M=4 it contains at most eight
128 KiB blobs (one MiB encoded coverage); separate MDU/slot ranges use separate
funded sessions. A 1 KiB encoded range still requires one blob proof. A 1 GiB
encoded range requires all 8192 blob proofs, split among sessions; it does not
receive a constant-size sampling discount. This is encoded coverage, not an
unauthenticated logical-file length or measured transport quantity.

Every blob gets a context/anchor/ordinal/position-bound off-domain z. A public
opening at another z is not accepted. Structural commitments, Merkle paths and
root-table witnesses may be reused. Zero/constant polynomials may yield identical
valid opening bytes at different z, so proof-byte uniqueness is not a rule.
Neither challenge verification nor completion proves independent byte delivery,
exclusive storage, incompressibility or an anti-collusion claim.

## State and conservation

| State and authorized operation | Result |
| --- | --- |
| OPEN + valid proof | PROOF_SUBMITTED; install accepted payee pin once |
| OPEN + owner confirmation | USER_CONFIRMED; no payment |
| USER_CONFIRMED + valid proof | COMPLETED; accept, settle and record activity once |
| PROOF_SUBMITTED + owner confirmation | COMPLETED; settle and record activity once |
| PROOF_SUBMITTED + same accepted provider retry | Success without FFI, pin/height/payment/activity changes |
| USER_CONFIRMED + owner confirmation retry | Success without changes |
| COMPLETED + compatible proof/confirmation retry | Success under existing actor/count/version/expiry admission; no pin reinstallation |
| Eligible live/EXPIRED record + owner cancellation after expiry | CANCELED; refund remaining variable fee once |
| CANCELED + owner cancellation retry | Success without changes |
| CANCELED/EXPIRED/UNSPECIFIED + proof/confirmation | Reject without cryptography or economic effects |

Both completion orders require an authenticated accepted-provider pin, including
zero-fee completion. Missing, malformed or conflicting pins fail closed; the
assigned provider is never a fallback. Error paths do not write an EXPIRED status
and rely on a failed transaction to preserve that write. Cancellation is the
successful refund transition.

With base fee B and locked variable fee L, open debits B+L, burns B and locks L.
Completion uses the configured completion-time burn basis points:
`C=ceil(L*bps/10000)`, pays L-C to the frozen payee, and clears L and the pin.
Cancellation returns L to its original funding source; B is never refunded.
Owner-funded fees return to deal escrow; sponsored fees return to the recorded
requester; protocol fees return module-to-module to the protocol budget. No
ordinary session proof reduces C4 audit quota or records organic audit credit.
Completion records billed encoded coverage/activity once. No acknowledgement,
deputy service or session cancellation independently punishes an assigned provider.

## Bounded candidate profile

| Resource | Session ceiling |
| --- | ---: |
| Opens per block | 128 |
| Expiry references for one block | 128 |
| Live retained session contexts | 8192 |
| Session TTL | 4096 blocks |
| Concurrent retained generations per deal | 8 |
| Concurrent retained session generations globally | 1024 |
| Shared proof count per message | 64 |
| Candidate prepaid cryptography per proof | 500000 gas |
| Candidate reserved future retention work per open | 100000 gas |
| Activation consensus block gas / bytes ceilings | 64000000 / 2097152 |

All session capacity checks precede fee transfers and voucher consumption. Gas is
prepaid for the entire proof list only after all cheap authority, range, shape and
challenge checks pass; proof verification follows. The fixed work reservation is
not measured qualification. BeginBlock captures at most one shared height anchor
and releases at most 128 session expiry references. It never scans all sessions.
After expiry it releases session anchor/generation references and transient pins,
even if the owner never cancels, while preserving the economic record and refund
liability. Audit references keep a shared anchor alive. C4 owns its independent
retention counters and the qualification of the combined generation population.
The complete `RetainedGenerations({})` query returns the sorted session/audit union
with its committed height, including COMPLETED sessions until expiry references
are released. Provider-filtered scheduling queries are insufficient for cleanup.
The global endpoint validates the bounded reference inventories and fails without
a partial list; callers must preserve generations on missing, failed or stale
responses and include their own in-flight references. See the
[storage retention contract](retrieval-v2-storage-audits.md#provider-queries-and-verification);
provider filesystem enforcement remains in #257.

## Activation and existing state

`retrieval_v2_activation_height=0` is disabled. A positive scheduled height must
be a one-indexed epoch boundary `(height-1)%epoch_length=0`, with epoch length >=2.
Admission rejects a past schedule. BeginBlock executes activation at exactly the
scheduled height, validates finite positive consensus gas/byte bounds, then stores
a durable once-active latch. The C4 bounded deal/slot inventory preflight and
legacy readiness clearing run before that write; implementation does not qualify
funded activation. Governance cannot unset or move an already active boundary to revive old
payout paths. Skipping the scheduled boundary fails closed.

Activation also disables every legacy ordinary payout entry point before cryptography or
effects: `ProveLiveness` user receipt, receipt batch and download-session proof,
and EVM `proveRetrievalBatch`. They require a new funded v2 session; fresh receipt
nonces or owner signatures do not restore their eligibility. `SystemProof` routes
exclusively to the frozen C4 storage/repair audit verifier. Preactivation legacy
operation remains available.

Existing records are not retagged, repriced or replayed. Version-0 COMPLETED
records stay terminal. Existing OPEN, USER_CONFIRMED and PROOF_SUBMITTED records
become expiry-refund-only after activation, using their original keys, nonce and
liability; their old proof cannot obtain fresh credit or payment. Secure
continuation needs a new funded version-2 session and cannot reuse a consumed
voucher. Legacy EXPIRED records may refund only with valid original funding.
UNSPECIFIED state cannot authorize payout or inferred refunds. The old
unspecified-funding schema maps to owner deal escrow only when payer is empty and
session owner equals deal owner. Missing requester/protocol payer information is
an explicit recovery blocker, not an invitation to infer a beneficiary.

Durable database restart preserves the latch, seeds, sessions and nonces. Current
module genesis export omits non-parameter module state; **export/import is not a
supported recovery path** for these liabilities or challenges. Before deployment,
#254 must record the affected-state inventory, supported snapshot/database restore
procedure and disposition of malformed records. No broader restore guarantee is
made by this slice.

## Transaction evidence

The app regressions use signed transactions through the production decoder, ante
handler, message router, bank, `FinalizeBlock` and `Commit`. A native two-message
transaction opens a funded session then fails a bank transfer: burn, escrow,
session, nonce, capacity and application events roll back while the transaction
fee and account sequence persist. A later transaction can open the same session
nonce using the next account sequence.

The signed EVM regression exercises three nonconstant legacy proofs through the
shared native-action boundary. A 2177439 gas limit consumes that limit and leaves
no proof nonce or EVM logs. With a 4000000 limit the baseline at `7f6b7904` uses 2291408 gas,
including the 677440 static component and 1500000 cryptography component. The
receipt, ABCI transaction result, block gas meter and charged account fee agree.
Successful-path store accounting may change that baseline; the test asserts the
component and reconciliation contracts instead of fixing the total.

Run both transaction regressions with:

```sh
scripts/chain_go.sh test -p 2 ./app -run 'Test(SignedEVMProofReceiptAndBlockGas|RetrievalSessionSignedTransactionRollback)' -count=1 -v
```

These tests complement the nested EVM revert/OOG and balance-journal regressions.
They establish transaction accounting and rollback, not throughput or delivery.
