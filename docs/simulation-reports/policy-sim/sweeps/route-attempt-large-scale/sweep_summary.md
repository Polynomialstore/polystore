# Policy Simulation Sensitivity Sweep

This report aggregates `3` completed simulator run output directories. It does not rerun the simulator or mutate raw run artifacts.

## Executive Summary

- Mode: `Sensitivity Sweep`.
- Runs analyzed: `3`.
- Varied parameters: `1`.
- Critical-risk runs: `1`.
- Assertion failures: `1`.
- Runs with modeled data loss: `0`.
- Decision posture: do not promote parameters from failing assertion contracts without explicit human approval.

## Run Matrix

| Run | Scenario | Seed | Risk | Assertions | Success | Unavailable Reads | Data Loss | Repairs | Backoffs | Saturated | Negative P&L | Storage Price | Retrieval Price |
|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `route-attempt-limit-12` | `large-scale-regional-stress` | `29` | `medium` | `PASS` | 99.26% | 1065 | 0 | 3624/3050 | 12436 | 15482 | 4 | 0.4407 | 0.0243 |
| `route-attempt-limit-16` | `large-scale-regional-stress` | `29` | `medium` | `PASS` | 99.26% | 1065 | 0 | 3624/3050 | 12436 | 15482 | 4 | 0.4407 | 0.0243 |
| `route-attempt-limit-8` | `large-scale-regional-stress` | `29` | `critical` | `FAIL` | 73.46% | 38214 | 0 | 781/735 | 10140 | 9483 | 0 | 0.4407 | 0.0243 |

## Key Metric Ranges

| Metric | Min | Max | Delta | Mean | Review Meaning |
|---|---:|---:|---:|---:|---|
| `success_rate` | 0.734625 | 0.992604 | 0.257979 | 0.906611 | Primary availability outcome; should not regress silently. |
| `unavailable_reads` | 1065.000000 | 38214.000000 | 37149.000000 | 13448.000000 | Temporary user-facing misses; allowed only in explicit stress contracts. |
| `data_loss_events` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Durability invariant; non-zero values block graduation. |
| `reward_coverage` | 0.960783 | 0.961174 | 0.000391 | 0.961044 | Shows whether compliant responsibility remains economically recognized. |
| `repairs_started` | 781.000000 | 3624.000000 | 2843.000000 | 2676.333333 | Detection and repair activation pressure. |
| `repairs_ready` | 735.000000 | 3050.000000 | 2315.000000 | 2278.333333 | Review this metric against the scenario contract. |
| `repairs_completed` | 735.000000 | 3050.000000 | 2315.000000 | 2278.333333 | Healing throughput under the parameter set. |
| `repair_attempts` | 10921.000000 | 16060.000000 | 5139.000000 | 14347.000000 | Repair retry pressure before starts or backoffs. |
| `repair_backoffs` | 10140.000000 | 12436.000000 | 2296.000000 | 11670.666667 | Replacement capacity or repair-start bottlenecks. |
| `repair_cooldowns` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retry cooldowns that intentionally throttle repair churn. |
| `repair_attempt_caps` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Per-slot attempt caps hit before a replacement could start. |
| `high_bandwidth_promotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Measured provider capability promotions. |
| `high_bandwidth_demotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Capability demotions after performance regression. |
| `high_bandwidth_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Final provider count eligible for high-bandwidth routing. |
| `high_bandwidth_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Serves attributed to high-bandwidth providers. |
| `hot_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hot-service demand exercised by the run. |
| `hot_high_bandwidth_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hot retrieval serves handled by promoted high-bandwidth providers. |
| `max_operator_assignment_share_bps` | 11.000000 | 13.000000 | 2.000000 | 12.333333 | Worst observed assignment share of any operator across epochs. |
| `top_operator_assignment_share_bps` | 11.000000 | 13.000000 | 2.000000 | 12.333333 | Final assignment share of the largest operator. |
| `top_operator_provider_share_bps` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Provider identity share controlled by the largest operator. |
| `max_operator_deal_slots` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Maximum same-operator slots in any one deal. |
| `operator_deal_cap_violations` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deal/operator groups above the configured cap. |
| `platinum_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `gold_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `silver_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `fail_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `average_latency_ms` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `performance_fail_rate` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `performance_reward_paid` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `retrieval_latent_attempts` | 144000.000000 | 144000.000000 | 0.000000 | 144000.000000 | Baseline read demand before demand-shock multipliers. |
| `retrieval_demand_shock_active` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Epochs where read-demand shock multipliers were active. |
| `max_retrieval_demand_multiplier_bps` | 10000.000000 | 10000.000000 | 0.000000 | 10000.000000 | Peak modeled read-demand multiplier. |
| `new_deal_latent_requests` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deal_requests` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deals_accepted` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deals_suppressed_price` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deals_rejected_price` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deals_rejected_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deal_acceptance_rate` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deal_latent_acceptance_rate` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `suspect_slots` | 361.000000 | 5906.000000 | 5545.000000 | 2209.333333 | Soft warning slot-epochs before thresholded delinquency. |
| `delinquent_slots` | 13109.000000 | 25634.000000 | 12525.000000 | 21459.000000 | Threshold-crossed slot-epochs that should be visible to operators. |
| `quota_misses` | 15854.000000 | 16827.000000 | 973.000000 | 16178.333333 | Soft liveness evidence generated by the run. |
| `invalid_proofs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hard-fault evidence generated by the run. |
| `paid_corrupt_bytes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Payment safety invariant; should remain zero. |
| `audit_budget_demand` | 168.270000 | 313.380000 | 145.110000 | 265.010000 | Total audit work implied by soft-failure evidence and carried backlog. |
| `audit_budget_spent` | 168.270000 | 313.380000 | 145.110000 | 265.010000 | Audit budget actually consumed under the configured cap. |
| `audit_budget_backlog` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Unmet audit demand remaining at run end. |
| `audit_budget_exhausted` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Epochs where audit demand exceeded available budget. |
| `evidence_spam_claims` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Low-quality deputy evidence submissions in the spam fixture. |
| `evidence_spam_convictions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Spam claims that still reached conviction and earned bounty. |
| `evidence_spam_bond_burned` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Evidence bond burned for unconvicted spam claims. |
| `evidence_spam_bounty_paid` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Conviction-gated bounty paid to the evidence spammer. |
| `evidence_spam_net_gain` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Spammer net economics; positive values indicate an abuse risk. |
| `provider_cost_shock_active` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Epochs where external provider cost pressure was active. |
| `max_provider_cost_shocked_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Largest provider population affected by cost shock in any epoch. |
| `max_provider_cost_shock_fixed_multiplier_bps` | 10000.000000 | 10000.000000 | 0.000000 | 10000.000000 | Peak modeled fixed-cost multiplier during cost shock. |
| `max_provider_cost_shock_storage_multiplier_bps` | 10000.000000 | 10000.000000 | 0.000000 | 10000.000000 | Peak modeled storage-cost multiplier during cost shock. |
| `max_provider_cost_shock_bandwidth_multiplier_bps` | 10000.000000 | 10000.000000 | 0.000000 | 10000.000000 | Peak modeled bandwidth-cost multiplier during cost shock. |
| `providers_negative_pnl` | 0.000000 | 4.000000 | 4.000000 | 2.666667 | Market sustainability and churn pressure. |
| `saturated_responses` | 9483.000000 | 15482.000000 | 5999.000000 | 13482.333333 | Provider bandwidth bottleneck signal. |
| `providers_over_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Placement/capacity invariant; should remain zero. |
| `final_storage_utilization_bps` | 5569.000000 | 5738.000000 | 169.000000 | 5625.333333 | Supply utilization against modeled capacity. |
| `final_storage_price` | 0.440685 | 0.440685 | 0.000000 | 0.440685 | Storage-controller endpoint under this run. |
| `final_retrieval_price` | 0.024267 | 0.024267 | 0.000000 | 0.024267 | Retrieval-controller endpoint under this run. |
| `storage_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Storage price controller direction changes across the run. |
| `retrieval_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval price controller direction changes across the run. |
| `provider_pnl` | 12925.930715 | 16990.955784 | 4065.025069 | 15635.947428 | Aggregate provider economics; inspect distribution before deciding. |

## Varied Parameters

| Parameter | Values |
|---|---|
| `route_attempt_limit` | `12`, `16`, `8` |

## Parameter Sensitivity

| Parameter | Value | Runs | Avg Success | Total Unavailable | Total Data Loss | Avg Backoffs | Avg Negative P&L | Avg Final Storage Price |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `route_attempt_limit` | `12` | 1 | 99.26% | 1065 | 0 | 12436 | 4 | 0.4407 |
| `route_attempt_limit` | `16` | 1 | 99.26% | 1065 | 0 | 12436 | 4 | 0.4407 |
| `route_attempt_limit` | `8` | 1 | 73.46% | 38214 | 0 | 10140 | 0 | 0.4407 |

## High-Risk Runs

| Run | Scenario | Risk | Reasons |
|---|---|---|---|
| `route-attempt-limit-8` | `large-scale-regional-stress` | `critical` | 1 assertion contract failures; temporary unavailable reads are present in an allowed stress fixture; retrieval success fell below 99%; repair coordination backoffs occurred; provider bandwidth saturation occurred |
| `route-attempt-limit-16` | `large-scale-regional-stress` | `medium` | temporary unavailable reads are present in an allowed stress fixture; repair coordination backoffs occurred; provider bandwidth saturation occurred; some providers ended with negative modeled P&L |
| `route-attempt-limit-12` | `large-scale-regional-stress` | `medium` | temporary unavailable reads are present in an allowed stress fixture; repair coordination backoffs occurred; provider bandwidth saturation occurred; some providers ended with negative modeled P&L |

## Best Observed Run

`route-attempt-limit-12` is the best observed run under the current ordering: zero data loss first, then highest retrieval success, then fewer unavailable reads, capacity violations, negative-P&L providers, and repair backoffs.

This is not an automatic policy choice. It is the run humans should inspect first when deciding which parameter set deserves keeper or e2e implementation work.

## Review Questions

- Which changed parameter plausibly caused the largest movement in availability, repair pressure, and provider economics?
- Did any run improve availability by hiding economic distress, capacity over-assignment, or repair backlog?
- Are unavailable reads explicitly allowed by the scenario contract, and did modeled data loss remain zero?
- Which parameter set should become the baseline for the next keeper/e2e planning slice?
