# Linux K8 high-load diagnostic 002

This retains one bounded single-host diagnostic for [issue #290](https://github.com/Polynomialstore/polystore/issues/290). It is not a production-capacity qualification. The recorded host was Linux x86_64 on an AMD Ryzen 7 9700X (16 logical CPUs), with `GOMAXPROCS=2` per Go process. The run used four validator processes and twelve provider-daemons on one Linux host, normal audits, K8 proofs, 32 deputy signers, and five 30-second offered-rate steps.

Preparation opened 962 sessions in sixteen committed atomic transactions: fifteen batches of 64 plus a final batch of two. Preparation declared 386,400,000 gas and used 367,420,844. All 32 warmup transactions committed valid, carrying 256 chained openings.

## Measured workload

The 150-second measurement offered 930 proof-submission transactions carrying 7,440 chained openings. Of those, 842 transactions committed valid, carrying 6,736 openings. The bounded driver queue rejected 88 offers as `queue_full`; there were no retries.

| Offered bundles/s | Offered bundles | Same cohort observed by step end | All client completion observations during step | Eventual committed valid | Queue full | Terminal p95 / p99 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 30 | 29 | 29 | 30 | 0 | 1.934 / 1.944 s |
| 2 | 60 | 57 | 58 | 60 | 0 | 1.991 / 2.026 s |
| 4 | 120 | 113 | 116 | 120 | 0 | 2.104 / 2.259 s |
| 8 | 240 | 217 | 224 | 240 | 0 | 3.386 / 4.285 s |
| 16 | 480 | 236 | 259 | 392 | 88 | 20.445 / 21.501 s |

Terminal latency runs from the scheduled offer through the final client observation, including driver queue time; percentiles use linear interpolation between sorted successful observations. It is not isolated chain inclusion latency. Client completion observations include carryover from earlier cohorts and are not block-commit rates. The scheduler took 168.783641 seconds from the first measured offer through drain, 18.783641 seconds beyond the offered window. It reached the configured limits of 32 in-flight and 128 queued operations. These results locate a driver-queue and declared-gas boundary at high load; they do not establish a stable 8 or 16 bundles/s chain rate.

At the five scheduled step-end fences, queued/in-flight operations were respectively 0/1, 0/3, 0/7, 0/23, and 124/32. These client scheduler counts exclude already-terminal `queue_full` offers and are not chain mempool counts. The final 156 pending operations completed during drain.

## Consensus, gas, and audits

All 842 successful transactions reconciled to blocks 556 through 679. Headers and transaction results agreed across all four validators. The median of four pre-measurement metric captures mapped scheduler start to wall time; the capture offsets spanned 512,720 ns. Applying 30-second fences to consensus `header.Time` accounted for one transaction before the mapped start, 29, 60, 127, 222, and 264 transactions in the five windows, and 139 afterward:

| Offered cohort rate | Header-time transactions in window | Header-time bundles/s | Header-time openings/s | Gas wanted | Gas used |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 29 | 0.967 | 7.733 | 145,000,000 | 119,856,991 |
| 2 | 60 | 2.000 | 16.000 | 300,000,000 | 247,988,704 |
| 4 | 127 | 4.233 | 33.867 | 635,000,000 | 524,918,308 |
| 8 | 222 | 7.400 | 59.200 | 1,110,000,000 | 917,565,637 |
| 16 | 264 | 8.800 | 70.400 | 1,320,000,000 | 1,091,165,320 |

These windows contain carryover across offered cohorts. Comet `header.Time` is a consensus timestamp rather than the wall-clock completion time of `FinalizeBlock` or `Commit`; header timestamps can predate their client offers. The rates describe header-time windows only and are not production-capacity or exact commit-completion rates. The capture-offset spread shows agreement among the four mapping samples, not a complete clock-error bound.

Proof transactions declared 5,000,000 gas each and used 4,131,317–4,134,115 gas. Median gas used was 516,758.75 per chained opening. The peak workload block at height 652 contained twelve transactions, 60,000,000 gas wanted, and 49,609,028 gas used under the 64,000,000 block limit. A thirteenth transaction at the declared ceiling would exceed the proposal gas cap even though execution used less gas.

Continuous Commit-step streams covered 124 blocks on every validator. Their conservative p95 execution upper bounds were 285.975–346.072 ms. Validator lifetime peak RSS was 381,140,992–393,928,704 bytes, measured by `wait4 ru_maxrss`; this is not CPU usage. At height 701, all twelve normal-audit assignments were finalized with one accepted sample and zero missed epochs.

## Publication boundary

The [summary](summary.json), [execution plan](plan.json), and [runtime provenance](runtime-provenance.json) are the only published run files. The [manifest](manifest.json) records source and published hashes plus the path substitutions. Raw evidence, block and audit streams, SQLite journals, proof inventory, logs, keyrings, generated payloads, and storage data remain private.

The result ends at committed `PROOF_SUBMITTED` state. It does not measure confirmation, completed sessions, client acknowledgement, byte delivery, WAN behavior, a hardware minimum, or a realistic distributed deployment. This completes the immediate bounded measurement. Longer steady-state and distributed capacity remain unqualified; #291 owns the next native large-session contract. No additional run of the retired serial-download workload is warranted.
