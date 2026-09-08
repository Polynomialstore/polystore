# Secured native transaction comparison (#257)

The same N one-proof sessions from alternating owners/deals use one authorized
submitter, either N separately signed transactions or one transaction containing
N existing messages. All sessions were ACKed in fixture setup; these timings
cover proof settlement. Every accepted session still performs one PSB1 FFI call.
No cross-message cryptographic aggregation or fee discount is introduced.

`results.json` contains all 40 observations, medians and ranges; the 20 original
logs and `provenance.json` retain commands, source/harness/library/setup hashes,
load, whole-process CPU and RSS. Five fresh processes per N run three iterations
per mode after fixture preparation. The benchmark starts its timer around SDK
sign/encode plus actual FinalizeBlock/Commit. IAVL uses MemDB: disk fsync, RPC,
block waiting, proof generation, open/ACK and browser verification are excluded.
The app matrix separately checks complete state equivalence, per-session burn
rounding, fees/sequence and rollback after a later validly signed invalid proof.

| Sessions | Separate ms/session (range) | Batched ms/session (range) | Gas/session separate → batch | Tx bytes separate → batch | Go bytes/op separate → batch |
| --- | --- | --- | --- | --- | --- |
| 1 | 5.629 (5.009–5.768) | 4.823 (4.786–4.903) | 619,349 → 619,349 | 1,072 → 1,072 | 1,392,480 → 1,389,354 |
| 8 | 4.090 (3.960–4.148) | 3.440 (3.427–3.454) | 619,485 → 579,573 | 8,590 → 7,366 | 3,452,706 → 2,006,269 |
| 32 | 3.798 (3.783–3.807) | 3.288 (3.278–3.297) | 619,606 → 575,393 | 34,366 → 28,943 | 10,468,360 → 4,083,845 |
| 64 | 3.715 (3.698–3.721) | 3.259 (3.249–3.413) | 619,616 → 574,686 | 68,734 → 57,711 | 19,777,890 → 6,809,077 |

All observations have zero failures and N native calls. N=8/32/64 batch latency
ranges do not overlap their separate-transaction ranges; signatures fall from
N×64 bytes to 64 bytes. Signature/encoding time and envelope bytes, Go allocations
and completion rates are retained in the JSON. The N=1 implementations are the
same path; their order-sensitive timing difference is not a claimed speedup or
an algorithmic regression. Each process runs separate before batched.

Pending serialized proof JSON is unchanged at 1,342 / 10,638 / 42,510 / 85,006
bytes for N=1/8/32/64. Maximum process RSS is 223,199,232 / 226,197,504 /
236,748,800 / 250,200,064 bytes. These RSS/CPU observations include fixture
preparation and both modes, so they cannot establish per-mode RSS deltas. Go
B/op excludes Rust allocations. Native PSB1 scratch is unchanged by transaction
grouping; its independently measured limits are in #256's retained evidence.

**INFRASTRUCTURE_UNAVAILABLE: dedicated runner.** Measurements used a shared
local Apple M3 (Darwin arm64), GOMAXPROCS=2, with background load recorded before
every process. They establish local transaction amortization, not sustained
capacity, a hardware floor, WAN delivery or the #260 operating envelope.

## Reproduce

From a built checkout using the tracked vendor patches:

```sh
cargo build --release --manifest-path polystore_core/Cargo.toml
GOMAXPROCS=2 ./scripts/chain_go.sh test -p 2 -count=1 ./app \
  -run '^TestRetrievalMultiSession(SignedProofRollback|TransactionMatrix)$'
GOMAXPROCS=2 ./scripts/chain_go.sh test -p 2 -c \
  -ldflags=-buildid=retrieval-native-local ./app -o /tmp/retrieval-native.test
cd polystorechain/app
for repeat in 1 2 3 4 5; do
  for n in 1 8 32 64; do
    GOMAXPROCS=2 POLYSTORE_RETRIEVAL_BENCH_SESSIONS=$n \
      /usr/bin/time -l /tmp/retrieval-native.test -test.run '^$' \
      -test.bench "^BenchmarkRetrievalNativeTransactions/N$n/(separate|batched)$" \
      -test.benchtime 3x -test.benchmem > "/tmp/retrieval-n$n-r$repeat.log" 2>&1
  done
done
```

Use `/usr/bin/time -v` on Linux. Change the build ID after changing a native
archive so the Go linker cannot reuse a cached executable with stale native
code. Record fresh source and binary hashes; do not relabel these observations
as measurements of another runtime or harness.

## Live native CLI smoke

`scripts/smoke_retrieval_v2.py` uses only Python standard library and the existing
artifact validators. It creates a new task-owned chain home, isolated loopback
ports, funded owners/provider accounts and finite 64M-gas/2MiB blocks. It checks
real CORS pinned-height access, versioned CLI opens, distinct future challenges,
two-owner/two-deal batch signing with `--gas auto`, a singular submission,
committed matching-hash results and all three canonical payees/payouts. It keeps
its home/results for diagnosis and terminates only the node it starts. Existing
output directories are rejected. The selected provider may be a deputy; the
canonical payee is explicit in each open.

Run from repo root with absolute binary/library/output paths; the output must
not already exist:

```sh
GOMAXPROCS=2 ./scripts/chain_go.sh build -p 2 \
  -ldflags=-buildid=retrieval-cli-local \
  -o /tmp/retrieval-polystorechaind ./cmd/polystorechaind
python3 scripts/smoke_retrieval_v2.py \
  --binary /tmp/retrieval-polystorechaind \
  --library "$PWD/polystore_core/target/release/libpolystore_core.dylib" \
  --output /tmp/retrieval-v2-smoke-new
```

Use `.so` on Linux. `cli-node-smoke.json` records the passing run: the batch
committed at H=25 with 1,195,468 gas, the singular at H=26 with 620,681 gas. Three
independently rounded 6-stake variable burns leave three 11-stake payouts. Base
fees are already burned at open; transaction fees use a separate denomination.
The binary was built at 5686d4b0; relevant production chain/native sources were
unchanged at the recorded run source. Its SHA and native/setup/fixture/harness
hashes are retained. This fixture proves native settlement; it is not canonical
FAT-v2 browser delivery evidence. #260 owns the complete network qualification.
