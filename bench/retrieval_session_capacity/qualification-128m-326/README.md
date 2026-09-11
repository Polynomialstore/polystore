# 128M retrieval-v3 qualification (issue #326)

The exact-head 128M candidate **failed qualification**, so the canonical profile remained **64M max block gas at the time of this run**. The run tested commit `1bbcd77068b5ad0f34c287f3bcf6be3a90bbc86c` on one local four-validator chain using 4,992 frozen one-opening 1 KiB retrieval-v3 proof transactions.

This separate-transaction result remains historical evidence and does not evaluate the later same-provider batching work. The [current 160M post-batch operational profile](../../../scripts/retrieval_consensus_profile.json) depends on [PR #331](https://github.com/Polynomialstore/polystore/pull/331).

The capacity path worked correctly. All 4,992 offered transactions committed exactly once with zero invalid, unknown, duplicate, dropped, or retried transactions. Across 36 saturated blocks, the observed rate was 98.60 proof sessions/s, or 8.52 million/day when the short saturated rate is multiplied by 86,400. Positive all-validator backlog lasted 50.63 seconds, and the peak observed mempool count was 4,851, below CometBFT's 5,000-entry cap. Blocks held 57–141 proof transactions, requested 51.57M–127.58M gas, used 33.16M–82.03M gas, and carried 61,674–152,562 proof-transaction bytes. The 2 MiB block-byte limit did not constrain the run.

Three strict gates failed:

| Gate | Required | Observed | Result |
| --- | ---: | ---: | :---: |
| Saturated blocks | at least 30 | 36 | pass |
| Positive backlog | at least 10s | 50.63s | pass |
| Commit interval p95 | at most 1.6s | 1.544s | pass |
| Consensus round | at most 0 | 0 | pass |
| Missed validator signatures | 0 | 3 | **fail** |
| Validator CPU during backlog | less than 60% of one core | 68.82–74.43% | **fail** |
| Native `FinalizeBlock` p95 upper bound | at most 650ms | 2s on all validators | **fail** |
| Peak CometBFT mempool entries | less than 5,000 | 4,851 | pass |

The signature misses occurred at heights 918, 920, and 922, all in round 0. No later saturated block missed a signature. The native CometBFT histogram is coarse: on every validator, 3 of 38 observed blocks fell at or below 650ms and the other 35 fell in the `(650ms, 2s]` bucket. Therefore p50, p95, and p99 are reported honestly as 2-second bucket upper bounds rather than estimated point durations.

This is chain behavior under the tested configuration, not a harness failure. The harness completed setup, retained both quiescence fences, accepted and reconciled every frozen transaction, captured the complete saturated interval, then failed closed on the qualification gates.

## Host observations

The host was an AMD Ryzen 7 9700X with 8 physical cores, 16 logical CPUs, and 32 GiB memory. Proof preparation and saturated chain execution were captured separately for 15 seconds:

| Phase | Host user | Host system | Host iowait | Host idle | Validator process CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| Proof preparation | 65.74% | 1.60% | 1.17% | 31.47% | 1.20–1.87% of one core each |
| Saturated chain | 21.90% | 0.45% | 1.04% | 76.57% | 81.93–88.47% of one core each |

The proof-preparation trigger recorded eight short-lived proof exporter processes; their lifetimes were too short to appear in the final `pidstat` averages. During saturated execution, sampled validator peak RSS was 641–696 MB. The host-wide idle capacity alongside near-core validator use is evidence that the current per-validator application/consensus path is the constraint in this topology. That interpretation does not establish the exact bottleneck inside `FinalizeBlock`.

Issue #328 owns the default-off parallel-execution feasibility spike. It keeps
the canonical gas profile and production network unchanged.

## Reproduce

Build the exact source commit and run from a fresh directory:

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode native-v3-chain \
  --binary /path/to/polystorechaind \
  --library /path/to/libpolystore_core.so \
  --gateway-binary /path/to/polystore_gateway \
  --cli-binary /path/to/polystore_cli \
  --product-source "$PWD" \
  --proof-exporter /path/to/retrieval-exporter.test \
  --home /path/to/new-run-directory \
  --chain-capacity-profile 1kib \
  --chain-capacity-transactions 4992 \
  --chain-max-gas 128000000 \
  --timeout 3600
```

[`results.json`](results.json) records every gate, interval and block summary, validator CPU/RSS, honest histogram bounds, binary and source hashes, and retained remote artifact paths. The main evidence remains at `/home/mikers/polystore-bench-290/runs/qualification-128m-1bbcd770-001/evidence.json` with SHA-256 `240c8b1edd7b0111dafb6e0bf273efe8eafae0911a624cc7cac7321db34df17e`. The compact host summary remains at `/home/mikers/polystore-bench-290/qualification-128m-1bbcd770-build/host-qualification-128m-1bbcd770-001/summary.json` with SHA-256 `52503ddcb3ae003fdd9e3b624d3e5999ec99396e8a71b009b11bbb9a25aaa317`.

The sessions/day and logical GiB/day figures extrapolate the 50.63-second positive-backlog interval; the full offer-to-drain measurement took 53.22 seconds. They are not 24-hour sustained, file-transfer, proof-preparation, signing, ACK, settlement, expiry, or refund results.
