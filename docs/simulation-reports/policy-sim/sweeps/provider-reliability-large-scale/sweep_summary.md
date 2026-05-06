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

| Run | Scenario | Seed | Risk | Assertions | Success | Unavailable Reads | Expired Reads | Closed Reads | Data Loss | Repairs | Backoffs | Saturated | Negative P&L | Storage Price | Retrieval Price |
|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `provider-online-probability-min-0p975` | `large-scale-regional-stress` | `29` | `medium` | `PASS` | 99.21% | 1132 | 0 | 0 | 0 | 4208/3540 | 14228 | 17494 | 0 | 0.4407 | 0.0243 |
| `provider-online-probability-min-0p985` | `large-scale-regional-stress` | `29` | `medium` | `PASS` | 99.26% | 1065 | 0 | 0 | 0 | 3624/3050 | 12436 | 15482 | 4 | 0.4407 | 0.0243 |
| `provider-online-probability-min-0p995` | `large-scale-regional-stress` | `29` | `medium` | `PASS` | 99.52% | 697 | 0 | 0 | 0 | 1947/1805 | 12263 | 12704 | 1 | 0.4407 | 0.0243 |

## Key Metric Ranges

| Metric | Min | Max | Delta | Mean | Review Meaning |
|---|---:|---:|---:|---:|---|
| `success_rate` | 0.992139 | 0.995160 | 0.003021 | 0.993301 | Primary availability outcome; should not regress silently. |
| `unavailable_reads` | 697.000000 | 1132.000000 | 435.000000 | 964.666667 | Temporary user-facing misses; allowed only in explicit stress contracts. |
| `offline_responses` | 43057.000000 | 57938.000000 | 14881.000000 | 50462.666667 | Provider responses missed because a selected provider was offline. |
| `expired_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Post-expiry read requests rejected as expired content, not live availability misses. |
| `closed_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Post-close read requests rejected as closed content, not live availability misses. |
| `data_loss_events` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Durability invariant; non-zero values block graduation. |
| `reward_coverage` | 0.955321 | 0.966307 | 0.010986 | 0.960934 | Shows whether compliant responsibility remains economically recognized. |
| `reward_pool_minted` | 7509.096000 | 7646.472000 | 137.376000 | 7567.248000 | Modeled base subsidy made available to active slots. |
| `reward_paid` | 7173.594000 | 7388.838000 | 215.244000 | 7271.874000 | Base subsidy actually paid to reward-eligible slots. |
| `reward_burned` | 257.634000 | 335.502000 | 77.868000 | 295.374000 | Base subsidy withheld from non-compliant responsibility. |
| `repairs_started` | 1947.000000 | 4208.000000 | 2261.000000 | 3259.666667 | Detection and repair activation pressure. |
| `repairs_ready` | 1805.000000 | 3540.000000 | 1735.000000 | 2798.333333 | Pending replacement providers that proved readiness. |
| `repairs_completed` | 1805.000000 | 3540.000000 | 1735.000000 | 2798.333333 | Healing throughput under the parameter set. |
| `repair_attempts` | 14210.000000 | 18436.000000 | 4226.000000 | 16235.333333 | Repair retry pressure before starts or backoffs. |
| `repair_backoffs` | 12263.000000 | 14228.000000 | 1965.000000 | 12975.666667 | Replacement capacity or repair-start bottlenecks. |
| `repair_cooldowns` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retry cooldowns that intentionally throttle repair churn. |
| `repair_attempt_caps` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Per-slot attempt caps hit before a replacement could start. |
| `repair_timeouts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Pending replacement providers that failed readiness before timeout. |
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
| `final_open_deals` | 1500.000000 | 1500.000000 | 0.000000 | 1500.000000 | Deals still active at run end. |
| `final_closed_deals` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deals closed by run end. |
| `retrieval_base_burned` | 288.000000 | 288.000000 | 0.000000 | 288.000000 | Base retrieval fees burned across live retrieval attempts. |
| `retrieval_variable_burned` | 1441.693465 | 1445.716525 | 4.023060 | 1443.240442 | Variable retrieval fee burn withheld from provider payout. |
| `retrieval_provider_payouts` | 17780.886073 | 17830.503810 | 49.617737 | 17799.965449 | Retrieval fees paid to providers for served slots. |
| `sponsored_retrieval_attempts` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval attempts funded by requester/sponsor sessions. |
| `sponsored_retrieval_spent` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Total sponsored retrieval base plus variable spend. |
| `owner_retrieval_escrow_debited` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Deal-owner escrow debited for non-sponsored retrievals. |
| `retrieval_wash_accounted_spend` | 288.000000 | 288.000000 | 0.000000 | 288.000000 | Explicit modeled requester, sponsor, or owner-funded retrieval spend counted against wash traffic. |
| `retrieval_wash_net_gain` | 17492.886073 | 17542.503810 | 49.617737 | 17511.965449 | Worst-case colluding requester/provider net gain; positive values indicate wash abuse risk. |
| `retrieval_attempts` | 144000.000000 | 144000.000000 | 0.000000 | 144000.000000 | Effective retrieval attempts after demand shock multipliers and inactive-content rejection. |
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
| `elasticity_spent` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Non-overlay user-funded elasticity spend consumed by overflow demand. |
| `elasticity_rejections` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Non-overlay elasticity expansion attempts rejected by spend cap. |
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
| `suspect_slots` | 228.000000 | 461.000000 | 233.000000 | 350.000000 | Soft warning slot-epochs before thresholded delinquency. |
| `delinquent_slots` | 19476.000000 | 29466.000000 | 9990.000000 | 24858.666667 | Threshold-crossed slot-epochs that should be visible to operators. |
| `withheld_responses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Refusal-to-serve retrieval responses generated by withholding providers. |
| `deputy_misses` | 13651.000000 | 17849.000000 | 4198.000000 | 15661.333333 | Deputy-served slots where the responsible provider failed direct service. |
| `quota_misses` | 13950.000000 | 18214.000000 | 4264.000000 | 16006.000000 | Soft liveness evidence generated by the run. |
| `corrupt_responses` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Bad retrieval responses generated by hard-fault providers. |
| `invalid_proofs` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Hard-fault evidence generated by the run. |
| `provider_hard_faults` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider-level hard-fault counter used for enforcement graduation. |
| `paid_corrupt_bytes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Payment safety invariant; should remain zero. |
| `provider_slashed` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Simulated bond removed from providers after hard-fault evidence. |
| `audit_budget_demand` | 276.010000 | 369.380000 | 93.370000 | 319.590000 | Total audit work implied by soft-failure evidence and carried backlog. |
| `audit_budget_spent` | 276.010000 | 360.630000 | 84.620000 | 316.673333 | Audit budget actually consumed under the configured cap. |
| `audit_budget_backlog` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Unmet audit demand remaining at run end. |
| `audit_budget_exhausted` | 0.000000 | 1.000000 | 1.000000 | 0.333333 | Epochs where audit demand exceeded available budget. |
| `evidence_spam_claims` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Low-quality deputy evidence submissions in the spam fixture. |
| `evidence_spam_convictions` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Spam claims that still reached conviction and earned bounty. |
| `evidence_spam_bond_burned` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Evidence bond burned for unconvicted spam claims. |
| `evidence_spam_bounty_paid` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Conviction-gated bounty paid to the evidence spammer. |
| `evidence_spam_net_gain` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Spammer net economics; positive values indicate an abuse risk. |
| `provider_bond_opportunity_cost` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Modeled capital carry cost of locked provider bond included in provider P&L. |
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
| `churn_pressure_provider_epochs` | 80.000000 | 289.000000 | 209.000000 | 168.333333 | Provider-epochs below the churn threshold. |
| `max_churn_pressure_providers` | 8.000000 | 20.000000 | 12.000000 | 15.333333 | Peak providers simultaneously eligible for churn. |
| `final_active_provider_capacity` | 31289.000000 | 31289.000000 | 0.000000 | 31289.000000 | Provider capacity remaining after economic exits. |
| `final_exited_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity removed by economic exits. |
| `final_reserve_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity still held outside normal placement as reserve supply. |
| `final_probationary_provider_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Provider capacity in onboarding probation at run end. |
| `max_churned_assigned_slots` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Peak assigned slots on churned providers before repair catches up. |
| `providers_negative_pnl` | 0.000000 | 4.000000 | 4.000000 | 1.666667 | Market sustainability and churn pressure. |
| `saturated_responses` | 12704.000000 | 17494.000000 | 4790.000000 | 15226.666667 | Provider bandwidth bottleneck signal. |
| `providers_over_capacity` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Placement/capacity invariant; should remain zero. |
| `final_storage_utilization_bps` | 5539.000000 | 5707.000000 | 168.000000 | 5605.000000 | Supply utilization against modeled capacity. |
| `min_storage_price` | 0.440685 | 0.440685 | 0.000000 | 0.440685 | Lowest storage price observed during the run. |
| `max_storage_price` | 1.000000 | 1.000000 | 0.000000 | 1.000000 | Highest storage price observed during the run. |
| `final_storage_price` | 0.440685 | 0.440685 | 0.000000 | 0.440685 | Storage-controller endpoint under this run. |
| `min_retrieval_price` | 0.011000 | 0.011000 | 0.000000 | 0.011000 | Lowest retrieval price observed during the run. |
| `max_retrieval_price` | 0.024267 | 0.024267 | 0.000000 | 0.024267 | Highest retrieval price observed during the run. |
| `final_retrieval_price` | 0.024267 | 0.024267 | 0.000000 | 0.024267 | Retrieval-controller endpoint under this run. |
| `storage_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Storage price controller direction changes across the run. |
| `retrieval_price_direction_changes` | 0.000000 | 0.000000 | 0.000000 | 0.000000 | Retrieval price controller direction changes across the run. |
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
