# Browser WebGPU KZG MSM Optimization Notes

Issue: #177
Baseline PR: #174

## Current Result

The pure WebGPU MSM path still preserves byte-for-byte parity with the WASM
`blst` oracle, but it is not ready for default upload scheduling.

On the local WebGPU-enabled Chrome benchmark environment:

- Chrome: HeadlessChrome 138 with WebGPU flags
- Host: Linux x64, 12 CPUs, ~31 GiB memory
- Fixture: 1 blob, 128 KiB
- WASM oracle: ~286-325 ms
- WebGPU prototype: ~26.0-26.5 s depending on bucket width

## Window Sweep

Command shape:

```sh
POLYSTORE_WEBGPU_MSM_BUCKET_WIDTH=<width> npm run perf:kzg-webgpu-msm
```

Measured single-run results:

| bucket width | WebGPU total | WASM total | parity | notes |
| --- | ---: | ---: | --- | --- |
| 13 | ~26.30 s | ~290.6 ms | true | PR #174-style default |
| 12 | ~26.00 s | ~288.6 ms | true | slightly faster than 13 in one run |
| 11 | ~26.50 s | ~286.3 ms | true | slower than 12/13 |
| 10 | ~26.09 s | ~325.3 ms | true | best safe tested width in this run |
| 9 | ~26.24 s | ~307.9 ms | true | slower than 10 |

Width 10 is now the prototype default because it was the best safe value in
this local sweep, but the difference is small relative to the remaining gap.

## Failed Reduction Experiment

A KZG-specific dense Pippenger running-sum reduction was tested locally. The
goal was to replace per-bucket scalar multiplication with additions. Chrome
accepted the TypeScript build, but the GPU device was lost before readback in
the benchmark environment. That path was not kept in source because it was not
browser-stable.

Two follow-up reduction variants were also tested and rejected:

- The vendored `subsum_phase1_g1` path was wired with explicit bind groups.
  Chrome rejected the original 64-lane form because the workgroup array of G1
  points exceeded the adapter's workgroup-storage limit.
- A browser-sized 32-lane `subsum_phase1_g1` variant and a KZG-specific sparse
  running-sum shader both compiled, but the benchmark lost the GPU instance
  before readback, including at `POLYSTORE_WEBGPU_MSM_BUCKET_WIDTH=4`.

These failures point to shader pressure/browser-stability limits in the current
`webgpu-groth16`-derived G1 arithmetic, not just TypeScript overhead.

## Cross-Device Diagnostic Runner

PR #178 adds a diagnostic wrapper around the same browser benchmark:

```sh
cd polystore-website
POLYSTORE_WEBGPU_MSM_RUNS=1 npm run diagnose:kzg-webgpu-msm
```

For local Chrome path or flag overrides:

```sh
POLYSTORE_CHROME_PATH=/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
POLYSTORE_WEBGPU_MSM_RUNS=1 \
npm run diagnose:kzg-webgpu-msm
```

The diagnostic JSON includes:

- `webgpu_diagnostics.adapter.info`
- `webgpu_diagnostics.adapter.features`
- `webgpu_diagnostics.adapter.limits.maxComputeWorkgroupStorageSize`
- `webgpu_diagnostics.adapter.limits.maxComputeInvocationsPerWorkgroup`
- per-run `device_lost_after_run`
- top-level `error` and `device_lost` when the benchmark fails in diagnostic mode
- the existing WASM/WebGPU timings and parity result

The stable path is `POLYSTORE_WEBGPU_MSM_REDUCTION=serial`, which is also the
default. PR #178 also exposes diagnostic-only generated reduction variants:

```sh
POLYSTORE_WEBGPU_MSM_REDUCTION=parallel16 POLYSTORE_WEBGPU_MSM_RUNS=1 npm run diagnose:kzg-webgpu-msm
POLYSTORE_WEBGPU_MSM_REDUCTION=parallel32 POLYSTORE_WEBGPU_MSM_RUNS=1 npm run diagnose:kzg-webgpu-msm
POLYSTORE_WEBGPU_MSM_REDUCTION=parallel64 POLYSTORE_WEBGPU_MSM_RUNS=1 npm run diagnose:kzg-webgpu-msm
```

These variants keep the stable per-bucket weighting shader and only replace the
final per-window sum with 16/32/64-lane generated reductions. They are not
scheduler candidates unless they return `error: null`, `device_lost: null`, and
`parity: true` on real browser hardware.

Local diagnostic run on Linux/HeadlessChrome 138:

- `maxComputeWorkgroupStorageSize`: 32768
- `maxComputeInvocationsPerWorkgroup`: 256
- `device_lost_after_run`: null on the stable path
- WebGPU total: ~26.43 s
- WASM total: ~389 ms
- parity: true

Local generated-reduction diagnostic result:

- `POLYSTORE_WEBGPU_MSM_REDUCTION=parallel16` loses the SwiftShader GPU
  instance before producing a run result:
  `OperationError: Instance dropped in popErrorScope`.

Use this runner on Apple M3 Chrome before spending more shader time. If the M3
has a larger workgroup-storage budget or avoids device loss for the rejected
reduction variants, the problem is adapter/backend sensitivity. If it matches
the Linux result, the current shader architecture is the bottleneck rather than
the local test machine.

## Handoff To #168

Do not enable the pure WebGPU MSM path by default in upload scheduling yet.
The #168 scheduler should treat this backend as forced/diagnostic-only unless
a later shader change replaces the current point-arithmetic bottleneck.

The next meaningful optimization is not more JavaScript tuning. The measured
hot path is still GPU dispatch/readback around the BLS12-381 point arithmetic.
Future work should focus on a browser-stable parallel reduction strategy or a
different fixed-base approach with an explicit browser memory budget.
