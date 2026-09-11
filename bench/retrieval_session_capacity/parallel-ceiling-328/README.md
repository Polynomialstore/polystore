# Retrieval V3 parallel-verifier ceiling (#328)

This short diagnostic isolates the two native verification calls used by one-opening retrieval V3 proofs. The fixture forces nonconstant polynomials and rejects identity commitments and openings before timing. On the Ryzen 7 9700X benchmark host, the verifier scales from **221.83 sessions/s on one core** to **1,616.10 sessions/s on eight physical cores**. The eight-core rate extrapolates to **139.63 million sessions/day** if verification were the only work.

| Workers | Median ms/session | Sessions/s | Derived sessions/day |
|---:|---:|---:|---:|
| 1 | 4.508 | 221.83 | 19.17M |
| 2 | 2.256 | 443.29 | 38.30M |
| 4 | 1.143 | 874.58 | 75.56M |
| 8 | 0.619 | 1,616.10 | 139.63M |
| 16 | 0.568 | 1,761.50 | 152.19M |

The retained [gas sweep](../gas-sweep-324/) reached **155.15 sessions/s** and **13.41 million/day** at 448M gas. That is 9.6% of one verifier process using all eight cores. Because the benchmark runs four validators on one host and every validator verifies every proof, its comparable verifier-only hardware ceiling is about **404.02 sessions/s** (1,616.10 / 4); the measured chain reaches **38.4%** of that shared-host ceiling. Increasing gas from 256M to 448M raised throughput only 10% while mean commit time rose from 1.98s to 3.19s and each validator approached one busy core. Block bytes remained below the 2 MiB limit. Gas therefore admits work until serial `FinalizeBlock` saturates; it cannot make proof transactions use the other cores. The later [128M qualification](../qualification-128m-326/) failed its validator-health gates, so canonical max block gas remains 64M.

## BlockSTM stop result

The pinned Cosmos SDK 0.53 stack has no intra-block parallel transaction runner. The closest released SDK/EVM pair exposing BlockSTM is Cosmos SDK 0.54.3 with cosmos/evm 0.7.0. Reaching PolyStore source compilation required a 33-file compatibility spike spanning 791 insertions and 246 deletions across SDK, EVM, IBC, store, logging, app wiring, tests, and the removed public `x/group` module. Compilation then stopped at PolyStore's three EVM correctness guards, which must be independently ported and requalified.

That meets #328's **blocked by migration scope** stop condition. BlockSTM is a coordinated consensus dependency migration, not a safe gas or startup-option change. The exact disposable patch, dependency summary, and compile log are retained here so a later migration does not have to rediscover the boundary.

[Issue #329](https://github.com/Polynomialstore/polystore/issues/329) owns the smaller next step: batch independent sessions from one provider, run only the pure verifier concurrently, and apply keeper/bank state sequentially in input order. It preserves the current SDK, proof, challenge, payment, and single-session APIs. Cross-provider aggregation remains deferred in #251.

## Reproduce

From `polystorechain`, with the native library built for the host:

```bash
../scripts/chain_go.sh test ./x/polystorechain/keeper \
  -run '^$' \
  -bench '^BenchmarkVerifyChainedProofParallel$' \
  -benchtime=2s \
  -count=5 \
  -cpu=1,2,4,8,16 \
  -benchmem
```

[`results.json`](results.json) records the five samples at each worker count, medians, derived daily rates, hardware and source provenance, native-library hash, and the retained chain comparison. [`benchmark.txt`](benchmark.txt) is the raw output. `blockstm-migration-spike.patch.gz`, `blockstm-dependency-summary.txt`, and `blockstm-compile.txt` retain the disposable compatibility attempt.

The benchmark excludes transaction decoding/signatures, keeper and bank state, gas accounting, consensus, networking, proof generation, and file transfer. Daily values are short-run extrapolations, not sustained 24-hour or end-to-end delivery claims.
