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

Matched retained measurements and peak-process-memory evidence are pending the
coordinator's frozen-harness gate. No performance improvement is claimed yet.
