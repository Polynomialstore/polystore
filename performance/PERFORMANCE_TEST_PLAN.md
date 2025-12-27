# NilStore Network Performance Simulation Plan

## Objective
To benchmark the `nilchain` implementation under varying loads to assess stability, transaction throughput (TPS), and resource consumption. This ensures the Phase 3 implementation is robust enough for Phase 4 (Testnet).

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
*   **Tooling:** A simplified Bash/Go load generator (`load_gen.sh`) utilizing the `nilchaind` CLI with `async` broadcasting for throughput.
*   **Environment:** Local dev machine.
*   **Verification:** Log parsing to confirm state updates.
