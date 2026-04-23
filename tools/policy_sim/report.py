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
from pathlib import Path
from typing import Any


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


def generate_run_report(run_dir: Path, out_dir: Path) -> None:
    summary = load_json(run_dir / "summary.json")
    epochs = load_csv(run_dir / "epochs.csv")
    providers = load_csv(run_dir / "providers.csv")
    evidence = load_csv(run_dir / "evidence.csv")
    repairs = load_csv(run_dir / "repairs.csv")
    economy = load_csv(run_dir / "economy.csv")
    out_dir.mkdir(parents=True, exist_ok=True)
    graphs_dir = out_dir / "graphs"
    graphs_dir.mkdir(exist_ok=True)

    write_report_md(out_dir / "report.md", summary, epochs, providers, evidence, repairs)
    write_risk_register(out_dir / "risk_register.md", summary, providers, evidence, repairs, economy)
    write_graduation_report(out_dir / "graduation.md", summary)
    write_graphs(graphs_dir, epochs, economy)


def write_report_md(
    path: Path,
    summary: dict[str, Any],
    epochs: list[dict[str, str]],
    providers: list[dict[str, str]],
    evidence: list[dict[str, str]],
    repairs: list[dict[str, str]],
) -> None:
    config = summary["config"]
    totals = summary["totals"]
    assertions = summary.get("assertions", [])
    failed = [item for item in assertions if not item.get("passed")]
    negative_pnl = [p for p in providers if fnum(p.get("pnl")) < 0]
    lines = [
        f"# Policy Simulation Report: {config['scenario']}",
        "",
        "## Result",
        "",
        f"- Seed: `{config['seed']}`",
        f"- Enforcement mode: `{config.get('enforcement_mode', '')}`",
        f"- Assertions: `{len(assertions) - len(failed)}/{len(assertions)} passed`",
        f"- Success rate: `{fnum(totals.get('success_rate')):.4f}`",
        f"- Reward coverage: `{fnum(totals.get('reward_coverage')):.4f}`",
        f"- Repairs started/completed: `{totals.get('repairs_started')}` / `{totals.get('repairs_completed')}`",
        f"- Invalid proofs: `{totals.get('invalid_proofs')}`",
        f"- Quota misses: `{totals.get('quota_misses')}`",
        f"- Providers with negative P&L: `{len(negative_pnl)}`",
        "",
        "## Assertion Details",
        "",
    ]
    if assertions:
        for item in assertions:
            status = "PASS" if item.get("passed") else "FAIL"
            lines.append(f"- `{status}` `{item.get('name')}`: {item.get('detail')}")
    else:
        lines.append("- No assertions were recorded.")
    lines.extend(
        [
            "",
            "## Notable Events",
            "",
            f"- Evidence events: `{len(evidence)}`",
            f"- Repair events: `{len(repairs)}`",
            f"- Epoch rows: `{len(epochs)}`",
            "",
            "## Generated Graphs",
            "",
            "- `graphs/retrieval_success_rate.svg`",
            "- `graphs/slot_states.svg`",
            "- `graphs/provider_pnl.svg`",
            "- `graphs/burn_mint_ratio.svg`",
        ]
    )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_risk_register(
    path: Path,
    summary: dict[str, Any],
    providers: list[dict[str, str]],
    evidence: list[dict[str, str]],
    repairs: list[dict[str, str]],
    economy: list[dict[str, str]],
) -> None:
    assertions = summary.get("assertions", [])
    failed = [item for item in assertions if not item.get("passed")]
    negative_pnl = [p for p in providers if fnum(p.get("pnl")) < 0]
    elasticity_rejections = sum(fnum(row.get("elasticity_rejections")) for row in economy)
    lines = ["# Risk Register", ""]
    if failed:
        lines.append("## Failed Assertions")
        lines.append("")
        for item in failed:
            lines.append(f"- `{item.get('name')}`: {item.get('detail')}")
        lines.append("")
    lines.append("## Review Items")
    lines.append("")
    if negative_pnl:
        lines.append(f"- `{len(negative_pnl)}` providers ended with negative modeled P&L.")
    if elasticity_rejections:
        lines.append(f"- Elasticity was rejected `{int(elasticity_rejections)}` times.")
    if evidence and not repairs:
        lines.append("- Evidence was recorded but no repair events occurred; check enforcement mode.")
    if not failed and not negative_pnl and not elasticity_rejections:
        lines.append("- No major risks surfaced in this run.")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_graduation_report(path: Path, summary: dict[str, Any]) -> None:
    config = summary["config"]
    assertions = summary.get("assertions", [])
    failed = [item for item in assertions if not item.get("passed")]
    scenario = config["scenario"]
    ready = bool(assertions) and not failed
    lines = [
        f"# Graduation Assessment: {scenario}",
        "",
        f"- Simulator assertions passing: `{str(ready).lower()}`",
        f"- Enforcement mode: `{config.get('enforcement_mode', '')}`",
        "",
        "## Recommendation",
        "",
    ]
    if not ready:
        lines.append("- Do not graduate yet. Fix failed assertions or add explicit review notes.")
    elif scenario in {"ideal", "single-outage", "withholding", "corrupt-provider", "lazy-provider"}:
        lines.append("- Candidate for keeper-test planning after reviewing ledgers.")
    else:
        lines.append("- Candidate for further simulation and human policy review before keeper graduation.")
    lines.extend(
        [
            "",
            "## Missing Human Decisions",
            "",
            "- Confirm acceptable assertion bounds.",
            "- Confirm whether any generated recommendation should become a keeper or e2e ticket.",
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


def safe_rate(row: dict[str, str], num: str, denom: str) -> float:
    denominator = fnum(row.get(denom))
    if denominator == 0:
        return 0.0
    return fnum(row.get(num)) / denominator


def burn_mint_ratio(row: dict[str, str]) -> float:
    burned = fnum(row.get("retrieval_base_burned")) + fnum(row.get("retrieval_variable_burned")) + fnum(row.get("reward_burned"))
    minted = fnum(row.get("reward_pool_minted")) + fnum(row.get("audit_budget_minted"))
    return burned / minted if minted else 0.0


def write_line_svg(
    path: Path,
    title: str,
    values: list[float],
    secondary: list[float] | None = None,
    secondary_label: str = "",
) -> None:
    width = 720
    height = 280
    pad = 36
    all_values = values + (secondary or [])
    if not all_values:
        all_values = [0.0]
    lo = min(all_values)
    hi = max(all_values)
    if hi == lo:
        hi = lo + 1.0

    def points(series: list[float]) -> str:
        if len(series) == 1:
            xs = [pad]
        else:
            xs = [pad + i * (width - 2 * pad) / (len(series) - 1) for i in range(len(series))]
        pts = []
        for x, value in zip(xs, series):
            y = height - pad - ((value - lo) / (hi - lo)) * (height - 2 * pad)
            pts.append(f"{x:.1f},{y:.1f}")
        return " ".join(pts)

    secondary_polyline = ""
    if secondary:
        secondary_polyline = f'<polyline fill="none" stroke="#d97706" stroke-width="2" points="{points(secondary)}" />'
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="{pad}" y="24" font-family="sans-serif" font-size="16" fill="#111827">{escape_xml(title)}</text>
  <text x="{pad}" y="{height - 8}" font-family="sans-serif" font-size="11" fill="#6b7280">min={lo:.4f} max={hi:.4f} {escape_xml(secondary_label)}</text>
  <line x1="{pad}" y1="{height - pad}" x2="{width - pad}" y2="{height - pad}" stroke="#d1d5db"/>
  <line x1="{pad}" y1="{pad}" x2="{pad}" y2="{height - pad}" stroke="#d1d5db"/>
  <polyline fill="none" stroke="#2563eb" stroke-width="2" points="{points(values)}" />
  {secondary_polyline}
</svg>
'''
    path.write_text(svg, encoding="utf-8")


def escape_xml(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def generate_policy_delta(baseline_dir: Path, candidate_dir: Path, out_dir: Path) -> None:
    baseline = load_json(baseline_dir / "summary.json")
    candidate = load_json(candidate_dir / "summary.json")
    keys = sorted(set(baseline["totals"].keys()) | set(candidate["totals"].keys()))
    lines = ["# Policy Delta", "", "| Metric | Baseline | Candidate | Delta |", "|---|---:|---:|---:|"]
    for key in keys:
        b = fnum(baseline["totals"].get(key))
        c = fnum(candidate["totals"].get(key))
        if b == 0 and c == 0:
            continue
        lines.append(f"| `{key}` | {b:.6f} | {c:.6f} | {c - b:.6f} |")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "policy_delta.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


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
