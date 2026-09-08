"""Safety checks for the actual benchmark entrypoint; no build or node is run."""
import os
import base64
import copy
from decimal import Decimal
from fractions import Fraction
import hashlib
from itertools import combinations
import json
from math import comb
import shutil
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
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


class RetrievalSchedulerTest(unittest.TestCase):
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
