"""Offline orchestration/economic regressions; no nodes, ports, native load or builds."""
import base64
import copy
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import retrieval_bench_artifact as artifact
import retrieval_four_validator_workload as workload
import retrieval_fresh_proof as producer

ADDRESSES = ["nil1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdqqjtx", "nil1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuyxhqs",
             "nil1xycnzvf3xycnzvf3xycnzvf3xycnzvf3ner3g8", "nil1xgeryv3jxgeryv3jxgeryv3jxgeryv3jza95r3"]
AUDIT_ADDRESSES = [
    "nil102e0z53k4ks07fffg4f5g9mm2ke0ppry6hldnq", "nil10489zrpfztul0avxgd0va5f0ru5wae2cjmhdtp",
    "nil10y7kv0jqy2e7fnwuv39yga53u59j3e4tw4vdqc", "nil10yrlgscjqs3m5g4nd8uxfgde064ks347uzcvc7",
    "nil12hdzex4uscgph556tlczw2lztdhgnlxvu4rm3s", "nil12lqej2x9de9t8mgk5e98huk7k2k6gagsr27awn",
    "nil12nfaymvwcdhwka2jdcsl5ml2y6e76lkgsje38k", "nil12ueq7u6uqxjd35mc704sjamwwxydsgsytw9lfu",
    "nil12v3u485sazwmfcnfah7dlvrtgkqlf5xkh5rthd", "nil137glcssk75ttt280qwyx4f3k8h5lgeu5s6rduh",
    "nil139mxr38p09rxk56a0dej5asy3d2ww397fttud7", "nil140pc0w3z6x6f6dkme8eux8naw5wd6rmxm5gfh8",
]


def fixture_state():
    life = SimpleNamespace(binary=Path("/binary"), chain="polystore_260-1", deadline=artifact.monotonic_ns() + 60 * 10**9,
        nodes=[dict(home="/home/validator0", rpc=26657)],
        env=dict(GOMAXPROCS="2", POLYSTORE_TRUSTED_SETUP="/setup", DYLD_LIBRARY_PATH="/lib", SECRET="excluded"),
        signers=dict(zip(("owner0", "owner1", "provider0", "provider1"), ADDRESSES)))
    fixtures, deals = {}, {}
    for i, k in enumerate((8, 2)):
        root = bytes([k]) * 32
        fixtures[k] = dict(k=k, m=4 if k == 8 else 1, manifest_root="0x" + root.hex())
        deals[k] = dict(id=str(i), owner=ADDRESSES[i], manifest_root=base64.b64encode(root).decode(), total_mdus="3",
            witness_mdus="1", redundancy_mode=2, end_block="1000", current_gen="1",
            mode2_slots=[dict(slot=0, status="SLOT_STATUS_ACTIVE", provider=ADDRESSES[i + 2])])
    operations = workload.build_operations(life, fixtures, deals, 10)
    return life, fixtures, deals, operations


def settlement_fixture():
    life, _, _, operations = fixture_state()
    params = dict(base_retrieval_fee=dict(denom="stake", amount="3"), retrieval_price_per_blob=dict(denom="stake", amount="17"), retrieval_burn_bps="3333")
    before = dict(bank=dict(balances={name + ":stake": "10000" for name in life.signers}, supply=dict(stake="100000")),
        retrieval=dict(params=params, module_stake="20000", deals={str(i): dict(escrow_balance="10000") for i in (0, 1)},
                       activities={str(i): {} for i in (0, 1)}, sessions={}))
    after = copy.deepcopy(before)
    after["bank"]["supply"]["stake"] = "99854"
    after["retrieval"]["module_stake"] = "19608"
    for i in (0, 1):
        after["bank"]["balances"][f"provider{i}:stake"] = "10123"
        after["retrieval"]["deals"][str(i)]["escrow_balance"] = "9804"
        after["retrieval"]["activities"][str(i)] = dict(successful_retrievals_total="3", bytes_served_total="1441792")
    results, transactions = {}, []
    for i, op in enumerate(operations):
        sid = bytes([i + 1] * 32).hex()
        results[op["operation_id"]] = dict(session_id=sid, all_transactions_committed=True)
        expected = copy.deepcopy(op["proof_expectation"]["session"])
        expected.update(session_id=base64.b64encode(bytes.fromhex(sid)).decode(),
                        manifest_root=base64.b64encode(bytes.fromhex(expected["manifest_root"])).decode(),
                        status="RETRIEVAL_SESSION_STATUS_COMPLETED", locked_fee="0", challenge_version=2, updated_height="42")
        after["retrieval"]["sessions"][sid] = expected
        for kind in ("open-session", "submit-proof", "confirm"):
            transactions.append(dict(operation_id=op["operation_id"], kind=kind, height=42, outcome="committed_success"))
    return before, after, operations, results, transactions, life.signers


class FourValidatorWorkloadTest(unittest.TestCase):
    def test_transaction_verification_uses_fenced_blocks_not_tx_indexes(self):
        raw = b"signed transaction"
        txhash = hashlib.sha256(raw).hexdigest().upper()
        fenced = [False]
        lifecycle = SimpleNamespace(
            chain="polystore_291-1", nodes=[{"node_id": str(i)} for i in range(4)])
        def wait_height(height):
            self.assertEqual(height, 20)
            fenced[0] = True
            return height
        def query(node, route):
            self.assertTrue(fenced[0])
            self.assertNotIn("/tx?hash", route)
            if route == "/block?height=19":
                return {"block_id": {"hash": "11" * 32}, "block": {
                    "header": {"height": "19", "chain_id": lifecycle.chain,
                               "app_hash": "22" * 32, "time": "2026-01-01T00:00:00Z"},
                    "data": {"txs": [base64.b64encode(raw).decode()]}}}
            if route == "/block_results?height=19":
                return {"height": "19", "txs_results": [
                    {"code": 0, "gas_wanted": "500000", "gas_used": "400000"}]}
            self.fail("unexpected query " + route)
        lifecycle.wait_height = Mock(side_effect=wait_height)
        lifecycle.query = Mock(side_effect=query)
        rows = workload.verify_transaction_nodes(lifecycle, dict(
            txhash=txhash, height=19, code=0, gas_wanted=500000, gas_used=400000))
        self.assertEqual(len(rows), 4)
        self.assertEqual(lifecycle.query.call_count, 8)
        lifecycle.wait_height.assert_called_once_with(20)

    def test_commit_captures_share_phase_deadline_and_never_qualify(self):
        sample = dict(chain_id="polystore_260-1", count=12, sum_seconds="0.15",
                      wall_time_ns=123, monotonic_start_ns=456, monotonic_end_ns=789)
        raw = json.dumps(sample) + "\n"
        for remaining in (3, 30):
            with self.subTest(remaining=remaining):
                life = SimpleNamespace(doc={}, chain=sample["chain_id"], env={"GOMAXPROCS": "2"},
                    deadline=(10 + remaining) * 10**9,
                    nodes=[dict(node_id=str(i), metrics=26660 + i) for i in range(4)])
                with patch.object(artifact, "monotonic_ns", return_value=10 * 10**9), \
                     patch.object(artifact, "run_bounded_command", return_value=SimpleNamespace(
                         returncode=0, stdout=raw, stderr="")) as command:
                    workload.capture_workload_metrics(life, "before_workload")
                    workload.capture_workload_metrics(life, "after_workload")
                self.assertEqual(command.call_count, 8)
                for index, call in enumerate(command.call_args_list):
                    self.assertEqual(call.args[1], (10 + min(remaining, 5)) * 10**9)
                    self.assertEqual(call.kwargs, dict(env=life.env))
                    self.assertEqual(call.args[0], [workload.sys.executable, workload.commit_metrics.__file__,
                        f"http://127.0.0.1:{26660 + index % 4}/metrics", life.chain, "--timeout", "2"])
                evidence = life.doc["commit_step_metrics"]
                self.assertFalse(evidence["qualification"])
                self.assertFalse(evidence["boundaries_reconciled"])
                self.assertNotIn("p95_upper_bound_seconds", evidence)
                for phase in evidence["phases"].values():
                    self.assertTrue(phase["complete"])
                    self.assertEqual(len(phase["nodes"]), 4)
                    for row in phase["nodes"]:
                        self.assertEqual(row["stdout"], raw)
                        self.assertEqual(row["sample"], sample)

    def test_commit_capture_failure_retains_partial_evidence_and_fails_closed(self):
        good = SimpleNamespace(returncode=0, stdout=json.dumps(dict(chain_id="polystore_260-1")), stderr="")
        failures = [SimpleNamespace(returncode=1, stdout="", stderr="missing Commit metrics"),
                    SimpleNamespace(returncode=0, stdout="not JSON", stderr=""),
                    SimpleNamespace(returncode=0, stdout='{"chain_id":"wrong"}', stderr=""),
                    subprocess.TimeoutExpired("capture", 0)]
        for failure in failures:
            with self.subTest(failure=failure):
                life = SimpleNamespace(doc={}, chain="polystore_260-1", env={}, deadline=10**30,
                    nodes=[dict(node_id=str(i), metrics=26660 + i) for i in range(4)])
                with patch.object(artifact, "run_bounded_command", side_effect=[good, failure]) as command:
                    with self.assertRaisesRegex(ValueError, "after_workload Commit metric capture failed for 1"):
                        workload.capture_workload_metrics(life, "after_workload")
                self.assertEqual(command.call_count, 2)
                evidence = life.doc["commit_step_metrics"]
                self.assertFalse(evidence["qualification"])
                phase = evidence["phases"]["after_workload"]
                self.assertFalse(phase["complete"])
                self.assertEqual(phase["nodes"][0]["sample"]["chain_id"], life.chain)
                self.assertIn("error", phase["nodes"][1])

    def test_old_cli_fails_before_bootstrap_or_transactions(self):
        with tempfile.TemporaryDirectory() as tmp:
            life = SimpleNamespace(home=Path(tmp) / "run", doc={}, reservations=[],
                cli=Mock(return_value="Usage: polystorechaind tx nilchain open-retrieval-session [flags]"),
                reserve_ports=Mock(), prepare=Mock(), start=Mock(), stop=Mock(), save=Mock())
            with patch.object(workload, "copy_fixture") as fixtures, \
                 patch.object(artifact, "scheduled_transaction") as submit:
                with self.assertRaisesRegex(ValueError, "#257 compatible CLI required"):
                    workload.run(life, "k8", "k2")
                fixtures.assert_not_called()
                life.reserve_ports.assert_not_called()
                life.prepare.assert_not_called()
                life.start.assert_not_called()
                submit.assert_not_called()
                life.stop.assert_called_once()
                life.save.assert_called_once()
                self.assertEqual(life.doc["status"], "failed")

    def test_cli_capability_check_requires_all_three_commands(self):
        life = SimpleNamespace(home=Path("/home"), doc={}, cli=Mock(side_effect=[
            "open-retrieval-session [flags]\n --challenge-version uint\n --authorized-proof-provider string",
            "submit-retrieval-proof [json-file] [flags]",
            "confirm-retrieval-session [flags]\n --session-id string"]))
        workload.require_retrieval_cli(life)
        self.assertEqual(life.cli.call_count, 3)
        self.assertEqual(len(life.doc["retrieval_cli_capabilities"]), 3)

    def test_stop_failure_still_closes_reservations_saves_evidence_and_restores_signals(self):
        events = []
        reservation = Mock()
        reservation.close.side_effect = lambda: events.append("close")
        def failed_stop():
            events.append("stop")
            raise RuntimeError("validator stop failed")
        with tempfile.TemporaryDirectory() as tmp:
            life = SimpleNamespace(home=Path(tmp) / "run", doc={}, reservations=[reservation],
                stop=failed_stop, save=lambda: events.append("save"))
            with patch.object(workload, "copy_fixture", side_effect=ValueError("invalid fixture")), \
                 patch.object(workload, "require_retrieval_cli"), \
                 patch.object(workload.signal, "getsignal", return_value="previous-handler"), \
                 patch.object(workload.signal, "signal") as set_signal:
                with self.assertRaisesRegex(RuntimeError, "validator stop failed"):
                    workload.run(life, "k8", "k2")
                self.assertEqual(events, ["stop", "close", "save"])
                self.assertEqual(life.doc["status"], "failed")
                self.assertEqual(life.doc["error"], "invalid fixture")
                self.assertEqual([call.args for call in set_signal.call_args_list[-2:]],
                    [(workload.signal.SIGTERM, "previous-handler"), (workload.signal.SIGINT, "previous-handler")])

    def test_two_owner_matrix_pins_intent_and_real_authorities(self):
        life, _, _, operations = fixture_state()
        self.assertEqual(len(operations), 6)
        self.assertEqual([(op["proof_expectation"]["snapshot"]["k"], op["proof_expectation"]["session"]["blob_count"]) for op in operations],
                         [(8, 1), (8, 2), (8, 8), (2, 1), (2, 2), (2, 8)])
        self.assertEqual({op["submit-proof"]["signer"] for op in operations}, set(ADDRESSES[2:]))
        for op in operations:
            self.assertEqual(op["proof_expectation"]["snapshot"]["slot"], 0)
            self.assertEqual(op["proof_expectation"]["session"]["owner"], op["open-session"]["signer"])
            self.assertNotIn("submit", op["submit-proof"])
            self.assertIn("{session_id}", op["confirm"]["submit"])
            self.assertIn("{proof_path}", op["proof_submit"])
            self.assertNotIn("SECRET", op["open-session"]["env"])
            self.assertEqual(op["open-session"]["_deadline_ns"], life.deadline)

    def test_unexpected_committed_deal_fails_before_open(self):
        life, fixtures, deals, _ = fixture_state()
        for field, bad in (("owner", ADDRESSES[1]), ("manifest_root", base64.b64encode(bytes(32)).decode()), ("total_mdus", "4")):
            changed = copy.deepcopy(deals)
            changed[8][field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                workload.build_operations(life, fixtures, changed, 10)

    def test_copy_fixture_preserves_and_authenticates_full_export(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for k in (8, 2):
                source = root / f"source{k}"
                source.mkdir()
                payload = dict(proofs=[dict(mdu_index="2", blob_index=i, blob_commitment=base64.b64encode(bytes([i+1])*48).decode()) for i in range(64//k)])
                raw = json.dumps(payload).encode()
                meta = dict(schema_version=1, k=k, m=4 if k == 8 else 1, slot=0, mdu_index=2, metadata_mdus=2,
                    user_mdus=1, data_bytes=8388608, encoded_blob_bytes=131072, rows_per_slot=64//k, proofs_per_session=64//k,
                    challenge_kind="legacy-fixed-z", data_pattern="be-fr-last-byte-cycle-1-through-251-v1",
                    trusted_setup_sha256=producer.SETUP_DIGEST, manifest_root="0x" + "01"*32,
                    proof_payload_sha256=hashlib.sha256(raw).hexdigest())
                (source / "1.json").write_bytes(raw)
                (source / "fixture.json").write_text(json.dumps(meta))
                result = workload.copy_fixture(source, root / f"copy{k}", k)
                self.assertEqual((Path(result["directory"]) / "1.json").read_bytes(), raw)
                (source / "1.json").write_bytes(raw + b" ")
                with self.assertRaisesRegex(ValueError, "digest"):
                    workload.copy_fixture(source, root / f"bad{k}", k)
                self.assertFalse((root / f"bad{k}").exists())

    def test_exact_conservation_and_corruption_rejection(self):
        values = settlement_fixture()
        result = workload.verify_settlement(*values)
        self.assertEqual((result["completed_sessions"], result["proofs"], result["burned_stake"]), (6, 22, 146))
        self.assertEqual(result["escrow_debits"], {"0": 196, "1": 196})
        sid = next(iter(values[1]["retrieval"]["sessions"]))
        cases = [(["bank", "balances", "owner0:stake"], "9999"),
                 (["bank", "balances", "provider0:stake"], "10124"),
                 (["bank", "supply", "stake"], "99855"), (["retrieval", "module_stake"], "19609"),
                 (["retrieval", "deals", "0", "escrow_balance"], "9805"),
                 (["retrieval", "activities", "0", "successful_retrievals_total"], "4"),
                 (["retrieval", "sessions", sid, "status"], "RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED"),
                 (["retrieval", "sessions", sid, "authorized_proof_provider"], ADDRESSES[3]),
                 (["retrieval", "sessions", sid, "locked_fee"], "17"),
                 (["retrieval", "sessions", sid, "funding"], 2)]
        for path, bad in cases:
            changed = list(copy.deepcopy(values))
            target = changed[1]
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = bad
            with self.subTest(path=path), self.assertRaises(ValueError):
                workload.verify_settlement(*changed)

    def test_incomplete_journal_is_not_completion_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "journal.sqlite"
            with sqlite3.connect(path) as db:
                db.executescript("CREATE TABLE operations(id TEXT, result TEXT); CREATE TABLE transactions(result TEXT);")
                db.execute("INSERT INTO operations VALUES (?,?)", ("one", json.dumps(dict(all_transactions_committed=False))))
            with self.assertRaisesRegex(ValueError, "did not commit"):
                workload.journal_results(path, [dict(operation_id="one")])

    def test_smoke_genesis_preserves_consensus_and_audits(self):
        with tempfile.TemporaryDirectory() as tmp:
            nodes = [dict(home=str(Path(tmp) / str(i))) for i in range(4)]
            genesis = dict(consensus=dict(params=dict(block=dict(max_bytes="2097152", max_gas="64000000"))),
                app_state=dict(nilchain=dict(params=dict(epoch_len_blocks="100", retrieval_v2_activation_height="1")),
                               mint=dict(minter=dict(inflation="0.13"), params=dict(mint_denom="stake"))))
            for node in nodes:
                path = Path(node["home"]) / "config"
                path.mkdir(parents=True)
                (path / "genesis.json").write_text(json.dumps(genesis))
            calls = []
            life = SimpleNamespace(nodes=nodes, doc={}, cli=lambda *args: calls.append(args))
            workload.smoke_genesis(life)
            outputs = [(Path(node["home"]) / "config/genesis.json").read_bytes() for node in nodes]
            self.assertTrue(all(raw == outputs[0] for raw in outputs))
            self.assertEqual(len(calls), 4)
            actual = json.loads(outputs[0])
            self.assertEqual(actual["consensus"], genesis["consensus"])
            self.assertEqual(actual["app_state"]["nilchain"]["params"]["epoch_len_blocks"], "100")
            self.assertEqual(actual["app_state"]["mint"], genesis["app_state"]["mint"])
            self.assertEqual(life.doc["genesis_sha256"], hashlib.sha256(outputs[0]).hexdigest())

    def test_all_four_retrieval_reads_are_height_pinned_and_must_agree(self):
        calls = []
        def query(node, route, height):
            calls.append((node["id"], height))
            if "module_accounts" in route:
                return dict(account=dict(base_account=dict(address=ADDRESSES[0])))
            if "balances" in route:
                return dict(balance=dict(denom="stake", amount="100" if node["id"] != 3 else "101"))
            return dict(params={})
        life = SimpleNamespace(nodes=[dict(id=i) for i in range(4)], snapshot=lambda height: dict(height=height), query=query)
        with self.assertRaisesRegex(ValueError, "four validators disagree"):
            workload.retrieval_snapshot(life, 42, {}, [])
        self.assertEqual({node for node, _ in calls}, {0, 1, 2, 3})
        self.assertTrue(all(height == 42 for _, height in calls))

    def test_failed_fresh_proof_never_confirms(self):
        _, _, _, operations = fixture_state()
        operation = operations[0]
        submitted = []
        response_type = b"/polystorechain.polystorechain.v1.MsgOpenRetrievalSessionResponse"
        any_value = b"\x0a" + bytes([len(response_type)]) + response_type + b"\x12\x22\x0a\x20"
        data = (b"\x12" + bytes([len(any_value)+32]) + any_value + bytes([1])*32).hex()
        def submit(job):
            submitted.append(job["kind"])
            return dict(outcome="committed_success", txhash="AB"*32, data=data, height=11)
        def broken(*args):
            raise ValueError("invalid fixture commitment")
        with tempfile.TemporaryDirectory() as tmp, patch.object(artifact, "scheduled_transaction", side_effect=submit):
            path = Path(tmp) / "journal.sqlite"
            artifact.schedule_retrieval_lifecycles([operation], journal_path=path, signers=ADDRESSES,
                prepare_session_proof=broken, max_in_flight=2, max_queued=4, max_queued_per_signer=4)
            self.assertEqual(submitted, ["open-session"])
            with self.assertRaises(ValueError):
                workload.journal_results(path, [operation])


class NativeV3PilotHelpersTest(unittest.TestCase):
    ROOT = "11" * 32
    INTEGRITY = "22" * 32
    SESSION = "33" * 32

    def session(self, *, expired=False, refunded=False):
        bitmap = bytearray(17)
        for ordinal in range(132):
            if ordinal != 17:
                bitmap[ordinal // 8] |= 1 << (ordinal % 8)
        counts = [17] * 7 + [14]
        return dict(session=dict(
            session_id=base64.b64encode(bytes.fromhex(self.SESSION)).decode(), deal_id="7",
            generation="1", owner=AUDIT_ADDRESSES[8], payer=AUDIT_ADDRESSES[8], nonce="1",
            polyfs_root=base64.b64encode(bytes.fromhex(self.ROOT)).decode(),
            integrity_root=base64.b64encode(bytes.fromhex(self.INTEGRITY)).decode(),
            setup_digest=base64.b64encode(bytes.fromhex(producer.SETUP_DIGEST)).decode(), plan_hash=base64.b64encode(bytes([8]) * 32).decode(),
            file_record_index=0, file_start_offset="0", file_length=str(workload.V3_PILOT_BYTES),
            range_start="0", range_length=str(workload.V3_PILOT_BYTES), metadata_mdus="2", user_mdus="3",
            first_blob="0", last_blob="132", population="133", sample_count="132", nonce_string="unused",
            deadline_height="250", chain_id="polystore_291-1", accepted_sample_bitmap=base64.b64encode(bitmap).decode(),
            obligations=[dict(slot=i, assigned_provider=AUDIT_ADDRESSES[i], payee=AUDIT_ADDRESSES[i],
                              blob_count=str(count), sample_count="0", locked_fee=str(count))
                         for i, count in enumerate(counts)],
            acked_slots_mask=0, settled_slots_mask=0,
            refunded_slots_mask=255 if refunded else 0, locked_fee="0" if refunded else "133",
            expired=expired))

    def validate_session(self, value, **kwargs):
        return workload.validate_v3_session(value, session_id=self.SESSION, deal_id="7",
            owner=AUDIT_ADDRESSES[8], providers=dict(enumerate(AUDIT_ADDRESSES[:8])), nonce=1,
            polyfs_root=self.ROOT, integrity_root=self.INTEGRITY, chain_id="polystore_291-1",
            deadline_height=250, **kwargs)

    def test_session_bitmap_and_refund_authorities_fail_closed(self):
        session, accepted = self.validate_session(self.session())
        self.assertEqual((len(accepted), 17 in accepted, sum(int(o["blob_count"]) for o in session["obligations"])),
                         (131, False, 133))
        self.validate_session(self.session(expired=True), expired=True)
        self.validate_session(self.session(expired=True, refunded=True), expired=True, refunded=True)
        mutations = {
            "wrong root": lambda s: s.update(polyfs_root=base64.b64encode(bytes(32)).decode()),
            "wrong chain": lambda s: s.update(chain_id="other"),
            "wrong deadline": lambda s: s.update(deadline_height="251"),
            "wrong setup": lambda s: s.update(setup_digest=base64.b64encode(bytes([9]) * 32).decode()),
            "wrong partition": lambda s: s["obligations"][0].update(blob_count="18"),
            "premature refund": lambda s: s.update(refunded_slots_mask=255, locked_fee="0"),
            "settled without ack": lambda s: s.update(settled_slots_mask=1),
            "padding bit": lambda s: s.update(accepted_sample_bitmap=base64.b64encode(bytes([255]) * 17).decode()),
        }
        for name, mutate in mutations.items():
            value = self.session()
            mutate(value["session"])
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.validate_session(value)

    def test_open_response_is_exact_and_nonzero(self):
        sid = bytes.fromhex(self.SESSION)
        kind = b"/polystorechain.polystorechain.v1.MsgOpenRetrievalSessionV3Response"
        suffix = (b"\x10" + workload._encode_varint(workload.V3_PILOT_BYTES) +
                  b"\x18" + workload._encode_varint(133 * artifact.ENCODED_BLOB_BYTES) +
                  b"\x20" + workload._encode_varint(132))
        response = b"\x0a\x20" + sid + suffix
        any_value = b"\x0a" + workload._encode_varint(len(kind)) + kind + b"\x12" + workload._encode_varint(len(response)) + response
        raw = b"\x12" + workload._encode_varint(len(any_value)) + any_value
        self.assertEqual(workload.opened_v3_session(dict(outcome="committed_success", data=raw.hex())), self.SESSION)
        for changed in (raw + b"\x00", bytes([raw[0] ^ 1]) + raw[1:], raw.replace(sid, bytes(32))):
            with self.assertRaises(ValueError):
                workload.opened_v3_session(dict(outcome="committed_success", data=changed.hex()))

    def test_provider_wave_and_committed_message_are_exact(self):
        providers = dict(enumerate(AUDIT_ADDRESSES[:8]))
        rows = [dict(status="success", http_status=200, session_id="0x" + self.SESSION, cleanup_status="complete",
                     slot=i, provider=providers[i], proof_count=17 if i < 7 else 13,
                     tx_hash=f"{i + 1:064x}") for i in range(8)]
        self.assertEqual(workload.validate_v3_provider_outcomes(rows, providers, session_id=self.SESSION)["proof_count"], 132)
        for field, bad in (("http_status", 202), ("cleanup_status", "pending"),
                           ("tx_hash", rows[1]["tx_hash"]), ("session_id", self.SESSION),
                           ("session_id", "0x" + "00" * 32)):
            changed = copy.deepcopy(rows)
            changed[0][field] = bad
            with self.subTest(field=field), self.assertRaises(ValueError):
                workload.validate_v3_provider_outcomes(changed, providers, session_id=self.SESSION)
        message = {"@type": "/polystorechain.polystorechain.v1.MsgSubmitRetrievalSessionProofV3",
                   "creator": providers[0], "slot": 0,
                   "session_id": base64.b64encode(bytes.fromhex(self.SESSION)).decode(),
                   "proofs": [{"ordinal": str(i)} for i in range(17)]}
        self.assertEqual(workload.validate_v3_committed_message(message, kind="session-proof",
            creator=providers[0], slot=0, session_id=self.SESSION, proof_count=17), list(range(17)))
        duplicate = copy.deepcopy(message)
        duplicate["proofs"][-1]["ordinal"] = "0"
        with self.assertRaises(ValueError):
            workload.validate_v3_committed_message(duplicate, kind="session-proof",
                creator=providers[0], slot=0, session_id=self.SESSION, proof_count=17)


    def test_provider_endpoint_uses_address_not_assignment_slot(self):
        lifecycle = SimpleNamespace(doc={"providers": [
            {"address": AUDIT_ADDRESSES[1], "port": 19091},
            {"address": AUDIT_ADDRESSES[0], "port": 19092},
        ]})
        self.assertEqual(workload.provider_http_url(lifecycle, AUDIT_ADDRESSES[0], "/sp/session-proof"),
                         "http://127.0.0.1:19092/sp/session-proof")
        with self.assertRaises(ValueError):
            workload.provider_http_url(lifecycle, AUDIT_ADDRESSES[2], "/sp/session-proof")

    def test_unfenced_v3_queries_choose_one_common_height(self):
        calls = []
        lifecycle = SimpleNamespace(nodes=[{"id": i} for i in range(4)],
            wait_height=Mock(return_value=77))
        session = self.session()
        retained = {"generations": [{"deal_id": "7", "generation": "1",
            "manifest_root": base64.b64encode(bytes.fromhex(self.ROOT)).decode()}]}
        def query(node, route, height):
            calls.append((node["id"], route, height))
            return retained if route.endswith("retained-generations") else session
        lifecycle.query = query
        self.assertEqual(workload.v3_session_query(lifecycle, self.SESSION), session)
        self.assertEqual(workload.v3_retained_generations(
            lifecycle, deal_id="7", root=self.ROOT), retained)
        self.assertEqual(lifecycle.wait_height.call_count, 2)
        self.assertEqual({row[2] for row in calls}, {77})

    def test_http_phase_drains_and_retains_provider_tagged_outcomes(self):
        with tempfile.TemporaryDirectory() as tmp:
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 10**9, save=Mock(), remaining=Mock(return_value=1))
            requests = [dict(provider="provider-a", url="http://a/ok", body={}),
                        dict(provider="provider-b", url="http://b/fail", body={})]
            def run(argv, deadline, env):
                if "/fail" in argv[-1]:
                    raise ValueError("expected provider failure")
                Path(argv[argv.index("--output") + 1]).write_text('{"status":"success"}')
                return SimpleNamespace(stdout="200", stderr="", returncode=0)
            with patch.object(artifact, "run_bounded_command", side_effect=run), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES):
                with self.assertRaisesRegex(ValueError, "expected provider failure"):
                    workload.run_v3_http_phase(lifecycle, "/curl", requests, "proofs", max_in_flight=2)
            retained = lifecycle.doc["v3_http_phases"]["proofs"]
            self.assertEqual({row["provider"] for row in retained}, {"provider-a", "provider-b"})
            self.assertEqual({row["status"] for row in retained}, {"success", "driver_error"})

    def test_native_v3_provider_routes_use_gateway_auth_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 10**9, save=Mock(), remaining=Mock(return_value=1))
            captured = []
            def run(argv, deadline, env):
                captured.append(argv)
                Path(argv[argv.index("--output") + 1]).write_text('{"status":"success"}')
                return SimpleNamespace(stdout="200", stderr="", returncode=0)
            requests = [
                ("generation-acceptance", "/sp/generation-v3/accept", {"deal_id": 7, "provider": "provider-a"}),
                ("session-proof", "/sp/session-proof", {"session_id": self.SESSION}),
            ]
            with patch.object(artifact, "run_bounded_command", side_effect=run), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES):
                for phase, route, body in requests:
                    workload.run_v3_http_phase(lifecycle, "/curl", [dict(
                        provider="provider-a", url="http://provider" + route, body=body,
                    )], phase, max_in_flight=1)
            expected = "X-PolyStore-Gateway-Auth: " + workload.V3_PROVIDER_AUTH_TOKEN
            self.assertEqual(len(captured), 2)
            for argv, (_, route, body) in zip(captured, requests):
                headers = [argv[index + 1] for index, value in enumerate(argv[:-1]) if value == "--header"]
                self.assertIn(expected, headers)
                self.assertFalse(any(value.startswith("Authorization:") for value in headers))
                self.assertEqual(json.loads(argv[argv.index("--data") + 1]), body)
                self.assertTrue(argv[-1].endswith(route))

    def test_disk_threshold_fails_closed(self):
        with patch.object(workload.shutil, "disk_usage", return_value=SimpleNamespace(free=99)):
            with self.assertRaisesRegex(ValueError, "found 99"):
                workload.require_free_disk(Path("/"), 100, "pilot")

    def test_session_list_is_retained_before_first_open_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            lifecycle = SimpleNamespace(home=Path(tmp), doc={"native_v3_generation": {
                "candidate": {"integrity_root": "0x" + self.INTEGRITY}}},
                signers={"owner0": AUDIT_ADDRESSES[8]}, chain="polystore_291-1",
                wait_height=Mock(return_value=70), save=Mock())
            deal = {"id": "7", "end_block": "1000",
                    "manifest_root": base64.b64encode(bytes.fromhex(self.ROOT)).decode()}
            with patch.object(workload, "v3_retained_generations", return_value={}), \
                 self.assertRaisesRegex(ValueError, "open failed"):
                workload.run_native_v3_sessions(lifecycle, deal=deal,
                    providers=dict(enumerate(AUDIT_ADDRESSES[:8])),
                    send=Mock(side_effect=ValueError("open failed")), wait=Mock(), curl="/curl")
            self.assertEqual(lifecycle.doc["native_v3"]["sessions"], [])
            lifecycle.save.assert_called()

    def test_first_generation_empty_root_is_canonical_cli_hex(self):
        candidate = dict(deal_id="7", expected_current_generation="0",
            previous_polyfs_root="", polyfs_root="0x" + self.ROOT,
            integrity_root="0x" + self.INTEGRITY, size_bytes=str(workload.V3_PILOT_BYTES),
            total_mdus="5", witness_mdus="1", integrity_leaf_count="288",
            commit_action="propose-deal-generation-v3", required_acceptances="12")
        lifecycle = SimpleNamespace(signers={"owner0": AUDIT_ADDRESSES[8]},
            nodes=[{"home": "/home", "rpc": 26657}], env={}, deadline=artifact.monotonic_ns() + 10**9,
            binary=Path("/chain"), chain="polystore_291-1")
        for spelling in ("", "0x"):
            candidate["previous_polyfs_root"] = spelling
            captured = []
            def send(name, args):
                captured.append(workload.transaction_job(lifecycle, lifecycle.signers[name], args))
                raise ValueError("stop after scheduled proposal")
            with self.subTest(spelling=spelling), self.assertRaisesRegex(ValueError, "stop after scheduled proposal"):
                workload.admit_native_v3_generation(lifecycle,
                    uploaded={"generation_candidate": copy.deepcopy(candidate)}, deal_id="7",
                    providers=dict(enumerate(AUDIT_ADDRESSES)), send=send, curl="/curl")
            argv = captured[0]["submit"]
            self.assertNotIn("", argv)
            self.assertEqual(argv[argv.index("--previous-polyfs-root") + 1], "0x")



class HealthyAuditViewsTest(unittest.TestCase):
    def test_native_v3_cli_is_fixed_bounded_and_normal_audit_only(self):
        common = ["diagnostic", "--mode", "native-v3-providers", "--binary", "/chain",
                  "--library", "/lib", "--home", "/new-home"]
        required = ["--gateway-binary", "/gateway", "--cli-binary", "/native-cli", "--product-source", "/source"]
        for extra in ([], required + ["--timeout", "601"], required + ["--audit-profile", "c6"],
                      required + ["--proof-only"]):
            with self.subTest(extra=extra), patch.object(workload.sys, "argv", common + extra), \
                 patch.object(workload.sys, "stderr"), patch.object(artifact, "FourValidatorLifecycle") as constructor:
                with self.assertRaises(SystemExit) as error:
                    workload.main()
                self.assertEqual(error.exception.code, 2)
                constructor.assert_not_called()
        with patch.object(workload.sys, "argv", common + required + ["--timeout", "600"]), \
             patch.object(artifact, "FourValidatorLifecycle") as constructor, \
             patch.object(workload, "run_healthy", return_value="evidence") as run, patch("builtins.print"):
            workload.main()
            run.assert_called_once_with(constructor.return_value, "/gateway", "/native-cli", "/source",
                                        native_v3=True, audit_profile="normal")

    def test_healthy_cli_requires_explicit_binaries_and_bounded_timeout(self):
        common = ["diagnostic", "--mode", "healthy-providers", "--binary", "/chain",
                  "--library", "/lib", "--home", "/new-home"]
        required = ["--gateway-binary", "/gateway", "--cli-binary", "/native-cli", "--product-source", "/source"]
        for extra in ([], required + ["--timeout", "601"], required + ["--proof-only"]):
            with self.subTest(extra=extra), patch.object(workload.sys, "argv", common + extra), \
                 patch.object(workload.sys, "stderr"), patch.object(artifact, "FourValidatorLifecycle") as constructor:
                with self.assertRaises(SystemExit) as error:
                    workload.main()
                self.assertEqual(error.exception.code, 2)
                constructor.assert_not_called()
        with patch.object(workload.sys, "argv", common + required + ["--timeout", "600"]), \
             patch.object(artifact, "FourValidatorLifecycle") as constructor, \
             patch.object(workload, "run_healthy", return_value="evidence") as run, patch("builtins.print"):
            workload.main()
            run.assert_called_once_with(constructor.return_value, "/gateway", "/native-cli", "/source", audit_profile="normal")

    def test_sustained_cli_defaults_k2_and_forwards_explicit_k8(self):
        common = ["diagnostic", "--mode", "sustained-providers", "--binary", "/chain", "--library", "/lib",
                  "--home", "/new-home", "--gateway-binary", "/gateway", "--cli-binary", "/native-cli",
                  "--product-source", "/source", "--proof-exporter", "/exporter", "--proof-gas", "20000000",
                  "--step-seconds", "4"]
        cases = (([], 2, 1, 8),
                 (["--sustained-k", "8", "--sustained-rate-scale", "4", "--sustained-deputies", "32"],
                  8, 4, 32))
        for extra, k, rate_scale, deputies in cases:
            with self.subTest(k=k), patch.object(workload.sys, "argv", common + extra), \
                 patch.object(artifact, "FourValidatorLifecycle") as constructor, \
                 patch.object(workload, "run_healthy", return_value="evidence") as run, patch("builtins.print"):
                workload.main()
                run.assert_called_once_with(constructor.return_value, "/gateway", "/native-cli", "/source",
                    sustained=dict(exporter="/exporter", step_seconds=4, proof_gas=20000000, k=k,
                                   rate_scale=rate_scale, deputy_count=deputies), audit_profile="normal")

    def fixture(self, *, complete=True, counts=None, k=2):
        layout = workload.mode2_layout(k)
        counts = (1, 9, 32) if counts is None and k == 2 else counts or (1,) * layout["assignments"]
        deal = dict(id="7", manifest_root=base64.b64encode(bytes([7]) * 32).decode(),
                    current_gen="1", start_block="5", end_block="1000")
        providers = dict(enumerate(AUDIT_ADDRESSES[:layout["assignments"]]))
        values = []
        for slot, count in enumerate(counts):
            accepted = count if complete else 0
            snapshot = dict(chain_id="polystore_260-1", generation="1", layout=2, k=k, m=layout["m"],
                            slot=slot, metadata_mdus="2", user_mdus="1", deal_end="1000",
                            setup_digest=base64.b64encode(bytes.fromhex(producer.SETUP_DIGEST)).decode())
            context = dict(version=2, chain_id="polystore_260-1", setup_digest=producer.SETUP_DIGEST,
                kind=2, context_id="00"*32, deal_id=7, generation=1, root="07"*32,
                assigned=producer.account(providers[slot]).hex(), payee=producer.account(providers[slot]).hex(),
                layout=2, k=k, m=layout["m"], slot=slot, metadata_mdus=2, user_mdus=1, start_mdu=0, start_leaf=0,
                blob_count=0, epoch_id=2, epoch_length=100, sample_count=count, snapshot_height=100,
                anchor_height=101, first_response_height=102, deadline_height=200, deal_end=1000)
            values.append(dict(audit=dict(epoch_id="2", sample_count=str(count), accepted_count=str(accepted),
                coverage=base64.b64encode(((1 << accepted) - 1).to_bytes((count + 7)//8, "little")).decode(),
                missed_epochs="0", assignment=dict(deal_id="7", deal_start="5", provider=providers[slot],
                    manifest_root=deal["manifest_root"], snapshot=snapshot, kind=2)),
                epoch_length="100", seed=base64.b64encode(bytes([8])*32).decode(), finalized=complete,
                canonical_context=base64.b64encode(producer.context_bytes(context)).decode()))
        return values, deal, providers

    def check(self, values, deal, providers, *, finalized=True):
        return workload.healthy_audit_views(values, deal, providers, 2, 100, "polystore_260-1", finalized=finalized)

    def test_explicit_frozen_quota_rejects_valid_but_undersampled_context(self):
        full, deal, providers = self.fixture(counts=(32, 32, 32))
        checked = workload.healthy_audit_views(full, deal, providers, 2, 100, "polystore_260-1", finalized=True, expected_samples=min(132, 32))
        self.assertEqual(sum(int(v["audit"]["sample_count"]) for v in checked.values()), 96)
        values, deal, providers = self.fixture()
        with self.assertRaisesRegex(ValueError, "sample count"):
            workload.healthy_audit_views(values, deal, providers, 2, 100, "polystore_260-1", finalized=True, expected_samples=32)

    def test_k8_audit_uses_twelve_assignments_and_eight_row_population(self):
        values, deal, providers = self.fixture(k=8, counts=(8,) * 12)
        checked = workload.healthy_audit_views(values, deal, providers, 2, 100, "polystore_260-1",
                                               finalized=True, expected_samples=8, k=8)
        self.assertEqual(set(checked), set(range(12)))
        self.assertEqual(sum(int(v["audit"]["sample_count"]) for v in checked.values()), 96)
        values[0]["audit"]["sample_count"] = "9"
        with self.assertRaisesRegex(ValueError, "sample count"):
            workload.healthy_audit_views(values, deal, providers, 2, 100, "polystore_260-1", finalized=True, k=8)

    def test_all_slots_include_parity_and_use_actual_sample_denominator(self):
        values, deal, providers = self.fixture()
        checked = self.check(values, deal, providers)
        self.assertEqual(set(checked), {0, 1, 2})
        self.assertEqual(sum(int(v["audit"]["accepted_count"]) for v in checked.values()), 42)
        self.assertEqual(sum(int(v["audit"]["sample_count"]) for v in checked.values()), 42)
        # Empty initial coverage is valid inventory, but cannot qualify completion.
        initial = self.fixture(complete=False)
        self.assertEqual(set(self.check(*initial, finalized=False)), {0, 1, 2})
        with self.assertRaises(ValueError):
            self.check(*initial)

    def test_invalid_epoch_slot_authority_context_and_coverage_fail_closed(self):
        mutations = {
            "missing parity": lambda rows: rows.pop(),
            "duplicate": lambda rows: rows.append(copy.deepcopy(rows[0])),
            "wrong epoch": lambda rows: rows[2]["audit"].update(epoch_id="1"),
            "wrong slot": lambda rows: rows[2]["audit"]["assignment"]["snapshot"].update(slot=3),
            "wrong provider": lambda rows: rows[2]["audit"]["assignment"].update(provider=ADDRESSES[3]),
            "wrong kind": lambda rows: rows[2]["audit"]["assignment"].update(kind=3),
            "wrong deal start": lambda rows: rows[2]["audit"]["assignment"].update(deal_start="6"),
            "wrong root": lambda rows: rows[2]["audit"]["assignment"].update(manifest_root=base64.b64encode(bytes(32)).decode()),
            "wrong generation": lambda rows: rows[2]["audit"]["assignment"]["snapshot"].update(generation="2"),
            "wrong epoch length": lambda rows: rows[2].update(epoch_length="99"),
            "wrong transcript": lambda rows: rows[2].update(canonical_context=rows[0]["canonical_context"]),
            "wrong seed size": lambda rows: rows[2].update(seed="AA=="),
            "population exceeded": lambda rows: rows[2]["audit"].update(sample_count="33"),
            "zero samples": lambda rows: rows[2]["audit"].update(sample_count="0"),
            "wrong bitmap count": lambda rows: rows[1]["audit"].update(accepted_count="8"),
            "padding bits": lambda rows: rows[1]["audit"].update(coverage="/wM=", accepted_count="10"),
            "incomplete": lambda rows: rows[1]["audit"].update(coverage="/wA=", accepted_count="8"),
            "unfinalized": lambda rows: rows[2].update(finalized=False),
            "missed": lambda rows: rows[2]["audit"].update(missed_epochs="1"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                values, deal, providers = self.fixture()
                mutate(values)
                with self.assertRaises(ValueError):
                    self.check(values, deal, providers)


if __name__ == "__main__":
    unittest.main()
