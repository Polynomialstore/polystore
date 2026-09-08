# PolyStore Network Performance Simulation Plan

## Objective
To benchmark the `polystorechain` implementation under varying loads to assess stability, transaction throughput (TPS), and resource consumption. This ensures the Phase 3 implementation is robust enough for Phase 4 (Testnet).

## Scope
Simulations will be run locally. "Scale" refers to the volume of state (Providers, Deals) and transactions, not physical distributed nodes.

## Simulation Scenarios

### 1. Small Scale (Functional Baseline)
*   **Validators:** 1
*   **Providers:** 10
*   **Deals:** 10
*   **Flow:** Register -> Create Deal -> Single Proof per Deal.
*   **Goal:** Verify correctness and baseline latency.

### 2. Medium Scale (Throughput Test)
*   **Validators:** 1
*   **Providers:** 50
*   **Deals:** 100
*   **Flow:** 
    *   Batch Register 50 Providers.
    *   Batch Create 100 Deals.
    *   Concurrent Proof Submission (50+ txs in mempool).
*   **Goal:** Measure average TPS and Block Time under moderate congestion.

### 3. Large Scale (Stress Test)
*   **Validators:** 1
*   **Providers:** 200
*   **Deals:** 500+
*   **Flow:** Rapid-fire creation and proving.
*   **Goal:** Identify bottlenecks (CPU, I/O) and max TPS before mempool saturation or timeout.

## Metrics to Capture
1.  **Total Execution Time:** From start of load to final block commit.
2.  **Average Block Time:** Time between block headers.
3.  **Transactions Per Second (TPS):** Total Txs / (Final Time - Start Time).
4.  **Success Rate:** % of Txs included in blocks vs submitted.

## Methodology
*   **Tooling:** A simplified Bash/Go load generator (`load_gen.sh`) utilizing the `polystorechaind` CLI with `async` broadcasting for throughput.
*   **Environment:** Local dev machine.
*   **Verification:** Log parsing to confirm state updates.

## Gateway mode-2 benchmark

For Mode-2 KZG + stripe ingest profiling and throughput tuning, use:

```bash
./performance/gateway_mode2_benchmark.sh --sizes "64,128,256"
```

The harness writes:

- `CSV` rows with end-to-end timing (`mode2_*`) and throughput
- `JSONL` detailed per-run payload responses
- A compact run summary JSON

See [`gateway_mode2_benchmark.md`](./gateway_mode2_benchmark.md) for usage details and field guidance.

## Retrieval-session driver safety (#260 preparation)

`scripts/bench_retrieval_sessions.sh` creates a unique chain home under
`_artifacts/bench-retrieval-*` and builds its chain binary inside that home.
`POLYSTORE_BENCH_HOME`, when supplied, must name a **new, nonexistent** directory
with an existing parent. Existing files, directories and symlinks are rejected
before any build. The driver removes only its own home on exit; `--keep-home`
retains that home (including the binary and node log) for inspection. It does not
permit reuse of an existing home. Recursive cleanup stays bound to the verified directory even if its pathname is
replaced; the final pathname operation can only remove an empty directory.
Run under an operator-controlled parent and keep the home and its ancestors
exclusively owned and unchanged until exit. Replacement protection applies to
recursive cleanup; builds, chain commands and configuration writes use pathnames
and require that exclusive ownership.

Run the entrypoint safety checks without compiling or starting a node:

```bash
python3 scripts/test_bench_retrieval_sessions.py
bash -n scripts/bench_retrieval_sessions.sh
```

The driver supports only the explicitly labeled `legacy-serial` mode. This is
M0 preparation for #260, with fixed legacy proof coordinates. It does not exercise
secure v2 challenges or establish capacity. A short lifecycle smoke is:

```bash
POLYSTORE_BENCH_SESSIONS=1 POLYSTORE_BENCH_PROOFS_PER_SESSION=2 \
  POLYSTORE_BENCH_OUTPUT=/tmp/retrieval-smoke.json \
  GOMAXPROCS=2 bash scripts/bench_retrieval_sessions.sh --keep-home
```

The default generated proof fixture uses deterministic nonconstant canonical
field elements: each 32-byte element is 31 zero bytes followed by a byte cycling
from 1 through 251. `POLYSTORE_BENCH_FIXTURE_DATA=legacy-zero` retains the old zero
fixture for explicitly labeled comparisons. The exporter writes `fixture.json`
beside the existing proof files and manifest root. Metadata records the actual
8 MiB encoded MDU hash, 8,126,464-byte raw payload capacity, trusted setup hash,
proof payload hash, root, layout, session count, and total proof count. The shell
independently recomputes the data pattern hash and checks every payload and the
node's trusted setup. Requested exports fail when setup is absent. Externally
supplied fixture directories must include this metadata; old result files are
unchanged.

The finite candidate profile is `General:rs=2+1`, slot 0, one user MDU following
two metadata MDUs, at most 32 proofs per session and 8,192 sessions per run.
`POLYSTORE_BENCH_PROOFS_PER_SESSION=0` is a control-only run with no completed
retrieval throughput. The profile fixes 64 million gas, 2 MiB block bytes and a
1,000 ms target interval. Before starting, the driver records an execution budget
(default 700 ms, `POLYSTORE_BENCH_EXECUTION_BUDGET_MS`) and memory ceiling (default
2 GiB, `POLYSTORE_BENCH_MEMORY_CEILING_BYTES`). These budgets are **declared, not
measured or enforced** by this preparation. Every result sets `qualification`
and `saturation` false.

Schema version 2 records source revision and working-tree diff, untracked source
hashes, compiler/host details, binary/native/setup hashes, harness hashes, and the
profile. The driver builds this checkout's native library with two Cargo jobs
and the patched-vendor chain with Go parallelism two; external native-library
paths are rejected. It selects isolated loopback ports by default, disables
unused listeners, and verifies the RPC node identity before sending transactions.
The home and parent still require exclusive ownership as described above.

Each transaction has an explicit outcome: `committed_success`,
`committed_failure`, `checktx_rejected`, or `unknown`; unexecuted stages are
`skipped`. A committed result must contain the exact transaction hash, positive
height, code, gas wanted, and gas used. An unknown outcome aborts before the
signer is reused. Completion requires committed open, proof and confirmation
transactions plus the matching session queried as `COMPLETED` at the committed
confirmation height. Missing or malformed session queries do not count as
completion. Counters distinguish setup from load and count actual committed
proofs and gas. Timing uses an OS monotonic clock shared between CLI processes,
including Python 3.9 on macOS; the wall interval includes pacing, CLI submission,
CheckTx, inclusion, and final session queries.

Remaining M0 work in #260 is independent funded signer concurrency with bounded
in-flight work and per-account sequencing, explicit warmup/repetitions,
proof-only and full-lifecycle sustained-load phases, backlog/block-fill/transaction
byte and execution/RSS measurements. V2 fixtures and provider delivery require
#255–#257. Fifteen-minute and four-validator qualification runs remain gated on
those prerequisites; this serial smoke provides no capacity or activation claim.
