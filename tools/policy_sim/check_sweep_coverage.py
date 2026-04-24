#!/usr/bin/env python3
"""Verify every policy simulator scenario has direct sweep coverage."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def scenario_stems(scenario_dir: Path) -> set[str]:
    return {path.stem for path in scenario_dir.glob("*.yaml")}


def sweep_base_stems(sweep_dir: Path) -> dict[str, list[str]]:
    covered: dict[str, list[str]] = {}
    for path in sorted(sweep_dir.glob("*.yaml")):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise SystemExit(f"invalid sweep JSON {path}: {exc}") from exc
        base = raw.get("base_scenario")
        if not isinstance(base, str) or not base:
            raise SystemExit(f"sweep missing base_scenario: {path}")
        covered.setdefault(Path(base).stem, []).append(path.name)
    return covered


def check_coverage(scenario_dir: Path, sweep_dir: Path) -> int:
    scenarios = scenario_stems(scenario_dir)
    covered = sweep_base_stems(sweep_dir)
    missing = sorted(scenarios - set(covered))
    unknown = sorted(set(covered) - scenarios)

    if unknown:
        print("sweeps reference missing scenario fixtures:")
        for stem in unknown:
            print(f"  - {stem}: {', '.join(covered[stem])}")
        return 1

    if missing:
        print("scenario fixtures without direct sweep coverage:")
        for stem in missing:
            print(f"  - {stem}")
        return 1

    print(
        "policy simulator sweep coverage ok: "
        f"{len(scenarios)} scenarios, {len(covered)} covered bases, "
        f"{sum(len(paths) for paths in covered.values())} sweep specs"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario-dir", type=Path, default=Path("tools/policy_sim/scenarios"))
    parser.add_argument("--sweep-dir", type=Path, default=Path("tools/policy_sim/sweeps"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return check_coverage(args.scenario_dir, args.sweep_dir)


if __name__ == "__main__":
    raise SystemExit(main())
