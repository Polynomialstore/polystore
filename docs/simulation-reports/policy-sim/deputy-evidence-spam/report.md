# Policy Simulation Report: Deputy Evidence Spam

## Executive Summary

**Verdict:** `PASS`. This run simulates `deputy-evidence-spam` with `48` providers, `80` data users, `24` deals, and an RS `8+4` layout for `6` epochs. Enforcement is configured as `REWARD_EXCLUSION`.

Model a deputy submitting low-quality failure claims. The policy question is whether evidence bonds and conviction-gated bounties make spam uneconomic before evidence-market keeper code exists.

Expected policy behavior: Spam claims burn bond, unconvicted claims earn no bounty, net spam gain is non-positive, and no real provider is repaired or slashed.

Observed result: retrieval success was `100.00%`, reward coverage was `100.00%`, repairs started/ready/completed were `0` / `0` / `0`, and `0` providers ended with negative modeled P&L. The run recorded `0` unavailable reads, `0` modeled data-loss events, `0` bandwidth saturation responses and `0` repair backoffs across `0` repair attempts. Slot health recorded `0` suspect slot-epochs and `0` delinquent slot-epochs. High-bandwidth promotions were `0` and final high-bandwidth providers were `0`.

## Review Focus

Use this before implementing evidence bonds, burn-on-expiry, bounty payout, or deputy reputation state.

A human reviewer should focus less on the pass/fail label and more on whether the scenario, assertions, and threshold values encode the policy we actually want to enforce on-chain.

## Run Configuration

| Field | Value |
|---|---:|
| Seed | `41` |
| Providers | `48` |
| Data users | `80` |
| Deals | `24` |
| Epochs | `6` |
| Erasure coding | `K=8`, `M=4`, `N=12` |
| User MDUs per deal | `16` |
| Retrievals/user/epoch | `1` |
| Liveness quota | `2`-`8` blobs/slot/epoch |
| Repair delay | `2` epochs |
| Repair attempt cap/slot | `0` (`0` means unlimited) |
| Repair backoff window | `0` epochs |
| Dynamic pricing | `false` |
| Storage price | `1.0000` |
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
| Operators | `48` |
| Dominant operator provider share | `0.00%` |
| Operator assignment cap/deal | `0` (`0` means disabled) |
| Provider regions | `global` |

## Economic Assumptions

The economic model is intentionally simple and deterministic. It is useful for comparing policy directions, not for setting final token economics without external market data.

| Assumption | Value | Interpretation |
|---|---:|---|
| Storage price | `1.0000` | Unitless price applied by the controller; current simulator does not yet model user demand elasticity against this quote. |
| Storage target utilization | `70.00%` | If dynamic pricing is enabled, utilization above this target steps storage price up, otherwise down. |
| Retrieval price per slot | `0.0100` | Paid per successful provider slot served, before the configured variable burn. |
| Retrieval target per epoch | `80` | If dynamic pricing is enabled, retrieval attempts above this target step retrieval price up, otherwise down. |
| Dynamic pricing max step | `5.00%` | Per-epoch controller movement cap. Lower values are safer but slower to equilibrate. |
| Base reward per slot | `0.0200` | Modeled issuance/subsidy paid only to reward-eligible active slots. |
| Provider storage cost/slot/epoch | `0.0100` | Simplified provider cost basis; jitter may create marginal-provider distress. |
| Provider bandwidth cost/retrieval | `0.0010` | Simplified egress cost basis for retrieval-heavy scenarios. |
| Performance reward per serve | `0.0000` | Optional tiered QoS reward. Multipliers are applied by latency tier and Fail tier receives the configured fail multiplier. |
| Audit budget per epoch | `1.0000` | Minted audit budget; spending is capped by available budget and unmet miss-driven demand carries forward as backlog. |
| Evidence spam claims/epoch | `40` | Synthetic low-quality deputy claims used to test bond burn and bounty gating economics. |
| Evidence bond / bounty | `0.0500` / `0.2000` | Spam claims burn bond unless convicted; bounty is paid only on convicted evidence. |
| Retrieval burn | `5.00%` | Fraction of variable retrieval fees burned before provider payout. |

## What Happened

User-facing retrieval availability stayed intact: every modeled retrieval completed successfully. That does not mean every provider behaved correctly; it means redundancy, routing, or deputy service absorbed the fault.

The policy layer recorded `240` evidence events: `0` soft, `0` threshold, `0` hard, and `240` spam events. Soft evidence is suitable for repair and reward exclusion; hard or convicted threshold evidence is the category that can later justify slashing or stronger sanctions.

Deputy evidence spam was exercised: `240` low-quality claims burned `12.0000` in bond and paid `0.0000` in bounties, for spammer net gain `-12.0000`.

No repair events occurred. For healthy or economic-only scenarios this is correct; for fault scenarios it may mean the policy is too passive.

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
| Repair attempts | `0` | Counts bounded attempts to open a repair or discover replacement pressure. |
| Repair backoff pressure | `0` backoffs per started repair | Shows whether repair coordination is saturated. |
| Repair backoffs per attempt | `0` | Distinguishes capacity/cooldown pressure from successful repair starts. |
| Repair cooldowns / attempt caps | `0` / `0` | Shows whether throttling, rather than candidate selection alone, is bounding repair churn. |
| Suspect / delinquent slot-epochs | `0` / `0` | Separates early warning state from threshold-crossed delinquency. |
| Final repair backlog | `0` slots | Started repairs minus completed repairs at run end. |
| High-bandwidth providers | `0` | Providers currently eligible for hot/high-bandwidth routing. |
| High-bandwidth promotions/demotions | `0` / `0` | Shows capability changes under measured demand. |
| Hot high-bandwidth serves/retrieval | `0` | Measures whether hot retrievals actually use promoted providers. |
| Avg latency / Fail tier rate | `0` ms / `0.00%` | Separates correctness from QoS: slow-but-valid service can be available while still earning lower or no performance rewards. |
| Platinum / Gold / Silver / Fail serves | `0` / `0` / `0` / `0` | Shows the latency-tier distribution for performance-market policy. |
| Performance reward paid | `0.0000` | Quantifies the tiered QoS reward stream separately from baseline storage and retrieval settlement. |
| Provider latency p10 / p50 / p90 | `0` / `0` / `0` ms | Shows whether aggregate averages hide slow provider tails. |
| Audit demand / spent | `0.0000` / `0.0000` | Shows whether enforcement evidence consumed the available audit budget. |
| Audit backlog / exhausted epochs | `0.0000` / `0` | Makes budget exhaustion explicit instead of hiding unmet audit work behind capped spending. |
| Evidence spam claims / convictions | `240` / `0` | Shows whether the evidence-market spam fixture exercised low-quality claims and any successful convictions. |
| Evidence spam bond / net gain | `12.0000` / `-12.0000` | Spam should be negative-EV unless conviction-gated bounties justify the claim volume. |
| Top operator provider share | `2.08%` | Shows whether many SP identities are controlled by one operator. |
| Top operator assignment share | `2.08%` | Shows whether placement caps translate identity concentration into slot concentration. |
| Max operator slots/deal | `1` | Checks per-deal blast-radius limits against operator Sybil concentration. |
| Operator cap violations | `0` | Counts deals where operator slot concentration exceeded the configured cap. |
| Final storage utilization | `37.50%` | Active slots versus modeled provider capacity. |
| Provider utilization p50 / p90 / max | `37.50%` / `37.50%` / `37.50%` | Detects assignment concentration and capacity cliffs. |
| Provider P&L p10 / p50 / p90 | `0.6465` / `0.7230` / `0.8675` | Shows whether aggregate P&L hides marginal-provider distress. |
| Storage price start/end/range | `1.0000` -> `1.0000` (`1.0000`-`1.0000`) | Shows dynamic pricing movement and bounds. |
| Retrieval price start/end/range | `0.0100` -> `0.0100` (`0.0100`-`0.0100`) | Shows whether demand pressure moved retrieval pricing. |

### Regional Signals

| Region | Providers | Utilization | Offline Responses | Saturated Responses | Negative P&L Providers | Avg P&L |
|---|---:|---:|---:|---:|---:|---:|
| `global` | 48 | 37.50% | 0 | 0 | 0 | 0.7400 |

### Top Bottleneck Providers

| Provider | Region | Slots/Capacity | Utilization | Bandwidth Cap | Attempts | Offline | Saturated | P&L |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `sp-047` | `global` | 6/16 | 37.50% | 0 | 104 | 0 | 0 | 0.9440 |
| `sp-037` | `global` | 6/16 | 37.50% | 0 | 99 | 0 | 0 | 0.9015 |
| `sp-043` | `global` | 6/16 | 37.50% | 0 | 97 | 0 | 0 | 0.8845 |
| `sp-044` | `global` | 6/16 | 37.50% | 0 | 97 | 0 | 0 | 0.8845 |
| `sp-046` | `global` | 6/16 | 37.50% | 0 | 96 | 0 | 0 | 0.8760 |
| `sp-042` | `global` | 6/16 | 37.50% | 0 | 95 | 0 | 0 | 0.8675 |
| `sp-041` | `global` | 6/16 | 37.50% | 0 | 94 | 0 | 0 | 0.8590 |
| `sp-034` | `global` | 6/16 | 37.50% | 0 | 93 | 0 | 0 | 0.8505 |

### Top Operators

| Operator | Providers | Provider Share | Assigned Slots | Assignment Share | Retrieval Attempts | Success | P&L |
|---|---:|---:|---:|---:|---:|---:|---:|
| `op-000` | 1 | 2.08% | 6 | 2.08% | 75 | 100.00% | 0.6975 |
| `op-001` | 1 | 2.08% | 6 | 2.08% | 63 | 100.00% | 0.5955 |
| `op-002` | 1 | 2.08% | 6 | 2.08% | 66 | 100.00% | 0.6210 |
| `op-003` | 1 | 2.08% | 6 | 2.08% | 66 | 100.00% | 0.6210 |
| `op-004` | 1 | 2.08% | 6 | 2.08% | 66 | 100.00% | 0.6210 |
| `op-005` | 1 | 2.08% | 6 | 2.08% | 74 | 100.00% | 0.6890 |
| `op-006` | 1 | 2.08% | 6 | 2.08% | 70 | 100.00% | 0.6550 |
| `op-007` | 1 | 2.08% | 6 | 2.08% | 76 | 100.00% | 0.7060 |

### Timeline

| Epoch | Retrieval Success | Evidence | Repairs Started | Repairs Ready | Repairs Completed | Reward Burned | Provider P&L | Notes |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 100.00% | 40 | 0 | 0 | 0 | 0.0000 | 5.9200 | 40 evidence spam claims |
| 2 | 100.00% | 40 | 0 | 0 | 0 | 0.0000 | 5.9200 | 40 evidence spam claims |
| 3 | 100.00% | 40 | 0 | 0 | 0 | 0.0000 | 5.9200 | 40 evidence spam claims |
| 4 | 100.00% | 40 | 0 | 0 | 0 | 0.0000 | 5.9200 | 40 evidence spam claims |
| 5 | 100.00% | 40 | 0 | 0 | 0 | 0.0000 | 5.9200 | 40 evidence spam claims |
| 6 | 100.00% | 40 | 0 | 0 | 0 | 0.0000 | 5.9200 | 40 evidence spam claims |

## Enforcement Interpretation

The simulator recorded `240` evidence events and `0` repair ledger events. The first evidence epoch was `1` and the first repair-start epoch was `none`.

Evidence by reason:

- `deputy_evidence_spam`: `240`

Evidence by provider:

- `deputy-spammer`: `240`

Repair summary:

- Repairs started: `0`
- Repairs marked ready: `0`
- Repairs completed: `0`
- Repair attempts: `0`
- Repair backoffs: `0`
- Repair cooldown backoffs: `0`
- Repair attempt-cap backoffs: `0`
- Suspect slot-epochs: `0`
- Delinquent slot-epochs: `0`
- Final active slots in last epoch: `288`

Candidate exclusion summary:

- No no-candidate repair backoffs were recorded.

### Repair Ledger Excerpt

- No repair ledger events were recorded.

## Economic Interpretation

The run minted `40.5600` reward/audit units and burned `14.4000` units, for a burn-to-mint ratio of `35.50%`.

Providers earned `71.0400` in modeled revenue against `35.5200` in modeled cost, ending with aggregate P&L `35.5200`.

Retrieval accounting paid providers `36.4800`, burned `0.4800` in base fees, and burned `1.9200` in variable retrieval fees.

Performance-tier accounting paid `0.0000` in QoS rewards.

Audit accounting saw `0.0000` of demand, spent `0.0000`, and ended with `0.0000` backlog after `0` exhausted epochs.

Evidence-spam accounting burned `12.0000` in claim bonds, paid `0.0000` in conviction-gated bounties, and left the spammer with net gain `-12.0000`.

No provider ended with negative modeled P&L under the current assumptions.

Final modeled storage price was `1.0000` and retrieval price per slot was `0.0100`.

### Provider P&L Extremes

| Provider | Assigned Slots | Revenue | Cost | Slashed | P&L | Churn Risk |
|---|---:|---:|---:|---:|---:|---:|
| `sp-001` | 6 | 0.7200 + 0.5985 | 0.7230 | 0.0000 | 0.5955 | no |
| `sp-002` | 6 | 0.7200 + 0.6270 | 0.7260 | 0.0000 | 0.6210 | no |
| `sp-003` | 6 | 0.7200 + 0.6270 | 0.7260 | 0.0000 | 0.6210 | no |
| `sp-004` | 6 | 0.7200 + 0.6270 | 0.7260 | 0.0000 | 0.6210 | no |
| `sp-017` | 6 | 0.7200 + 0.6460 | 0.7280 | 0.0000 | 0.6380 | no |

## Assertion Contract

Assertions are the machine-readable policy contract for this fixture. Passing means this simulator run satisfied the current contract; it does not mean the policy is production-ready.

| Assertion | Status | Meaning | Detail |
|---|---|---|---|
| `min_success_rate` | `PASS` | Availability floor: user-facing reads must stay above this success rate. | success_rate=1, required>=1 |
| `min_evidence_spam_claims` | `PASS` | Evidence-market spam fixture must submit low-quality claims. | evidence_spam_claims=240, required>=1 |
| `min_evidence_spam_bond_burned` | `PASS` | Unconvicted evidence spam should burn a non-zero bond. | evidence_spam_bond_burned=12, required>=1 |
| `max_evidence_spam_bounty_paid` | `PASS` | Low-quality spam should not receive conviction-gated bounty payout. | evidence_spam_bounty_paid=0, required<=0 |
| `max_evidence_spam_net_gain` | `PASS` | Spam should be uneconomic or at least non-profitable under the modeled bond/bounty parameters. | evidence_spam_net_gain=-12, required<=0 |
| `max_repairs_started` | `PASS` | No-repair invariant for healthy baseline runs. | repairs_started=0, required<=0 |
| `max_provider_slashed` | `PASS` | Custom assertion. Review the detail and fixture threshold. | provider_slashed=0, required<=0 |
| `max_data_loss_events` | `PASS` | Durability invariant: stress may allow unavailable reads, but modeled data loss must stay at zero. | data_loss_events=0, required<=0 |

## Evidence Ledger Excerpt

These rows are representative raw evidence events. Use `evidence.csv` for the complete ledger.

| Epoch | Deal | Slot | Provider | Class | Reason | Consequence |
|---:|---:|---:|---|---|---|---|
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| 1 |  |  | `deputy-spammer` | `spam` | `deputy_evidence_spam` | `bond_burned` |
| ... | ... | ... | ... | ... | ... | `228` more events omitted |

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
