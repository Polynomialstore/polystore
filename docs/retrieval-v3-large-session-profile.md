# Retrieval v3 native large-session contract

Status: **implemented; isolated production-browser qualification passed; disabled by default**.
This document fixes the wire-independent protocol choices for issue #291. The
shared primitives, native generation admission, owner/sponsored session opening,
sampled proof submission, provider data delivery, per-provider ACK/settlement
and expiry refunds are implemented. The EVM precompile exposes the same eight
native v3 actions. Browser WASM exposes the shared context, challenge, FAT v3
and full-byte integrity primitives. The browser implements one-session
orchestration, durable recovery and authenticated cache reuse. End-to-end
qualification remains required before target-network activation.
Retrieval v2 remains unchanged.

The initial v3 profile supports canonical, untransformed FAT v3 content in
StripeReplica K=8, M=4 only. One funded session can retrieve one logical byte
range, including a 1 GiB range, through a bounded set of provider obligations.
It uses one session-wide sample budget and separately authenticates every byte
that the client accepts.

V3 initially applies only to ordinary USER retrieval, either deal-owner-funded
from deal escrow or sponsored and funded by an authenticated requester. Protocol
audit and repair remain v2; every
protocol-funded/grant attempt carrying version 3 rejects before charging,
consuming authority or writing state. No protocol-grant transcript is extended.
`session_owner_raw20` below means the deal owner for deal-escrow funding and the
authenticated session requester for sponsored funding; it is not always the deal
owner.

Normative words MUST, MUST NOT, SHOULD and MAY have their usual RFC 2119 meaning.
`LP(x)` is `U32BE(len(x)) || x`. All integer arithmetic is checked before state,
allocation, signature verification, fee transfer or voucher consumption.

## 1. Two independent checks

V3 deliberately separates these claims:

1. **Sampled KZG availability.** Fresh, unpredictable, off-domain openings test
   a bounded sample from the frozen delivery plan. Sampling gives the quantified
   probability in section 5. It does not prove that every byte was delivered.
2. **Full-byte integrity.** The client hashes every complete encoded blob it
   receives and verifies its Merkle path to an integrity root authenticated by
   the same generation's PolyFS root. A client MUST do this before durable write,
   decode, terminal acknowledgement or payment eligibility.

A fixture-known digest, a transport checksum, a newly supplied public KZG
evaluation, or a digest not reached from the deal's frozen PolyFS root cannot
satisfy full-byte integrity.

## 2. FAT v3 integrity header

FAT v3 changes only the existing 128-byte FAT header. The 256-byte record layout,
including its 232 path bytes, is byte-for-byte identical to FAT v2. The root table,
31/32 scalar packing, record order, canonical path rules and deterministic zero
tail also remain unchanged.

Header bytes use the existing FAT little-endian convention:

| Bytes | Value |
| --- | --- |
| 0..4 | `NILF` |
| 4..6 | `3` as U16LE |
| 6..8 | `256` as U16LE |
| 8..12 | record count as U32LE |
| 12 | integrity hash, exactly `1` = SHA-256 |
| 13 | integrity tree, exactly `1` = binary duplicate-last tree |
| 14..16 | zero |
| 16..20 | integrity leaf bytes, exactly `131072` as U32LE |
| 20..28 | integrity leaf count as U64LE |
| 28..60 | integrity root, 32 bytes |
| 60..128 | zero |

The integrity tree covers encoded blobs in **user MDUs only**. It excludes MDU 0
and all witness MDUs, avoiding self-reference. Metadata remains authenticated by
the existing KZG root-table and witness path. For K8/M4 there are 96 leaves per
user MDU, ordered by increasing MDU index and then existing slot-major
`leaf_index = slot*8 + row`. Data, parity and deterministic padding blobs are all
included. Thus:

```text
integrity_leaf_count = user_mdus * 96
tree_position = (mdu_index - metadata_mdus) * 96 + leaf_index
```

Zero user MDUs cannot form FAT v3. The declared count MUST equal this product.
Before using the integrity tree or authorizing an ACK, the client MUST likewise
authenticate this header against the session's frozen `polyfs_root`, and compare
its root and count with the session's frozen `integrity_root` and `user_mdus * 96`. Provider
acceptance signatures do not replace the client's header authentication.
Every encoded blob is exactly 131072 bytes. Define:

```text
leaf = SHA256(
  LP("polystore/integrity-leaf/v3") ||
  U64BE(mdu_index) || U32BE(leaf_index) ||
  U32BE(131072) || encoded_blob
)

parent = SHA256(LP("polystore/integrity-node/v3") || left32 || right32)
```

At each level, pair nodes left to right. Duplicate the last node when the level
has odd length. Repeat until one root remains. A proof supplies one 32-byte
sibling per level; direction is derived from the current position. For an odd
last node, the sibling MUST equal the current node. Extra, short or differently
ordered paths fail. The PolyFS root-table limit bounds a K8/M4 tree at 6291456
leaves and each proof at 23 siblings.

The owner builds KZG commitments and this tree from the same canonical encoded
blob vector in one proposed generation. Before that generation becomes eligible
for v3, every one of the 12 frozen assigned providers MUST first authenticate the
FAT v3 header against the proposed generation's `polyfs_root`. The header lies
in the first FAT blob (MDU0 blob index 16 under unchanged 31/32 packing): verify
its complete encoded bytes against the KZG commitment and that commitment's
exact Merkle membership at index 16 under the 64-leaf MDU0 root, or verify the
complete canonical MDU0 through the existing authenticated path. Decode the
header only from those authenticated bytes, reject invalid version/packing/header
fields, and require its integrity root to equal the proposed `integrity_root`
and its leaf count to equal the frozen `user_mdus * 96`. A signature binding two
roots without this header authentication is insufficient.

Each provider MUST then check each blob in its slot against both its existing
KZG commitment path and the integrity path to that authenticated header root,
then submit this digest through a new generation-acceptance action that
reuses the existing native signer/EVM caller authentication machinery (no new
detached-signature scheme):

```text
SHA256(
  LP("polystore/generation-acceptance/v3") || LP(chain_id) || setup_digest32 ||
  U64BE(deal_id) || U64BE(generation) || polyfs_root32 || integrity_root32 ||
  U8(2) || U32BE(8) || U32BE(4) ||
  U64BE(metadata_mdus) || U64BE(user_mdus) ||
  U32BE(slot) || provider_raw20
)
```

This authenticated acceptance is provider consent after an ingest check; it is
not a succinct
cryptographic proof that the two commitments agree. Admission MUST authenticate
the registered provider for each slot and require exactly one acceptance per
slot. Acceptances are keyed by the pending `(deal,generation,polyfs_root)`; final
generation admission atomically compares every bound field with current chain
state so a concurrent owner update fails closed. A root, generation, layout,
assignment or setup change prevents reuse for a new admission. It does not rewrite
an already frozen live session: its pins and old-provider liabilities remain until
terminal completion or expiry. A provider has no v3 liability for owner-supplied
metadata it did not accept. After acceptance, a mismatching response is
attributable to that provider for obligation failure and nonpayment. V3 creates
no new slashing or provider-health penalty.

The leaf binds its physical coordinate and bytes, while authenticated MDU0 and
the acceptance bind the deal and generation. An append may reuse a leaf hash only
when its encoded bytes AND absolute `(mdu_index, leaf_index)` remain unchanged.
If witness growth changes `metadata_mdus`, existing user MDUs shift absolute
indices: the uploader MUST rehash every affected encoded blob at its new
coordinate and rebuild the new generation's integrity tree and paths before
provider acceptance. Old-generation bytes, hashes and paths remain bound to the
old generation for its retained sessions. Qualification MUST cover an append
across a witness-count boundary and reject reuse of the old-coordinate hashes.
Per-slot acceptance
does not prove global Reed-Solomon correctness, truthful FAT metadata or
consistency among other slots. Bad owner-generated parity can impair recovery;
this systematic-only profile neither attributes that fault to an honest provider
nor claims to repair it.

Existing FAT v1/v2 generations have no integrity root. They remain eligible only
for their existing retrieval versions. An owner may create a new FAT v3 generation
and obtain fresh acceptances; no user-gateway may synthesize a v3 root at read time.

## 3. Frozen logical range and provider plan

V3 supports only active FAT v3 records with no compression or encryption flags.
The file record authenticates `start_offset` and `length`. The request supplies
file-relative `range_start >= 0` and `range_length > 0`, with
`range_start + range_length <= file.length` using checked addition.
The initial profile caps `range_length` at 1073741824 bytes (1 GiB). An unaligned
1 GiB range can therefore cover at most 8458 encoded data blobs.
Let `C=126976`, the payload bytes carried by one canonical encoded data blob, and:

Before open, the user-gateway MUST verify the selected FAT record through the
existing MDU0 KZG/PolyFS path. The owner-authenticated open then freezes those
record fields as range authorization. V3 does not add a chain-side FAT-record
proof: a dishonest owner can misdescribe its own logical path/range, but cannot
redirect provider liability away from the exact encoded tuples the signed plan
authorizes. The chain makes no logical-file truth claim beyond that owner
authorization.

```text
a = file.start_offset + range_start
b = a + range_length - 1
first = floor(a / C)
last  = floor(b / C)
U = last - first + 1
```

Admission requires `last < user_mdus*64` after checked additions and rejects a
zero-length, overflowed or out-of-generation range before charging.

This is the same raw-offset-to-systematic-blob mapping used by the canonical
31/32 encoder. For each raw blob ordinal `t` in `[first,last]`:

```text
mdu_index = metadata_mdus + floor(t / 64)
data_blob = t mod 64
slot = data_blob mod 8
row = floor(data_blob / 8)
leaf_index = slot*8 + row
```

The frozen delivery vector is these distinct `(t,mdu_index,leaf_index)` tuples in
increasing `t`. It is derived, not stored or enumerated on chain, and is fixed
before the anchor is known. There is one provider
obligation for each represented systematic slot, so a small range does not create
eight empty obligations. Each obligation freezes its provider, payee, slot and
ordered subset of the vector. Provider assignments, file record, root, generation,
range and plan cannot change after open.

In this initial profile `payee_raw20` MUST equal `assigned_provider_raw20`.
Deputy or alternate-payee service requires a later version and cannot add a hidden
obligation or fee to v3.

The initial profile has no parity substitution or deputy migration. Transport may
retry the same frozen obligation before expiry. Failure uses expiry and refund; a
different provider or plan requires explicit user authorization for a new funded
session, nonce and future anchor. A reconnect cannot silently reroll positions,
but base fees do not prevent a requester or proposer from grinding multiple
sessions or anchors. Parity storage
and independent storage audits remain required by K8/M4.

Each complete encoded blob is transferred and integrity-checked even when only
part of its payload intersects the requested range. The session records both
`logical_range_length` and `U`. Activity and variable fees count each authorized
encoded blob once; overlapping transport retries and samples add no coverage.

## 4. Context, seed and distinct positions

The v3 session ID is:

```text
SHA256(
  LP("polystore/retrieval-session/v3") || U32BE(3) || LP(chain_id) ||
  session_owner_raw20 || U64BE(deal_id) || U64BE(generation) ||
  U32BE(file_record_index) || U64BE(range_start) || U64BE(range_length) ||
  plan_hash32 || U64BE(nonce)
)
```

The nonce is monotonic in the `(session_owner_raw20,deal_id)` scope across v3
sessions; provider-plan changes do not create another nonce namespace. A duplicate open is
idempotent only when the stored session ID and complete context hash match.
Reusing an ID with different terms, or replaying a consumed nonce, rejects before
fees, voucher consumption or state.

`plan_hash` is SHA-256 over this compact canonical descriptor; it never hashes or
stores U tuples:

```text
LP("polystore/retrieval-plan/v3") || U64BE(first) || U64BE(last) ||
U64BE(U) || U32BE(obligation_count) ||
for each represented slot in ascending order:
  U32BE(slot) || assigned_provider_raw20 || payee_raw20 ||
  U64BE(blob_count_for_slot)
```

`1 <= obligation_count <= 8`. Counts and coordinates are derived from
`[first,last]`; admission rejects caller-supplied disagreement in O(8) work.

The canonical challenge context is SHA-256 of this exact transcript:

```text
LP("polystore/challenge-context/v3") || U32BE(3) || LP(chain_id) ||
setup_digest32 || session_id32 || session_owner_raw20 ||
U64BE(deal_id) || U64BE(generation) || polyfs_root32 || integrity_root32 ||
U32BE(file_record_index) || U64BE(file_start_offset) || U64BE(file_length) ||
U64BE(range_start) || U64BE(range_length) ||
U8(2) || U32BE(8) || U32BE(4) ||
U64BE(metadata_mdus) || U64BE(user_mdus) || plan_hash32 ||
U64BE(U) || U64BE(Q) || U64BE(nonce) ||
LP(price_denom) || LP(price_per_blob_amount_decimal) ||
LP(base_fee_amount_decimal) || U32BE(completion_burn_bps) ||
U8(funding_kind) || funding_payer_raw20 ||
U64BE(snapshot_height) || U64BE(anchor_height) ||
U64BE(first_response_height) || U64BE(deadline_height) || U64BE(deal_end)
```

An open at H uses snapshot H, anchor H+1 and responses H+2 through the inclusive
deadline, no later than deal end. Seed capture reuses the authenticated committed
block-hash mechanism of v2:

```text
seed = SHA256(LP("polystore/challenge-seed/v3") || context_hash || anchor_hash32)
```

Missing or malformed anchor hashes fail closed. This remains a trusted-devnet
source whose proposer may grind its block hash. It does not establish an unbiased
permissionless beacon. The plan must be funded and frozen before anchor reveal.

Set `Q=min(U,132)`. Select Q positions without replacement from `[0,U)` using the
v2 sparse tail-swap Fisher-Yates algorithm, but hash the v3 domain:

```text
LP("polystore/session-position/v3") || context_hash || seed32 ||
U64BE(i) || U32BE(counter)
```

For ordinal i, use `n=U-i`, rejection-sample the digest to `[0,n)` exactly as v2,
and apply the same sparse map update. The selected population position `p`
derives `t=first+p`, then its MDU/leaf/provider through section 3; no vector lookup
or U-sized state is needed. Distinctness is within this session only; neither global
coordinate uniqueness nor proof-byte uniqueness is required.

For every selected tuple derive z with counters 0..255:

```text
LP("polystore/blob-challenge/v3") || context_hash || seed32 ||
U64BE(i) || U64BE(t) || U64BE(mdu_index) || U32BE(leaf_index) || U32BE(counter)
```

Interpret SHA-256 as an unsigned big-endian integer and accept only
`0<z<Fr` and `z^4096 mod Fr != 1`, using the v2 BLS12-381 scalar modulus. No
prover nonce, public evaluation or transaction hash enters the challenge.

## 5. Assurance and threat assumptions

For a frozen population U with b bad positions and Q distinct uniform samples,
the probability that every sample misses the bad set is:

```text
Pr[miss] = C(U-b,Q) / C(U,Q)       when Q <= U-b
Pr[miss] = 0                       otherwise
```

The standard aligned examples are:

| Logical range | U | Q | Bad positions | Miss probability |
| --- | ---: | ---: | ---: | ---: |
| aligned 1 KiB inside one payload blob | 1 | 1 | 1 | 0 |
| 1 KiB crossing a payload-blob boundary | 2 | 2 | 1 | 0 |
| aligned 1 GiB | 8457 | 132 | 846 (at least 10%) | `8.088203627301511e-7` |
| aligned 1 GiB | 8457 | 132 | 1 | `0.9843916282369635` |

For the last row the exact miss probability is `8325/8457 =
0.9843916282369635`; sampling detects that one missing blob only about 1.56% of
the time. This is intentional and must be disclosed. If the provider attempts a
full delivery, a missing, truncated, reordered or one-byte-corrupt blob fails the
full-byte integrity check deterministically and cannot receive a terminal ACK.

The probability statement assumes the bad set was fixed before the unpredictable
anchor, SHA-256 behaves as a random oracle for position selection, and the
provider cannot grind the anchor. It is per logical session over the union of all
provider obligations. It is not a 132-sample guarantee for every provider. The
chain records the sample count assigned to each provider so liability is limited
to that provider's frozen tuples.

Across any declared horizon of T sessions, the probability that at least one
session misses its fixed bad set is at most `T * Pr[miss]` by the union bound;
independence is not assumed. This bound is meaningful only while each plan is
fixed before its anchor and anchors are unpredictable. It does not cover proposer
grinding, requesters opening many paid sessions after learning earlier outcomes,
or providers choosing what to withhold after seeing samples.

| Threat | Contract result |
| --- | --- |
| Owner publishes inconsistent KZG and integrity metadata | Generation is ineligible until every assigned provider performs ingest checks and signs; unsigned providers have no v3 liability. |
| Provider withholds at least 10% before challenge | Sample miss probability follows the exact bound above; no stronger claim under a grindable beacon. |
| Provider loses one blob | Sampling is weak at 1 GiB; complete delivery still fails deterministically and remains unpaid without ACK. |
| Provider returns corrupt, reordered or truncated bytes | Complete-blob length, coordinate-bound leaf and authenticated path fail before ACK. |
| Provider substitutes an arbitrary polynomial with a valid fresh opening | Chained membership authenticates its commitment and MDU root back to the frozen PolyFS root before accepting any sample. |
| Provider replays another root, generation, range or signer | Session/context/plan and acceptance transcripts bind them; admission rejects mismatch before KZG. |
| Client retries transport or proof messages | Frozen coordinates and accepted-sample bitmap prevent new credit or payment. |
| One provider fails | Only its obligation remains unpaid/refundable; no other provider is cryptographically aggregated or blamed. |
| Owner and provider collude to claim fictional delivery | KZG can establish knowledge at sampled points, but no chain-visible primitive proves client receipt of all bytes; the owner ACK is explicit payment authority and no stronger demand claim is made. |
| Provider withholds adaptively after seeing samples | It may answer samples and withhold other data; terminal ACK still requires full-byte delivery. The confidence bound applies only to a bad set fixed before the anchor. |
| Corruption is outside the KZG sample | The client rejects it through the integrity tree. Without an ACK, the chain does not infer which party caused noncompletion. |
| Anchor reorg or crash/restart | Only a committed canonical anchor is usable. Durable context, seed, bitmap, ACK and liabilities reload exactly; missing or conflicting state fails closed without a fresh seed. |
| Admission flood or huge range | One session stores at most eight obligation descriptors and 132 sample bits; coordinates derive from a compact range. Existing open and retained-session caps still apply. |

## 6. Bounded messages, settlement and recovery

There is one session record, one base fee and one locked variable-fee pool. Open
freezes canonical coin denom, nonnegative per-blob integer price, base fee,
completion burn basis points, funding kind and normalized funding payer in the
challenge context. Amounts are canonical decimal ASCII (`0` or no leading zero);
denom follows the existing chain coin rules. Funding kinds are exactly:

| Value | Name | Required payer and refund destination |
| ---: | --- | --- |
| 1 | `DEAL_ESCROW` | `funding_payer_raw20` and `session_owner_raw20` both equal the canonical deal owner; incomplete liability refunds to deal escrow. |
| 2 | `REQUESTER` | `funding_payer_raw20` and `session_owner_raw20` both equal the authenticated session requester; incomplete liability refunds to that requester. |

Values 0, 3 and all other values reject before effects. No missing payer may be
inferred. For
each obligation `j`, `blob_count_j` is the number of its frozen delivery tuples,
and:

```text
U = sum(blob_count_j)
L_j = blob_count_j * frozen RetrievalPricePerBlob
L = sum(L_j)
```

Open debits and burns the base fee once and locks L. The logical byte count and
Q never alter this fee formula. The response exposes
`logical_requested_bytes=range_length` and
`billed_encoded_bytes=U*131072`; metadata, chunk boundaries, retries, ACKs and
samples add no billable blobs. On an obligation's terminal completion,
`C_j=ceil(L_j*completion_burn_bps/10000)` is burned and `L_j-C_j` pays its
frozen payee once. On expiry, every incomplete `L_j` returns to the recorded
funding source; completed obligations are immutable. No provider can receive
another provider's partition. All conservation and fail-closed payer rules from
v2 remain in force.

All checked `base_fee+L` arithmetic, deal-escrow or requester balance sufficiency,
access authorization and capacity checks occur before debit, burn, voucher
consumption or state. A sponsored `max_total_fee=0` means absent; otherwise
`base_fee+L <= max_total_fee` is required. Existing access and voucher rules apply
to every represented obligation. In particular, a provider-restricted voucher
cannot authorize a different slot/provider. Unsupported multi-provider voucher
combinations reject before consumption. One successful session open consumes its
voucher authority and fees exactly once.

An obligation becomes terminal only after both (a) all of its assigned sampled
openings are accepted and (b) the session owner signs one cumulative ACK after
verifying all of its delivered blobs. An obligation with zero assigned samples satisfies
(a) vacuously but still requires full delivery and its ACK. The ACK signs:

```text
SHA256(
  LP("polystore/retrieval-obligation-ack/v3") || LP(chain_id) ||
  session_id32 || context_hash32 || plan_hash32 || U32BE(slot) ||
  assigned_provider_raw20 || payee_raw20 || U64BE(blob_count_for_slot) ||
  U64BE(billed_encoded_bytes_for_slot) || integrity_root32
)
```

Native signer or authenticated EVM caller MUST normalize to the frozen
`session_owner_raw20`.
The first compatible ACK is idempotent; exact duplicates succeed without state
or economic effects, while a conflicting signer or transcript rejects. An ACK
may be recorded before every proof, but settlement waits for both predicates.
Proof-before-ACK and ACK-before-proof settle the same partition exactly once.
A proof message carries at most the existing 64
openings. If one provider receives more than 64 of the 132 samples, it uses
multiple messages under the same obligation. A session-wide Q-bit accepted bitmap
deduplicates retries. Partial batches change only bitmap bits; they do not create
coverage, payment or a second fee. KZG verification remains per opening and no
cross-provider aggregation is introduced. The authenticated native signer or EVM
caller submitting a proof MUST equal that obligation's frozen assigned provider;
authority from another obligation cannot be reused.

For every sample ordinal `i` in `[0,Q)`, the chain derives the one expected tuple
`(i,t,mdu_index,leaf_index,slot,z)` from the frozen context. Each submitted proof
names `i` and MUST exactly match that tuple and the signer's obligation. An
unselected or out-of-range coordinate, wrong `z`, wrong slot/provider, or an
ordinal repeated within one message rejects before KZG verification. After those
cheap checks, the chain validates every chained-proof field length and exact
Merkle path/index shape, then precharges verification gas for every included
proof. Each sample MUST pass the existing PolyFS chained verification against the
session's frozen 32-byte `polyfs_root`:

1. Authenticate the root-table DU commitment through its Merkle path under
   `polyfs_root` (64 MDU0 leaves). The expected `mdu_index` MUST be a user MDU
   inside the frozen generation and the root-table range `1..65536`. Derive its
   DU index as
   `floor((mdu_index - 1) / 4096)` and its cell as `(mdu_index - 1) % 4096`.
   The DU path consumes exactly `merkle_sibling_count(DU index,64)=6`
   siblings; truncated, extended or reindexed paths reject.
2. Verify the root-table KZG opening at that fixed cell with the canonical
   encoding of the submitted target MDU root as its expected value. This is the
   existing `verify_mdu0_root_table_proof` contract, not a standalone manifest
   commitment supplied by the provider.
3. Authenticate the submitted blob commitment through its exact Merkle path
   under that authenticated MDU root, at the derived `leaf_index` among the
   frozen K8/M4 layout's 96 leaves. The path consumes exactly
   `merkle_sibling_count(leaf_index,96)` siblings (six or seven, as selected by
   the existing carry-forward tree); truncated, extended, reindexed or
   duplicate-last paths reject.
4. Verify the fresh data KZG opening for that authenticated blob commitment at
   the derived `z` and submitted canonical `y`.

All checks MUST succeed for every included sample before any bitmap mutation,
including an opening whose ordinal was accepted by an earlier message. Existing
strict point/scalar encodings, allocated-user-MDU bounds and exact sibling
consumption rules apply. Neither generation acceptance nor a valid opening for
an unauthenticated commitment substitutes for these membership checks. Such an already-accepted valid tuple
is idempotent; an invalid or rebound retry fails without mutation. The chain does
not require different serialized proof bytes and stores no proof-byte digest.
Settlement requires the ACK and every ordinal assigned to that obligation.

Transport streams complete encoded blobs in plan order. The user-gateway may
persist at most 64 cumulative, monotonic resume checkpoints for the session and
must compact older checkpoints. Checkpoints contain no payment or chain claim.
Retry resumes the same frozen provider obligation before expiry. At expiry, the
chain releases its anchor/generation references and preserves the economic record
needed for one refund. There is no pre-expiry cancellation or unlock: stopping
transport, retry, or ACK leaves every incomplete liability locked. After expiry
(`height > deadline_height`), the authenticated session owner may invoke the
idempotent cancel/refund operation, which refunds each incomplete partition once
to its frozen funding destination and cannot alter a completed partition. Durable
database restart must preserve session, plan,
bitmap, ACK, liability, funding source and expiry references. Export/import is
unsupported until those records are explicitly included and qualified.

For K8/M4, one range creates at most eight systematic provider obligations and
Q is at most 132. Chain state is therefore O(8+132), independent of logical byte
length. One proof message has at most 64 openings; batching changes envelope count,
not sample count or liability. The existing proof gas precharge and 64,000,000 gas /
2 MiB block-byte limits apply. At the measured reference cost of about 4.134M gas for eight openings,
132 openings require many transactions/blocks; this contract makes no throughput
or completion-latency claim.

| Retained resource | V3 ceiling |
| --- | ---: |
| Opens per block | 128 |
| Live retained sessions | 8192 |
| Session TTL | 4096 blocks |
| Concurrent retained generations per deal / globally | 8 / 1024 |
| Provider obligations per session | 8 |
| Accepted-sample bitmap bits per session | 132 |
| Openings per proof message | 64 |
| Maximally packed successful proof messages, excluding retries | 9 |
| Off-chain cumulative resume checkpoints | 64 |

The packed-message bound follows from partitioning 132 samples across at most
eight obligations, filling each provider's 64-opening messages and sending no
empty message. Smaller fragments and idempotent retries can submit more
transactions but cannot add bitmap bits, fees or credit. Admission applies the
shared v2 block/session/generation limits before charging and performs no U-sized
work.

## 7. Admission and activation gate

V3 MUST have its own activation parameter, initially zero. Before activation,
every native, sponsored, protocol, EVM, provider-daemon, user-gateway and browser
route rejects v3 before charging or consuming authority. Activation requires:

- independent agreement on this document and its executable vectors;
- reject a proposed integrity root or leaf count differing from the authenticated
  FAT v3 header, even with otherwise valid blob paths to the proposed root; an
  honest provider must not sign acceptance, and a client must not ACK;
- canonical FAT v3 production and strict parsing in Rust, Go and browser paths;
- atomic producer generation plus all 12 authenticated provider acceptances;
- full-byte integrity before every terminal ACK;
- exact native/EVM parity for IDs, plans, sampling, proof admission and fees;
- reject a valid fresh opening for an unrelated commitment, substituted MDU root,
  wrong root-table cell, and truncated/extended/reindexed membership paths,
  including retries of already-accepted ordinals; no bitmap or balance mutation;
- bounded expiry/refund/restart tests and retained-generation accounting; and
- end-to-end K8 qualification under the production 64,000,000 gas and 2 MiB
  block-byte limits.

Vector success establishes byte-level agreement only. It does not qualify signer
authority, block-hash freshness, gas, crash recovery, transport delivery or safe
network activation. Deployed v3 runtime paths remain disabled until the complete
qualification list above passes independent review. Isolated qualification
networks may explicitly enable v3 through its normal activation parameter to run
these tests under the same protocol and resource limits; this does not authorize
deployed activation or establish delivery or throughput claims.

Run the independent standard-library oracle with:

```sh
python3 polystorechain/pkg/retrievalchallenge/testdata/check_large_session_v3_vectors.py
```

It checks exact FAT v3 header bytes, compact plan, session ID, full context,
anchor seed, distinct positions, off-domain z values, range populations and the
confidence fraction against
`polystorechain/pkg/retrievalchallenge/testdata/large-session-v3-golden.json`.
It also rejects changed bytes, changed coordinates, wrong roots, truncated paths
and invalid odd-leaf duplication. The three-blob tree is a hashing primitive
vector, not a complete admitted generation.

## Native transaction and query interface

The native CLI accepts the generated protobuf JSON message directly:

```sh
polystorechaind tx polystorechain retrieval-session-v3 open request.json \
  --from owner --chain-id "$CHAIN_ID" --generate-only
```

Remove `--generate-only` to sign and submit using the usual chain transaction
flags. The JSON `creator` must equal the address resolved by `--from`; integers
of type `uint64` use decimal strings and byte fields use base64. See command
`--help` for an open-request example. The action selects these message schemas
in `polystorechain/proto/polystorechain/polystorechain/v1/tx.proto`:

| Action | Message |
| --- | --- |
| `open` | `MsgOpenRetrievalSessionV3` |
| `open-sponsored` | `MsgOpenRetrievalSessionV3Sponsored` |
| `prove` | `MsgSubmitRetrievalSessionProofV3` |
| `ack` | `MsgAcknowledgeRetrievalObligationV3` |
| `refund` | `MsgRefundRetrievalSessionV3` |

`Query.GetRetrievalSessionV3` takes the 32-byte session ID and returns the frozen
session, progress bitmap, settlement/refund masks and `anchor_seed`. This field
contains the raw committed H+1 anchor, **not** the derived sampling seed. Derive
`ContextV3.Seed(anchor_seed)` before calling `ContextV3.Challenges`. It is empty
before anchor capture and after reference release. The CLI does not generate
proofs, authenticate downloaded bytes, or create ACK digests; those require the
frozen context and provider/client integration specified above.

## Production upload of an initial v3 generation

`POST /gateway/upload?deal_id=0&fat_version=3` opts into the native v3
producer. Send one multipart `file`; optional fields are `owner`, `file_path`
and `file_size_bytes`. Query `upload_id` enables the existing asynchronous
upload/status flow. The `(deal_id, upload_id)` identity is atomically bound to
FAT version, including retries and cached results. Absent `fat_version`, or
explicit `fat_version=2`, retains the v2 response and behavior.

This initial producer requires an existing, empty, unexpired generation-zero
deal whose actual chain profile is K=8/M=4 and whose twelve distinct slots are
active without pending replacements. It accepts nonempty plain files only;
append, implicit deal creation, file flags, PolyCE, fake ingest and fast ingest
are rejected. Only query parameters select the version and asynchronous identity.
The file's contents are opaque; callers must not label externally encrypted
bytes as a protocol encryption mode.

During RS encoding, each worker hashes all 96 encoded blobs, including parity
and padding, and writes one 3,072-byte block to its deterministic sidecar offset.
The producer streams the completed vector to calculate its root, replaces the
scalar-packed FAT header, and then computes the original encoded MDU0 root.
Artifacts remain immutable and provisional until native generation admission.

The producer uploads MDU0, witness/manifest metadata, the complete integrity
sidecar and the assigned user shards to all twelve providers using the existing
bundle transport, in batches of at most 4,096 artifacts sent serially per
provider. All batches must finish; file size does not increase concurrent
requests. Even a colocated provider receives its bundles through its registered
endpoint. Unsupported bundle endpoints and any incomplete fanout
fail the upload; no per-artifact fallback drops the sidecar. Provider assignments
are checked against the original snapshot before fanout and again before a
successful response.

A successful response contains `generation_candidate`, with decimal-string
`deal_id`, `expected_current_generation`, `size_bytes`, `total_mdus`,
`witness_mdus`, `integrity_leaf_count`; hex `polyfs_root`, `integrity_root`;
`previous_polyfs_root`; `commit_action="propose-deal-generation-v3"` and
`required_acceptances=12`. There is no top-level legacy `cid` or
`manifest_root`, including asynchronous status and cached results.

Save the response as `upload.json`, then use the native CLI proposal route
with your usual owner signing/network flags:

```sh
polystorechaind tx polystorechain propose-deal-generation-v3 \
  --deal-id "$(jq -r .generation_candidate.deal_id upload.json)" \
  --expected-current-generation "$(jq -r .generation_candidate.expected_current_generation upload.json)" \
  --previous-polyfs-root "$(jq -r .generation_candidate.previous_polyfs_root upload.json)" \
  --polyfs-root "$(jq -r .generation_candidate.polyfs_root upload.json)" \
  --integrity-root "$(jq -r .generation_candidate.integrity_root upload.json)" \
  --size "$(jq -r .generation_candidate.size_bytes upload.json)" \
  --total-mdus "$(jq -r .generation_candidate.total_mdus upload.json)" \
  --witness-mdus "$(jq -r .generation_candidate.witness_mdus upload.json)" \
  --integrity-leaf-count "$(jq -r .generation_candidate.integrity_leaf_count upload.json)"
```

For asynchronous status, the candidate is under `result.generation_candidate`.
The size flag is `--size`, not `--size-bytes`. After proposal inclusion, invoke
the authenticated acceptance action below on each provider. Confirm the pending
candidate's acceptance mask is `4095` (`0xfff`), then have the owner submit
`finalize-deal-generation-v3 --deal-id <id> --generation 1 --polyfs-root <root>`.
The gateway does not sign proposals or finalize on the owner's behalf. Both
legacy gateway update relays reject locally staged FAT v3 roots; a direct legacy
chain transaction cannot inspect MDU0, so this is a local relay guard, not a new
consensus format check. Chain activation remains disabled by default and must be
qualified separately. Upload acceptance alone does not qualify retrieval or
chain throughput.

## Provider-daemon integrity artifact

A generation-local `integrity_leaves_v3.bin` contains the ordered raw 32-byte
integrity leaf hashes, with no header or per-leaf sibling paths. Entry
`(mdu_index - metadata_mdus) * 96 + leaf_index` corresponds to that absolute
coordinate under the frozen generation. Its exact length is
`user_mdus * 96 * 32` bytes, bounded by 201,326,592 bytes at the protocol limit.
This is a local ingest representation, not an additional consensus encoding.

Before accepting a proposed generation, the provider-daemon authenticates the
FAT v3 header and requires its root and leaf count to match the proposal. It
streams the leaf vector to reconstruct the canonical duplicate-last tree root
with logarithmic working memory, and recomputes every leaf in its assigned slot
from the stored encoded blob while verifying its KZG commitment membership.
This includes parity slots. A matching sidecar root alone does not establish
that the provider stores the corresponding bytes.

The vector belongs to the immutable generation artifacts. Reusing a generation
with shifted absolute MDU coordinates requires new leaf hashes, as specified
above. This representation does not by itself qualify browser retrieval or
full-byte delivery.

## Provider-daemon and user-gateway data route

The existing `GET /sp/retrieval/mdu/{polyfs_root}/{mdu_index}` provider-daemon route
serves a native v3 systematic-slot chunk when all of these fields are present:

- `Accept: multipart/form-data; version=3`;
- exactly one `X-PolyStore-Session-Id: 0x<32-byte session id>`;
- exactly one canonical decimal `X-PolyStore-Slot` in `0..7`; and
- exactly one canonical decimal `deal_id` plus one `owner` query value.

Optional `X-PolyStore-Start-Blob-Index` and `X-PolyStore-Blob-Count` headers are
strict hints: when supplied they must equal the frozen chunk. The requested root,
deal, owner, user MDU, slot, provider signer and payee must match the committed
session. Settled, acknowledged and refunded slots cannot deliver again. The
existing `GET /gateway/mdu/{polyfs_root}/{mdu_index}` user-gateway route resolves
the same frozen payee and proxies the same request. A v2 lookup must return an
explicit not-found response before either route considers v3; v2 timeouts,
malformed responses and server errors remain failures.

The response uses the existing two-part multipart framing with `version=3`.
The JSON `metadata` part contains:

| Field | Value |
| --- | --- |
| `version` | `3` |
| `session_id`, `context_hash`, `polyfs_root`, `integrity_root` | lowercase `0x` hex frozen authority |
| `slot` | systematic slot number |
| `mdu_index`, `blob_count`, `total_bytes` | canonical decimal strings |
| `start_blob_index` | first slot-major leaf index |
| `entries[]` | ordered `t`, `mdu_index`, `leaf_index`, `integrity_position`, `integrity_path` |

Each `entries[].integrity_path` is an array of lowercase `0x`-encoded 32-byte
siblings in leaf-to-root order. The `bytes` part concatenates one complete
131072-byte encoded blob for each entry. One `(slot, MDU)` response has at most
eight blobs and 1 MiB. The client uses one logical session across all required
chunks, recomputes each coordinate-bound leaf, verifies every path against the
frozen integrity root, and authenticates the FAT v3 metadata against the frozen
PolyFS root before durable write, decode or ACK.

Provider daemons retain `integrity_index_v3.bin`, the complete duplicate-last internal
Merkle levels derived from `integrity_leaves_v3.bin`. Generation acceptance
builds it with bounded memory before publishing the immutable generation.
Previously accepted inactive generations may build the derived index once on
first retrieval under the existing response-capacity and generation-lease
guards. The build is deduplicated, cancellation-aware, disk-reserved and
atomically published. A hot chunk reads only its path. The index is never an
authority: each returned blob is rehashed and its path is checked against the
frozen root before response headers are written.

The browser worker accepts caller-supplied frozen v3 authority and verifies the
same multipart bytes. It checks the complete MDU0 against the frozen PolyFS root
before parsing the FAT v3 header, then binds the header's integrity root and
leaf count to that authority. For data chunks it derives every MDU, slot, leaf
and integrity-tree position from the expected logical `t`, requires exact
response coordinates, and verifies every complete encoded blob with the shared
Rust duplicate-last Merkle primitive before returning bytes. The worker also
exposes canonical context hash, seed and fixed-width challenge derivation from
the shared golden transcript.

The browser client supplies these primitives with authority from the committed
generation-v3 query, obtains the authoritative owner/deal nonce, opens the
session through the wallet and EVM adapter, and queries the frozen session before
requesting provider chunks. It verifies MDU0 and every complete encoded blob
before writing the output, acknowledges each completed obligation, and retains
at most one settled verified output, capped at 1 GiB, until explicit cleanup.
Fetching keeps at most two bounded 1 MiB chunks in flight while writes, flushes
and durable cursors remain ordered. A missing initial generation-v3 query permits
the legacy retrieval path; parameter, deal, timeout, malformed and server
failures remain fatal rather than silently downgrading.

Browser recovery persists the frozen request, output cursors and transaction
journal. Checkpoint and owner/deal locks prevent another tab from opening a
replacement payment. An unfinished checkpoint may be discarded only while its
payment journal is absent, explicitly rejected/prepared, or proven reverted;
broadcasting, committed and malformed records remain for reconciliation. The
current browser client requires the exact trusted loopback user-gateway route
from its latest successful probe before preparing a new native V3 open
transaction, including when data is fetched directly from providers. Existing
broadcasting or committed journals,
settled output caches and expiry refunds remain available without that route.
This precondition prevents locking a new retrieval fee when the client cannot
request provider proof submission; it does not qualify public activation. The
first cold user-gateway request stays alive for up to 5 minutes 30 seconds,
including the provider-daemon's 5-minute index-build bound. Caller cancellation
stops the synchronous build while its response-capacity admission and generation
lease remain held. Warm requests use the hot path above.

The bounded one-user-MDU benchmark
`BenchmarkRetrievalDataV3Hot1MiB` (Linux amd64, 10 iterations) measured a
565545 ns cold build and a 3088-byte index for 96 leaves. After warming, the
authenticated 1 MiB prepare path measured 479544 ns/op, 1101288 B/op and 633
allocs/op. This small-fixture check covers index construction and the hot
verification/allocation boundary; it is not a retrieval-throughput result.

These routes and the browser flow remain unavailable on networks where retrieval
v3 activation is zero. Public activation still requires the complete gate above
and operational qualification on the target network.

The authenticated provider-daemon action is `POST /sp/generation-v3/accept`
with `{"deal_id":0}` and the existing `X-PolyStore-Gateway-Auth` header. An
optional `provider` must equal the daemon's actual signing address. The action
queries the proposed generation and derives the provider slot; callers do not
supply acceptance roots or digests. Owners may propose and finalize through the
native CLI or the EVM adapter. Acceptance uses the same signer coordination and
durable pending transaction state as normal audits; an uncertain broadcast
requires reconciliation before further signing.

## Provider-daemon sampled proof action

Use the existing authenticated `POST /sp/session-proof` action with a single
`session_id` and, optionally, the daemon's actual `provider` address. V3 routing
requires an explicit not-found response from the older session query; a timeout,
malformed response, or server error does not authorize a version fallback.

The daemon reconstructs the frozen context, compact provider plan, and global
sample set from committed session state and the raw anchor. It selects only its
assigned, unaccepted global ordinals, generates and locally verifies at most 64
proofs, then submits one native proof message. Further calls handle any remaining
samples. The action reads challenged blobs; it does not download the requested
file, acknowledge delivery, or qualify client integrity verification.

Normal audits, generation acceptance, and retrieval proofs share the actual
provider's signer lock and durable pending-operation record. A recorded
transaction hash is reconciled before fresh signing, even when its proposal or
session is no longer current. An unknown broadcast without a recorded hash
remains blocked unless the exact operation's accepted effects establish its
outcome. A recovered transaction is not evidence that a different requested
session is complete; callers must query current session state before deciding
whether more proofs or a delivery acknowledgement are required.

## EVM adapter

The existing PolyStore precompile exposes `proposeDealGenerationV3`,
`acceptDealGenerationV3`, `finalizeDealGenerationV3`,
`openRetrievalSessionV3`, `openRetrievalSessionV3Sponsored`,
`submitRetrievalSessionProofV3`, `acknowledgeRetrievalObligationV3` and
`refundRetrievalSessionV3`. The EVM caller maps directly to the native message
creator. In particular, the sponsored-open caller funds the request and each
provider action remains subject to the native frozen-provider authority check.
All methods are nonpayable; attached EVM value is rejected before native state
changes.

Successful owner and sponsored opens emit
`RetrievalSessionV3Opened(uint64 indexed dealId, address indexed requester,
bytes32 sessionId)`. The session ID is copied from the native response, including
an exact idempotent nonce replay. Receipts do not contain the full frozen plan or
payment state; clients must query the authoritative native session by this ID.
The adapter uses the existing native-action journal, proof pricing and block
limits, so EVM revert and out-of-gas roll back generation, session, voucher,
funding, retention and event effects together. This ABI parity does not enable
v3 on a deployed network; activation and target-network qualification remain
separate operational decisions.


## Isolated production-browser qualification

Use `scripts/retrieval_four_validator_workload.py --mode native-v3-browser`.
It creates an isolated four-validator chain, admits a production FAT v3
fixture through all twelve provider-daemons, completes normal storage audits,
and drives the real `DealDetail`, wallet, worker, OPFS and user-gateway path.
It never activates a deployed chain. Use a fresh output directory per run.

On the Linux fixture host, set the four binary/library variables below to
artifacts built from the checked-out revision, install the website's locked
Node dependencies and Playwright Chromium, and use a functioning systemd user
session with cgroup v2 `memory.peak`:

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode native-v3-browser --audit-profile normal --timeout 1800 \
  --browser-bytes 1024 \
  --binary "$CHAIN_BINARY" --library "$CORE_LIBRARY" \
  --gateway-binary "$GATEWAY_BINARY" --cli-binary "$CLI_BINARY" \
  --product-source "$PWD" --home "$RUN_DIR"
```

Run these cases in order, changing `--browser-bytes` and choosing a new
`RUN_DIR` each time. Use `--timeout 3600` for the 1 GiB case to include setup
and audits around its 30-minute retrieval allowance:

| Logical bytes | Required observation |
| --- | --- |
| `1024` | One paid session, verified download and cache; estimate rejection and wallet cancellation before payment; separate short-deal expiry/refund |
| `16777217` | One multi-MDU session; corrupt an unsampled blob, swap multipart sections and truncate a response; unknown-open reconciliation, reload at a durable cursor, settlement and cache |
| `1073741824` | One large session, 8,457 authorized blobs and 132 sampled challenges; 1,064 bounded transport chunks |

Only start the large measurement after the small correctness cases pass.
For the 1 GiB pilot with a separate Mac browser over the LAN, add
`--browser-executor-handoff` and use `--timeout 3600` on the Linux coordinator.
The smaller correctness cases run on the Linux host. Once it publishes
`browser-executor-request.json`, run this from an exact matching, clean Mac
checkout with the locked website dependencies and Chrome installed. Set
`BENCH_SSH` to the fixture host and `REMOTE_RUN_DIR` to its run directory:

```sh
python3 scripts/retrieval_bench_artifact.py browser-executor \
  --ssh "$BENCH_SSH" \
  --remote-request "$REMOTE_RUN_DIR/browser-executor-request.json" \
  --source "$PWD" \
  --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
```

The executor owns four loopback SSH forwards and a fresh persistent browser
profile. It retains the host/browser identity and returns results to the
coordinator for the same four-validator transaction and balance checks.
This topology measures a LAN client with cohosted validators and providers;
it does not establish WAN performance or distributed validator capacity.

Retain `evidence.json`, browser result/memory files and logs with the source
and binary identities. Failed profiles contain private wallet and payload
state; keep them private for diagnosis. A successful result requires the
complete sampled ordinal set, canonical committed transactions on all four
validators, exact payer/provider/burn/refund accounting and a cache download
with no additional MDU requests or payment. Transfer, browser verification,
write/flush, transaction inclusion and provider proof/settlement timings are
separate; concurrent phase durations must not be added together.

Linux reports aggregate cgroup charged memory, including file cache. macOS
reports sampled process-tree RSS, which can double-count shared pages and
miss peaks between samples. Neither is JavaScript heap usage. Keep the
60-second progress heartbeat, ten-minute no-progress watchdog and absolute
execution deadline. Execution limits cap test cost. The
[retained production-browser report](../bench/retrieval_session_capacity/native-browser-291/README.md)
records the passing small, multi-MDU and Mac LAN 1 GiB cases. Its measured
654.052-second paid interval establishes a provisional **14-minute target**
for that topology, including 25% operating margin rounded up to a minute.
This is a single-pilot regression target, not a WAN or p95 service promise.
After a matching run, require both full qualification and the measured target:

```sh
jq -e '.qualification == true and
  (.native_v3_browser.playwright.outcome.progressAfterPaid.phaseMs <= 840000)' \
  "$RUN_DIR/evidence.json"
```

Recalibrate from retained measurements when deployment hardware, topology
or concurrency changes. Public activation remains a separate decision.
