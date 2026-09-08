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
from these timings. #260 still owns sustained capacity and native memory work.

Real EVM route tests use this same nonconstant fixture. Three proofs consume
677,440 static gas plus 1,500,000 prepaid crypto gas. Invalid-first/middle/last
all charge 2,180,094 total including native reads; success charges 2,204,742
including native writes. The success budget boundary and one-below boundary
are checked through `evm.Call`, native store commit, nonce/reward/balance state
and EVM/SDK events. This is not a receipt/block throughput measurement.
