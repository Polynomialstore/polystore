# Browser WebGPU KZG MSM Optimization Notes

Issue: #177, #179
Baseline PR: #174

## Current Result

The pure WebGPU MSM path preserves byte-for-byte parity with the WASM `blst`
oracle and is now faster than WASM on real Apple M3 and NVIDIA RTX 3060 Ti
browser hardware. The fastest reduction mode is adapter-sensitive.

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

On Ubuntu 22.04, headed Chrome 148, NVIDIA RTX 3060 Ti/Vulkan using the
diagnostic runner at commit `1b9dedd8`:

| reduction mode | WebGPU total | WASM total | parity | device lost |
| --- | ---: | ---: | --- | --- |
| `serial` | ~92.66-105.28 ms | ~285.96-286.38 ms | true | no |
| `parallel32` | ~7434.90 ms | ~290.28 ms | true | no |
| `parallel64` | ~7601.74 ms | ~291.76 ms | true | no |
| `parallel16` | ~21222.31 ms | ~286.96 ms | true | no |

The default reduction mode is adapter-aware: Apple Metal uses `parallel16`,
while other adapters use `serial`. This preserves the M3 win without regressing
NVIDIA Vulkan.

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

The default path is adapter-aware. Leave `POLYSTORE_WEBGPU_MSM_REDUCTION`
unset to use the selected default, or set it explicitly for diagnostics:

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

Local NVIDIA note:

- Headless Chrome still selected SwiftShader even with native Vulkan flags.
- Headed Chrome with `POLYSTORE_WEBGPU_HEADLESS=0` and
  `POLYSTORE_WEBGPU_CHROME_ARGS='--use-vulkan=native --force_high_performance_gpu'`
  selected `vendor: nvidia`, `architecture: ampere`, `isFallbackAdapter: false`.
- With no explicit `POLYSTORE_WEBGPU_MSM_REDUCTION`, the adapter-aware default
  selected `serial` on NVIDIA and returned ~92.66 ms WebGPU vs ~285.96 ms WASM.

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

## #179 Throughput Follow-up

The first #179 pass removes the allocation-heavy `Map<number, Map<number,
number[]>>` bucket builder from the browser MSM path. Bucket construction now
uses typed-array counting, prefix offsets, and a second fill pass, keeping
buckets sorted by window/value while avoiding per-bucket JS arrays.

The WebGPU committer also keeps reusable scratch buffers for bucket metadata,
aggregated buckets, window sums, parallel partial sums, and readback. Buffers
grow geometrically and are retained across blobs and calls until the committer
is destroyed. Benchmark diagnostics now report `scratchCapacityBytes`,
`scratchResizeCount`, aggregate bucket/readback/upload counters, per-stage
medians/min/p95, and throughput in blobs/sec and MiB/sec for both WASM and
WebGPU runs.

The diagnostic runner now supports matrix sweeps so PR evidence can compare
batch size, bucket width, and reduction mode without rerunning one command per
cell:

```sh
POLYSTORE_WEBGPU_MSM_BLOBS_LIST=1,4,16,64 \
POLYSTORE_WEBGPU_MSM_BUCKET_WIDTHS=9,10,11 \
POLYSTORE_WEBGPU_MSM_REDUCTIONS=auto,serial,parallel16,parallel32,parallel64 \
POLYSTORE_WEBGPU_MSM_RUNS=3 \
npm run diagnose:kzg-webgpu-msm
```

For multi-cell runs the JSON includes `result.matrix.results` plus
`result.matrix.recommendation`, which identifies the lowest blob count where a
successful WebGPU median beats or matches WASM for that adapter/Chrome run.
The timing source is explicitly reported as `cpu-wall-clock`; `timestamp-query`
availability is captured in diagnostics, but the harness intentionally keeps
the CPU wall-clock fallback because Chrome does not expose timestamp queries on
all native and software adapters.

Adapter defaults are codified and test-covered:

- Apple/Metal defaults to `parallel16`, matching the M3 diagnostic evidence.
- NVIDIA/Vulkan and unknown native adapters default to `serial`, matching the
  RTX 3060 Ti diagnostic evidence.
- Fallback/software adapters remain rejected unless diagnostics explicitly opt
  in through `allowFallbackAdapter`.

The code also has an adapter-scoped calibration cache helper. Runtime selection
still uses conservative built-in defaults in this PR; benchmark-matrix output
can be converted into cached thresholds by the scheduler without changing the
MSM committer API.

Native NVIDIA diagnostic command:

```sh
POLYSTORE_WEBGPU_HEADLESS=0 \
POLYSTORE_WEBGPU_CHROME_ARGS='--use-vulkan=native --force_high_performance_gpu' \
POLYSTORE_WEBGPU_MSM_RUNS=1 \
npm run diagnose:kzg-webgpu-msm
```

On the #179 branch, headed Chrome 148 selected `vendor: nvidia`,
`architecture: ampere`, and `isFallbackAdapter: false`. Matrix diagnostic
results with `POLYSTORE_WEBGPU_MSM_RUNS=3` on a clean tree:

| blobs | WebGPU total | WASM total | WebGPU throughput | parity | notes |
| ---: | ---: | ---: | ---: | --- | --- |
| 1 | 96.87 ms | 286.83 ms | 10.32 blobs/s | true | serial mode, clean tree |
| 4 | 386.48 ms | 1158.68 ms | 10.35 blobs/s | true | serial mode, clean tree |
| 16 | 1704.76 ms | 4904.21 ms | 9.39 blobs/s | true | serial mode, clean tree |
| 64 | 6811.54 ms | 20539.38 ms | 9.40 blobs/s | true | serial mode, clean tree |

The matrix recommendation for this adapter was `webgpu_recommended: true`,
`min_blobs: 1`, `bucket_width: 10`, and `reduction_mode: serial`.

Apple M3 diagnostic comment on PR #183 at the same commit selected `vendor:
apple`, `architecture: metal-3`, and `isFallbackAdapter: false`. For 1 blob,
default adapter selection used `parallel16` and measured ~152.19 ms WebGPU
versus ~235.20 ms WASM, ~6.57 blobs/s WebGPU throughput, and parity true.

Multi-blob dispatch is intentionally still one blob per GPU command plan with
reused scratch buffers. The attempted deeper shader-level reductions above
were unstable or adapter-hostile, and the current native results show the main
remaining bottleneck is GPU dispatch/readback plus BLS12-381 point arithmetic,
not JavaScript allocation churn. The PR therefore closes #179 by making the
measured throughput path reproducible, adapter-aware, lower-allocation, and
guarded by benchmark evidence rather than by landing a new unproven batched
shader pipeline.
