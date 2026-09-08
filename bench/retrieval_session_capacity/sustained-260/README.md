# Four-validator sustained retrieval harness (#260)

The harness ingests a real 8,126,464-byte K2 file into three assigned
provider-daemons, prepares fresh challenge-bound proofs, and submits them through
eight separately funded deputy signers. It retains normal minting, finite block
limits (64M gas / 2 MiB), all three storage-audit assignments, transaction journals,
Commit metric streams and validator peak RSS. It does not verify delivered files.

The completed runs below are **20-second pilots, not 900-second capacity
qualification**. The driver always leaves `qualification=false`; a completed run
must still be evaluated against the issue's complete acceptance criteria.

## Build and pin the runtime

Use a clean topic checkout containing this harness, the selected #256/#258 crypto
implementation, #271 system audit v2, and #278 CLI/provider readiness fixes. Keep
that checkout and all supplied binaries unchanged until owned processes stop.
Record `git rev-parse HEAD`, `git status --porcelain`, build commands, and SHA-256
of the chain, gateway, Rust CLI, exporter, native library, trusted setup and driver.
The driver's automatic hashes do **not** attest how supplied binaries were built.
Reusing a binary requires retained build provenance and verified unchanged source
for that component; matching a filename is insufficient.

From the checkout root, these sequential commands build the required artifacts
using available dependencies and the maintained vendored chain corrections:

```sh
export RETRIEVAL_REPO="$PWD"
export RETRIEVAL_BIN="$(mktemp -d /tmp/polystore-m2-bin.XXXXXX)"
export GOMAXPROCS=2 GOFLAGS=-p=2
cargo build --manifest-path polystore_core/Cargo.toml --release --locked --offline -j 2
cargo build --manifest-path polystore_cli/Cargo.toml --release --locked --offline -j 2
case "$(uname -s)" in
  Darwin) export RETRIEVAL_LIBRARY="$RETRIEVAL_REPO/polystore_core/target/release/libpolystore_core.dylib" ;;
  Linux) export RETRIEVAL_LIBRARY="$RETRIEVAL_REPO/polystore_core/target/release/libpolystore_core.so" ;;
esac
export CGO_LDFLAGS="-L$RETRIEVAL_REPO/polystore_core/target/release -lpolystore_core"
./scripts/chain_go.sh build -o "$RETRIEVAL_BIN/polystorechaind" ./cmd/polystorechaind
(cd polystore_gateway && go build -o "$RETRIEVAL_BIN/polystore_gateway" .)
(cd polystore_gateway && go test -c -o "$RETRIEVAL_BIN/retrieval-exporter.test" .)
```

Use the platform's working Rust/Go/CGO toolchain and cached dependencies for these
commands; dependency provisioning is outside the measurement. The exporter is an
opt-in Go test executable, not a production endpoint. The driver invokes it once
with a bounded manifest and checks every returned proof against independently
queried session context, committed anchor, intended signer, nonce and expiry.

## Run the same-path pilot, then the final collection

Use an otherwise quiet host with room for builds and retained homes. Run only one
harness at a time: it reserves fixed localhost ports. The `--home` parent must
exist and the selected child must not exist. Homes include test keyrings and are
retained on success or failure; do not publish whole homes. Capture stdout/stderr
outside the new child directory. Do not start unrelated builds during measurement.

The following is the **final 900-second C6 collection command**. Replace the home
name for every attempt:

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --mode sustained-providers --audit-profile c6 \
  --binary "$RETRIEVAL_BIN/polystorechaind" \
  --library "$RETRIEVAL_LIBRARY" \
  --gateway-binary "$RETRIEVAL_BIN/polystore_gateway" \
  --cli-binary "$RETRIEVAL_REPO/polystore_cli/target/release/polystore_cli" \
  --product-source "$RETRIEVAL_REPO" \
  --proof-exporter "$RETRIEVAL_BIN/retrieval-exporter.test" \
  --proof-gas 20000000 --step-seconds 180 --timeout 7200 \
  --home /tmp/polystore-m2-c6-final-001 \
  > /tmp/polystore-m2-c6-final-001.log 2>&1
```

For the bounded same-path pilot, change **only** `--step-seconds 180` to
`--step-seconds 4`, `--timeout 7200` to `--timeout 600`, and both output names.
`--audit-profile normal` preserves normal audit quotas. Explicit `c6` sets the
benchmark genesis minimum and maximum to 132; the protocol clamps that quota to
this K2 assignment's population of 32 rows. All three assignments must therefore
accept 96 samples per epoch. This is a benchmark profile, not a production-default
change or evidence for the larger-population miss probability.

Five equal steps offer 0.25, 0.5, 1, 2 and 4 sessions/s. The full run prepares
1,403 distinct sessions: eight committed warmups and 1,395 measured offers, with
32 fresh openings per session. The pilot prepares 39 (eight plus 31). Preparation
uses at most 64 opens per SDK atomic batch and at most 128 sessions per expiry
bucket. Global nonces remain unique across warmups and measurement. Queue and
in-flight bounds are 128 and eight; an uncertain transaction quarantines its
signer and remains visible in the journal.

The 7,200-second budget includes startup, normal audit readiness, all proof
preparation, warmup, measurement, bounded drain and final audit validation. Native
proof preparation can take tens of minutes. Earliest expiry is pinned near the
preparation height plus 4,000 blocks, within the 4,096-block TTL. The driver refuses
to start measurement unless both remaining wall time and block lifetime cover
900 seconds plus the 120-second drain allowance. Cleanup can outlive the work
deadline while bounded children and the audit monitor stop. The pilots also used
an external 768 MiB free-space stop guard; their retained summaries record its
minimum observed space. That external guard is not built into the driver.

## Retained pilot evidence

| Evidence | Normal pilot | C6 pilot |
| --- | ---: | ---: |
| Fresh warmup / measured proofs committed | 8 / 31 | 8 / 31 |
| Measured unknown or dropped operations | 0 | 0 |
| Final accepted / required audit samples | 3 / 3 | 96 / 96 |
| Offered window / scheduler including drain | 20 / 24.534 s | 20 / 25.075 s |
| Per-validator Commit p95 upper bounds | 380.522–529.704 ms | 290.441–380.359 ms |
| Proof gas used, fixed 20M limit | 16,314,261–16,314,276 | 16,314,267–16,314,282 |
| Validator lifetime peak RSS | 230.6–236.4 MB | 237.9–245.9 MB |

[Normal summary](pilot2/summary.json) and [C6 summary](pilot3-c6/summary.json)
retain binary/source provenance, metric fences, interval upper bounds and raw
stream hashes. Adjacent JSONL files retain the metric streams and public block
summaries without transaction bodies. Both pilots stopped their owned services
successfully. Full private journals and proof inventories remain at the original
local paths recorded in the summaries.

**Original pilot validation:** committed transaction code/gas came from node0's
`block_results`; all four validators agreed on committed block headers and
application hashes. Commit metrics were captured separately from all four nodes.
The later harness change `34027481` additionally compares transaction results
from all four validators. Its negative regression rejects a single-validator gas
mismatch, but these two pilots predate that change. Do not retrospectively claim
that the pilots exercised four-node result comparison; final collection must.

## Interpretation and remaining checks

Inspect `evidence.json`, both SQLite journals, exporter result manifest,
`sustained-audits.jsonl`, `sustained-blocks.jsonl` and all four Commit streams.
Require every warmup to commit before measurement and account for every measured
offer, including unknown, rejected and quarantined operations. Inspect individual
rate steps, queueing/drain, block gas and transaction-byte fill; aggregate pilot
p95 values do not establish sustainable performance at the highest rate.

Commit bounds exclude the post-persistence transition tail, validator-key refresh
and next-round scheduling. Sample gaps produce conservative execution bounds;
they do not justify interpolated per-block latency. Peak RSS covers each
validator's whole lifetime, not just the offered window. Four local processes do
not establish WAN capacity. This workload has no user confirmation, file-delivery,
settlement-conservation, restart, migration or production-security qualification.
The [separate mixed keeper comparison](../mixed-final-260/README.md) covers M1
performance; it is not a substitute for final M2 collection and evaluation.
