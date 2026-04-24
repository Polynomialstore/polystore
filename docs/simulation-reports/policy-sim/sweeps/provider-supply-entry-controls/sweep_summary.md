# Policy Simulation Sensitivity Sweep

This report aggregates `8` completed simulator run output directories. It does not rerun the simulator or mutate raw run artifacts.

## Executive Summary

- Mode: `Sensitivity Sweep`.
- Runs analyzed: `8`.
- Varied parameters: `6`.
- Critical-risk runs: `0`.
- Assertion failures: `0`.
- Runs with modeled data loss: `0`.
- Decision posture: safe to use this report for policy-parameter review before keeper work.

## Run Matrix

| Run | Scenario | Seed | Risk | Assertions | Success | Unavailable Reads | Expired Reads | Closed Reads | Data Loss | Repairs | Backoffs | Saturated | Negative P&L | Storage Price | Retrieval Price |
|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `baseline-cap2-probation1` | `provider-supply-entry` | `97` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 60/60 | 0 | 0 | 8 | 0.7195 | 0.0138 |
| `delayed-entry-start` | `provider-supply-entry` | `97` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 60/59 | 0 | 0 | 8 | 0.7564 | 0.0138 |
| `immediate-promotion` | `provider-supply-entry` | `97` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 60/60 | 0 | 0 | 8 | 0.7195 | 0.0138 |
| `longer-probation` | `provider-supply-entry` | `97` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 60/59 | 0 | 0 | 8 | 0.7564 | 0.0138 |
| `price-triggered-entry` | `provider-supply-entry` | `97` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 60/59 | 0 | 0 | 8 | 0.9240 | 0.0138 |
| `slow-entry-cap1` | `provider-supply-entry` | `97` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 60/59 | 0 | 0 | 8 | 0.7195 | 0.0138 |
| `underfilled-short-window` | `provider-supply-entry` | `97` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 60/59 | 0 | 0 | 8 | 0.9240 | 0.0138 |
| `wide-entry-cap4` | `provider-supply-entry` | `97` | `medium` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 60/60 | 0 | 0 | 8 | 0.7195 | 0.0138 |

## Key Metric Ranges

| Metric | Min | Max | Delta | Mean | Review Meaning |
|---|---:|---:|---:|---:|---|
| `success_rate` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Primary availability outcome; should not regress silently. |
| `unavailable_reads` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Temporary user-facing misses; allowed only in explicit stress contracts. |
| `offline_responses` | 123.000000 | 146.000000 | 23.000000 | 135.375000 | Provider responses missed because a selected provider was offline. |
| `expired_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Post-expiry read requests rejected as expired content, not live availability misses. |
| `closed_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Post-close read requests rejected as closed content, not live availability misses. |
| `data_loss_events` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Durability invariant; non-zero values block graduation. |
| `reward_coverage` | 0.989975 | 0.989980 | 0.000005 | 0.989977 | Shows whether compliant responsibility remains economically recognized. |
| `reward_pool_minted` | 239.400000 | 239.520000 | 0.120000 | 239.445000 | Modeled base subsidy made available to active slots. |
| `reward_paid` | 237.000000 | 237.120000 | 0.120000 | 237.045000 | Base subsidy actually paid to reward-eligible slots. |
| `reward_burned` | 2.400000 | 2.400000 | 0.000000 | 2.400000 | Base subsidy withheld from non-compliant responsibility. |
| `repairs_started` | 60.000000 | 60.000000 | 0.000000 | 60.000000 | Detection and repair activation pressure. |
| `repairs_ready` | 59.000000 | 60.000000 | 1.000000 | 59.375000 | Review this metric against the scenario contract. |
| `repairs_completed` | 59.000000 | 60.000000 | 1.000000 | 59.375000 | Healing throughput under the parameter set. |
| `repair_attempts` | 60.000000 | 60.000000 | 0.000000 | 60.000000 | Repair retry pressure before starts or backoffs. |
| `repair_backoffs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Replacement capacity or repair-start bottlenecks. |
| `repair_cooldowns` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retry cooldowns that intentionally throttle repair churn. |
| `repair_attempt_caps` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Per-slot attempt caps hit before a replacement could start. |
| `repair_timeouts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Pending replacement providers that failed readiness before timeout. |
| `high_bandwidth_promotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Measured provider capability promotions. |
| `high_bandwidth_demotions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Capability demotions after performance regression. |
| `high_bandwidth_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Final provider count eligible for high-bandwidth routing. |
| `high_bandwidth_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Serves attributed to high-bandwidth providers. |
| `hot_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hot-service demand exercised by the run. |
| `hot_high_bandwidth_serves` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hot retrieval serves handled by promoted high-bandwidth providers. |
| `max_operator_assignment_share_bps` | 185.000000 | 207.000000 | 22.000000 | 198.750000 | Worst observed assignment share of any operator across epochs. |
| `top_operator_assignment_share_bps` | 185.000000 | 207.000000 | 22.000000 | 198.750000 | Final assignment share of the largest operator. |
| `top_operator_provider_share_bps` | 113.000000 | 113.000000 | 0.000000 | 113.000000 | Provider identity share controlled by the largest operator. |
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
| `final_open_deals` | 36.000000 | 36.000000 | 0.000000 | 36.000000 | Deals still active at run end. |
| `final_closed_deals` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deals closed by run end. |
| `retrieval_base_burned` | 1.540000 | 1.540000 | 0.000000 | 1.540000 | Base retrieval fees burned across live retrieval attempts. |
| `retrieval_variable_burned` | 7.268339 | 7.268339 | 0.000000 | 7.268339 | Variable retrieval fee burn withheld from provider payout. |
| `retrieval_provider_payouts` | 138.098446 | 138.098446 | 0.000000 | 138.098446 | Retrieval fees paid to providers for served slots. |
| `sponsored_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval attempts funded by requester/sponsor sessions. |
| `sponsored_retrieval_spent` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Total sponsored retrieval base plus variable spend. |
| `owner_retrieval_escrow_debited` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deal-owner escrow debited for non-sponsored retrievals. |
| `retrieval_wash_accounted_spend` | 1.540000 | 1.540000 | 0.000000 | 1.540000 | Explicit modeled requester, sponsor, or owner-funded retrieval spend counted against wash traffic. |
| `retrieval_wash_net_gain` | 136.558446 | 136.558446 | 0.000000 | 136.558446 | Worst-case colluding requester/provider net gain; positive values indicate wash abuse risk. |
| `retrieval_attempts` | 1540.000000 | 1540.000000 | 0.000000 | 1540.000000 | Effective retrieval attempts after demand shock multipliers and inactive-content rejection. |
| `retrieval_latent_attempts` | 1540.000000 | 1540.000000 | 0.000000 | 1540.000000 | Baseline read demand before demand-shock multipliers. |
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
| `delinquent_slots` | 60.000000 | 64.000000 | 4.000000 | 62.500000 | Threshold-crossed slot-epochs that should be visible to operators. |
| `quota_misses` | 60.000000 | 60.000000 | 0.000000 | 60.000000 | Soft liveness evidence generated by the run. |
| `invalid_proofs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hard-fault evidence generated by the run. |
| `paid_corrupt_bytes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Payment safety invariant; should remain zero. |
| `provider_slashed` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Review this metric against the scenario contract. |
| `audit_budget_demand` | 0.565000 | 0.570000 | 0.005000 | 0.566875 | Total audit work implied by soft-failure evidence and carried backlog. |
| `audit_budget_spent` | 0.565000 | 0.570000 | 0.005000 | 0.566875 | Audit budget actually consumed under the configured cap. |
| `audit_budget_backlog` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Unmet audit demand remaining at run end. |
| `audit_budget_exhausted` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Epochs where audit demand exceeded available budget. |
| `evidence_spam_claims` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Low-quality deputy evidence submissions in the spam fixture. |
| `evidence_spam_convictions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Spam claims that still reached conviction and earned bounty. |
| `evidence_spam_bond_burned` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Evidence bond burned for unconvicted spam claims. |
| `evidence_spam_bounty_paid` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Conviction-gated bounty paid to the evidence spammer. |
| `evidence_spam_net_gain` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Spammer net economics; positive values indicate an abuse risk. |
| `provider_cost_shock_active` | 12.000000 | 12.000000 | 0.000000 | 12.000000 | Epochs where external provider cost pressure was active. |
| `max_provider_cost_shocked_providers` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Largest provider population affected by cost shock in any epoch. |
| `max_provider_cost_shock_fixed_multiplier_bps` | 80000.000000 | 80000.000000 | 0.000000 | 80000.000000 | Peak modeled fixed-cost multiplier during cost shock. |
| `max_provider_cost_shock_storage_multiplier_bps` | 80000.000000 | 80000.000000 | 0.000000 | 80000.000000 | Peak modeled storage-cost multiplier during cost shock. |
| `max_provider_cost_shock_bandwidth_multiplier_bps` | 40000.000000 | 40000.000000 | 0.000000 | 40000.000000 | Peak modeled bandwidth-cost multiplier during cost shock. |
| `provider_churn_events` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Provider exits executed by the economic churn policy. |
| `churned_providers` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Providers marked as exited by run end. |
| `provider_entries` | 2.000000 | 8.000000 | 6.000000 | 6.500000 | Reserve providers admitted into probation by the supply-entry policy. |
| `provider_probation_promotions` | 2.000000 | 8.000000 | 6.000000 | 6.500000 | Probationary providers promoted into assignment-eligible active supply. |
| `provider_underbonded_repairs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Repairs started because a provider lacked required bond headroom. |
| `final_underbonded_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Providers below the configured bond requirement at run end. |
| `max_underbonded_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak providers below the configured bond requirement. |
| `final_underbonded_assigned_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Assigned slots still held by underbonded providers at run end. |
| `max_underbonded_assigned_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak assigned slots held by underbonded providers. |
| `final_provider_bond_deficit` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Run-end aggregate provider bond deficit under configured collateral rules. |
| `max_provider_bond_deficit` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak aggregate provider bond deficit under configured collateral rules. |
| `reserve_providers` | 0.000000 | 6.000000 | 6.000000 | 1.500000 | Providers still outside normal placement as reserve supply. |
| `probationary_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Providers in onboarding probation and not yet eligible for normal placement. |
| `max_reserve_providers` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Peak providers still outside normal placement as reserve supply. |
| `max_probationary_providers` | 0.000000 | 6.000000 | 6.000000 | 2.250000 | Peak providers simultaneously in onboarding probation. |
| `entered_active_providers` | 2.000000 | 8.000000 | 6.000000 | 6.500000 | Providers that entered from reserve and are active by run end. |
| `churn_pressure_provider_epochs` | 20.000000 | 20.000000 | 0.000000 | 20.000000 | Provider-epochs below the churn threshold. |
| `max_churn_pressure_providers` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Peak providers simultaneously eligible for churn. |
| `final_active_provider_capacity` | 908.000000 | 983.000000 | 75.000000 | 964.250000 | Provider capacity remaining after economic exits. |
| `final_exited_provider_capacity` | 96.000000 | 96.000000 | 0.000000 | 96.000000 | Provider capacity removed by economic exits. |
| `final_reserve_provider_capacity` | 0.000000 | 75.000000 | 75.000000 | 18.750000 | Provider capacity still held outside normal placement as reserve supply. |
| `final_probationary_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity in onboarding probation at run end. |
| `max_churned_assigned_slots` | 31.000000 | 32.000000 | 1.000000 | 31.375000 | Peak assigned slots on churned providers before repair catches up. |
| `providers_negative_pnl` | 8.000000 | 8.000000 | 0.000000 | 8.000000 | Market sustainability and churn pressure. |
| `saturated_responses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider bandwidth bottleneck signal. |
| `providers_over_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Placement/capacity invariant; should remain zero. |
| `final_storage_utilization_bps` | 4384.000000 | 4746.000000 | 362.000000 | 4478.250000 | Supply utilization against modeled capacity. |
| `min_storage_price` | 0.719548 | 0.837068 | 0.117520 | 0.758153 | Lowest storage price observed during the run. |
| `max_storage_price` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Highest storage price observed during the run. |
| `final_storage_price` | 0.719548 | 0.923967 | 0.204418 | 0.779878 | Storage-controller endpoint under this run. |
| `min_retrieval_price` | 0.010000 | 0.010000 | 0.000000 | 0.010000 | Lowest retrieval price observed during the run. |
| `max_retrieval_price` | 0.013785 | 0.013785 | 0.000000 | 0.013785 | Highest retrieval price observed during the run. |
| `final_retrieval_price` | 0.013785 | 0.013785 | 0.000000 | 0.013785 | Retrieval-controller endpoint under this run. |
| `storage_price_direction_changes` | 0.000000 | 3.000000 | 3.000000 | 1.250000 | Storage price controller direction changes across the run. |
| `retrieval_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval price controller direction changes across the run. |
| `provider_pnl` | 273.508446 | 273.748446 | 0.240000 | 273.597696 | Aggregate provider economics; inspect distribution before deciding. |

## Varied Parameters

| Parameter | Values |
|---|---|
| `provider_entry_end_epoch` | `12`, `14`, `6` |
| `provider_entry_max_per_epoch` | `1`, `2`, `4` |
| `provider_entry_probation_epochs` | `0`, `1`, `3` |
| `provider_entry_start_epoch` | `5`, `7` |
| `provider_entry_trigger_storage_price` | `0.0`, `0.9` |
| `provider_entry_trigger_utilization_bps` | `0`, `4000` |

## Parameter Sensitivity

| Parameter | Value | Runs | Avg Success | Total Unavailable | Total Data Loss | Avg Backoffs | Avg Negative P&L | Avg Final Storage Price |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `provider_entry_end_epoch` | `12` | 6 | 100.00% | 0 | 0 | 0 | 8 | 0.7598 |
| `provider_entry_end_epoch` | `14` | 1 | 100.00% | 0 | 0 | 0 | 8 | 0.7564 |
| `provider_entry_end_epoch` | `6` | 1 | 100.00% | 0 | 0 | 0 | 8 | 0.9240 |
| `provider_entry_max_per_epoch` | `1` | 2 | 100.00% | 0 | 0 | 0 | 8 | 0.8218 |
| `provider_entry_max_per_epoch` | `2` | 4 | 100.00% | 0 | 0 | 0 | 8 | 0.7891 |
| `provider_entry_max_per_epoch` | `4` | 2 | 100.00% | 0 | 0 | 0 | 8 | 0.7195 |
| `provider_entry_probation_epochs` | `0` | 1 | 100.00% | 0 | 0 | 0 | 8 | 0.7195 |
| `provider_entry_probation_epochs` | `1` | 6 | 100.00% | 0 | 0 | 0 | 8 | 0.7938 |
| `provider_entry_probation_epochs` | `3` | 1 | 100.00% | 0 | 0 | 0 | 8 | 0.7564 |
| `provider_entry_start_epoch` | `5` | 7 | 100.00% | 0 | 0 | 0 | 8 | 0.7832 |
| `provider_entry_start_epoch` | `7` | 1 | 100.00% | 0 | 0 | 0 | 8 | 0.7564 |
| `provider_entry_trigger_storage_price` | `0.0` | 7 | 100.00% | 0 | 0 | 0 | 8 | 0.7593 |
| `provider_entry_trigger_storage_price` | `0.9` | 1 | 100.00% | 0 | 0 | 0 | 8 | 0.9240 |
| `provider_entry_trigger_utilization_bps` | `0` | 1 | 100.00% | 0 | 0 | 0 | 8 | 0.9240 |
| `provider_entry_trigger_utilization_bps` | `4000` | 7 | 100.00% | 0 | 0 | 0 | 8 | 0.7593 |

## High-Risk Runs

| Run | Scenario | Risk | Reasons |
|---|---|---|---|
| `wide-entry-cap4` | `provider-supply-entry` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `underfilled-short-window` | `provider-supply-entry` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity; reserve providers remained unused at run end |
| `slow-entry-cap1` | `provider-supply-entry` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `price-triggered-entry` | `provider-supply-entry` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity; reserve providers remained unused at run end |
| `longer-probation` | `provider-supply-entry` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `immediate-promotion` | `provider-supply-entry` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `delayed-entry-start` | `provider-supply-entry` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity |
| `baseline-cap2-probation1` | `provider-supply-entry` | `medium` | some providers ended with negative modeled P&L; provider economic churn removed active capacity |

## Best Observed Run

`baseline-cap2-probation1` is the best observed run under the current ordering: zero data loss first, then highest retrieval success, then fewer unavailable reads, capacity violations, negative-P&L providers, and repair backoffs.

This is not an automatic policy choice. It is the run humans should inspect first when deciding which parameter set deserves keeper or e2e implementation work.

## Review Questions

- Which changed parameter plausibly caused the largest movement in availability, repair pressure, and provider economics?
- Did any run improve availability by hiding economic distress, capacity over-assignment, or repair backlog?
- Are unavailable reads explicitly allowed by the scenario contract, and did modeled data loss remain zero?
- Which parameter set should become the baseline for the next keeper/e2e planning slice?
