# Final mixed keeper comparison (#260)

Five interleaved, warmed process observations per revision, three measured
iterations per process, on one otherwise quiet Darwin ARM64 host with
`GOMAXPROCS=2`. One iteration accepts six new sessions with 52 fresh openings:
K8 counts 1/2/8 and K2 counts 1/8/32, mixed owners/deals and data/parity providers.
The safe #255 baseline and selected #256/#258 implementation use the same
nonconstant fixture, setup and finite 64M gas / 2 MiB block profile.

| Per six-session iteration | Baseline median [min, max] | Candidate median [min, max] |
| --- | ---: | ---: |
| Keeper verification, ms | 274.638 [273.643, 276.864] | 45.209 [43.973, 45.871] |
| Fresh generation, ms | 6485.806 [6434.195, 6520.425] | 1761.299 [1713.232, 1780.035] |
| Gas | 26,155,844 | 26,155,844 |
| Go B/op | 145,669 [145,669, 145,685] | 168,645 [168,645, 168,650] |
| Go allocs/op | 1,235 | 1,143 |
| Whole-process peak RSS, bytes | 127,107,072 [121,765,888, 133,988,352] | 133,464,064 [124,567,552, 135,839,744] |

Verification is 6.075x faster; generation falls 72.84%. Both timing ranges
are disjoint. Gas is unchanged. The bounded batch transport costs 22,976 more
Go bytes per six-session iteration while making 92 fewer allocations. This is
consistent with the previously accepted batch transport cost documented in
[the verifier report](../../../performance/retrieval-v2-crypto.md); no extra pool
or singleton implementation was added. RSS ranges overlap and include setup,
fixture storage, generation, Go and native allocators; RSS is not retained heap.
The separate native allocator probes remain necessary and are linked there.

Raw logs include process wall/user/system time. Their medians are respectively
42.14/41.83/0.29 seconds for baseline and 12.13/12.13/0.17 for candidate. These
include setup, fresh warmups, Go benchmark calibration and generation; they are
not keeper execution latency. The first candidate process wall time was 15.23
seconds; all five observations are retained rather than dropping it.

The benchmark asserts first successful `PROOF_SUBMITTED` state for every session.
It does not confirm delivery, settle payment, exercise the mempool, or measure
network capacity. No capacity rate is inferred from this keeper-only comparison.

## Reproduce

[provenance.json](provenance.json) pins source, binary, library, fixture and setup
identities. [measure.py](measure.py) is the exact executed local collection script;
its absolute paths identify the original checkouts and outputs. Raw logs and
[observations.json](observations.json) retain every observation. To repeat on a
new host, use isolated checkouts of the two full source SHAs in provenance,
overlay the same `retrieval_v2_bench_test.go` from fixture commit `d2fa788f` on
the baseline, and build each source's own release native library and keeper test
binary using [the existing build instructions](../../../performance/retrieval-v2-crypto.md#reproduce).
Verify the fixture and setup hashes match before running.

For each of five repeats, alternate baseline/candidate ordering. Run from each
checkout's `polystorechain/x/polystorechain/keeper` directory, substituting that
checkout's absolute binary and library paths:

```sh
GOMAXPROCS=2 DYLD_LIBRARY_PATH=/absolute/checkout/polystore_core/target/release \
POLYSTORE_TRUSTED_SETUP=/absolute/checkout/polystorechain/trusted_setup.txt \
/usr/bin/time -l /absolute/keeper-mixed.test -test.run='^$' \
  -test.bench='^BenchmarkSubmitRetrievalSessionProofV2Mixed$' \
  -test.benchtime=3x -test.count=1 -test.timeout=120s
```

Retain `PASS`, exactly 6 sessions / 52 proofs, all timing/allocation/gas rows and
library identities. The executed collector also enforces a 150-second outer
process-group deadline and retains host process snapshots. Linux requires its
own RSS/time interpretation and native-library environment; do not combine
cross-host results into this same-host comparison.
