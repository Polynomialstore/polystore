# V3 terminal lifecycle qualification (#338)

## Admission correctness

`churn-49ddaba7.log` records a PASS at exact source
`49ddaba7b9b00b985209a137085f417a937264bc` (base
`66ec21b1ff6f5a73e2077640f539c289fbf3b3c9`). The opt-in test completed
8,193 distinct V3 sessions, each with a freshly generated nonconstant native
KZG proof, before each session's original deadline. New waves use the maximum
4,096-block TTL. An unfinished V2 session remains live and retained-generation
inventory is checked after every wave. No TTL reduction or live-cap increase.

Dedicated AMD Ryzen 7 9700X Linux runner, `GOMAXPROCS=4`; warm Go 1.25.5/vendor
and native library from the matching core source. Wall duration: **237.50 s**.
This is keeper admission correctness, **not** byte-delivery or service-capacity
evidence. No total historical-state bound is established.

```sh
# Compile from the source root with the normal native library available.
GOMAXPROCS=4 ./scripts/chain_go.sh test -p 4 -c -o /tmp/338-keeper.test ./x/polystorechain/keeper
# Run from polystorechain/x/polystorechain/keeper for the trusted setup path.
GOMAXPROCS=4 POLYSTORE_RUN_V3_COMPLETION_CHURN=1 timeout 900s /tmp/338-keeper.test \
  -test.run='^TestRetrievalSessionV3CompletionChurnBeyondLiveCapacity$' -test.timeout=14m -test.v
```

SHA-256 `churn-49ddaba7.log`:
`f8ca079ea8c6ed074de6d7cfe842d36ee58bcc474e7a54b823ea080dca960e43`.
The first local M3/GOMAXPROCS=2 attempt was stopped by its 3-minute test timeout
during fresh native proof generation; it was not counted as a pass.

## Lifecycle cost scope

The matched benchmark covers ACK after accepted proof, singleton/aggregate proof
after ACK, and later expiry. Fixture and fresh nonconstant proof generation are
excluded; SDK cache creation/discard, message literal allocation and gas-meter
reads are included. Each iteration begins from the same parent and discards its
cache, including the fixture bank's effects. Post-timer assertions ensure actual
acceptance/settlement and the expected live/generation accounting, and report the
observed terminal-row count so a no-op cannot silently become a fast result.

Process live Go heap is sampled after GC while the fixture and final cache remain
alive; reserved Go heap is separately labeled. Neither includes native heap or
constitutes per-transition allocation. `B/op`/`allocs/op` are the timed benchmark
metrics. A separate diagnostic counts reference Get/Has, Set and Delete calls;
it excludes iterator steps, session economic rows and bank rows and is not
installed in the timing benchmark.

## Matched retained measurements

Both runs passed on the same dedicated AMD Ryzen 7 9700X Linux host, Go 1.25.5,
`GOMAXPROCS=4`, sequentially with 50 iterations and five repetitions per phase.
Each execution had a 90-second external limit and 85-second test limit; both
finished in 24.61 seconds. Numbers below are independent medians of the five
repetitions; timings are descriptive, not a confidence-interval claim.

- Baseline: `66ec21b1ff6f5a73e2077640f539c289fbf3b3c9` plus the identical two
  new harness files and only `*testing.T` → `testing.TB` signatures for existing
  `ackDigestV3` / `newSessionCacheBank` helpers. No baseline production edits.
- Candidate: `cd77edc1bb671e87759901fceb5041815d778884`.
- Timed harness Git blob: `94e5450e2074b81ea86580d283b3ec10da91a883`.
  Untimed reference-counter blob: `bcfc10414158b3be53b63f19bd39e0ca3e6c2068`.
- Identical native source tree: `469cabf263c4a5a88741ad70a0289eba70fd4f1c`.
  Reused Linux `libpolystore_core.so` SHA-256:
  `11b7f1f3d12fc9fa14e604b911ab7a37a6290d4bfe4d113fad273b92f75691c2`.

Each row is one transition of the stated number of sessions. `8` is not a
per-session figure. Arrows are baseline → candidate.

| Phase | Sessions | µs/op | Gas/op | B/op | allocs/op |
| --- | ---: | ---: | ---: | ---: | ---: |
| ACK after proof | 1 | 23.565 → 32.042 | 43,803 → 70,880 | 26,531 → 47,134 | 322 → 439 |
| ACK after proof | 8 | 165.339 → 215.622 | 350,574 → 578,999 | 179,643 → 310,641 | 2,216 → 2,937 |
| Singleton proof after ACK | 1 | 4,502.717 → 4,508.051 | 1,243,812 → 1,270,889 | 26,180 → 46,788 | 312 → 429 |
| Aggregate proof after ACK | 1 | 2,686.272 → 2,694.728 | 1,043,812 → 1,070,889 | 28,022 → 48,636 | 318 → 435 |
| Aggregate proof after ACK | 8 | 5,839.021 → 5,896.927 | 2,034,924 → 2,263,349 | 171,217 → 302,207 | 2,086 → 2,807 |
| Later expiry | 1 | 29.638 → 12.796 | 51,939 → 10,854 | 48,448 → 22,976 | 413 → 207 |
| Later expiry | 8 | 107.641 → 13.231 | 294,671 → 10,854 | 163,256 → 22,976 | 1,542 → 207 |

This intentionally moves cleanup into the final settlement transaction. The
one-session ACK adds 8.477 µs, 27,077 gas, 20,603 allocated bytes and 117
allocations. The eight-session ACK adds 50.283 µs total. The later expiry loses
the completed-session work. Summing these isolated ACK and expiry phase medians
gives 53.203 → 44.838 µs for one session and 272.980 → 228.853 µs for eight;
gas and allocation sums also decrease. These sums are an accounting comparison,
not a measured end-to-end lifecycle latency. Proof-path changes below 1% are not
claimed as statistically significant. No higher delivery throughput follows.

Whole-process post-GC live Go heap ranged 27,741,592–27,938,944 bytes on baseline
and 27,736,136–27,923,400 bytes on candidate. Median reserved Go heap across
phases was 83.10–83.20 MB and 74.68–74.81 MB respectively. `/usr/bin/time -v`
peak process RSS was 128,824 KiB and 122,472 KiB. These include fixtures and
runtime/native process state (RSS), are **not per-operation memory**, do not
measure large historical state, and are not claimed as a memory improvement.

### Reference-operation and copy audit

The separate counter reports application-store API calls, not physical disk
writes. Reads are Get/Has; iterators and economic/session/bank rows are excluded.

| Phase | Sessions | Get/Has | Set | Delete |
| --- | ---: | ---: | ---: | ---: |
| ACK completion | 1 | 1 → 10 | 0 → 3 | 0 → 5 |
| ACK completion | 8 | 8 → 66 | 0 → 38 | 0 → 12 |
| Later expiry | 1 | 6 → 1 | 2 → 0 | 5 → 0 |
| Later expiry | 8 | 20 → 1 | 16 → 0 | 12 → 0 |

The new path iterates only represented obligations (bounded by the existing
slot limit), never the session collection. Existing message validation and
session protobuf decoding remain; passing the session value to the release
helper is a shallow struct copy, not a second serialized full context. Collection
codecs and SDK cache entries allocate for the bounded reference reads/writes;
the measured extra B/op includes that transient work. The shared anchor is read
once to retain its seed and again by the shared decrement helper, intentionally
reusing the expiry path's underflow/audit-reference checks. No new blob or proof
copy, retained full-context duplicate, global cache or unbounded cleanup was
introduced. The only additional durable payload is the 32-byte original seed
under a 40-byte prefix and 32-byte session key: **104 application KV bytes**.
It is also the exactly-once marker and remains with the historical session and
nonce indexes indefinitely. This is not a physical database-size estimate.

The graph coordinator explicitly accepted the bounded early-terminal overhead
and retained duplicate safety read as the implementation tradeoff for #338.
No deployed-state pruning, economics change or capacity increase is implied.

### Reproduction and integrity

On each source variant, supply the same native library directory through
`CGO_LDFLAGS` / `LD_LIBRARY_PATH`, compile using the command above, then run from
`polystorechain/x/polystorechain/keeper`:

```sh
GOMAXPROCS=4 /usr/bin/time -v timeout 90s /tmp/338-keeper.test \
  -test.run='^TestRetrievalV3CompletionReferenceOperationCounts$' \
  -test.bench='^BenchmarkRetrievalV3Completion$' \
  -test.benchtime=50x -test.count=5 -test.timeout=85s -test.v
```

Raw logs (include individual measurements, semantic checks and process RSS):

- [Baseline](338-base-66ec21b1.log), SHA-256
  `3691aacddd8482935c04ec48d1f00906b907bcf266c79dbd8036f63926620094`.
- [Candidate](338-candidate-cd77edc1.log), SHA-256
  `887cd2bcc3ef3cab84efb093638d4acb4e1b266b4ca8ddd2afa901d35424ed50`.
