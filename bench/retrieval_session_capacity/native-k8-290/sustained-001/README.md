# Native K8 sustained diagnostic 001

This is the retained result of one bounded local diagnostic for
[issue #290](https://github.com/Polynomialstore/polystore/issues/290). It is not
a capacity qualification. The five offered-rate steps lasted 60 seconds each,
and the run used four validator processes plus twelve provider-daemons on one
nonquiet Apple workstation because realistic dedicated deployment infrastructure
was unavailable.

Preparation opened 473 sessions in eight committed atomic transactions. The
400,000 gas ceiling per session-open message produced 189,200,000 total gas
wanted and 180,665,709 gas used. Eight warmup and 465 measured
`MsgSubmitRetrievalSessionProof` transactions committed successfully. Each K8
transaction carried eight chained openings, for 64 warmup and 3,720 measured
openings. Every assignment received 38 or 39 committed-valid bundles.

## Offered window and drain

The measured window offered 465 bundles across 300 seconds:

| Offered bundles/s | Offered bundles | Same cohort observed committed by step end | All client completion observations during step | Pending at boundary | Eventual committed-valid | Terminal p95 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.25 | 15 | 15 | 15 | 0 | 15 | 2.093 s |
| 0.5 | 30 | 30 | 30 | 0 | 30 | 2.010 s |
| 1 | 60 | 59 | 59 | 1 | 60 | 2.015 s |
| 2 | 120 | 117 | 118 | 3 | 120 | 2.013 s |
| 4 | 240 | 236 | 239 | 4 | 240 | 2.299 s |

The p95 values above are terminal observation latencies; the exact millisecond
values are in the summary. At the 300-second boundary, 461 of 465 transaction
completion observations had finished. All 465 transactions eventually committed;
the scheduler finished 1.244220 seconds after the offered window, while the
separately fenced scheduler-and-drain interval was 301.326692 seconds. These are
client observations around committed transactions. Consensus reconciliation
independently records the actual workload transactions in blocks 411 through
636 and agreement on headers and results across all four validators.

The 4 bundles/s step reached the configured offered ceiling with a bounded queue:
peak queued work was three, peak in-flight work was eight, and each 60-second
heartbeat reported zero queued work. The four pending observations at the final
boundary drained immediately afterward. This supports a workload-limited local
lower bound at the maximum offered rate; it does not identify chain saturation
or qualify 4 bundles/s as production capacity.

## Gas, validators, and audits

Proof transactions declared 5,000,000 gas and used 4,131,317–4,134,115 gas.
The busiest observed workload block held six transactions, with 30,000,000 gas
wanted and 24,804,642 gas used under the unchanged 64,000,000 block limit. The
SDK default proposal path admits against declared gas, so 5,000,000 permits at
most twelve such transactions by arithmetic. The observed maximum of six and
the unused block-gas headroom are further evidence that this workload did not
measure the chain limit.

Continuous Commit-step streams covered 226 blocks on each validator and reported
conservative p95 upper bounds of 155.971–160.498 ms, within the fixed 700 ms
budget. The separate two-scrape CPU bounds accumulated 14.755–15.190 CPU-seconds
per validator over about 301.6 seconds, or 4.89–5.04% of one core. They do not
establish CPU p95 or reconcile exact workload block boundaries. Validator
lifetime peak RSS was 295,223,296–309,968,896 bytes.

The final normal audit observation at height 701 recorded one accepted sample
for each of twelve finalized assignments, with zero missed epochs. This is the
normal-audit K8 profile; it is not the C6 full-small-population profile.

## Publication boundary

The [summary](summary.json), [execution plan](plan.json), and
[runtime provenance](runtime-provenance.json) are the only published run files.
The [manifest](manifest.json) records original and published hashes, path
substitutions, the seven independently hash-checked private artifacts, and the
excluded files. The source run home, keyrings, SQLite journals, raw evidence,
provider and validator logs, payload, proof inventory, and private driver log
remain local.

The result ends at committed `PROOF_SUBMITTED` state. It does not measure
confirmation, completed sessions, client acknowledgement, byte delivery, WAN
behavior, a hardware minimum, or a realistic deployment. Issue #290 remains open:
a higher offered workload with enough signer/driver concurrency is needed to
locate a limiter, followed by equivalent measurement on dedicated deployment
resources before any capacity claim.
