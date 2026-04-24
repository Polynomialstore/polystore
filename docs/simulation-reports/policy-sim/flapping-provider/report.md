# Policy Simulation Report: Flapping Provider

## Executive Summary

**Verdict:** `PASS`. This run simulates `flapping-provider` with `48` providers, `80` data users, `24` deals, and an RS `8+4` layout for `10` epochs. Enforcement is configured as `REWARD_EXCLUSION`.

Model a provider with intermittent outages that recover before the delinquency threshold. This is the anti-thrash fixture: normal infrastructure jitter should create evidence and operator visibility without needless slot churn.

Expected policy behavior: Offline responses are visible, retrieval success stays high, no data loss occurs, and repair stays below the configured threshold.

Observed result: retrieval success was `100.00%`, reward coverage was `99.17%`, repairs started/ready/completed were `0` / `0` / `0`, and `0` providers ended with negative modeled P&L. The run recorded `0` unavailable reads, `0` modeled data-loss events, `0` bandwidth saturation responses and `0` repair backoffs across `0` repair attempts. Slot health recorded `24` suspect slot-epochs and `0` delinquent slot-epochs.

## Review Focus

Use this case to tune missed-epoch windows before treating sustained non-response as delinquency.

A human reviewer should focus less on the pass/fail label and more on whether the scenario, assertions, and threshold values encode the policy we actually want to enforce on-chain.

## Run Configuration

| Field | Value |
|---|---:|
| Seed | `31` |
| Providers | `48` |
| Data users | `80` |
| Deals | `24` |
| Epochs | `10` |
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
| Audit budget per epoch | `1.0000` | Minted audit budget; spending is capped by available budget and miss-driven demand. |
| Retrieval burn | `5.00%` | Fraction of variable retrieval fees burned before provider payout. |

## What Happened

User-facing retrieval availability stayed intact: every modeled retrieval completed successfully. That does not mean every provider behaved correctly; it means redundancy, routing, or deputy service absorbed the fault.

The policy layer recorded `46` evidence events: `46` soft events and `0` hard events. Soft evidence is suitable for repair and reward exclusion; hard evidence is the category that can later justify slashing or stronger sanctions.

No repair events occurred. For healthy or economic-only scenarios this is correct; for fault scenarios it may mean the policy is too passive.

Reward exclusion was active: `0.4800` modeled reward units were burned instead of paid to non-compliant slots.

The directly implicated provider set begins with: `sp-000`.

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
| Suspect / delinquent slot-epochs | `24` / `0` | Separates early warning state from threshold-crossed delinquency. |
| Final repair backlog | `0` slots | Started repairs minus completed repairs at run end. |
| Final storage utilization | `37.50%` | Active slots versus modeled provider capacity. |
| Provider utilization p50 / p90 / max | `37.50%` / `37.50%` / `37.50%` | Detects assignment concentration and capacity cliffs. |
| Provider P&L p10 / p50 / p90 | `1.0945` / `1.2390` / `1.3665` | Shows whether aggregate P&L hides marginal-provider distress. |
| Storage price start/end/range | `1.0000` -> `1.0000` (`1.0000`-`1.0000`) | Shows dynamic pricing movement and bounds. |
| Retrieval price start/end/range | `0.0100` -> `0.0100` (`0.0100`-`0.0100`) | Shows whether demand pressure moved retrieval pricing. |

### Regional Signals

| Region | Providers | Utilization | Offline Responses | Saturated Responses | Negative P&L Providers | Avg P&L |
|---|---:|---:|---:|---:|---:|---:|
| `global` | 48 | 37.50% | 44 | 0 | 0 | 1.2233 |

### Top Bottleneck Providers

| Provider | Region | Slots/Capacity | Utilization | Bandwidth Cap | Attempts | Offline | Saturated | P&L |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `sp-000` | `global` | 6/16 | 37.50% | 0 | 129 | 44 | 0 | 0.3425 |
| `sp-014` | `global` | 6/16 | 37.50% | 0 | 161 | 0 | 0 | 1.4685 |
| `sp-018` | `global` | 6/16 | 37.50% | 0 | 159 | 0 | 0 | 1.4515 |
| `sp-021` | `global` | 6/16 | 37.50% | 0 | 157 | 0 | 0 | 1.4345 |
| `sp-023` | `global` | 6/16 | 37.50% | 0 | 154 | 0 | 0 | 1.4090 |
| `sp-017` | `global` | 6/16 | 37.50% | 0 | 152 | 0 | 0 | 1.3920 |
| `sp-022` | `global` | 6/16 | 37.50% | 0 | 149 | 0 | 0 | 1.3665 |
| `sp-037` | `global` | 6/16 | 37.50% | 0 | 149 | 0 | 0 | 1.3665 |

### Timeline

| Epoch | Retrieval Success | Evidence | Repairs Started | Repairs Ready | Repairs Completed | Reward Burned | Provider P&L | Notes |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |
| 2 | 100.00% | 25 | 0 | 0 | 0 | 0.1200 | 5.8000 | 14 offline responses, 6 quota misses, 6 suspect slots |
| 3 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |
| 4 | 100.00% | 21 | 0 | 0 | 0 | 0.1200 | 5.8000 | 9 offline responses, 6 quota misses, 6 suspect slots |
| 5 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |
| 6 | 100.00% | 21 | 0 | 0 | 0 | 0.1200 | 5.8000 | 9 offline responses, 6 quota misses, 6 suspect slots |
| 7 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |
| 8 | 100.00% | 23 | 0 | 0 | 0 | 0.1200 | 5.8000 | 12 offline responses, 6 quota misses, 6 suspect slots |
| 9 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |
| 10 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |

## Enforcement Interpretation

The simulator recorded `46` evidence events and `0` repair ledger events. The first evidence epoch was `2` and the first repair-start epoch was `none`.

Evidence by reason:

- `quota_shortfall`: `24`
- `deputy_served_zero_direct`: `22`

Evidence by provider:

- `sp-000`: `46`

Repair summary:

- Repairs started: `0`
- Repairs marked ready: `0`
- Repairs completed: `0`
- Repair attempts: `0`
- Repair backoffs: `0`
- Repair cooldown backoffs: `0`
- Repair attempt-cap backoffs: `0`
- Suspect slot-epochs: `24`
- Delinquent slot-epochs: `0`
- Final active slots in last epoch: `288`

### Repair Ledger Excerpt

- No repair ledger events were recorded.

## Economic Interpretation

The run minted `67.6000` reward/audit units and burned `4.4800` units, for a burn-to-mint ratio of `6.63%`.

Providers earned `117.9200` in modeled revenue against `59.2000` in modeled cost, ending with aggregate P&L `58.7200`.

Retrieval accounting paid providers `60.8000`, burned `0.8000` in base fees, and burned `3.2000` in variable retrieval fees.

No provider ended with negative modeled P&L under the current assumptions.

Final modeled storage price was `1.0000` and retrieval price per slot was `0.0100`.

### Provider P&L Extremes

| Provider | Assigned Slots | Revenue | Cost | Slashed | P&L | Churn Risk |
|---|---:|---:|---:|---:|---:|---:|
| `sp-000` | 6 | 0.7200 + 0.8075 | 1.1850 | 0.0000 | 0.3425 | no |
| `sp-004` | 6 | 1.2000 + 1.0830 | 1.2140 | 0.0000 | 1.0690 | no |
| `sp-011` | 6 | 1.2000 + 1.0925 | 1.2150 | 0.0000 | 1.0775 | no |
| `sp-005` | 6 | 1.2000 + 1.1020 | 1.2160 | 0.0000 | 1.0860 | no |
| `sp-001` | 6 | 1.2000 + 1.1115 | 1.2170 | 0.0000 | 1.0945 | no |

## Assertion Contract

Assertions are the machine-readable policy contract for this fixture. Passing means this simulator run satisfied the current contract; it does not mean the policy is production-ready.

| Assertion | Status | Meaning | Detail |
|---|---|---|---|
| `min_success_rate` | `PASS` | Availability floor: user-facing reads must stay above this success rate. | success_rate=1, required>=0.99 |
| `min_offline_responses` | `PASS` | Custom assertion. Review the detail and fixture threshold. | offline_responses=44, required>=1 |
| `min_suspect_slots` | `PASS` | Health-state observability: soft failures should become suspect before punitive consequences. | suspect_slots=24, required>=1 |
| `max_delinquent_slots` | `PASS` | Transient jitter should not cross into delinquent slot state. | delinquent_slots=0, required<=0 |
| `max_repairs_started` | `PASS` | No-repair invariant for healthy baseline runs. | repairs_started=0, required<=0 |
| `max_data_loss_events` | `PASS` | Durability invariant: stress may allow unavailable reads, but modeled data loss must stay at zero. | data_loss_events=0, required<=0 |
| `max_paid_corrupt_bytes` | `PASS` | Corrupt data must not earn payment. | paid_corrupt_bytes=0, required<=0 |

## Evidence Ledger Excerpt

These rows are representative raw evidence events. Use `evidence.csv` for the complete ledger.

| Epoch | Deal | Slot | Provider | Class | Reason | Consequence |
|---:|---:|---:|---|---|---|---|
| 2 | 1 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 1 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 2 | 5 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 5 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 2 | 9 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 9 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 2 | 13 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 13 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 2 | 17 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 17 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 2 | 21 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 4 | 1 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| ... | ... | ... | ... | ... | ... | `34` more events omitted |

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

## Raw Artifacts

- `summary.json`: compact machine-readable run summary.
- `epochs.csv`: per-epoch availability, liveness, reward, repair, and economics metrics.
- `providers.csv`: final provider-level economics and fault counters.
- `slots.csv`: per-slot epoch ledger, including health state and reason.
- `evidence.csv`: policy evidence events.
- `repairs.csv`: repair start, pending-provider readiness, completion, attempt-count, cooldown, attempt-cap, and backoff events.
- `economy.csv`: per-epoch market and accounting ledger.
- `signals.json`: derived availability, saturation, repair, capacity, economic, regional, and provider bottleneck signals.
