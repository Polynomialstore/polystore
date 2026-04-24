# Policy Simulation Sensitivity Sweep

This report aggregates `3` completed simulator run output directories. It does not rerun the simulator or mutate raw run artifacts.

## Executive Summary

- Mode: `Sensitivity Sweep`.
- Runs analyzed: `3`.
- Varied parameters: `1`.
- Critical-risk runs: `0`.
- Assertion failures: `0`.
- Runs with modeled data loss: `0`.
- Decision posture: safe to use this report for policy-parameter review before keeper work.

## Run Matrix

| Run | Scenario | Seed | Risk | Assertions | Success | Unavailable Reads | Data Loss | Repairs | Backoffs | Saturated | Negative P&L | Storage Price | Retrieval Price |
|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `provider-online-probability-min-0p975` | `large-scale-regional-stress` | `29` | `medium` | `PASS` | 99.21% | 1132 | 0 | 4208/3540 | 14228 | 17494 | 0 | 0.4407 | 0.0243 |
| `provider-online-probability-min-0p985` | `large-scale-regional-stress` | `29` | `medium` | `PASS` | 99.26% | 1065 | 0 | 3624/3050 | 12436 | 15482 | 4 | 0.4407 | 0.0243 |
| `provider-online-probability-min-0p995` | `large-scale-regional-stress` | `29` | `medium` | `PASS` | 99.52% | 697 | 0 | 1947/1805 | 12263 | 12704 | 1 | 0.4407 | 0.0243 |

## Key Metric Ranges

| Metric | Min | Max | Delta | Mean | Review Meaning |
|---|---:|---:|---:|---:|---|
| `success_rate` | 0.992139 | 0.995160 | 0.003021 | 0.993301 | Primary availability outcome; should not regress silently. |
| `unavailable_reads` | 697.000000 | 1132.000000 | 435.000000 | 964.666667 | Temporary user-facing misses; allowed only in explicit stress contracts. |
| `data_loss_events` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Durability invariant; non-zero values block graduation. |
| `reward_coverage` | 0.955321 | 0.966307 | 0.010986 | 0.960934 | Shows whether compliant responsibility remains economically recognized. |
| `repairs_started` | 1947.000000 | 4208.000000 | 2261.000000 | 3259.666667 | Detection and repair activation pressure. |
| `repairs_ready` | 1805.000000 | 3540.000000 | 1735.000000 | 2798.333333 | Review this metric against the scenario contract. |
| `repairs_completed` | 1805.000000 | 3540.000000 | 1735.000000 | 2798.333333 | Healing throughput under the parameter set. |
| `repair_attempts` | 14210.000000 | 18436.000000 | 4226.000000 | 16235.333333 | Repair retry pressure before starts or backoffs. |
| `repair_backoffs` | 12263.000000 | 14228.000000 | 1965.000000 | 12975.666667 | Replacement capacity or repair-start bottlenecks. |
| `repair_cooldowns` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retry cooldowns that intentionally throttle repair churn. |
| `repair_attempt_caps` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Per-slot attempt caps hit before a replacement could start. |
| `high_bandwidth_promotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Measured provider capability promotions. |
| `high_bandwidth_demotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Capability demotions after performance regression. |
| `high_bandwidth_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Final provider count eligible for high-bandwidth routing. |
| `high_bandwidth_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Serves attributed to high-bandwidth providers. |
| `hot_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hot-service demand exercised by the run. |
| `hot_high_bandwidth_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hot retrieval serves handled by promoted high-bandwidth providers. |
| `max_operator_assignment_share_bps` | 12.000000 | 13.000000 | 1.000000 | 12.666667 | Worst observed assignment share of any operator across epochs. |
| `top_operator_assignment_share_bps` | 12.000000 | 13.000000 | 1.000000 | 12.666667 | Final assignment share of the largest operator. |
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
| `new_deal_latent_requests` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deal_requests` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deals_accepted` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deals_suppressed_price` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deals_rejected_price` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deals_rejected_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deal_acceptance_rate` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `new_deal_latent_acceptance_rate` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `suspect_slots` | 228.000000 | 461.000000 | 233.000000 | 350.000000 | Soft warning slot-epochs before thresholded delinquency. |
| `delinquent_slots` | 19476.000000 | 29466.000000 | 9990.000000 | 24858.666667 | Threshold-crossed slot-epochs that should be visible to operators. |
| `quota_misses` | 13950.000000 | 18214.000000 | 4264.000000 | 16006.000000 | Soft liveness evidence generated by the run. |
| `invalid_proofs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hard-fault evidence generated by the run. |
| `paid_corrupt_bytes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Payment safety invariant; should remain zero. |
| `audit_budget_demand` | 276.010000 | 369.380000 | 93.370000 | 319.590000 | Total audit work implied by soft-failure evidence and carried backlog. |
| `audit_budget_spent` | 276.010000 | 360.630000 | 84.620000 | 316.673333 | Audit budget actually consumed under the configured cap. |
| `audit_budget_backlog` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Unmet audit demand remaining at run end. |
| `audit_budget_exhausted` | 0.000000 | 1.000000 | 1.000000 | 0.333333 | Epochs where audit demand exceeded available budget. |
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
| `providers_negative_pnl` | 0.000000 | 4.000000 | 4.000000 | 1.666667 | Market sustainability and churn pressure. |
| `saturated_responses` | 12704.000000 | 17494.000000 | 4790.000000 | 15226.666667 | Provider bandwidth bottleneck signal. |
| `providers_over_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Placement/capacity invariant; should remain zero. |
| `final_storage_utilization_bps` | 5539.000000 | 5707.000000 | 168.000000 | 5605.000000 | Supply utilization against modeled capacity. |
| `final_storage_price` | 0.440685 | 0.440685 | 0.000000 | 0.440685 | Storage-controller endpoint under this run. |
| `final_retrieval_price` | 0.024267 | 0.024267 | 0.000000 | 0.024267 | Retrieval-controller endpoint under this run. |
| `provider_pnl` | 16911.858963 | 17168.862866 | 257.003903 | 17023.892538 | Aggregate provider economics; inspect distribution before deciding. |

## Varied Parameters

| Parameter | Values |
|---|---|
| `provider_online_probability_min` | `0.975`, `0.985`, `0.995` |

## Parameter Sensitivity

| Parameter | Value | Runs | Avg Success | Total Unavailable | Total Data Loss | Avg Backoffs | Avg Negative P&L | Avg Final Storage Price |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `provider_online_probability_min` | `0.975` | 1 | 99.21% | 1132 | 0 | 14228 | 0 | 0.4407 |
| `provider_online_probability_min` | `0.985` | 1 | 99.26% | 1065 | 0 | 12436 | 4 | 0.4407 |
| `provider_online_probability_min` | `0.995` | 1 | 99.52% | 697 | 0 | 12263 | 1 | 0.4407 |

## High-Risk Runs

| Run | Scenario | Risk | Reasons |
|---|---|---|---|
| `provider-online-probability-min-0p995` | `large-scale-regional-stress` | `medium` | temporary unavailable reads are present in an allowed stress fixture; repair coordination backoffs occurred; provider bandwidth saturation occurred; some providers ended with negative modeled P&L |
| `provider-online-probability-min-0p985` | `large-scale-regional-stress` | `medium` | temporary unavailable reads are present in an allowed stress fixture; repair coordination backoffs occurred; provider bandwidth saturation occurred; some providers ended with negative modeled P&L |
| `provider-online-probability-min-0p975` | `large-scale-regional-stress` | `medium` | temporary unavailable reads are present in an allowed stress fixture; repair coordination backoffs occurred; provider bandwidth saturation occurred |

## Best Observed Run

`provider-online-probability-min-0p995` is the best observed run under the current ordering: zero data loss first, then highest retrieval success, then fewer unavailable reads, capacity violations, negative-P&L providers, and repair backoffs.

This is not an automatic policy choice. It is the run humans should inspect first when deciding which parameter set deserves keeper or e2e implementation work.

## Review Questions

- Which changed parameter plausibly caused the largest movement in availability, repair pressure, and provider economics?
- Did any run improve availability by hiding economic distress, capacity over-assignment, or repair backlog?
- Are unavailable reads explicitly allowed by the scenario contract, and did modeled data loss remain zero?
- Which parameter set should become the baseline for the next keeper/e2e planning slice?
