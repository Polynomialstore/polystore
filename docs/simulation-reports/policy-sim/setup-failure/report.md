# Policy Simulation Report: Setup Phase Failure

## Executive Summary

**Verdict:** `PASS`. This run simulates `setup-failure` with `48` providers, `80` data users, `24` deals, and an RS `8+4` layout for `8` epochs. Enforcement is configured as `REWARD_EXCLUSION`.

Model a provider failing during early placement/upload setup. The policy concern is avoiding a bad initial assignment that leaves the deal under-replicated before steady-state liveness has much evidence.

Expected policy behavior: Early evidence should trigger repair while preserving availability and not expanding on-chain enforcement beyond simulated mode.

Observed result: retrieval success was `100.00%`, reward coverage was `99.74%`, repairs started/ready/completed were `6` / `6` / `6`, and `1` providers ended with negative modeled P&L. The run recorded `0` unavailable reads, `0` modeled data-loss events, `0` bandwidth saturation responses and `0` repair backoffs across `6` repair attempts.

## Review Focus

Use this to design provider admission and initial-deal health checks.

A human reviewer should focus less on the pass/fail label and more on whether the scenario, assertions, and threshold values encode the policy we actually want to enforce on-chain.

## Run Configuration

| Field | Value |
|---|---:|
| Seed | `11` |
| Providers | `48` |
| Data users | `80` |
| Deals | `24` |
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

The policy layer recorded `12` evidence events: `12` soft events and `0` hard events. Soft evidence is suitable for repair and reward exclusion; hard evidence is the category that can later justify slashing or stronger sanctions.

Repair was exercised: `6` repair operations started, `6` produced pending-provider readiness evidence, and `6` completed. The simulator models this as make-before-break reassignment, so the old assignment remains visible until replacement work catches up and the readiness gate is satisfied.

Reward exclusion was active: `0.1200` modeled reward units were burned instead of paid to non-compliant slots.

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
| Repair attempts | `6` | Counts bounded attempts to open a repair or discover replacement pressure. |
| Repair backoff pressure | `0` backoffs per started repair | Shows whether repair coordination is saturated. |
| Repair backoffs per attempt | `0` | Distinguishes capacity/cooldown pressure from successful repair starts. |
| Repair cooldowns / attempt caps | `0` / `0` | Shows whether throttling, rather than candidate selection alone, is bounding repair churn. |
| Final repair backlog | `0` slots | Started repairs minus completed repairs at run end. |
| Final storage utilization | `37.50%` | Active slots versus modeled provider capacity. |
| Provider utilization p50 / p90 / max | `37.50%` / `43.75%` / `43.75%` | Detects assignment concentration and capacity cliffs. |
| Provider P&L p10 / p50 / p90 | `0.9130` / `1.0065` / `1.1230` | Shows whether aggregate P&L hides marginal-provider distress. |
| Storage price start/end/range | `1.0000` -> `1.0000` (`1.0000`-`1.0000`) | Shows dynamic pricing movement and bounds. |
| Retrieval price start/end/range | `0.0100` -> `0.0100` (`0.0100`-`0.0100`) | Shows whether demand pressure moved retrieval pricing. |

### Regional Signals

| Region | Providers | Utilization | Offline Responses | Saturated Responses | Negative P&L Providers | Avg P&L |
|---|---:|---:|---:|---:|---:|---:|
| `global` | 48 | 37.50% | 15 | 0 | 1 | 0.9792 |

### Top Bottleneck Providers

| Provider | Region | Slots/Capacity | Utilization | Bandwidth Cap | Attempts | Offline | Saturated | P&L |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| `sp-000` | `global` | 0/16 | 0.00% | 0 | 15 | 15 | 0 | -0.5200 |
| `sp-022` | `global` | 7/16 | 43.75% | 0 | 132 | 0 | 0 | 1.2420 |
| `sp-045` | `global` | 7/16 | 43.75% | 0 | 131 | 0 | 0 | 1.2335 |
| `sp-039` | `global` | 6/16 | 37.50% | 0 | 124 | 0 | 0 | 1.1340 |
| `sp-014` | `global` | 7/16 | 43.75% | 0 | 122 | 0 | 0 | 1.1570 |
| `sp-037` | `global` | 7/16 | 43.75% | 0 | 120 | 0 | 0 | 1.1400 |
| `sp-032` | `global` | 7/16 | 43.75% | 0 | 118 | 0 | 0 | 1.1230 |
| `sp-033` | `global` | 6/16 | 37.50% | 0 | 118 | 0 | 0 | 1.0830 |

### Timeline

| Epoch | Retrieval Success | Evidence | Repairs Started | Repairs Ready | Repairs Completed | Reward Burned | Provider P&L | Notes |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 100.00% | 27 | 6 | 0 | 0 | 0.1200 | 5.8000 | 15 offline responses, 6 quota misses |
| 2 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.8000 | 6 slots repairing |
| 3 | 100.00% | 0 | 0 | 6 | 6 | 0.0000 | 5.8000 | 6 slots repairing |
| 4 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |
| 5 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |
| 6 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |
| 7 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |
| 8 | 100.00% | 0 | 0 | 0 | 0 | 0.0000 | 5.9200 | steady state |

## Enforcement Interpretation

The simulator recorded `12` evidence events and `18` repair ledger events. The first evidence epoch was `1` and the first repair-start epoch was `1`.

Evidence by reason:

- `deputy_served_zero_direct`: `6`
- `quota_shortfall`: `6`

Evidence by provider:

- `sp-000`: `12`

Repair summary:

- Repairs started: `6`
- Repairs marked ready: `6`
- Repairs completed: `6`
- Repair attempts: `6`
- Repair backoffs: `0`
- Repair cooldown backoffs: `0`
- Repair attempt-cap backoffs: `0`
- Final active slots in last epoch: `288`

### Repair Ledger Excerpt

| Epoch | Event | Deal | Slot | Old Provider | New Provider | Reason | Attempt | Cooldown Until |
|---:|---|---:|---:|---|---|---|---:|---:|
| 1 | `repair_started` | 1 | 0 | `sp-000` | `sp-045` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 5 | 0 | `sp-000` | `sp-037` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 9 | 0 | `sp-000` | `sp-022` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 13 | 0 | `sp-000` | `sp-032` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 17 | 0 | `sp-000` | `sp-041` | `deputy_served_zero_direct` | 1 | 0 |
| 1 | `repair_started` | 21 | 0 | `sp-000` | `sp-014` | `deputy_served_zero_direct` | 1 | 0 |
| 3 | `repair_ready` | 1 | 0 | `sp-000` | `sp-045` | `catchup_ready` | 1 | 0 |
| 3 | `repair_completed` | 1 | 0 | `sp-000` | `sp-045` | `catchup_complete` | 1 | 0 |
| 3 | `repair_ready` | 5 | 0 | `sp-000` | `sp-037` | `catchup_ready` | 1 | 0 |
| 3 | `repair_completed` | 5 | 0 | `sp-000` | `sp-037` | `catchup_complete` | 1 | 0 |
| 3 | `repair_ready` | 9 | 0 | `sp-000` | `sp-022` | `catchup_ready` | 1 | 0 |
| 3 | `repair_completed` | 9 | 0 | `sp-000` | `sp-022` | `catchup_complete` | 1 | 0 |
| ... | ... | ... | ... | ... | ... | `6` more events omitted | ... | ... |

## Economic Interpretation

The run minted `53.8400` reward/audit units and burned `3.3200` units, for a burn-to-mint ratio of `6.17%`.

Providers earned `94.3600` in modeled revenue against `47.3600` in modeled cost, ending with aggregate P&L `47.0000`.

Retrieval accounting paid providers `48.6400`, burned `0.6400` in base fees, and burned `2.5600` in variable retrieval fees.

`1` providers ended with negative P&L and `1` were marked as churn risk. That is economically important even when retrieval success is perfect.

Final modeled storage price was `1.0000` and retrieval price per slot was `0.0100`.

### Provider P&L Extremes

| Provider | Assigned Slots | Revenue | Cost | Slashed | P&L | Churn Risk |
|---|---:|---:|---:|---:|---:|---:|
| `sp-000` | 0 | 0.0000 + 0.0000 | 0.5200 | 0.0000 | -0.5200 | yes |
| `sp-002` | 6 | 0.9600 + 0.8835 | 0.9730 | 0.0000 | 0.8705 | no |
| `sp-027` | 6 | 0.9600 + 0.9025 | 0.9750 | 0.0000 | 0.8875 | no |
| `sp-007` | 6 | 0.9600 + 0.9120 | 0.9760 | 0.0000 | 0.8960 | no |
| `sp-004` | 6 | 0.9600 + 0.9215 | 0.9770 | 0.0000 | 0.9045 | no |

## Assertion Contract

Assertions are the machine-readable policy contract for this fixture. Passing means this simulator run satisfied the current contract; it does not mean the policy is production-ready.

| Assertion | Status | Meaning | Detail |
|---|---|---|---|
| `min_success_rate` | `PASS` | Availability floor: user-facing reads must stay above this success rate. | success_rate=1, required>=0.99 |
| `min_repairs_started` | `PASS` | Repair liveness: policy must start reassignment when evidence warrants it. | repairs_started=6, required>=1 |
| `min_repairs_ready` | `PASS` | Repair readiness: pending providers must produce catch-up evidence before promotion. | repairs_ready=6, required>=1 |
| `max_data_loss_events` | `PASS` | Durability invariant: stress may allow unavailable reads, but modeled data loss must stay at zero. | data_loss_events=0, required<=0 |
| `max_paid_corrupt_bytes` | `PASS` | Corrupt data must not earn payment. | paid_corrupt_bytes=0, required<=0 |

## Evidence Ledger Excerpt

These rows are representative raw evidence events. Use `evidence.csv` for the complete ledger.

| Epoch | Deal | Slot | Provider | Class | Reason | Consequence |
|---:|---:|---:|---|---|---|---|
| 1 | 1 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 1 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 5 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 5 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 9 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 9 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 13 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 13 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 17 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 17 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |
| 1 | 21 | 0 | `sp-000` | `soft` | `deputy_served_zero_direct` | `repair_candidate` |
| 1 | 21 | 0 | `sp-000` | `soft` | `quota_shortfall` | `repair_candidate` |

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
- `repairs.csv`: repair start, pending-provider readiness, completion, attempt-count, cooldown, attempt-cap, and backoff events.
- `economy.csv`: per-epoch market and accounting ledger.
- `signals.json`: derived availability, saturation, repair, capacity, economic, regional, and provider bottleneck signals.
