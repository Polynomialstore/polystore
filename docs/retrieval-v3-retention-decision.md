# V3 retrieval-state retention decision (#341)

Status: **measured proposal; no pruning or public-contract change**. Parent:
[#337](https://github.com/Polynomialstore/polystore/issues/337). Existing full
session and nonce queries, exact retries, and refunds remain authoritative.
This document does not approve an archive service or unlimited operating volume.

## What is retained today

Inspected runtime: `66ec21b1ff6f5a73e2077640f539c289fbf3b3c9`.
The production paths are `keeper/retrieval_v3_session.go`,
`keeper/retrieval_challenge.go`, `keeper/query.go`, and
`keeper/query_retained_generations.go` under `polystorechain/x/polystorechain`.

| State / index | Created / released | Consumer and irreducible purpose |
| --- | --- | --- |
| Full `RetrievalSessionsV3` row, keyed by 32-byte ID | Every open; settlement/refund mutate it; no removal | Frozen authorization, sample bitmap, ACK/settlement/refund masks, exact open retry, session query and interrupted transfer recovery |
| Owner/deal/nonce → ID | Every successful open; never removed | Resolve an unknown committed open without funding a second one |
| Owner/deal nonce high-water | Updated on successful open; never removed | Reject reused lower/equal nonces; one row per distinct owner/deal, not per session |
| Expiry reference + per-height count | Open / bounded original-expiry processing | Enumerate due live contexts without scanning all history |
| Per-height open count | Open / next-block processing | Bound admissions per block; early completion must not reset it |
| Live count | Open / expiry at the inspected baseline | Bound outstanding challenge contexts, not all-time rows |
| Generation refs + per-deal/global generation counts | Open / last reference released | Keep old provider generation artifacts while active sessions require them |
| Shared anchor with separate session/audit refcounts | Open/audit scheduling / last reference released | Fresh challenge seed; one consumer may not remove another's anchor |
| Proposed #338 terminal anchor map | Completed-session early release / no pruning proposed | Preserve authenticated pre-deadline replay and query seed after releasing shared refs |

The #338 candidate proposes `RetrievalSessionV3TerminalAnchors/value/`:
40 prefix bytes + 32 ID bytes + 32 seed bytes = **104 additional application
key/value bytes per early-completed session**. This is a proposal at this
document's baseline, not a claim that the map is already deployed. Its final
codec and lifecycle must be remeasured after #338 lands.

Expired-but-unrefunded rows retain actual money owed. Zero locked value alone
does not mean a zero-priced session completed. A partially settled session may
still have refundable partitions. No cleanup may silently forfeit those claims.

Application state is separate from CometBFT blocks/transactions, historical
IAVL versions, provider artifacts, and browser/provider journals. Pruning block
history does not remove application rows. Releasing generation refs permits
artifact GC only under the provider's existing retention rules; it is not chain
history deletion. Current genesis export/import is not a session archive.

## Reproducible size experiment

`TestRetrievalV3RetentionSerializedFootprint` constructs 1 KiB, eight-blob,
and 1 GiB fixtures using production range/plan/context/sample derivation,
validates the stored rows, round-trips their actual protobuf encoding, and
measures the actual collections key/value codecs. Currency is `stake`, price
3/blob, base fee 5, burn 250 bps; chain ID `retention-341`, one owner/deal,
nonce 1, snapshot 10000 and deadline 14096. IDs, roots and providers are fixed
synthetic fixtures. These are representative sizes, **not maximum-size amounts,
denoms, owner cardinality or chain identifiers**.

| Logical range | Obligations / samples | Live row + nonce index | Settled row + nonce index | Expired, unrefunded | Refunded |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 KiB | 1 / 1 | 705 B | 711 B | 708 B | 711 B |
| 1,015,808 B | 8 / 8 | 1,453 B | 1,460 B | 1,456 B | 1,459 B |
| 1 GiB | 8 / 132 | 1,496 B | 1,500 B | 1,499 B | 1,499 B |

The nonce index is 126 B/session; the high-water row adds 92 B per owner/deal
for these address lengths. The settled protobufs alone are 527, 1276 and
1316 B. The baseline table excludes live shared refs, #338's proposed 104 B,
IAVL nodes, history, compression, WALs and block data. Integer-width changes
are measured in the growing fixture below; do not multiply nonce-1 sizes and
call the result an exact long-run database bound.

`TestRetrievalV3RetentionCommittedGrowth` inserts **phase snapshots directly**
using the production maps, 128 terminal rows per commit, four IAVL versions,
GoLevelDB, then reloads the store and checks row/nonce identity. It does not
execute funding, delivery, ACK, proof verification, or full open/terminal churn.
That production-path endurance gate belongs to #338/#343.

Diagnostic run: Apple M3, 16 GiB, macOS, Go 1.25.5 darwin/arm64,
`GOMAXPROCS=2`. The test itself took 1.686 s including both measurements;
other focused tests were active, so **no CPU throughput claim** is made.

| Fixture | 128 rows: DB key/value bytes | 512 rows: DB key/value bytes | Last 128-row marginal bytes/session | 512 rows: compacted directory bytes | GC-observed retained heap delta |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 KiB settled | 224,519 | 966,268 | 1,985.11 | 570,189 | 6,542,304 B |
| 1 GiB settled | 426,502 | 1,780,052 | 3,597.48 | 530,234 | 9,728,000 B |

DB key/value bytes include retained IAVL versions and internal indexes.
Directory size includes LevelDB files after an explicit compaction, not an
uncompressed logical limit; the fixtures' repetitive fields compress well.
Heap deltas include backend/store caches and runtime noise and are not a
per-session live-heap bound. These small slopes cannot establish a million-row
or many-version bound; measure the actual database during qualification.

Run from the repository root after the normal native-library build:

```sh
GOMAXPROCS=2 ./scripts/chain_go.sh test -p 2 -count=1 -timeout 3m \
  ./x/polystorechain/keeper -run TestRetrievalV3Retention -v
```

For the diagnostic, `CGO_LDFLAGS` and `DYLD_LIBRARY_PATH` selected the existing
native library in sibling `polystore-160m-final/polystore_core/target/release`.
Its core source tree `469cabf263c4a5a88741ad70a0289eba70fd4f1c` is identical
to the inspected runtime. No native crypto result is inferred from reuse.
This instrumentation-only work uses an exploratory-measurement test-first
exception: there is no production defect fixed by these tests.

## Minimal recommended decision: bounded qualification, unchanged history

Do not add a garbage collector merely to close this issue. Preserve existing
queries, exact retry and refund rights. Obtain human approval for a bounded,
isolated qualification envelope:

- Stop admitting new test sessions at **1,000,000 cumulative new sessions OR
  4 GiB additional application database data**, whichever comes first.
- Warn at 750,000 sessions or 3 GiB added data. Forecast remaining budget from
  observed growth; do not subtract expired sessions from lifetime consumption.
- Count every funded open, not only successful completions. Account for
  owner/deal cardinality, outstanding refundable amount and oldest liability.
- This is a harness/operator gate to implement and test in #343, **not an
  existing production admission guard** or an approved deployment limit.
- The provisional 4 KiB/session planning allowance rounds up the largest
  observed 3,597.48 B marginal slope plus the proposed 104 B terminal record.
  It is an estimate, not an upper bound; the measured byte stop is mandatory.
- At 1, 10, and 100 new sessions/s, one million sessions is approximately
  11.57 days, 27.78 hours, and 2.78 hours respectively. These are arithmetic,
  not achieved lifecycle rates. No 24-hour service claim follows.
- Revisit before any higher volume, longer duration, production deployment,
  >4 KiB/session observed sustained slope, or growing unresolved liabilities.
  A finite approved benchmark cannot approve indefinite archive growth.

**Approval: pending.** A merged analysis PR is not human approval of the
operating envelope or of changed recovery/refund semantics. #343 must retain
this explicit decision gate and stop on exhausted budget. Do not close #341
until that decision and final #338 size delta are recorded.

## If finite-history product operation becomes necessary

The least disruptive candidate is a versioned terminal-outcome compaction,
not deletion of all old nonces. It still has tradeoffs requiring approval:

1. Preserve full rows and exact existing queries during an explicit height-based
   window. The window value remains undecided; do not silently choose a deadline.
2. For settled/refunded rows only, compact into authenticated ID, original
   request binding, funding recipient, terminal masks/outcome and version.
   Preserve enough data for whatever exact-retry promise is approved.
   Compact rows still grow with lifetime sessions.
3. To actually bound history, retire even compact rows after an approved
   horizon. Keep a high-water mark per owner/deal. Return explicit historical
   unavailability for unknown nonce ≤ high-water; never imply “not committed”.
   Nonce gaps mean high-water alone cannot tell a skipped nonce from a pruned
   committed nonce. Unknown committed-open recovery must fail closed, not
   open/fund a replacement.
4. Never compact away unpaid amounts, redirect refunds, or introduce a refund
   deadline as cleanup. Unresolved liability backlog is an irreducible
   per-claim state/collateral budget unless separately redesigned and approved.
5. If an external archive is chosen, specify authenticated proofs, availability,
   retention ownership and unavailable behavior. No such archive is assumed
   to exist. A genesis export is not a substitute.

Any implementation needs a bounded due-key index, persisted cursor and maximum
entries **and bytes** per block; interrupted cleanup resumes atomically.
Candidate work bound: at most 128 entries and 128 KiB examined/written per block,
stopping before the next over-budget item. These are unapproved starting
parameters, not evidence of capacity. Shared refs release only once and before
terminal history compaction. No all-history scan in open/ACK/proof or EndBlock.
Migration must recognize existing full rows, preserve nonce high-water and
money, and keep old queries until a coordinated versioned API/client upgrade.
No implementation child is authorized yet.

## Contract vectors required for an approved implementation

| Case | Required result / existing evidence |
| --- | --- |
| Valid settled proof retry / modified evaluation | Current `TestRetrievalSessionV3RealProofAckSettlementAndReplay`; do not replace crypto verification with a terminal success shortcut |
| Same nonce, changed terms; retry after deadline/root change | `TestRetrievalSessionV3ExactOpenRetryUsesFrozenTerms`; unchanged full-history behavior until versioned approval |
| Unknown committed open beyond prune horizon / missing archive | Explicit unavailable/ambiguous result; no second funded open; new red API and browser recovery tests required |
| Partial settlement / refund; zero-priced unfinished | `TestRetrievalSessionV3PartialSettlementExpiryAndRefund`, `TestRetrievalSessionV3ZeroPricedRefundPersistsOnce`; preserve each unresolved partition |
| Multiple owner/deal scopes and skipped nonces | Separate high-water marks; an unavailable historical lookup is not evidence of a never-used nonce |
| Restart / interrupted cleanup / one-over entry or byte budget | Cursor and mutations commit atomically, no skipped claim, no double-release, bounded work; new red migration/cleanup tests required |

The current experiment covers serializer validity, all four row phases, bounded
repeated inserts and committed-store reload. It intentionally does not create
a second simulated protocol whose passing tests would be mistaken for implemented
pruning, cryptographic authorization or complete-lifecycle qualification.

