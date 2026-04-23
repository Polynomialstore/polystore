#!/usr/bin/env python3
"""Generate human-readable reports from policy simulator outputs.

The simulator owns deterministic raw artifacts. This tool consumes those
artifacts and writes Markdown plus small SVG charts without rerunning the
simulation.
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


SCENARIO_GUIDES = {
    "ideal": {
        "title": "Cooperative Baseline",
        "intent": (
            "Prove the simulator can represent a healthy network before any policing policy is trusted. "
            "All providers behave correctly, no repair should be needed, rewards should cover all eligible slots, "
            "and the economic ledger should not invent distress."
        ),
        "expected": "No evidence, no repairs, no invalid proofs, full retrieval success, and full reward coverage.",
        "review": "Use this as the control case for policy deltas. If this report shows churn or missing rewards, the harness is overfitting enforcement noise.",
    },
    "single-outage": {
        "title": "Single Provider Outage",
        "intent": (
            "Model an honest provider that becomes unavailable for several epochs. The policy question is whether "
            "the network can preserve user-facing availability while detecting the failing slot and performing make-before-break repair."
        ),
        "expected": "Retrievals remain available, soft evidence accumulates, affected slots are repaired, and the offline provider is not paid for missed work.",
        "review": "Check whether repair starts soon enough without overreacting to a short outage.",
    },
    "withholding": {
        "title": "Withholding Provider",
        "intent": (
            "Model a provider that stays nominally online but withholds retrieval responses and skips synthetic proof participation. "
            "This is a griefing case because the provider may try to appear present while forcing deputies or peers to absorb load."
        ),
        "expected": "The run should record withheld responses or deputy misses, exclude bad slots from rewards, and schedule repair without paying corrupt bytes.",
        "review": "Confirm that withholding is distinguishable from ordinary jitter before any real slashing policy is considered.",
    },
    "corrupt-provider": {
        "title": "Corrupt Provider",
        "intent": (
            "Model a provider returning bad data or invalid synthetic proofs. This is the hard-fault path where repair, reward exclusion, "
            "and simulated slashing should be visible."
        ),
        "expected": "Invalid proofs appear, corrupt bytes are not paid, repairs start, and simulated slash accounting is non-zero in slash mode.",
        "review": "Review this before keeper slashing work. This is the clearest fixture for evidence quality and punishment severity.",
    },
    "malicious-corrupt": {
        "title": "Corrupt Provider",
        "intent": (
            "Model a provider returning bad data or invalid synthetic proofs. This is the hard-fault path where repair, reward exclusion, "
            "and simulated slashing should be visible."
        ),
        "expected": "Invalid proofs appear, corrupt bytes are not paid, repairs start, and simulated slash accounting is non-zero in slash mode.",
        "review": "Review this before keeper slashing work. This is the clearest fixture for evidence quality and punishment severity.",
    },
    "lazy-provider": {
        "title": "Lazy Provider",
        "intent": (
            "Model a provider that does not satisfy liveness quota even when user-facing reads may still succeed. "
            "This tests whether the network detects free-riding on redundancy instead of only detecting outright retrieval failures."
        ),
        "expected": "Quota misses accumulate, rewards are withheld for non-compliant slots, and repair starts if laziness persists.",
        "review": "Check whether the quota threshold is calibrated or too punitive for normal low-traffic periods.",
    },
    "setup-failure": {
        "title": "Setup Phase Failure",
        "intent": (
            "Model a provider failing during early placement/upload setup. The policy concern is avoiding a bad initial assignment "
            "that leaves the deal under-replicated before steady-state liveness has much evidence."
        ),
        "expected": "Early evidence should trigger repair while preserving availability and not expanding on-chain enforcement beyond simulated mode.",
        "review": "Use this to design provider admission and initial-deal health checks.",
    },
    "underpriced-storage": {
        "title": "Underpriced Storage Market",
        "intent": (
            "Model a technically healthy network whose prices do not cover provider costs. This is not an availability failure; "
            "it is a market-equilibrium warning that rational providers would churn even though the protocol appears healthy."
        ),
        "expected": "Retrieval success remains high, but provider P&L turns negative and churn risk appears.",
        "review": "This fixture should force discussion of price floors, reward calibration, and dynamic pricing before production economics.",
    },
    "wash-retrieval": {
        "title": "Wash Retrieval Demand",
        "intent": (
            "Model artificial retrieval demand. The policy question is whether fake activity can farm rewards for free, "
            "or whether requester/session fees and burns make the attack costly."
        ),
        "expected": "Retrievals succeed, but base fees and variable burns are visible and non-zero.",
        "review": "Check whether burn and payout ratios are strong enough to make wash traffic irrational.",
    },
    "viral-public-retrieval": {
        "title": "Viral Public Retrieval Spike",
        "intent": (
            "Model a legitimate public-demand spike. The system should pay providers for real bandwidth, burn the configured fees, "
            "and avoid treating popularity as misbehavior."
        ),
        "expected": "High retrieval volume succeeds, provider payouts rise, and base burns are visible without unnecessary repair.",
        "review": "Use this to separate anti-wash controls from legitimate popularity handling.",
    },
    "elasticity-cap-hit": {
        "title": "Elasticity Cap Hit",
        "intent": (
            "Model demand above the user-funded elasticity budget. The desired behavior is fail-closed spending: the simulator should record "
            "rejections instead of silently exceeding the configured cap."
        ),
        "expected": "Elasticity rejections are visible and spend remains at or below the cap.",
        "review": "Confirm this matches product expectations for burst handling and user-funded capacity expansion.",
    },
    "large-scale-regional-stress": {
        "title": "Large-Scale Regional Stress",
        "intent": (
            "Model a population-scale network with more than one thousand storage providers and thousands of users. "
            "Providers have heterogeneous capacity, bandwidth, reliability, cost, region, and repair coordination probability. "
            "A correlated regional outage and dynamic pricing test whether network state, price, retrieval success, and healing remain stable under scale."
        ),
        "expected": "Availability should stay above the configured floor, price should remain bounded, saturation and repair backoffs should be visible, and no provider should be assigned above modeled capacity.",
        "review": "Use this report to inspect aggregate network state rather than a single bad actor: utilization, price trajectory, bandwidth saturation, repair throughput, and provider P&L distribution.",
    },
}


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_csv(path: Path) -> list[dict[str, str]]:
    if not path.exists() or path.stat().st_size == 0:
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def fnum(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def fint(value: Any) -> int:
    return int(round(fnum(value)))


def fmt_num(value: Any, digits: int = 4) -> str:
    number = fnum(value)
    if abs(number - round(number)) < 0.0000001:
        return str(int(round(number)))
    return f"{number:.{digits}f}"


def fmt_money(value: Any) -> str:
    return f"{fnum(value):.4f}"


def fmt_pct(value: Any) -> str:
    return f"{fnum(value) * 100:.2f}%"


def fmt_bps(value: Any) -> str:
    return fmt_pct(fnum(value) / 10_000)


def metric_sum(rows: list[dict[str, str]], key: str) -> float:
    return sum(fnum(row.get(key)) for row in rows)


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    sorted_values = sorted(values)
    idx = min(len(sorted_values) - 1, max(0, round((pct / 100) * (len(sorted_values) - 1))))
    return sorted_values[idx]


def first_epoch(rows: list[dict[str, str]], predicate) -> str:
    for row in rows:
        if predicate(row):
            return str(row.get("epoch", ""))
    return "none"


def scenario_guide(name: str) -> dict[str, str]:
    return SCENARIO_GUIDES.get(
        name,
        {
            "title": name.replace("-", " ").title(),
            "intent": "Custom simulator scenario. Review the configuration, evidence ledger, and assertion contract before drawing policy conclusions.",
            "expected": "Expected behavior is defined by the assertions bundled with this run.",
            "review": "Confirm the scenario is sufficiently specified before using it for keeper or e2e planning.",
        },
    )


def generate_run_report(run_dir: Path, out_dir: Path) -> None:
    summary = load_json(run_dir / "summary.json")
    epochs = load_csv(run_dir / "epochs.csv")
    providers = load_csv(run_dir / "providers.csv")
    slots = load_csv(run_dir / "slots.csv")
    evidence = load_csv(run_dir / "evidence.csv")
    repairs = load_csv(run_dir / "repairs.csv")
    economy = load_csv(run_dir / "economy.csv")
    out_dir.mkdir(parents=True, exist_ok=True)
    graphs_dir = out_dir / "graphs"
    graphs_dir.mkdir(exist_ok=True)

    signals = compute_signals(summary, epochs, providers, repairs, economy)
    (out_dir / "signals.json").write_text(json.dumps(signals, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    write_report_md(out_dir / "report.md", summary, epochs, providers, slots, evidence, repairs, economy)
    write_risk_register(out_dir / "risk_register.md", summary, providers, evidence, repairs, economy)
    write_graduation_report(out_dir / "graduation.md", summary)
    write_graphs(graphs_dir, epochs, economy)


def compute_signals(
    summary: dict[str, Any],
    epochs: list[dict[str, str]],
    providers: list[dict[str, str]],
    repairs: list[dict[str, str]],
    economy: list[dict[str, str]],
) -> dict[str, Any]:
    totals = summary["totals"]
    worst_epoch = min(epochs, key=lambda row: safe_rate(row, "retrieval_successes", "retrieval_attempts"), default={})
    peak_saturation_epoch = max(epochs, key=lambda row: fnum(row.get("saturated_responses")), default={})
    peak_repair_backoff_epoch = max(epochs, key=lambda row: fnum(row.get("repair_backoffs")), default={})
    peak_repairing_epoch = max(epochs, key=lambda row: fnum(row.get("repairing_slots")), default={})
    degraded_epochs = [
        row
        for row in epochs
        if safe_rate(row, "retrieval_successes", "retrieval_attempts") < 0.999
        or fnum(row.get("unavailable_reads")) > 0
    ]
    worst_epoch_number = int(fnum(worst_epoch.get("epoch"))) if worst_epoch else 0
    recovery_epoch = 0
    for row in epochs:
        epoch = int(fnum(row.get("epoch")))
        if epoch <= worst_epoch_number:
            continue
        if safe_rate(row, "retrieval_successes", "retrieval_attempts") >= 0.999 and fnum(row.get("unavailable_reads")) == 0:
            recovery_epoch = epoch
            break

    repair_started = fnum(totals.get("repairs_started"))
    repair_completed = fnum(totals.get("repairs_completed"))
    retrieval_attempts = max(1.0, fnum(totals.get("retrieval_attempts")))
    storage_prices = [fnum(row.get("storage_price")) for row in economy]
    retrieval_prices = [fnum(row.get("retrieval_price_per_slot")) for row in economy]
    capacity_utils = [fnum(row.get("capacity_utilization_bps")) for row in providers]
    pnls = [fnum(row.get("pnl")) for row in providers]
    bandwidth_caps = [fnum(row.get("bandwidth_capacity_per_epoch")) for row in providers if fnum(row.get("bandwidth_capacity_per_epoch")) > 0]
    online_probs = [fnum(row.get("online_probability")) for row in providers]
    assigned_slots = sum(fnum(row.get("assigned_slots")) for row in providers)
    capacity_slots = sum(fnum(row.get("capacity_slots")) for row in providers)
    regions = regional_signals(providers)

    return {
        "availability": {
            "success_rate": fnum(totals.get("success_rate")),
            "unavailable_reads": fnum(totals.get("unavailable_reads")),
            "worst_epoch": int(fnum(worst_epoch.get("epoch"))),
            "worst_epoch_success_rate": safe_rate(worst_epoch, "retrieval_successes", "retrieval_attempts") if worst_epoch else 0.0,
            "degraded_epochs": len(degraded_epochs),
            "recovery_epoch_after_worst": recovery_epoch,
        },
        "saturation": {
            "saturated_responses": fnum(totals.get("saturated_responses")),
            "saturation_per_retrieval_attempt": fnum(totals.get("saturated_responses")) / retrieval_attempts,
            "peak_saturation_epoch": int(fnum(peak_saturation_epoch.get("epoch"))),
            "peak_saturated_responses": fnum(peak_saturation_epoch.get("saturated_responses")),
        },
        "repair": {
            "started": repair_started,
            "completed": repair_completed,
            "completion_ratio": repair_completed / repair_started if repair_started else 1.0,
            "backoffs": fnum(totals.get("repair_backoffs")),
            "backoffs_per_started_repair": fnum(totals.get("repair_backoffs")) / max(1.0, repair_started),
            "peak_backoff_epoch": int(fnum(peak_repair_backoff_epoch.get("epoch"))),
            "peak_repair_backoffs": fnum(peak_repair_backoff_epoch.get("repair_backoffs")),
            "peak_repairing_epoch": int(fnum(peak_repairing_epoch.get("epoch"))),
            "peak_repairing_slots": fnum(peak_repairing_epoch.get("repairing_slots")),
            "final_repair_backlog": max(0.0, repair_started - repair_completed),
        },
        "capacity": {
            "assigned_slots": assigned_slots,
            "capacity_slots": capacity_slots,
            "final_utilization_bps": fnum(totals.get("final_storage_utilization_bps")),
            "providers_over_capacity": fnum(totals.get("providers_over_capacity")),
            "provider_capacity_utilization_p50_bps": percentile(capacity_utils, 50),
            "provider_capacity_utilization_p90_bps": percentile(capacity_utils, 90),
            "provider_capacity_utilization_max_bps": max(capacity_utils, default=0.0),
            "bandwidth_capacity_p10": percentile(bandwidth_caps, 10),
            "bandwidth_capacity_p50": percentile(bandwidth_caps, 50),
            "bandwidth_capacity_p90": percentile(bandwidth_caps, 90),
            "online_probability_p10": percentile(online_probs, 10),
            "online_probability_p50": percentile(online_probs, 50),
            "online_probability_p90": percentile(online_probs, 90),
        },
        "economics": {
            "provider_pnl": fnum(totals.get("provider_pnl")),
            "providers_negative_pnl": fnum(totals.get("providers_negative_pnl")),
            "provider_pnl_p10": percentile(pnls, 10),
            "provider_pnl_p50": percentile(pnls, 50),
            "provider_pnl_p90": percentile(pnls, 90),
            "storage_price_start": storage_prices[0] if storage_prices else 0.0,
            "storage_price_end": storage_prices[-1] if storage_prices else 0.0,
            "storage_price_min": min(storage_prices, default=0.0),
            "storage_price_max": max(storage_prices, default=0.0),
            "retrieval_price_start": retrieval_prices[0] if retrieval_prices else 0.0,
            "retrieval_price_end": retrieval_prices[-1] if retrieval_prices else 0.0,
            "retrieval_price_min": min(retrieval_prices, default=0.0),
            "retrieval_price_max": max(retrieval_prices, default=0.0),
        },
        "regions": regions,
        "top_bottleneck_providers": top_bottleneck_providers(providers),
    }


def regional_signals(providers: list[dict[str, str]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in providers:
        grouped[row.get("region", "unknown")].append(row)
    regions = []
    for region, rows in sorted(grouped.items()):
        assigned = sum(fnum(row.get("assigned_slots")) for row in rows)
        capacity = sum(fnum(row.get("capacity_slots")) for row in rows)
        pnls = [fnum(row.get("pnl")) for row in rows]
        regions.append(
            {
                "region": region,
                "providers": len(rows),
                "assigned_slots": assigned,
                "capacity_slots": capacity,
                "utilization_bps": int(assigned * 10_000 / max(1.0, capacity)),
                "offline_responses": sum(fnum(row.get("offline_responses")) for row in rows),
                "saturated_responses": sum(fnum(row.get("saturated_responses")) for row in rows),
                "negative_pnl_providers": sum(1 for row in rows if fnum(row.get("pnl")) < 0),
                "avg_provider_pnl": sum(pnls) / len(pnls) if pnls else 0.0,
            }
        )
    return regions


def top_bottleneck_providers(providers: list[dict[str, str]]) -> list[dict[str, Any]]:
    ranked = sorted(
        providers,
        key=lambda row: (
            fnum(row.get("saturated_responses"))
            + fnum(row.get("offline_responses"))
            + max(0.0, fnum(row.get("capacity_utilization_bps")) - 10_000) / 100,
            fnum(row.get("retrieval_attempts")),
        ),
        reverse=True,
    )
    out = []
    for row in ranked[:8]:
        out.append(
            {
                "provider_id": row.get("provider_id", ""),
                "region": row.get("region", ""),
                "assigned_slots": fnum(row.get("assigned_slots")),
                "capacity_slots": fnum(row.get("capacity_slots")),
                "capacity_utilization_bps": fnum(row.get("capacity_utilization_bps")),
                "bandwidth_capacity_per_epoch": fnum(row.get("bandwidth_capacity_per_epoch")),
                "retrieval_attempts": fnum(row.get("retrieval_attempts")),
                "offline_responses": fnum(row.get("offline_responses")),
                "saturated_responses": fnum(row.get("saturated_responses")),
                "pnl": fnum(row.get("pnl")),
            }
        )
    return out


def write_report_md(
    path: Path,
    summary: dict[str, Any],
    epochs: list[dict[str, str]],
    providers: list[dict[str, str]],
    slots: list[dict[str, str]],
    evidence: list[dict[str, str]],
    repairs: list[dict[str, str]],
    economy: list[dict[str, str]],
) -> None:
    config = summary["config"]
    totals = summary["totals"]
    assertions = summary.get("assertions", [])
    failed = [item for item in assertions if not item.get("passed")]
    negative_pnl = [p for p in providers if fnum(p.get("pnl")) < 0]
    churn_risk = [p for p in providers if fnum(p.get("churn_risk")) > 0]
    scenario = str(config["scenario"])
    guide = scenario_guide(scenario)
    evidence_by_reason = Counter(row.get("reason", "unknown") for row in evidence)
    evidence_by_provider = Counter(row.get("provider_id", "unknown") for row in evidence)
    repairs_started = [row for row in repairs if row.get("event") == "repair_started"]
    repairs_completed = [row for row in repairs if row.get("event") == "repair_completed"]
    worst_providers = sorted(providers, key=lambda row: fnum(row.get("pnl")))[:5]
    active_end_slots = [row for row in slots if row.get("epoch") == str(config.get("epochs")) and row.get("status") == "ACTIVE"]
    timeline_rows = build_timeline_rows(epochs)
    verdict = "PASS" if assertions and not failed else "NEEDS REVIEW"
    if not assertions:
        verdict = "UNASSERTED"
    signals = compute_signals(summary, epochs, providers, repairs, economy)

    lines = [
        f"# Policy Simulation Report: {guide['title']}",
        "",
        "## Executive Summary",
        "",
        f"**Verdict:** `{verdict}`. This run simulates `{scenario}` with `{config.get('providers')}` providers, "
        f"`{config.get('users')}` data users, `{config.get('deals')}` deals, and an RS `{config.get('k')}+{config.get('m')}` layout "
        f"for `{config.get('epochs')}` epochs. Enforcement is configured as `{config.get('enforcement_mode')}`.",
        "",
        guide["intent"],
        "",
        f"Expected policy behavior: {guide['expected']}",
        "",
        f"Observed result: retrieval success was `{fmt_pct(totals.get('success_rate'))}`, reward coverage was "
        f"`{fmt_pct(totals.get('reward_coverage'))}`, repairs started/completed were "
        f"`{fmt_num(totals.get('repairs_started'))}` / `{fmt_num(totals.get('repairs_completed'))}`, and "
        f"`{len(negative_pnl)}` providers ended with negative modeled P&L. The run also recorded "
        f"`{fmt_num(totals.get('saturated_responses'))}` bandwidth saturation responses and "
        f"`{fmt_num(totals.get('repair_backoffs'))}` repair backoffs.",
        "",
        "## Review Focus",
        "",
        guide["review"],
        "",
        "A human reviewer should focus less on the pass/fail label and more on whether the scenario, assertions, and threshold values encode the policy we actually want to enforce on-chain.",
        "",
        "## Run Configuration",
        "",
        "| Field | Value |",
        "|---|---:|",
        f"| Seed | `{config.get('seed')}` |",
        f"| Providers | `{config.get('providers')}` |",
        f"| Data users | `{config.get('users')}` |",
        f"| Deals | `{config.get('deals')}` |",
        f"| Epochs | `{config.get('epochs')}` |",
        f"| Erasure coding | `K={config.get('k')}`, `M={config.get('m')}`, `N={fint(config.get('k')) + fint(config.get('m'))}` |",
        f"| User MDUs per deal | `{config.get('user_mdus_per_deal')}` |",
        f"| Retrievals/user/epoch | `{config.get('retrievals_per_user_per_epoch')}` |",
        f"| Liveness quota | `{config.get('quota_min_blobs')}`-`{config.get('quota_max_blobs')}` blobs/slot/epoch |",
        f"| Repair delay | `{config.get('repair_epochs')}` epochs |",
        f"| Dynamic pricing | `{str(config.get('dynamic_pricing')).lower()}` |",
        f"| Storage price | `{fmt_money(config.get('storage_price'))}` |",
            f"| Retrieval price/slot | `{fmt_money(config.get('retrieval_price_per_slot'))}` |",
            f"| Provider capacity range | `{config.get('provider_capacity_min') or config.get('provider_slot_capacity')}`-`{config.get('provider_capacity_max') or config.get('provider_slot_capacity')}` slots |",
            f"| Provider bandwidth range | `{config.get('provider_bandwidth_capacity_min') or config.get('provider_bandwidth_capacity_per_epoch')}`-`{config.get('provider_bandwidth_capacity_max') or config.get('provider_bandwidth_capacity_per_epoch')}` serves/epoch (`0` means unlimited) |",
            f"| Provider regions | `{', '.join(str(item) for item in config.get('provider_regions', []))}` |",
            "",
        "## What Happened",
        "",
        build_behavior_narrative(totals, evidence, repairs, providers, economy),
        "",
        "## Diagnostic Signals",
        "",
        "These are derived from the raw CSV/JSON outputs and are intended to make scale behavior reviewable without manually scanning ledgers.",
        "",
        *diagnostic_signal_lines(signals),
        "",
        "### Regional Signals",
        "",
        *regional_signal_lines(signals),
        "",
        "### Top Bottleneck Providers",
        "",
        *bottleneck_provider_lines(signals),
        "",
        "### Timeline",
        "",
        "| Epoch | Retrieval Success | Evidence | Repairs Started | Repairs Completed | Reward Burned | Provider P&L | Notes |",
        "|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    lines.extend(timeline_rows)
    lines.extend(
        [
            "",
            "## Enforcement Interpretation",
            "",
            f"The simulator recorded `{len(evidence)}` evidence events and `{len(repairs)}` repair ledger events. "
            f"The first evidence epoch was `{first_epoch(evidence, lambda row: True)}` and the first repair-start epoch was "
            f"`{first_epoch(repairs, lambda row: row.get('event') == 'repair_started')}`.",
            "",
            "Evidence by reason:",
            "",
            *counter_lines(evidence_by_reason),
            "",
            "Evidence by provider:",
            "",
            *counter_lines(evidence_by_provider),
            "",
            "Repair summary:",
            "",
            f"- Repairs started: `{len(repairs_started)}`",
            f"- Repairs completed: `{len(repairs_completed)}`",
            f"- Repair backoffs: `{fmt_num(totals.get('repair_backoffs'))}`",
            f"- Final active slots in last epoch: `{len(active_end_slots)}`",
            "",
            "### Repair Ledger Excerpt",
            "",
            *repair_excerpt_lines(repairs),
            "",
            "## Economic Interpretation",
            "",
            build_economic_narrative(totals, providers, economy, negative_pnl, churn_risk),
            "",
            "### Provider P&L Extremes",
            "",
            "| Provider | Assigned Slots | Revenue | Cost | Slashed | P&L | Churn Risk |",
            "|---|---:|---:|---:|---:|---:|---:|",
            *provider_lines(worst_providers),
            "",
            "## Assertion Contract",
            "",
            "Assertions are the machine-readable policy contract for this fixture. Passing means this simulator run satisfied the current contract; it does not mean the policy is production-ready.",
            "",
            "| Assertion | Status | Meaning | Detail |",
            "|---|---|---|---|",
            *assertion_lines(assertions),
            "",
            "## Evidence Ledger Excerpt",
            "",
            "These rows are representative raw evidence events. Use `evidence.csv` for the complete ledger.",
            "",
            "| Epoch | Deal | Slot | Provider | Class | Reason | Consequence |",
            "|---:|---:|---:|---|---|---|---|",
            *evidence_excerpt_lines(evidence),
            "",
            "## Generated Graphs",
            "",
            "The following SVG graphs are generated beside this report and embedded here with relative Markdown links so the report is readable as a self-contained artifact in GitHub or a local Markdown viewer.",
            "",
            "### Retrieval Success Rate",
            "",
            "Should stay near 1.0 unless availability is actually lost.",
            "",
            "![Retrieval Success Rate](graphs/retrieval_success_rate.svg)",
            "",
            "### Slot State Transitions",
            "",
            "Shows active slots and repair slots; spikes indicate reassignment churn.",
            "",
            "![Slot State Transitions](graphs/slot_states.svg)",
            "",
            "### Provider P&L",
            "",
            "Shows aggregate provider economics over time.",
            "",
            "![Provider P&L](graphs/provider_pnl.svg)",
            "",
            "### Burn / Mint Ratio",
            "",
            "Shows whether burns are material relative to minted rewards and audit budget.",
            "",
            "![Burn / Mint Ratio](graphs/burn_mint_ratio.svg)",
            "",
            "### Price Trajectory",
            "",
            "Shows storage price and retrieval price movement under dynamic pricing.",
            "",
            "![Price Trajectory](graphs/price_trajectory.svg)",
            "",
            "### Capacity Utilization",
            "",
            "Shows active storage responsibility against modeled provider capacity.",
            "",
            "![Capacity Utilization](graphs/capacity_utilization.svg)",
            "",
            "### Saturation And Repair Pressure",
            "",
            "Shows provider bandwidth saturation and repair backoffs, which are scale-specific stress signals.",
            "",
            "![Saturation And Repair Pressure](graphs/saturation_and_repair.svg)",
            "",
            "### Repair Backlog",
            "",
            "Shows whether started repairs are accumulating faster than they complete.",
            "",
            "![Repair Backlog](graphs/repair_backlog.svg)",
            "",
            "## Raw Artifacts",
            "",
            "- `summary.json`: compact machine-readable run summary.",
            "- `epochs.csv`: per-epoch availability, liveness, reward, repair, and economics metrics.",
            "- `providers.csv`: final provider-level economics and fault counters.",
            "- `slots.csv`: per-slot epoch ledger.",
            "- `evidence.csv`: policy evidence events.",
            "- `repairs.csv`: repair start/completion events.",
            "- `economy.csv`: per-epoch market and accounting ledger.",
            "- `signals.json`: derived availability, saturation, repair, capacity, economic, regional, and provider bottleneck signals.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_behavior_narrative(
    totals: dict[str, Any],
    evidence: list[dict[str, str]],
    repairs: list[dict[str, str]],
    providers: list[dict[str, str]],
    economy: list[dict[str, str]],
) -> str:
    parts = []
    if fnum(totals.get("success_rate")) >= 1.0:
        if evidence or repairs:
            parts.append(
                "User-facing retrieval availability stayed intact: every modeled retrieval completed successfully. "
                "That does not mean every provider behaved correctly; it means redundancy, routing, or deputy service absorbed the fault."
            )
        else:
            parts.append(
                "User-facing retrieval availability stayed intact and no operational enforcement evidence was recorded. "
                "For this run, the main question is the scenario-specific control or economic result rather than recovery from a provider fault."
            )
    else:
        parts.append(
            f"Availability was degraded: the run succeeded on `{fmt_pct(totals.get('success_rate'))}` of retrievals and recorded "
            f"`{fmt_num(totals.get('unavailable_reads'))}` unavailable reads."
        )

    soft_evidence = sum(1 for row in evidence if row.get("evidence_class") == "soft")
    hard_evidence = sum(1 for row in evidence if row.get("evidence_class") == "hard")
    if evidence:
        parts.append(
            f"The policy layer recorded `{len(evidence)}` evidence events: `{soft_evidence}` soft events and `{hard_evidence}` hard events. "
            "Soft evidence is suitable for repair and reward exclusion; hard evidence is the category that can later justify slashing or stronger sanctions."
        )
    else:
        parts.append("The policy layer recorded no evidence events, which is expected only for cooperative or pure-market control scenarios.")

    if repairs:
        started = sum(1 for row in repairs if row.get("event") == "repair_started")
        completed = sum(1 for row in repairs if row.get("event") == "repair_completed")
        parts.append(
            f"Repair was exercised: `{started}` repair operations started and `{completed}` completed. "
            "The simulator models this as make-before-break reassignment, so the old assignment remains visible while replacement work catches up."
        )
    else:
        parts.append("No repair events occurred. For healthy or economic-only scenarios this is correct; for fault scenarios it may mean the policy is too passive.")

    if fnum(totals.get("reward_burned")) > 0:
        parts.append(
            f"Reward exclusion was active: `{fmt_money(totals.get('reward_burned'))}` modeled reward units were burned instead of paid to non-compliant slots."
        )
    if fnum(totals.get("provider_slashed")) > 0:
        parts.append(
            f"Simulated slashing was active: providers lost `{fmt_money(totals.get('provider_slashed'))}` bond units in aggregate."
        )
    if fnum(totals.get("saturated_responses")) > 0:
        parts.append(
            f"Provider bandwidth constraints mattered: the run recorded `{fmt_num(totals.get('saturated_responses'))}` saturated provider responses. "
            "That is a scale signal, not necessarily malicious behavior."
        )
    if fnum(totals.get("repair_backoffs")) > 0:
        parts.append(
            f"Repair coordination was constrained: `{fmt_num(totals.get('repair_backoffs'))}` repair attempts backed off because no candidate or repair-start budget was available."
        )
    if metric_sum(economy, "elasticity_rejections") > 0:
        parts.append(
            f"Elasticity spend failed closed: `{fmt_num(metric_sum(economy, 'elasticity_rejections'))}` expansion attempts were rejected rather than exceeding the cap."
        )

    faulty = [
        row
        for row in providers
        if fnum(row.get("offline_responses")) or fnum(row.get("withheld_responses")) or fnum(row.get("corrupt_responses")) or fnum(row.get("hard_faults"))
    ]
    if faulty:
        ids = ", ".join(row.get("provider_id", "") for row in faulty[:5])
        parts.append(f"The directly implicated provider set begins with: `{ids}`.")

    return "\n\n".join(parts)


def diagnostic_signal_lines(signals: dict[str, Any]) -> list[str]:
    availability = signals["availability"]
    saturation = signals["saturation"]
    repair = signals["repair"]
    capacity = signals["capacity"]
    economics = signals["economics"]
    return [
        "| Signal | Value | Why It Matters |",
        "|---|---:|---|",
        f"| Worst epoch success | `{fmt_pct(availability['worst_epoch_success_rate'])}` at epoch `{availability['worst_epoch']}` | Identifies the availability cliff instead of hiding it in aggregate success. |",
        f"| Degraded epochs | `{fmt_num(availability['degraded_epochs'])}` | Counts epochs with unavailable reads or success below 99.9%. |",
        f"| Recovery epoch after worst | `{availability['recovery_epoch_after_worst'] or 'not recovered'}` | Shows whether the network returned to clean steady state after the worst point. |",
        f"| Saturation rate | `{fmt_pct(saturation['saturation_per_retrieval_attempt'])}` | Provider bandwidth saturation per retrieval attempt. |",
        f"| Peak saturation | `{fmt_num(saturation['peak_saturated_responses'])}` at epoch `{saturation['peak_saturation_epoch']}` | Reveals when bandwidth, not storage correctness, became the bottleneck. |",
        f"| Repair completion ratio | `{fmt_pct(repair['completion_ratio'])}` | Measures whether healing catches up with detection. |",
        f"| Repair backoff pressure | `{fmt_num(repair['backoffs_per_started_repair'])}` backoffs per started repair | Shows whether repair coordination is saturated. |",
        f"| Final repair backlog | `{fmt_num(repair['final_repair_backlog'])}` slots | Started repairs minus completed repairs at run end. |",
        f"| Final storage utilization | `{fmt_bps(capacity['final_utilization_bps'])}` | Active slots versus modeled provider capacity. |",
        f"| Provider utilization p50 / p90 / max | `{fmt_bps(capacity['provider_capacity_utilization_p50_bps'])}` / `{fmt_bps(capacity['provider_capacity_utilization_p90_bps'])}` / `{fmt_bps(capacity['provider_capacity_utilization_max_bps'])}` | Detects assignment concentration and capacity cliffs. |",
        f"| Provider P&L p10 / p50 / p90 | `{fmt_money(economics['provider_pnl_p10'])}` / `{fmt_money(economics['provider_pnl_p50'])}` / `{fmt_money(economics['provider_pnl_p90'])}` | Shows whether aggregate P&L hides marginal-provider distress. |",
        f"| Storage price start/end/range | `{fmt_money(economics['storage_price_start'])}` -> `{fmt_money(economics['storage_price_end'])}` (`{fmt_money(economics['storage_price_min'])}`-`{fmt_money(economics['storage_price_max'])}`) | Shows dynamic pricing movement and bounds. |",
        f"| Retrieval price start/end/range | `{fmt_money(economics['retrieval_price_start'])}` -> `{fmt_money(economics['retrieval_price_end'])}` (`{fmt_money(economics['retrieval_price_min'])}`-`{fmt_money(economics['retrieval_price_max'])}`) | Shows whether demand pressure moved retrieval pricing. |",
    ]


def regional_signal_lines(signals: dict[str, Any]) -> list[str]:
    regions = signals.get("regions", [])
    if not regions:
        return ["- No regional provider metadata was recorded."]
    lines = [
        "| Region | Providers | Utilization | Offline Responses | Saturated Responses | Negative P&L Providers | Avg P&L |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in regions:
        lines.append(
            f"| `{row['region']}` | {fmt_num(row['providers'])} | {fmt_bps(row['utilization_bps'])} | "
            f"{fmt_num(row['offline_responses'])} | {fmt_num(row['saturated_responses'])} | "
            f"{fmt_num(row['negative_pnl_providers'])} | {fmt_money(row['avg_provider_pnl'])} |"
        )
    return lines


def bottleneck_provider_lines(signals: dict[str, Any]) -> list[str]:
    providers = signals.get("top_bottleneck_providers", [])
    if not providers:
        return ["- No provider bottleneck rows were recorded."]
    lines = [
        "| Provider | Region | Slots/Capacity | Utilization | Bandwidth Cap | Attempts | Offline | Saturated | P&L |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in providers:
        lines.append(
            f"| `{row['provider_id']}` | `{row['region']}` | {fmt_num(row['assigned_slots'])}/{fmt_num(row['capacity_slots'])} | "
            f"{fmt_bps(row['capacity_utilization_bps'])} | {fmt_num(row['bandwidth_capacity_per_epoch'])} | "
            f"{fmt_num(row['retrieval_attempts'])} | {fmt_num(row['offline_responses'])} | "
            f"{fmt_num(row['saturated_responses'])} | {fmt_money(row['pnl'])} |"
        )
    return lines


def build_timeline_rows(epochs: list[dict[str, str]]) -> list[str]:
    rows = []
    for row in epochs:
        evidence_count = (
            fnum(row.get("quota_misses"))
            + fnum(row.get("deputy_misses"))
            + fnum(row.get("invalid_proofs"))
            + fnum(row.get("withheld_responses"))
            + fnum(row.get("offline_responses"))
            + fnum(row.get("corrupt_responses"))
            + fnum(row.get("saturated_responses"))
        )
        notes = []
        if fnum(row.get("offline_responses")):
            notes.append(f"{fmt_num(row.get('offline_responses'))} offline responses")
        if fnum(row.get("withheld_responses")):
            notes.append(f"{fmt_num(row.get('withheld_responses'))} withheld")
        if fnum(row.get("invalid_proofs")):
            notes.append(f"{fmt_num(row.get('invalid_proofs'))} invalid proofs")
        if fnum(row.get("saturated_responses")):
            notes.append(f"{fmt_num(row.get('saturated_responses'))} saturated")
        if fnum(row.get("quota_misses")):
            notes.append(f"{fmt_num(row.get('quota_misses'))} quota misses")
        if fnum(row.get("repair_backoffs")):
            notes.append(f"{fmt_num(row.get('repair_backoffs'))} repair backoffs")
        if fnum(row.get("repairing_slots")):
            notes.append(f"{fmt_num(row.get('repairing_slots'))} slots repairing")
        if not notes:
            notes.append("steady state")
        rows.append(
            "| {epoch} | {success} | {evidence} | {started} | {completed} | {burned} | {pnl} | {notes} |".format(
                epoch=row.get("epoch", ""),
                success=fmt_pct(safe_rate(row, "retrieval_successes", "retrieval_attempts")),
                evidence=fmt_num(evidence_count),
                started=fmt_num(row.get("repairs_started")),
                completed=fmt_num(row.get("repairs_completed")),
                burned=fmt_money(row.get("reward_burned")),
                pnl=fmt_money(row.get("provider_pnl")),
                notes=", ".join(notes),
            )
        )
    return rows or ["| n/a | n/a | n/a | n/a | n/a | n/a | n/a | no epoch rows |"]


def counter_lines(counter: Counter[str]) -> list[str]:
    if not counter:
        return ["- None recorded."]
    return [f"- `{key}`: `{value}`" for key, value in counter.most_common(8)]


def repair_excerpt_lines(repairs: list[dict[str, str]]) -> list[str]:
    if not repairs:
        return ["- No repair ledger events were recorded."]
    lines = ["| Epoch | Event | Deal | Slot | Old Provider | New Provider | Reason |", "|---:|---|---:|---:|---|---|---|"]
    for row in repairs[:12]:
        lines.append(
            f"| {row.get('epoch', '')} | `{row.get('event', '')}` | {row.get('deal_id', '')} | {row.get('slot', '')} | "
            f"`{row.get('old_provider', '')}` | `{row.get('new_provider', '')}` | `{row.get('reason', '')}` |"
        )
    if len(repairs) > 12:
        lines.append(f"| ... | ... | ... | ... | ... | ... | `{len(repairs) - 12}` more events omitted |")
    return lines


def provider_lines(providers: list[dict[str, str]]) -> list[str]:
    if not providers:
        return ["| n/a | n/a | n/a | n/a | n/a | n/a | n/a |"]
    return [
        "| {provider} | {slots} | {revenue} | {cost} | {slashed} | {pnl} | {risk} |".format(
            provider=f"`{row.get('provider_id', '')}`",
            slots=fmt_num(row.get("assigned_slots")),
            revenue=fmt_money(row.get("reward_revenue")) + " + " + fmt_money(row.get("retrieval_revenue")),
            cost=fmt_money(row.get("total_cost")),
            slashed=fmt_money(row.get("slashed")),
            pnl=fmt_money(row.get("pnl")),
            risk="yes" if fnum(row.get("churn_risk")) else "no",
        )
        for row in providers
    ]


def assertion_meaning(name: str) -> str:
    meanings = {
        "min_success_rate": "Availability floor: user-facing reads must stay above this success rate.",
        "max_success_rate": "Control bound: used when the scenario is not intended to prove availability loss.",
        "max_repairs_started": "No-repair invariant for healthy baseline runs.",
        "min_repairs_started": "Repair liveness: policy must start reassignment when evidence warrants it.",
        "min_repairs_completed": "Repair completion: make-before-break reassignment must finish within the run.",
        "max_quota_misses": "Healthy providers should not miss liveness quota.",
        "min_quota_misses": "Fault fixture must generate quota evidence.",
        "max_invalid_proofs": "Healthy providers should never produce invalid proofs.",
        "min_invalid_proofs": "Hard-fault fixture must generate invalid-proof evidence.",
        "max_paid_corrupt_bytes": "Corrupt data must not earn payment.",
        "min_reward_coverage": "Healthy slots should receive the expected rewards.",
        "min_provider_slashed": "Simulated slashing must affect hard-fault providers.",
        "min_providers_negative_pnl": "Market warning: some providers must become economically distressed.",
        "min_retrieval_base_burned": "Requester/session demand must pay a non-zero base burn.",
        "min_retrieval_variable_burned": "Variable retrieval activity must contribute non-zero burn.",
        "min_retrieval_provider_payouts": "Legitimate high demand must pay providers for bandwidth.",
        "min_elasticity_rejections": "Spend cap must reject excess elasticity demand.",
        "max_elasticity_spent": "Elasticity spend must not exceed the configured cap.",
        "min_withheld_responses": "Withholding fixture must create visible withheld-response evidence.",
        "min_saturated_responses": "Scale fixture must expose provider bandwidth saturation.",
        "min_repair_backoffs": "Scale fixture must expose healing coordination pressure.",
        "max_providers_over_capacity": "Assignment must respect modeled provider capacity.",
        "min_final_storage_utilization_bps": "Network utilization should be high enough to make pricing/healing meaningful.",
        "max_final_storage_utilization_bps": "Network utilization should remain below the capacity cliff.",
    }
    return meanings.get(name, "Custom assertion. Review the detail and fixture threshold.")


def assertion_lines(assertions: list[dict[str, Any]]) -> list[str]:
    if not assertions:
        return ["| none | `UNASSERTED` | No assertion contract was recorded. | n/a |"]
    lines = []
    for item in assertions:
        status = "PASS" if item.get("passed") else "FAIL"
        name = str(item.get("name", ""))
        lines.append(f"| `{name}` | `{status}` | {assertion_meaning(name)} | {item.get('detail', '')} |")
    return lines


def evidence_excerpt_lines(evidence: list[dict[str, str]]) -> list[str]:
    if not evidence:
        return ["| n/a | n/a | n/a | n/a | n/a | n/a | No evidence events were recorded. |"]
    lines = []
    for row in evidence[:12]:
        lines.append(
            f"| {row.get('epoch', '')} | {row.get('deal_id', '')} | {row.get('slot', '')} | `{row.get('provider_id', '')}` | "
            f"`{row.get('evidence_class', '')}` | `{row.get('reason', '')}` | `{row.get('consequence', '')}` |"
        )
    if len(evidence) > 12:
        lines.append(f"| ... | ... | ... | ... | ... | ... | `{len(evidence) - 12}` more events omitted |")
    return lines


def build_economic_narrative(
    totals: dict[str, Any],
    providers: list[dict[str, str]],
    economy: list[dict[str, str]],
    negative_pnl: list[dict[str, str]],
    churn_risk: list[dict[str, str]],
) -> str:
    retrieval_burned = fnum(totals.get("retrieval_base_burned")) + fnum(totals.get("retrieval_variable_burned"))
    minted = fnum(totals.get("reward_pool_minted")) + fnum(totals.get("audit_budget_minted"))
    burned = retrieval_burned + fnum(totals.get("reward_burned"))
    burn_ratio = burned / minted if minted else 0.0
    parts = [
        f"The run minted `{fmt_money(minted)}` reward/audit units and burned `{fmt_money(burned)}` units, "
        f"for a burn-to-mint ratio of `{fmt_pct(burn_ratio)}`.",
        f"Providers earned `{fmt_money(totals.get('provider_revenue'))}` in modeled revenue against `{fmt_money(totals.get('provider_cost'))}` in modeled cost, "
        f"ending with aggregate P&L `{fmt_money(totals.get('provider_pnl'))}`.",
        f"Retrieval accounting paid providers `{fmt_money(totals.get('retrieval_provider_payouts'))}`, burned `{fmt_money(totals.get('retrieval_base_burned'))}` in base fees, "
        f"and burned `{fmt_money(totals.get('retrieval_variable_burned'))}` in variable retrieval fees.",
    ]
    if negative_pnl:
        parts.append(
            f"`{len(negative_pnl)}` providers ended with negative P&L and `{len(churn_risk)}` were marked as churn risk. "
            "That is economically important even when retrieval success is perfect."
        )
    else:
        parts.append("No provider ended with negative modeled P&L under the current assumptions.")
    if economy:
        last = economy[-1]
        parts.append(
            f"Final modeled storage price was `{fmt_money(last.get('storage_price'))}` and retrieval price per slot was `{fmt_money(last.get('retrieval_price_per_slot'))}`."
        )
    if metric_sum(economy, "elasticity_rejections"):
        parts.append(
            f"Elasticity attempted to exceed budget `{fmt_num(metric_sum(economy, 'elasticity_rejections'))}` times; modeled spend remained `{fmt_money(metric_sum(economy, 'elasticity_spent'))}`."
        )
    return "\n\n".join(parts)


def write_risk_register(
    path: Path,
    summary: dict[str, Any],
    providers: list[dict[str, str]],
    evidence: list[dict[str, str]],
    repairs: list[dict[str, str]],
    economy: list[dict[str, str]],
) -> None:
    config = summary["config"]
    totals = summary["totals"]
    guide = scenario_guide(str(config["scenario"]))
    assertions = summary.get("assertions", [])
    failed = [item for item in assertions if not item.get("passed")]
    negative_pnl = [p for p in providers if fnum(p.get("pnl")) < 0]
    elasticity_rejections = sum(fnum(row.get("elasticity_rejections")) for row in economy)
    rows = []
    if failed:
        for item in failed:
            rows.append(
                {
                    "risk": f"Assertion `{item.get('name')}` failed",
                    "severity": "high",
                    "evidence": str(item.get("detail", "")),
                    "impact": "The fixture no longer proves its intended policy property.",
                    "followup": "Fix simulator behavior or adjust the assertion only after explicit human policy approval.",
                }
            )
    if fnum(totals.get("unavailable_reads")):
        rows.append(
            {
                "risk": "User-facing availability loss",
                "severity": "critical",
                "evidence": f"{fmt_num(totals.get('unavailable_reads'))} unavailable reads; success rate {fmt_pct(totals.get('success_rate'))}.",
                "impact": "The network failed the primary storage availability objective.",
                "followup": "Do not graduate. Investigate routing, redundancy, repair timing, and provider selection.",
            }
        )
    if negative_pnl:
        rows.append(
            {
                "risk": "Provider economic churn pressure",
                "severity": "medium" if len(negative_pnl) < len(providers) / 2 else "high",
                "evidence": f"{len(negative_pnl)} of {len(providers)} providers ended with negative modeled P&L.",
                "impact": "A technically healthy network may still be unstable if rational providers exit.",
                "followup": "Review storage price, retrieval price, reward pool, provider cost assumptions, and dynamic-pricing thresholds.",
            }
        )
    if elasticity_rejections:
        rows.append(
            {
                "risk": "Elasticity demand rejected by spend cap",
                "severity": "medium",
                "evidence": f"{fmt_num(elasticity_rejections)} elasticity attempts were rejected.",
                "impact": "The system correctly fails closed, but users may experience capacity limits during demand spikes.",
                "followup": "Decide whether this is acceptable UX or whether user-funded burst budgets need product controls.",
            }
        )
    if fnum(totals.get("saturated_responses")):
        rows.append(
            {
                "risk": "Provider bandwidth saturation",
                "severity": "medium",
                "evidence": f"{fmt_num(totals.get('saturated_responses'))} provider responses saturated before serving.",
                "impact": "Retrieval demand may exceed heterogeneous provider bandwidth before the storage layer notices a hard fault.",
                "followup": "Review bandwidth admission, route_attempt_limit, retrieval pricing, and elasticity policy.",
            }
        )
    if fnum(totals.get("repair_backoffs")):
        rows.append(
            {
                "risk": "Repair coordination bottleneck",
                "severity": "medium",
                "evidence": f"{fmt_num(totals.get('repair_backoffs'))} repair attempts backed off.",
                "impact": "The network may detect bad slots faster than it can safely heal them.",
                "followup": "Review max repair starts per epoch, replacement capacity, and catch-up probability assumptions.",
            }
        )
    if evidence and not repairs and str(config["scenario"]) not in {"ideal", "underpriced-storage", "wash-retrieval", "viral-public-retrieval", "elasticity-cap-hit"}:
        rows.append(
            {
                "risk": "Evidence without repair",
                "severity": "high",
                "evidence": f"{len(evidence)} evidence events and 0 repair events.",
                "impact": "The simulator may be measuring bad behavior without enforcing recovery.",
                "followup": "Review enforcement mode and repair thresholds.",
            }
        )
    if fnum(totals.get("paid_corrupt_bytes")):
        rows.append(
            {
                "risk": "Corrupt bytes paid",
                "severity": "critical",
                "evidence": f"{fmt_num(totals.get('paid_corrupt_bytes'))} corrupt bytes were paid.",
                "impact": "The policy allows provably bad service to earn rewards.",
                "followup": "Block graduation until reward accounting excludes corrupt responses.",
            }
        )
    if not rows:
        rows.append(
            {
                "risk": "No material risk surfaced",
                "severity": "low",
                "evidence": "Assertions passed, no negative provider P&L, no elasticity cap hit, and no availability loss.",
                "impact": "This run is suitable as a control or candidate for deeper implementation planning.",
                "followup": "Compare against adjacent scenarios and confirm assertion thresholds.",
            }
        )

    lines = [
        f"# Risk Register: {guide['title']}",
        "",
        guide["intent"],
        "",
        "## Material Risks",
        "",
        "| Risk | Severity | Evidence | Impact | Recommended Follow-Up |",
        "|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(f"| {row['risk']} | `{row['severity']}` | {row['evidence']} | {row['impact']} | {row['followup']} |")
    lines.extend(
        [
            "",
            "## Evidence Counters",
            "",
            f"- Evidence events: `{len(evidence)}`",
            f"- Repair events: `{len(repairs)}`",
            f"- Failed assertions: `{len(failed)}`",
            f"- Providers with negative P&L: `{len(negative_pnl)}`",
            f"- Elasticity rejections: `{fmt_num(elasticity_rejections)}`",
            f"- Saturated responses: `{fmt_num(totals.get('saturated_responses'))}`",
            f"- Repair backoffs: `{fmt_num(totals.get('repair_backoffs'))}`",
            "",
            "## Review Questions",
            "",
            "- Are the modeled thresholds strict enough to catch griefing without punishing honest jitter?",
            "- Does the risk severity match how we would respond in a real devnet incident?",
            "- Should any risk item become a keeper test, gateway e2e test, or explicit governance parameter decision?",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_graduation_report(path: Path, summary: dict[str, Any]) -> None:
    config = summary["config"]
    totals = summary["totals"]
    assertions = summary.get("assertions", [])
    failed = [item for item in assertions if not item.get("passed")]
    scenario = config["scenario"]
    guide = scenario_guide(str(scenario))
    assertions_ready = bool(assertions) and not failed
    availability_ready = fnum(totals.get("unavailable_reads")) == 0
    corrupt_ready = fnum(totals.get("paid_corrupt_bytes")) == 0
    repair_ready = True
    if scenario in {"single-outage", "withholding", "corrupt-provider", "malicious-corrupt", "lazy-provider", "setup-failure"}:
        repair_ready = fnum(totals.get("repairs_started")) > 0 and fnum(totals.get("repairs_completed")) > 0
    hard_enforcement_ready = scenario not in {"corrupt-provider", "malicious-corrupt"} or fnum(totals.get("provider_slashed")) > 0
    ready = assertions_ready and availability_ready and corrupt_ready and repair_ready and hard_enforcement_ready

    if ready and scenario in {"ideal", "single-outage", "withholding", "corrupt-provider", "malicious-corrupt", "lazy-provider", "setup-failure"}:
        recommendation = "Candidate for implementation planning."
        rationale = "The fixture passed its assertion contract and exercised the expected enforcement path."
    elif ready:
        recommendation = "Candidate for further simulation review."
        rationale = "The fixture passed, but it primarily informs economic/product policy rather than immediate keeper enforcement."
    else:
        recommendation = "Do not graduate yet."
        rationale = "One or more readiness checks failed or the fixture is missing an assertion contract."

    lines = [
        f"# Graduation Assessment: {guide['title']}",
        "",
        guide["intent"],
        "",
        "## Recommendation",
        "",
        f"**{recommendation}** {rationale}",
        "",
        "## Readiness Checklist",
        "",
        "| Check | Result | Why It Matters |",
        "|---|---|---|",
        f"| Assertion contract passes | `{str(assertions_ready).lower()}` | The scenario must have explicit machine-readable policy expectations. |",
        f"| No user-facing availability loss | `{str(availability_ready).lower()}` | Enforcement must not harm users while repairing or measuring faults. |",
        f"| Corrupt bytes not paid | `{str(corrupt_ready).lower()}` | Bad data must never be economically rewarded. |",
        f"| Repair path exercised when expected | `{str(repair_ready).lower()}` | Fault scenarios should prove recovery, not only detection. |",
        f"| Hard enforcement represented when expected | `{str(hard_enforcement_ready).lower()}` | Corruption fixtures should prove the simulated slash/jail accounting path before keeper work. |",
        "",
        "## Candidate Next Artifact",
        "",
    ]
    if recommendation == "Candidate for implementation planning.":
        lines.append("Create a keeper/e2e planning ticket that names the exact evidence rows, reward-accounting rule, and repair transition this fixture should enforce.")
    elif recommendation == "Candidate for further simulation review.":
        lines.append("Create a policy-review note that compares this scenario against at least one baseline and one adversarial variant.")
    else:
        lines.append("Do not create implementation tickets until the failing readiness check has a human-approved policy resolution.")
    lines.extend(
        [
            "",
            "## Missing Human Decisions",
            "",
            "- Confirm whether the assertion bounds are the intended policy thresholds.",
            "- Confirm whether this scenario should graduate to keeper tests, gateway e2e tests, provider-daemon tests, or remain simulator-only.",
            "- Confirm which metrics become governance parameters versus internal monitoring thresholds.",
            "- Confirm whether any economic assumption is realistic enough to affect product or token policy.",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_graphs(graphs_dir: Path, epochs: list[dict[str, str]], economy: list[dict[str, str]]) -> None:
    write_line_svg(
        graphs_dir / "retrieval_success_rate.svg",
        "Retrieval Success Rate",
        [safe_rate(row, "retrieval_successes", "retrieval_attempts") for row in epochs],
    )
    write_line_svg(
        graphs_dir / "slot_states.svg",
        "Active Slots",
        [fnum(row.get("active_slots")) for row in epochs],
        secondary=[fnum(row.get("repairing_slots")) for row in epochs],
        secondary_label="Repairing Slots",
    )
    write_line_svg(
        graphs_dir / "provider_pnl.svg",
        "Provider P&L",
        [fnum(row.get("provider_pnl")) for row in economy],
    )
    write_line_svg(
        graphs_dir / "burn_mint_ratio.svg",
        "Burn / Mint Ratio",
        [burn_mint_ratio(row) for row in economy],
    )
    write_line_svg(
        graphs_dir / "price_trajectory.svg",
        "Price Trajectory",
        [fnum(row.get("storage_price")) for row in economy],
        secondary=[fnum(row.get("retrieval_price_per_slot")) for row in economy],
        secondary_label="Retrieval Price",
    )
    write_line_svg(
        graphs_dir / "capacity_utilization.svg",
        "Capacity Utilization BPS",
        [fnum(row.get("storage_utilization_bps")) for row in economy],
    )
    write_line_svg(
        graphs_dir / "saturation_and_repair.svg",
        "Saturation And Repair Pressure",
        [fnum(row.get("saturated_responses")) for row in epochs],
        secondary=[fnum(row.get("repair_backoffs")) for row in epochs],
        secondary_label="Repair Backoffs",
    )
    write_line_svg(
        graphs_dir / "repair_backlog.svg",
        "Repair Backlog",
        repair_backlog_series(epochs),
    )


def safe_rate(row: dict[str, str], num: str, denom: str) -> float:
    denominator = fnum(row.get(denom))
    if denominator == 0:
        return 0.0
    return fnum(row.get(num)) / denominator


def burn_mint_ratio(row: dict[str, str]) -> float:
    burned = fnum(row.get("retrieval_base_burned")) + fnum(row.get("retrieval_variable_burned")) + fnum(row.get("reward_burned"))
    minted = fnum(row.get("reward_pool_minted")) + fnum(row.get("audit_budget_minted"))
    return burned / minted if minted else 0.0


def repair_backlog_series(epochs: list[dict[str, str]]) -> list[float]:
    backlog = 0.0
    out = []
    for row in epochs:
        backlog += fnum(row.get("repairs_started")) - fnum(row.get("repairs_completed"))
        out.append(max(0.0, backlog))
    return out


def write_line_svg(
    path: Path,
    title: str,
    values: list[float],
    secondary: list[float] | None = None,
    secondary_label: str = "",
) -> None:
    width = 860
    height = 440
    left = 86
    right = 36
    top = 96
    bottom = 78
    plot_width = width - left - right
    plot_height = height - top - bottom
    all_values = values + (secondary or [])
    if not all_values:
        all_values = [0.0]
    lo_raw = min(all_values)
    hi_raw = max(all_values)
    lo = 0.0 if lo_raw >= 0 else lo_raw
    hi = hi_raw
    if hi == lo:
        hi = lo + 1.0
    padding = (hi - lo) * 0.06
    if lo_raw < 0:
        lo -= padding
    hi += padding

    def points(series: list[float]) -> str:
        if len(series) == 1:
            xs = [left]
        else:
            xs = [left + i * plot_width / (len(series) - 1) for i in range(len(series))]
        pts = []
        for x, value in zip(xs, series):
            y = top + plot_height - ((value - lo) / (hi - lo)) * plot_height
            pts.append(f"{x:.1f},{y:.1f}")
        return " ".join(pts)

    y_ticks = [lo + (hi - lo) * i / 4 for i in range(5)]
    x_count = max(len(values), len(secondary or []), 1)
    x_tick_indices = sorted({round(i * (x_count - 1) / min(5, max(1, x_count - 1))) for i in range(min(6, x_count))})
    y_grid = []
    for tick in y_ticks:
        y = top + plot_height - ((tick - lo) / (hi - lo)) * plot_height
        y_grid.append(
            f'<line x1="{left}" y1="{y:.1f}" x2="{width - right}" y2="{y:.1f}" stroke="#e5e7eb" stroke-width="1"/>'
        )
        y_grid.append(
            f'<text x="{left - 10}" y="{y + 4:.1f}" font-family="sans-serif" font-size="11" text-anchor="end" fill="#4b5563">{escape_xml(axis_tick(tick))}</text>'
        )
    x_grid = []
    for idx in x_tick_indices:
        x = left if x_count == 1 else left + idx * plot_width / (x_count - 1)
        label = str(idx + 1)
        x_grid.append(
            f'<line x1="{x:.1f}" y1="{top}" x2="{x:.1f}" y2="{top + plot_height}" stroke="#f3f4f6" stroke-width="1"/>'
        )
        x_grid.append(
            f'<text x="{x:.1f}" y="{top + plot_height + 22}" font-family="sans-serif" font-size="11" text-anchor="middle" fill="#4b5563">{escape_xml(label)}</text>'
        )

    primary_label = title
    secondary_polyline = ""
    secondary_legend = ""
    if secondary:
        secondary_polyline = f'<polyline fill="none" stroke="#d97706" stroke-width="2.5" points="{points(secondary)}" />'
        secondary_legend = f'''
  <line x1="{left + 190}" y1="72" x2="{left + 220}" y2="72" stroke="#d97706" stroke-width="3"/>
  <text x="{left + 226}" y="76" font-family="sans-serif" font-size="12" fill="#374151">{escape_xml(secondary_label or "Secondary")}</text>'''
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="{left}" y="26" font-family="sans-serif" font-size="18" font-weight="700" fill="#111827">{escape_xml(title)}</text>
  <text x="{left}" y="48" font-family="sans-serif" font-size="12" fill="#6b7280">Scale: x=epoch, y={escape_xml(title)}; displayed range {escape_xml(axis_tick(lo))} to {escape_xml(axis_tick(hi))}</text>
  <line x1="{left}" y1="72" x2="{left + 30}" y2="72" stroke="#2563eb" stroke-width="3"/>
  <text x="{left + 36}" y="76" font-family="sans-serif" font-size="12" fill="#374151">{escape_xml(primary_label)}</text>
  {secondary_legend}
  <rect x="{left}" y="{top}" width="{plot_width}" height="{plot_height}" fill="#ffffff" stroke="#d1d5db"/>
  {"".join(y_grid)}
  {"".join(x_grid)}
  <line x1="{left}" y1="{top + plot_height}" x2="{width - right}" y2="{top + plot_height}" stroke="#111827" stroke-width="1.2"/>
  <line x1="{left}" y1="{top}" x2="{left}" y2="{top + plot_height}" stroke="#111827" stroke-width="1.2"/>
  <text x="{left + plot_width / 2:.1f}" y="{height - 24}" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#111827">Epoch</text>
  <text transform="translate(22 {top + plot_height / 2:.1f}) rotate(-90)" font-family="sans-serif" font-size="13" text-anchor="middle" fill="#111827">{escape_xml(title)}</text>
  <polyline fill="none" stroke="#2563eb" stroke-width="2.5" points="{points(values)}" />
  {secondary_polyline}
</svg>
'''
    path.write_text(svg, encoding="utf-8")


def axis_tick(value: float) -> str:
    if abs(value) >= 1000:
        return f"{value:,.0f}"
    if abs(value) >= 100:
        return f"{value:.0f}"
    if abs(value) >= 10:
        return f"{value:.1f}"
    if abs(value) >= 1:
        return f"{value:.2f}"
    return f"{value:.4f}"


def escape_xml(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def generate_policy_delta(baseline_dir: Path, candidate_dir: Path, out_dir: Path) -> None:
    baseline = load_json(baseline_dir / "summary.json")
    candidate = load_json(candidate_dir / "summary.json")
    baseline_name = str(baseline["config"].get("scenario", "baseline"))
    candidate_name = str(candidate["config"].get("scenario", "candidate"))
    baseline_guide = scenario_guide(baseline_name)
    candidate_guide = scenario_guide(candidate_name)
    keys = sorted(set(baseline["totals"].keys()) | set(candidate["totals"].keys()))
    material = []
    for key in keys:
        b = fnum(baseline["totals"].get(key))
        c = fnum(candidate["totals"].get(key))
        if b == 0 and c == 0:
            continue
        material.append((key, b, c, c - b))
    ranked = sorted(material, key=lambda item: abs(item[3]), reverse=True)
    lines = [
        f"# Policy Delta: {baseline_guide['title']} -> {candidate_guide['title']}",
        "",
        "## Summary",
        "",
        f"Baseline scenario `{baseline_name}` represents: {baseline_guide['intent']}",
        "",
        f"Candidate scenario `{candidate_name}` represents: {candidate_guide['intent']}",
        "",
        "This report is intended to answer: what changed when we moved from the control case to the candidate policy/fault case, and are those changes desirable?",
        "",
    ]
    if baseline["config"].get("epochs") != candidate["config"].get("epochs"):
        lines.extend(
            [
                "**Comparability note:** these runs use different epoch counts, so raw volume metrics such as retrieval attempts, rewards, and costs are not directly comparable without normalization. Prefer rates, evidence classes, and scenario-specific invariants for review.",
                "",
            ]
        )
    lines.extend(
        [
        "## Decision Metrics",
        "",
        "| Metric | Baseline | Candidate | Interpretation |",
        "|---|---:|---:|---|",
        *decision_metric_lines(baseline, candidate),
        "",
        "## High-Signal Changes",
        "",
        "| Metric | Baseline | Candidate | Delta | Interpretation |",
        "|---|---:|---:|---:|---|",
        ]
    )
    for key, b, c, delta in ranked[:12]:
        lines.append(f"| `{key}` | {b:.6f} | {c:.6f} | {delta:.6f} | {delta_interpretation(key, b, c, delta)} |")
    lines.extend(
        [
            "",
            "## Full Metric Delta",
            "",
            "| Metric | Baseline | Candidate | Delta |",
            "|---|---:|---:|---:|",
        ]
    )
    for key, b, c, delta in material:
        lines.append(f"| `{key}` | {b:.6f} | {c:.6f} | {c - b:.6f} |")
    lines.extend(
        [
            "",
            "## Human Review Questions",
            "",
            "- Did the candidate preserve the baseline availability invariant?",
            "- Did the candidate create evidence and repair activity only where expected?",
            "- Did rewards move away from non-compliant providers without over-penalizing healthy providers?",
            "- Did market metrics move in a direction that supports provider retention rather than hidden churn?",
        ]
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "policy_delta.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def decision_metric_lines(baseline: dict[str, Any], candidate: dict[str, Any]) -> list[str]:
    baseline_totals = baseline["totals"]
    candidate_totals = candidate["totals"]
    metrics = [
        ("success_rate", "Availability invariant."),
        ("reward_coverage", "Whether compliant slots remain economically recognized."),
        ("repairs_started", "Whether the candidate exercised repair."),
        ("repairs_completed", "Whether repair finished within the modeled window."),
        ("quota_misses", "Soft liveness evidence created by the candidate."),
        ("invalid_proofs", "Hard evidence created by the candidate."),
        ("paid_corrupt_bytes", "Corrupt data payment safety invariant."),
        ("providers_negative_pnl", "Economic sustainability/churn indicator."),
        ("saturated_responses", "Whether heterogeneous provider bandwidth became a bottleneck."),
        ("repair_backoffs", "Whether healing coordination or replacement capacity became constrained."),
        ("final_storage_utilization_bps", "Final active-slot utilization against modeled provider capacity."),
    ]
    lines = []
    for key, meaning in metrics:
        lines.append(
            f"| `{key}` | {fnum(baseline_totals.get(key)):.6f} | {fnum(candidate_totals.get(key)):.6f} | {meaning} |"
        )
    return lines


def delta_interpretation(key: str, baseline: float, candidate: float, delta: float) -> str:
    if key == "success_rate":
        if candidate >= baseline:
            return "Availability was preserved or improved."
        return "Availability degraded; this should block graduation unless intentional."
    if key in {"repairs_started", "repairs_completed", "repairing_slots"}:
        if delta > 0:
            return "Repair path was exercised in the candidate scenario."
        return "Repair activity did not increase."
    if key in {"quota_misses", "deputy_misses", "invalid_proofs", "withheld_responses", "offline_responses"}:
        if delta > 0:
            return "Candidate generated additional policy evidence."
        return "Candidate did not add this evidence class."
    if key in {"reward_burned", "provider_slashed"}:
        if delta > 0:
            return "Candidate increased enforcement/accounting penalties."
        return "No additional penalty was applied."
    if key in {"provider_pnl", "provider_revenue", "provider_cost"}:
        return "Economic accounting changed; inspect provider distribution before drawing conclusions."
    if key == "providers_negative_pnl":
        if delta > 0:
            return "More providers are economically distressed."
        return "Provider distress did not increase."
    if key in {"retrieval_base_burned", "retrieval_variable_burned", "retrieval_provider_payouts"}:
        return "Retrieval market accounting changed with demand volume or price settings."
    if key == "saturated_responses":
        if delta > 0:
            return "Candidate exposed provider bandwidth saturation."
        return "Bandwidth saturation did not increase."
    if key == "repair_backoffs":
        if delta > 0:
            return "Candidate exposed repair coordination limits."
        return "Repair backoffs did not increase."
    if key == "final_storage_utilization_bps":
        return "Final storage utilization changed against modeled provider capacity."
    return "Metric changed; inspect the full report for causal context."


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", type=Path, help="single simulator output directory")
    parser.add_argument("--baseline-dir", type=Path)
    parser.add_argument("--candidate-dir", type=Path)
    parser.add_argument("--out-dir", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    out_dir = args.out_dir or args.run_dir or args.candidate_dir
    if out_dir is None:
        raise SystemExit("--out-dir is required unless --run-dir or --candidate-dir is set")
    if args.run_dir:
        generate_run_report(args.run_dir, out_dir)
    if args.baseline_dir and args.candidate_dir:
        generate_policy_delta(args.baseline_dir, args.candidate_dir, out_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
