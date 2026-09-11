# Retrieval V3 native batching and chain capacity (#329)

This benchmark isolates the chain's capacity to confirm one-opening retrieval V3 proofs. It uses a deterministic 16 MiB payload and 1 KiB retrieval ranges, one sampled chained proof per session, fresh chain state per run, four validators on one Ryzen 7 9700X host, `GOMAXPROCS=2` per validator, normal audits, no retries, and a positive mempool backlog throughout the measured interval.

The direct verifier benchmark satisfies #329's parallelism gate. With the same nonconstant, nonidentity proof corpus and native batch size 64, median verification increased from **222.93 sessions/s with one worker** to **1,458.13 sessions/s with eight workers**, a **6.54x speedup** over the required 1.5x.

| Native proof batch | 1 worker | 2 workers | 4 workers | 8 workers |
| ---: | ---: | ---: | ---: | ---: |
| 8 | 222.70/s | 440.47/s | 855.03/s | 1,401.75/s |
| 32 | 222.81/s | 441.40/s | 866.32/s | 1,385.40/s |
| 64 | 222.93/s | 444.60/s | 865.32/s | 1,458.13/s |

This direct result measures only parallel calls to the exact V3 chained-proof verifier. It establishes the implementation speedup independently of transaction decoding, block packing, keeper state, consensus, and commit cadence.

## Fair chain comparator at 192M gas

Each transaction shape confirmed 4,096 logical sessions under the same workload parameters. The serial shape contains 64 existing `MsgSubmitRetrievalSessionProofV3` messages in one transaction. The native shape contains one `MsgSubmitRetrievalSessionProofBatchV3` with 64 entries. The separate shape uses one existing message per transaction. Every fully populated serial and native block held three transactions, or 192 sessions.

| Transaction shape | Sessions/s | Derived sessions/day | Gas used/session | Bytes/session | Commit p50/p95 | FinalizeBlock p95 range | Consensus health |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Separate transactions | 125.43 | 10.84M | 581,693 | 1,081 | 1.657/1.907s | 1.031-1.036s | round 0; 6 missed signatures |
| 64 serial messages/tx | 136.62 | 11.80M | 536,326 | 910 | 1.355/1.481s | 0.893-0.905s | round 0; 1 missed signature |
| Native batch 64 | **139.10** | **12.02M** | **532,000** | **797** | **1.362/1.449s** | **0.526-0.545s** | **round 0; 0 missed signatures** |

Native batching reduced gas used per session by **8.54%** and transaction bytes per session by **26.27%** versus separate transactions. Against serial messages in one transaction, it reduced gas by **0.81%** and bytes by **12.42%**. Its chain rate was 1.018x serial and 1.109x separate because this test also measures block packing and the one-second consensus cadence. The 1.5x acceptance gate belongs to the direct verifier comparison above.

All runs committed every offered logical session once. They reported zero invalid, unknown, duplicate, dropped, or retried transactions, and all four validators agreed on block contents and final session bitmaps. Fresh chains produce different session IDs and challenge seeds, so the comparator holds the deterministic payload and workload parameters constant rather than reusing signed proof bytes across runs.

## Gas ceiling result

The highest measured healthy point is **192M block gas, one-second `timeout_commit`, batch 64, and `GOMAXPROCS=2` per validator**. It sustained **139.10 sessions/s**, or a short-run extrapolation of **12.02 million proof sessions/day**. Exact FinalizeBlock p95 was 526-545ms across the four validators, with no missed signatures, round escalation, proof errors, or reconciliation faults.

A 256M diagnostic increased throughput to **190.84 sessions/s** (16.49M/day) and packed exactly four batch transactions, or 256 sessions, per block. It remained correct with round-zero consensus and no missed signatures, but exact FinalizeBlock p95 was **711-738ms on all four validators**, exceeding the 700ms bound. The gas sweep stops there; 320M, 384M, and 448M were intentionally not run.

| Max gas | Sessions/s | Derived sessions/day | Host avg CPU | Validator avg CPU, aggregate | Validator peak RSS, aggregate | Exact FinalizeBlock p95 | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 192M | 139.10 | 12.02M | 19.74% of 16 CPUs | 2.86 cores | 1.81 GB | 526-545ms | highest passing point |
| 256M | 190.84 | 16.49M | 27.03% of 16 CPUs | 4.01 cores | 1.97 GB | 711-738ms | stop: latency gate failed |

The host remains underused in aggregate, but raising block gas lengthens the sequential work each validator must finish in FinalizeBlock. At 256M, each validator averaged about one CPU core while all four crossed the latency bound. A block-gas increase alone therefore does not approach the configured two-worker pure-verifier ceiling of 442.56 sessions/s while preserving the measured execution budget. This PR records the result and does not change activation parameters.

## Evidence and reproduction

[`results.json`](results.json) contains all five direct-verifier samples for batch sizes 8, 32, and 64 at worker counts 1, 2, 4, and 8; exact chain rates; block packing; gas; bytes; commit quantiles; precise per-validator FinalizeBlock measurements; CPU/RSS; failure counters; and provenance. [`benchmark.txt`](benchmark.txt) is the raw direct-verifier output (SHA-256 `6b32a7c0250c084f164fbc06d1b160801d7333be91dc08d68ba1133ec6829b66`). Full chain evidence remains on the benchmark host because it includes large per-transaction records; `results.json` records each path and SHA-256.

Run the direct matrix from `polystorechain` with the native library built for the host:

```sh
POLYSTORE_BENCH_FIXTURE_NONCONSTANT=1 \
LD_LIBRARY_PATH=/path/to/polystore_core/target/release \
../scripts/chain_go.sh test ./x/polystorechain/keeper \
  -run '^$' \
  -bench '^BenchmarkRetrievalV3ProofBatchVerify$' \
  -benchtime=1s \
  -count=5 \
  -cpu=1,2,4,8 \
  -benchmem
```

Run a fresh-chain native 192M point from the repository root:

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
  --chain-capacity-sessions 4096 \
  --chain-proof-submission-mode batch-message \
  --chain-proof-batch-size 64 \
  --chain-proof-gas-adjustment 1.6 \
  --chain-timeout-commit-ms 1000 \
  --chain-validator-gomaxprocs 2 \
  --chain-max-gas 192000000 \
  --timeout 3600
```

Daily values are the saturated measured rate multiplied by 86,400. They describe proof-confirmation capacity, not a 24-hour qualification or file-download throughput. Session opening, file transfer, proof construction, transaction preparation and signing, owner acknowledgement, settlement, expiry, and refunds are outside the timed interval.
