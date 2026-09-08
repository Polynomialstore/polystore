"""Safety checks for the actual benchmark entrypoint; no build or node is run."""
import os
import base64
import copy
import hashlib
import json
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import retrieval_bench_artifact as artifact


SCRIPT = Path(__file__).with_name("bench_retrieval_sessions.sh")


class BenchmarkHomeTest(unittest.TestCase):
    def setUp(self):
        # Mock builds must not prepare or stamp the developer's real vendor tree.
        checkout = tempfile.TemporaryDirectory()
        self.addCleanup(checkout.cleanup)
        root = Path(checkout.name)
        for directory in ("scripts", "polystore_core", "polystorechain/vendor"):
            (root / directory).mkdir(parents=True)
        for name in (SCRIPT.name, "chain_go.sh", "retrieval_bench_artifact.py", "retrieval_consensus_profile.json"):
            shutil.copy2(SCRIPT.with_name(name), root / "scripts" / name)
        for name in ("go.mod", "go.sum", "vendor/correction.go"):
            (root / "polystorechain" / name).write_text("mock dependency\n")
        subprocess.run(["git", "init", "-q", str(root)], check=True)
        subprocess.run(["git", "-C", str(root), "add", "."], check=True)
        self.script = root / "scripts" / SCRIPT.name

    def test_external_fixture_overrides_are_rejected_before_home_or_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            marker = root / "build-called"
            fakebin = root / "bin"
            fakebin.mkdir()
            cargo = fakebin / "cargo"
            cargo.write_text('#!/bin/sh\nprintf called > "$BUILD_MARKER"\nexit 89\n')
            cargo.chmod(0o755)
            home = root / "new-home"
            output = root / "previous-result.json"
            output.write_text("preserve")
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}", BUILD_MARKER=str(marker),
                       POLYSTORE_BENCH_HOME=str(home), POLYSTORE_BENCH_OUTPUT=str(output))
            for name in ("POLYSTORE_BENCH_PROOFS_DIR", "POLYSTORE_BENCH_MANIFEST_ROOT"):
                with self.subTest(override=name):
                    result = subprocess.run(["bash", str(self.script)], env=dict(env, **{name: "untrusted"}),
                                            capture_output=True, text=True, timeout=10)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(name + " is unsupported", result.stderr)
                    self.assertFalse(marker.exists())
                    self.assertFalse(home.exists())
                    self.assertEqual(output.read_text(), "preserve")

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
                    result = subprocess.run(["bash", str(self.script)], env=dict(env, POLYSTORE_BENCH_HOME=str(home)), capture_output=True, text=True, timeout=10)
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
            output = root / "previous-result.json"
            previous = '{"status":"finished","sentinel":"preserve"}\n'
            output.write_text(previous)
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}", POLYSTORE_BENCH_HOME=str(home), POLYSTORE_BENCH_OUTPUT=str(output))
            for keep in (False, True):
                with self.subTest(keep=keep):
                    result = subprocess.run(["bash", str(self.script)] + (["--keep-home"] if keep else []), env=env, capture_output=True, text=True, timeout=10)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("cargo build --release failed", result.stderr)
                    self.assertEqual(home.is_dir(), keep)
                    self.assertEqual(output.read_text(), previous)

    def test_binary_is_built_inside_each_unique_default_home(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fakebin = root / "bin"
            fakebin.mkdir()
            for name, body in (
                ("cargo", "exit 0"),
                ("go", 'if [ "$1" = mod ] && [ "$2" = vendor ]; then exit 0; fi; printf "%s\\n" "$@" > "$BUILD_ARGS"; exit 89'),
            ):
                command = fakebin / name
                command.write_text("#!/bin/sh\n" + body + "\n")
                command.chmod(0o755)
            args_file = root / "args"
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}", BUILD_ARGS=str(args_file))
            env.pop("POLYSTORE_BENCH_HOME", None)
            homes = []
            for _ in range(2):
                result = subprocess.run(["bash", str(self.script)], env=env, capture_output=True, text=True, timeout=10)
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
            result = subprocess.run(["bash", str(self.script)], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("home changed; refusing cleanup", result.stderr)
            self.assertTrue(home.is_symlink())
            self.assertEqual((target / "sentinel").read_text(), "preserve")

    def test_cleanup_race_cannot_delete_replacement_contents(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fakebin = root / "bin"
            fakebin.mkdir()
            home = root / "home"
            cargo = fakebin / "cargo"
            cargo.write_text('#!/bin/sh\nmkdir "$POLYSTORE_BENCH_HOME/owned-child"\nexit 89\n')
            cargo.chmod(0o755)
            python = fakebin / "python3"
            # Replace the home immediately before the recursive deletion starts.
            python.write_text(f"#!{sys.executable}\n" + '''
import os, pathlib, re, shutil, sys
if len(sys.argv) > 1 and sys.argv[1] != "-":
    os.execv(sys.executable, [sys.executable] + sys.argv[1:])
code = sys.stdin.read()
if len(sys.argv) == 4 and re.fullmatch(r"[0-9]+:[0-9]+", sys.argv[3]):
    original = shutil.rmtree
    def replace_then_remove(*args, **kwargs):
        path = pathlib.Path(os.environ["POLYSTORE_BENCH_HOME"])
        path.rename(str(path) + ".original")
        path.mkdir()
        (path / "operator-data").write_text("preserve")
        return original(*args, **kwargs)
    shutil.rmtree = replace_then_remove
sys.argv = sys.argv[1:]
exec(compile(code, "<benchmark home>", "exec"))
''')
            python.chmod(0o755)
            env = dict(os.environ, PATH=f"{fakebin}:{os.environ['PATH']}", POLYSTORE_BENCH_HOME=str(home))
            result = subprocess.run(["bash", str(self.script)], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual((home / "operator-data").read_text(), "preserve")
            self.assertTrue(Path(str(home) + ".original").is_dir())


class BenchmarkArtifactTest(unittest.TestCase):
    def test_abort_retains_outcomes_and_specific_unknown_status(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "result.json"
            for status, expected, code in (("running", "aborted", 1),
                                           ("running", "aborted", 143),
                                           ("finished", "aborted", 1),
                                           ("aborted_unknown_transaction", "aborted_unknown_transaction", 1)):
                with self.subTest(status=status, code=code):
                    txs = [{"kind": "register-provider", "outcome": "checktx_rejected", "code": 11}]
                    path.write_text(json.dumps({"status": status, "txs": txs}))
                    artifact.abort_run(path, code)
                    self.assertEqual(json.loads(path.read_text()), {"status": expected, "txs": txs, "exit_code": code})
            with self.assertRaises(ValueError):
                artifact.abort_run(path, 0)

    def test_failed_open_accounts_for_each_unexecuted_stage(self):
        doc = {"config": {"sessions": 1, "proofs_per_session": 2}, "txs": [
            {"index": 1, "kind": "open-session", "outcome": "checktx_rejected"},
            {"index": 1, "kind": "submit-proof", "outcome": "skipped"},
            {"index": 1, "kind": "confirm-session", "outcome": "skipped"},
        ]}
        got = artifact.summarize(doc, 1, 1_000_000_001)
        self.assertEqual(got["load_records"], 3)
        self.assertEqual(got["load_txs_sent"], 1)
        self.assertEqual(got["load_outcomes"]["skipped"], 2)
        self.assertEqual(got["sessions_completed"], 0)
        self.assertEqual(got["proofs_committed"], 0)

    def test_committed_requires_exact_identity_height_code_and_gas(self):
        valid = {"txhash": "AB" * 32, "height": "1", "code": 0, "gas_wanted": "500", "gas_used": "400"}
        self.assertEqual(artifact.committed_tx(valid, "ab" * 32), valid)
        for name in valid:
            damaged = dict(valid)
            del damaged[name]
            with self.subTest(missing=name), self.assertRaises(ValueError):
                artifact.committed_tx(damaged, valid["txhash"])
        for changes in ({"height": "0"}, {"code": False}, {"gas_used": "-1"}, {"txhash": "CD" * 32}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                artifact.committed_tx(dict(valid, **changes), valid["txhash"])

    def test_outcomes_and_state_control_completion_and_rate_arithmetic(self):
        doc = {"config": {"sessions": 3, "proofs_per_session": 8}, "txs": [],
               "session_states": [{"index": 1, "completed": True}, {"index": 2, "completed": True}, {"index": 3, "completed": False}]}
        for index in range(1, 4):
            for kind in ("open-session", "submit-proof", "confirm-session"):
                doc["txs"].append({"index": index, "kind": kind, "code": 0, "outcome": "committed_success", "gas_used": 10})
        doc["txs"][4]["outcome"] = "unknown"  # code=0 alone is not evidence.
        got = artifact.summarize(doc, 1, 2_000_000_001)
        self.assertEqual(got["sessions_completed"], 1)
        self.assertEqual(got["sessions_per_sec"], 0.5)
        self.assertEqual(got["sessions_per_hour"], 1800)
        self.assertEqual(got["sessions_per_day"], 43200)
        self.assertEqual(got["proofs_committed"], 16)
        self.assertEqual(got["committed_gas_used"], 80)
        self.assertFalse(got["qualification"])
        with self.assertRaises(ValueError):
            artifact.summarize(doc, 1, 1)

    def test_session_state_matches_full_requested_identity(self):
        session = {"session_id": base64.b64encode(bytes(32)).decode(), "deal_id": "1", "owner": "owner", "provider": "provider", "nonce": "2", "blob_count": "8", "manifest_root": base64.b64encode(bytes(32)).decode(), "start_mdu_index": "2", "total_bytes": "1048576", "updated_height": "16", "status": "RETRIEVAL_SESSION_STATUS_COMPLETED"}
        args = ("00" * 32, "1", "owner", "provider", "2", "8", "00" * 32, "16")
        self.assertTrue(artifact.session_state({"session": session}, *args)["completed"])
        for name in ("session_id", "deal_id", "owner", "provider", "nonce", "blob_count", "manifest_root", "start_mdu_index", "total_bytes", "updated_height"):
            wrong = dict(session, **{name: "wrong"})
            with self.subTest(field=name), self.assertRaises((ValueError, TypeError)):
                artifact.session_state({"session": wrong}, *args)

    def test_proto_omitted_deal_zero_is_valid(self):
        session = {"session_id": base64.b64encode(bytes(32)).decode(), "owner": "owner", "provider": "provider", "nonce": "2", "blob_count": "8", "manifest_root": base64.b64encode(bytes(32)).decode(), "start_mdu_index": "2", "total_bytes": "1048576", "updated_height": "16", "status": "RETRIEVAL_SESSION_STATUS_COMPLETED"}
        self.assertTrue(artifact.session_state({"session": session}, "00" * 32, "0", "owner", "provider", "2", "8", "00" * 32, "16")["completed"])

    def test_opened_response_requires_exact_single_owning_envelope(self):
        # Independent bytes from a real committed CLI TxMsgData response.
        actual = "12670A412F706F6C7973746F7265636861696E2E706F6C7973746F7265636861696E2E76312E4D73674F70656E52657472696576616C53657373696F6E526573706F6E736512220A20C3393246784994291E73D21C496ECB46D5F3AB119DF54AD0640E978DF87D7FD2"
        session_id = "c3393246784994291e73d21c496ecb46d5f3ab119df54ad0640e978df87d7fd2"
        self.assertEqual(artifact.opened_session_id({"data": actual}), session_id)
        for malformed in (actual[:-2], actual + actual, actual + "00", actual.replace("1267", "1266", 1), actual.replace("4D7367", "587367", 1), "00" * 73 + session_id, "xx" + actual[2:]):
            with self.subTest(data=malformed[:12]), self.assertRaises(ValueError):
                artifact.opened_session_id({"data": malformed})

    def test_profile_has_fixed_predeclared_finite_budgets(self):
        consensus = {"block": {"max_gas": "64000000", "max_bytes": "2097152"}}
        got = artifact.profile("2", "32", "700", "2147483648", consensus)
        self.assertEqual(got["target_block_interval_ms"], 1000)
        self.assertEqual(got["execution_budget_ms"], 700)
        self.assertEqual(got["gas_limit"], "17000000")
        control = artifact.profile("1", "0", "700", "2147483648", consensus)
        self.assertEqual(control["gas_limit"], "1000000")
        for args in (("8193", "1", "700", "1"), ("1", "33", "700", "1"), ("1", "1", "0", "1"), ("1", "1", "700", "0")):
            with self.subTest(args=args), self.assertRaises(ValueError):
                artifact.profile(*args, consensus)
        unlimited = copy.deepcopy(consensus)
        unlimited["block"]["max_gas"] = "-1"
        with self.assertRaises(ValueError):
            artifact.profile("1", "1", "700", "1", unlimited)

    def test_clock_has_shared_origin_across_processes(self):
        helper = str(SCRIPT.with_name("retrieval_bench_artifact.py"))
        start = int(subprocess.check_output([sys.executable, helper, "clock"], text=True))
        # Python 3.9/macOS time.monotonic_ns() restarted near zero per process.
        subprocess.run([sys.executable, helper, "pace", str(start + 100_000_000)], check=True, timeout=5)
        end = int(subprocess.check_output([sys.executable, helper, "clock"], text=True))
        self.assertGreaterEqual(end - start, 100_000_000)
        self.assertLess(end - start, 5_000_000_000)

    def test_fixture_checks_hash_geometry_and_actual_proof_count(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = json.dumps({"proofs": [{}]}).encode()
            (root / "1.json").write_bytes(payload)
            manifest = "0x" + "ab" * 32
            (root / "manifest_root.txt").write_text(manifest)
            meta = {"schema_version": 1, "challenge_kind": "legacy-fixed-z", "data_pattern": "zero-filled-v1",
                    "data_sha256": hashlib.sha256(bytes(8 * 1024 * 1024)).hexdigest(),
                    "trusted_setup_sha256": "cd" * 32, "proof_payload_sha256": hashlib.sha256(payload).hexdigest(),
                    "manifest_root": manifest, "sessions": 1, "proofs_per_session": 1, "total_proofs": 1,
                    "k": 2, "m": 1, "slot": 0, "rows_per_slot": 32, "mdu_index": 2, "metadata_mdus": 2,
                    "user_mdus": 1, "data_bytes": 8388608, "raw_payload_capacity_bytes": 8126464, "encoded_blob_bytes": 131072}
            def write(value):
                (root / "fixture.json").write_text(json.dumps(value))
            write(meta)
            self.assertEqual(artifact.fixture(root, 1, 1, "zero-filled-v1")["total_proofs"], 1)
            for name, bad in (("k", 8), ("sessions", True), ("total_proofs", 2), ("data_sha256", "aa" * 32), ("proof_payload_sha256", "aa" * 32)):
                write(dict(meta, **{name: bad}))
                with self.subTest(field=name), self.assertRaises(ValueError):
                    artifact.fixture(root, 1, 1, "zero-filled-v1")
            # Even a correctly rehashed replacement must contain the promised count.
            payload = json.dumps({"proofs": []}).encode()
            (root / "1.json").write_bytes(payload)
            write(dict(meta, proof_payload_sha256=hashlib.sha256(payload).hexdigest()))
            with self.assertRaisesRegex(ValueError, "proof count"):
                artifact.fixture(root, 1, 1, "zero-filled-v1")

    def test_missing_fixture_is_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(FileNotFoundError):
                artifact.fixture(directory, 1, 1, "zero-filled-v1")


if __name__ == "__main__":
    unittest.main()
