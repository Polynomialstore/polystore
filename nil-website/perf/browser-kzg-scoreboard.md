# Browser KZG Perf Scoreboard

Use this file to record the largest wins on `perf/browser-kzg-next` against the same benchmark family.

Recommended commands:

```bash
npm --prefix nil-website run perf:prepare-stages
npm --prefix nil-website run perf:prepare
```

Fields to track:
- `full_prepare_ms`
- `user_stage_ms`
- `witness_stage_ms`
- `meta_stage_ms`
- `manifest_ms`
- `notes`

| Order | Optimization | Command / Workload | Before | After | Delta | Delta % | Biggest Win Area | Notes |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| 1 | CLI stage baseline | `env WARMUP_RUNS=0 MEASURE_RUNS=1 FILE_BYTES=49103158 npm --prefix nil-website run perf:prepare-stages` | 180313.73 ms | 180313.73 ms | 0.00 ms | 0.00% | User stage / KZG commit | user `180059.62 ms`, witness `150.42 ms`, meta `49.56 ms`, manifest `47.99 ms`; sum user decode `170951 ms`, sum user MSM `175774 ms` |
| 2 | Batch blob commitments inside Rust/WASM | `env WARMUP_RUNS=0 MEASURE_RUNS=1 FILE_BYTES=49103158 npm --prefix nil-website run perf:prepare-stages` | 180313.73 ms | 160276.59 ms | -20037.14 ms | -11.11% | User stage / KZG commit | user `160093.82 ms`, witness `93.29 ms`, meta `47.97 ms`, manifest `36.24 ms`; biggest win is avoiding per-blob `blst` scratch/session overhead in the user stage |

Backend comparison notes:

| Check | Command / Workload | Result | Notes |
| --- | --- | --- | --- |
| Interleaved median: `blst` vs `affine` vs `projective` | `env FILE_BYTES=8126464 CYCLES=3 BASIS_MODES=blst,affine,projective npm --prefix nil-website run perf:prepare-compare` | `blst` wins | median total: `27.26s` (`blst`) vs `53.68s` (`affine`) vs `59.20s` (`projective`) |
