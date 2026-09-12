# 160M retrieval proof confirmation qualification (issue #251)

This retained run qualifies the 160M max-block-gas candidate for the native V3 batch proof route on one four-validator host. Both `native_v3_chain.qualification` and the measurement's `issue_251_qualification.qualified` field are `true`; all reasons lists are empty. The generic outer-harness `qualification` field remains `false` because it is not the mode-specific qualification result. The authoritative compact extraction is [`results.json`](results.json).

## Exact candidate

- Source: `63eb7fe73e4933fc6b847b76bcccb883c0484dc9`, clean and exact-head checked.
- Artifact binding: all five product artifacts were rebuilt from that checkout and verified against [`build-manifest.json`](build-manifest.json), SHA-256 `5cc13b80c6e334b15a54cbcf624c2ab23014f6110ecee3f2c9420f159c4cf542`.
- Topology: four validator processes on one AMD Ryzen 7 9700X host, 16 logical CPUs, `GOMAXPROCS=4` per validator.
- Workload: 7,680 pre-opened 1 KiB sessions, one sampled chained proof per session, 120 `MsgSubmitRetrievalSessionProofBatchV3` transactions of 64 sessions each.
- Consensus: 160,000,000 max gas, 2 MiB max bytes, one-second `timeout_commit`, gas adjustment 1.6, normal audits.
- Exact invocation and environment: [`command.sh`](command.sh).

## Result

The measured all-validator-positive interval committed **473.6146 sessions/s**, a short-run extrapolation of **40,920,300 sessions/day**. Because this profile has one sampled chained proof per session, sampled chained-proof capacity is also **473.6146/s** and **40,920,300/day**. Each chained proof performs two KZG opening verifications, giving **947.2292 KZG opening verifications/s** and **81,840,601/day**.

The extrapolated daily values multiply the short saturated rate by 86,400. They are capacity estimates, not 24-hour endurance measurements.

| Metric | Result |
|---|---:|
| Offered / committed batch transactions | 120 / 120 |
| Committed logical sessions | 7,680 / 7,680 |
| Saturated blocks | 12, heights 816-827 |
| Positive backlog | 16.2157 s |
| Transactions / sessions per block | exactly 10 / 640 |
| Average gas wanted per block | 149,308,573.75 |
| Average gas used per block | 93,480,130.25 |
| Average transaction bytes per block | 510,220 |
| Commit interval p50 / p95 / p99 | 1.3677 / 1.4988 / 1.4988 s |
| Maximum consensus round / blocks above round zero | 0 / 0 |
| Missed validator signatures | 0 |

The complete 15-row reconciliation trace is [`blocks.jsonl`](blocks.jsonl), covering heights 815-829 and containing the 12 saturated qualification blocks at heights 816-827. Its SHA-256 is `12cada6211a6afc4ad3afb419a2b3c646a62d35e4b248f94dc82c3a1870d019b`.

## Qualification gates

| Gate | Required | Observed | Result |
|---|---:|---:|---:|
| Saturated blocks | at least 10 | 12 | pass |
| All-validator positive backlog | at least 10 s | 16.2157 s | pass |
| Commit interval p95 | at most 1.6 s | 1.4988 s | pass |
| Precise FinalizeBlock p95, every validator | at most 700 ms | 312.7-324.0 ms | pass |
| Maximum consensus round | 0 | 0 | pass |
| Missed validator signatures | 0 | 0 | pass |
| Peak RSS per validator | below 2 GiB | at most 652,185,600 B | pass |
| Comet mempool count | below 5,000 | 120 | pass |
| Reconciliation | exact | exact | pass |

Precise per-validator FinalizeBlock p95 upper bounds were 316.393 ms, 312.656 ms, 323.999 ms, and 320.536 ms. Each value comes from 14 isolated intervals gathered from cumulative FinalizeBlock counters.

Reconciliation found zero invalid, unknown, duplicate, dropped, retried, or partial proof sets. It committed all 7,680 complete proof sets and all 120 frozen provider-local batch sequences exactly once.

The post-workload restart also passed: all four validators restarted at fixed height 833, advanced to height 835, and completed the normal-audit verification at height 902. Chain progress, state agreement, artifact binding, and the provider nonce ordering check all passed.

## Resource use

The 18.2389-second resource sample span contained 19 samples. Whole-host CPU averaged **8.893% of 16 logical CPUs**, or **1.423 cores**, and host memory peaked at 7,851,089,920 of 32,109,105,152 bytes. The four validators averaged **1.216 cores aggregate**; individual averages were 0.293-0.322 cores. Their sampled aggregate peak RSS was 2,440,404,992 bytes and the largest individual peak was 652,185,600 bytes. During the positive-backlog fence, each validator used 32.625-33.180% of one core and sampled RSS was 592,531,456-650,510,336 bytes.

This run used only about 54.2% of the separate 873.75 sessions/s one-sample verifier reference at `GOMAXPROCS=4`. That comparison is derived from the retained pure-verifier benchmark identified in `results.json`; it is not another chain measurement.

## Scope and retained evidence

This measures chain confirmation of already prepared provider proofs. Sessions were pre-opened, and signed transactions were frozen before timing. It excludes file transport, proof preparation, session opening, signing, owner acknowledgement, settlement, expiration, and refund. Normal audits remained active.

Session opening is a separate protocol limit: at most 128 new sessions can open per block. At ideal one-second blocks that caps new opens at **11,059,200/day**, below the proof-confirmation extrapolation measured here. A full service therefore needs session reuse or a separately qualified increase in opening capacity to expose the measured proof-confirmation rate.

The complete 44,687,639-byte raw evidence is retained as deterministic [`evidence.json.gz`](evidence.json.gz), produced with `gzip -n -9`. The compressed file is 5,067,536 bytes with SHA-256 `4d2c29854f615bdf059cfd52701f00c97f36b0612370614145d6b3f9983764cc`; decompression yields SHA-256 `1ccc8bd796b2a5232efad9c2b9ebf46d962ed8a68e215d8807bf790b58bf881f`.

The original benchmark-host locations remain available for provenance:

- Evidence: `/home/mikers/polystore-bench-336-63eb7fe7-final/runs/63eb7fe7-20260912T040917Z-batch64-7680-160m-1s-a16-gmp4/evidence.json`, SHA-256 `1ccc8bd796b2a5232efad9c2b9ebf46d962ed8a68e215d8807bf790b58bf881f`.
- Run directory: `/home/mikers/polystore-bench-336-63eb7fe7-final/runs/63eb7fe7-20260912T040917Z-batch64-7680-160m-1s-a16-gmp4`.
- Build manifest: `/home/mikers/polystore-bench-336-63eb7fe7-final/build/build-manifest.json`.
- Run log: `/home/mikers/polystore-bench-336-63eb7fe7-final/runs/63eb7fe7-20260912T040917Z-batch64-7680-160m-1s-a16-gmp4.log`.

[`results.json`](results.json) is a deterministic compact extraction from that evidence. [`SHA256SUMS`](SHA256SUMS) binds every retained local artifact.
