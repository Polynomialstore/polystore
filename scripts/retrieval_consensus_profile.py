#!/usr/bin/env python3
"""Strict loader for the checked-in retrieval consensus profile."""
import json
from pathlib import Path
import re


MAX_BLOCK_GAS = 448_000_000
MAX_BLOCK_BYTES = 2_097_152


def _decimal(value, name, maximum):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]*", value):
        raise ValueError(f"{name} must be a positive canonical decimal string")
    number = int(value)
    if number > maximum:
        raise ValueError(f"{name} exceeds the compiled activation ceiling")
    return number


def validate_consensus_profile(data):
    if not isinstance(data, dict) or set(data) != {"block"}:
        raise ValueError("consensus profile must contain only block")
    block = data["block"]
    if not isinstance(block, dict) or set(block) != {"max_bytes", "max_gas"}:
        raise ValueError("consensus profile block must contain max_bytes and max_gas")
    _decimal(block["max_bytes"], "max_bytes", MAX_BLOCK_BYTES)
    _decimal(block["max_gas"], "max_gas", MAX_BLOCK_GAS)
    return {"block": dict(block)}


def load_consensus_profile(path):
    return validate_consensus_profile(json.loads(Path(path).read_text()))


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", type=Path)
    block = load_consensus_profile(parser.parse_args().profile)["block"]
    print(block["max_gas"], block["max_bytes"])
