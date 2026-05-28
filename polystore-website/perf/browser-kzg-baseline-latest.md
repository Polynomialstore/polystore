# Browser-Only WASM KZG Baseline

Generated: 2026-05-28T17:25:42.331Z

## Context

| Field | Value |
| --- | --- |
| Branch | `perf/wasm-kzg-benchmark` |
| Commit | `f31c94eb16e99cdb7ba53f660a0cb6ad7b6da79d` |
| Node | `v24.14.1` |
| V8 | `13.6.233.17-node.44` |
| Platform | `linux/x64` |
| OS release | `6.8.0-110-generic` |
| CPU | 11th Gen Intel(R) Core(TM) i5-11400F @ 2.60GHz |
| Logical CPUs | 12 |
| Memory | 31.21 GiB |

## Summary

| Workload | Key Result | Notes |
| --- | ---: | --- |
| One nonzero 128 KiB blob | 258.45 ms | Median wall time over 5 measured runs. |
| One raw user MDU prepare | 26567.78 ms | 1 user MDU, RS 2+1. |
| One raw user MDU user stage | 26433.04 ms | KZG-dominated stage. |
| One raw user MDU user MSM total | 25792.00 ms | Aggregated profiled Rust/WASM MSM time across measured runs. |
| Implied per-blob MSM from one MDU | 268.67 ms | 96 commitments per raw user MDU. |

## Single Blob Commitment

| Metric | Median | Min | Max |
| --- | ---: | ---: | ---: |
| Wall time | 258.45 ms | 257.42 ms | 262.82 ms |
| Rust total | 258.00 ms | 257.00 ms | 263.00 ms |
| Rust MSM | 258.00 ms | 257.00 ms | 263.00 ms |

## One Raw User MDU Prepare

| Stage | Median |
| --- | ---: |
| Total prepare | 26567.78 ms |
| User stage | 26433.04 ms |
| Witness stage | 52.64 ms |
| Metadata stage | 42.54 ms |
| Manifest | 34.99 ms |

## Large User-Stage Worker Sweep

| Mode / Concurrency | Workers Used | Median | Min | Max |
| --- | ---: | ---: | ---: | ---: |
| fused_batch_sampled:5 | 5 | 56170.16 ms | 56170.16 ms | 56170.16 ms |
| fused_batch_sampled:6 | 6 | 40087.33 ms | 40087.33 ms | 40087.33 ms |
| fused_batch_sampled:7 | 7 | 38378.57 ms | 38378.57 ms | 38378.57 ms |

## Commands

```bash
env SINGLE_BLOB_WARMUPS=1 SINGLE_BLOB_RUNS=5 ONE_MDU_RUNS=1 LARGE_CYCLES=1 LARGE_FILE_BYTES=49103158 CONCURRENCIES=5,6,7 PIPELINE_MODES=fused_batch_sampled npm --prefix polystore-website run perf:browser-kzg-baseline --silent
env FILE_BYTES=8126464 WARMUP_RUNS=0 MEASURE_RUNS=1 BASIS_MODE=blst npm --prefix polystore-website run perf:prepare-stages --silent
env FILE_BYTES=49103158 CYCLES=1 CONCURRENCIES=5,6,7 PIPELINE_MODES=fused_batch_sampled BASIS_MODE=blst npm --prefix polystore-website run perf:user-stage-concurrency --silent
```

The single-blob benchmark is run inside `scripts/benchmark_browser_kzg_baseline.ts`; set `SINGLE_BLOB_RUNS`, `ONE_MDU_RUNS`, `LARGE_CYCLES`, `LARGE_FILE_BYTES`, `CONCURRENCIES`, and `PIPELINE_MODES` to adjust runtime and coverage.

Browser-runtime evidence is intentionally separate from this Node/V8 baseline. Use this artifact as the stable dependency contract for Rust/WASM KZG algorithm work and worker-thread scheduling comparisons.
