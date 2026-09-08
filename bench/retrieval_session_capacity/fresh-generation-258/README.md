# Fresh proof generation arithmetic

The unchanged mixed keeper fixture generates six fresh sessions with 52 openings: K8 counts 1/2/8 and K2 counts 1/8/32, two owners/deals and data/parity slots. A native CPU sample placed 58.70% of opening observations in custom MSM and 40.87% in repeated inversion. Raw profile and identities are retained under `cpu-profile/`.

Five warmed observations per variant were interleaved on one Apple M3 Mac with GOMAXPROCS=2. Each process performs an untimed warmup and one measured iteration. No competing task builds or local chain services ran during collection; ordinary OS/application activity remained. The selection gate was declared before collection: at least 20% median improvement exceeding observed variation.

| Variant | Median generation ms/opening | Observed range | Whole-process user CPU s | Peak RSS median bytes |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 121.359 | 120.292–122.154 | 13.69 | 118128640 |
| Batch inversion | 71.597 | 71.490–72.293 | 8.48 | 118587392 |
| Batch + serial native MSM | 32.733 | 32.660–32.857 | 4.37 | 118079488 |

Batch inversion reduces median generation time 41.0%; serial blst MSM reduces it another 54.3%, totaling 73.0%. Both pass selection. These results concern producer arithmetic, not keeper acceptance or network throughput. The benchmark log's `generation-ns/op` covers 52 openings; its ordinary `ns/op` measures a different acceptance stage. Whole-process CPU/RSS include setup, warmup and verification and must not be attributed solely to the timed generation stage. All processes had a sampled maximum of 14 threads; the existing commitment-generation pool remains unchanged. The new opening MSM directly calls the serial primitive.

The same Rust allocator probe, compiled separately against baseline and candidate source, measures one nonconstant off-domain opening and one interior-domain opening. Both warm repeats agree:

| Variant | Peak requested bytes | Total requested bytes | Allocation calls | Realloc calls | Retained bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 598016 | 640760 | 888 | 3 | 0 |
| Candidate | 622592 | 665336 | 888 | 3 | 0 |

The 24 KiB peak increase is bounded local scratch. Requested Rust heap excludes stack, direct C allocations, allocator internals, setup/input and Go; it is not RSS. Probe validity controls and proof verification occur outside accounting.

## Reproduction

Use the tracked `BenchmarkSubmitRetrievalSessionProofV2Mixed` fixture. Its retained binary/source overlay identity is in `provenance.json`; the baseline library's unrelated reconstruction/browser changes do not alter `compute_proof`. Build each library from its pinned source commit with `cargo build --release --locked`, preserve it in its own directory, and use the same linked benchmark executable for every run. On macOS, run from `polystorechain/x/polystorechain/keeper`:

```sh
/usr/bin/time -l /usr/bin/env GOMAXPROCS=2 DYLD_LIBRARY_PATH=/absolute/variant/library \
  /absolute/keeper-mixed.test '-test.run=^$' \
  '-test.bench=^BenchmarkSubmitRetrievalSessionProofV2Mixed$' \
  -test.benchtime=1x -test.count=1 -test.timeout=45s
```

Rotate baseline/batch/serial order across five rounds. The logs, observations and summary retain all15 observations. Use the existing `verifier_allocations --generation` example for memory; source changes must force a real crate rebuild when sharing dependency caches. Do not treat an unchanged cached candidate executable as baseline evidence.

## Correctness

All73 core tests pass (five existing ignores), including six independent nonconstant producer answers, 122 verifier vectors, analytic quotient/domain boundaries, noncanonical stored-cell reduction, root-table/endian and session-batch checks. The shared WASM target builds using LLVM clang on this Mac; Apple clang lacks this target. Independent review checked batch-inversion zero handling/signs, scalar encoding, blst buffer lengths/lifetimes and the direct serial call. Fresh opening, manifest and provider-audit callers share `compute_proof`; challenge derivation, verification, gas, wire data and commitment generation are unchanged.
