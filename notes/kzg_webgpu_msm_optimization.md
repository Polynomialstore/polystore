# Browser WebGPU KZG MSM Optimization Notes

Issue: #177
Baseline PR: #174

## Current Result

The pure WebGPU MSM path preserves byte-for-byte parity with the WASM `blst`
oracle and is now faster than WASM on real Apple M3 browser hardware when using
the `parallel16` reduction mode.

On the local WebGPU-enabled Chrome benchmark environment, which resolves to
SwiftShader rather than a native GPU:

- Chrome: HeadlessChrome 138 with WebGPU flags
- Host: Linux x64, 12 CPUs, ~31 GiB memory
- Fixture: 1 blob, 128 KiB
- WASM oracle: ~286-325 ms
- WebGPU serial prototype: ~26.0-26.5 s depending on bucket width

On Apple M3 Chrome/Metal using the diagnostic runner at commit `69533f8e`:

| reduction mode | WebGPU total | WASM total | parity | device lost |
| --- | ---: | ---: | --- | --- |
| `parallel16` | ~99.19 ms | ~246.06 ms | true | no |
| `parallel32` | ~105.82 ms | ~259.70 ms | true | no |
| `parallel64` | ~111.44 ms | ~251.26 ms | true | no |

`parallel16` is the default reduction mode because it is the fastest passing
mode on the native Apple Metal target and still preserves parity in the local
SwiftShader smoke test.

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

The default path is `POLYSTORE_WEBGPU_MSM_REDUCTION=parallel16`. PR #178 also
keeps explicit reduction overrides for diagnostics:

```sh
POLYSTORE_WEBGPU_MSM_REDUCTION=serial POLYSTORE_WEBGPU_MSM_RUNS=1 npm run diagnose:kzg-webgpu-msm
POLYSTORE_WEBGPU_MSM_REDUCTION=parallel16 POLYSTORE_WEBGPU_MSM_RUNS=1 npm run diagnose:kzg-webgpu-msm
POLYSTORE_WEBGPU_MSM_REDUCTION=parallel32 POLYSTORE_WEBGPU_MSM_RUNS=1 npm run diagnose:kzg-webgpu-msm
POLYSTORE_WEBGPU_MSM_REDUCTION=parallel64 POLYSTORE_WEBGPU_MSM_RUNS=1 npm run diagnose:kzg-webgpu-msm
```

These variants keep the stable per-bucket weighting shader and only replace the
final per-window sum with generated reductions. The first shared-memory tree
implementation produced invalid G1 points on Apple Metal; the retained
implementation uses a safer two-phase reduction where phase 1 writes lane
partials and phase 2 folds those partials serially per window.

Local diagnostic run on Linux/HeadlessChrome 138:

- `maxComputeWorkgroupStorageSize`: 32768
- `maxComputeInvocationsPerWorkgroup`: 256
- `device_lost_after_run`: null on the stable path
- WebGPU total: ~26.43 s
- WASM total: ~389 ms
- parity: true

Local generated-reduction diagnostic result on SwiftShader:

- `POLYSTORE_WEBGPU_MSM_REDUCTION=parallel16` returns `parity: true`,
  `error: null`, and `device_lost: null`, but remains slow at ~42.6 s because
  the adapter is software-backed.

## Handoff To #168

The #168 scheduler can gate the pure WebGPU MSM path behind capability detection
and parity/perf evidence instead of treating it as diagnostic-only. Native
Apple Metal evidence now shows the optimized path beating the WASM CPU method
for the 1-blob browser benchmark.

The next meaningful optimization is not more JavaScript tuning. The measured
hot path is still GPU dispatch/readback around the BLS12-381 point arithmetic.
Future work should focus on reducing bucket construction overhead, validating
multi-blob batching, and testing the default mode across additional native
browser adapters.
