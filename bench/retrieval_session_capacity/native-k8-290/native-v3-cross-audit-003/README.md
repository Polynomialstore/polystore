# Native-v3 proof phases across normal audits (#290)

The retained run committed all **360 measured proof transactions / 5,940 fresh
sample ordinals**, completed 24 normal audits and refunded all 46 expired
sessions. Its fixed local operating point was **1.9713 committed transactions/s**
including drain. Provider proof preparation and later commit observation are
the largest measured per-request phases. This is a four-validator, twelve
provider-daemon **single-host diagnostic**, not maximum chain capacity, WAN
performance or a file-download measurement (`qualification=false`).

The runtime and harness were built from merged commit
`70ce16da02e3790ba128ae883f33be4e70d30a9f`. This includes
[phase instrumentation (#317)](https://github.com/Polynomialstore/polystore/pull/317)
and [audit admission priority (#318)](https://github.com/Polynomialstore/polystore/pull/318).
The earlier collection `002` failed because a provider's audit repeatedly lost
signer admission to retrieval traffic; it remains failed and unqualified.
This run demonstrates complete audit coverage with the fix. It makes no speedup
claim against either that failure or [retained run 001](../native-v3-cross-audit-001).

## Workload and throughput

One AMD Ryzen 7 9700X host (8 cores / 16 threads, Linux 7.0.0-30) ran four
validators and twelve provider-daemons. The build used Go 1.25.5 and Rust/Cargo
1.98.1; commands and artifact hashes are in
[runtime-provenance.json](runtime-provenance.json). The isolated chain retained
64M block gas, 2 MiB blocks, normal 100-block audits and a 1-second configured
commit timeout. This is not a distributed-validator deployment.

Two append-signed transactions opened 46 native 16 MiB sessions (31 and 15
messages). Each session has U=133/Q=132 and eight systematic provider
obligations. Eight proof transactions warmed the production HTTP route outside
the measured interval. The scheduler then offered 360 transactions at 2/s over
180 seconds, round-robin across eight independent provider signers, with at
most one active request per signer. A transaction contains that provider's
15–17 assigned sample openings, not proofs for every downloaded byte.

| Quantity | Result |
| --- | ---: |
| Offered / committed-valid measured transactions | 360 / 360 |
| Accepted measured sample ordinals | 5,940 |
| Scheduler interval, including drain | 182.624890855 s |
| Final drain | 2.624890855 s |
| Committed transactions / scheduler second | 1.9712537448 |
| Accepted sample ordinals / scheduler second | 32.5256867900 |
| Maximum queued / in flight | 3 / 8 |
| HTTP attempts / initial 429 retries | 372 / 12 |
| Terminal failed / unknown proof requests | 0 / 0 |
| Measured proof heights | 293–426 |
| Audit anchors / accepted audits / missed audits | 301 and 401 / 24 / 0 |
| Expired sessions / verified refunds | 46 / 46 |

The six 30-second bins each offered 60 transactions. They observed
52/62/59/61/60/59 terminal successes, ending with 8/6/7/6/6/7 outstanding
requests and zero queued requests. The final seven completed during drain.
Each of the twelve initial `429 retrieval submission busy` responses retried
once with the same request/provider/session identity. Retries are not counted
as additional committed work. All provider account-sequence deltas reconcile
to the unique measured proofs and normal audits.

## Where request time goes

These are nearest-rank percentiles of 360 successful measured transactions,
joined to their exact request, provider, session and all-validator receipt.
All 360 CLI attempts succeeded without an explicit sequence retry. HTTP 429
retries happen before provider admission and are measured separately below.

| Provider phase (milliseconds) | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| Frozen authority checks | 1.281 | 1.773 | 3.162 |
| Sampled proof preparation | 925.995 | 1,081.906 | 1,149.085 |
| CLI pre-broadcast work | 98.021 | 245.820 | 323.980 |
| BroadcastTxSync / CheckTx round-trip | 1.130 | 198.813 | 268.302 |
| Later committed-transaction observation | 1,506.172 | 2,507.916 | 2,510.409 |
| Other local work, measured per request | 86.793 | 137.604 | 186.665 |
| Total provider request | 2,741.111 | 3,684.950 | 3,831.318 |

Proof preparation includes reading sampled encoded blobs, recomputing their
commitments, generating fresh KZG openings and verifying the assembled proofs
locally. It is not an isolated KZG primitive timer. CLI pre-broadcast work
includes gas simulation and signing; its clock starts at the CLI command
handler, excluding process startup. BroadcastTxSync measures the RPC/CheckTx
round-trip, not block inclusion. Commit observation starts after successful
CheckTx and includes polling plus the transaction index/RPC path. Its p50 is
therefore an observation latency, not exact consensus inclusion latency.

The provider total starts after route selection and signer admission. Retrieval
admission accepts immediately or returns 429; it does not wait in a signer
queue. The audit-priority wait is a separate background path. The residual
local duration is computed **within each request** before taking percentiles;
it includes process startup, durable journal work and uninstrumented local
work. Percentiles must not be added or subtracted to infer another phase.

| Client observation (milliseconds) | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| Initial dispatch lag | 46.791 | 297.584 | 1,856.727 |
| Scheduled offer to successful request start | 49.112 | 1,343.815 | 2,134.589 |
| Successful HTTP request duration | 2,818.474 | 3,752.991 | 3,915.788 |
| Scheduled offer to terminal response | 2,909.111 | 4,294.213 | 5,853.849 |

The second row includes backoff for the twelve HTTP 429 retries and is not pure
signer wait. The eight warmup observations remain a separate population in
[summary.json](summary.json); their proof-preparation p50 was 1,406.301 ms.
They are neither mixed into measured percentiles nor treated as a cold-start
benchmark.

Consensus header timestamps supply a separate denominator: from the header
preceding the first measured proof (height 292) through height 426,
180.925019797 seconds contain 360 committed proof transactions, or
1.9897745508 transactions per header second. The 134 inter-header intervals
have p50/p95/p99 of 1,336.504/1,431.295/1,443.570 ms. These are proposal/header
timestamps, not commit-completion timestamps. All nine fractional digits are
preserved; the preceding header is included. Do not combine this clock with
process-monotonic phase timings or quote this fixed workload as maximum capacity.

## Chain cost, resources and limits

Measured proofs consumed 3,049,981,256 gas against 4,870,623,654 declared gas.
The distribution was 14 transactions with 15 openings, 152 with 16 and 194
with 17. Used gas per transaction ranged from 7,710,824 to 8,725,999, with
median 8,725,836; aggregate gas per accepted ordinal was 513,464.86.
At height 406, peak block used/declared gas was 34,502,059/56,117,970 and
transaction payload was 52,239 bytes. These are native message costs with the
unchanged gas adjustment, not independent costs for individual openings.

All four validators agreed on reconciled blocks 217–429. The four raw Commit
streams yielded 210 fenced block observations each, with p95 execution upper
bounds of 366.510–417.794 ms, below the local 700 ms guard. The Commit metric
excludes the documented post-persistence tail and next-round scheduling. Its
wider observation window includes alignment and later all-validator queries;
it is separate from the measured provider and CPU windows.

Actual validator CPU snapshots span 182.643849805 seconds. Node zero averaged
0.379 cores and the others 0.196 cores each. Node zero also served provider and
observer RPC; this report does not attribute its extra CPU. Lifetime peak RSS
was 330,756,096–352,899,072 bytes per validator, below the 2 GiB local guard.
Lifetime RSS is not a phase peak. The 814.057-second total run includes setup,
alignment, state reconciliation, expiry and cleanup outside the throughput
clock; it is not a download time.

The measured latency owner is provider preparation plus commit observation;
this workload does not establish a maximum or prove validator CPU saturation.
The earlier [chain-only report](../native-v3-chain-001) separately identifies
declared-gas block packing under its finite offered load. No owner ACK or file
delivery occurred here. All 46 sessions deliberately expired and refunded.
Delivery, cache/resume and practical 1 GiB targets remain owned by #291;
distributed capacity requires a recorded distributed deployment.

## Reproduce without rerunning the workload

The shared [checker](../native-v3-cross-audit-001/check.py) reuses the pinned
harness validators, checks all four Commit streams and re-decodes 440 signed
transactions recovered from the stopped blockstores. The 440 comprise two
opens, eight warmups, 360 measured proofs, 24 audits and 46 refunds. It rejects
malformed phase timing before the final literal input hashes. It reproduces
the original 001 summary unchanged and checks this report through `--report`.

Set `HARNESS_SOURCE` to a checkout of
`70ce16da02e3790ba128ae883f33be4e70d30a9f`; set `PRIVATE` to the retained 003
directory and `BENCH_ROOT` to the preserved build root. From this report's
repository checkout:

```sh
python3 bench/retrieval_session_capacity/native-k8-290/native-v3-cross-audit-001/check.py \
  --report bench/retrieval_session_capacity/native-k8-290/native-v3-cross-audit-003 \
  --decoder "$BENCH_ROOT/native-phase-build-70ce16da/bin/polystorechaind" \
  --decoder-library "$BENCH_ROOT/native-phase-build-70ce16da/rust-target/release/libpolystore_core.so" \
  "$HARNESS_SOURCE/scripts/retrieval_four_validator_workload.py" \
  "$PRIVATE/evidence.json" \
  "$PRIVATE/native-v3-cross-audit-blocks.jsonl" \
  "$PRIVATE/transaction-recovery-private/transactions.json" \
  "$PRIVATE"/native-v3-cross-audit-commit-*.jsonl
```

[pins.json](pins.json) freezes inputs and source-module identities.
[manifest.json](manifest.json) records private input hashes and published file
hashes, including the shared checker. [plan.json](plan.json) is the completed
guard with host identity removed; the runtime provenance preserves all artifact
and component identities. Raw signatures, proofs, session state, keyrings and
logs remain private. No production activation or deployment changed.
