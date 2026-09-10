# Native v3 chain diagnostic 001

This report retains the finite local chain diagnostic for [#290](https://github.com/Polynomialstore/polystore/issues/290), collected after [#309](https://github.com/Polynomialstore/polystore/pull/309) landed as `0acb91a2d89073d0e3cb441db97d2dd192d03be9`. It measures fresh native v3 proof transactions independently of provider preparation. It does not qualify sustained capacity, delivery, or a realistic distributed deployment.

The fixed workload uses eight native 16 MiB sessions, each with eligible population U=133 and sample quota Q=132. Eight assigned systematic providers submit one transaction each per session. Twelve provider-daemons and four validators share one Linux host: AMD Ryzen 7 9700X, 16 logical CPUs, `GOMAXPROCS=2` per Go process. Normal audits and the 64M block-gas / 2 MiB block-byte limits remain enabled. Eight warmup transactions are excluded from the three eight-second offered steps at 1, 2, and 4 transactions/s.

## Observations

All 64 proof transactions committed successfully and the eight authoritative session bitmaps contain all 1,056 assigned sample ordinals. The measured subset contains **56 transactions / 924 sample ordinals**, reconciled against identical block headers and transaction results on all four validators. Every session subsequently expired and refunded its unacknowledged reserve. No owner ACK, download, delivery verification, or paid completion is claimed.

| Offered interval | Offered rate | Offered / eventually committed | Same-cohort completions observed by interval end | Backlog at interval end (queued / in flight) |
| --- | ---: | ---: | ---: | ---: |
| 0–8 s | 1 tx/s | 8 / 8 | 8 | 0 (0 / 0) |
| 8–16 s | 2 tx/s | 16 / 16 | 13 | 3 (0 / 3) |
| 16–24 s | 4 tx/s | 32 / 32 | 19 | 13 (5 / 8) |

The fixed 24-second offer schedule drained after another **3.987 seconds**. Its finite eventual valid rate is **2.001 transactions/s** over the 27.987-second scheduler-plus-drain denominator. This is a client-observed finite workload rate, not sustained chain capacity. Completions from earlier cohorts carry into later intervals; the final interval observed 22 total completions, of which 19 belong to that interval's offers.

| Client-side latency boundary | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| Scheduled offer → worker start | 0.077 ms | 1,803 ms | 2,053 ms |
| Worker start → CheckTx observation | 90.832 ms | 256 ms | 392 ms |
| Worker start → committed-result observation | 1,842 ms | 3,421 ms | 3,858 ms |
| Scheduled offer → terminal observation | 1,945 ms | 4,053 ms | 4,237 ms |

Percentiles use nearest rank. These include client scheduling, CLI and polling effects and do not establish exact submit-to-inclusion latency. Reconciled heights 237–257 span 26.789 seconds between their first and last header timestamps and contain the same 56 measured transactions. A block header timestamp is not commit-completion time; the report retains this separate numerator and interval without calling it an exact throughput measurement.

The fullest observed block reserved **54,117,960 / 64,000,000 gas (84.56%) for four workload transactions**. Its remaining gas cannot fit even the smallest measured transaction (12,311,318 declared gas). Peak transaction payload was only **51,219 bytes / 2 MiB (2.44%)**, excluding headers, evidence and framing. This suggests declared gas packing constrains this profile before payload size; it does not establish the maximum attainable throughput. Measured transactions reserved 757,650,096 gas and consumed 474,441,513 gas. Limits and production gas adjustment remain unchanged.

During the enclosing 27.988-second `/proc` window, the four validators averaged **0.210, 0.194, 0.196 and 0.195 CPU cores**, respectively (0.796 cores summed). This is average process CPU, not a peak or whole-host utilization measurement. Lifetime peak RSS was 293,093,376; 292,261,888; 293,314,560; and 294,899,712 bytes, from Linux `wait4` in KiB; these maxima cover each whole validator process, including setup and refunds. Validator replication does not multiply the chain's throughput.

Twelve normal audit assignments finalized by height 201, before measurement in epoch 3 and its next anchor at height 301. Normal audits remained enabled, but **this short measurement did not cross an audit anchor**. The retained before/after Commit metric samples are execution upper-bound observations; two wide scrapes do not establish p95 or reconcile every workload block boundary.

The full harness took **552.031 seconds**. That includes chain/provider setup, admission, waiting for audit finalization, session opening, proof preparation, warmups, the short measured phase, and waiting for session expiry/refunds. It is not a file download duration. Proof generation totaled 89,196 ms of per-message elapsed time across eight parallel exporters; this sum is not wall time. All 64 exact-message gas simulations completed before measurement, but their duration was not retained.

## Next measurement

Continue #290 with the existing provider-daemon `/sp/session-proof` route at a fixed 2 offers/s for 60 seconds, crossing a normal audit anchor. Reconcile chain-committed proofs, provider account sequences, queue/drain behavior, CPU and audit outcomes. That closes the concurrent signer/audit gap in this diagnostic. Report the route's proof generation, simulation and transaction observation costs honestly; do not infer a production operating point from this single-host finite run. Native large-file data delivery remains a separate #291 qualification.

## Reproduction and provenance

The [plan](plan.json) records the exact command and frozen harness/runtime identities. [Runtime provenance](runtime-provenance.json) retains compiler versions, component trees, executable hashes and build commands, including the unchanged core/CLI/chain reuse chain. The run uses the landed harness and binaries whose four runtime component trees match that commit.

Generate the summary from the retained private inputs with the pinned harness:

```sh
python3 summarize.py "$HARNESS_SOURCE/scripts/retrieval_four_validator_workload.py" \
  "$RUN_HOME/evidence.json" "$RUN_HOME/native-v3-chain-blocks.jsonl" \
  --run-scope landed-retained-diagnostic > summary.json

python3 check.py "$HARNESS_SOURCE/scripts/retrieval_four_validator_workload.py" \
  "$RUN_HOME/evidence.json" "$RUN_HOME/native-v3-chain-blocks.jsonl"
```

Run these commands from this artifact directory. `$HARNESS_SOURCE` is a checkout at the landed commit above; `$RUN_HOME` is the retained private run directory. The summary's only publication transform replaces its local harness path with `$HARNESS_SOURCE/scripts/retrieval_four_validator_workload.py`. Plans and build manifests replace the machine's benchmark-root path with `$BENCH_ROOT`.

Raw source hashes and published file hashes are listed in [manifest.json](manifest.json). Raw evidence, proof inventory, provider/validator logs, keyrings and generated payloads remain private. The extractor verifies the harness hash before importing its shared validators, then checks successful completion, workload counts, signer/transaction identities, authoritative bitmaps, block hashes and totals, gas simulations, CPU and resource records. Its runnable check accepts this retained success and rejects 19 altered inputs. Failed earlier correctness smokes remain failures and are excluded from this report. This publication changes only the artifact directory; collection harness and runtime bytes remain frozen.
