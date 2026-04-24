# Policy Simulation Sensitivity Sweep

This report aggregates `5` completed simulator run output directories. It does not rerun the simulator or mutate raw run artifacts.

## Executive Summary

- Mode: `Sensitivity Sweep`.
- Runs analyzed: `5`.
- Varied parameters: `3`.
- Critical-risk runs: `0`.
- Assertion failures: `0`.
- Runs with modeled data loss: `0`.
- Decision posture: safe to use this report for policy-parameter review before keeper work.

## Run Matrix

| Run | Scenario | Seed | Risk | Assertions | Success | Unavailable Reads | Expired Reads | Closed Reads | Data Loss | Repairs | Backoffs | Saturated | Negative P&L | Storage Price | Retrieval Price |
|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `baseline-repair` | `sustained-non-response` | `32` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 6/6 | 0 | 0 | 1 | 1.0000 | 0.0100 |
| `fast-threshold1-repair` | `sustained-non-response` | `32` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 6/6 | 0 | 0 | 1 | 1.0000 | 0.0100 |
| `long-repair-window` | `sustained-non-response` | `32` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 6/6 | 0 | 0 | 1 | 1.0000 | 0.0100 |
| `readiness-timeout-unsafe` | `sustained-non-response` | `32` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 18/0 | 0 | 0 | 1 | 1.0000 | 0.0100 |
| `slow-threshold6-still-repairs` | `sustained-non-response` | `32` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 6/6 | 0 | 0 | 1 | 1.0000 | 0.0100 |

## Key Metric Ranges

| Metric | Min | Max | Delta | Mean | Review Meaning |
|---|---:|---:|---:|---:|---|
| `success_rate` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Primary availability outcome; should not regress silently. |
| `unavailable_reads` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Temporary user-facing misses; allowed only in explicit stress contracts. |
| `offline_responses` | 18.000000 | 47.000000 | 29.000000 | 23.800000 | Provider responses missed because a selected provider was offline. |
| `expired_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Post-expiry read requests rejected as expired content, not live availability misses. |
| `closed_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Post-close read requests rejected as closed content, not live availability misses. |
| `data_loss_events` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Durability invariant; non-zero values block graduation. |
| `reward_coverage` | 0.993671 | 0.997908 | 0.004237 | 0.997055 | Shows whether compliant responsibility remains economically recognized. |
| `reward_pool_minted` | 56.640000 | 57.360000 | 0.720000 | 57.120000 | Modeled base subsidy made available to active slots. |
| `reward_paid` | 56.520000 | 57.240000 | 0.720000 | 56.952000 | Base subsidy actually paid to reward-eligible slots. |
| `reward_burned` | 0.120000 | 0.360000 | 0.240000 | 0.168000 | Base subsidy withheld from non-compliant responsibility. |
| `repairs_started` | 6.000000 | 18.000000 | 12.000000 | 8.400000 | Detection and repair activation pressure. |
| `repairs_ready` | 0.000000 | 6.000000 | 6.000000 | 4.800000 | Review this metric against the scenario contract. |
| `repairs_completed` | 0.000000 | 6.000000 | 6.000000 | 4.800000 | Healing throughput under the parameter set. |
| `repair_attempts` | 6.000000 | 18.000000 | 12.000000 | 8.400000 | Repair retry pressure before starts or backoffs. |
| `repair_backoffs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Replacement capacity or repair-start bottlenecks. |
| `repair_cooldowns` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retry cooldowns that intentionally throttle repair churn. |
| `repair_attempt_caps` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Per-slot attempt caps hit before a replacement could start. |
| `repair_timeouts` | 0.000000 | 18.000000 | 18.000000 | 3.600000 | Pending replacement providers that failed readiness before timeout. |
| `high_bandwidth_promotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Measured provider capability promotions. |
| `high_bandwidth_demotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Capability demotions after performance regression. |
| `high_bandwidth_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Final provider count eligible for high-bandwidth routing. |
| `high_bandwidth_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Serves attributed to high-bandwidth providers. |
| `hot_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hot-service demand exercised by the run. |
| `hot_high_bandwidth_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hot retrieval serves handled by promoted high-bandwidth providers. |
| `max_operator_assignment_share_bps` | 243.000000 | 272.000000 | 29.000000 | 248.800000 | Worst observed assignment share of any operator across epochs. |
| `top_operator_assignment_share_bps` | 208.000000 | 243.000000 | 35.000000 | 236.000000 | Final assignment share of the largest operator. |
| `top_operator_provider_share_bps` | 208.000000 | 208.000000 | 0.000000 | 208.000000 | Provider identity share controlled by the largest operator. |
| `max_operator_deal_slots` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Maximum same-operator slots in any one deal. |
| `operator_deal_cap_violations` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deal/operator groups above the configured cap. |
| `platinum_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Serves in the fastest latency tier. |
| `gold_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Serves in the middle positive latency tier. |
| `silver_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Serves in the low positive latency tier. |
| `fail_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Serves slower than the configured positive latency tiers. |
| `average_latency_ms` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Average modeled successful-service latency. |
| `performance_fail_rate` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Share of tiered serves that landed in the Fail tier. |
| `platinum_share` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Share of tiered serves that landed in the fastest performance tier. |
| `performance_reward_paid` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Tiered QoS rewards paid separately from baseline storage and retrieval settlement. |
| `storage_escrow_locked` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Storage escrow charged upfront for committed deals. |
| `storage_escrow_earned` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Storage escrow earned over modeled service epochs. |
| `storage_escrow_refunded` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Unearned storage escrow returned by deal close/refund. |
| `storage_escrow_outstanding` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Storage escrow still locked at run end. |
| `storage_fee_provider_payouts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Earned storage fees paid to eligible providers. |
| `storage_fee_burned` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Earned storage fees withheld from non-compliant slots. |
| `deals_closed` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deal close events executed across the run. |
| `deals_expired` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deal expiry events executed across the run. |
| `final_expired_deals` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deals expired by run end. |
| `final_open_deals` | 24.000000 | 24.000000 | 0.000000 | 24.000000 | Deals still active at run end. |
| `final_closed_deals` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deals closed by run end. |
| `retrieval_base_burned` | 0.800000 | 0.800000 | 0.000000 | 0.800000 | Base retrieval fees burned across live retrieval attempts. |
| `retrieval_variable_burned` | 3.200000 | 3.200000 | 0.000000 | 3.200000 | Variable retrieval fee burn withheld from provider payout. |
| `retrieval_provider_payouts` | 60.800000 | 60.800000 | 0.000000 | 60.800000 | Retrieval fees paid to providers for served slots. |
| `sponsored_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval attempts funded by requester/sponsor sessions. |
| `sponsored_retrieval_spent` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Total sponsored retrieval base plus variable spend. |
| `owner_retrieval_escrow_debited` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deal-owner escrow debited for non-sponsored retrievals. |
| `retrieval_wash_accounted_spend` | 0.800000 | 0.800000 | 0.000000 | 0.800000 | Explicit modeled requester, sponsor, or owner-funded retrieval spend counted against wash traffic. |
| `retrieval_wash_net_gain` | 60.000000 | 60.000000 | 0.000000 | 60.000000 | Worst-case colluding requester/provider net gain; positive values indicate wash abuse risk. |
| `retrieval_attempts` | 800.000000 | 800.000000 | 0.000000 | 800.000000 | Effective retrieval attempts after demand shock multipliers and inactive-content rejection. |
| `retrieval_latent_attempts` | 800.000000 | 800.000000 | 0.000000 | 800.000000 | Baseline read demand before demand-shock multipliers. |
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
| `elasticity_overlay_activations` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Temporary overflow routes activated by user-funded elasticity. |
| `elasticity_overlay_expired` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Temporary overflow routes removed by TTL. |
| `elasticity_overlay_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval serves completed by overlay routes. |
| `elasticity_overlay_rejections` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Overlay expansion rejected by spend cap or candidate selection. |
| `final_elasticity_overlay_active` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Run-end temporary overlay routes, including routes pending readiness. |
| `max_elasticity_overlay_active` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak temporary overlay routes, including routes pending readiness. |
| `final_elasticity_overlay_ready` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Run-end overlay routes ready for routing. |
| `max_elasticity_overlay_ready` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak overlay routes ready for routing. |
| `staged_upload_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `staged_upload_accepted` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `staged_upload_committed` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `staged_upload_rejections` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `staged_upload_cleaned` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `final_staged_upload_pending_generations` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `max_staged_upload_pending_generations` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `final_staged_upload_pending_mdus` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `max_staged_upload_pending_mdus` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `suspect_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Soft warning slot-epochs before thresholded delinquency. |
| `delinquent_slots` | 12.000000 | 54.000000 | 42.000000 | 27.600000 | Threshold-crossed slot-epochs that should be visible to operators. |
| `quota_misses` | 6.000000 | 18.000000 | 12.000000 | 8.400000 | Soft liveness evidence generated by the run. |
| `invalid_proofs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hard-fault evidence generated by the run. |
| `paid_corrupt_bytes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Payment safety invariant; should remain zero. |
| `provider_slashed` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `audit_budget_demand` | 0.060000 | 0.175000 | 0.115000 | 0.083000 | Total audit work implied by soft-failure evidence and carried backlog. |
| `audit_budget_spent` | 0.060000 | 0.175000 | 0.115000 | 0.083000 | Audit budget actually consumed under the configured cap. |
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
| `provider_churn_events` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider exits executed by the economic churn policy. |
| `churned_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Providers marked as exited by run end. |
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
| `max_reserve_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak providers still outside normal placement as reserve supply. |
| `max_probationary_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak providers simultaneously in onboarding probation. |
| `entered_active_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Providers that entered from reserve and are active by run end. |
| `churn_pressure_provider_epochs` | 9.000000 | 9.000000 | 0.000000 | 9.000000 | Provider-epochs below the churn threshold. |
| `max_churn_pressure_providers` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Peak providers simultaneously eligible for churn. |
| `final_active_provider_capacity` | 768.000000 | 768.000000 | 0.000000 | 768.000000 | Provider capacity remaining after economic exits. |
| `final_exited_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity removed by economic exits. |
| `final_reserve_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity still held outside normal placement as reserve supply. |
| `final_probationary_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity in onboarding probation at run end. |
| `max_churned_assigned_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak assigned slots on churned providers before repair catches up. |
| `providers_negative_pnl` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Market sustainability and churn pressure. |
| `saturated_responses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider bandwidth bottleneck signal. |
| `providers_over_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Placement/capacity invariant; should remain zero. |
| `final_storage_utilization_bps` | 3750.000000 | 3750.000000 | 0.000000 | 3750.000000 | Supply utilization against modeled capacity. |
| `min_storage_price` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Lowest storage price observed during the run. |
| `max_storage_price` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Highest storage price observed during the run. |
| `final_storage_price` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Storage-controller endpoint under this run. |
| `min_retrieval_price` | 0.010000 | 0.010000 | 0.000000 | 0.010000 | Lowest retrieval price observed during the run. |
| `max_retrieval_price` | 0.010000 | 0.010000 | 0.000000 | 0.010000 | Highest retrieval price observed during the run. |
| `final_retrieval_price` | 0.010000 | 0.010000 | 0.000000 | 0.010000 | Retrieval-controller endpoint under this run. |
| `storage_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Storage price controller direction changes across the run. |
| `retrieval_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval price controller direction changes across the run. |
| `provider_pnl` | 58.120000 | 58.840000 | 0.720000 | 58.552000 | Aggregate provider economics; inspect distribution before deciding. |

## Varied Parameters

| Parameter | Values |
|---|---|
| `evict_after_missed_epochs` | `1`, `2`, `6` |
| `repair_epochs` | `2`, `4`, `8` |
| `repair_pending_timeout_epochs` | `0`, `2` |

## Parameter Sensitivity

| Parameter | Value | Runs | Avg Success | Total Unavailable | Total Data Loss | Avg Backoffs | Avg Negative P&L | Avg Final Storage Price |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `evict_after_missed_epochs` | `1` | 1 | 100.00% | 0 | 0 | 0 | 1 | 1.0000 |
| `evict_after_missed_epochs` | `2` | 3 | 100.00% | 0 | 0 | 0 | 1 | 1.0000 |
| `evict_after_missed_epochs` | `6` | 1 | 100.00% | 0 | 0 | 0 | 1 | 1.0000 |
| `repair_epochs` | `2` | 3 | 100.00% | 0 | 0 | 0 | 1 | 1.0000 |
| `repair_epochs` | `4` | 1 | 100.00% | 0 | 0 | 0 | 1 | 1.0000 |
| `repair_epochs` | `8` | 1 | 100.00% | 0 | 0 | 0 | 1 | 1.0000 |
| `repair_pending_timeout_epochs` | `0` | 4 | 100.00% | 0 | 0 | 0 | 1 | 1.0000 |
| `repair_pending_timeout_epochs` | `2` | 1 | 100.00% | 0 | 0 | 0 | 1 | 1.0000 |

## High-Risk Runs

| Run | Scenario | Risk | Reasons |
|---|---|---|---|
| `slow-threshold6-still-repairs` | `sustained-non-response` | `medium` | some providers ended with negative modeled P&L |
| `readiness-timeout-unsafe` | `sustained-non-response` | `medium` | pending repair readiness timeouts occurred; some providers ended with negative modeled P&L |
| `long-repair-window` | `sustained-non-response` | `medium` | some providers ended with negative modeled P&L |
| `fast-threshold1-repair` | `sustained-non-response` | `medium` | some providers ended with negative modeled P&L |
| `baseline-repair` | `sustained-non-response` | `medium` | some providers ended with negative modeled P&L |

## Best Observed Run

`baseline-repair` is the best observed run under the current ordering: zero data loss first, then highest retrieval success, then fewer unavailable reads, capacity violations, negative-P&L providers, and repair backoffs.

This is not an automatic policy choice. It is the run humans should inspect first when deciding which parameter set deserves keeper or e2e implementation work.

## Review Questions

- Which changed parameter plausibly caused the largest movement in availability, repair pressure, and provider economics?
- Did any run improve availability by hiding economic distress, capacity over-assignment, or repair backlog?
- Are unavailable reads explicitly allowed by the scenario contract, and did modeled data loss remain zero?
- Which parameter set should become the baseline for the next keeper/e2e planning slice?
