#!/usr/bin/env python3
"""Run versioned policy-simulator sweep specs and generate sweep reports."""

from __future__ import annotations

import argparse
import itertools
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    from .policing_sim import SimConfig, load_scenario_spec, run_one, write_output_dir
    from .report import generate_sweep_report
except ImportError:  # Allows direct execution as a script.
    from policing_sim import SimConfig, load_scenario_spec, run_one, write_output_dir
    from report import generate_sweep_report


@dataclass
class SweepCase:
    name: str
    config: dict[str, Any]
    faults: list[str]
    assertions: dict[str, Any]


@dataclass
class SweepSpec:
    name: str
    description: str
    base_scenario: Path
    cases: list[SweepCase]


def load_sweep_spec(path: Path) -> SweepSpec:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(
            "sweep specs must be strict JSON, even when using the .yaml "
            f"extension because JSON is a YAML subset: {path}: "
            f"{exc.msg} at line {exc.lineno}, column {exc.colno}"
        ) from exc
    if not isinstance(raw, dict):
        raise ValueError(f"sweep spec must be an object: {path}")

    base_scenario = resolve_relative(path, Path(str(raw["base_scenario"])))
    base = load_scenario_spec(base_scenario)
    cases: list[SweepCase] = []

    for name, overrides in matrix_cases(raw.get("matrix", {})):
        cases.append(build_case(name, base.config, base.faults, base.assertions, overrides, {}, []))

    for raw_case in raw.get("cases", []):
        if not isinstance(raw_case, dict):
            raise ValueError(f"sweep case must be an object: {path}")
        name = slug(str(raw_case.get("name", f"case-{len(cases) + 1}")))
        cases.append(
            build_case(
                name,
                base.config,
                base.faults,
                base.assertions,
                dict(raw_case.get("config", {})),
                dict(raw_case.get("assertions", {})),
                list(raw_case.get("faults", [])),
            )
        )

    if not cases:
        raise ValueError(f"sweep spec must define matrix values or cases: {path}")

    return SweepSpec(
        name=slug(str(raw.get("name") or path.stem)),
        description=str(raw.get("description", "")),
        base_scenario=base_scenario,
        cases=cases,
    )


def resolve_relative(anchor: Path, target: Path) -> Path:
    if target.is_absolute():
        return target
    return (anchor.parent / target).resolve()


def matrix_cases(matrix: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    if not matrix:
        return []
    keys = list(matrix.keys())
    values = []
    for key in keys:
        raw_values = matrix[key]
        if not isinstance(raw_values, list) or not raw_values:
            raise ValueError(f"matrix field {key!r} must be a non-empty list")
        values.append(raw_values)

    cases = []
    for combo in itertools.product(*values):
        overrides = dict(zip(keys, combo))
        name = "__".join(f"{slug(key)}-{slug_value(value)}" for key, value in overrides.items())
        cases.append((name, overrides))
    return cases


def build_case(
    name: str,
    base_config: dict[str, Any],
    base_faults: list[str],
    base_assertions: dict[str, Any],
    config_overrides: dict[str, Any],
    assertion_overrides: dict[str, Any],
    extra_faults: list[str],
) -> SweepCase:
    config = dict(base_config)
    config.update(config_overrides)
    assertions = dict(base_assertions)
    assertions.update(assertion_overrides)
    return SweepCase(name=name, config=config, faults=[*base_faults, *extra_faults], assertions=assertions)


def run_sweep_spec(spec_path: Path, run_root: Path, report_root: Path, clean: bool = True) -> dict[str, Any]:
    spec = load_sweep_spec(spec_path)
    sweep_run_dir = run_root / spec.name
    sweep_report_dir = report_root / spec.name
    if clean:
        for path in (sweep_run_dir, sweep_report_dir):
            if path.exists():
                shutil.rmtree(path)
    sweep_run_dir.mkdir(parents=True, exist_ok=True)
    sweep_report_dir.mkdir(parents=True, exist_ok=True)

    failures = 0
    case_rows = []
    for case in spec.cases:
        result = run_one(SimConfig(**case.config), case.faults, case.assertions, None)
        failed = [item for item in result.assertions if not item.passed]
        if failed:
            failures += 1
        run_dir = sweep_run_dir / case.name
        write_output_dir(run_dir, result)
        case_rows.append(
            {
                "case": case.name,
                "scenario": result.config.get("scenario"),
                "seed": result.config.get("seed"),
                "failed_assertions": [item.name for item in failed],
                "success_rate": result.totals.get("success_rate"),
                "unavailable_reads": result.totals.get("unavailable_reads"),
                "data_loss_events": result.totals.get("data_loss_events"),
            }
        )

    generate_sweep_report(sweep_run_dir, sweep_report_dir)
    manifest = {
        "name": spec.name,
        "description": spec.description,
        "base_scenario": str(spec.base_scenario),
        "case_count": len(spec.cases),
        "assertion_failures": failures,
        "raw_run_dir": str(sweep_run_dir),
        "committed_artifacts": ["sweep_summary.md", "sweep_summary.json", "manifest.json"],
        "omitted_artifacts": ["*/summary.json", "*/epochs.csv", "*/providers.csv", "*/slots.csv", "*/evidence.csv", "*/repairs.csv", "*/economy.csv"],
        "omission_reason": "Sweep raw ledgers are generated locally or uploaded as CI artifacts to keep committed reports reviewable.",
        "cases": case_rows,
    }
    sweep_report_dir.joinpath("manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def sweep_paths(path: Path) -> list[Path]:
    if path.is_file():
        return [path]
    paths = sorted([*path.glob("*.yaml"), *path.glob("*.json")])
    if not paths:
        raise SystemExit(f"no sweep specs found in {path}")
    return paths


def write_sweep_index(out_dir: Path, manifests: list[dict[str, Any]]) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Policy Simulation Sweep Reports",
        "",
        "This directory contains committed sweep summaries generated from versioned specs in `tools/policy_sim/sweeps`.",
        "",
        "Raw per-case simulator ledgers are intentionally omitted from git. Regenerate them locally or use CI artifacts when detailed ledger inspection is needed.",
        "",
        "Regenerate this corpus with:",
        "",
        "```bash",
        "python3 tools/policy_sim/run_sweeps.py \\",
        "  --sweep-dir tools/policy_sim/sweeps \\",
        "  --run-dir /tmp/polystore-policy-sweep-runs \\",
        "  --out-dir docs/simulation-reports/policy-sim/sweeps",
        "```",
        "",
        "## Sweep Index",
        "",
        "| Sweep | Cases | Assertion Failures | Description | Report |",
        "|---|---:|---:|---|---|",
    ]
    for manifest in sorted(manifests, key=lambda item: item["name"]):
        name = manifest["name"]
        lines.append(
            f"| `{name}` | {manifest['case_count']} | {manifest['assertion_failures']} | "
            f"{manifest['description']} | [summary]({name}/sweep_summary.md) |"
        )
    lines.extend(
        [
            "",
            "## Review Rule",
            "",
            "Sweeps are parameter-review artifacts. Assertion failures are allowed when a sweep intentionally explores unsafe thresholds, but any failed run must be treated as non-graduating until a human accepts the risk or changes the parameter range.",
        ]
    )
    out_dir.joinpath("README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def slug(raw: str) -> str:
    out = []
    for ch in raw.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-") or "case"


def slug_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return str(value).replace(".", "p")
    if isinstance(value, (dict, list)):
        return slug(json.dumps(value, sort_keys=True))
    return slug(str(value))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sweep-file", type=Path)
    parser.add_argument("--sweep-dir", type=Path)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--no-clean", action="store_true", help="do not delete existing output directories before generation")
    parser.add_argument("--fail-on-assertion", action="store_true", help="return non-zero when any sweep case assertion fails")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.sweep_file and not args.sweep_dir:
        raise SystemExit("one of --sweep-file or --sweep-dir is required")
    paths = []
    if args.sweep_file:
        paths.extend(sweep_paths(args.sweep_file))
    if args.sweep_dir:
        paths.extend(sweep_paths(args.sweep_dir))

    manifests = [run_sweep_spec(path, args.run_dir, args.out_dir, clean=not args.no_clean) for path in paths]
    write_sweep_index(args.out_dir, manifests)
    failures = sum(int(manifest["assertion_failures"]) for manifest in manifests)
    return 1 if args.fail_on_assertion and failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
