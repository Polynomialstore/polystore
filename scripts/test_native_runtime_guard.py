#!/usr/bin/env python3
"""Check selected-runtime admission without building or starting any service.

Usage: python3 scripts/test_native_runtime_guard.py /path/to/current/library \
           /path/to/older/library
Both must be real platform-native libraries; the older library must lack
polystore_reconstruct_slot_rs. Only the two named launcher functions execute.
"""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def function(source, name):
    match = re.search(r"^" + re.escape(name) + r"\(\) \{\n.*?^\}", source, re.M | re.S)
    if not match:
        raise AssertionError(f"missing launcher function: {name}")
    return match.group(0)


def check(current, older):
    scripts = Path(__file__).resolve().parent
    for library in (current, older):
        if not library.is_file():
            raise ValueError(f"native library does not exist: {library}")
        print(f"library {library} sha256={hashlib.sha256(library.read_bytes()).hexdigest()}")
    with tempfile.TemporaryDirectory(prefix="polystore-runtime-guard-") as temporary:
        root = Path(temporary)
        # Missing nm is a real PATH omission; uname remains available so the
        # actual platform-selection branch is exercised.
        no_nm = root / "no-nm"
        no_nm.mkdir()
        (no_nm / "uname").symlink_to(shutil.which("uname"))
        for name in ("run_devnet_provider.sh", "redeploy_polystorechaind.sh"):
            source = (scripts / name).read_text()
            body = "set -euo pipefail\n" + "\n".join(
                function(source, item) for item in
                ("find_polystore_core_lib_dir", "ensure_polystore_core_runtime")
            ) + '''
log() { :; }
die() { echo "$*" >&2; exit 1; }
cargo() { echo UNEXPECTED_BUILD >&2; exit 99; }
run_in_dir() { echo UNEXPECTED_BUILD >&2; exit 99; }
ensure_polystore_core_runtime
printf 'ADMITTED:%s\\n' "$POLYSTORE_CORE_LIB_DIR"
'''
            for label, library, missing_nm in (
                ("current", current, False), ("older", older, False),
                ("missing-nm", current, True),
            ):
                env = dict(os.environ, POLYSTORE_CORE_LIB_DIR=str(library.parent),
                           ROOT_DIR=str(root), SOURCE_ROOT=str(root), TARGET_ROOT=str(root))
                if missing_nm:
                    env["PATH"] = str(no_nm)
                result = subprocess.run(["/bin/bash", "-c", body], env=env,
                                        capture_output=True, text=True, timeout=15)
                output = result.stdout + result.stderr
                if "UNEXPECTED_BUILD" in output:
                    raise AssertionError(f"selected runtime was replaced: {output}")
                if label == "current":
                    assert result.returncode == 0 and f"ADMITTED:{library.parent}" in output, output
                else:
                    expected = "nm is required" if missing_nm else "lacks polystore_reconstruct_slot_rs"
                    assert result.returncode != 0 and expected in output and str(library) in output, output
                    assert "ADMITTED:" not in output, output
                print(f"PASS {name}: {label}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("current", type=Path)
    parser.add_argument("older", type=Path)
    args = parser.parse_args()
    check(args.current.resolve(), args.older.resolve())
