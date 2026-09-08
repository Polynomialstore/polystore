# Retrieval v2 frozen storage obligations

This implements the C4 keeper path owned by [#255](https://github.com/Polynomialstore/polystore/issues/255).
`retrieval_v2_activation_height=0` remains the default. The finite limits below
are a candidate trusted-devnet profile, not capacity qualification or permission
for funded activation. The [canonical challenge RFC](../rfcs/rfc-challenge-derivation-and-quotas.md)
continues to define exact bytes, rejection sampling, off-domain points and trust
limits. Session authority, admission and refunds are separate from these storage
obligations.

## Issuance and exact statements

For epoch `e`, fixed length `L>=2`, start `S=1+(e-1)L`, and end `E=eL`, BeginBlock
at S reads the committed S-1 assignment view before transactions. It freezes each
eligible assignment's provider, root, generation, setup digest, chain ID, layout,
metadata/user MDU counts, deal lifetime, quota and policy. Epoch length cannot
change after activation. Changing root, assignment, service hint or quota later
cannot modify an issued record or its outcome identity.

The shared anchor is `ctx.HeaderHash()` at S, the ABCI2 current-block hash supplied
by BaseApp. It becomes durable with that block; responses begin at S+1 and end at
`min(E, frozen_deal_end-1)`, inclusive. An unavailable hash remains unavailable;
there is no later-block retry or fallback. An empty response window, zero user
population, or disabled quota creates no obligation. Activation must occur at an
epoch boundary S, after bounded preflight and before that epoch's issuance.

ACTIVE storage statements use canonical context kind 2. Population is
`U=user_mdus*rows`, where rows is 64 for replica and `64/K` for StripeReplica.
Metadata is excluded; allocated user padding and the assigned parity positions
are included. The existing service-hint BPS quota is computed on that population,
clamped to the frozen minimum/maximum and then to U. The reference candidate
`quota_min_blobs=quota_max_blobs=132` yields `Q=min(U,132)`. A v2 policy may set both
minimum and maximum to zero to disable subsequent issuance. Positive-to-zero and
zero-to-positive updates take effect only at the next snapshot. The protocol
hard ceiling remains 4096; that ceiling is not the funded task count.

`MsgProveLiveness.SystemProof` uses the existing signer and proof message. The
keeper locates the authoritative frozen provider/slot statement, checks window,
seed and fixed proof shape, prepays native proof cost plus `100*Q` gas for sampling,
and matches the exact selected `(mdu, leaf, z)`. Position `p_i` and ordinal i remain
distinct. A request samples the bounded list for membership and derives only the
submitted position's z, avoiding Q field-point derivations per individual proof.
The shared FFI then verifies the frozen root and layout. Only successful verified
ordinals set coverage bits, once. Replays and invalid submissions earn nothing.
Constant and zero blobs remain valid; proof-byte uniqueness is not required.

## Pending repair is a separate purpose

Canonical kind 3 denotes pending repair readiness, with the same epoch fields and
window rules as kind 2 but a different context hash. A record is eligible only
for an explicitly REPAIRING slot's pending provider whose repair target generation
matches the current committed generation. It freezes that identity, target root
and layout at S-1. The candidate inventory counts kind 2 and kind 3 together.

The pending quota is the frozen assignment quota multiplied by the existing
`repair_readiness_quota_bps`, rounded up and bounded by population, preserving
the existing one-proof minimum when that fraction is zero and audits are enabled.
Disabling the underlying quota also disables new readiness issuance. One record's
entire distinct list must be proved; partial lists from different epochs cannot
combine. Completion uses the existing readiness and explicit owner
`CompleteSlotRepair` transition only if the current pending identity, target
generation, root and layout still match. The shared deal setter invalidates the
readiness marker on identity, status, root, generation, population or profile
changes. Activation clears all legacy readiness markers and proof counters in
the bounded legacy slot inventory; organic or session credit from v1 cannot
authorize a v2 promotion. Promotion remains an explicit transaction.

Pending proofs do not fulfill ACTIVE obligations, accrue storage rewards, or
change provider health. Their readiness evidence and slot transition are retained.
Organic retrieval, paid sessions, cancellations and deputy activity likewise
supply no storage quota, reward, health or readiness credit under v2. Existing
bandwidth payment and operational repair actions retain their own authority.

## Epoch outcomes and bounds

The coverage bitmap is the only ACTIVE proof count used by v2 finalization and
base rewards. Missing/corrupt seeds and unissued statements provide neither a
fulfilled reward nor a provider failure. Base reward weights use frozen assigned
user bytes and complete coverage, preserving existing provider eligibility rules.
Distinct valid ACTIVE proofs retain the existing storage reward schedule, with
its policy frozen for the epoch. Organic volume cannot reduce Q or increase those
storage rewards.

Finalization reuses the existing soft quota-shortfall evidence, cooldown and repair
policy. It records the frozen outgoing provider's outcome after assignment changes
and never transfers that missed count or slot-health transition to a replacement.
It does not introduce a new invalid-proof slash or penalty engine. A finalized
epoch cannot apply its outcome or base payout twice.

| Resource | Candidate bound and owner |
| --- | --- |
| ACTIVE plus pending assignment view | 64 entries, maintained by every production deal mutation through `setDealWithAssignmentCollateralLocks` |
| Activation legacy preflight | Reads at most 65 deal records to reject an inventory above 64; at most 64 legacy slots total, including empty/expired deals, and at most 128 readiness removals |
| Epoch storage records | At most 64 per epoch, current and previous only |
| Coverage bitmap | At most 512 bytes per record at the protocol ceiling; 17 bytes for Q=132 |
| Audit anchor/generation references | At most 128 retained obligations across two epochs |
| Additional generations from audits | At most two per deal; union with the session limits of eight per deal and 1024 globally |
| Funded retrieval `AuditTask` issuance | Separate global cap 64 per epoch; v2 candidates come only from the bounded frozen ACTIVE view with an available seed |
| Provider audit listing | At most 128 records; one detailed request derives at most Q<=4096 challenges |
| Complete retained-generation query | At most 8192 session expiry references and 128 audit records; at most 1152 sorted, deduplicated tuples |

A larger historic deal inventory needs a reviewed bounded migration before
activation; the preflight never silently omits older or closed records. Legacy
slot lists also have a 256-entry wire ceiling, checked before iteration. An
aggregate inventory above 64 legacy slots requires the same reviewed migration;
all validation finishes before any readiness key is removed. The store-backed
activation regression uses a finite 64,000,000 gas meter: 64 live slots with
Q=132 consumed 2,295,007 gas; 64 expired slots consumed 192,845 gas. These cover
the added readiness clearing and shared activation hook, not complete block
execution or arbitrary historic state sizes. After
activation the shared setter rejects mutations that exceed the live assignment
cap before writing the new deal. Expired view entries are removed during bounded
view maintenance. The cap deliberately limits this candidate network; it is not
a claim that larger networks are unsupported in principle.

The two-epoch audit retention process releases only audit references. A seed is
removed only when audit and session references both reach zero. Providers must
retain the union of audit snapshots and active session snapshots, including old
roots after a content update. Restart evidence uses actual IAVL commit and an
independently reopened multistore/keeper; it does not assert that the pre-existing
genesis export code exports the new state.

These bounds cover new C4 issuance/finalization and v2 funded task candidates.
Existing global provider-health decay, jail, underbonding, draining and rotation
scans remain in EndBlock. Existing assignment collateral eligibility work and
legacy task history are also outside this new cap. [#260](https://github.com/Polynomialstore/polystore/issues/260)
must measure the complete integrated workload before funded activation.

## Provider queries and verification

`ListStorageAuditsByProvider` returns current/previous records, frozen canonical
context bytes, seed availability and finalization status for scheduling.
`GetStorageAuditChallenge` selects one retained
`(epoch_id,deal_id,slot,provider)` and returns exact ordinals, selected population
indices, MDU/leaf positions and off-domain z values. Missing seeds produce an
unavailable view with no invented challenge list.

`RetainedGenerations({})` (`GET /polystorechain/polystorechain/v1/retained-generations`)
is the complete chain retention contract. It returns `committed_height` and sorted,
deduplicated `(deal_id,generation,manifest_root)` tuples from live session expiry
references plus current/previous audit references. Completed sessions remain in
this union until their actual reference release. The query has no provider filter:
assigned providers and authorized deputies need the same historical protection.
It validates the frozen contexts, reference keys, counters, generation roots and
shared anchors; malformed, inconsistent or oversized state fails the whole query
without a partial list. Unreferenced session/deal history does not add query work.

Provider cleanup must obtain the complete successful response at an authoritative
committed height, union it with locally owned in-flight references, and preserve
all returned generations. A failed, incomplete or stale query cannot mean an empty
retention set. Reading a retained root must never switch the active generation.
The chain endpoint is implemented here; provider filesystem ownership and cleanup
changes remain in [#257](https://github.com/Polynomialstore/polystore/issues/257).

The native path is tested with a real zero-blob KZG proof, duplicate rejection,
root mutation and pending repair completion. Further tests exercise populations
0/1/131/132/133, empty windows, missing anchors, disabled policy transitions,
index/retention ceilings, old-provider attribution and persisted restart. An
independent Python oracle covers session, audit and repair canonical bytes and
challenge vectors. These tests establish those boundaries, not cross-host
capacity, delivery freshness, storage exclusivity, formal retrievability, proposer
unbiasability or grinding resistance. The accepted block-hash source still relies
on the trusted-devnet non-grinding assumption.

Local helper characterization on Apple M3/darwin-arm64, `GOMAXPROCS=2`, 100
iterations (native verification and global hooks excluded):

| New work | Time/op | Bytes/op | Allocations/op |
| --- | ---: | ---: | ---: |
| One selected tuple, Q=132 | 52.7 µs | 47,373 | 804 |
| One selected tuple, Q=1375 | 410 µs | 468,587 | 8,266 |
| Epoch issuance/pruning and shared session hook, 64 assignments, Q=132 | 1.162 ms | 1,985,992 | 14,539 |

The complete retained-generation query at its legal reference ceiling (8192
session references, 128 audit records, 1152 tuples) measured 46.15 ms/op,
21,399,179 bytes/op and 193,312 allocations/op over 10 iterations on the same
host. This is query work, separate from BeginBlock.

These characterize added work without a speedup or end-to-end throughput claim.
With the required native library and patched vendor dependencies prepared, run
from the repository root:

```sh
GOMAXPROCS=2 ./scripts/chain_go.sh test -p 2 ./pkg/retrievalchallenge ./x/polystorechain/keeper \
  -run '^$' -bench 'Benchmark(AuditChallengeForPosition|StorageAuditMaximumEpoch)$' \
  -benchtime=100x -benchmem
GOMAXPROCS=2 ./scripts/chain_go.sh test -p 2 ./x/polystorechain/keeper \
  -run '^$' -bench '^BenchmarkRetainedGenerationsMaximum$' -benchtime=10x -benchmem
```
