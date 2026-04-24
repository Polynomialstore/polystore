# Policy Simulation Sensitivity Sweep

This report aggregates `9` completed simulator run output directories. It does not rerun the simulator or mutate raw run artifacts.

## Executive Summary

- Mode: `Sensitivity Sweep`.
- Runs analyzed: `9`.
- Varied parameters: `2`.
- Critical-risk runs: `5`.
- Assertion failures: `5`.
- Runs with modeled data loss: `0`.
- Decision posture: do not promote parameters from failing assertion contracts without explicit human approval.

## Run Matrix

| Run | Scenario | Seed | Risk | Assertions | Success | Unavailable Reads | Data Loss | Repairs | Backoffs | Saturated | Negative P&L | Storage Price | Retrieval Price |
|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `high-bandwidth-capacity-threshold-100__high-bandwidth-demotion-saturation-bps-100` | `high-bandwidth-regression` | `44` | `medium` | `PASS` | 100.00% | 0 | 0 | 0/0 | 0 | 43 | 0 | 1.0000 | 0.0140 |
| `high-bandwidth-capacity-threshold-100__high-bandwidth-demotion-saturation-bps-300` | `high-bandwidth-regression` | `44` | `medium` | `PASS` | 100.00% | 0 | 0 | 0/0 | 0 | 68 | 0 | 1.0000 | 0.0140 |
| `high-bandwidth-capacity-threshold-100__high-bandwidth-demotion-saturation-bps-600` | `high-bandwidth-regression` | `44` | `critical` | `FAIL` | 100.00% | 0 | 0 | 0/0 | 0 | 61 | 0 | 1.0000 | 0.0140 |
| `high-bandwidth-capacity-threshold-110__high-bandwidth-demotion-saturation-bps-100` | `high-bandwidth-regression` | `44` | `medium` | `PASS` | 100.00% | 0 | 0 | 0/0 | 0 | 21 | 0 | 1.0000 | 0.0140 |
| `high-bandwidth-capacity-threshold-110__high-bandwidth-demotion-saturation-bps-300` | `high-bandwidth-regression` | `44` | `medium` | `PASS` | 100.00% | 0 | 0 | 0/0 | 0 | 21 | 0 | 1.0000 | 0.0140 |
| `high-bandwidth-capacity-threshold-110__high-bandwidth-demotion-saturation-bps-600` | `high-bandwidth-regression` | `44` | `critical` | `FAIL` | 100.00% | 0 | 0 | 0/0 | 0 | 21 | 0 | 1.0000 | 0.0140 |
| `high-bandwidth-capacity-threshold-120__high-bandwidth-demotion-saturation-bps-100` | `high-bandwidth-regression` | `44` | `critical` | `FAIL` | 100.00% | 0 | 0 | 0/0 | 0 | 10 | 0 | 1.0000 | 0.0140 |
| `high-bandwidth-capacity-threshold-120__high-bandwidth-demotion-saturation-bps-300` | `high-bandwidth-regression` | `44` | `critical` | `FAIL` | 100.00% | 0 | 0 | 0/0 | 0 | 10 | 0 | 1.0000 | 0.0140 |
| `high-bandwidth-capacity-threshold-120__high-bandwidth-demotion-saturation-bps-600` | `high-bandwidth-regression` | `44` | `critical` | `FAIL` | 100.00% | 0 | 0 | 0/0 | 0 | 10 | 0 | 1.0000 | 0.0140 |

## Key Metric Ranges

| Metric | Min | Max | Delta | Mean | Review Meaning |
|---|---:|---:|---:|---:|---|
| `success_rate` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Primary availability outcome; should not regress silently. |
| `unavailable_reads` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Temporary user-facing misses; allowed only in explicit stress contracts. |
| `data_loss_events` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Durability invariant; non-zero values block graduation. |
| `reward_coverage` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Shows whether compliant responsibility remains economically recognized. |
| `repairs_started` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Detection and repair activation pressure. |
| `repairs_ready` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `repairs_completed` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Healing throughput under the parameter set. |
| `repair_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Repair retry pressure before starts or backoffs. |
| `repair_backoffs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Replacement capacity or repair-start bottlenecks. |
| `repair_cooldowns` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retry cooldowns that intentionally throttle repair churn. |
| `repair_attempt_caps` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Per-slot attempt caps hit before a replacement could start. |
| `high_bandwidth_promotions` | 17.000000 | 40.000000 | 23.000000 | 29.666667 | Measured provider capability promotions. |
| `high_bandwidth_demotions` | 0.000000 | 5.000000 | 5.000000 | 1.444444 | Capability demotions after performance regression. |
| `high_bandwidth_providers` | 17.000000 | 40.000000 | 23.000000 | 28.222222 | Final provider count eligible for high-bandwidth routing. |
| `high_bandwidth_serves` | 11899.000000 | 27181.000000 | 15282.000000 | 19840.888889 | Serves attributed to high-bandwidth providers. |
| `hot_retrieval_attempts` | 4800.000000 | 4800.000000 | 0.000000 | 4800.000000 | Hot-service demand exercised by the run. |
| `hot_high_bandwidth_serves` | 11899.000000 | 27181.000000 | 15282.000000 | 19840.888889 | Hot retrieval serves handled by promoted high-bandwidth providers. |
| `platinum_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `gold_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `silver_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `fail_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `average_latency_ms` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `performance_fail_rate` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `performance_reward_paid` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `suspect_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Soft warning slot-epochs before thresholded delinquency. |
| `delinquent_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Threshold-crossed slot-epochs that should be visible to operators. |
| `quota_misses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Soft liveness evidence generated by the run. |
| `invalid_proofs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hard-fault evidence generated by the run. |
| `paid_corrupt_bytes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Payment safety invariant; should remain zero. |
| `providers_negative_pnl` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Market sustainability and churn pressure. |
| `saturated_responses` | 10.000000 | 68.000000 | 58.000000 | 29.444444 | Provider bandwidth bottleneck signal. |
| `providers_over_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Placement/capacity invariant; should remain zero. |
| `final_storage_utilization_bps` | 3750.000000 | 3750.000000 | 0.000000 | 3750.000000 | Supply utilization against modeled capacity. |
| `final_storage_price` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Storage-controller endpoint under this run. |
| `final_retrieval_price` | 0.014000 | 0.014000 | 0.000000 | 0.014000 | Retrieval-controller endpoint under this run. |
| `provider_pnl` | 478.080000 | 478.080000 | 0.000000 | 478.080000 | Aggregate provider economics; inspect distribution before deciding. |

## Varied Parameters

| Parameter | Values |
|---|---|
| `high_bandwidth_capacity_threshold` | `100`, `110`, `120` |
| `high_bandwidth_demotion_saturation_bps` | `100`, `300`, `600` |

## Parameter Sensitivity

| Parameter | Value | Runs | Avg Success | Total Unavailable | Total Data Loss | Avg Backoffs | Avg Negative P&L | Avg Final Storage Price |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `high_bandwidth_capacity_threshold` | `100` | 3 | 100.00% | 0 | 0 | 0 | 0 | 1.0000 |
| `high_bandwidth_capacity_threshold` | `110` | 3 | 100.00% | 0 | 0 | 0 | 0 | 1.0000 |
| `high_bandwidth_capacity_threshold` | `120` | 3 | 100.00% | 0 | 0 | 0 | 0 | 1.0000 |
| `high_bandwidth_demotion_saturation_bps` | `100` | 3 | 100.00% | 0 | 0 | 0 | 0 | 1.0000 |
| `high_bandwidth_demotion_saturation_bps` | `300` | 3 | 100.00% | 0 | 0 | 0 | 0 | 1.0000 |
| `high_bandwidth_demotion_saturation_bps` | `600` | 3 | 100.00% | 0 | 0 | 0 | 0 | 1.0000 |

## High-Risk Runs

| Run | Scenario | Risk | Reasons |
|---|---|---|---|
| `high-bandwidth-capacity-threshold-120__high-bandwidth-demotion-saturation-bps-600` | `high-bandwidth-regression` | `critical` | 1 assertion contract failures; provider bandwidth saturation occurred |
| `high-bandwidth-capacity-threshold-120__high-bandwidth-demotion-saturation-bps-300` | `high-bandwidth-regression` | `critical` | 1 assertion contract failures; provider bandwidth saturation occurred |
| `high-bandwidth-capacity-threshold-120__high-bandwidth-demotion-saturation-bps-100` | `high-bandwidth-regression` | `critical` | 1 assertion contract failures; provider bandwidth saturation occurred |
| `high-bandwidth-capacity-threshold-110__high-bandwidth-demotion-saturation-bps-600` | `high-bandwidth-regression` | `critical` | 1 assertion contract failures; provider bandwidth saturation occurred |
| `high-bandwidth-capacity-threshold-100__high-bandwidth-demotion-saturation-bps-600` | `high-bandwidth-regression` | `critical` | 1 assertion contract failures; provider bandwidth saturation occurred |
| `high-bandwidth-capacity-threshold-110__high-bandwidth-demotion-saturation-bps-300` | `high-bandwidth-regression` | `medium` | provider bandwidth saturation occurred |
| `high-bandwidth-capacity-threshold-110__high-bandwidth-demotion-saturation-bps-100` | `high-bandwidth-regression` | `medium` | provider bandwidth saturation occurred |
| `high-bandwidth-capacity-threshold-100__high-bandwidth-demotion-saturation-bps-300` | `high-bandwidth-regression` | `medium` | provider bandwidth saturation occurred |
| `high-bandwidth-capacity-threshold-100__high-bandwidth-demotion-saturation-bps-100` | `high-bandwidth-regression` | `medium` | provider bandwidth saturation occurred |

## Best Observed Run

`high-bandwidth-capacity-threshold-100__high-bandwidth-demotion-saturation-bps-100` is the best observed run under the current ordering: zero data loss first, then highest retrieval success, then fewer unavailable reads, capacity violations, negative-P&L providers, and repair backoffs.

This is not an automatic policy choice. It is the run humans should inspect first when deciding which parameter set deserves keeper or e2e implementation work.

## Review Questions

- Which changed parameter plausibly caused the largest movement in availability, repair pressure, and provider economics?
- Did any run improve availability by hiding economic distress, capacity over-assignment, or repair backlog?
- Are unavailable reads explicitly allowed by the scenario contract, and did modeled data loss remain zero?
- Which parameter set should become the baseline for the next keeper/e2e planning slice?
