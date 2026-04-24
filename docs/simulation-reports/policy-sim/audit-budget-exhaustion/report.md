# Policy Simulation Report: Audit Budget Exhaustion

## Executive Summary

**Verdict:** `PASS`. This run simulates `audit-budget-exhaustion` with `60` providers, `120` data users, `36` deals, and an RS `8+4` layout for `8` epochs. Enforcement is configured as `REWARD_EXCLUSION`.

Model many soft failures with an intentionally tight audit budget. The policy concern is whether audit spending remains capped instead of becoming an unbounded protocol subsidy.

Expected policy behavior: Quota misses create audit demand, audit spend is capped by budget, repair starts where allowed, and data-loss events remain zero.

Observed result: retrieval success was `100.00%`, reward coverage was `98.11%`, repairs started/ready/completed were `32` / `32` / `32`, and `4` providers ended with negative modeled P&L. The run recorded `0` unavailable reads, `0` modeled data-loss events, `0` bandwidth saturation responses and `0` repair backoffs across `32` repair attempts. Slot health recorded `32` suspect slot-epochs and `64` delinquent slot-epochs. High-bandwidth promotions were `0` and final high-bandwidth providers were `0`.

## Review Focus

Use this case to decide whether audit budget exhaustion should degrade into backlog, higher fees, or stronger admission control.

A human reviewer should focus less on the pass/fail label and more on whether the scenario, assertions, and threshold values encode the policy we actually want to enforce on-chain.

## Run Configuration

| Field | Value |
|---|---:|
| Seed | `33` |
| Providers | `60` |
| Data users | `120` |
| Deals | `36` |
| Epochs | `8` |
| Erasure coding | `K=8`, `M=4`, `N=12` |
| User MDUs per deal | `16` |
| Retrievals/user/epoch | `1` |
| Liveness quota | `2`-`8` blobs/slot/epoch |
| Repair delay | `2` epochs |
| Repair attempt cap/slot | `0` (`0` means unlimited) |
| Repair backoff window | `0` epochs |
| Dynamic pricing | `false` |
| Storage price | `1.0000` |
| New deal requests/epoch | `0` |
| Storage demand price ceiling | `0.0000` (`0` means disabled) |
| Storage demand reference price | `0.0000` (`0` disables elasticity) |
| Storage demand elasticity | `0.00%` |
| Retrieval price/slot | `0.0100` |
| Provider capacity range | `16`-`16` slots |
| Provider bandwidth range | `0`-`0` serves/epoch (`0` means unlimited) |
| Service class | `General` |
| Performance market | `false` |
| Provider latency range | `0`-`0` ms |
| Latency tier windows | Platinum <= `100` ms, Gold <= `250` ms, Silver <= `500` ms |
| High-bandwidth promotion | `false` |
| High-bandwidth capacity threshold | `0` serves/epoch |
| Hot retrieval share | `0.00%` |
| Operators | `60` |
| Dominant operator provider share | `0.00%` |
| Operator assignment cap/deal | `0` (`0` means disabled) |
| Provider regions | `global` |

## Economic Assumptions

The economic model is intentionally simple and deterministic. It is useful for comparing policy directions, not for setting final token economics without external market data.

| Assumption | Value | Interpretation |
|---|---:|---|
| Storage price | `1.0000` | Unitless price applied by the controller, demand-elasticity curve, and optional affordability gate. |
| New deal requests/epoch | `0` | Latent modeled write demand before optional price elasticity suppression. Effective requests are accepted only when price and capacity gates pass. |
| Storage demand price ceiling | `0.0000` | If non-zero, new deal demand above this storage price is rejected as unaffordable. |
| Storage demand reference price | `0.0000` | If non-zero with elasticity enabled, demand scales around this price before hard affordability rejection. |
| Storage demand elasticity | `0.00%` | Demand multiplier change for a 100% price move relative to the reference price, clamped by configured min/max demand bps. |
| Storage target utilization | `70.00%` | If dynamic pricing is enabled, utilization above this target steps storage price up, otherwise down. |
| Retrieval price per slot | `0.0100` | Paid per successful provider slot served, before the configured variable burn. |
| Retrieval target per epoch | `80` | If dynamic pricing is enabled, retrieval attempts above this target step retrieval price up, otherwise down. |
| Dynamic pricing max step | `5.00%` | Per-epoch controller movement cap. Lower values are safer but slower to equilibrate. |
| Base reward per slot | `0.0200` | Modeled issuance/subsidy paid only to reward-eligible active slots. |
| Provider storage cost/slot/epoch | `0.0100` | Simplified provider cost basis; jitter may create marginal-provider distress. |
| Provider bandwidth cost/retrieval | `0.0010` | Simplified egress cost basis for retrieval-heavy scenarios. |
| Performance reward per serve | `0.0000` | Optional tiered QoS reward. Multipliers are applied by latency tier and Fail tier receives the configured fail multiplier. |
| Audit budget per epoch | `0.0500` | Minted audit budget; spending is capped by available budget and unmet miss-driven demand carries forward as backlog. |
| Evidence spam claims/epoch | `0` | Synthetic low-quality deputy claims used to test bond burn and bounty gating economics. |
| Evidence bond / bounty | `0.0000` / `0.0000` | Spam claims burn bond unless convicted; bounty is paid only on convicted evidence. |
| Retrieval burn | `5.00%` | Fraction of variable retrieval fees burned before provider payout. |

## What Happened

User-facing retrieval availability stayed intact: every modeled retrieval completed successfully. That does not mean every provider behaved correctly; it means redundancy, routing, or deputy service absorbed the fault.

The policy layer recorded `64` evidence events: `64` soft, `0` threshold, `0` hard, and `0` spam events. Soft evidence is suitable for repair and reward exclusion; hard or convicted threshold evidence is the category that can later justify slashing or stronger sanctions.

Repair was exercised: `32` repair operations started, `32` produced pending-provider readiness evidence, and `32` completed. The simulator models this as make-before-break reassignment, so the old assignment remains visible until replacement work catches up and the readiness gate is satisfied.

Reward exclusion was active: `1.2800` modeled reward units were burned instead of paid to non-compliant slots.

Audit demand exceeded available budget: `15.6000` of unmet audit work remained after `8` exhausted epochs.

## Diagnostic Signals

These are derived from the raw CSV/JSON outputs and are intended to make scale behavior reviewable without manually scanning ledgers.

| Signal | Value | Why It Matters |
|---|---:|---|
| Worst epoch success | `100.00%` at epoch `1` | Identifies the availability cliff instead of hiding it in aggregate success. |
| Unavailable reads | `0` | Temporary read failures are a scale/reliability signal; they are not automatically permanent data loss. |
| Modeled data-loss events | `0` | Durability-loss signal. This should remain zero for current scale fixtures. |
| Degraded epochs | `0` | Counts epochs with unavailable reads or success below 99.9%. |
| Recovery epoch after worst | `2` | Shows whether the network returned to clean steady state after the worst point. |
| Saturation rate | `0.00%` | Provider bandwidth saturation per retrieval attempt. |
| Peak saturation | `0` at epoch `1` | Reveals when bandwidth, not storage correctness, became the bottleneck. |
| Repair readiness ratio | `100.00%` | Measures whether pending providers catch up before promotion. |
| Repair completion ratio | `100.00%` | Measures whether healing catches up with detection. |
| Repair attempts | `32` | Counts bounded attempts to open a repair or discover replacement pressure. |
| Repair backoff pressure | `0` backoffs per started repair | Shows whether repair coordination is saturated. |
| Repair backoffs per attempt | `0` | Distinguishes capacity/cooldown pressure from successful repair starts. |
| Repair cooldowns / attempt caps | `0` / `0` | Shows whether throttling, rather than candidate selection alone, is bounding repair churn. |
| Suspect / delinquent slot-epochs | `32` / `64` | Separates early warning state from threshold-crossed delinquency. |
| Final repair backlog | `0` slots | Started repairs minus completed repairs at run end. |
| High-bandwidth providers | `0` | Providers currently eligible for hot/high-bandwidth routing. |
| High-bandwidth promotions/demotions | `0` / `0` | Shows capability changes under measured demand. |
| Hot high-bandwidth serves/retrieval | `0` | Measures whether hot retrievals actually use promoted providers. |
| Avg latency / Fail tier rate | `0` ms / `0.00%` | Separates correctness from QoS: slow-but-valid service can be available while still earning lower or no performance rewards. |
| Platinum / Gold / Silver / Fail serves | `0` / `0` / `0` / `0` | Shows the latency-tier distribution for performance-market policy. |
| Performance reward paid | `0.0000` | Quantifies the tiered QoS reward stream separately from baseline storage and retrieval settlement. |
| Provider latency p10 / p50 / p90 | `0` / `0` / `0` ms | Shows whether aggregate averages hide slow provider tails. |
| New deal latent/effective demand | `0` / `0` | Shows how much modeled write demand survived the price-elasticity curve. |
| New deal demand accepted/rejected/suppressed | `0` / `0` / `0` | Shows whether modeled write demand is entering the network, blocked by price/capacity, or never arriving because quotes are unattractive. |
| New deal effective/latent acceptance | `0.00%` / `0.00%` | Demand-side market health signal; a technically available network can still fail if users cannot afford storage. |
| Audit demand / spent | `118.6000` / `0.4000` | Shows whether enforcement evidence consumed the available audit budget. |
| Audit backlog / exhausted epochs | `15.6000` / `8` | Makes budget exhaustion explicit instead of hiding unmet audit work behind capped spending. |
| Evidence spam claims / convictions | `0` / `0` | Shows whether the evidence-market spam fixture exercised low-quality claims and any successful convictions. |
| Evidence spam bond / net gain | `0.0000` / `0.0000` | Spam should be negative-EV unless conviction-gated bounties justify the claim volume. |
| Top operator provider share | `1.66%` | Shows whether many SP identities are controlled by one operator. |
| Top operator assignment share | `2.31%` | Shows whether placement caps translate identity concentration into slot concentration. |
| Max operator slots/deal | `1` | Checks per-deal blast-radius limits against operator Sybil concentration. |
| Operator cap violations | `0` | Counts deals where operator slot concentration exceeded the configured cap. |
| Final storage utilization | `45.00%` | Active slots versus modeled provider capacity. |
| Provider utilization p50 / p90 / max | `50.00%` / `56.25%` / `62.50%` | Detects assignment concentration and capacity cliffs. |
| Provider P&L p10 / p50 / p90 | `1.0950` / `1.3280` / `1.5460` | Shows whether aggregate P&L hides marginal-provider distress. |
| Storage price start/end/range | `1.0000` -> `1.0000` (`1.0000`-`1.0000`) | Shows dynamic pricing movement and bounds. |
| Retrieval price start/end/range | `0.0100` -> `0.0100` (`0.0100`-`0.0100`) | Shows whether demand pressure moved retrieval pricing. |

### Regional Signals

| Region | Providers | Utilization | Offline Responses | Saturated Responses | Negative P&L Providers | Avg P&L |
|---|---:|---:|---:|---:|---:|---:|
| `global` | 60 | 45.00% | 0 | 0 | 4 | 1.2213 |

### Top Bottleneck Providers

| Provider | Region | Slots/Capacity | Utilization | Bandwidth Cap | Attempts | Offline | Saturated | P&L |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `sp-042` | `global` | 10/16 | 62.50% | 0 | 185 | 0 | 0 | 1.8225 |
| `sp-021` | `global` | 10/16 | 62.50% | 0 | 174 | 0 | 0 | 1.7290 |
| `sp-037` | `global` | 8/16 | 50.00% | 0 | 169 | 0 | 0 | 1.6265 |
| `sp-016` | `global` | 9/16 | 56.25% | 0 | 165 | 0 | 0 | 1.6225 |
| `sp-006` | `global` | 8/16 | 50.00% | 0 | 159 | 0 | 0 | 1.5915 |
| `sp-030` | `global` | 9/16 | 56.25% | 0 | 156 | 0 | 0 | 1.5460 |
| `sp-004` | `global` | 8/16 | 50.00% | 0 | 154 | 0 | 0 | 1.5490 |
| `sp-017` | `global` | 8/16 | 50.00% | 0 | 152 | 0 | 0 | 1.4820 |

### Top Operators

| Operator | Providers | Provider Share | Assigned Slots | Assignment Share | Retrieval Attempts | Success | P&L |
|---|---:|---:|---:|---:|---:|---:|---:|
| `op-021` | 1 | 1.66% | 10 | 2.31% | 174 | 100.00% | 1.7290 |
| `op-042` | 1 | 1.66% | 10 | 2.31% | 185 | 100.00% | 1.8225 |
| `op-016` | 1 | 1.66% | 9 | 2.08% | 165 | 100.00% | 1.6225 |
| `op-025` | 1 | 1.66% | 9 | 2.08% | 130 | 100.00% | 1.3250 |
| `op-030` | 1 | 1.66% | 9 | 2.08% | 156 | 100.00% | 1.5460 |
| `op-034` | 1 | 1.66% | 9 | 2.08% | 136 | 100.00% | 1.3760 |
| `op-040` | 1 | 1.66% | 9 | 2.08% | 148 | 100.00% | 1.4780 |
| `op-004` | 1 | 1.66% | 8 | 1.85% | 154 | 100.00% | 1.5490 |

### Timeline

| Epoch | Retrieval Success | Evidence | Repairs Started | Repairs Ready | Repairs Completed | Reward Burned | Provider P&L | Notes |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 100.00% | 32 | 0 | 0 | 0 | 0.6400 | 8.8400 | 32 quota misses, 32 suspect slots |
| 2 | 100.00% | 32 | 32 | 0 | 0 | 0.6400 | 8.8400 | 32 quota misses, 32 delinquent slots |
| 3 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 8.8400 | 32 slots repairing, 32 delinquent slots |
| 4 | 100.00% | 0 | 0 | 32 | 32 | 0.0000 | 8.8400 | 32 slots repairing |
| 5 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 9.4800 | steady state |
| 6 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 9.4800 | steady state |
| 7 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 9.4800 | steady state |
| 8 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 9.4800 | steady state |

## Enforcement Interpretation

The simulator recorded `64` evidence events and `96` repair ledger events. The first evidence epoch was `1` and the first repair-start epoch was `2`.

Evidence by reason:

- `quota_shortfall`: `64`

Evidence by provider:

- `sp-000`: `16`
- `sp-001`: `16`
- `sp-002`: `16`
- `sp-003`: `16`

Repair summary:

- Repairs started: `32`
- Repairs marked ready: `32`
- Repairs completed: `32`
- Repair attempts: `32`
- Repair backoffs: `0`
- Repair cooldown backoffs: `0`
- Repair attempt-cap backoffs: `0`
- Suspect slot-epochs: `32`
- Delinquent slot-epochs: `64`
- Final active slots in last epoch: `432`

Candidate exclusion summary:

- No no-candidate repair backoffs were recorded.

### Repair Ledger Excerpt

| Epoch | Event | Deal | Slot | Old Provider | New Provider | Reason | Attempt | Cooldown Until |
|---:|---|---:|---:|---|---|---|---:|---:|
| 2 | `repair_started` | 1 | 0 | `sp-000` | `sp-034` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 1 | 1 | `sp-001` | `sp-042` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 1 | 2 | `sp-002` | `sp-040` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 1 | 3 | `sp-003` | `sp-025` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 6 | 0 | `sp-000` | `sp-059` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 6 | 1 | `sp-001` | `sp-021` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 6 | 2 | `sp-002` | `sp-042` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 6 | 3 | `sp-003` | `sp-023` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 11 | 0 | `sp-000` | `sp-016` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 11 | 1 | `sp-001` | `sp-041` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 11 | 2 | `sp-002` | `sp-037` | `quota_shortfall` | 1 | 0 |
| 2 | `repair_started` | 11 | 3 | `sp-003` | `sp-034` | `quota_shortfall` | 1 | 0 |
| ... | ... | ... | ... | ... | ... | `84` more events omitted | ... | ... |

## Economic Interpretation

The run minted `68.2400` reward/audit units and burned `6.0800` units, for a burn-to-mint ratio of `8.91%`.

Providers earned `139.5200` in modeled revenue against `66.2400` in modeled cost, ending with aggregate P&L `73.2800`.

Retrieval accounting paid providers `72.9600`, burned `0.9600` in base fees, and burned `3.8400` in variable retrieval fees.

Performance-tier accounting paid `0.0000` in QoS rewards.

Audit accounting saw `118.6000` of demand, spent `0.4000`, and ended with `15.6000` backlog after `8` exhausted epochs.

`4` providers ended with negative P&L and `4` were marked as churn risk. That is economically important even when retrieval success is perfect.

Final modeled storage price was `1.0000` and retrieval price per slot was `0.0100`.

### Provider P&L Extremes

| Provider | Assigned Slots | Revenue | Cost | Slashed | P&L | Churn Risk |
|---|---:|---:|---:|---:|---:|---:|
| `sp-001` | 0 | 0.0000 + 0.2280 | 0.6640 | 0.0000 | -0.4360 | yes |
| `sp-003` | 0 | 0.0000 + 0.2280 | 0.6640 | 0.0000 | -0.4360 | yes |
| `sp-002` | 0 | 0.0000 + 0.2375 | 0.6650 | 0.0000 | -0.4275 | yes |
| `sp-000` | 0 | 0.0000 + 0.2470 | 0.6660 | 0.0000 | -0.4190 | yes |
| `sp-035` | 7 | 1.1200 + 0.9500 | 1.0600 | 0.0000 | 1.0100 | no |

## Assertion Contract

Assertions are the machine-readable policy contract for this fixture. Passing means this simulator run satisfied the current contract; it does not mean the policy is production-ready.

| Assertion | Status | Meaning | Detail |
|---|---|---|---|
| `min_success_rate` | `PASS` | Availability floor: user-facing reads must stay above this success rate. | success_rate=1, required>=0.99 |
| `min_quota_misses` | `PASS` | Fault fixture must generate quota evidence. | quota_misses=64, required>=1 |
| `min_audit_budget_demand` | `PASS` | Fault fixtures should create non-zero audit demand from miss-driven evidence. | audit_budget_demand=118.6, required>=1 |
| `min_audit_budget_spent` | `PASS` | Audit demand should spend at least this much budget in the fixture. | audit_budget_spent=0.4, required>=0.1 |
| `min_audit_budget_backlog` | `PASS` | Tight audit-budget fixtures should expose unmet audit demand instead of hiding capped spend. | audit_budget_backlog=15.6, required>=0.1 |
| `min_audit_budget_exhausted` | `PASS` | Tight audit-budget fixtures should record at least this many budget-exhausted epochs. | audit_budget_exhausted=8, required>=1 |
| `max_data_loss_events` | `PASS` | Durability invariant: stress may allow unavailable reads, but modeled data loss must stay at zero. | data_loss_events=0, required<=0 |
| `max_paid_corrupt_bytes` | `PASS` | Corrupt data must not earn payment. | paid_corrupt_bytes=0, required<=0 |

## Evidence Ledger Excerpt

These rows are representative raw evidence events. Use `evidence.csv` for the complete ledger.

| Epoch | Deal | Slot | Provider | Class | Reason | Consequence |
|---:|---:|---:|---|---|---|---|
| 1 | 1 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 1 | 1 | `sp-001` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 1 | 2 | `sp-002` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 1 | 3 | `sp-003` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 6 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 6 | 1 | `sp-001` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 6 | 2 | `sp-002` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 6 | 3 | `sp-003` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 11 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 11 | 1 | `sp-001` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 11 | 2 | `sp-002` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 11 | 3 | `sp-003` | `soft` | `quota_shortfall` | `repair_candidate` |
| ... | ... | ... | ... | ... | ... | `52` more events omitted |

## Generated Graphs

The following SVG graphs are generated beside this report and embedded here with relative Markdown links so the report is readable as a self-contained artifact in GitHub or a local Markdown viewer.

### Retrieval Success Rate

Should stay near 1.0 unless availability is actually lost.

![Retrieval Success Rate](graphs/retrieval_success_rate.svg)

### Slot State Transitions

Shows active slots and repair slots; spikes indicate reassignment churn.

![Slot State Transitions](graphs/slot_states.svg)

### Provider P&L

Shows aggregate provider economics over time.

![Provider P&L](graphs/provider_pnl.svg)

### Burn / Mint Ratio

Shows whether burns are material relative to minted rewards and audit budget.

![Burn / Mint Ratio](graphs/burn_mint_ratio.svg)

### Price Trajectory

Shows storage price and retrieval price movement under dynamic pricing.

![Price Trajectory](graphs/price_trajectory.svg)

### Storage Demand

Shows modeled new deal demand accepted versus rejected by price.

![Storage Demand](graphs/storage_demand.svg)

### Capacity Utilization

Shows active storage responsibility against modeled provider capacity.

![Capacity Utilization](graphs/capacity_utilization.svg)

### Saturation And Repair Pressure

Shows provider bandwidth saturation and repair backoffs, which are scale-specific stress signals.

![Saturation And Repair Pressure](graphs/saturation_and_repair.svg)

### Repair Backlog

Shows whether started repairs are accumulating faster than they complete.

![Repair Backlog](graphs/repair_backlog.svg)

### High-Bandwidth Promotion

Shows capability promotion/demotion state over time for hot-path eligibility.

![High-Bandwidth Promotion](graphs/high_bandwidth_promotion.svg)

### Hot Retrieval Routing

Shows whether hot retrieval attempts are being served by promoted high-bandwidth providers.

![Hot Retrieval Routing](graphs/hot_retrieval_routing.svg)

### Performance Tiers

Shows the fast positive tier and Fail-tier service counts under the performance market.

![Performance Tiers](graphs/performance_tiers.svg)

### Operator Concentration

Shows whether operator assignment share is bounded despite provider identity concentration.

![Operator Concentration](graphs/operator_concentration.svg)

### Evidence Pressure

Shows soft liveness evidence and hard invalid-proof evidence by epoch.

![Evidence Pressure](graphs/evidence_pressure.svg)

### Evidence Spam Economics

Shows bond burn and bounty payout for low-quality deputy evidence claims.

![Evidence Spam Economics](graphs/evidence_spam.svg)

### Audit Budget

Shows whether miss-driven audit demand is spending budget or accumulating carryover.

![Audit Budget](graphs/audit_budget.svg)

### Audit Backlog

Shows unmet audit demand and exhausted-budget epochs when evidence exceeds available enforcement budget.

![Audit Backlog](graphs/audit_backlog.svg)

### Elasticity Spend

Shows demand-funded elasticity spend and rejected expansion attempts.

![Elasticity Spend](graphs/elasticity_spend.svg)

## Raw Artifacts

- `summary.json`: compact machine-readable run summary.
- `epochs.csv`: per-epoch availability, liveness, reward, repair, and economics metrics.
- `providers.csv`: final provider-level economics, fault counters, and capability tier.
- `operators.csv`: final operator-level provider count, assignment share, success, and P&L metrics.
- `slots.csv`: per-slot epoch ledger, including health state and reason.
- `evidence.csv`: policy evidence events.
- `repairs.csv`: repair start, pending-provider readiness, completion, attempt-count, cooldown, candidate-exclusion, attempt-cap, and backoff events.
- `economy.csv`: per-epoch market and accounting ledger.
- `signals.json`: derived availability, saturation, repair, capacity, economic, regional, concentration, and provider bottleneck signals.
