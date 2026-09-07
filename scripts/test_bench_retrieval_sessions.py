"""Safety checks for the actual benchmark entrypoint; no build or node is run."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("bench_retrieval_sessions.sh")


class BenchmarkHomeTest(unittest.TestCase):
    def test_existing_paths_are_preserved_before_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            build_marker = root / "build-called"
            fakebin = root / "bin"
            fakebin.mkdir()
            cargo = fakebin / "cargo"
            cargo.write_text('#!/bin/sh\nprintf called > "$BUILD_MARKER"\nexit 89\n')
            cargo.chmod(0o755)
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}", BUILD_MARKER=str(build_marker))
            existing = root / "existing"
            existing.mkdir()
            sentinel = existing / "operator-data"
            sentinel.write_text("preserve")
            link = root / "link"
            link.symlink_to(existing, target_is_directory=True)
            dangling = root / "dangling"
            dangling.symlink_to(root / "absent", target_is_directory=True)
            for home in (existing, link, dangling, sentinel):
                with self.subTest(home=home.name):
                    result = subprocess.run(["bash", str(SCRIPT)], env=dict(env, POLYSTORE_BENCH_HOME=str(home)), capture_output=True, text=True, timeout=10)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("must not already exist", result.stderr)
                    self.assertFalse(build_marker.exists(), result.stderr)
                    self.assertEqual(sentinel.read_text(), "preserve")
                    self.assertTrue(link.is_symlink())
                    self.assertTrue(dangling.is_symlink())

    def test_only_new_owned_home_is_cleaned_on_build_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fakebin = root / "bin"
            fakebin.mkdir()
            cargo = fakebin / "cargo"
            cargo.write_text("#!/bin/sh\nexit 89\n")
            cargo.chmod(0o755)
            home = root / "new-home"
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}", POLYSTORE_BENCH_HOME=str(home))
            for keep in (False, True):
                with self.subTest(keep=keep):
                    result = subprocess.run(["bash", str(SCRIPT)] + (["--keep-home"] if keep else []), env=env, capture_output=True, text=True, timeout=10)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("cargo build --release failed", result.stderr)
                    self.assertEqual(home.is_dir(), keep)

    def test_binary_is_built_inside_each_unique_default_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fakebin = root / "bin"
            fakebin.mkdir()
            for name, body in (
                ("cargo", "exit 0"),
                ("go", 'printf "%s\\n" "$@" > "$BUILD_ARGS"; exit 89'),
            ):
                command = fakebin / name
                command.write_text("#!/bin/sh\n" + body + "\n")
                command.chmod(0o755)
            args_file = root / "args"
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}", BUILD_ARGS=str(args_file))
            env.pop("POLYSTORE_BENCH_HOME", None)
            homes = []
            for _ in range(2):
                result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("chain build failed", result.stderr)
                args = args_file.read_text().splitlines()
                binary = Path(args[args.index("-o") + 1])
                self.assertEqual(binary.name, "polystorechaind")
                self.assertTrue(binary.parent.name.startswith("bench-retrieval-"))
                self.assertFalse(binary.parent.exists())
                homes.append(binary.parent)
            self.assertNotEqual(*homes)

    def test_replaced_home_is_not_removed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fakebin = root / "bin"
            fakebin.mkdir()
            home = root / "home"
            target = root / "operator-data"
            target.mkdir()
            (target / "sentinel").write_text("preserve")
            cargo = fakebin / "cargo"
            cargo.write_text('#!/bin/sh\nmv "$POLYSTORE_BENCH_HOME" "$POLYSTORE_BENCH_HOME.original"\nln -s "$OPERATOR_DATA" "$POLYSTORE_BENCH_HOME"\nexit 89\n')
            cargo.chmod(0o755)
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}", POLYSTORE_BENCH_HOME=str(home), OPERATOR_DATA=str(target))
            result = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("home changed; refusing cleanup", result.stderr)
            self.assertTrue(home.is_symlink())
            self.assertEqual((target / "sentinel").read_text(), "preserve")


if __name__ == "__main__":
    unittest.main()
