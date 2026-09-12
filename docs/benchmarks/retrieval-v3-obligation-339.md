# V3 provider-obligation aggregate qualification (#339)

The provider-daemon now sends its existing nonempty, at-most-64-proof obligation
as one `sessions` entry in `MsgSubmitRetrievalSessionProofBatchV3`, using the
existing `retrieval-session-v3 prove-batch` CLI and native PSB2 aggregate verifier.
There is no cross-session collector, new signer queue, or change to the HTTP
response, exact-ordinal journal, accepted bitmap, settlement authority, or V2
fallback. Explicit `prove` remains available for independent verification.

## Matched diagnostic, not end-to-end capacity

The same frozen session, provider slot, nonconstant real KZG proofs and committed
ACK state are submitted to the independent and aggregate keeper routes. Each
operation freshly accepts every proof in that obligation and settles it. The
test compares results, complete module state, events and bank effects between
identical fixtures. The benchmark times keeper preparation, verification and
settlement, excluding fixture construction, proof generation, the prior owner
ACK, cache-branch creation and mock-bank reset. Each iteration resets both state
and bank effects; it does not benchmark replay or let mock transfers accumulate.

These are completed **obligations**, not completed eight-provider sessions. The
singleton is a 1 KiB range. The 2/8/16-proof fixtures have 16/64/128 global
samples respectively, partitioned across eight providers. Synthetic 32/64-proof
same-slot partitions are tested only as envelope/continuation boundaries, not
presented as typical performance fixtures.

Frozen product and harness candidate:
`41e8158da3d45e04b5649e763afcd5546fd9e6c6`. Both compared routes are available at
that head; the independent route is the old provider dispatch target. Subsequent
HTTP test and documentation additions do not change this benchmark or production
dispatcher. Native core tree: `469cabf263c4a5a88741ad70a0289eba70fd4f1c`.

The coordinator reviewed the harness before the bounded diagnostic. Dedicated
Linux/amd64 runner: AMD Ryzen 7 9700X, 8 cores / 16 threads; Go 1.25.5,
`GOMAXPROCS=4`, existing release native library, no concurrent workload at
measurement time. Five repetitions of 50 operations per route/size, 90-second
outer execution limit. Medians below; [raw output](retrieval-v3-obligation-339.txt)
preserves stdout/stderr interleaving.

| Proofs in one obligation | Independent ns/op | Aggregate ns/op | Independent obligations/s | Aggregate obligations/s | Speedup |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4,502,774 | 2,673,459 | 222.1 | 374.0 | 1.68x |
| 2 | 9,008,111 | 3,153,468 | 111.0 | 317.1 | 2.86x |
| 8 | 35,944,147 | 5,855,315 | 27.82 | 170.8 | 6.14x |
| 16 | 71,856,071 | 9,438,511 | 13.92 | 105.9 | 7.61x |

| Proofs | Independent keeper gas/op | Aggregate keeper gas/op | Independent message bytes | Aggregate message bytes |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1,225,374 | 1,025,374 | 833 | 836 |
| 2 | 2,450,016 | 1,150,016 | 1,591 | 1,594 |
| 8 | 9,650,379 | 1,750,379 | 6,127 | 6,130 |
| 16 | 19,250,445 | 2,550,445 | 12,173 | 12,176 |

These byte counts are unsigned protobuf **messages**, not signed transactions;
gas is consumed inside the measured keeper branch, not transaction GasWanted or
GasUsed. The unchanged independent crypto precharge is `1,200,000*n`; PSB2 is
`1,000,000 + (n-1)*100,000`. Ante handling, transaction framing, signing, gas
estimation, submission retries, commit observation, provider proof preparation,
and browser/network delivery require separate measurements. Nothing here
requalifies 473.6 proof-confirmed sessions/s, changes deployments, or claims a
network-wide capacity multiplier. Whole-pipeline qualification belongs to #343.

## Allocation and ownership audit

| Proofs | Independent B/op | Aggregate B/op | Independent allocs/op | Aggregate allocs/op |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 20,817 | 22,905 | 233 | 240 |
| 2 | 47,278 | 50,094 | 691 | 696 |
| 8 | 110,950 | 117,150 | 1,524 | 1,517 |
| 16 | 198,147 | 209,206 | 2,667 | 2,644 |

Residual Go allocation increases of 2,088 / 2,816 / 6,200 / 11,059 bytes per
operation are accepted for the measured verification reduction; there is no
zero-copy or allocation-reduction claim. Singleton allocation count increases
by seven even though CPU time falls. Go allocation metrics do not account for
native Rust allocations. The entire diagnostic process, including both routes
and fixture construction, used a maximum RSS of 106,608 KiB; this is not a
per-route memory comparison. It completed in 38.89 seconds wall time, 39.76
seconds user CPU and 0.05 seconds system CPU, with no swap.

- Provider submission wraps the existing proof slice without deep-copying its
  proof bytes. `jsonpb` still serializes the complete envelope to a bounded
  temporary file; that file is closed before submission and removed on request
  exit, including ambiguous, rejected and successful outcomes. No proof bodies
  are added to the persistent journal.
- The aggregate keeper creates bounded per-entry/per-proof wrapper slices. The
  Go PSB2 encoder validates all sizes before one exact-capacity buffer allocation,
  capped at 70,028 bytes. The synchronous FFI call borrows that buffer without
  retaining Go pointers or adding a separate `C.CBytes` copy.
- Rust parsing borrows Merkle-path bytes and owns bounded record/transcript/
  opening/MSM vectors. These are temporary native allocations and are released
  when the synchronous verifier returns; the trusted setup remains shared.

## Reproduction and correctness gates

Compile outside the timing window, using the chain's required vendor wrapper
and an existing compatible release native library:

```sh
GOMAXPROCS=4 ./scripts/chain_go.sh test -p 4 -c \
  -o /tmp/polystore-339-keeper.test ./x/polystorechain/keeper
cd polystorechain/x/polystorechain/keeper
GOMAXPROCS=4 timeout 90s /usr/bin/time -v /tmp/polystore-339-keeper.test \
  -test.run='^$' -test.bench='^BenchmarkRetrievalV3SameObligationSettlement$' \
  -test.benchmem -test.benchtime=50x -test.count=5 -test.timeout=90s
```

Set `CGO_LDFLAGS=-L<release-library-directory> -lpolystore_core` and
`LD_LIBRARY_PATH=<release-library-directory>` when reusing a library outside the
worktree. On macOS use `DYLD_LIBRARY_PATH` and omit Linux `timeout`/`time -v`.

Correctness gates include the real user-gateway continuation through the
authenticated provider handler at 1/2/8/16 proofs; exact serialized aggregate
shape and durable pre-broadcast intent; hash persistence before pending replies;
hashless quarantine and exact-ordinal reconciliation; actual signing-account
changes; rejection/local-failure cleanup; empty-envelope no-broadcast behavior;
0/1/2/8/16/32/64/65/132 synthetic partition/continuation boundaries; existing V2
submission and priority-audit signer locks; and native aggregate invalid-member,
atomic settlement rollback, replay and CLI round-trip tests. The HTTP test mocks
CLI broadcast/commit responses, while the keeper comparator executes the native
aggregate verifier; these are complementary tests, not a live-chain E2E run.

The shared V3 profile's PSB2 gas and CLI wording is updated by the #338 profile
owner to avoid conflicting edits. This document owns the #339 measured
comparison; channel design and cross-session coalescing remain separate work.
