# RFC: Challenge Derivation & Proof Quota Policy

**Status:** V2 implemented; canonical trusted-devnet bootstrap activates at height 1
**Scope:** Chain protocol policy (`polystorechain/`)
**Motivation:** `spec.md` §7.6; Appendix B #3 (challenge derivation), #4 (quota + penalty curve)
**Depends on:** `spec.md`, `rfcs/rfc-mode2-onchain-state.md`, `rfcs/rfc-blob-alignment-and-striping.md`

---

## Version 3 large-session amendment

The [retrieval v3 large-session profile](../docs/retrieval-v3-large-session-profile.md)
fixes its own context, committed-anchor seed, session-wide sparse sampling and
fresh off-domain point transcripts. Its population is the exact frozen set of
encoded blobs needed by a logical range, rather than every MDU/slot proof or 132
samples per provider. The keeper, provider, browser and shared primitives are
implemented. V3 remains disabled while its activation parameter is zero; target
activation needs matching end-to-end qualification. The v2 rules below are unchanged.

## Version 2: canonical challenge primitives

The pure Go package `polystorechain/pkg/retrievalchallenge` implements this section's
serialization, response windows, distinct sampling and off-domain evaluation points.
The SESSION keeper now authenticates its actors and immutable snapshots, captures
fixed committed anchors, enforces exact proof targets and settles once. See the
[session wire/profile/recovery contract](../docs/retrieval-v2-session-profile.md).
The [frozen storage obligation implementation](../docs/retrieval-v2-storage-audits.md)
adds independent ACTIVE audits, pending repair readiness and the complete retained
generation query. Zero is the disabled activation sentinel; the canonical
trusted-devnet bootstrap sets height 1. Closed #254–#258 and #260 retain its security,
integration and qualification record; #259 remains open and deferred. The pure package
itself does not authenticate a setup, perform KZG verification or establish byte delivery.

This section supersedes the historical v1 assumptions below **for version-2
operation**. In particular, ordinary retrieval cannot reduce independent storage
audits, a public proof cannot select its payee, and a proposer-influenced block
hash is not an unbiased beacon. No absolute anti-grinding or delivery claim is
supported by the legacy description.

### Canonical bytes and ownership

`LP(x)` means a four-byte unsigned big-endian byte length followed by the bytes of
`x`. Integers below are unsigned big endian; fixed byte strings have no prefix or
padding. The exact transcript is the following concatenation, in table order.
`context_hash = SHA256(transcript)`. JSON, protobuf, EVM ABI encodings and displayed
bech32/hex strings are **not** hash inputs. Clients must preserve uint64 values
without conversion through JavaScript `Number`. The golden fixture encodes every
U64 input as a decimal JSON string; parse those strings with `BigInt` in JavaScript.
This fixture representation does not change the binary transcript.

| Field | Encoding | Canonical value/source required at integration |
| --- | --- | --- |
| domain | LP ASCII | `polystore/challenge-context/v2` |
| version | U32 | 2 |
| chain_id | LP UTF-8 | Authenticated chain ID; 1–50 bytes, valid UTF-8, no NUL |
| setup_digest | 32 bytes | SHA-256 of the exact accepted trusted-setup artifact; expected digest authenticated by the protocol profile |
| kind | U8 | 1 = paid session; 2 = ACTIVE storage audit; 3 = pending repair readiness |
| context_id | 32 bytes | Versioned session ID from the session profile for kind 1; all zero for kinds 2 and 3, whose identity is the bound epoch/assignment tuple |
| deal_id, generation | U64 each | Frozen deal and content generation |
| root | 32 bytes | Frozen PolyFS root |
| assigned, payee | 20 bytes each | Canonical raw account addresses; distinct fields even when equal |
| layout | U8 | 1 = replica; 2 = StripeReplica |
| K, M, slot | U32 each | Replica: exactly 1,0,0. Stripe: K divides 64, 1<=K<=64, M>0, K+M<=256, slot<K+M |
| metadata_mdus, user_mdus | U64 each | Metadata includes MDU 0 and all witness MDUs; metadata>=1 and total<=65537 |
| start_mdu | U64 | Session start; zero for audit |
| start_leaf | U32 | Session start in slot-major ordering; zero for audit |
| blob_count | U64 | Session count; zero for audit |
| epoch_id, epoch_length, sample_count | U64 each | Audit snapshot values; all zero for session |
| snapshot_height, anchor_height, first_response_height, deadline_height | U64 each | Validated immutable inclusive response window below |
| deal_end | U64 | Frozen deal end height |

The root table admits nonzero MDU indices 1..65536; hence the total count includes
MDU 0 and may reach 65537. This format uses the existing 64 blobs per user MDU.
`rows=64/K` for Stripe and 64 for replica; `U=user_mdus*rows` is the audit population
**for this assignment**, excluding metadata and including allocated padding/parity
where applicable. Bounds must precede arithmetic/allocation. These small fixed
layout bounds also prevent multiplication/leaf-index overflow.

A v2 session covers an exact positive contiguous range within **one user MDU and
one assignment**: `metadata_mdus<=start_mdu<metadata_mdus+user_mdus` and
`slot*rows<=start_leaf<start_leaf+blob_count<=(slot+1)*rows`. This intentionally
narrows legacy replica sessions that could span MDUs. Use separate sessions for
separate MDUs; do not reinterpret old sessions. Each opened blob requires a fresh
opening, including a partially requested blob. `blob_count*131072` is billed
encoded coverage, not observed transport bytes or logical payload length.

For epoch kinds 2 and 3, payee equals assigned and context_id/session fields are zero. Their
`sample_count` must be positive, no greater than U and no greater than **4096**.
4096 is the inactive v2 hard allocation/work ceiling, not the quota policy or a
claim that an active chain can process that many proofs. A profile may set a lower
cap (the #260 reference experiment uses min(U,132)); an infeasible desired
assurance target remains unqualified. No audit context is created for U=0 or a
zero/disabled quota. The standalone sampler permits U=Q=0 and returns an empty set.

The primitive accepts fixed-size root/setup/address/ID bytes as data. Integration
must authenticate their values; structurally valid bytes, a context digest and a
zero default are not evidence of registration, ownership, trust or authorization.
Do not let a submitted context replace authoritative frozen state.

### Issuance and response windows

All heights must fit positive signed int64 chain heights, except audit snapshot 0
which denotes committed genesis state. All deadlines below are inclusive.

- Session opened at H: snapshot H, anchor H+1, first response H+2. Require
  H>=1, H<deal_end and H+2<=expires_at<=deal_end. Preserve existing session
  expiry semantics (`height>expires_at`); do not silently extend an expiry.
- Epoch e with frozen length L>=2: start S=1+(e-1)L and end E=eL. Snapshot
  committed state S-1, anchor S, and accept S+1..min(E,deal_end-1). Overflow,
  epoch 0 and L<2 are errors. An empty response interval issues no obligation
  and warrants neither an audit reward nor provider failure.

The session deadline may equal deal_end; the audit deadline is strictly before
it. These are deliberately different existing lifetime contracts. Later parameter
or root/assignment changes cannot move an already issued window or reroll its
challenge. Validation does not fetch a block or declare a seed available.

### Fixed anchor and bounded derivation

The chain must persist/query the exact canonical 32-byte committed hash of
the predetermined anchor height. A caller cannot choose the seed, substitute a
later height, or fall back to nil/current-block data. A missing/corrupt/pruned
anchor is protocol failure, not provider failure. This initial trusted-devnet
source assumes non-grinding proposers; permissionless sampling/reward security is
blocked until an authenticated, predetermined future beacon round is integrated
and qualified. Hashing extra fields or several proposer-controlled blocks does
not remove bias. Source authentication and unavailable-round behavior remain
outside these pure primitives and cannot be skipped at activation.

For expected ordinal i and tuple (mdu,leaf), hash:

```text
LP("polystore/blob-challenge/v2") || context_hash || seed32 ||
U64BE(i) || U64BE(mdu) || U32BE(leaf) || U32BE(counter)
```

Interpret SHA-256 as an unsigned big-endian integer. Try counters 0..255, accepting
only `0<z<Fr` and `z^4096 mod Fr != 1`, with
`Fr=0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001`.
Return z as exactly 32 big-endian bytes. Exhaustion is explicit protocol failure;
there is no biased modular fallback. Do not hash proof bytes, y, transaction hash
or a prover-selected nonce into the challenge being answered.

The new z is an off-domain polynomial evaluation, not a literal byte challenge.
Commitments, Merkle paths and root-table openings are immutable structure and may
be reused. Constant and zero polynomials can yield identical valid opening bytes
at different z; they remain valid. No global proof-byte uniqueness rule is added.
KZG verification and once-only state accounting are separate integration steps;
this helper proves neither delivery, incompressibility, storage exclusivity nor a
formal proof-of-retrievability extractor.

### Distinct audit positions

Freeze U and Q from the eligible ACTIVE assignment before anchor revelation.
Ordinary/session/legacy retrieval activity must not subtract from Q. At ordinal i,
set n=U-i and hash:

```text
LP("polystore/audit-position/v2") || context_hash || seed32 ||
U64BE(i) || U32BE(counter)
```

Interpret the digest as x. Reject `x>=floor(2^256/n)*n`; otherwise take r=x%n.
For n=1 take r=0 without hashing. Try at most 256 counters per draw. Sparse
Fisher-Yates uses a request-local map and exactly this tail-swap variant:

```text
p_i = map.get(r, r)
map[r] = map.get(n-1, n-1)
delete map[n-1]
mdu = metadata_mdus + p_i / rows
leaf = slot*rows + p_i % rows
```

The selected position is **p_i**, not ordinal i. Keep i separately in the point
transcript and eventual coverage key. For replica, slot=0 and rows=64. The map and
output use O(Q) storage; no U-sized array or retry-until-unique loop is allowed in
production. Derive Q once per context/request. A multi-proof request compares the
ordered tuple list before FFI. A one-tuple SystemProof request samples membership
and derives only that tuple's field point, rather than all Q points. No lower-level
sampling helper authenticates the supplied context hash or seed.

### Frozen storage audit runtime

The [C4 implementation contract](../docs/retrieval-v2-storage-audits.md) defines the
bounded ACTIVE/pending view, BeginBlock snapshots, shared anchor/generation
retention, exact SystemProof admission and provider queries. The canonical kind-3
extension preserves the explicit pending repair readiness workflow without
allowing pending/organic/session/deputy work to masquerade as ACTIVE coverage.
The independent golden fixture includes all three kinds.

For ACTIVE kind 2, Q is independent of organic volume and frozen at S-1. Kind 3
applies the frozen existing repair-readiness fraction to that quota. Neither kind
can reuse an accepted ordinal, change a frozen context after the seed, or transfer
an old obligation's failure to a replacement. A pending proof changes only its
explicit readiness evidence and slot promotion guard, with no storage reward or
provider-health credit. Missing seeds and empty windows produce no provider
failure or fulfilled reward.

The cap is 64 combined assignments and 128 current/previous records; the funded
retrieval-task cap of 64 is separate. Zero remains the disabled protocol sentinel,
while the canonical trusted-devnet bootstrap sets activation height 1. The cap,
quota min=max132 profile and local helper measurements do not qualify whole-chain
capacity or funded release. Existing global EndBlock health, jail, underbonding,
draining and rotation work is outside #251's fixed proof-confirmation workload and
needs separate evidence for materially different state sizes. No permissionless
beacon or stronger C1–C6 trust claim is added.

### Integration and migration contract

The authenticated native/sponsored/EVM open normalizes and persists the effective
`authorized_proof_provider`, defaulting to assigned, in durable session state
including COMPLETED. A deputy requires the requester's authority and registration.
Sponsored opens must preserve the voucher issuer's provider restriction; protocol
opens must preserve task/repair serving authority. An optional field cannot grant
arbitrary budget payees or bypass `VoucherAuth.provider`. An unassigned deputy
needs an issuer-authorized voucher version; no consumed-voucher reuse. A later
fallback uses a new authorized funded session and the old expiry/refund path.

The #255 integration uses the existing seams:

- [session opens, proof admission and settlement](../polystorechain/x/polystorechain/keeper/msg_server.go),
  [protobuf state](../polystorechain/proto/polystorechain/polystorechain/v1/types.proto)
  and [messages](../polystorechain/proto/polystorechain/polystorechain/v1/tx.proto):
  durable normalized authority, generated ABI/bindings, authoritative context query,
  shared native/EVM validation and once-only settlement.
- [unified liveness](../polystorechain/x/polystorechain/keeper/unified_liveness.go),
  [rewards](../polystorechain/x/polystorechain/keeper/base_rewards.go) and
  [epoch finalization](../polystorechain/x/polystorechain/keeper/slashing.go):
  frozen eligible assignments, finite admission/retention caps, once-only coverage
  and no organic credit subtraction or unsubstantiated provider failure attribution.
  Open-time gas alone cannot bound future epoch work.
- Coordinated migration: keep historical COMPLETED terminal; unsupported legacy
  OPEN/USER_CONFIRMED/PROOF_SUBMITTED become expiry-refund-only with original locks
  and refund sources. Never infer missing payees or relabel old proofs as fresh.
  Secure continuation uses a new funded session without consumed-voucher reuse.
- Retain immutable generations for both session and audit references; historical
  reads cannot change `.active_generation`. Reject mutations if required reference
  capacity cannot be preserved. The implemented retention guard enforces this
  requirement; the trusted-devnet rollout uses fresh genesis instead of an in-place
  legacy-state migration.

Closed #255–#258 and #260 retain the integration, bounded-gas, EVM rollback and
trusted-devnet qualification evidence; #259 remains open and deferred. Activation
on another network requires matching provider-daemon, user-gateway, browser and EVM
qualification. #251 qualifies only its named proof-confirmation workload. Passing
vector tests alone is not runtime signer binding, seed capture, delivery, reward or
rollback qualification. Pricing is unchanged.

### Reproducible checks

```sh
cd polystorechain
go test -mod=vendor ./pkg/retrievalchallenge -count=1
go test -mod=vendor ./pkg/retrievalchallenge -race -count=1
go test -mod=vendor ./pkg/retrievalchallenge -run '^$' -bench . -benchmem
python3 pkg/retrievalchallenge/testdata/check_vectors.py
```

The checked-in fixture contains exact transcript bytes, hashes, selected positions,
MDU/leaf indices and z values, including deal ID above JavaScript's safe integer
limit. The independent Python oracle uses a full-list shuffle for the small fixture;
the Go implementation uses the bounded sparse map. The oracle checks the committed
fixture without regenerating it. Boundary tests cover empty populations, layout and
window validity, overflow, metadata exclusion, repeated samples, invalid seed
lengths, nontrivial roots of unity and forced rejection exhaustion. Benchmarks
characterize only these new Go helpers; there is no FFI/native scratch allocation,
KZG throughput result, capacity qualification or speedup claim.

---

## Historical v1 reference

The sections below describe legacy policy and implementation history. Their organic
credit subtraction and anti-grinding claims are not the v2 contract and must not
be used to describe current version-2 behavior.

## 0. Executive Summary

PolyStore’s “Unified Liveness” requires the chain to deterministically answer:
1. **What** positions a provider must prove for a given epoch (synthetic challenges)
2. **How many** proofs are required (quota)
3. **How organic retrieval** reduces synthetic demand (credits)
4. **What happens** when a provider is invalid vs merely non-compliant (penalty curve)

This RFC freezes:
- a deterministic, anti-grind challenge derivation function
- a quota computation function with explicit parameters
- an accounting model for credits and synthetic fills
- enforcement + penalty outcomes (invalid proof slashing vs quota failure health decay)

---

## 1. Definitions

### 1.1 Epoch
PolyStore defines a **liveness epoch** with fixed length:
- `EPOCH_LEN_BLOCKS` (param; e.g. 100 blocks)
- `epoch_id = floor(block_height / EPOCH_LEN_BLOCKS)`

### 1.2 Assignment
An **assignment** is:
- legacy full-replica compatibility: `(deal_id, provider)` where `provider ∈ Deal.providers[]`
- striped layout: `(deal_id, slot)` where `slot ∈ [0..K+M-1]` and `slot.provider` is the accountable provider

### 1.3 Challenge position
A synthetic challenge position is a pair:
- `(mdu_index, blob_index)`
  - legacy full-replica compatibility: `blob_index ∈ [0..63]` (Blob within MDU)
  - striped layout: `blob_index` MUST be interpreted as `leaf_index` per slot-major ordering (§8.1.3); `blob_index ∈ [0..leafCount-1]`

### 1.4 Credit
A **credit** is a unit of evidence earned via organic retrieval that reduces synthetic demand.
This RFC accounts credits in **blob-proofs** (not bytes) to avoid ambiguity across legacy full-replica compatibility and the striped layout.

---

## 2. Required Chain Inputs (Frozen)

Challenge derivation and quota computation MUST be computable from:
- current block height (for epoch)
- `Deal`: `redundancy_mode`, `service_hint` (legacy), `providers[]`
- **Frozen additions:** `Deal.total_mdus`, `Deal.witness_mdus`, and for striped deals the explicit `(K,M)` and slot order (see `rfcs/rfc-mode2-onchain-state.md`)
- epoch randomness `R_e` (see §3.1)
- per-epoch counters for credits + satisfied synthetic challenges (new state; see §5)

---

## 3. Deterministic Challenge Derivation (Anti-grind)

### 3.0 Canonical encoding (must be deterministic)
Unless otherwise stated, hashes are computed over byte concatenation using:
- `U64BE(x)`: 8-byte big-endian unsigned integer
- `U32BE(x)`: 4-byte big-endian unsigned integer
- `ADDR20(provider)`: 20-byte account address obtained by bech32-decoding the provider string (reject invalid)

`SHA256(tag || …)` means SHA-256 over the concatenated byte slices, where `tag` is ASCII bytes.

### 3.1 Epoch randomness
Define the epoch seed as:

```
epoch_start_height = epoch_id * EPOCH_LEN_BLOCKS
R_e = SHA256("polystore/epoch/v1" || chain_id || epoch_id || block_hash(epoch_start_height))
```

Rationale:
- deterministic and locally computable by all nodes
- unpredictable prior to the epoch boundary (assuming honest majority of validators)
- does not rely on any off-chain RNG or trusted beacon

### 3.2 Challenge set size
For each assignment, the chain derives a target challenge count:

```
quota_blobs = required_blobs(deal, assignment, epoch_id)        // §4
credits_blobs = credits_applied(deal, assignment, epoch_id)      // §5
synthetic_needed = max(0, quota_blobs - credits_blobs)
```

The synthetic challenge set for the assignment is:
- `S_e(deal, assignment) = { C_i | i ∈ [0..synthetic_needed-1] }`

### 3.3 Striped slot-major derivation

Let:
- `K,M` be the deal’s striped profile
- `N = K+M`
- `rows = 64 / K`
- `leafCount = N * rows`
- `meta_mdus = 1 + witness_mdus`
- `user_mdus = total_mdus - meta_mdus` (must be > 0 for challenges)

For slot `s ∈ [0..N-1]` and challenge ordinal `i`:

```
seed = SHA256("polystore/chal/v1" || R_e || U64BE(deal_id) || U64BE(current_gen) || U64BE(slot) || U64BE(i))
mdu_ordinal = U64BE(seed[0..8]) % user_mdus
row        = U64BE(seed[8..16]) % rows

mdu_index  = meta_mdus + mdu_ordinal
leaf_index = slot*rows + row
```

The challenge position is `(mdu_index, blob_index=leaf_index)`.

**Exclusions (frozen):**
- Synthetic challenges MUST NOT target metadata MDUs (`mdu_index < meta_mdus`).
- Synthetic challenges MUST NOT target striped slots with `status != ACTIVE` (repairing slots are excluded).

### 3.4 Legacy full-replica compatibility

Let:
- `meta_mdus = 1 + witness_mdus`
- `user_mdus = total_mdus - meta_mdus`

For provider `P` and challenge ordinal `i`:

```
seed = SHA256("polystore/chal/v1" || R_e || U64BE(deal_id) || U64BE(current_gen) || ADDR20(provider) || U64BE(i))
mdu_ordinal = U64BE(seed[0..8]) % user_mdus
blob_index  = U64BE(seed[8..16]) % 64
mdu_index   = meta_mdus + mdu_ordinal
```

The challenge position is `(mdu_index, blob_index)`.

---

## 4. Required Proof Quota (Policy Freeze)

### 4.1 Parameters
All of the following are chain params:
- `quota_bps_per_epoch_hot` (basis points of stored bytes proved per epoch)
- `quota_bps_per_epoch_cold`
- `quota_min_blobs` (floor)
- `quota_max_blobs` (cap)
- `credit_cap_bps` (max fraction of quota satisfiable via credits)

### 4.2 Normalized “slot bytes”
Quota targets are computed over **slot-responsible bytes** (not entire deal bytes):
- striped layout: each slot stores `rows * BLOB_SIZE` per user MDU.
  - `slot_bytes = user_mdus * rows * BLOB_SIZE`
- legacy full-replica compatibility: each provider stores full MDUs.
  - `slot_bytes = user_mdus * MDU_SIZE`

### 4.3 Required blobs function

```
quota_bps = (service_hint_base == Hot) ? quota_bps_per_epoch_hot : quota_bps_per_epoch_cold
target_bytes = ceil(slot_bytes * quota_bps / 10_000)
target_blobs = ceil(target_bytes / BLOB_SIZE)
quota_blobs  = clamp(quota_min_blobs, target_blobs, quota_max_blobs)
```

Notes:
- using `BLOB_SIZE` as the unit makes legacy full-replica compatibility and the striped layout comparable
- caps ensure quotas remain operationally feasible on low-end nodes

---

## 5. Credit Accounting (Organic Retrieval → Quota Reduction)

### 5.1 What counts as credit
Credits accrue from **completed user retrieval** evidence paths that include valid blob proofs:
- `MsgSubmitRetrievalSessionProof` (preferred)
- `MsgProveLiveness` receipt paths (`user_receipt`, `user_receipt_batch`) while in transition

### 5.2 Credit unit
Each *unique proved blob* counts as **1 credit blob**.
- A session proof covering `blob_count` blobs yields `blob_count` credits, subject to caps.

### 5.3 Credit caps (anti-wash + determinism)
To prevent a single large download from satisfying all synthetic demand indefinitely:
- credits applied per `(deal, assignment, epoch)` are capped:

```
credit_cap = ceil(quota_blobs * credit_cap_bps / 10_000)
credits_blobs = min(credit_cap, unique_proved_blobs_in_epoch)
```

Uniqueness is enforced by storing a per-epoch set keyed by:
`credit_id = SHA256("polystore/credit/v1" || epoch_id || deal_id || assignment || mdu_index || blob_index)`.

---

## 6. Enforcement & Penalty Curve (Freeze)

### 6.0 Proof acceptance rules (must-fail)
- `system_proof` MUST match one derived synthetic challenge for that assignment and epoch.
  - The chain checks membership by recomputing `C_i` for `i ∈ [0..synthetic_needed-1]` and comparing `(mdu_index, blob_index)`.
  - Duplicate synthetic proofs for the same `(epoch, assignment, mdu_index, blob_index)` MUST NOT be double-counted.
- `session_proof` and receipt paths MAY be outside the synthetic challenge set; they still accrue credits (§5).

### 6.1 Invalid proofs (hard failures)
- A proof that fails verification MUST be slashable immediately (existing devnet behavior).
- Invalid proofs also increment an assignment health failure counter (see `CHAIN-103`).

### 6.2 Quota shortfall (soft failures)
- If, at epoch end, `credits_blobs + satisfied_synthetic_blobs < quota_blobs`, the assignment is **non-compliant**.
- Non-compliance is NOT immediately slashable by default; it:
  - decays the assignment’s `HealthState`
  - reduces placement priority
  - increments a rolling `missed_epochs` counter

### 6.3 Eviction trigger (policy hook)
When `missed_epochs` exceeds `evict_after_missed_epochs` (param), the chain SHOULD:
- mark the slot as `REPAIRING`
- select and attach a `pending_provider` candidate (see `rfcs/rfc-mode2-onchain-state.md`)

---

## 7. Required State Additions (for implementation sprints)

To implement the above without storing per-proof raw history, add collections:

- `QuotaState(deal_id, assignment, epoch_id)`:
  - `quota_blobs`
  - `credits_blobs`
  - `synthetic_satisfied_blobs`
  - `missed_epochs` (rolling)

- `CreditSeen(credit_id)` with TTL to prevent replay/double-counting.
- `SyntheticSeen(challenge_id)` to prevent counting the same synthetic proof twice.

All keys are deterministic hashes to keep store keys bounded.

---

## 8. Test Gates (for later sprints)

- Determinism tests: same chain state + epoch → identical challenge set across nodes.
- Anti-grind tests: challenge set changes with epoch; cannot be precomputed far in advance.
- E2E: no organic traffic → synthetic proofs required; with organic traffic → synthetic needed drops.
