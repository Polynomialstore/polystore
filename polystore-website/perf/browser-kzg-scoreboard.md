# Browser KZG Perf Scoreboard

Use this file to record the largest wins on `perf/browser-kzg-next` against the same benchmark family.

Recommended commands:

```bash
npm --prefix polystore-website run perf:prepare-stages
npm --prefix polystore-website run perf:prepare
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
| 1 | CLI stage baseline | `env WARMUP_RUNS=0 MEASURE_RUNS=1 FILE_BYTES=49103158 npm --prefix polystore-website run perf:prepare-stages` | 180313.73 ms | 180313.73 ms | 0.00 ms | 0.00% | User stage / KZG commit | user `180059.62 ms`, witness `150.42 ms`, meta `49.56 ms`, manifest `47.99 ms`; sum user decode `170951 ms`, sum user MSM `175774 ms` |
| 2 | Batch blob commitments inside Rust/WASM | `env WARMUP_RUNS=0 MEASURE_RUNS=1 FILE_BYTES=49103158 npm --prefix polystore-website run perf:prepare-stages` | 180313.73 ms | 160276.59 ms | -20037.14 ms | -11.11% | User stage / KZG commit | user `160093.82 ms`, witness `93.29 ms`, meta `47.97 ms`, manifest `36.24 ms`; biggest win is avoiding per-blob `blst` scratch/session overhead in the user stage |

Backend comparison notes:

| Check | Command / Workload | Result | Notes |
| --- | --- | --- | --- |
| Interleaved median: `blst` vs `affine` vs `projective` | `env FILE_BYTES=8126464 CYCLES=3 BASIS_MODES=blst,affine,projective npm --prefix polystore-website run perf:prepare-compare` | `blst` wins | median total: `27.26s` (`blst`) vs `53.68s` (`affine`) vs `59.20s` (`projective`) |
| Interleaved median: user-stage concurrency `4` vs `5` | `env FILE_BYTES=40632320 CYCLES=3 CONCURRENCIES=4,5,6 npm --prefix polystore-website run perf:user-stage-concurrency` | `5` workers wins | 5-MDU median user-stage wall: `63.61s` (`4`) vs `54.74s` (`5`); `6` requested also resolves to `5` workers for 5 jobs and measured `48.84s` median on the same run |
| Interleaved median: user-stage concurrency `5` vs `6` vs `7` | `env FILE_BYTES=49103158 CYCLES=3 CONCURRENCIES=5,6,7 npm --prefix polystore-website run perf:user-stage-concurrency` | `6` workers wins | 7-MDU median user-stage wall: `65.86s` (`5`) vs `40.04s` (`6`) vs `44.57s` (`7`); top browser tier should cap at `6`, not `7` |
| Interleaved median: split worker path vs one-call batch wasm path | `env FILE_BYTES=49103158 CYCLES=3 CONCURRENCIES=6 PIPELINE_MODES=split,fused_batch npm --prefix polystore-website run perf:user-stage-concurrency` | `fused_batch` wins | 7-MDU median user-stage wall: `42.76s` (`split`) vs `36.29s` (`fused_batch`); keep full batch commit inside wasm and remove extra JS/WASM crossings |
| Interleaved median: fused batch profiled vs unprofiled | `env FILE_BYTES=49103158 CYCLES=3 CONCURRENCIES=6 PIPELINE_MODES=fused_batch,fused_batch_unprofiled npm --prefix polystore-website run perf:user-stage-concurrency --silent` | `fused_batch_unprofiled` wins | 7-MDU median user-stage wall: `50.57s` (`fused_batch`) vs `47.65s` (`fused_batch_unprofiled`); detailed per-MDU profiling still has measurable hot-path cost |
| Interleaved median: fused batch sampled profiling vs fully unprofiled | `env FILE_BYTES=49103158 CYCLES=3 CONCURRENCIES=6 PIPELINE_MODES=fused_batch_sampled,fused_batch_unprofiled npm --prefix polystore-website run perf:user-stage-concurrency --silent` | `sampled` is close enough | 7-MDU median user-stage wall: `47.00s` (`fused_batch_sampled`) vs `46.70s` (`fused_batch_unprofiled`); profile one representative user MDU and keep the rest on the fast path |
