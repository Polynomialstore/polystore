# Policy Simulation Sensitivity Sweep

This report aggregates `7` completed simulator run output directories. It does not rerun the simulator or mutate raw run artifacts.

## Executive Summary

- Mode: `Sensitivity Sweep`.
- Runs analyzed: `7`.
- Varied parameters: `2`.
- Critical-risk runs: `0`.
- Assertion failures: `0`.
- Runs with modeled data loss: `0`.
- Decision posture: safe to use this report for policy-parameter review before keeper work.

## Run Matrix

| Run | Scenario | Seed | Risk | Assertions | Success | Unavailable Reads | Data Loss | Repairs | Backoffs | Saturated | Negative P&L | Storage Price | Retrieval Price |
|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `baseline-churn-base-repair` | `provider-economic-churn` | `91` | `medium` | `PASS` | 100.00% | 0 | 0 | 48/48 | 0 | 0 | 8 | 1.3121 | 0.0131 |
| `burst-churn-constrained-repair` | `provider-economic-churn` | `91` | `high` | `PASS` | 98.08% | 23 | 0 | 48/48 | 48 | 0 | 8 | 1.3121 | 0.0131 |
| `burst-churn-wide-repair` | `provider-economic-churn` | `91` | `high` | `PASS` | 98.75% | 15 | 0 | 48/48 | 16 | 0 | 8 | 1.3121 | 0.0131 |
| `fast-churn-constrained-repair` | `provider-economic-churn` | `91` | `high` | `PASS` | 97.58% | 29 | 0 | 40/40 | 112 | 0 | 8 | 1.3121 | 0.0131 |
| `fast-churn-wide-repair` | `provider-economic-churn` | `91` | `medium` | `PASS` | 100.00% | 0 | 0 | 48/48 | 0 | 0 | 8 | 1.3121 | 0.0131 |
| `slow-churn-base-repair` | `provider-economic-churn` | `91` | `medium` | `PASS` | 100.00% | 0 | 0 | 42/35 | 0 | 0 | 8 | 1.3121 | 0.0131 |
| `slow-churn-constrained-repair` | `provider-economic-churn` | `91` | `medium` | `PASS` | 99.67% | 4 | 0 | 28/24 | 56 | 0 | 8 | 1.3121 | 0.0131 |

## Key Metric Ranges

| Metric | Min | Max | Delta | Mean | Review Meaning |
|---|---:|---:|---:|---:|---|
| `success_rate` | 0.975833 | 1.000000 | 0.024167 | 0.991548 | Primary availability outcome; should not regress silently. |
| `unavailable_reads` | 0.000000 | 29.000000 | 29.000000 | 10.142857 | Temporary user-facing misses; allowed only in explicit stress contracts. |
| `data_loss_events` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Durability invariant; non-zero values block graduation. |
| `reward_coverage` | 0.970451 | 0.991837 | 0.021386 | 0.985166 | Shows whether compliant responsibility remains economically recognized. |
| `repairs_started` | 28.000000 | 48.000000 | 20.000000 | 43.142857 | Detection and repair activation pressure. |
| `repairs_ready` | 24.000000 | 48.000000 | 24.000000 | 41.571429 | Review this metric against the scenario contract. |
| `repairs_completed` | 24.000000 | 48.000000 | 24.000000 | 41.571429 | Healing throughput under the parameter set. |
| `repair_attempts` | 42.000000 | 128.000000 | 86.000000 | 71.142857 | Repair retry pressure before starts or backoffs. |
| `repair_backoffs` | 0.000000 | 112.000000 | 112.000000 | 33.142857 | Replacement capacity or repair-start bottlenecks. |
| `repair_cooldowns` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retry cooldowns that intentionally throttle repair churn. |
| `repair_attempt_caps` | 0.000000 | 24.000000 | 24.000000 | 5.142857 | Per-slot attempt caps hit before a replacement could start. |
| `repair_timeouts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Pending replacement providers that failed readiness before timeout. |
| `high_bandwidth_promotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Measured provider capability promotions. |
| `high_bandwidth_demotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Capability demotions after performance regression. |
| `high_bandwidth_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Final provider count eligible for high-bandwidth routing. |
| `high_bandwidth_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Serves attributed to high-bandwidth providers. |
| `hot_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hot-service demand exercised by the run. |
| `hot_high_bandwidth_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hot retrieval serves handled by promoted high-bandwidth providers. |
| `max_operator_assignment_share_bps` | 160.000000 | 185.000000 | 25.000000 | 181.000000 | Worst observed assignment share of any operator across epochs. |
| `top_operator_assignment_share_bps` | 160.000000 | 185.000000 | 25.000000 | 181.000000 | Final assignment share of the largest operator. |
| `top_operator_provider_share_bps` | 125.000000 | 125.000000 | 0.000000 | 125.000000 | Provider identity share controlled by the largest operator. |
| `max_operator_deal_slots` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Maximum same-operator slots in any one deal. |
| `operator_deal_cap_violations` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deal/operator groups above the configured cap. |
| `platinum_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `gold_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `silver_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `fail_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `average_latency_ms` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `performance_fail_rate` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `performance_reward_paid` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `retrieval_latent_attempts` | 1200.000000 | 1200.000000 | 0.000000 | 1200.000000 | Baseline read demand before demand-shock multipliers. |
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
| `suspect_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Soft warning slot-epochs before thresholded delinquency. |
| `delinquent_slots` | 46.000000 | 152.000000 | 106.000000 | 76.857143 | Threshold-crossed slot-epochs that should be visible to operators. |
| `quota_misses` | 42.000000 | 152.000000 | 110.000000 | 76.285714 | Soft liveness evidence generated by the run. |
| `invalid_proofs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hard-fault evidence generated by the run. |
| `paid_corrupt_bytes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Payment safety invariant; should remain zero. |
| `audit_budget_demand` | 0.375000 | 1.150000 | 0.775000 | 0.601429 | Total audit work implied by soft-failure evidence and carried backlog. |
| `audit_budget_spent` | 0.375000 | 1.150000 | 0.775000 | 0.601429 | Audit budget actually consumed under the configured cap. |
| `audit_budget_backlog` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Unmet audit demand remaining at run end. |
| `audit_budget_exhausted` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Epochs where audit demand exceeded available budget. |
| `evidence_spam_claims` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Low-quality deputy evidence submissions in the spam fixture. |
| `evidence_spam_convictions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Spam claims that still reached conviction and earned bounty. |
| `evidence_spam_bond_burned` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Evidence bond burned for unconvicted spam claims. |
| `evidence_spam_bounty_paid` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Conviction-gated bounty paid to the evidence spammer. |
| `evidence_spam_net_gain` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Spammer net economics; positive values indicate an abuse risk. |
| `provider_cost_shock_active` | 10.000000 | 10.000000 | 0.000000 | 10.000000 | Epochs where external provider cost pressure was active. |
| `max_provider_cost_shocked_providers` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Largest provider population affected by cost shock in any epoch. |
| `max_provider_cost_shock_fixed_multiplier_bps` | 80000.000000 | 80000.000000 | 0.000000 | 80000.000000 | Peak modeled fixed-cost multiplier during cost shock. |
| `max_provider_cost_shock_storage_multiplier_bps` | 80000.000000 | 80000.000000 | 0.000000 | 80000.000000 | Peak modeled storage-cost multiplier during cost shock. |
| `max_provider_cost_shock_bandwidth_multiplier_bps` | 40000.000000 | 40000.000000 | 0.000000 | 40000.000000 | Peak modeled bandwidth-cost multiplier during cost shock. |
| `provider_churn_events` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Provider exits executed by the economic churn policy. |
| `churned_providers` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Providers marked as exited by run end. |
| `provider_entries` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Reserve providers admitted into probation by the supply-entry policy. |
| `provider_probation_promotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Probationary providers promoted into assignment-eligible active supply. |
| `provider_underbonded_repairs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Repairs started because a provider lacked required bond headroom. |
| `final_underbonded_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Providers below the configured bond requirement at run end. |
| `max_underbonded_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak providers below the configured bond requirement. |
| `final_underbonded_assigned_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Assigned slots still held by underbonded providers at run end. |
| `max_underbonded_assigned_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak assigned slots held by underbonded providers. |
| `final_provider_bond_deficit` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Run-end aggregate provider bond deficit under configured collateral rules. |
| `max_provider_bond_deficit` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak aggregate provider bond deficit under configured collateral rules. |
| `reserve_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Providers still outside normal placement as reserve supply. |
| `probationary_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Providers in onboarding probation and not yet eligible for normal placement. |
| `entered_active_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Providers that entered from reserve and are active by run end. |
| `churn_pressure_provider_epochs` | 8.000000 | 36.000000 | 28.000000 | 18.857143 | Provider-epochs below the churn threshold. |
| `max_churn_pressure_providers` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Peak providers simultaneously eligible for churn. |
| `final_active_provider_capacity` | 854.000000 | 854.000000 | 0.000000 | 854.000000 | Provider capacity remaining after economic exits. |
| `final_exited_provider_capacity` | 102.000000 | 102.000000 | 0.000000 | 102.000000 | Provider capacity removed by economic exits. |
| `final_reserve_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity still held outside normal placement as reserve supply. |
| `final_probationary_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity in onboarding probation at run end. |
| `max_churned_assigned_slots` | 13.000000 | 48.000000 | 35.000000 | 36.142857 | Peak assigned slots on churned providers before repair catches up. |
| `providers_negative_pnl` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Market sustainability and churn pressure. |
| `saturated_responses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider bandwidth bottleneck signal. |
| `providers_over_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Placement/capacity invariant; should remain zero. |
| `final_storage_utilization_bps` | 4976.000000 | 5058.000000 | 82.000000 | 5039.571429 | Supply utilization against modeled capacity. |
| `final_storage_price` | 1.312087 | 1.312087 | 0.000000 | 1.312087 | Storage-controller endpoint under this run. |
| `final_retrieval_price` | 0.013121 | 0.013121 | 0.000000 | 0.013121 | Retrieval-controller endpoint under this run. |
| `storage_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Storage price controller direction changes across the run. |
| `retrieval_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval price controller direction changes across the run. |
| `provider_pnl` | 197.571625 | 213.560499 | 15.988874 | 207.116997 | Aggregate provider economics; inspect distribution before deciding. |

## Varied Parameters

| Parameter | Values |
|---|---|
| `max_repairs_started_per_epoch` | `16`, `32`, `4`, `8` |
| `provider_churn_max_providers_per_epoch` | `1`, `2`, `4`, `8` |

## Parameter Sensitivity

| Parameter | Value | Runs | Avg Success | Total Unavailable | Total Data Loss | Avg Backoffs | Avg Negative P&L | Avg Final Storage Price |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `max_repairs_started_per_epoch` | `16` | 3 | 99.36% | 23 | 0 | 16 | 8 | 1.3121 |
| `max_repairs_started_per_epoch` | `32` | 2 | 99.38% | 15 | 0 | 8 | 8 | 1.3121 |
| `max_repairs_started_per_epoch` | `4` | 1 | 99.67% | 4 | 0 | 56 | 8 | 1.3121 |
| `max_repairs_started_per_epoch` | `8` | 1 | 97.58% | 29 | 0 | 112 | 8 | 1.3121 |
| `provider_churn_max_providers_per_epoch` | `1` | 2 | 99.83% | 4 | 0 | 28 | 8 | 1.3121 |
| `provider_churn_max_providers_per_epoch` | `2` | 1 | 100.00% | 0 | 0 | 0 | 8 | 1.3121 |
| `provider_churn_max_providers_per_epoch` | `4` | 2 | 98.79% | 29 | 0 | 56 | 8 | 1.3121 |
| `provider_churn_max_providers_per_epoch` | `8` | 2 | 98.42% | 38 | 0 | 32 | 8 | 1.3121 |

## High-Risk Runs

| Run | Scenario | Risk | Reasons |
|---|---|---|---|
| `fast-churn-constrained-repair` | `provider-economic-churn` | `high` | temporary unavailable reads are present in an allowed stress fixture; retrieval success fell below 99%; repair coordination backoffs occurred; some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `burst-churn-wide-repair` | `provider-economic-churn` | `high` | temporary unavailable reads are present in an allowed stress fixture; retrieval success fell below 99%; repair coordination backoffs occurred; some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `burst-churn-constrained-repair` | `provider-economic-churn` | `high` | temporary unavailable reads are present in an allowed stress fixture; retrieval success fell below 99%; repair coordination backoffs occurred; some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `slow-churn-constrained-repair` | `provider-economic-churn` | `medium` | temporary unavailable reads are present in an allowed stress fixture; repair coordination backoffs occurred; some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `slow-churn-base-repair` | `provider-economic-churn` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `fast-churn-wide-repair` | `provider-economic-churn` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `baseline-churn-base-repair` | `provider-economic-churn` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity |

## Best Observed Run

`baseline-churn-base-repair` is the best observed run under the current ordering: zero data loss first, then highest retrieval success, then fewer unavailable reads, capacity violations, negative-P&L providers, and repair backoffs.

This is not an automatic policy choice. It is the run humans should inspect first when deciding which parameter set deserves keeper or e2e implementation work.

## Review Questions

- Which changed parameter plausibly caused the largest movement in availability, repair pressure, and provider economics?
- Did any run improve availability by hiding economic distress, capacity over-assignment, or repair backlog?
- Are unavailable reads explicitly allowed by the scenario contract, and did modeled data loss remain zero?
- Which parameter set should become the baseline for the next keeper/e2e planning slice?
