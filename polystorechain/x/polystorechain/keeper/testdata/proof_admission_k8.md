# Nonconstant K8 proof fixture

`proof_admission_k8.json` contains three ordinary (legacy, prover-selected z)
chained proofs, leaf indices 0, 1 and 2, for one K=8/M=4 encoded MDU. It is a
verification/admission fixture, not a v2 fresh-challenge response.

`TestNonconstantProofAdmissionFixture` reconstructs the fixture with the existing
benchmark helpers and compares the complete JSON. Every scalar in the 8 MiB
source MDU has zero high bytes and last byte `1 + (scalar_index % 251)`. This
avoids constant/identity KZG proof fast paths. MDU #2 is rooted in the existing
PolyFS MDU0 root-table fixture; z hints are 100, 101 and 102. Regenerate only for
an intentional reviewed fixture change:

```sh
POLYSTORE_UPDATE_PROOF_ADMISSION_FIXTURE=1 scripts/chain_go.sh test ./x/polystorechain/keeper -run '^TestNonconstantProofAdmissionFixture$' -count=1
```

The September 2026 admission check used the unchanged core dylib SHA-256
`4ed8aa1c19bc41d372de60fc726924870c1cbe7eb2feff7ad9c1199e806a4c71`.

Bounded characterization, Go 1.25.5 / darwin arm64 / Apple M3, three iterations
per row on a shared host; these are two-hop FFI-only times, excluding fixture
setup, path flattening, SDK work and native scratch accounting:

| K/M | Proofs | ms/op | Go B/op | Go allocs/op |
| --- | ---: | ---: | ---: | ---: |
| 8/4 | 1 | 9.143 | 0 | 0 |
| 8/4 | 2 | 17.157 | 0 | 0 |
| 8/4 | 8 | 73.500 | 10 | 0 |
| 2/1 | 1 | 9.793 | 0 | 0 |
| 2/1 | 8 | 51.457 | 0 | 0 |
| 2/1 | 32 | 269.119 | 0 | 0 |

Run the existing benchmark with `POLYSTORE_BENCH_FIXTURE_NONCONSTANT=1`,
`POLYSTORE_BENCH_FIXTURE_SERVICE_HINT=General:rs=8+4` (or `2+1`),
`-run '^$' -bench 'BenchmarkSubmitRetrievalSessionProof/ffi-verify-only-(1|2|8)$'`
(or `(1|8|32)`), `-benchtime=3x -benchmem -count=1`.
The 500,000 gas/proof component is fixed by the binary, not derived at runtime
from these timings. The [native allocation probe](../../../../../polystore_core/examples/verifier_allocations.md)
records sequential Rust heap scratch separately: 2456-byte measured peak,
54264 cumulative bytes per proof, zero retained bytes for these K8/K2 fixtures.
#260 still owns whole-process memory and sustained capacity.

Full keeper submission characterization at the final #255 audit slice, using the
same unchanged dylib, Go 1.25.5 / Apple M3 and `GOMAXPROCS=2`, three iterations
per row. Each row uses one legal legacy session; fixture creation and session open
are outside timing. These are fixed-z preactivation baselines, not measurements
of the v2 challenge or batch backend. Separate shared-host runs must not be used
as a paired speedup comparison with the earlier FFI-only table.

| K/M | Proofs | ms/op | Total gas/op | Go B/op | Go allocs/op |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8/4 | 1 | 5.361 | 539982 | 32434 | 352 |
| 8/4 | 2 | 10.619 | 1051389 | 43365 | 452 |
| 8/4 | 8 | 41.295 | 4119835 | 107949 | 1048 |
| 2/1 | 1 | 5.734 | 537255 | 30562 | 322 |
| 2/1 | 8 | 46.415 | 4117108 | 105888 | 1016 |
| 2/1 | 32 | 182.796 | 16390958 | 372245 | 3446 |

Reproduce with the same environment and command above, replacing
`ffi-verify-only-` with `proofs-`, and adding `GOMAXPROCS=2` and `-p 2`.
Each proof accounts for 131072 encoded bytes (up to 126976 packed payload bytes),
704 bytes of cryptographic fields including both Merkle paths for these leaf
positions, plus numeric indices and wire framing. Each submission invokes exactly
2N native FFI calls and 4N single pairings for N proofs. Gas is 500000*N prepaid
cryptography plus the measured SDK reads/writes shown by the remainder; Go
allocations exclude the separately recorded native scratch. #256 must measure
its v2 integration and batch backend directly; these rows are not a capacity gate.

Real EVM route tests use this same nonconstant fixture. Three proofs consume
677,440 static gas plus 1,500,000 prepaid crypto gas. Invalid-first/middle/last
all charge 2,180,094 total including native reads; success at `7f6b7904` charges 2,213,535
including native writes. The success budget boundary and one-below boundary
are checked through `evm.Call`, native store commit, nonce/reward/balance state
and EVM/SDK events. These direct-call totals exclude transaction intrinsic gas; the signed app
regression records 2,291,408 gas for the same three proofs and checks agreement
between receipt, ABCI result, block meter and account fee. Neither is a
throughput measurement. The final activation gate adds 2705 SDK gas to this
legacy EVM baseline: direct success is 2216240 and invalid-first/middle/last are
2182799. With v2 active, the same valid batch instead reverts after 678563 gas
(static 677440 plus admission reads), before any cryptography or payment.
