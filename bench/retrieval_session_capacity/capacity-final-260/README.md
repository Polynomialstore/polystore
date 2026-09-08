# C6 prepared-proof capacity evidence (#260)

The complete 900-second offered-load window is retained here. The original
harness run remains `failed` (`interrupted by signal 15`): a disk guard stopped
its later audit-finalization wait after measurement, queue drain and four-validator
transaction reconciliation. This is qualified evidence for the measured window,
not a successful uninterrupted whole-run lifecycle. `qualification=false` is
preserved in both original-derived and supplementary records.

## Measured result

Four validators ran on one local host with three provider-daemons, normal minting,
64M block gas, 2 MiB blocks, 20M gas per proof transaction and a predeclared
700 ms Commit p95 budget. Each session submitted 32 fresh challenge-bound openings
for a real K2 slot-zero assignment. Proofs and sessions were prepared before the
timed submission workload; this is not generation, delivery or settlement throughput.

| Offered sessions/s | Offers | Eventually committed | Queue-full drops | Pending at step end | Observed completions/s | Worst validator Commit p95 upper bound |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.25 | 45 | 45 | 0 | 0 | 0.2500 | 108.94 ms |
| 0.5 | 90 | 90 | 0 | 0 | 0.5000 | 640.32 ms |
| 1 | 180 | 180 | 0 | 1 | 0.9944 | 137.05 ms |
| 2 | 360 | 360 | 0 | 4 | 1.9833 | 359.83 ms |
| 4 | 720 | 528 | 192 | 135 | 2.2056 | 481.77 ms |

Each step lasted 180 seconds. **2 sessions/s is the highest stable tested offered
rate over its 180-second step**, not 900 seconds at a constant rate or an interpolated maximum. At 4/s the queue reached 128, eight jobs were
in flight, and offer-to-start p95 rose to 59.895 seconds. There were 1,203 committed
successes, 192 local queue-full rejections, zero unknown outcomes and zero
quarantined signers. 135 successes were observed during the 60.621 second drain.
Completion observation includes the committed transaction and pinned proof-state
query; it is later than the exact commit instant.

All four validators agreed on block headers and encoded transaction outcomes
across heights 2090–2806. Peak validator RSS was 589,987,840 / 553,926,656 /
573,505,536 / 554,319,872 bytes, below the 2 GiB budget. 267 blocks contained three
workload proofs. Maximum block gas wanted was 64M; maximum gas used was 50,137,356.
Maximum encoded transaction payload was 75,140 bytes, well below 2 MiB. Four observed
proof costs would exceed 64M gas, so the 20M transaction limit did not exclude an
otherwise fitting fourth proof. This supports gas-limited saturation on this host;
it does not establish WAN performance or a minimum hardware specification.

## Audit coverage and interruption boundary

The scheduler window is monotonic [668551863409000,669451863409000) ns. All four
Commit streams bracket its end at height 2761; observed commits 2090–2761 intersect
epochs 21–28 (epoch 21 overlaps only partially). Original `audits.jsonl` retains each of those epochs finalized with
96/96 accepted samples and zero missed epochs. Epoch 28 was recorded finalized at
height 2803 during uninterrupted drain, before interruption. Epoch 29 started about 954 seconds after measurement
start, during drain. Its later supplementary recovery must not be substituted for
uninterrupted measurement evidence.

`audit-recovery.json` records restart of the same persisted homes and binaries:
52/96 samples were already accepted, 44 more completed after the pause, and all
four validators agreed on 96/96 at state height 2901. The recovery's
`transactions_submitted=0` refers to driver retrieval transactions; restarted
provider-daemons did submit the remaining audit responses. Original measurement
artifact hashes remained unchanged.

C6 requests 132 samples but clamps to the assignment population: three assignments
of 32 rows require 96 samples per epoch. This does not measure 132 samples per large
assignment or validate permissionless randomness, exclusive custody or fresh delivery.
Commit timing excludes other consensus phases and is not whole-block cadence.

## Reproduce the analysis

Python standard library only:

```sh
python3 summarize.py --self-test
python3 summarize.py . > /tmp/polystore-capacity-analysis.json
cmp step-analysis.json /tmp/polystore-capacity-analysis.json
```

`measurement.json` is a public-field export of the original evidence, whose hash
is retained within it. Transaction journals are gzip JSONL, with complete measured
outcomes and pinned proof state. Four raw Commit streams, block outcomes and audit
observations are retained. `summarize.py` also reads the original read-only SQLite
journal when given a private run home. Per-step p95 bounds conservatively treat
boundary-uncertain observations as unbounded; they cannot dilute a step's bound.

Runtime/harness source was frozen at 76653383b04fbd8c971cc4839f831ca0bf15ca2c.
`build-provenance.json` links supplied binaries to their source; automatic runtime
hashes alone do not establish build correspondence. Follow the existing
[build and collection instructions](../sustained-260/README.md) for a new run,
with a fresh home and enough disk for preparation plus retained node databases.
`guard.json` records this run's disk stop. Test keyrings, provider authentication
files and whole node homes are excluded from this public export.
