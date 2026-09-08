"""Safety checks for the actual benchmark entrypoint; no build or node is run."""
import os
import base64
import copy
from concurrent.futures import Future
from decimal import Decimal
from fractions import Fraction
import hashlib
import io
from itertools import combinations
import json
from math import comb
import shutil
import signal
import socket
import sqlite3
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from unittest.mock import patch

import retrieval_bench_artifact as artifact


SCRIPT = Path(__file__).with_name("bench_retrieval_sessions.sh")
# Independent bytes from a real committed CLI TxMsgData response.
OPEN_RESPONSE_DATA = "12670A412F706F6C7973746F7265636861696E2E706F6C7973746F7265636861696E2E76312E4D73674F70656E52657472696576616C53657373696F6E526573706F6E736512220A20C3393246784994291E73D21C496ECB46D5F3AB119DF54AD0640E978DF87D7FD2"


class BenchmarkHomeTest(unittest.TestCase):
    def setUp(self):
        # Mock builds must not prepare or stamp the developer's real vendor tree.
        checkout = tempfile.TemporaryDirectory()
        self.addCleanup(checkout.cleanup)
        root = Path(checkout.name)
        for directory in ("scripts", "polystore_core", "polystorechain/vendor"):
            (root / directory).mkdir(parents=True)
        for name in (SCRIPT.name, "chain_go.sh", "retrieval_bench_artifact.py", "retrieval_fresh_proof.py", "retrieval_consensus_profile.json"):
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
        actual = OPEN_RESPONSE_DATA
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


class ScheduledTransactionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.txhash = "AB" * 32

    def job(self, **response):
        # Real child processes exercise output draining and parsing. The query
        # includes fields that must never be retained in an in-memory record.
        committed = {"txhash": self.txhash, "height": "12", "code": 0,
                     "gas_used": "123", "gas_wanted": "200", "data": OPEN_RESPONSE_DATA,
                     "tx": {"signed_proof": "do-not-retain" * 10000}, "events": [{"ignored": True}]}
        committed.update(response)
        query = self.root / "query.json"
        query.write_text(json.dumps(committed))
        submit = self.root / "submit.json"
        submit.write_text(json.dumps({"code": 0, "txhash": self.txhash}))
        command = [sys.executable, "-c", "import pathlib,sys; print(pathlib.Path(sys.argv[1]).read_text())"]
        return {"kind": "open-session", "submit": [*command, str(submit)],
                "query": [*command, str(query)], "timeout_seconds": 1}

    def test_committed_open_data_is_canonical_and_decodable_without_signed_tx(self):
        result = artifact.scheduled_transaction(self.job())
        self.assertEqual(result["outcome"], "committed_success")
        self.assertEqual((result["height"], result["gas_used"]), (12, 123))
        self.assertEqual(result["data"], OPEN_RESPONSE_DATA.lower())
        self.assertEqual(artifact.opened_session_id(result), "c3393246784994291e73d21c496ecb46d5f3ab119df54ad0640e978df87d7fd2")
        self.assertNotIn("response_error", result)
        self.assertNotIn("tx", result)
        self.assertNotIn("events", result)
        self.assertNotIn("do-not-retain", json.dumps(result))
        self.assertLess(len(json.dumps(result)), 1024)

    def test_bad_response_data_preserves_commit_evidence_but_cannot_supply_id(self):
        for data in (None, 1, "x0", "0", OPEN_RESPONSE_DATA + "00", "00" * (artifact.MAX_RESPONSE_DATA_BYTES + 1)):
            with self.subTest(data=str(data)[:20]):
                result = artifact.scheduled_transaction(self.job(data=data))
                self.assertEqual((result["outcome"], result["txhash"], result["height"], result["code"]),
                                 ("committed_success", self.txhash, 12, 0))
                self.assertIn("response_error", result)
                self.assertNotIn("data", result)
                with self.assertRaises(ValueError):
                    artifact.opened_session_id(result)
        failed = artifact.scheduled_transaction(self.job(code=17, data=None))
        self.assertEqual((failed["outcome"], failed["code"]), ("committed_failure", 17))
        self.assertIn("response_error", failed)

    def test_generic_response_data_has_an_exact_retention_bound(self):
        for size in (artifact.MAX_RESPONSE_DATA_BYTES, artifact.MAX_RESPONSE_DATA_BYTES + 1):
            with self.subTest(size=size):
                job = self.job(data="AB" * size)
                job["kind"] = "transaction"
                result = artifact.scheduled_transaction(job)
                self.assertEqual(result["outcome"], "committed_success")
                if size == artifact.MAX_RESPONSE_DATA_BYTES:
                    self.assertEqual(result["data"], "ab" * size)
                else:
                    self.assertNotIn("data", result)
                    self.assertIn("oversized", result["response_error"])

    def test_submit_and_query_share_absolute_deadline(self):
        run = artifact.run_bounded_command
        for submit_ns, query_ns, expected in ((800_000_000, 100_000_000, "committed_success"),
                                               (800_000_000, 300_000_000, "unknown"),
                                               (1_000_000_000, 0, "unknown")):
            with self.subTest(submit_ns=submit_ns, query_ns=query_ns):
                job = self.job()
                now, calls = [0], []
                def command(argv, deadline):
                    calls.append((now[0], deadline))
                    result = run(argv, deadline)
                    # Model actual subprocess work without a timing-sensitive sleep.
                    now[0] += submit_ns if len(calls) == 1 else query_ns
                    return result
                with patch.object(artifact, "monotonic_ns", side_effect=lambda: now[0]), \
                     patch.object(artifact, "run_bounded_command", side_effect=command):
                    result = artifact.scheduled_transaction(job)
                self.assertEqual(result["outcome"], expected)
                self.assertEqual(result["checktx_latency_ns"], submit_ns)
                self.assertEqual(calls, [(0, 1_000_000_000)] +
                                 ([(submit_ns, 1_000_000_000)] if submit_ns < 1_000_000_000 else []))
                if expected == "committed_success":
                    self.assertEqual(result["commit_observation_latency_ns"], 900_000_000)
                else:
                    self.assertEqual(result["txhash"], self.txhash)
                    self.assertNotIn("data", result)

    def test_malformed_query_and_oversized_output_remain_unknown(self):
        run = artifact.run_bounded_command
        for scenario in ("malformed-query", "oversized-query", "oversized-submit"):
            with self.subTest(scenario=scenario):
                job = self.job()
                # Cap both pipes together; neither logs nor JSON may grow capture.
                flood = [sys.executable, "-c", "import os; os.write(1,b'x'*600); os.write(2,b'y'*600)"]
                if scenario == "malformed-query":
                    (self.root / "query.json").write_text("{}")
                elif scenario == "oversized-query":
                    job["query"] = flood
                else:
                    job["submit"] = flood
                now, calls = [0], []
                def command(argv, deadline):
                    calls.append(deadline)
                    try:
                        return run(argv, deadline)
                    finally:
                        now[0] += 600_000_000
                with patch.object(artifact, "MAX_COMMAND_OUTPUT_BYTES", 1024), \
                     patch.object(artifact, "monotonic_ns", side_effect=lambda: now[0]), \
                     patch.object(artifact, "run_bounded_command", side_effect=command):
                    result = artifact.scheduled_transaction(job)
                self.assertEqual(result["outcome"], "unknown")
                self.assertNotIn("data", result)
                self.assertEqual(calls, [1_000_000_000] * (1 if scenario == "oversized-submit" else 2))
                if scenario.startswith("oversized"):
                    self.assertIn("byte limit", result["error"])
                if scenario != "oversized-submit":
                    self.assertEqual(result["txhash"], self.txhash)

    def test_deadline_covers_pipe_drain_and_process_exit(self):
        for body in ("import time; print('partial', flush=True); time.sleep(10)",
                     "import os,time; os.close(1); os.close(2); time.sleep(10)"):
            with self.subTest(body=body), self.assertRaises(subprocess.TimeoutExpired):
                artifact.run_bounded_command([sys.executable, "-c", body], artifact.monotonic_ns() + 100_000_000)

    def test_timeout_kills_descendant_after_command_leader_exits(self):
        pidfile = self.root / "descendant.pid"
        # The direct child exits, but its descendant keeps both captured pipes
        # open. Killing only the direct child cannot clean up this command.
        body = """
import pathlib, subprocess, sys
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
pathlib.Path(sys.argv[1]).write_text(str(child.pid))
"""
        descendant = None
        try:
            with self.assertRaises(subprocess.TimeoutExpired):
                artifact.run_bounded_command([sys.executable, "-c", body, str(pidfile)],
                                             artifact.monotonic_ns() + 1_000_000_000)
            descendant = int(pidfile.read_text())
            # An orphan can briefly be a zombie before the OS reaps it. Unlike
            # kill(pid, 0), process state distinguishes that from a live child.
            deadline = artifact.monotonic_ns() + 1_000_000_000
            while True:
                state = subprocess.run(["ps", "-o", "stat=", "-p", str(descendant)],
                                       capture_output=True, text=True, timeout=1).stdout.strip()
                if not state or state.startswith("Z"):
                    break
                if artifact.monotonic_ns() >= deadline:
                    self.fail("descendant survived the command timeout: " + state)
                time.sleep(0.01)
        finally:
            # Also clean up if the regression fails against the old adapter.
            if descendant is None and pidfile.exists():
                descendant = int(pidfile.read_text())
            if descendant is not None:
                try:
                    os.kill(descendant, signal.SIGKILL)
                except ProcessLookupError:
                    pass


class RetrievalSchedulerTest(unittest.TestCase):
    def test_unresolved_warmup_exposure_overlaps_later_measurement(self):
        for outcome in ("unknown", "committed_success", "committed_failure", "checktx_rejected", "not_submitted"):
            with self.subTest(outcome=outcome):
                now = 0
                measurement_offset = 20_000_000
                jobs = [{"id": phase, "operation_id": phase, "phase": phase,
                         "signer": "address-" + phase, "offered_offset_ns": offset,
                         "timeout_seconds": 1, "query": ["must-not-run"],
                         "submit": ["must-not-run", "--from", "address-" + phase]}
                        for phase, offset in (("warmup", 0), ("measurement", measurement_offset))]

                def record_transaction(item):
                    nonlocal now
                    if item["phase"] == "warmup":
                        # Admit measurement only after the coordinator has
                        # recorded the warmup result and removed its worker.
                        now = measurement_offset

                def result(job):
                    return {"outcome": outcome if job["phase"] == "warmup" else "committed_success"}

                with patch.object(artifact, "monotonic_ns", side_effect=lambda: now), \
                        patch.object(artifact, "scheduled_transaction", side_effect=result):
                    report = artifact.schedule_transactions(jobs, max_in_flight=2, max_queued=1,
                                                            max_queued_per_signer=1,
                                                            record_transaction=record_transaction)
                warmup, measurement = report["transactions"]
                self.assertLess(warmup["finished_ns"], measurement["offered_ns"])
                self.assertEqual(measurement["outcome"], "committed_success")
                self.assertEqual(report["phases"]["warmup"]["outcomes"][outcome], 1)
                self.assertEqual(report["quarantined_signers"], ["address-warmup"] if outcome == "unknown" else [])
                self.assertEqual(report["warmup_overlapped_measurement"], outcome == "unknown")

    def test_fake_subprocess_load_bounds_signers_quarantine_and_accounting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / "fake_chain.py"
            fake.write_text(textwrap.dedent('''\
                import hashlib, json, os, pathlib, sys, time
                mode, directory, name, signer, scenario, hash_key = sys.argv[1:7]
                root = pathlib.Path(directory)
                lock = root / (signer + ".lock")
                txhash = hashlib.sha256(hash_key.encode()).hexdigest().upper()
                def event(kind):
                    fd = os.open(root / "events.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                    os.write(fd, (json.dumps({"kind": kind, "id": name, "signer": signer,
                                             "ns": time.monotonic_ns()}) + "\\n").encode())
                    os.close(fd)
                if mode == "submit":
                    try:
                        lock.mkdir()
                    except FileExistsError:
                        event("signer_conflict")
                        print(json.dumps({"code": 99}))
                        sys.exit(1)
                    event("submit")
                    if name in ("warm-a", "warm-b"):
                        (root / (name + ".ready")).touch()
                        deadline = time.monotonic() + 2
                        while not all((root / (other + ".ready")).exists() for other in ("warm-a", "warm-b")):
                            if time.monotonic() > deadline:
                                raise RuntimeError("global concurrency did not reach two")
                            time.sleep(0.001)
                        # Release only after the single artifact writer observes
                        # admission of the entire initial burst; no timing race.
                        while not (root / "release-warmup").exists():
                            if time.monotonic() > deadline:
                                raise RuntimeError("initial burst was not accounted")
                            time.sleep(0.001)
                    if scenario == "reject":
                        lock.rmdir()
                        event("rejected")
                        print(json.dumps({"code": 7}))
                    else:
                        print(json.dumps({"code": 0, "txhash": txhash}))
                elif scenario == "unknown":
                    print("{}")  # HTTP/CLI success alone is no commit evidence.
                else:
                    assert sys.argv[7] == txhash
                    lock.rmdir()
                    event("committed")
                    print(json.dumps({"txhash": txhash, "height": "4", "code": 0,
                                      "gas_wanted": "1000000", "gas_used": "900000"}))
            '''))

            def job(name, signer, *, phase="measurement", offset=0, deps=(), scenario="success", operation=None, hash_key=None):
                common = [str(root), name, signer, scenario, hash_key or name]
                return {"id": name, "operation_id": operation or name, "phase": phase,
                        "signer": signer, "offered_offset_ns": offset, "depends_on": list(deps),
                        "timeout_seconds": 1,
                        "submit": [sys.executable, str(fake), "submit", *common, "--from", signer],
                        "query": [sys.executable, str(fake), "query", *common]}

            jobs = [job("warm-a", "address-a", phase="warmup"), job("warm-b", "address-b", phase="warmup"),
                    job("proof-a", "address-a", deps=("warm-a",), operation="session-a"),
                    job("confirm-a", "address-a", deps=("proof-a",), operation="session-a"),
                    job("lane-overflow", "address-a"),
                    job("unknown-c", "address-c", scenario="unknown"), job("quarantined-c", "address-c"),
                    job("lane-overflow-c", "address-c"), job("proof-d", "address-d"),
                    job("duplicate-d", "address-d", deps=("proof-d",), hash_key="proof-d"),
                    job("reject-r", "address-r", scenario="reject"), job("dependent-r", "address-z", deps=("reject-r",)),
                    job("global-overflow", "address-e", offset=1)]
            persisted = []
            def record_transaction(item):
                persisted.append(item)
                if item["id"] == "global-overflow":
                    (root / "release-warmup").touch()
            report = artifact.schedule_transactions(jobs, max_in_flight=2, max_queued=8, max_queued_per_signer=2,
                                                    record_transaction=record_transaction)
            self.assertEqual(persisted, report["transactions"])
            records = {item["id"]: item for item in report["transactions"]}
            self.assertEqual(len(records), len(jobs))
            self.assertEqual((report["peak_in_flight"], report["peak_queued"], report["peak_queued_per_signer"]), (2, 8, 2))
            self.assertEqual(report["quarantined_signers"], ["address-c"])
            for name in ("lane-overflow", "lane-overflow-c", "global-overflow"):
                self.assertEqual((records[name]["outcome"], records[name]["error"]), ("not_submitted", "queue_full"))
            self.assertEqual(records["unknown-c"]["outcome"], "unknown")
            self.assertEqual(records["quarantined-c"]["error"], "signer_quarantined")
            self.assertEqual(records["duplicate-d"]["outcome"], "duplicate")
            self.assertEqual(records["reject-r"]["outcome"], "checktx_rejected")
            self.assertEqual(records["dependent-r"]["outcome"], "skipped")
            self.assertEqual(report["phases"]["warmup"]["outcomes"]["committed_success"], 2)
            self.assertEqual(report["phases"]["measurement"]["outcomes"]["committed_success"], 3)
            self.assertEqual(report["phases"]["measurement"]["offered"], 11)
            self.assertTrue(report["warmup_overlapped_measurement"])
            self.assertIsNone(report["completed_sessions"])
            self.assertFalse(report["qualification"])
            for planned in jobs:
                item = records[planned["id"]]
                self.assertEqual(item["offered_ns"], report["started_ns"] + planned["offered_offset_ns"])
                self.assertGreaterEqual(item["terminal_latency_ns"], 0)
                if item["started_ns"] is not None:
                    self.assertGreaterEqual(item["queue_latency_ns"], 0)
            operations = {item["operation_id"]: item for item in report["operations"]}
            self.assertTrue(operations["session-a"]["all_transactions_committed"])
            self.assertFalse(operations["duplicate-d"]["all_transactions_committed"])
            self.assertGreater(operations["session-a"]["terminal_latency_ns"], 0)
            events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
            self.assertNotIn("signer_conflict", {item["kind"] for item in events})
            self.assertEqual([item["id"] for item in events if item["kind"] == "submit" and item["signer"] == "address-c"], ["unknown-c"])
            active = set()
            for event in events:
                if event["kind"] == "submit":
                    self.assertNotIn(event["signer"], active)
                    active.add(event["signer"])
                    self.assertLessEqual(len(active), 2)
                else:
                    active.remove(event["signer"])
            self.assertEqual(active, {"address-c"})

            # Exhausted uncertainty credits stop unrelated queued broadcasts;
            # releasing only the worker must never release the global budget.
            exhausted = artifact.schedule_transactions(
                [job("unknown-x", "address-x", scenario="unknown"), job("blocked-y", "address-y")],
                max_in_flight=1, max_queued=1, max_queued_per_signer=1)
            self.assertEqual(exhausted["transactions"][1]["error"], "unknown_capacity_exhausted")
            self.assertIsNone(exhausted["transactions"][1]["started_ns"])

    def test_scheduler_rejects_invalid_plan_before_launch(self):
        job = {"id": "a", "operation_id": "a", "phase": "measurement", "signer": "address-a",
               "offered_offset_ns": 0, "timeout_seconds": 1,
               "submit": ["must-not-run", "--from", "address-a"], "query": ["must-not-run"]}
        for changes in ({"submit": ["must-not-run", "--from", "key-alias"]}, {"depends_on": ["future"]},
                        {"phase": "unknown"}, {"timeout_seconds": 0}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                artifact.schedule_transactions([dict(job, **changes)], max_in_flight=2, max_queued=2, max_queued_per_signer=1)
        with self.assertRaisesRegex(ValueError, "cannot span"):
            artifact.schedule_transactions([dict(job, phase="warmup"), dict(job, id="b")],
                                           max_in_flight=2, max_queued=2, max_queued_per_signer=1)


class IncrementalRetrievalLifecycleTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.fake = self.root / "chain.py"
        self.fake.write_text(textwrap.dedent('''\
            import hashlib, json, os, pathlib, sys
            mode, directory, operation, stage, signer, scenario = sys.argv[1:7]
            root = pathlib.Path(directory)
            sid = hashlib.sha256(operation.encode()).hexdigest()
            txhash = hashlib.sha256((operation + stage).encode()).hexdigest().upper()
            lock = root / (signer + ".lock")
            def event(kind):
                fd = os.open(root / "events.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                os.write(fd, (json.dumps(dict(kind=kind, operation=operation, stage=stage, signer=signer)) + "\\n").encode())
                os.close(fd)
            if mode == "submit":
                assert sys.argv[sys.argv.index("--from") + 1] == signer
                if stage != "open-session":
                    assert sys.argv[7] == sid, "reused or substituted session ID"
                try:
                    lock.mkdir()
                except FileExistsError:
                    event("conflicting_signer")
                    raise
                event("submit")
                print(json.dumps(dict(code=0, txhash=txhash)))
            elif scenario == "unknown" and stage == "submit-proof":
                print("{}")
            else:
                assert sys.argv[-1] == txhash
                lock.rmdir()
                event("commit")
                data = ""
                if stage == "open-session":
                    prefix = "12670A412F706F6C7973746F7265636861696E2E706F6C7973746F7265636861696E2E76312E4D73674F70656E52657472696576616C53657373696F6E526573706F6E736512220A20"
                    data = "00" if scenario == "bad-open" else prefix + sid
                print(json.dumps(dict(code=0, txhash=txhash, height="12", gas_used="50", gas_wanted="100", data=data)))
            '''))
        self.built = []

    def operation(self, identity, phase="measurement", offset=0, scenario="success"):
        stages = {}
        for stage, signer in (("open-session", "owner-a"), ("submit-proof", "provider-a"), ("confirm", "owner-a")):
            common = [str(self.root), identity, stage, signer, scenario]
            job = {"signer": signer, "query": [sys.executable, str(self.fake), "query", *common], "timeout_seconds": 1}
            if stage != "submit-proof":
                job["submit"] = [sys.executable, str(self.fake), "submit", *common,
                                 *(["{session_id}"] if stage == "confirm" else []), "--from", signer]
            stages[stage] = job
        return dict(operation_id=identity, phase=phase, offered_offset_ns=offset, scenario=scenario, **stages)

    def prepare(self, operation, session_id, deadline):
        self.assertGreater(deadline, artifact.monotonic_ns())
        self.assertEqual(session_id, hashlib.sha256(operation["operation_id"].encode()).hexdigest())
        self.built.append((operation["operation_id"], session_id))
        submit = [sys.executable, str(self.fake), "submit", str(self.root), operation["operation_id"],
                  "submit-proof", "provider-a", operation["scenario"], session_id, "--from", "provider-a"]
        return {"submit": submit, "session_id": session_id,
                "context_hash": hashlib.sha256((session_id + "context").encode()).hexdigest(),
                "seed": hashlib.sha256((session_id + "seed").encode()).hexdigest()}

    def run_operations(self, operations, **kwargs):
        return artifact.schedule_retrieval_lifecycles(iter(operations), journal_path=self.root / "run.sqlite",
            signers=["owner-a", "provider-a"], prepare_session_proof=self.prepare,
            max_in_flight=2, max_queued=4, max_queued_per_signer=2, **kwargs)

    def rows(self, table):
        with sqlite3.connect(self.root / "run.sqlite") as db:
            return [json.loads(row[0]) for row in db.execute(f"SELECT result FROM {table}")]

    def test_real_subprocess_fresh_ids_seed_stages_and_unknown_quarantine(self):
        report = self.run_operations([self.operation("good", "warmup"),
            self.operation("uncertain", "warmup", 0, "unknown"),
            self.operation("after", "measurement")])
        transactions = self.rows("transactions")
        operations = {row["operation_id"]: row for row in self.rows("operations")}
        self.assertTrue(operations["good"]["all_transactions_committed"])
        self.assertFalse(operations["uncertain"]["all_transactions_committed"])
        self.assertFalse(operations["after"]["all_transactions_committed"])
        self.assertEqual(report["quarantined_signers"], ["provider-a"])
        self.assertTrue(report["warmup_overlapped_measurement"])
        self.assertIsNone(report["transactions"])
        self.assertIsNone(report["operations"])
        self.assertIsNone(report["completed_sessions"])
        self.assertFalse(report["qualification"])
        self.assertEqual([name for name, _ in self.built], ["good", "uncertain"])
        proof = next(row for row in transactions if row["operation_id"] == "good" and row["kind"] == "submit-proof")
        self.assertEqual(proof["seed"], hashlib.sha256((proof["session_id"] + "seed").encode()).hexdigest())
        self.assertIn("preparation_latency_ns", proof)
        for row in transactions:
            self.assertNotIn("submit", row)
            self.assertNotIn("_state", row)
            self.assertGreaterEqual(row["terminal_latency_ns"], 0)
        events = [json.loads(line) for line in (self.root / "events.jsonl").read_text().splitlines()]
        self.assertNotIn("conflicting_signer", {event["kind"] for event in events})
        active = set()
        for event in events:
            if event["kind"] == "submit":
                self.assertNotIn(event["signer"], active)
                active.add(event["signer"])
                self.assertLessEqual(len(active), 2)
            else:
                active.remove(event["signer"])
        self.assertEqual(active, {"provider-a"})

    def test_committed_open_with_bad_response_cannot_build_proof_or_confirm(self):
        report = self.run_operations([self.operation("bad", scenario="bad-open")])
        self.assertEqual(self.built, [])
        self.assertEqual(len(self.rows("transactions")), 1)
        self.assertEqual(self.rows("transactions")[0]["outcome"], "committed_success")
        self.assertIn("stage_response_invalid", self.rows("operations")[0]["error"])
        self.assertEqual(report["quarantined_signers"], [])

    def test_more_than_8192_operations_over_simulated_15_minutes_keep_bounded_state(self):
        now, consumed = [0], [0]
        class ImmediateExecutor:
            def __init__(self, **kwargs): pass
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def submit(self, function, job):
                future = Future()
                future.set_result(function(job))
                return future
        def source():
            for index in range(10000):
                consumed[0] += 1
                yield self.operation(str(index), "warmup" if index < 10 else "measurement", index * 100_000_000)
        def reject(job):
            # At most one future operation was read while this operation ran.
            self.assertLessEqual(consumed[0], int(job["operation_id"]) + 2)
            self.assertEqual(now[0], job["offered_offset_ns"])
            return {"outcome": "checktx_rejected", "code": 7}
        def advance(seconds):
            now[0] += max(1, round(seconds * 1e9))
        with patch.object(artifact, "monotonic_ns", side_effect=lambda: now[0]), \
             patch.object(artifact.time, "sleep", side_effect=advance), \
             patch.object(artifact, "ThreadPoolExecutor", ImmediateExecutor), \
             patch.object(artifact, "scheduled_transaction", side_effect=reject):
            report = self.run_operations(source())
        self.assertEqual(consumed[0], 10000)
        self.assertGreaterEqual(report["finished_ns"] - report["started_ns"], 900 * 10**9)
        self.assertLessEqual(report["peak_retained_operation_states"], 2)
        self.assertEqual(report["phases"]["measurement"]["offered_operations"], 9990)
        self.assertEqual(report["phases"]["measurement"]["outcomes"]["checktx_rejected"], 9990)
        with sqlite3.connect(self.root / "run.sqlite") as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 10000)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM operations WHERE result IS NULL").fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT status FROM run").fetchone()[0], "finished")

    def test_builder_mismatch_and_expired_deadline_never_broadcast(self):
        for fault in ("session_id", "seed", "signer", "deadline"):
            with self.subTest(fault=fault):
                ledger = artifact.RetrievalLifecycleJournal(self.root / (fault + ".sqlite"), ["owner-a", "provider-a"], self.prepare)
                self.addCleanup(ledger.db.close)
                job = ledger.initial(self.operation(fault))
                state = job["_state"]
                state["session_id"] = hashlib.sha256(fault.encode()).hexdigest()
                proof = ledger.stage_job(state, "submit-proof")
                now = [0]
                def prepare(operation, session_id, deadline):
                    value = self.prepare(operation, session_id, deadline)
                    if fault in ("session_id", "seed"):
                        value[fault] = "invalid"
                    elif fault == "signer":
                        value["submit"][-1] = "owner-a"
                    else:
                        now[0] = deadline
                    return value
                ledger.prepare_session_proof = prepare
                with patch.object(artifact, "monotonic_ns", side_effect=lambda: now[0]), \
                     patch.object(artifact, "scheduled_transaction") as submit:
                    result = artifact.execute_scheduled_transaction(proof)
                self.assertEqual(result["outcome"], "not_submitted")
                submit.assert_not_called()

    def test_run_wide_hash_dedup_stops_a_repeated_open_before_preparation(self):
        def committed(job):
            identity = "first" if job["operation_id"] == "repeat" else job["operation_id"]
            txhash = hashlib.sha256((identity + job["kind"]).encode()).hexdigest().upper()
            result = {"outcome": "committed_success", "txhash": txhash}
            if job["kind"] == "open-session":
                result["data"] = OPEN_RESPONSE_DATA[:-64] + hashlib.sha256(job["operation_id"].encode()).hexdigest()
            return result
        with patch.object(artifact, "scheduled_transaction", side_effect=committed):
            report = self.run_operations([self.operation("first"), self.operation("repeat")])
        rows = self.rows("transactions")
        self.assertEqual(sum(row["outcome"] == "duplicate" for row in rows), 1)
        self.assertEqual([name for name, _ in self.built], ["first"])
        self.assertEqual(report["phases"]["measurement"]["outcomes"]["committed_success"], 3)
        self.assertFalse(next(row for row in self.rows("operations") if row["operation_id"] == "repeat")["all_transactions_committed"])

    def test_invalid_late_operation_aborts_ledger_without_restarting_the_stream(self):
        release = threading.Event()
        committed = {"outcome": "committed_success", "txhash": "AB" * 32,
                     "data": OPEN_RESPONSE_DATA, "height": 12}
        def submit(job):
            self.assertTrue(release.wait(1))
            return committed
        def source():
            yield self.operation("first")
            yield self.operation("queued")
            release.set()
            yield None
        with patch.object(artifact, "scheduled_transaction", side_effect=submit) as broadcast:
            with self.assertRaisesRegex(ValueError, "JSON object"):
                self.run_operations(source())
        self.assertEqual(broadcast.call_count, 1)
        self.assertEqual(self.built, [])
        transactions = self.rows("transactions")
        self.assertEqual(len(transactions), 3)
        actual = next(row for row in transactions if row["outcome"] == "committed_success")
        for name, value in committed.items():
            self.assertEqual(actual[name], value)
        self.assertEqual({(row["operation_id"], row["kind"], row["error"]) for row in transactions
                          if row["outcome"] == "not_submitted"},
                         {("queued", "open-session", "run_aborted"), ("first", "submit-proof", "run_aborted")})
        self.assertTrue(all(not row["all_transactions_committed"] and row["error"] == "run_aborted"
                            for row in self.rows("operations")))
        with sqlite3.connect(self.root / "run.sqlite") as db:
            self.assertEqual(db.execute("SELECT status FROM run").fetchone()[0], "aborted")
        with self.assertRaises(FileExistsError):
            self.run_operations([self.operation("first")])

    def test_proof_preparation_and_commit_use_one_stage_deadline(self):
        now, deadlines = [0], []
        ledger = artifact.RetrievalLifecycleJournal(self.root / "deadline.sqlite", ["owner-a", "provider-a"], self.prepare)
        self.addCleanup(ledger.db.close)
        state = ledger.initial(self.operation("deadline"))["_state"]
        state["session_id"] = hashlib.sha256(b"deadline").hexdigest()
        proof = ledger.stage_job(state, "submit-proof")
        def prepare(operation, session_id, deadline):
            value = self.prepare(operation, session_id, deadline)
            now[0] = 800_000_000
            return value
        def command(argv, deadline):
            deadlines.append(deadline)
            if len(deadlines) == 1:
                now[0] += 50_000_000
                value = {"code": 0, "txhash": "AB" * 32}
            else:
                now[0] += 300_000_000
                value = {"code": 0, "txhash": "AB" * 32, "height": "3", "gas_used": "1", "gas_wanted": "2"}
            return subprocess.CompletedProcess(argv, 0, json.dumps(value), "")
        ledger.prepare_session_proof = prepare
        with patch.object(artifact, "monotonic_ns", side_effect=lambda: now[0]), \
             patch.object(artifact, "run_bounded_command", side_effect=command):
            result = artifact.execute_scheduled_transaction(proof)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(result["preparation_latency_ns"], 800_000_000)
        self.assertEqual(deadlines, [1_000_000_000, 1_000_000_000])


class FourValidatorLifecycleTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.binary = self.root / "polystorechaind"
        # A real short-lived mock CLI writes the same generated file shapes.
        # Validator starts below are Popen mocks; no node or listener is run.
        self.binary.write_text(textwrap.dedent('''\
            #!/usr/bin/env python3
            import base64, json, pathlib, sys
            args = sys.argv[1:]
            home = pathlib.Path(args[args.index("--home") + 1])
            if args[0] == "multi-node":
                output = pathlib.Path(args[args.index("--output-dir") + 1])
                for i in range(4):
                    config = output / f"validator{i}" / "config"
                    config.mkdir(parents=True)
                    genesis = {"consensus": {"params": {"block": {}}}, "app_state": {
                        "bank": {"denom_metadata": []}, "nilchain": {"params": {
                            "retrieval_v2_activation_height": "0", "unchanged_fee": "17"}}}}
                    (config / "genesis.json").write_text(json.dumps(genesis))
                    (config / "config.toml").write_text('[consensus]\\ntimeout_commit = "5s"\\n[p2p]\\naddr_book_strict = true\\n[instrumentation]\\nprometheus_listen_addr = ":26660"\\n')
                    (config / "app.toml").write_text('[grpc]\\naddress = "localhost:9090"\\n[api]\\naddress = "tcp://localhost:1317"\\n')
                    (config / "priv_validator_key.json").write_text(json.dumps({"pub_key": {
                        "type": "tendermint/PubKeyEd25519", "value": base64.b64encode(bytes([i + 1]) * 32).decode()},
                        "priv_key": "NEVER RETAIN THIS SECRET"}))
            elif args[:2] == ["keys", "show"]:
                print("nil1" + args[2] + "a" * 35)
            elif args[:2] == ["comet", "show-node-id"]:
                print(str(int(home.name[-1]) + 1) * 40)
            elif args[0] not in ("keys", "genesis"):
                raise SystemExit("unexpected mock command")
            '''))
        self.binary.chmod(0o755)
        self.library = self.root / "libpolystore_core.so"
        self.library.write_bytes(b"mock native library")
        self.runner = artifact.FourValidatorLifecycle(self.binary, self.library, self.root / "run")
        self.started = []
        self.http_requests = []
        self.fault = None

    def response(self, request, timeout):
        self.http_requests.append(request)
        url = request.full_url
        height = request.get_header("X-cosmos-block-height")
        node = next(n for n in self.runner.nodes if f':{n["rpc"]}/' in url or f':{n["api"]}/' in url)
        if "/status" in url:
            value = {"node_info": {"id": node["node_id"], "network": self.runner.chain},
                     "sync_info": {"latest_block_height": "6" if len(self.started) > 4 else "3"}}
            if self.fault == "wrong_node":
                value["node_info"]["id"] = "0" * 40
        elif "/block?" in url:
            block_height = url.split("height=")[1]
            value = {"block": {"header": {"height": block_height, "chain_id": self.runner.chain,
                       "app_hash": "A" * 64}}, "block_id": {"hash": "B" * 64}}
            if self.fault == "app_hash" and node is self.runner.nodes[-1]:
                value["block"]["header"]["app_hash"] = "C" * 64
            if self.fault == "restart_state" and len(self.started) > 4:
                value["block"]["header"]["app_hash"] = "C" * 64
            if self.fault == "block_height":
                value["block"]["header"]["height"] = str(int(block_height) - 1)
        elif "/validators?" in url:
            value = {"block_height": url.split("height=")[1].split("&")[0], "total": "4",
                     "validators": [{"pub_key": n["validator_key"], "voting_power": "100"} for n in self.runner.nodes]}
            if self.fault == "voting_keys":
                value["validators"][-1] = value["validators"][0]
        else:
            denom = url.split("denom=")[1]
            amount = "100000000000" if denom == "stake" else "1000000000000000000"
            if "/supply/" in url:
                value = {"amount": {"denom": denom, "amount": str(int(amount) * 4)}}
            else:
                value = {"balance": {"denom": denom, "amount": amount}}
                if self.fault == "balance" and node is self.runner.nodes[-1]:
                    value["balance"]["amount"] = "1"
        if height is None:
            value = {"result": value}
        if self.fault == "empty":
            value = {}
        response = io.BytesIO(json.dumps(value).encode())
        response.status = 200
        response.headers = {"x-cosmos-block-height": "999" if self.fault == "economic_height" else height}
        return response

    def fake_start(self, argv, **kwargs):
        if argv[1] != "start":
            return self.real_popen(argv, **kwargs)
        # Native start exposes api.enable but reads api.address from app.toml.
        self.assertNotIn("--api.address", argv)
        home = Path(argv[argv.index("--home") + 1])
        node = next(n for n in self.runner.nodes if Path(n["home"]) == home)
        self.assertIn(f'[api]\naddress = "tcp://127.0.0.1:{node["api"]}"\n',
                      (home / "config/app.toml").read_text())
        class Process:
            returncode = None
            def poll(self):
                return self.returncode
            def terminate(self):
                self.returncode = 0
            def kill(self):
                self.returncode = -9
            def wait(self, timeout=None):
                if self.returncode is None:
                    raise AssertionError("must stop owned node before waiting")
                return self.returncode
        process = Process()
        self.started.append((argv, process))
        return process

    def run_mock(self):
        self.real_popen = subprocess.Popen
        with patch.object(self.runner, "reserve_ports") as reserve, \
             patch.object(artifact.subprocess, "Popen", side_effect=self.fake_start), \
             patch.object(artifact.urllib.request, "urlopen", side_effect=self.response):
            result = self.runner.run()
        self.assertEqual(reserve.call_count, 2)
        return result

    def test_mock_cli_four_keys_shared_genesis_and_persistent_restart(self):
        path = self.run_mock()
        doc = json.loads(path.read_text())
        self.assertEqual(doc["status"], "lifecycle_checks_passed")
        self.assertFalse(doc["qualification"])
        self.assertEqual(doc["transactions_submitted"], 0)
        self.assertEqual(len(self.started), 8)
        self.assertTrue(all(p.poll() == 0 for _, p in self.started))
        self.assertEqual([a for a, _ in self.started[:4]], [a for a, _ in self.started[4:]])
        self.assertEqual(doc["before_restart"], doc["after_restart_original_height"])
        self.assertEqual(doc["before_restart"]["height"], 2)
        self.assertEqual(doc["before_restart"]["app_hash_block_height"], 3)
        self.assertEqual(doc["after_restart_later_height"]["height"], 5)
        self.assertEqual(len(set(doc["signers"].values())), 4)
        self.assertEqual(self.runner.home.stat().st_mode & 0o777, 0o700)
        self.assertEqual(len([c for c in doc["commands"] if c[1] == "multi-node"]), 1)
        self.assertFalse(any("gentx" in c or "in-place-testnet" in c for c in doc["commands"]))
        self.assertNotIn("NEVER RETAIN THIS SECRET", path.read_text())
        for node in doc["nodes"]:
            home = Path(node["home"])
            self.assertEqual(artifact.sha256(home / "config/genesis.json"), doc["genesis_sha256"])
            self.assertIn('timeout_commit = "1s"', (home / "config/config.toml").read_text())
            self.assertTrue((home / "initial.log").exists())
            self.assertTrue((home / "restart.log").exists())
        self.assertEqual(doc["frozen_module_params"]["unchanged_fee"], "17")
        self.assertEqual(doc["profile"]["consensus"]["block"]["max_gas"], "64000000")

    def test_fixed_height_and_voting_evidence_rejects_malformed_or_disagreeing_nodes(self):
        self.runner.home.mkdir(mode=0o700)
        self.runner.prepare()
        for fault in ("economic_height", "block_height", "app_hash", "voting_keys", "balance", "empty"):
            with self.subTest(fault=fault), patch.object(artifact.urllib.request, "urlopen", side_effect=self.response):
                self.fault = fault
                with self.assertRaises((ValueError, KeyError)):
                    self.runner.snapshot(2)
        self.fault = "wrong_node"
        with patch.object(artifact.urllib.request, "urlopen", side_effect=self.response):
            with self.assertRaisesRegex(ValueError, "different node"):
                self.runner.wait_height(3)

    def test_failed_check_stops_owned_children_and_retains_failure_evidence(self):
        self.fault = "voting_keys"
        with self.assertRaisesRegex(ValueError, "validator set"):
            self.run_mock()
        self.assertEqual(len(self.started), 4)
        self.assertTrue(all(p.poll() == 0 for _, p in self.started))
        doc = json.loads((self.runner.home / "evidence.json").read_text())
        self.assertEqual(doc["status"], "failed")
        self.assertNotIn("after_restart_original_height", doc)

    def test_restart_cannot_replace_historical_state_even_if_all_nodes_agree(self):
        self.fault = "restart_state"
        with self.assertRaisesRegex(ValueError, "restart changed"):
            self.run_mock()
        self.assertEqual(len(self.started), 8)
        self.assertTrue(all(p.poll() == 0 for _, p in self.started))
        doc = json.loads((self.runner.home / "evidence.json").read_text())
        self.assertEqual(doc["status"], "failed")
        self.assertNotEqual(doc["before_restart"]["app_hash"], doc["after_restart_original_height"]["app_hash"])

    def test_existing_home_and_symlink_are_rejected_without_removal(self):
        existing = self.root / "operator"
        existing.mkdir()
        (existing / "sentinel").write_text("preserve")
        link = self.root / "link"
        link.symlink_to(existing)
        for home in (existing, link):
            with self.assertRaisesRegex(ValueError, "must not already exist"):
                artifact.FourValidatorLifecycle(self.binary, self.library, home)
        self.assertEqual((existing / "sentinel").read_text(), "preserve")
        self.assertTrue(link.is_symlink())

    def test_port_conflict_closes_only_own_reservations_before_any_cli(self):
        reservations = []
        class Reservation:
            closed = False
            def __init__(self):
                reservations.append(self)
            def setsockopt(self, level, option, value):
                self_option = (level, option, value)
                assert self_option == (socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            def listen(self, backlog):
                assert backlog == 1
            def bind(self, address):
                if len(reservations) == 3:
                    raise OSError("address already in use")
            def close(self):
                self.closed = True
        with patch.object(artifact.socket, "socket", side_effect=Reservation), \
             patch.object(self.runner, "cli") as cli:
            with self.assertRaisesRegex(OSError, "already in use"):
                self.runner.run()
        cli.assert_not_called()
        self.assertTrue(all(r.closed for r in reservations))
        self.assertEqual(json.loads((self.runner.home / "evidence.json").read_text())["status"], "failed")

    def test_restart_reservations_allow_time_wait_but_exclude_live_listeners(self):
        # Real TCP active close leaves the old server tuple in TIME_WAIT.
        server = socket.socket()
        server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server.bind(("127.0.0.1", 0))
        port = server.getsockname()[1]
        server.listen(1)
        server.settimeout(2)
        self.addCleanup(server.close)
        with socket.create_connection(("127.0.0.1", port), timeout=2) as client:
            accepted, _ = server.accept()
            with accepted:
                accepted.settimeout(2)
                accepted.shutdown(socket.SHUT_WR)
                self.assertEqual(client.recv(1), b"")
                client.shutdown(socket.SHUT_WR)
                self.assertEqual(accepted.recv(1), b"")
        server.close()
        with socket.socket() as old_probe:
            with self.assertRaises(OSError):
                old_probe.bind(("127.0.0.1", port))

        # Keep the remaining ephemeral ports distinct until the reservation.
        held = [socket.socket() for _ in range(4)]
        for sock in held:
            self.addCleanup(sock.close)
            sock.bind(("127.0.0.1", 0))
        ports = [port] + [sock.getsockname()[1] for sock in held]
        for sock in held:
            sock.close()
        self.runner.nodes = [dict(zip(("rpc", "p2p", "grpc", "api", "metrics"), ports))]
        self.addCleanup(lambda: [sock.close() for sock in self.runner.reservations])
        self.runner.reserve_ports()
        self.assertEqual(len(self.runner.reservations), 5)
        # A second reservation cannot steal the same port, even with REUSEADDR.
        other = artifact.FourValidatorLifecycle(self.binary, self.library, self.root / "other")
        other.nodes = self.runner.nodes
        self.addCleanup(lambda: [sock.close() for sock in other.reservations])
        with self.assertRaises(OSError):
            other.reserve_ports()

    def test_oversized_http_body_is_not_evidence(self):
        response = io.BytesIO(b"x" * (artifact.MAX_COMMAND_OUTPUT_BYTES + 1))
        response.status = 200
        response.headers = {}
        with patch.object(artifact.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(ValueError, "oversized"):
                self.runner.query(self.runner.nodes[0], "/status")

    def test_runtime_artifact_change_blocks_restart_before_any_process(self):
        self.runner.doc["provenance"] = {"binary_sha256": "0" * 64}
        with patch.object(artifact.subprocess, "Popen") as popen:
            with self.assertRaisesRegex(ValueError, "artifact changed"):
                self.runner.start("restart")
        popen.assert_not_called()

    def test_generated_toml_setting_is_section_specific_and_fails_on_drift(self):
        original = '[rpc]\nladdr = "public"\n[p2p]\nladdr = "peer"\n'
        self.assertEqual(artifact.set_toml_value(original, "p2p", "laddr", '"local"'),
                         '[rpc]\nladdr = "public"\n[p2p]\nladdr = "local"\n')
        for text in ("", '[p2p]\nladdr = "a"\nladdr = "b"\n'):
            with self.assertRaisesRegex(ValueError, "expected one"):
                artifact.set_toml_value(text, "p2p", "laddr", '"local"')

    def test_opt_in_help_does_not_require_builds_or_create_homes(self):
        result = subprocess.run(["bash", str(SCRIPT), "--help"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("legacy-serial", result.stdout)
        self.assertIn("four-validator-lifecycle", result.stdout)
        result = subprocess.run(["bash", str(SCRIPT), "--binary", str(self.binary), "--help"],
                                env=dict(os.environ, POLYSTORE_BENCH_MODE="four-validator-lifecycle"),
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("26657/26654/26651/26648", result.stdout)
        self.assertFalse(self.runner.home.exists())


class RetrievalArithmeticTest(unittest.TestCase):
    def test_encoding_constants_match_production_sources(self):
        root = SCRIPT.parent.parent
        kzg = (root / "polystore_core/src/kzg.rs").read_text()
        coding = (root / "polystore_core/src/coding.rs").read_text()
        challenge = (root / "polystorechain/pkg/retrievalchallenge/challenge.go").read_text()
        # Fail visibly if the native encoding/profile or protocol ceiling changes.
        self.assertIn(f"BLOB_SIZE: usize = {artifact.ENCODED_BLOB_BYTES};", kzg)
        self.assertIn("MDU_SIZE: usize = 8 * 1024 * 1024;", kzg)
        self.assertIn(f"SCALAR_BYTES: usize = {artifact.SCALAR_BYTES};", coding)
        self.assertIn(f"SCALAR_PAYLOAD_BYTES: usize = {artifact.SCALAR_PAYLOAD_BYTES};", coding)
        self.assertIn(f"DATA_SHARDS_NUM: usize = {artifact.DEFAULT_K};", coding)
        self.assertIn(f"SHARDS_NUM: usize = {artifact.DEFAULT_K + artifact.DEFAULT_M};", coding)
        self.assertRegex(challenge, rf"MaxSamples\s*= uint64\({artifact.MAX_AUDIT_SAMPLES}\)")

    def test_denominators_against_enumerated_legal_windows(self):
        unit = artifact.PAYLOAD_BLOB_BYTES
        for k in (1, 2, 4, 8, 16, 32, 64):
            for offset in (0, unit - 512, 63 * unit + 11, 64 * unit - 512, 130 * unit):
                for length in (0, 1, 1024, unit, 64 * unit + 1, 193 * unit):
                    with self.subTest(k=k, offset=offset, length=length):
                        # Enumerate intersected encoded atoms and group actual
                        # (MDU, slot, row) positions; independent of the shortcut.
                        windows = {}
                        for index in range((offset + length) // unit + 1):
                            if length and index * unit < offset + length and (index + 1) * unit > offset:
                                mdu, blob = divmod(index, 64)
                                row, slot = divmod(blob, k)
                                windows.setdefault((mdu, slot), []).append(row)
                        for rows in windows.values():
                            self.assertEqual(rows, list(range(rows[0], rows[-1] + 1)))
                            self.assertLessEqual(len(rows), 64 // k)
                        actual = artifact.retrieval_denominator(offset, length, k=k)
                        blobs = sum(map(len, windows.values()))
                        self.assertEqual(actual["unique_data_blobs"], blobs)
                        self.assertEqual(actual["legal_session_windows"], len(windows))
                        self.assertEqual(actual["user_mdus_touched"], len({mdu for mdu, _ in windows}))
                        self.assertEqual(actual["verified_encoded_bytes"], blobs * 131072)
                        self.assertEqual(actual["billed_encoded_bytes"], actual["verified_encoded_bytes"])

    def test_frozen_payload_and_encoded_denominators(self):
        report = artifact.arithmetic_report()
        self.assertEqual(report["encoding"]["payload_blob_bytes"], 126976)
        cases = report["denominators"]
        for name, count in (("payload_1kib_inside", 1), ("payload_1kib_crossing", 2)):
            self.assertEqual(cases[name]["requested_bytes"], 1024)
            self.assertEqual(cases[name]["fresh_blob_openings"], count)
            self.assertEqual(cases[name]["billed_encoded_bytes"], count * 131072)
        encoded = cases["encoded_1gib_aligned"]
        self.assertEqual(encoded["unique_data_blobs"], 8192)
        self.assertEqual(encoded["verified_encoded_bytes"], 1 << 30)
        logical = cases["payload_1gib_aligned"]
        self.assertEqual((logical["unique_data_blobs"], logical["user_mdus_touched"],
                          logical["legal_session_windows"], logical["billed_encoded_bytes"]),
                         (8457, 133, 1064, 1108475904))
        windows = {(i // 64, i % 64 % 8) for i in range(8457)}
        self.assertEqual(len(windows), logical["legal_session_windows"])
        self.assertEqual({slot for mdu, slot in windows if mdu == 132}, set(range(8)))
        population = report["audit_population_for_payload_1gib"]
        self.assertEqual(population["stored_encoded_blobs_per_slot_assignment"], 1064)
        self.assertEqual(population["stored_encoded_blobs_across_all_slots"], 12768)

    def test_range_integer_validation_and_precision(self):
        unit = artifact.PAYLOAD_BLOB_BYTES
        offset = ((1 << 53) // unit + 1) * unit
        self.assertEqual(artifact.retrieval_denominator(offset, unit)["unique_data_blobs"], 1)
        for args, kwargs in (((-1, 1), {}), ((0, True), {}), (((1 << 63) - 1, 1), {}),
                             ((0, 1), {"k": 3}), ((0, 1), {"encoded": 1})):
            with self.subTest(args=args, kwargs=kwargs), self.assertRaises(ValueError):
                artifact.retrieval_denominator(*args, **kwargs)

    def test_hypergeometric_against_exhaustive_distinct_subsets(self):
        for population in range(10):
            for unavailable in range(population + 1):
                absent = set(range(unavailable))
                for samples in range(population + 1):
                    draws = list(combinations(range(population), samples))
                    misses = sum(absent.isdisjoint(draw) for draw in draws)
                    actual = artifact.sampling_miss(population, unavailable, samples)
                    self.assertEqual(actual, Fraction(misses, len(draws)))
                    if population:
                        self.assertLessEqual(actual, Fraction(population - unavailable, population) ** samples)

    def test_sampling_boundaries_and_exact_large_cases(self):
        self.assertEqual(artifact.sampling_miss(0, 0, 0), 1)
        self.assertEqual(artifact.sampling_miss(1, 1, 1), 0)
        self.assertEqual(artifact.sampling_miss(1, 0, 1), 1)
        self.assertEqual(artifact.sampling_miss(8192, 1, 132), 1 - Fraction(132, 8192))
        self.assertEqual(artifact.sampling_miss(1064, 107, 132), Fraction(comb(957, 132), comb(1064, 132)))
        self.assertGreater(artifact.sampling_miss(64, 7, 57), 0)
        self.assertEqual(artifact.sampling_miss(64, 7, 58), 0)
        for args in ((0, 1, 0), (1, 0, 2), (8192, 0, 4097), (1, -1, 0), (True, 0, 0)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                artifact.sampling_miss(*args)

    def test_fraction_bounds_have_exact_thresholds(self):
        epsilon = Fraction(1, 1000000)
        for available, samples in ((Fraction(9, 10), 132), (Fraction(99, 100), 1375)):
            self.assertLessEqual(available ** samples, epsilon)
            self.assertGreater(available ** (samples - 1), epsilon)
        self.assertGreater(Fraction(9, 10) ** 64, epsilon)

    def test_probability_serialization_does_not_cancel_or_underflow(self):
        case = artifact.sampling_case(8192, 1, 132)
        self.assertEqual(Decimal(case["detection_probability"]) * 100, Decimal("1.611328125"))
        case = artifact.sampling_case((1 << 63) - 1, 1, 1)
        self.assertGreater(Decimal(case["detection_probability"]), 0)
        case = artifact.sampling_case(8192, 4096, 4096)
        self.assertGreater(Decimal(case["miss_probability"]), 0)
        self.assertLess(Decimal(case["miss_probability"]), Decimal("1e-2400"))

    def test_offline_subcommand_is_self_contained_and_unqualified(self):
        helper = SCRIPT.with_name("retrieval_bench_artifact.py")
        # No repo cwd, node, setup, native library, network or binary is needed.
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([sys.executable, str(helper), "arithmetic"], cwd=directory,
                                    text=True, capture_output=True, check=True, timeout=10)
        doc = json.loads(result.stdout)
        self.assertEqual(doc, artifact.arithmetic_report())
        self.assertFalse(doc["qualification"])
        self.assertFalse(doc["runtime_measured"])
        self.assertEqual([item["bound_at_most_1e_minus_6"] for item in
                          doc["sampling"]["fraction_bound_targets"]], [False, True, True])
        result = subprocess.run([sys.executable, str(helper), "arithmetic", "ignored"],
                                text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("takes no arguments", result.stderr)


if __name__ == "__main__":
    unittest.main()
