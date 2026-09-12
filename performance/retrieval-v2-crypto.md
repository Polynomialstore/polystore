# Fresh-session verifier comparison, 2026-09-08

The complete first v2 proof submission improves on the measured Apple M3 host.
All seven baseline/candidate timing ranges are disjoint. The default K8 eight-proof
median falls from 40.823 ms to 7.066 ms (5.777x); singleton latency also improves.
Activation remains disabled. This is a keeper acceptance measurement, not network
throughput, byte-delivery evidence or sustained validator capacity.

[Machine-readable samples and exact provenance](retrieval-v2-crypto-2026-09-08.json)
retain every benchmark row, source/native-library/test-binary/setup/fixture hash,
Go allocations, gas and separately measured generation. Baseline source `34e7c2db`
has the merged `bdd59f38` code plus the identical copied benchmark fixture;
candidate verifier source is `7144c8d8`. Both use Go 1.25.5, GOMAXPROCS=2, Rust
1.90.0 release/default features and the approved setup. Five interleaved
baseline/candidate subprocesses each perform three iterations per listed count.
No agent builds, tests or nodes ran concurrently; this was a shared user workstation.
An initial `Hot` hint resolved to K8 and was excluded from K2 evidence. The final
K2 run uses explicit `General:rs=2+1` and asserts actual output labels/counts.

## First acceptance

Values are median [minimum, maximum] across five process-level observations.
Proofs/s is proof count divided by median keeper time, excluding generation.

| Profile | Proofs | Independent ms | Batch ms | Speedup | Independent proofs/s | Batch proofs/s | Gas/op, both |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| K8 | 1 | 5.122 [5.027, 5.262] | 3.193 [3.065, 3.206] | 1.604x | 195.2 | 313.2 | 525,644 |
| K8 | 2 | 10.241 [10.091, 10.463] | 3.753 [3.691, 3.777] | 2.728x | 195.3 | 532.8 | 1,025,644 |
| K8 | 8 | 40.823 [40.222, 41.014] | 7.066 [6.715, 7.140] | 5.777x | 196.0 | 1132.1 | 4,025,644 |
| K2 | 1 | 5.112 [4.933, 5.309] | 3.188 [3.056, 3.346] | 1.603x | 195.6 | 313.6 | 525,644 |
| K2 | 2 | 10.173 [10.027, 12.975] | 3.679 [3.531, 4.185] | 2.765x | 196.6 | 543.7 | 1,025,644 |
| K2 | 8 | 40.869 [40.712, 46.300] | 7.049 [6.792, 7.191] | 5.798x | 195.7 | 1134.9 | 4,025,644 |
| K2 | 32 | 166.608 [163.134, 185.236] | 19.392 [19.245, 21.335] | 8.592x | 192.1 | 1650.2 | 16,025,710 |

The measured revision charged 500,000 gas per proof plus the same SDK work; the
current independent route charges 1,200,000. Ordinary v2 dispatch changes
from two independent native calls per proof to one native call per complete list.
The batch performs two MSMs, one generator multiplication and two Miller-loop
terms with one final exponentiation; the corrected independent path uses four
pairing terms per proof. Go count coverage of the actual C call in
`TestRetrievalV2BatchFirstMiddleLastFailure` records exactly four dispatches:
three invalid batches and one accepted batch. Underfunded prepayment and the
accepted retry add zero. Invalid first/middle/last all pay whole-list gas and
leave session/payout state unchanged.

## Generation and memory

Go bytes/allocations below are medians; all raw ranges are in the JSON artifact.
Generation is median milliseconds and includes fresh blob opening evaluation,
prover MSM and proof construction outside the acceptance timer. Setup, challenge
derivation, session opening and the reusable structural root-table opening are
outside that metric. This change does not optimize proof generation.

| Profile | Proofs | Independent Go B/op | Batch Go B/op | Independent allocs/op | Batch allocs/op | Independent generation ms | Batch generation ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| K8 | 1 | 15,005 | 15,997 | 127 | 127 | 120.004 | 119.819 |
| K8 | 2 | 16,285 | 17,757 | 138 | 136 | 239.861 | 239.614 |
| K8 | 8 | 23,645 | 27,178 | 199 | 188 | 960.381 | 964.363 |
| K2 | 1 | 15,048 | 16,040 | 128 | 128 | 119.348 | 119.896 |
| K2 | 2 | 16,618 | 17,885 | 143 | 138 | 239.355 | 239.346 |
| K2 | 8 | 23,717 | 27,037 | 200 | 186 | 955.487 | 957.621 |
| K2 | 32 | 53,400 | 65,258 | 444 | 384 | 3834.162 | 3831.559 |

Singleton Go allocation rises by about 1 KiB while its latency falls by about 38%.
This bounded transport cost is accepted; a separate singleton implementation or
pool would add complexity. The batch necessarily holds O(proofs + path bytes)
parsed openings, transcript, coefficients and MSM inputs. The
[native allocator probe](../polystore_core/examples/verifier_allocations.md)
records 4,040 bytes peak requested native heap for its normal singleton statement
versus 2,504 for independent verification; the admitted 64-proof maximum-path
fixture peaks at 125,952 bytes. Both warm passes match and retain zero native heap.
Those native fixtures have their own documented geometry; they are not K8/K2
keeper memory measurements. Go B/op and native peak cannot be added to claim total
peak/RSS. Stack, allocator overhead, setup, input storage and concurrent requests
remain outside the native probe.

Fresh blob generation remains roughly 120 ms per blob on this implementation;
eight-proof generation is roughly 960 ms. Verifier proof rates therefore cannot
be advertised as complete retrieval rates. #257/#260 must include generation,
transport, actual-byte verification, confirmation and block work in qualification.

## Reproduce

Use isolated checkouts of baseline `34e7c2db182eb08957f56f8dc9f29b0acdc0c0d5`
and candidate `7144c8d8b55aa13275c96c9d47a5a566616b58c7`. Copy only candidate
`polystorechain/x/polystorechain/keeper/retrieval_v2_bench_test.go` into the baseline
checkout. Its recorded SHA-256 must match in both trees. Build each tree's own
native release library and test binary; never share either across versions:

```sh
cargo build --manifest-path polystore_core/Cargo.toml --release --locked --offline -j 2
(cd polystorechain && ../scripts/chain_go.sh test -c -p 2 -o ../keeper-v2.test ./x/polystorechain/keeper)
```

In each tree, for each of five repeats, run the following once for
`General:rs=8+4` and once for `General:rs=2+1`. Interleave baseline and candidate
for the same profile/repeat, keep the host quiet and use a 180-second subprocess
timeout. Output must contain actual `/K8/proofs1,2,8` or `/K2/proofs1,2,8,32`
rows and `PASS`; exit status alone does not establish the selected layout.

```sh
(cd polystorechain/x/polystorechain/keeper && \
  GOMAXPROCS=2 \
  DYLD_LIBRARY_PATH="$PWD/../../../../polystore_core/target/release" \
  LD_LIBRARY_PATH="$PWD/../../../../polystore_core/target/release" \
  POLYSTORE_BENCH_FIXTURE_SERVICE_HINT='General:rs=8+4' \
  ../../../../keeper-v2.test -test.run='^$' \
    -test.bench='^BenchmarkSubmitRetrievalSessionProofV2$' \
    -test.benchtime=3x -test.count=1)
```

The benchmark opens distinct sessions in discarded cache contexts, captures the
future anchor and regenerates the required z openings before each timed first
acceptance. Cache isolation prevents duration from changing live-session caps or
history; the measured call uses a fresh finite gas meter and asserts the resulting
`PROOF_SUBMITTED` state. Legal public slot/MDU limits are unchanged. Core 64-proof
and maximum-path samples remain separately labelled API boundary tests.

## Integrated node compatibility smoke

The integrated daemon at `147549585fd8bd32e85b6e81021e6569f64aa568`
completed the M0 harness with one two-proof nonconstant session: all eight
registration/deal/open/proof/confirm transactions committed successfully, and the
exact session `b5bfce6963e99f75519a26901da381d25419f59e1dcb0c6f65bd5f3649b1f97c`
was queried as `COMPLETED` at height 9. The load used 1,339,732 gas. The native
library SHA-256 matched the candidate recorded above; the only working-tree
change was formatting this document's reproduction command.

Reproduce with `POLYSTORE_BENCH_SESSIONS=1 POLYSTORE_BENCH_PROOFS_PER_SESSION=2
bash scripts/bench_retrieval_sessions.sh` (on one shell line). This harness defaults
to nonconstant data and remains a legacy fixed-z compatibility smoke. It does
not exercise the v2 batch path; the actual v2 keeper integration and repeated
measurements above cover that path. Full live v2 delivery remains #257/#260 work.

## Final selected mixed workload

The [five-pair final comparison](../bench/retrieval_session_capacity/mixed-final-260/README.md)
includes the selected #258 generator and mixed K8/K2 owners, deals and providers.
Median verification for six fresh sessions / 52 openings improves from 274.638 ms
to 45.209 ms (6.075x), with identical 26,155,844 gas. Fresh generation falls from
6485.806 ms to 1761.299 ms. Both timing ranges are disjoint. Go allocation count
falls from 1,235 to 1,143; allocated bytes rise from 145,669 to 168,645, consistent
with the bounded batch transport discussed above. This is keeper-only evidence;
#260 retains ownership of final delivery and sustained capacity qualification.
