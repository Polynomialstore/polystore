# Concurrent retrieval preparation (#260)

This harness prepares evidence for [#260](https://github.com/Polynomialstore/polystore/issues/260).
It does **not** establish network delivery, saturation or qualified capacity.
Final collection waits for #255–#257 and the reviewed harness to merge.

The legacy `scripts/bench_retrieval_sessions.sh` mode remains available and labeled
as compatibility evidence. The new helpers use only Python's standard library
and the existing native proof library. No provider transport is simulated as
delivered bytes.

## Build and check

Run from the repository root, in a topic worktree. These commands build the
current source after the compatible #257 CLI has merged; older binaries fail
the workload capability check before startup or funding. Reusing an arbitrary
binary is permitted for diagnostics but
does not attest its correspondence to that source.

```sh
export GOMAXPROCS=2 GOFLAGS=-p=2
export POLYSTORE_PREP_DIR="$(mktemp -d /tmp/polystore-retrieval-prep.XXXXXX)"
cargo build --release --manifest-path polystore_core/Cargo.toml
case "$(uname -s)" in
  Darwin) export POLYSTORE_PREP_LIB="$PWD/polystore_core/target/release/libpolystore_core.dylib" ;;
  Linux) export POLYSTORE_PREP_LIB="$PWD/polystore_core/target/release/libpolystore_core.so" ;;
  *) exit 1 ;;
esac
export LD_LIBRARY_PATH="$PWD/polystore_core/target/release${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export DYLD_LIBRARY_PATH="$PWD/polystore_core/target/release${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
scripts/chain_go.sh build -o "$POLYSTORE_PREP_DIR/polystorechaind" ./cmd/polystorechaind
python3 scripts/test_bench_retrieval_sessions.py
POLYSTORE_TEST_NATIVE_LIBRARY="$POLYSTORE_PREP_LIB" \
  python3 -m unittest discover -s scripts -p 'test_retrieval*.py'
```

`chain_go.sh` reconstructs vendor dependencies while preserving tracked SDK
patches. The native test environment variable is required to run native checks;
omitting it leaves that subset skipped. CI supplies the freshly built library.

Export the complete deterministic nonconstant fixture rows. These exports reuse
the existing keeper fixture, including both structural inclusion hops. Their
legacy evaluation points are replaced after each session's canonical anchor is
available; legacy points cannot satisfy the fresh proof.

```sh
POLYSTORE_BENCH_FIXTURE_DIR="$POLYSTORE_PREP_DIR/k8" \
POLYSTORE_BENCH_FIXTURE_SESSIONS=1 POLYSTORE_BENCH_FIXTURE_NONCONSTANT=1 \
POLYSTORE_BENCH_FIXTURE_SERVICE_HINT='General:rs=8+4' POLYSTORE_BENCH_FIXTURE_COUNT=8 \
  scripts/chain_go.sh test ./x/polystorechain/keeper \
    -run '^TestWriteRetrievalSessionProofFixture$' -count=1 -timeout=120s
POLYSTORE_BENCH_FIXTURE_DIR="$POLYSTORE_PREP_DIR/k2" \
POLYSTORE_BENCH_FIXTURE_SESSIONS=1 POLYSTORE_BENCH_FIXTURE_NONCONSTANT=1 \
POLYSTORE_BENCH_FIXTURE_SERVICE_HINT='General:rs=2+1' POLYSTORE_BENCH_FIXTURE_COUNT=32 \
  scripts/chain_go.sh test ./x/polystorechain/keeper \
    -run '^TestWriteRetrievalSessionProofFixture$' -count=1 -timeout=120s
```

## Four validators and real settlement

```sh
python3 scripts/retrieval_four_validator_workload.py \
  --binary "$POLYSTORE_PREP_DIR/polystorechaind" --library "$POLYSTORE_PREP_LIB" \
  --home "$POLYSTORE_PREP_DIR/settlement" \
  --fixture-k8 "$POLYSTORE_PREP_DIR/k8" --fixture-k2 "$POLYSTORE_PREP_DIR/k2" \
  --timeout 600
```

The new `--home` must not exist. This starts four owned local processes, with
distinct consensus keys and equal voting power, and retains homes and evidence
after stopping them. Occupied ports fail before startup; it never kills a process
discovered by port or deletes an old home. Fixed ports are:

| Service | Four loopback ports |
| --- | --- |
| RPC | 26657, 26654, 26651, 26648 |
| P2P | 26656, 26653, 26650, 26647 |
| gRPC | 9090, 9088, 9086, 9084 |
| API | 1317, 1316, 1315, 1314 |
| Metrics | 26660, 26661, 26662, 26663 |

The smoke opens two owner-funded deals, selects slot zero in each, and executes
six open → fresh proof → confirmation lifecycles with 1/2/8 blobs each. The two
explicit proof authorities are distinct. It checks all four validators at the
same committed height for terminal sessions, authorized payees, escrow debits,
module balances, once-only activity counters, payouts and rounded burns. Block
H+1 supplies the app hash for executed state H. It then restarts the same homes
and compares both the original and a later committed state.

This isolated smoke pins base fee 3 stake, variable fee 17 stake/blob, burn 3333
bps and zero mint inflation to expose exact conservation. It retains finite
64-million gas / 2-MiB block limits and the default audit settings. It does not
qualify production issuance, nonzero slots, provider bytes or the stronger
132-sample audit profile. `evidence.json` always has `qualification: false`.
On failure, `evidence.json` retains setup transaction outcomes and the SQLite
journal retains known workload outcomes. Missing or ambiguous outcomes cannot
become successful sessions or signer retries.

## Measurement boundaries

The scheduler admits bounded work and owns a signer until its committed result.
Code 19 (already in the mempool), absent hashes after possible broadcast and
receipt deadlines remain uncertain. Proof preparation and submission share an
absolute deadline. Its journal distinguishes offered operations, accepted
transactions and terminal lifecycles; a committed open alone is not completion.

`retrieval_commit_metrics.py` reads the existing CometBFT Commit-step count/sum.
This includes validation, blockstore/WAL fsync, FinalizeBlock, application Commit,
mempool update and state persistence, plus any wait for a committed block. It
excludes the subsequent state-transition tail, validator-key refresh and round
scheduling. It reports a conservative p95 upper bound, including grouped scrape
intervals and floating-point roundoff. It never calls the mean p95. Phase
boundaries and observation counts must be reconciled with committed heights;
missing observations, resets or unresolved boundaries remain unqualified.
Capture the helper through `run_bounded_command` for an absolute HTTP deadline.

Each owned validator is reaped using `wait4`, retaining its kernel peak RSS,
including native memory, separately for startup and restart. Missing usage stays
unavailable rather than becoming zero. The predeclared limits remain 700 ms for
the documented execution boundary and 2 GiB per validator. The lifecycle smoke
does not yet apply or qualify those load budgets.

Remaining #260 work includes actual 1 GiB network delivery, sustained offered-load
steps demonstrating saturation, production economic/adversarial traffic and the
final repeated baseline/candidate report. Four processes on one shared host do
not establish WAN capacity or four independent hardware hosts.

## Retained correctness diagnostic

[`settlement-smoke.json`](settlement-smoke.json) records the successful local
four-validator run at harness commit `a024f0e9`, including all committed setup and
workload outcomes, fresh-proof hashes, canonical state comparisons, eight metric
captures and eight kernel peak-RSS observations across initial/restarted processes.
Six sessions and 22 fresh proofs complete through 18 workload transactions.
Escrow debits of 392 stake equal 246 stake paid to providers plus 146 burned.
Same-height app-hash/economic agreement and later-height restart checks pass.

The diagnostic binary combines #257 commit `c8b04fbd` with the two reviewed #260
multi-node configuration files through Go's build overlay. Exact file, binary,
library and evidence hashes and the build command are in
[`diagnostic-build.json`](diagnostic-build.json). The harness source is committed;
its recorded dirty paths are documentation only. Fixture data were generated by
the existing keeper exporter and validated separately against all 40 nonconstant
K8/K2 commitments and 52 fresh openings. This integration check precedes merged
source correspondence and final collection, so its qualification remains false.
The wide timing captures validate instrumentation only; no p95 or capacity claim
is derived from this smoke.


## Prepared proof-only smoke

Add `--proof-only` to the four-validator command above, with a new `--home`.
The driver commits six opens, waits for each canonical challenge and generates
fresh native openings before the measurement fence. The scheduler submits only
those six proofs, verifies `PROOF_SUBMITTED` at each transaction's committed
height, and reports zero completed lifecycles inside this interval. Confirmation,
payout checks and restart then run outside the interval. The original complete
lifecycle mode remains the default.

Prepared inventory is bounded and pinned to session, seed, anchor, frozen payee
and proof-file digest. It is revalidated before broadcast and cannot be reused
under another operation ID. An empty offered inventory slot records depletion,
not an offered transaction or completed proof. Preparation and HTTP evidence
reads share the run's absolute deadline. Latest evidence uses `/abci_info`'s
persisted application height: `/status` can publish a block before its state is
queryable.

Proof-only Commit measurements fence two scrapes with three stable `/status`
reads, verify the owned node/chain and require the metric count to equal height
minus the known process-start application height. A moving or incomplete fence
is retried only within the existing phase deadline. Each measured proof must
fall strictly after the starting fence and at or before the ending fence.
These counts apply to the initial fresh process only; a restarted process needs
its own recorded start height and series. The conservative bound covers the
previously documented Commit boundary, not all consensus work.

[`prepared-proof-smoke.json`](prepared-proof-smoke.json) retains the successful
six-session diagnostic: proof transactions at heights 44–46 fall within all four
node fences 43–46. The window records six submitted proofs (22 blob openings),
zero completed lifecycles, and no depleted inventory. Subsequent confirmation
checks the same 392 = 246 + 146 stake conservation and restart agreement. This
uses the same diagnostic binary/library/setup identified in
[`diagnostic-build.json`](diagnostic-build.json); its supplied-binary limitation
remains explicit. Source hashes identify the tested dirty driver; the final
additional node-ID labels and coverage assertion were checked against these raw
artifacts. This short zero-mint, slot-zero run is instrumentation evidence only,
not a sustained-load, saturation, delivery or capacity qualification.
