# Policy Simulation Sensitivity Sweep

This report aggregates `5` completed simulator run output directories. It does not rerun the simulator or mutate raw run artifacts.

## Executive Summary

- Mode: `Sensitivity Sweep`.
- Runs analyzed: `5`.
- Varied parameters: `7`.
- Critical-risk runs: `0`.
- Assertion failures: `0`.
- Runs with modeled data loss: `0`.
- Decision posture: safe to use this report for policy-parameter review before keeper work.

## Run Matrix

| Run | Scenario | Seed | Risk | Assertions | Success | Unavailable Reads | Expired Reads | Closed Reads | Data Loss | Repairs | Backoffs | Saturated | Negative P&L | Storage Price | Retrieval Price |
|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `baseline-close-all-epoch4` | `closed-retrieval-rejection` | `110` | `low` | `PASS` | 100.00% | 0 | 0 | 160 | 0 | 0/0 | 0 | 0 | 0 | 0.0500 | 0.0100 |
| `early-close-all-epoch2` | `closed-retrieval-rejection` | `110` | `low` | `PASS` | 100.00% | 0 | 0 | 320 | 0 | 0/0 | 0 | 0 | 0 | 0.0500 | 0.0100 |
| `larger-closed-read-demand` | `closed-retrieval-rejection` | `110` | `low` | `PASS` | 100.00% | 0 | 0 | 1000 | 0 | 0/0 | 0 | 0 | 0 | 0.0500 | 0.0100 |
| `no-close-open-control` | `closed-retrieval-rejection` | `110` | `low` | `PASS` | 100.00% | 0 | 0 | 0 | 0 | 0/0 | 0 | 0 | 0 | 0.0500 | 0.0100 |
| `partial-half-close-epoch4` | `closed-retrieval-rejection` | `110` | `low` | `PASS` | 100.00% | 0 | 0 | 83 | 0 | 0/0 | 0 | 0 | 0 | 0.0500 | 0.0100 |

## Key Metric Ranges

| Metric | Min | Max | Delta | Mean | Review Meaning |
|---|---:|---:|---:|---:|---|
| `success_rate` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Primary availability outcome; should not regress silently. |
| `unavailable_reads` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Temporary user-facing misses; allowed only in explicit stress contracts. |
| `offline_responses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider responses missed because a selected provider was offline. |
| `expired_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Post-expiry read requests rejected as expired content, not live availability misses. |
| `closed_retrieval_attempts` | 0.000000 | 1000.000000 | 1000.000000 | 312.600000 | Post-close read requests rejected as closed content, not live availability misses. |
| `data_loss_events` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Durability invariant; non-zero values block graduation. |
| `reward_coverage` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Shows whether compliant responsibility remains economically recognized. |
| `reward_pool_minted` | 5.760000 | 38.400000 | 32.640000 | 17.472000 | Modeled base subsidy made available to active slots. |
| `reward_paid` | 5.760000 | 38.400000 | 32.640000 | 17.472000 | Base subsidy actually paid to reward-eligible slots. |
| `reward_burned` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Base subsidy withheld from non-compliant responsibility. |
| `repairs_started` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Detection and repair activation pressure. |
| `repairs_ready` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Pending replacement providers that proved readiness. |
| `repairs_completed` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Healing throughput under the parameter set. |
| `repair_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Repair retry pressure before starts or backoffs. |
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
| `max_operator_assignment_share_bps` | 83.000000 | 277.000000 | 194.000000 | 196.800000 | Worst observed assignment share of any operator across epochs. |
| `top_operator_assignment_share_bps` | 0.000000 | 277.000000 | 277.000000 | 97.000000 | Final assignment share of the largest operator. |
| `top_operator_provider_share_bps` | 83.000000 | 208.000000 | 125.000000 | 183.000000 | Provider identity share controlled by the largest operator. |
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
| `storage_escrow_locked` | 691.200000 | 2304.000000 | 1612.800000 | 1059.840000 | Storage escrow charged upfront for committed deals. |
| `storage_escrow_earned` | 230.400000 | 1536.000000 | 1305.600000 | 698.880000 | Storage escrow earned over modeled service epochs. |
| `storage_escrow_refunded` | 0.000000 | 768.000000 | 768.000000 | 337.920000 | Unearned storage escrow returned by deal close/refund. |
| `storage_escrow_outstanding` | 0.000000 | 115.200000 | 115.200000 | 23.040000 | Storage escrow still locked at run end. |
| `storage_fee_provider_payouts` | 230.400000 | 1536.000000 | 1305.600000 | 698.880000 | Earned storage fees paid to eligible providers. |
| `storage_fee_burned` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Earned storage fees withheld from non-compliant slots. |
| `deals_closed` | 0.000000 | 40.000000 | 40.000000 | 14.000000 | Deal close events executed across the run. |
| `deals_expired` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deal expiry events executed across the run. |
| `final_expired_deals` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deals expired by run end. |
| `final_open_deals` | 0.000000 | 12.000000 | 12.000000 | 3.600000 | Deals still active at run end. |
| `final_closed_deals` | 0.000000 | 40.000000 | 40.000000 | 14.000000 | Deals closed by run end. |
| `retrieval_base_burned` | 0.160000 | 2.000000 | 1.840000 | 0.671400 | Base retrieval fees burned across live retrieval attempts. |
| `retrieval_variable_burned` | 0.640000 | 8.000000 | 7.360000 | 2.685600 | Variable retrieval fee burn withheld from provider payout. |
| `retrieval_provider_payouts` | 12.160000 | 152.000000 | 139.840000 | 51.026400 | Retrieval fees paid to providers for served slots. |
| `sponsored_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval attempts funded by requester/sponsor sessions. |
| `sponsored_retrieval_spent` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Total sponsored retrieval base plus variable spend. |
| `owner_retrieval_escrow_debited` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deal-owner escrow debited for non-sponsored retrievals. |
| `retrieval_wash_accounted_spend` | 0.160000 | 2.000000 | 1.840000 | 0.671400 | Explicit modeled requester, sponsor, or owner-funded retrieval spend counted against wash traffic. |
| `retrieval_wash_net_gain` | 12.000000 | 150.000000 | 138.000000 | 50.355000 | Worst-case colluding requester/provider net gain; positive values indicate wash abuse risk. |
| `retrieval_attempts` | 160.000000 | 2000.000000 | 1840.000000 | 671.400000 | Effective retrieval attempts after demand shock multipliers and inactive-content rejection. |
| `retrieval_latent_attempts` | 480.000000 | 3000.000000 | 2520.000000 | 984.000000 | Baseline read demand before demand-shock multipliers. |
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
| `delinquent_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Threshold-crossed slot-epochs that should be visible to operators. |
| `withheld_responses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Refusal-to-serve retrieval responses generated by withholding providers. |
| `deputy_misses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deputy-served slots where the responsible provider failed direct service. |
| `quota_misses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Soft liveness evidence generated by the run. |
| `corrupt_responses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Bad retrieval responses generated by hard-fault providers. |
| `invalid_proofs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hard-fault evidence generated by the run. |
| `provider_hard_faults` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider-level hard-fault counter used for enforcement graduation. |
| `paid_corrupt_bytes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Payment safety invariant; should remain zero. |
| `provider_slashed` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Simulated bond removed from providers after hard-fault evidence. |
| `audit_budget_demand` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Total audit work implied by soft-failure evidence and carried backlog. |
| `audit_budget_spent` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Audit budget actually consumed under the configured cap. |
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
| `churn_pressure_provider_epochs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider-epochs below the churn threshold. |
| `max_churn_pressure_providers` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak providers simultaneously eligible for churn. |
| `final_active_provider_capacity` | 768.000000 | 1920.000000 | 1152.000000 | 998.400000 | Provider capacity remaining after economic exits. |
| `final_exited_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity removed by economic exits. |
| `final_reserve_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity still held outside normal placement as reserve supply. |
| `final_probationary_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity in onboarding probation at run end. |
| `max_churned_assigned_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak assigned slots on churned providers before repair catches up. |
| `providers_negative_pnl` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Market sustainability and churn pressure. |
| `saturated_responses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider bandwidth bottleneck signal. |
| `providers_over_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Placement/capacity invariant; should remain zero. |
| `final_storage_utilization_bps` | 0.000000 | 1875.000000 | 1875.000000 | 562.400000 | Supply utilization against modeled capacity. |
| `min_storage_price` | 0.050000 | 0.050000 | 0.000000 | 0.050000 | Lowest storage price observed during the run. |
| `max_storage_price` | 0.050000 | 0.050000 | 0.000000 | 0.050000 | Highest storage price observed during the run. |
| `final_storage_price` | 0.050000 | 0.050000 | 0.000000 | 0.050000 | Storage-controller endpoint under this run. |
| `min_retrieval_price` | 0.010000 | 0.010000 | 0.000000 | 0.010000 | Lowest retrieval price observed during the run. |
| `max_retrieval_price` | 0.010000 | 0.010000 | 0.000000 | 0.010000 | Highest retrieval price observed during the run. |
| `final_retrieval_price` | 0.010000 | 0.010000 | 0.000000 | 0.010000 | Retrieval-controller endpoint under this run. |
| `storage_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Storage price controller direction changes across the run. |
| `retrieval_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval price controller direction changes across the run. |
| `provider_pnl` | 242.720000 | 1693.600000 | 1450.880000 | 753.895200 | Aggregate provider economics; inspect distribution before deciding. |

## Varied Parameters

| Parameter | Values |
|---|---|
| `deal_close_bps` | `0`, `5000` |
| `deal_close_count` | `0`, `12`, `40` |
| `deal_close_epoch` | `0`, `2`, `4` |
| `deal_duration_epochs` | `6`, `8` |
| `deals` | `12`, `40` |
| `providers` | `120`, `48` |
| `users` | `500`, `80` |

## Parameter Sensitivity

| Parameter | Value | Runs | Avg Success | Total Unavailable | Total Data Loss | Avg Backoffs | Avg Negative P&L | Avg Final Storage Price |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `deal_close_bps` | `0` | 4 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deal_close_bps` | `5000` | 1 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deal_close_count` | `0` | 2 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deal_close_count` | `12` | 2 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deal_close_count` | `40` | 1 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deal_close_epoch` | `0` | 1 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deal_close_epoch` | `2` | 1 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deal_close_epoch` | `4` | 3 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deal_duration_epochs` | `6` | 4 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deal_duration_epochs` | `8` | 1 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deals` | `12` | 4 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `deals` | `40` | 1 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `providers` | `120` | 1 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `providers` | `48` | 4 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `users` | `500` | 1 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |
| `users` | `80` | 4 | 100.00% | 0 | 0 | 0 | 0 | 0.0500 |

## High-Risk Runs

- No medium, high, or critical risk runs were detected.

## Best Observed Run

`baseline-close-all-epoch4` is the best observed run under the current ordering: zero data loss first, then highest retrieval success, then fewer unavailable reads, capacity violations, negative-P&L providers, and repair backoffs.

This is not an automatic policy choice. It is the run humans should inspect first when deciding which parameter set deserves keeper or e2e implementation work.

## Review Questions

- Which changed parameter plausibly caused the largest movement in availability, repair pressure, and provider economics?
- Did any run improve availability by hiding economic distress, capacity over-assignment, or repair backlog?
- Are unavailable reads explicitly allowed by the scenario contract, and did modeled data loss remain zero?
- Which parameter set should become the baseline for the next keeper/e2e planning slice?
