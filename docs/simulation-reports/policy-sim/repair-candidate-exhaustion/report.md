# Policy Simulation Report: Repair Candidate Exhaustion

## Executive Summary

**Verdict:** `PASS`. This run simulates `repair-candidate-exhaustion` with `12` providers, `80` data users, `8` deals, and an RS `8+4` layout for `8` epochs. Enforcement is configured as `REWARD_EXCLUSION`.

Model a network with no spare replacement capacity. The expected behavior is explicit repair backoff and operator visibility, not silent over-assignment.

Expected policy behavior: Repair backoffs are visible, provider capacity is respected, and data-loss events remain zero under the modeled fault.

Observed result: retrieval success was `100.00%`, reward coverage was `94.79%`, repairs started/completed were `0` / `0`, and `0` providers ended with negative modeled P&L. The run recorded `0` unavailable reads, `0` modeled data-loss events, `0` bandwidth saturation responses and `72` repair backoffs.

## Review Focus

Use this case to tune assignment headroom, repair attempt caps, and launch-provider minimums.

A human reviewer should focus less on the pass/fail label and more on whether the scenario, assertions, and threshold values encode the policy we actually want to enforce on-chain.

## Run Configuration

| Field | Value |
|---|---:|
| Seed | `37` |
| Providers | `12` |
| Data users | `80` |
| Deals | `8` |
| Epochs | `8` |
| Erasure coding | `K=8`, `M=4`, `N=12` |
| User MDUs per deal | `16` |
| Retrievals/user/epoch | `1` |
| Liveness quota | `2`-`8` blobs/slot/epoch |
| Repair delay | `2` epochs |
| Dynamic pricing | `false` |
| Storage price | `1.0000` |
| Retrieval price/slot | `0.0100` |
| Provider capacity range | `8`-`8` slots |
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

The policy layer recorded `80` evidence events: `80` soft events and `0` hard events. Soft evidence is suitable for repair and reward exclusion; hard evidence is the category that can later justify slashing or stronger sanctions.

Repair was exercised: `0` repair operations started and `0` completed. The simulator models this as make-before-break reassignment, so the old assignment remains visible while replacement work catches up.

Reward exclusion was active: `0.8000` modeled reward units were burned instead of paid to non-compliant slots.

Repair coordination was constrained: `72` repair attempts backed off because no candidate or repair-start budget was available.

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
| Repair completion ratio | `100.00%` | Measures whether healing catches up with detection. |
| Repair backoff pressure | `72` backoffs per started repair | Shows whether repair coordination is saturated. |
| Final repair backlog | `0` slots | Started repairs minus completed repairs at run end. |
| Final storage utilization | `100.00%` | Active slots versus modeled provider capacity. |
| Provider utilization p50 / p90 / max | `100.00%` / `100.00%` / `100.00%` | Detects assignment concentration and capacity cliffs. |
| Provider P&L p10 / p50 / p90 | `3.8950` / `4.0820` / `4.2435` | Shows whether aggregate P&L hides marginal-provider distress. |
| Storage price start/end/range | `1.0000` -> `1.0000` (`1.0000`-`1.0000`) | Shows dynamic pricing movement and bounds. |
| Retrieval price start/end/range | `0.0100` -> `0.0100` (`0.0100`-`0.0100`) | Shows whether demand pressure moved retrieval pricing. |

### Regional Signals

| Region | Providers | Utilization | Offline Responses | Saturated Responses | Negative P&L Providers | Avg P&L |
|---|---:|---:|---:|---:|---:|---:|
| `global` | 12 | 100.00% | 280 | 0 | 0 | 3.8000 |

### Top Bottleneck Providers

| Provider | Region | Slots/Capacity | Utilization | Bandwidth Cap | Attempts | Offline | Saturated | P&L |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `sp-000` | `global` | 8/8 | 100.00% | 0 | 444 | 280 | 0 | 0.8340 |
| `sp-008` | `global` | 8/8 | 100.00% | 0 | 471 | 0 | 0 | 4.2435 |
| `sp-011` | `global` | 8/8 | 100.00% | 0 | 471 | 0 | 0 | 4.2435 |
| `sp-009` | `global` | 8/8 | 100.00% | 0 | 460 | 0 | 0 | 4.1500 |
| `sp-002` | `global` | 8/8 | 100.00% | 0 | 457 | 0 | 0 | 4.1245 |
| `sp-004` | `global` | 8/8 | 100.00% | 0 | 453 | 0 | 0 | 4.0905 |
| `sp-010` | `global` | 8/8 | 100.00% | 0 | 452 | 0 | 0 | 4.0820 |
| `sp-001` | `global` | 8/8 | 100.00% | 0 | 446 | 0 | 0 | 4.0310 |

### Timeline

| Epoch | Retrieval Success | Evidence | Repairs Started | Repairs Completed | Reward Burned | Provider P&L | Notes |
|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 100.00% | 0 | 0 | 0 | 0.0000 | 5.8000 | steady state |
| 2 | 100.00% | 77 | 0 | 0 | 0.1600 | 5.6400 | 61 offline responses, 8 quota misses, 8 repair backoffs |
| 3 | 100.00% | 74 | 0 | 0 | 0.1600 | 5.6400 | 58 offline responses, 8 quota misses, 16 repair backoffs |
| 4 | 100.00% | 73 | 0 | 0 | 0.1600 | 5.6400 | 57 offline responses, 8 quota misses, 16 repair backoffs |
| 5 | 100.00% | 63 | 0 | 0 | 0.1600 | 5.6400 | 47 offline responses, 8 quota misses, 16 repair backoffs |
| 6 | 100.00% | 73 | 0 | 0 | 0.1600 | 5.6400 | 57 offline responses, 8 quota misses, 16 repair backoffs |
| 7 | 100.00% | 0 | 0 | 0 | 0.0000 | 5.8000 | steady state |
| 8 | 100.00% | 0 | 0 | 0 | 0.0000 | 5.8000 | steady state |

## Enforcement Interpretation

The simulator recorded `80` evidence events and `72` repair ledger events. The first evidence epoch was `2` and the first repair-start epoch was `none`.

Evidence by reason:

- `deputy_served_zero_direct`: `40`
- `quota_shortfall`: `40`

Evidence by provider:

- `sp-000`: `80`

Repair summary:

- Repairs started: `0`
- Repairs completed: `0`
- Repair backoffs: `72`
- Final active slots in last epoch: `96`

### Repair Ledger Excerpt

| Epoch | Event | Deal | Slot | Old Provider | New Provider | Reason |
|---:|---|---:|---:|---|---|---|
| 2 | `repair_backoff` | 1 | 0 | `sp-000` | `` | `no_candidate` |
| 2 | `repair_backoff` | 2 | 0 | `sp-000` | `` | `no_candidate` |
| 2 | `repair_backoff` | 3 | 0 | `sp-000` | `` | `no_candidate` |
| 2 | `repair_backoff` | 4 | 0 | `sp-000` | `` | `no_candidate` |
| 2 | `repair_backoff` | 5 | 0 | `sp-000` | `` | `no_candidate` |
| 2 | `repair_backoff` | 6 | 0 | `sp-000` | `` | `no_candidate` |
| 2 | `repair_backoff` | 7 | 0 | `sp-000` | `` | `no_candidate` |
| 2 | `repair_backoff` | 8 | 0 | `sp-000` | `` | `no_candidate` |
| 3 | `repair_backoff` | 1 | 0 | `sp-000` | `` | `no_candidate` |
| 3 | `repair_backoff` | 1 | 0 | `sp-000` | `` | `no_candidate` |
| 3 | `repair_backoff` | 2 | 0 | `sp-000` | `` | `no_candidate` |
| 3 | `repair_backoff` | 2 | 0 | `sp-000` | `` | `no_candidate` |
| ... | ... | ... | ... | ... | ... | `60` more events omitted |

## Economic Interpretation

The run minted `23.3600` reward/audit units and burned `4.0000` units, for a burn-to-mint ratio of `17.12%`.

Providers earned `63.2000` in modeled revenue against `17.6000` in modeled cost, ending with aggregate P&L `45.6000`.

Retrieval accounting paid providers `48.6400`, burned `0.6400` in base fees, and burned `2.5600` in variable retrieval fees.

No provider ended with negative modeled P&L under the current assumptions.

Final modeled storage price was `1.0000` and retrieval price per slot was `0.0100`.

### Provider P&L Extremes

| Provider | Assigned Slots | Revenue | Cost | Slashed | P&L | Churn Risk |
|---|---:|---:|---:|---:|---:|---:|
| `sp-000` | 8 | 0.4800 + 1.5580 | 1.2040 | 0.0000 | 0.8340 | no |
| `sp-003` | 8 | 1.2800 + 4.0850 | 1.4700 | 0.0000 | 3.8950 | no |
| `sp-006` | 8 | 1.2800 + 4.1230 | 1.4740 | 0.0000 | 3.9290 | no |
| `sp-005` | 8 | 1.2800 + 4.1420 | 1.4760 | 0.0000 | 3.9460 | no |
| `sp-001` | 8 | 1.2800 + 4.2370 | 1.4860 | 0.0000 | 4.0310 | no |

## Assertion Contract

Assertions are the machine-readable policy contract for this fixture. Passing means this simulator run satisfied the current contract; it does not mean the policy is production-ready.

| Assertion | Status | Meaning | Detail |
|---|---|---|---|
| `min_success_rate` | `PASS` | Availability floor: user-facing reads must stay above this success rate. | success_rate=1, required>=0.95 |
| `min_offline_responses` | `PASS` | Custom assertion. Review the detail and fixture threshold. | offline_responses=280, required>=1 |
| `min_repair_backoffs` | `PASS` | Scale fixture must expose healing coordination pressure. | repair_backoffs=72, required>=1 |
| `max_providers_over_capacity` | `PASS` | Assignment must respect modeled provider capacity. | providers_over_capacity=0, required<=0 |
| `max_data_loss_events` | `PASS` | Durability invariant: stress may allow unavailable reads, but modeled data loss must stay at zero. | data_loss_events=0, required<=0 |
| `max_paid_corrupt_bytes` | `PASS` | Corrupt data must not earn payment. | paid_corrupt_bytes=0, required<=0 |

## Evidence Ledger Excerpt

These rows are representative raw evidence events. Use `evidence.csv` for the complete ledger.

| Epoch | Deal | Slot | Provider | Class | Reason | Consequence |
|---:|---:|---:|---|---|---|---|
| 2 | 1 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 1 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 2 | 2 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 2 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 2 | 3 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 3 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 2 | 4 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 4 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 2 | 5 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 5 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 2 | 6 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 2 | 6 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| ... | ... | ... | ... | ... | ... | `68` more events omitted |

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
- `slots.csv`: per-slot epoch ledger.
- `evidence.csv`: policy evidence events.
- `repairs.csv`: repair start/completion events.
- `economy.csv`: per-epoch market and accounting ledger.
- `signals.json`: derived availability, saturation, repair, capacity, economic, regional, and provider bottleneck signals.
