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

Run the entrypoint safety checks without compiling or starting a node:

```bash
python3 scripts/test_bench_retrieval_sessions.py
bash -n scripts/bench_retrieval_sessions.sh
```

The existing driver still submits and waits serially. Its output is a preliminary
latency characterization, not saturation or secure-v2 capacity evidence. #260
still requires the concurrent load driver, nonconstant fixtures, provenance and
finite-gas qualification after the #255–#257 security prerequisites. This safety
change alone does not qualify or activate that protocol.
