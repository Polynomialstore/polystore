# Retrieval V3 160M chain-capacity qualification (#326)

The exact four-validator run at `76d7ce549b422d9991011afbf567225e0454c034`
committed 6,656 one-opening, 1 KiB retrieval sessions in 104 provider batches of
64. With 160M block gas, a 2 MiB byte limit, `GOMAXPROCS=4`, and one-second
`timeout_commit`, all 26 measured blocks were gas saturated at four batches (256
sessions) per block. The measured rate was **188.35 sessions/s**, or **16.27
million sessions/day** by short-run extrapolation.

| Profile | Sessions/s | Derived/day | Commit p95 | FinalizeBlock p95 | Consensus |
| --- | ---: | ---: | ---: | ---: | --- |
| 160M gas, 1s | 188.35 | 16.27M | 1.434s | 602-621ms | round 0, no missed signatures |
| 160M gas, 500ms | 246.11 | 21.26M | 1.180s | 608-629ms | round 0, 6 missed signatures |

The one-second profile passed exact transaction/session reconciliation, 25-block
saturation, ten-second backlog, commit-latency, execution-latency, consensus,
memory, mempool, and post-run restart gates. The 500ms diagnostic was faster but
missed six validator signatures, so it is not an activation candidate.

The gas step is discrete. Each 64-session batch requested about 37.44M gas. The
160M profile admits four batches; the next capacity step requires enough gas for
five, approximately 187.2M at the retained 1.1 gas adjustment. The measured 192M
diagnostic reached 234.57 sessions/s but its 757-771ms `FinalizeBlock` p95 failed
the 700ms execution budget. A smaller gas increase would admit no additional
batch, and the next increase already exceeds the measured latency budget.

The host was underutilized as a whole: the four validators averaged 6.27 CPU
cores together on a 16-logical-CPU Ryzen 7 9700X host, while each validator
averaged about 1.56-1.58 cores. The directly comparable pure verifier ceiling at
four workers is 873.75 one-sample sessions/s per validator. The full chain
reached 21.6% of that figure because it also decodes and admits transactions,
prepares each session sequentially, verifies the proof set concurrently, applies
session state sequentially, commits state, and runs consensus. The frozen
sessions were unacknowledged, so this measurement did not execute provider
settlement. Raising gas
changes how much of that work enters a block; it does not parallelize the serial
parts.

`results.json` records the compact measurements and source-evidence hashes. The
full evidence stays on the benchmark host because it contains every session,
transaction, block, resource sample, and restart observation. Its SHA-256 makes
the retained summary auditable.

## Scope

These figures measure proof confirmation only. Frozen signed transactions were
submitted directly after setup, so file transfer, proof generation, session
opening, signing, owner acknowledgement, and refund paths are outside the timed
interval. Daily values are the short saturated rate multiplied by 86,400; they
are not a 24-hour soak result.

## Reproduce

Build the product binaries, native library, and proof exporter from the recorded
commit, then run from the repository root:

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode native-v3-chain \
  --binary /path/to/polystorechaind \
  --library /path/to/libpolystore_core.so \
  --gateway-binary /path/to/polystore_gateway \
  --cli-binary /path/to/polystore_cli \
  --product-source "$PWD" \
  --proof-exporter /path/to/retrieval-inventory-exporter \
  --home /path/to/new-run-directory \
  --chain-capacity-profile 1kib \
  --chain-capacity-sessions 6656 \
  --chain-proof-submission-mode batch-message \
  --chain-proof-batch-size 64 \
  --chain-proof-gas-adjustment 1.1 \
  --chain-max-gas 160000000 \
  --chain-timeout-commit-ms 1000 \
  --chain-validator-gomaxprocs 4 \
  --timeout 3600
```
