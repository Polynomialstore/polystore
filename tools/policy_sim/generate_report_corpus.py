#!/usr/bin/env python3
"""Generate the committed policy-simulation report corpus.

The raw simulator output can be large, especially for scale scenarios. This
script keeps the committed corpus reviewable by writing narrative reports,
graphs, signals, summaries, and assertion contracts while leaving full CSV
ledgers to CI artifacts or local scratch directories.
"""

from __future__ import annotations

import argparse
import json
import shutil
import tempfile
from dataclasses import asdict
from pathlib import Path
from typing import Any

try:
    from .policing_sim import SimConfig, fixture_paths, load_scenario_spec, run_one, write_output_dir
    from .report import generate_run_report
except ImportError:  # Allows direct execution as a script.
    from policing_sim import SimConfig, fixture_paths, load_scenario_spec, run_one, write_output_dir
    from report import generate_run_report


GRADUATION_TARGETS = {
    "ideal": {
        "target": "keeper control tests",
        "next_test": "Add no-op epoch tests proving healthy providers do not accrue evidence, repair, reward exclusion, jail, or slash state.",
        "missing_surfaces": ["keeper epoch hooks", "reward eligibility queries"],
        "e2e": "Gateway happy-path smoke remains sufficient; do not add a slow failure e2e for the control case.",
    },
    "single-outage": {
        "target": "keeper repair and gateway route-around",
        "next_test": "Add a keeper test where a slot crosses missed-epoch threshold, enters repair, selects a deterministic pending provider, and later promotes.",
        "missing_surfaces": ["slot health state", "repair attempt ledger", "promotion readiness proof", "gateway repair-aware routing"],
        "e2e": "Kill one provider-daemon during retrieval and assert reads stay available while repair starts.",
    },
    "flapping-provider": {
        "target": "keeper soft-fault window",
        "next_test": "Add missed-epoch window tests proving intermittent failures create health evidence without triggering repair churn.",
        "missing_surfaces": ["soft-fault decay", "per-slot suspect state", "operator health query"],
        "e2e": "Optional provider restart e2e; keeper coverage should be the first artifact.",
    },
    "sustained-non-response": {
        "target": "keeper delinquency repair",
        "next_test": "Add per-slot delinquency tests for repeated non-response, reward exclusion, repair start, and replacement selection.",
        "missing_surfaces": ["non-response accumulator", "delinquency reason codes", "reward exclusion event"],
        "e2e": "Provider timeout/blackhole e2e after keeper state is deterministic.",
    },
    "withholding": {
        "target": "gateway fallback plus keeper evidence",
        "next_test": "Add tests for threshold non-response evidence and deputy-served miss accounting before punitive policy.",
        "missing_surfaces": ["threshold evidence case", "deputy transcript accounting", "gateway fallback telemetry"],
        "e2e": "Provider refuses retrieval responses; gateway routes around and records attributable failure.",
    },
    "corrupt-provider": {
        "target": "hard-fault keeper path",
        "next_test": "Add invalid-proof or wrong-data keeper tests proving no corrupt payment, repair start, and slash/jail simulation gates.",
        "missing_surfaces": ["hard evidence submission", "corrupt-byte reward exclusion", "jail/slash params"],
        "e2e": "Provider returns corrupt bytes or invalid proof and user-gateway rejects the response.",
    },
    "lazy-provider": {
        "target": "reward eligibility keeper tests",
        "next_test": "Add quota shortfall and synthetic-fill tests proving lazy responsibility is excluded from base rewards without soft-fault slashing.",
        "missing_surfaces": ["quota miss ledger", "reward exclusion reason query", "soft fault consequence ceiling"],
        "e2e": "Slow-path only after keeper reward accounting is stable.",
    },
    "setup-failure": {
        "target": "setup bump and deterministic replacement",
        "next_test": "Add setup-phase replacement tests proving failed initial upload selects a system provider and does not imply fraud.",
        "missing_surfaces": ["setup slot state", "setup bump event", "candidate exclusion reasons"],
        "e2e": "Create deal with one failing provider upload and verify replacement before first content commit.",
    },
    "underpriced-storage": {
        "target": "economic policy calibration",
        "next_test": "Compare storage floors, base rewards, and provider cost assumptions before encoding governance defaults.",
        "missing_surfaces": ["dynamic pricing state", "provider cost assumptions", "profitability dashboards"],
        "e2e": "No process e2e yet; this is a parameter-calibration fixture.",
    },
    "wash-retrieval": {
        "target": "session fee and credit-cap keeper tests",
        "next_test": "Add retrieval fee, burn, credit-cap, and requester-paid session accounting tests.",
        "missing_surfaces": ["requester-paid session accounting", "burn ledger", "credit cap enforcement"],
        "e2e": "Synthetic wash traffic e2e only after keeper accounting exists.",
    },
    "viral-public-retrieval": {
        "target": "sponsored retrieval accounting",
        "next_test": "Add sponsored-session tests proving public demand pays providers without draining owner escrow unexpectedly.",
        "missing_surfaces": ["sponsored session funding", "owner escrow isolation", "hot route observability"],
        "e2e": "Public retrieval spike against one deal with requester/sponsor funding.",
    },
    "elasticity-cap-hit": {
        "target": "elasticity spend-window tests",
        "next_test": "Add spend-window tests for saturation signaling, fail-closed expansion, TTL, and cap-bound rejection.",
        "missing_surfaces": ["MsgSignalSaturation hardening", "overlay accountability", "deal spend window"],
        "e2e": "Burst traffic e2e after overlay semantics are implemented.",
    },
    "audit-budget-exhaustion": {
        "target": "audit budget keeper tests",
        "next_test": "Add audit-budget minted/spent/carryover tests proving audit demand is capped and backlog is explicit.",
        "missing_surfaces": ["audit budget state", "audit backlog query", "evidence bounty accounting"],
        "e2e": "No process e2e until audit sessions are wired through provider-daemon.",
    },
    "price-controller-bounds": {
        "target": "dynamic pricing keeper tests",
        "next_test": "Add epoch pricing tests for floors, ceilings, utilization target, retrieval-demand target, and max step bps.",
        "missing_surfaces": ["dynamic pricing params", "storage utilization accumulator", "retrieval demand accumulator"],
        "e2e": "No process e2e; validate with keeper tests and simulator sweeps first.",
    },
    "subsidy-farming": {
        "target": "base reward compliance tests",
        "next_test": "Add tests proving idle or non-compliant responsibility cannot farm base rewards profitably.",
        "missing_surfaces": ["compliance-gated base rewards", "subsidy leakage metrics", "operator concentration checks"],
        "e2e": "No process e2e until keeper reward gating is complete.",
    },
    "coordinated-regional-outage": {
        "target": "placement diversity and nightly stress",
        "next_test": "Keep as simulator calibration until placement-diversity params exist, then add keeper candidate-selection tests.",
        "missing_surfaces": ["regional/provider-class placement metadata", "operator concentration limits", "nightly stress harness"],
        "e2e": "Manual or nightly multi-provider outage, not PR-blocking CI.",
    },
    "repair-candidate-exhaustion": {
        "target": "candidate selection and repair backoff keeper tests",
        "next_test": "Add tests proving no eligible replacement emits backoff, preserves capacity constraints, and does not over-assign providers.",
        "missing_surfaces": ["candidate exclusion reasons", "repair attempt caps", "replacement capacity query"],
        "e2e": "Small devnet with no spare provider capacity after keeper behavior is stable.",
    },
    "high-bandwidth-promotion": {
        "target": "provider capability and hot-route policy tests",
        "next_test": "Add capability-tier keeper/runtime tests proving measured providers can become high-bandwidth eligible and hot retrieval routing prefers them without over-capacity assignment.",
        "missing_surfaces": ["provider capability tier state", "bandwidth probe telemetry", "hot-route preference query", "capability demotion rule"],
        "e2e": "Hot retrieval burst against heterogeneous providers after gateway/provider telemetry exists; assert promoted providers receive hot traffic and can later demote on regression.",
    },
    "large-scale-regional-stress": {
        "target": "scale calibration and regression reporting",
        "next_test": "Use sweep reports to tune repair throughput, placement headroom, retrieval pricing, and provider P&L before keeper defaults.",
        "missing_surfaces": ["scale sweep corpus", "placement diversity params", "operator concentration analysis", "CI artifact retention"],
        "e2e": "Do not mirror this as process e2e; keep it as simulator/CI artifact work.",
    },
}


def generate_corpus(scenario_dir: Path, out_dir: Path, work_dir: Path | None, clean: bool) -> int:
    paths = fixture_paths(scenario_dir)
    if not paths:
        raise SystemExit(f"no scenario fixtures found in {scenario_dir}")

    if clean and out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if work_dir:
        if clean and work_dir.exists():
            shutil.rmtree(work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)
        return _generate(paths, out_dir, work_dir)

    with tempfile.TemporaryDirectory(prefix="polystore-policy-runs-") as tmp:
        return _generate(paths, out_dir, Path(tmp))


def _generate(paths: list[Path], out_dir: Path, run_root: Path) -> int:
    rows: list[dict[str, Any]] = []
    failures = 0
    for path in paths:
        spec = load_scenario_spec(path)
        result = run_one(SimConfig(**spec.config), spec.faults, spec.assertions, None)
        failed = [item for item in result.assertions if not item.passed]
        if failed:
            failures += 1

        run_dir = run_root / spec.name
        report_dir = out_dir / spec.name
        write_output_dir(run_dir, result)
        generate_run_report(run_dir, report_dir)
        shutil.copy2(run_dir / "summary.json", report_dir / "summary.json")
        shutil.copy2(run_dir / "assertions.json", report_dir / "assertions.json")
        (report_dir / "manifest.json").write_text(
            json.dumps(
                {
                    "scenario_fixture": str(path),
                    "description": spec.description,
                    "committed_artifacts": [
                        "report.md",
                        "risk_register.md",
                        "graduation.md",
                        "signals.json",
                        "summary.json",
                        "assertions.json",
                        "graphs/*.svg",
                    ],
                    "omitted_artifacts": [
                        "epochs.csv",
                        "providers.csv",
                        "slots.csv",
                        "evidence.csv",
                        "repairs.csv",
                        "economy.csv",
                    ],
                    "omission_reason": "CSV ledgers are generated in CI/local artifacts to keep the committed report corpus reviewable.",
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        rows.append(index_row(spec.name, result, failed))

    write_index(out_dir, rows)
    write_graduation_map(out_dir, rows)
    return 1 if failures else 0


def index_row(name: str, result, failed: list[Any]) -> dict[str, Any]:
    totals = result.totals
    return {
        "scenario": name,
        "verdict": "FAIL" if failed else "PASS",
        "success_rate": totals.get("success_rate", 0.0),
        "unavailable_reads": totals.get("unavailable_reads", 0),
        "data_loss_events": totals.get("data_loss_events", 0),
        "repairs_started": totals.get("repairs_started", 0),
        "repairs_ready": totals.get("repairs_ready", 0),
        "repairs_completed": totals.get("repairs_completed", 0),
        "repair_attempts": totals.get("repair_attempts", 0),
        "repair_backoffs": totals.get("repair_backoffs", 0),
        "repair_cooldowns": totals.get("repair_cooldowns", 0),
        "repair_attempt_caps": totals.get("repair_attempt_caps", 0),
        "high_bandwidth_promotions": totals.get("high_bandwidth_promotions", 0),
        "high_bandwidth_demotions": totals.get("high_bandwidth_demotions", 0),
        "high_bandwidth_providers": totals.get("high_bandwidth_providers", 0),
        "hot_retrieval_attempts": totals.get("hot_retrieval_attempts", 0),
        "hot_high_bandwidth_serves": totals.get("hot_high_bandwidth_serves", 0),
        "suspect_slots": totals.get("suspect_slots", 0),
        "delinquent_slots": totals.get("delinquent_slots", 0),
        "providers_negative_pnl": totals.get("providers_negative_pnl", 0),
        "saturated_responses": totals.get("saturated_responses", 0),
        "assertions": [asdict(item) for item in result.assertions],
    }


def write_index(out_dir: Path, rows: list[dict[str, Any]]) -> None:
    lines = [
        "# Policy Simulation Report Corpus",
        "",
        "This directory contains the committed human-readable report set generated from `tools/policy_sim/scenarios`.",
        "",
        "The complete CSV ledgers are intentionally omitted from git because scale runs can produce large per-slot/per-epoch output. Regenerate them locally or use CI artifacts when a full ledger review is needed.",
        "",
        "Regenerate this corpus with:",
        "",
        "```bash",
        "python3 tools/policy_sim/generate_report_corpus.py \\",
        "  --scenario-dir tools/policy_sim/scenarios \\",
        "  --out-dir docs/simulation-reports/policy-sim \\",
        "  --work-dir /tmp/polystore-policy-runs",
        "```",
        "",
        "## Scenario Index",
        "",
        "The corpus-level [graduation map](graduation_map.md) translates these simulator results into the next keeper, gateway/provider, or policy-calibration artifacts.",
        "",
        "The [sweep reports](sweeps/README.md) compare parameter ranges for scale, routing, reliability, and pricing decisions. Regenerate them with `tools/policy_sim/run_sweeps.py` after regenerating this scenario corpus.",
        "",
        "`Repairs` is reported as `started/ready/completed`; `ready` is pending-provider catch-up evidence before promotion. `Backoffs` includes no-candidate, coordination-limit, cooldown, and attempt-cap throttling events. `High-BW` is reported as `promotions/final providers`.",
        "",
        "| Scenario | Verdict | Success | Unavailable Reads | Data Loss Events | Repairs | Health | Attempts | Backoffs | High-BW | Saturated | Negative P&L | Report |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for row in sorted(rows, key=lambda item: item["scenario"]):
        scenario = row["scenario"]
        lines.append(
            f"| `{scenario}` | `{row['verdict']}` | {row['success_rate']:.4f} | "
            f"{row['unavailable_reads']} | {row['data_loss_events']} | "
            f"{row['repairs_started']}/{row['repairs_ready']}/{row['repairs_completed']} | "
            f"{row['suspect_slots']}/{row['delinquent_slots']} | {row['repair_attempts']} | {row['repair_backoffs']} | "
            f"{row['high_bandwidth_promotions']}/{row['high_bandwidth_providers']} | "
            f"{row['saturated_responses']} | {row['providers_negative_pnl']} | "
            f"[report]({scenario}/report.md) |"
        )
    lines.extend(
        [
            "",
            "## Review Rule",
            "",
            "Unavailable reads are a bounded availability signal for explicitly marked stress scenarios. Modeled data-loss events are a durability failure and should remain zero for the current simulator milestone.",
        ]
    )
    out_dir.joinpath("README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_graduation_map(out_dir: Path, rows: list[dict[str, Any]]) -> None:
    mapped = [graduation_map_row(row) for row in sorted(rows, key=lambda item: item["scenario"])]
    status_counts: dict[str, int] = {}
    for row in mapped:
        status_counts[row["status"]] = status_counts.get(row["status"], 0) + 1

    (out_dir / "graduation_map.json").write_text(
        json.dumps({"status_counts": status_counts, "scenarios": mapped}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    lines = [
        "# Policy Simulation Graduation Map",
        "",
        "This report converts the committed simulator corpus into implementation planning targets. It is intentionally higher-level than per-scenario `graduation.md` files: this is the artifact to use when choosing the next keeper, gateway/provider, or e2e test slice.",
        "",
        "## Readiness Summary",
        "",
        "| Status | Count | Meaning |",
        "|---|---:|---|",
    ]
    for status in ["implementation planning", "further simulation review", "blocked"]:
        lines.append(f"| `{status}` | {status_counts.get(status, 0)} | {graduation_status_meaning(status)} |")
    lines.extend(
        [
            "",
            "## Scenario-to-Implementation Map",
            "",
            "| Scenario | Status | Target | Next Test Slice | Missing Surfaces | E2E Posture |",
            "|---|---|---|---|---|---|",
        ]
    )
    for row in mapped:
        lines.append(
            f"| [`{row['scenario']}`]({row['scenario']}/report.md) | `{row['status']}` | {row['target']} | "
            f"{row['next_test']} | {', '.join(f'`{item}`' for item in row['missing_surfaces'])} | {row['e2e']} |"
        )
    lines.extend(
        [
            "",
            "## Recommended Near-Term Keeper/E2E Slices",
            "",
            *recommended_graduation_lines(mapped),
            "",
            "## Missing Surfaces By Component",
            "",
            *missing_surface_lines(mapped),
            "",
            "## Review Rule",
            "",
            "Use this map to choose implementation work only after the linked scenario report, risk register, and assertion contract have been reviewed. A passing simulator fixture is evidence for planning, not permission to enable live punitive enforcement.",
        ]
    )
    (out_dir / "graduation_map.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def graduation_map_row(row: dict[str, Any]) -> dict[str, Any]:
    scenario = row["scenario"]
    target = GRADUATION_TARGETS.get(
        scenario,
        {
            "target": "case-by-case policy review",
            "next_test": "Define the implementation target before adding keeper or e2e coverage.",
            "missing_surfaces": ["explicit graduation target"],
            "e2e": "Undecided.",
        },
    )
    status, blockers = graduation_status(row)
    return {
        "scenario": scenario,
        "status": status,
        "blockers": blockers,
        "target": target["target"],
        "next_test": target["next_test"],
        "missing_surfaces": target["missing_surfaces"],
        "e2e": target["e2e"],
        "metrics": {
            "verdict": row["verdict"],
            "success_rate": row["success_rate"],
            "unavailable_reads": row["unavailable_reads"],
            "data_loss_events": row["data_loss_events"],
            "repairs_started": row["repairs_started"],
            "repairs_ready": row.get("repairs_ready", 0),
            "repairs_completed": row["repairs_completed"],
            "repair_attempts": row.get("repair_attempts", 0),
            "repair_backoffs": row["repair_backoffs"],
            "repair_cooldowns": row.get("repair_cooldowns", 0),
            "repair_attempt_caps": row.get("repair_attempt_caps", 0),
            "high_bandwidth_promotions": row.get("high_bandwidth_promotions", 0),
            "high_bandwidth_demotions": row.get("high_bandwidth_demotions", 0),
            "high_bandwidth_providers": row.get("high_bandwidth_providers", 0),
            "hot_retrieval_attempts": row.get("hot_retrieval_attempts", 0),
            "hot_high_bandwidth_serves": row.get("hot_high_bandwidth_serves", 0),
            "suspect_slots": row.get("suspect_slots", 0),
            "delinquent_slots": row.get("delinquent_slots", 0),
            "providers_negative_pnl": row["providers_negative_pnl"],
            "saturated_responses": row["saturated_responses"],
        },
    }


def graduation_status(row: dict[str, Any]) -> tuple[str, list[str]]:
    blockers = []
    if row["verdict"] != "PASS":
        blockers.append("assertion contract failed")
    if row["data_loss_events"]:
        blockers.append("modeled data loss occurred")
    if blockers:
        return "blocked", blockers
    scenario = row["scenario"]
    implementation_ready = {
        "ideal",
        "single-outage",
        "flapping-provider",
        "sustained-non-response",
        "withholding",
        "corrupt-provider",
        "lazy-provider",
        "setup-failure",
        "audit-budget-exhaustion",
        "price-controller-bounds",
        "subsidy-farming",
        "repair-candidate-exhaustion",
        "high-bandwidth-promotion",
    }
    if scenario in implementation_ready:
        return "implementation planning", []
    return "further simulation review", []


def graduation_status_meaning(status: str) -> str:
    meanings = {
        "implementation planning": "The fixture passed and maps to a concrete keeper, gateway/provider, or e2e artifact.",
        "further simulation review": "The fixture passed but should inform parameter or product policy before implementation work.",
        "blocked": "The fixture failed assertions or durability safety and should not graduate.",
    }
    return meanings[status]


def recommended_graduation_lines(rows: list[dict[str, Any]]) -> list[str]:
    ready = [row for row in rows if row["status"] == "implementation planning"]
    priority = [
        "ideal",
        "single-outage",
        "sustained-non-response",
        "corrupt-provider",
        "lazy-provider",
        "setup-failure",
        "repair-candidate-exhaustion",
        "high-bandwidth-promotion",
        "price-controller-bounds",
    ]
    ready.sort(key=lambda row: (priority.index(row["scenario"]) if row["scenario"] in priority else 99, row["scenario"]))
    if not ready:
        return ["- No scenario is ready for implementation planning from this corpus."]
    lines = []
    for row in ready[:8]:
        lines.append(f"- `{row['scenario']}`: {row['next_test']}")
    return lines


def missing_surface_lines(rows: list[dict[str, Any]]) -> list[str]:
    counts: dict[str, int] = {}
    for row in rows:
        for surface in row["missing_surfaces"]:
            counts[surface] = counts.get(surface, 0) + 1
    lines = ["| Surface | Scenario Count |", "|---|---:|"]
    for surface, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        lines.append(f"| `{surface}` | {count} |")
    return lines


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--no-clean", action="store_true", help="do not delete existing output directories before generation")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return generate_corpus(args.scenario_dir, args.out_dir, args.work_dir, clean=not args.no_clean)


if __name__ == "__main__":
    raise SystemExit(main())
