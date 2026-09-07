#!/usr/bin/env python3
"""Exercise the real chain build entrypoint without compiling dependencies."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class ChainGoTest(unittest.TestCase):
    def test_patch_preservation_and_required_build_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "scripts").mkdir()
            chain = root / "polystorechain"
            (chain / "vendor").mkdir(parents=True)
            script = root / "scripts/chain_go.sh"
            shutil.copyfile(Path(__file__).with_name("chain_go.sh"), script)
            for name in ("go.mod", "go.sum"):
                (chain / name).write_text("dependency v1\n")
            patch = chain / "vendor/correction.go"
            patch.write_text("tracked correction\n")
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            patch.write_text("uncommitted correction\n")
            fake = root / "go"
            fake.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
with open(os.environ["CALLS"], "a") as out:
    out.write(json.dumps([sys.argv[1:], os.environ.get("GOFLAGS")]) + "\\n")
if sys.argv[1:] == ["mod", "vendor"]:
    pathlib.Path("vendor/correction.go").write_text("upstream without correction\\n")
    sys.exit(int(os.environ.get("VENDOR_EXIT", "0")))
sys.exit(int(os.environ.get("BUILD_EXIT", "0")))
''')
            fake.chmod(0o755)
            calls = root / "calls.jsonl"
            env = dict(os.environ, GO_BIN=str(fake), CALLS=str(calls), GOFLAGS="-trimpath -mod=mod")

            def run(*args, **overrides):
                return subprocess.run(["bash", str(script), *args], env=dict(env, **overrides), capture_output=True, text=True)

            self.assertEqual(run("build", "./cmd/polystorechaind").returncode, 0)
            self.assertEqual(patch.read_text(), "uncommitted correction\n")
            recorded = [json.loads(x) for x in calls.read_text().splitlines()]
            self.assertEqual(recorded, [[["mod", "vendor"], ""], [["build", "./cmd/polystorechaind"], "-trimpath -mod=mod -mod=vendor"]])
            self.assertEqual(run("test", "./...", BUILD_EXIT="7").returncode, 7)
            self.assertEqual(len(calls.read_text().splitlines()), 3, "reuse unchanged dependency tree")
            self.assertEqual(run("build", "-mod=mod", "./...").returncode, 2)
            self.assertEqual(len(calls.read_text().splitlines()), 3, "reject bypass before running Go")

            (chain / "go.mod").write_text("dependency v2\n")
            self.assertEqual(run("test", "./...", VENDOR_EXIT="9").returncode, 9)
            self.assertEqual(patch.read_text(), "uncommitted correction\n", "failed vendoring must preserve edits")
            self.assertEqual(run("test", "./...").returncode, 0)
            self.assertEqual(patch.read_text(), "uncommitted correction\n")
            self.assertEqual(run("vendor").returncode, 0)
            self.assertEqual(patch.read_text(), "uncommitted correction\n")
            shutil.copyfile(Path(__file__).resolve().parents[1] / "polystorechain/Makefile", chain / "Makefile")
            failed = subprocess.run(["make", "-s", "test-unit"], cwd=chain, env=dict(env, BUILD_EXIT="7"), capture_output=True)
            self.assertNotEqual(failed.returncode, 0, "Makefile must propagate Go test failure")


if __name__ == "__main__":
    unittest.main()
