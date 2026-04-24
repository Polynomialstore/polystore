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
        "repairs_completed": totals.get("repairs_completed", 0),
        "repair_backoffs": totals.get("repair_backoffs", 0),
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
        "| Scenario | Verdict | Success | Unavailable Reads | Data Loss Events | Repairs | Backoffs | Saturated | Negative P&L | Report |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for row in sorted(rows, key=lambda item: item["scenario"]):
        scenario = row["scenario"]
        lines.append(
            f"| `{scenario}` | `{row['verdict']}` | {row['success_rate']:.4f} | "
            f"{row['unavailable_reads']} | {row['data_loss_events']} | "
            f"{row['repairs_started']}/{row['repairs_completed']} | {row['repair_backoffs']} | "
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
