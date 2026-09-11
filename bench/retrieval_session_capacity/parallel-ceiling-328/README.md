# Retrieval V3 parallel-verifier ceiling (#328)

This short diagnostic measures one sampled retrieval V3 chained proof for one session per benchmark operation. It invokes the exact pure `verifyPolyFSChainedProof` wrapper used for every sample in `MsgSubmitRetrievalSessionProofV3`, including proof-shape and Merkle-path validation and both native KZG checks. The fixture forces nonconstant polynomials and rejects identity commitments and openings before timing. On the Ryzen 7 9700X benchmark host, one verifier process scales from **221.50 chained-proof sessions/s at GOMAXPROCS=1** to **1,616.39/s at GOMAXPROCS=8**. The eight-worker result is a single-process host upper bound of **139.66 million sessions/day** if verification were the only work.

| GOMAXPROCS | Median ms/chained-proof session | Chained-proof sessions/s | Derived sessions/day |
|---:|---:|---:|---:|
| 1 | 4.515 | 221.50 | 19.14M |
| 2 | 2.260 | 442.56 | 38.24M |
| 4 | 1.144 | 873.75 | 75.49M |
| 8 | 0.619 | 1,616.39 | 139.66M |
| 16 | 0.568 | 1,761.12 | 152.16M |

The retained [gas sweep](../gas-sweep-324/) reached **155.15 committed proof transactions/s** and **13.41 million/day** at 448M gas. Its one-sample profile carries one chained proof for one retrieval session in each transaction. All four validators repeat the same transaction stream and each was configured with `GOMAXPROCS=2`, so the directly comparable logical execution ceiling is the **442.56 sessions/s per-validator two-worker result**, or **38.24 million/day**. The measured chain reaches **35.1%** of that verifier-only ceiling. The **1,616.39/s** eight-worker result is a single-process host upper bound; dividing it by four would not model four validator processes correctly.

Each chained proof checks two KZG opening equations, one for manifest inclusion and one for blob data. The two-worker per-validator ceiling therefore corresponds to **885.13 opening equations/s** and **76.47 million/day**; the eight-worker single-process host upper bound corresponds to **3,232.77/s** and **279.31 million/day**. These are equation counts derived from the chained-proof rate, not additional sessions.

Increasing gas from 256M to 448M raised throughput only 10% while mean commit time rose from 1.98s to 3.19s and each validator approached one busy core. Block bytes remained below the 2 MiB limit. Gas therefore admits work until serial `FinalizeBlock` saturates; it cannot make proof transactions use the other cores. The later [128M qualification](../qualification-128m-326/) failed its validator-health gates, so canonical max block gas remained 64M for that separate-transaction path. The [current 192M post-batch operational profile](../../../scripts/retrieval_consensus_profile.json) depends on the same-provider batching work in [PR #331](https://github.com/Polynomialstore/polystore/pull/331).

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
