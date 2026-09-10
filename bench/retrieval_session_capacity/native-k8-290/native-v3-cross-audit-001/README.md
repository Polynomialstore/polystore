# Retained native-v3 provider cross-audit diagnostic (#290)

This artifact records one retained run of the production `provider-daemon` HTTP
route on the reviewed landed harness. It is a **single-host operating-point
diagnostic**, with `qualification=false`: it establishes that 360 measured proof
transactions were offered at 2 transactions/s, all eventually committed, and
normal audits completed across two anchors. It does not establish maximum chain
capacity, a realistic deployment rate, WAN behavior, or delivered-byte capacity.

The run used four validators and twelve provider-daemons on one Linux host. It
opened 46 native v3 16 MiB logical sessions in two append-signed transactions of
31 and 15 messages. Eight provider transactions warmed the route outside the
clock. The measured scheduler then offered 360 transactions round-robin across
the eight systematic providers for 180 seconds, with at most one active request
per provider. Each transaction carried the provider's full assigned set of 15,
16, or 17 authenticated sample openings.

## Result

| Quantity | Retained result |
| --- | ---: |
| Offered / eventually committed-valid measured transactions | 360 / 360 |
| Authoritatively accepted measured openings | 5,940 |
| Fixed offered rate | 2 transactions/s; 33 openings/s |
| Scheduler duration, including drain | 182.066769129 s |
| Committed-valid transactions / scheduler second | 1.9772965804 |
| Accepted openings / scheduler second | 32.6253935763 |
| Maximum queued / in flight | 2 / 8 |
| HTTP attempts / 429 backpressure retries | 373 / 13 |
| Proof commit height span | 293..425 |
| Audit anchors / successful audit transactions | 301 and 401 / 24 |
| Reconciled block range | 217..434; all four validators agree |
| Refunds after expiry | 46 / 46 verified |

The two derived scheduler rates divide the 360 client-observed committed
successes and 5,940 authoritative openings by the complete 182.066769129-second
scheduler interval, including 2.066769129 seconds of drain. They are measurements
of this fixed offered workload. They are not a chain maximum. CometBFT header
time is a consensus timestamp rather than a wall-clock Commit completion time,
so this artifact does not derive a separate per-window commit rate from headers.

The provider HTTP result is also not a pure proof-generation timer. Its terminal
observation includes queueing, proof generation, native verification, gas
simulation, signing, broadcast, and client observation of commit. The retained
provider receipts do not separate CheckTx latency from inclusion latency.

| HTTP observation | p50 | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Terminal from scheduled offer | 2,928.886 ms | 4,277.033 ms | 5,794.835 ms | 6,030.771 ms |
| Pre-success-start delay | 49.514 ms | 1,303.981 ms | 2,137.684 ms | 2,157.522 ms |
| Initial dispatch lag | 48.220 ms | 280.757 ms | 1,797.526 ms | 2,034.034 ms |
| Request after start | 2,826.686 ms | 3,730.674 ms | 3,867.149 ms | 4,097.038 ms |

The 373 HTTP attempts comprise 360 successful `200` responses and 13 initial
`429 retrieval submission busy` responses. Those 13 requests retried once with
the same request, provider, session, and initial-dispatch identity; all then
returned `200` and committed. There were no terminal failures or unclassified
attempts. The pre-success-start delay includes scheduler delay and the retry
backoff for those requests, so it is not a pure signer-queue measurement.

The six 30-second client-observation bins are retained in
[`summary.json`](summary.json). Each bin offered 60 transactions. Terminal
observations were 53, 59, 61, 61, 61, and 60, with 7, 8, 7, 6, 5, and 5
requests outstanding at the corresponding bin boundaries. The final five
requests completed during the bounded drain; no queue or request remained at
scheduler completion.

Measured proof gas used was 3,049,981,281 against 4,870,622,929 declared gas.
Per transaction, used gas ranged from 7,710,824 to 8,725,999 with median
8,725,836. The proof-count distribution was 18 transactions with 15 openings,
144 with 16, and 198 with 17. The aggregate used-gas ratio was approximately
513,464.86 per accepted opening. These are native-v3 message costs from this
profile, not a claim that openings execute independently.

All four exact raw Commit streams recompute to 215 fenced block observations.
Their Commit-step p95 execution upper bounds were 360.593–395.595 ms, below the
diagnostic's 700 ms bound. This timer covers the documented Commit step and may
include waiting for a committed block; it excludes the post-persistence state
transition tail, validator-key refresh, and next-round scheduling. The Commit
streams use a wider observation window that starts before workload alignment and
ends after the heavy all-validator LCD queries. It is separate from the narrower
CPU and provider HTTP measurement window.

Validator CPU is a `/proc` process-tick delta over the 189.759685646-second
window that includes the fixed HTTP workload, drain, audit transactions, bounded
node-zero event observation, and all-validator height fence. Node zero averaged
0.364 cores and the other validators 0.191 cores each during that window. The
evidence does not attribute the difference; node zero also served provider and
observer RPC. Peak RSS values of 329,969,664–356,466,688 bytes are `wait4`
whole-process-lifetime peaks. They are not phase peaks. All stayed below the
configured 2 GiB per-validator diagnostic ceiling, which was not a production
qualification budget.

No owner ACK was sent and no file bytes were downloaded. Delivery, byte
integrity at the client, cache/resume behavior, and WAN performance remain
unmeasured.

## Reproduction and private evidence

[`summarize.py`](summarize.py) imports only the exact pinned landed harness bytes
and their three sibling modules. It reuses the owning validators for native v3
session authority, provider responses, two-anchor span, HTTP receipt fences,
provider sequences, schedule bins, CPU deltas, and Commit streams. It then joins
all 440 successful transaction receipts to raw stopped-blockstore bytes from all
four validators: two batched opens, eight warmups, 360 measured proofs, 24
system audits, and 46 refunds. The public [`summary.json`](summary.json) contains
no raw transactions, proofs, signatures, keyrings, paths, host identity, or logs.

The private source hashes, sanitized [`plan.json`](plan.json), and sanitized
[`runtime-provenance.json`](runtime-provenance.json) are pinned in
[`manifest.json`](manifest.json). With the retained inputs available locally:

```sh
python3 bench/retrieval_session_capacity/native-k8-290/native-v3-cross-audit-001/check.py \
  scripts/retrieval_four_validator_workload.py \
  "$PRIVATE/evidence.json" \
  "$PRIVATE/native-v3-cross-audit-blocks.jsonl" \
  "$PRIVATE/transaction-recovery-private/transactions.json" \
  "$PRIVATE"/native-v3-cross-audit-commit-*.jsonl
```

The checker requires exact reconstruction of the checked-in summary, exercises
a small semantic failure set before the final literal evidence pins, and checks
every published payload hash.
