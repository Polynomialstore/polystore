"""Offline orchestration/economic regressions; no nodes, ports, native load or builds."""
import base64
import copy
import datetime
import hashlib
import inspect
import io
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import urllib.error
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
    FUTURE_HEIGHT = json.dumps({"code": 2, "message": "codespace sdk code 26: invalid height: cannot query with height in the future; please provide a valid height", "details": []}).encode()

    @staticmethod
    def query_response(value, height="7"):
        response = io.BytesIO(json.dumps(value).encode())
        response.status = 200
        response.headers = {"x-cosmos-block-height": height}
        return response

    @classmethod
    def query_error(cls, body=None):
        return urllib.error.HTTPError("http://node/query", 500, "Internal Server Error", {}, io.BytesIO(body or cls.FUTURE_HEIGHT))

    def query_lifecycle(self):
        lifecycle = object.__new__(artifact.FourValidatorLifecycle)
        lifecycle.deadline = 100 * 10**9
        lifecycle.remaining = Mock(return_value=30)
        return lifecycle

    def test_native_v3_browser_geometry_covers_retained_fixture_sizes(self):
        self.assertEqual(workload.v3_file_geometry(1024), dict(size=1024, metadata_mdus=2,
            user_mdus=1, total_mdus=3, witness_mdus=1, integrity_leaf_count=96))
        self.assertEqual(workload.v3_file_geometry(1_073_741_824), dict(size=1_073_741_824,
            metadata_mdus=2, user_mdus=133, total_mdus=135, witness_mdus=1,
            integrity_leaf_count=12_768))
        multi = 16_777_217
        self.assertIn(multi, workload.V3_BROWSER_SIZES)
        self.assertNotEqual(multi % 126_976, 0)
        self.assertEqual((multi + 126_975) // 126_976, 133)
        self.assertEqual(workload.v3_file_geometry(multi)["user_mdus"], 3)

    def test_browser_profile_enables_bounded_app_mempool_without_changing_existing_profile(self):
        generated = '[api]\naddress = "tcp://localhost:1317"\nenabled-unsafe-cors = false\n[mempool]\nmax-txs = -1\n'
        existing = artifact.configure_four_validator_app(generated, "tcp://127.0.0.1:1317")
        browser = artifact.configure_four_validator_app(generated, "tcp://127.0.0.1:1317", browser_evm=True)
        self.assertIn(f'[mempool]\nmax-txs = {artifact.APP_MEMPOOL_MAX_TXS}\n', existing)
        self.assertIn(f'[mempool]\nmax-txs = {artifact.APP_MEMPOOL_MAX_TXS}\n', browser)
        self.assertEqual(artifact.APP_MEMPOOL_MAX_TXS, 0)
        self.assertIn('enabled-unsafe-cors = false', existing)
        self.assertIn('enabled-unsafe-cors = true', browser)

    def test_browser_http_preflight_rejects_missing_cors_or_wrong_chain(self):
        life = SimpleNamespace(nodes=[dict(api=1317, evm_rpc=8545)], remaining=lambda: 30)
        def responses():
            rows = [self.query_response(dict(params={})), self.query_response(dict(params={
                        "active_static_precompiles": ["0x0000000000000000000000000000000000000900"]})),
                    self.query_response({}),
                    self.query_response(dict(result="0x40000"))]
            for row in rows:
                row.headers.update({"Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type"})
            return rows
        with patch.object(workload.urllib.request, "urlopen", side_effect=responses()) as get:
            evidence = workload.browser_http_preflight(life, "http://127.0.0.1:4173")
            self.assertEqual([row["method"] for row in evidence["checks"]], ["GET", "GET", "OPTIONS", "POST"])
            self.assertTrue(all(call.args[0].get_header("Origin") == evidence["origin"] for call in get.call_args_list))
        for change in ("cors", "precompile", "content-type", "chain"):
            rows = responses()
            if change == "cors":
                rows[0].headers.pop("Access-Control-Allow-Origin")
            elif change == "content-type":
                rows[2].headers["Access-Control-Allow-Headers"] = "unrelated"
            elif change == "precompile":
                rows[1] = self.query_response(dict(params={"active_static_precompiles": []}))
                rows[1].headers["Access-Control-Allow-Origin"] = "*"
            else:
                rows[3] = self.query_response(dict(result="0x1"))
                rows[3].headers["Access-Control-Allow-Origin"] = "*"
            with self.subTest(change=change), patch.object(workload.urllib.request, "urlopen", side_effect=rows):
                with self.assertRaises(ValueError):
                    workload.browser_http_preflight(life, "http://127.0.0.1:4173")

    def test_browser_native_transactions_pay_the_global_evm_fee_floor(self):
        life = SimpleNamespace(binary=Path("/chain"), chain="polystore_290-1", deadline=10**18,
            nodes=[dict(home="/home", rpc=26657)], env={"GOMAXPROCS": "2"})
        for browser in (False, True):
            life.browser_evm = browser
            job = workload.transaction_job(life, AUDIT_ADDRESSES[0], ["create-deal", "100", "1", "1"])
            self.assertEqual(job["submit"][job["submit"].index("--gas-prices") + 1],
                             artifact.BROWSER_EVM_NATIVE_GAS_PRICES if browser else "0.001aatom")

    def test_public_policy_uses_one_signed_owner_message_and_committed_query(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            owner = ADDRESSES[0]
            intended = {"@type": "/polystorechain.polystorechain.v1.MsgUpdateDealRetrievalPolicy",
                "creator": owner, "deal_id": "7", "policy": {"mode": "RETRIEVAL_POLICY_MODE_PUBLIC",
                    "allowlist_root": None, "voucher_signer": ""}}
            lifecycle = SimpleNamespace(home=home, binary=Path("/chain"), chain="polystore_291-1",
                nodes=[dict(home="/node", rpc=26657)], signers={"owner0": owner}, doc={}, save=Mock(),
                wait_height=Mock(), cli=Mock(return_value=json.dumps({"tx": {"body": {"messages": [intended]}}})))

            def command(argv):
                if "--generate-only" in argv:
                    return json.dumps({"body": {"messages": [{"@type": "template"}]}, "signatures": []})
                output = Path(argv[argv.index("--output-document") + 1])
                unsigned = json.loads((home / "browser-public-policy/unsigned.jsonl").read_text())
                unsigned["signatures"] = ["signed"]
                output.write_text(json.dumps(unsigned))
                return ""

            committed = dict(outcome="committed_success", txhash="A" * 64, height=12)
            lifecycle.query = Mock(return_value={"deal": {"retrieval_policy": {
                "mode": "RETRIEVAL_POLICY_MODE_PUBLIC", "allowlist_root": "", "voucher_signer": ""}}})
            with patch.object(workload, "transaction_job", return_value={"submit": ["/chain", "tx", "nilchain",
                    "create-deal"], "signer": owner}), \
                 patch.object(artifact, "scheduled_transaction", return_value=committed) as broadcast, \
                 patch.object(workload, "verify_transaction_nodes", return_value=["four-node-proof"]):
                evidence = workload.set_public_retrieval_policy(lifecycle, deal_id="7", command=command)
            self.assertEqual(evidence["message"], intended)
            self.assertEqual(broadcast.call_count, 1)
            lifecycle.wait_height.assert_called_once_with(13)
            lifecycle.save.assert_called_once()

    def test_browser_launcher_pins_canonical_gateway_and_real_e2e_wallet_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            website = root / "polystore-website"
            for relative in ("node_modules/.bin/vite", "node_modules/.bin/playwright",
                             "public/wasm/polystore_core_bg.wasm"):
                path = website / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"fixture")
            home = root / "run"
            home.mkdir()
            lifecycle = SimpleNamespace(home=home, binary=Path("/chain"), chain="polystore_291-1",
                deadline=10**18, env={"POLYSTORE_TRUSTED_SETUP": "/setup", "GOMAXPROCS": "2"},
                nodes=[dict(home="/node", rpc=26657, api=1317, evm_rpc=8545)],
                doc={"provenance": {"cli_binary": "/native-cli", "curl_binary": "/curl"},
                     "payload": {"bytes": 1024, "sha256": "ab" * 32}},
                remaining=Mock(return_value=30), wait_height=Mock(side_effect=[20, 21, 22]),
                signers={}, save=Mock())
            process_ids = iter((101, 102))
            launched = []
            def popen(argv, **kwargs):
                launched.append((argv, kwargs))
                return SimpleNamespace(pid=next(process_ids), returncode=None)
            def command(argv, timeout=60):
                if argv[-1].endswith("/status"):
                    return json.dumps({"persona": "user-gateway", "allowed_route_families": ["gateway"]})
                return "ready"
            memory = {"schema": artifact.BROWSER_MEMORY_SCHEMA, "memory_peak_bytes": 123456,
                "source": artifact.BROWSER_MEMORY_SOURCE, "measurement_scope": artifact.BROWSER_MEMORY_SCOPE}
            def playwright(argv, deadline, memory_output, *, env=None, cwd=None):
                Path(env["E2E_NATIVE_V3_RESULT"]).write_text(json.dumps({"success": True,
                    "session": {"session_id": base64.b64encode(bytes(32)).decode()},
                    "evmReceipts": [], "evmTransactions": [], "providerProofOutcomes": [], "paidDiagnosticCount": 2,
                    "cacheMduRequests": {"before": {"gatewayMetadata": 1, "gatewayData": 1,
                        "directMetadata": 0, "directData": 0}, "after": {"gatewayMetadata": 1,
                        "gatewayData": 1, "directMetadata": 0, "directData": 0}},
                    "diagnostics": [dict(phase="transport", edge="start", atMs=1), dict(phase="transport", edge="end", atMs=2)]}))
                self.assertEqual(cwd, website)
                self.assertEqual(memory_output, home / "browser-memory.json")
                self.assertEqual((env["VITE_E2E"], env["VITE_CHAIN_ID"], env["E2E_NATIVE_V3_PAYER"]),
                    ("1", "262144", workload.V3_BROWSER_PAYER))
                self.assertEqual((env["E2E_NATIVE_V3_EXPIRY"], env["E2E_NATIVE_V3_FAULTS"]), ("0", "0"))
                return SimpleNamespace(returncode=0, stdout="passed", stderr=""), memory
            ports = {"gateway": 18080, "website": 4173,
                     "gateway_reservation": Mock(), "website_reservation": Mock()}
            processes = []
            with patch.object(workload.subprocess, "Popen", side_effect=popen), \
                 patch.object(artifact, "run_bounded_browser_command", side_effect=playwright), \
                 patch.object(workload, "collect_issuance", return_value=17), \
                 patch.object(workload, "browser_v3_snapshot", return_value={"bank": {"height": 19}, "retrieval": {"sessions": {"00" * 32: {"sample_count": 0}}}}), \
                 patch.object(workload, "browser_v3_committed_receipts", return_value=[]), \
                 patch.object(workload, "validate_v3_provider_phase_timings", return_value={"qualification": True}), \
                 patch.object(workload, "verify_browser_v3_economics", return_value={"issued_stake": 17}):
                result = workload.run_native_v3_browser(lifecycle, gateway=Path("/gateway"), source=root,
                    deal={"id": "7"}, browser_ports=ports, command=command, processes=processes,
                    check_providers=Mock())
            self.assertEqual([row[0][0] for row in launched], ["/gateway", str(website / "node_modules/.bin/vite")])
            self.assertEqual(result["gateway"]["status"]["persona"], "user-gateway")
            self.assertEqual(result["economics"]["issued_stake"], 17)
            self.assertEqual(result["playwright"]["memory"], memory)
            ports["gateway_reservation"].close.assert_called_once()
            ports["website_reservation"].close.assert_called_once()

    def test_browser_executor_handoff_publishes_fixed_request_and_retains_response(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            response_path = home / "browser-executor-response.json"
            response_path.write_text("{}")
            lifecycle = SimpleNamespace(home=home, doc={"provenance": {
                "product_source_commit": "ab" * 20, "product_source_status": ""},
                "payload": {"bytes": 1 << 30}}, remaining=Mock(return_value=5),
                deadline=600_000_001_000, save=Mock())
            completed = subprocess.CompletedProcess(["playwright", "test"], 0, "passed", "")
            with patch.object(artifact, "monotonic_ns", return_value=1_000), \
                 patch.object(artifact, "create_browser_executor_request",
                    return_value={"id": "cd" * 16, "head": "ab" * 20}) as create, \
                 patch.object(artifact, "read_browser_executor_response",
                    return_value=(completed, {"peak_rss_bytes": 4096}, {"returncode": 0})):
                result, memory = workload.run_browser_executor_handoff(lifecycle, source=Path("/source"),
                    browser_env={"fixed": "environment"}, faults=False, check_providers=Mock())
            self.assertIs(result, completed)
            self.assertEqual(memory["peak_rss_bytes"], 4096)
            self.assertNotIn("mac_source", lifecycle.doc["browser_executor"])
            self.assertEqual(create.call_args.kwargs["source_head"], "ab" * 20)
            self.assertEqual(create.call_args.kwargs["timeout_seconds"], 600)
            lifecycle.remaining.assert_called_once_with()

    def test_browser_fault_result_is_one_durable_paid_session(self):
        sid = "12" * 32
        encoded = base64.b64encode(bytes.fromhex(sid)).decode()
        obligations = [dict(slot=str(slot)) for slot in (0, 1)]
        session = dict(session_id=encoded, obligations=obligations)
        chunks = [dict(id=str(index), slot=index % 2, entries=[str(index)]) for index in range(21)]
        chunks[0]["entries"] = ["132"]
        planned = dict(sessionId="0x" + sid, nonce="7", population="133", sampleCount="132",
                       chunks=chunks, unsampled=["132"])
        checkpoints = {key: dict(planned) for key in ("corrupt", "multipart-order", "truncate")}
        hashes = ["0x" + str(index) * 64 for index in (1, 2, 3)]
        outcome = dict(success=True, stage="settled-cache", session=session, planned=planned,
            targetT="132", targetChunk=chunks[0], targetBlob=0,
            faultDeliveries={key: 1 for key in checkpoints},
            faultSnapshots=checkpoints, durableCheckpoint=dict(planned),
            evmReceipts=[{"transactionHash": value} for value in hashes],
            evmTransactions=[{"hash": value} for value in hashes], rawTransactions=3,
            rawTransactionAttempts=4, phaseGuards={"openedSessions": 1, "acknowledgedObligations": 2,
                                                   "targetVerifiedChunks": 1},
            before={"nonce": {"found": True, "nonce": "4"}},
            afterUnknown={"nonce": {"found": True, "nonce": "5"}},
            after={"nonce": {"found": True, "nonce": "5"}}, dataRequests=24, targetRequests=4,
            requestsBeforeReopen={"data": 16, "target": 4},
            requestsBeforeCache={"data": 24, "target": 4, "raw": 3},
            downloaded={"bytes": 16_777_217, "sha256": "ab" * 32},
            cached={"bytes": 16_777_217, "sha256": "ab" * 32},
            cacheMduRequests={"before": {"gatewayMetadata": 2, "gatewayData": 21,
                "directMetadata": 0, "directData": 0}, "after": {"gatewayMetadata": 2,
                "gatewayData": 21, "directMetadata": 0, "directData": 0}},
            localState={"checkpoints": 1, "unbound": 0, "journals": []},
            resultDurability={"atomicReplace": True, "verifiedStages": ["unknown-open", "corrupt",
                "multipart-order", "truncate", "durable-before-reopen", "settled-cache"]})
        workload.validate_native_v3_browser_fault_outcome(
            outcome, session, {"bytes": 16_777_217, "sha256": "ab" * 32})
        outcome["rawTransactions"] = 4
        with self.assertRaisesRegex(ValueError, "canonical open"):
            workload.validate_native_v3_browser_fault_outcome(
                outcome, session, {"bytes": 16_777_217, "sha256": "ab" * 32})

    def test_browser_cache_requires_equal_nonnegative_exact_transport_counters(self):
        counters = {"gatewayMetadata": 1, "gatewayData": 2, "directMetadata": 0, "directData": 0}
        self.assertEqual(workload.validate_browser_cache_mdu_requests(
            {"cacheMduRequests": {"before": counters, "after": dict(counters)}})["before"], counters)
        for after in (dict(counters, gatewayData=3), dict(counters, directData=True),
                      dict(counters, unexpected=0)):
            with self.subTest(after=after), self.assertRaisesRegex(ValueError, "additional MDU"):
                workload.validate_browser_cache_mdu_requests(
                    {"cacheMduRequests": {"before": counters, "after": after}})

    def test_browser_expiry_launcher_reuses_stack_with_separate_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            website = root / "polystore-website"
            (website / "node_modules/.bin").mkdir(parents=True)
            (website / "node_modules/.bin/playwright").write_bytes(b"fixture")
            home = root / "run"
            home.mkdir()
            sid = "00" * 32
            final = {"session_id": base64.b64encode(bytes(32)).decode()}
            before = {"bank": {"height": 19}, "retrieval": {"deals": {"8": {"end_block": "150"}}}}
            after = {"bank": {"height": 30}, "retrieval": {"sessions": {sid: final}}}
            lifecycle = SimpleNamespace(home=home, chain="polystore_291-1", deadline=10**18,
                nodes=[dict(api=1317, evm_rpc=8545)], signers={}, doc={}, save=Mock(),
                wait_height=Mock(side_effect=[20, 31]))
            hashes = ["0x" + byte * 64 for byte in ("1", "2")]
            outcome = dict(success=True, stage="refunded", strictExpiryObserved=True, rawTransactions=2,
                retryMduRequests=0, retryMduRequestsBeforeRefund=0, requestedSessionId="0x" + sid,
                afterRefund={"height": "30"}, session=final,
                evmReceipts=[{"transactionHash": value} for value in hashes],
                evmTransactions=[{"hash": value} for value in hashes])
            memory = {"memory_peak_bytes": 123}
            def playwright(argv, deadline, memory_output, *, env=None, cwd=None):
                Path(env["E2E_NATIVE_V3_RESULT"]).write_text(json.dumps(outcome))
                self.assertEqual((env["E2E_NATIVE_V3_EXPIRY"], env["E2E_NATIVE_V3_DEAL_ID"],
                                  env["E2E_NATIVE_V3_BYTES"]), ("1", "8", "1024"))
                self.assertEqual(memory_output, home / "browser-expiry-memory.json")
                self.assertEqual(cwd, website)
                return SimpleNamespace(returncode=0, stdout="passed", stderr=""), memory
            committed = [dict(receipt={"transactionHash": value}) for value in hashes]
            with patch.object(artifact, "run_bounded_browser_command", side_effect=playwright), \
                 patch.object(workload, "browser_v3_snapshot", side_effect=[before, after]), \
                 patch.object(workload, "collect_issuance", return_value=17), \
                 patch.object(workload, "browser_v3_committed_receipts", return_value=committed), \
                 patch.object(workload, "verify_browser_v3_refund_economics", return_value={"issued_stake": 17}):
                evidence = workload.run_native_v3_browser_expiry(lifecycle, source=root, deal={"id": "8"},
                    browser_ports={"gateway": 18080, "website": 4173},
                    payload={"bytes": 1024, "sha256": "ab" * 32}, check_providers=Mock())
            self.assertEqual(evidence["economics"]["issued_stake"], 17)
            self.assertEqual(evidence["playwright"]["memory"], memory)
            self.assertEqual(lifecycle.doc["native_v3_browser_expiry"], evidence)

    def test_short_browser_fixture_has_unique_admission_and_policy_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            main_payload = home / "main.bin"
            main_payload.write_bytes(bytes(range(256)) * 8)
            owner = ADDRESSES[0]
            providers = dict(enumerate(AUDIT_ADDRESSES))
            assigned = {slot: AUDIT_ADDRESSES[(slot + 1) % len(AUDIT_ADDRESSES)] for slot in providers}
            slots = [dict(slot=str(slot), provider=provider, status="SLOT_STATUS_ACTIVE", pending_provider="")
                     for slot, provider in assigned.items()]
            initial = {"mode2_slots": slots}
            final = dict(initial, manifest_root=base64.b64encode(bytes.fromhex("ab" * 32)).decode(),
                         size="1024", total_mdus="3", witness_mdus="1", current_gen="1")
            lifecycle = SimpleNamespace(home=home, nodes=[{}], signers={"owner0": owner},
                doc={"payload": {"path": str(main_payload)},
                     "providers": [dict(address=provider, port=19091 + slot)
                                   for slot, provider in providers.items()]}, save=Mock())
            lifecycle.query = Mock(side_effect=[{"deals": [{"id": "7", "owner": owner}, {"id": "8", "owner": owner}]},
                                                {"deal": initial}, {"deal": final}])
            send = Mock(return_value={"height": 10})
            wait = Mock()
            command = Mock(return_value=json.dumps({"upload": "ok"}))
            candidate = {"polyfs_root": "0x" + "ab" * 32}
            with patch.object(workload, "admit_native_v3_generation", return_value=(candidate, 20)) as admit, \
                 patch.object(workload, "set_public_retrieval_policy", return_value={"public": True}) as policy:
                fixture = workload.prepare_native_v3_browser_expiry(lifecycle, main_deal={"id": "7"},
                    providers=providers, send=send, wait=wait, command=command, curl="/curl")
            self.assertEqual(send.call_args.args[1], ["create-deal", "180", "100000000", "10000000",
                "--service-hint", "General:rs=8+4"])
            self.assertEqual(fixture["payload"]["bytes"], 1024)
            self.assertTrue(command.call_args.args[0][-1].startswith(
                "http://127.0.0.1:19092/sp/retrieval/upload?deal_id=8&"))
            self.assertEqual(admit.call_args.kwargs["providers"], assigned)
            self.assertEqual(admit.call_args.kwargs["evidence_key"], "native_v3_browser_expiry_generation")
            self.assertEqual(admit.call_args.kwargs["http_phase"], "browser-expiry-generation-acceptance")
            self.assertEqual(policy.call_args.kwargs["directory_name"], "browser-expiry-public-policy")
            self.assertEqual(lifecycle.doc["native_v3_browser_expiry_fixture"], fixture)

    def test_fixed_height_query_retries_only_future_height_error(self):
        lifecycle = self.query_lifecycle()
        delayed = [self.query_error(), self.query_response({"session": {"id": "ready"}})]
        with patch.object(artifact.urllib.request, "urlopen", side_effect=delayed) as opened, \
                patch.object(artifact, "monotonic_ns", return_value=0), patch.object(artifact.time, "sleep") as sleep:
            self.assertEqual(lifecycle.query({"api": 1317, "rpc": 26657}, "/query", 7), {"session": {"id": "ready"}})
        self.assertEqual(opened.call_count, 2)
        self.assertEqual(opened.call_args_list[1].kwargs["timeout"], 5)
        sleep.assert_called_once()

        for body in (b'{"code":2,"message":"other","details":[]}', b"not-json"):
            with self.subTest(body=body), patch.object(artifact.urllib.request, "urlopen", side_effect=[self.query_error(body)]) as opened:
                with self.assertRaisesRegex(ValueError, "node query HTTP 500"):
                    lifecycle.query({"api": 1317, "rpc": 26657}, "/query", 7)
                opened.assert_called_once()

    def test_browser_economics_checks_real_blob_fees_rounding_payer_and_conservation(self):
        sid = "ab" * 32
        signers = {"owner0": ADDRESSES[0], "provider0": ADDRESSES[1], "provider1": ADDRESSES[2]}
        before = dict(bank=dict(height=10, balances={name + ":stake": "1000" for name in signers},
                               supply={"stake": "10000"}),
                      payer=dict(address=workload.V3_BROWSER_PAYER, stake="1000", aatom="1000"),
                      retrieval=dict(module_stake="1000", deals={"0": {"escrow_balance": "1000"}}, sessions={}))
        after = copy.deepcopy(before)
        after["bank"].update(height=20, supply={"stake": "10073"})  # 100 mint - 27 burn
        after["bank"]["balances"].update({"provider0:stake": "1022", "provider1:stake": "1022"})
        after["payer"].update(stake="929", aatom="970")
        session = dict(payer=workload.V3_BROWSER_PAYER, owner=workload.V3_BROWSER_PAYER,
            funding="RETRIEVAL_SESSION_FUNDING_REQUESTER", price_denom="stake", base_fee="3",
            price_per_blob="17", completion_burn_bps=3333, acked_slots_mask=3, settled_slots_mask=3,
            refunded_slots_mask=0, locked_fee="0", sample_count=2,
            accepted_sample_bitmap=base64.b64encode(bytes([3]) + bytes(16)).decode(),
            obligations=[dict(slot=i, payee=ADDRESSES[i+1], assigned_provider=ADDRESSES[i+1],
                blob_count=2, locked_fee="34") for i in range(2)])
        after["retrieval"]["sessions"][sid] = session
        receipts = [dict(height=15, receipt={"from": "0x8647e4b22f37b3e30fd3d297f1fb7e13fdf68255",
            "to": "0x0000000000000000000000000000000000000900", "gasUsed": "0xa", "effectiveGasPrice": "0x3"})]
        def verify(candidate=after, observed=receipts):
            return workload.verify_browser_v3_economics(before, candidate, session_id=sid,
                receipts=observed, issued_stake=100, signers=signers)
        self.assertEqual(verify(), dict(charged_stake=71, provider_payouts={ADDRESSES[1]: 22, ADDRESSES[2]: 22},
            burned_stake=27, issued_stake=100, payer_gas_aatom=30, completed_sessions=1))
        mutations = [
            lambda d: d["payer"].update(stake="894"),
            lambda d: d["payer"].update(aatom="969"),
            lambda d: d["bank"]["balances"].update({"provider0:stake": "1034"}),
            lambda d: d["bank"]["supply"].update(stake="10062"),
            lambda d: d["retrieval"].update(module_stake="1001"),
            lambda d: d["retrieval"]["deals"]["0"].update(escrow_balance="999"),
            lambda d: d["retrieval"]["sessions"][sid].update(payer=ADDRESSES[0]),
            lambda d: d["retrieval"]["sessions"][sid].update(settled_slots_mask=1),
            lambda d: d["retrieval"]["sessions"][sid].update(accepted_sample_bitmap=base64.b64encode(bytes(17)).decode()),
            lambda d: d["retrieval"]["sessions"][sid]["obligations"][0].update(blob_count=3),
        ]
        for mutate in mutations:
            candidate = copy.deepcopy(after)
            mutate(candidate)
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                verify(candidate)
        for field, value in (("from", "0x" + "11" * 20), ("to", "0x" + "00" * 20)):
            candidate = copy.deepcopy(receipts)
            candidate[0]["receipt"][field] = value
            with self.assertRaises(ValueError):
                verify(observed=candidate)

    def test_browser_expiry_economics_refunds_variable_fee_and_retains_base_and_gas(self):
        sid = "ab" * 32
        signers = {"owner0": ADDRESSES[0], "provider0": ADDRESSES[1]}
        before = dict(bank=dict(height=10, balances={name + ":stake": "1000" for name in signers},
                               supply={"stake": "10000"}),
                      payer=dict(address=workload.V3_BROWSER_PAYER, stake="1000", aatom="1000"),
                      retrieval=dict(params={"fixed": "prices"}, module_stake="1000",
                                     deals={"8": {"escrow_balance": "1000"}}, sessions={}))
        after = copy.deepcopy(before)
        after["bank"].update(height=20, supply={"stake": "10097"})
        after["payer"].update(stake="997", aatom="970")
        pending = dict(session_id=base64.b64encode(bytes.fromhex(sid)).decode(), deadline_height="19",
            payer=workload.V3_BROWSER_PAYER, owner=workload.V3_BROWSER_PAYER,
            funding="RETRIEVAL_SESSION_FUNDING_REQUESTER", price_denom="stake", base_fee="3",
            price_per_blob="17", locked_fee="17", acked_slots_mask="0", settled_slots_mask="0",
            refunded_slots_mask="0", sample_count="1", accepted_sample_bitmap=base64.b64encode(bytes(17)).decode(),
            obligations=[dict(slot="0", payee=ADDRESSES[1], assigned_provider=ADDRESSES[1],
                              blob_count="1", locked_fee="17")])
        final = dict(pending, expired=True, locked_fee="0", refunded_slots_mask="1")
        after["retrieval"]["sessions"][sid] = final
        receipts = [dict(height=height, receipt={"from": "0x8647e4b22f37b3e30fd3d297f1fb7e13fdf68255",
            "to": "0x0000000000000000000000000000000000000900", "gasUsed": "0x5",
            "effectiveGasPrice": "0x3"}) for height in (12, 15)]
        outcome = dict(sessionBeforeRefund=pending, afterRefund={"height": "20"},
            localStateBeforeRefund={"checkpoints": 1, "unbound": 0,
                "journals": [{"state": "committed", "hasHash": True}]},
            phaseGuards={"openedSessions": 1, "verifiedWrites": 0, "flushedChunks": 0,
                         "verifiedChunks": 0, "acknowledgedObligations": 0},
            resultDurability={"verifiedStages": ["interrupted", "refunded"]})
        def verify(candidate=after, result=outcome):
            return workload.verify_browser_v3_refund_economics(before, candidate, session_id=sid,
                receipts=receipts, issued_stake=100, signers=signers, outcome=result)
        self.assertEqual(verify(), dict(retained_base_fee_stake=3, refunded_variable_fee_stake=17,
            issued_stake=100, payer_gas_aatom=30, refunded_sessions=1))
        mutations = [
            lambda d: d["payer"].update(stake="980"),
            lambda d: d["payer"].update(aatom="969"),
            lambda d: d["bank"]["balances"].update({"provider0:stake": "1001"}),
            lambda d: d["bank"]["supply"].update(stake="10114"),
            lambda d: d["retrieval"]["sessions"][sid].update(refunded_slots_mask="0"),
        ]
        for mutate in mutations:
            candidate = copy.deepcopy(after)
            mutate(candidate)
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                verify(candidate)
        incomplete = copy.deepcopy(outcome)
        incomplete["resultDurability"]["verifiedStages"] = ["interrupted"]
        with self.assertRaises(ValueError):
            verify(result=incomplete)

    def test_browser_phase_report_does_not_add_overlapping_chunks_as_elapsed_time(self):
        events = [dict(phase="transport", chunkId=chunk, edge=edge, atMs=at)
                  for chunk, edge, at in (("a", "start", 0), ("b", "start", 1), ("a", "end", 3), ("b", "end", 4))]
        phase = workload.browser_phase_intervals(events)["phases"]["transport"]
        self.assertEqual(phase["summed_work_ms"], 6)
        self.assertEqual(phase["occupied_elapsed_ms"], 4)
        self.assertEqual(phase["count"], 2)
        for invalid in (events[:-1], events[1:], [dict(events[0], atMs=float("nan"))],
                        [events[0], events[0], *events[1:]], [events[0], dict(events[2], atMs=-1)]):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                workload.browser_phase_intervals(invalid)

    def test_browser_evm_receipts_join_committed_bytes_and_reject_disagreement(self):
        raw = b"actual signed transaction"
        txhash = "0x" + "ab" * 32
        nodes = [dict(node_id=str(i)) for i in range(4)]
        block = dict(block_id={"hash": "CD" * 32}, block={"header": {
            "height": "15", "chain_id": "chain", "app_hash": "EF" * 32, "time": "now"},
            "data": {"txs": [base64.b64encode(raw).decode()]}})
        response = dict(height="15", txs_results=[dict(code=0, gas_wanted="100", gas_used="90",
            events=[dict(type="ethereum_tx", attributes=[dict(key="ethereumTxHash", value=txhash)]),
                    dict(type="ethereum_tx", attributes=[dict(key="ethereumTxHash", value=txhash.upper())])])])
        receipt = dict(transactionHash=txhash, status="0x1", blockNumber="0xf", blockHash="0x" + "cd" * 32)
        life = SimpleNamespace(nodes=nodes, chain="chain", wait_height=Mock(),
            query=Mock(side_effect=lambda node, route: block if route.startswith("/block?") else response))
        result = workload.browser_v3_committed_receipts(life, [receipt])
        self.assertEqual(result[0]["txhash"], hashlib.sha256(raw).hexdigest().upper())
        self.assertEqual(result[0]["validators"], [str(i) for i in range(4)])
        for candidate in ([receipt, receipt], [dict(receipt, status="0x0")],
                          [dict(receipt, blockHash="0x" + "00" * 32)], [dict(receipt, transactionHash="0x" + "11" * 32)]):
            with self.subTest(candidate=candidate), self.assertRaises(ValueError):
                workload.browser_v3_committed_receipts(life, candidate)
        distinct = copy.deepcopy(response)
        distinct["txs_results"][0]["events"].append(dict(type="ethereum_tx",
            attributes=[dict(key="ethereumTxHash", value="0x" + "11" * 32)]))
        life.query = lambda node, route: block if route.startswith("/block?") else distinct
        with self.assertRaisesRegex(ValueError, "one successful Ethereum transaction"):
            workload.browser_v3_committed_receipts(life, [receipt])
        failed = copy.deepcopy(response)
        failed["txs_results"][0]["code"] = 1
        life.query = lambda node, route: block if route.startswith("/block?") else failed
        with self.assertRaisesRegex(ValueError, "one successful Ethereum transaction"):
            workload.browser_v3_committed_receipts(life, [receipt])
        duplicate_block = copy.deepcopy(block)
        duplicate_block["block"]["data"]["txs"].append(base64.b64encode(b"second transaction").decode())
        duplicate_response = copy.deepcopy(response)
        duplicate_response["txs_results"].append(copy.deepcopy(response["txs_results"][0]))
        life.query = lambda node, route: duplicate_block if route.startswith("/block?") else duplicate_response
        with self.assertRaisesRegex(ValueError, "lacks a unique"):
            workload.browser_v3_committed_receipts(life, [receipt])
        def disagree(node, route):
            value = copy.deepcopy(block if route.startswith("/block?") else response)
            if node["node_id"] == "3" and "txs_results" in value:
                value["txs_results"][0]["gas_used"] = "89"
            return value
        life.query = disagree
        with self.assertRaisesRegex(ValueError, "four validators disagree"):
            workload.browser_v3_committed_receipts(life, [receipt])

    def test_fixed_height_query_future_height_retry_is_bounded(self):
        lifecycle = self.query_lifecycle()
        with patch.object(artifact.urllib.request, "urlopen", side_effect=[self.query_error()]) as opened, \
                patch.object(artifact, "monotonic_ns", side_effect=[0, 5 * 10**9]):
            with self.assertRaisesRegex(ValueError, "invalid height: cannot query with height in the future"):
                lifecycle.query({"api": 1317, "rpc": 26657}, "/query", 7)
        opened.assert_called_once()

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

    def test_finalize_block_capture_is_an_explicit_fenced_option(self):
        sample = dict(chain_id="polystore_260-1", count=12, sum_seconds="0.15",
                      wall_time_ns=123, monotonic_start_ns=456, monotonic_end_ns=789)
        life = SimpleNamespace(doc={}, chain=sample["chain_id"], env={}, deadline=10**30,
            nodes=[dict(node_id="ab" * 20, metrics=26660, rpc=26657)])
        result = SimpleNamespace(returncode=0, stdout=json.dumps(sample), stderr="")
        with patch.object(artifact, "run_bounded_command", return_value=result) as command:
            workload.capture_workload_metrics(
                life, "candidate", fenced=True, finalize_block=True)
        self.assertEqual(command.call_args.args[0][-1], "--finalize-block-histogram")

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

    def test_payload_nonconstant_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "payload.bin"
            for raw, expected in ((b"", False), (b"\x07" * 2048, False),
                                  (b"\x07" * 2047 + b"\x08", True)):
                path.write_bytes(raw)
                self.assertEqual(workload.file_is_nonconstant(path), expected)

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

    def test_session_validation_accepts_one_blob_rotated_provider_shape(self):
        value = self.session()
        session = value["session"]
        session.update(range_start=str(7 * workload.V3_DATA_BLOB_PAYLOAD_BYTES),
                       range_length="1024", first_blob="7", last_blob="7",
                       population="1", sample_count="1",
                       accepted_sample_bitmap=base64.b64encode(bytes(17)).decode(),
                       obligations=[dict(slot=7, assigned_provider=AUDIT_ADDRESSES[7],
                                         payee=AUDIT_ADDRESSES[7], blob_count="1",
                                         sample_count="0", locked_fee="1")],
                       locked_fee="1")
        parsed, accepted = self.validate_session(value,
            range_start=7 * workload.V3_DATA_BLOB_PAYLOAD_BYTES, range_length=1024)
        self.assertEqual((accepted, parsed["obligations"][0]["slot"]), ([], 7))

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
        second = raw.replace(sid, bytes.fromhex("22" * 32))
        self.assertEqual(workload.opened_v3_sessions(
            dict(outcome="committed_success", data=(raw + second).hex()), 2),
            [self.SESSION, "22" * 32])
        ordered = [raw.replace(sid, bytes([index]) * 32) for index in range(1, 32)]
        self.assertEqual(workload.opened_v3_sessions(
            dict(outcome="committed_success", data=b"".join(ordered).hex()), 31),
            [(bytes([index]) * 32).hex() for index in range(1, 32)])
        self.assertEqual(len(workload.opened_v3_sessions(
            dict(outcome="committed_success", data=b"".join(ordered[:15]).hex()), 15)), 15)
        small_suffix = (b"\x10" + workload._encode_varint(1024) +
                        b"\x18" + workload._encode_varint(artifact.ENCODED_BLOB_BYTES) + b"\x20\x01")
        small_response = b"\x0a\x20" + bytes.fromhex("44" * 32) + small_suffix
        small_any = (b"\x0a" + workload._encode_varint(len(kind)) + kind +
                     b"\x12" + workload._encode_varint(len(small_response)) + small_response)
        small = b"\x12" + workload._encode_varint(len(small_any)) + small_any
        self.assertEqual(workload.opened_v3_sessions(
            dict(outcome="committed_success", data=(small + raw).hex()), 2, shapes=[
                dict(range_start="0", range_length="1024", file_length=str(workload.V3_PILOT_BYTES)),
                dict(range_start="0", range_length=str(workload.V3_PILOT_BYTES),
                     file_length=str(workload.V3_PILOT_BYTES)),
            ]), ["44" * 32, self.SESSION])
        with self.assertRaisesRegex(ValueError, "repeats"):
            workload.opened_v3_sessions(
                dict(outcome="committed_success", data=(raw + raw).hex()), 2)
        with self.assertRaisesRegex(ValueError, "zero file start offset"):
            workload.opened_v3_sessions(
                dict(outcome="committed_success", data=small.hex()), 1, shapes=[
                    dict(file_start_offset="1", range_start="0", range_length="1024",
                         file_length=str(workload.V3_PILOT_BYTES)),
                ])

    def test_native_v3_open_batch_binds_order_gas_bytes_and_response(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            owner = AUDIT_ADDRESSES[0]
            life = SimpleNamespace(binary=Path("/chain"), chain="chain", env={},
                deadline=artifact.monotonic_ns() + 10**9, signers={"owner0": owner},
                nodes=[{"home": str(home), "rpc": 26657}], doc={}, save=Mock())
            paths, generated, completion_order = [], {}, []
            release_first = threading.Event()
            for nonce in range(1, 32):
                path = home / f"open-{nonce}.json"
                path.write_text(json.dumps(dict(creator=owner, deal_id="7", generation="1",
                    range=dict(file_record_index=0, file_start_offset="0",
                               file_length=str(workload.V3_PILOT_BYTES), range_start="0",
                               range_length=str(workload.V3_PILOT_BYTES)), nonce=str(nonce),
                    deadline_height="300")))
                paths.append(path)
            def command(args):
                if "--generate-only" in args:
                    path = Path(args[args.index("open") + 1])
                    source = json.loads(path.read_text())
                    nonce = int(source["nonce"])
                    if nonce == 1:
                        self.assertTrue(release_first.wait(timeout=1))
                    elif nonce == 2:
                        release_first.set()
                    source["range"] = {key: str(value) for key, value in source["range"].items()}
                    message = {"@type": "/polystorechain.polystorechain.v1.MsgOpenRetrievalSessionV3", **source}
                    gas = args[args.index("--gas") + 1]
                    tx = {"body": {"messages": [message]},
                          "auth_info": {"fee": {"gas_limit": gas}}}
                    generated[nonce] = tx
                    completion_order.append(nonce)
                    return json.dumps(tx)
                txs = [json.loads(line) for line in Path(args[3]).read_text().splitlines()]
                messages = [row["body"]["messages"][0] for row in txs]
                gas = sum(int(row["auth_info"]["fee"]["gas_limit"]) for row in txs)
                Path(args[args.index("--output-document") + 1]).write_text(json.dumps({
                    "body": {"messages": messages}, "auth_info": {"fee": {"gas_limit": str(gas)}},
                    "signatures": ["signed"]}))
                return ""
            session_ids = [bytes([index]) * 32 for index in range(1, 32)]
            kind = b"/polystorechain.polystorechain.v1.MsgOpenRetrievalSessionV3Response"
            suffix = (b"\x10" + workload._encode_varint(workload.V3_PILOT_BYTES) +
                      b"\x18" + workload._encode_varint(133 * artifact.ENCODED_BLOB_BYTES) +
                      b"\x20" + workload._encode_varint(132))
            def response(session):
                body = b"\x0a\x20" + session + suffix
                any_value = (b"\x0a" + workload._encode_varint(len(kind)) + kind +
                             b"\x12" + workload._encode_varint(len(body)) + body)
                return b"\x12" + workload._encode_varint(len(any_value)) + any_value
            committed = dict(outcome="committed_success", height=12, code=0,
                gas_wanted=62_100_000, gas_used=15_000_000, txhash="AB" * 32,
                data=b"".join(response(value) for value in session_ids).hex())
            with patch.object(artifact, "scheduled_transaction", return_value=committed) as submit, \
                    patch.object(workload, "verify_transaction_nodes", return_value=[
                        {"node_id": str(i), "bytes": 4096} for i in range(4)]):
                ids, height = workload.open_v3_session_batch(life, paths, home / "batch", command)
            self.assertEqual((ids, height), ([value.hex() for value in session_ids], 12))
            self.assertNotEqual(completion_order, list(range(1, 32)))
            self.assertEqual([int(generated[index]["auth_info"]["fee"]["gas_limit"]) for index in range(1, 32)],
                             [2_100_000] + [2_000_000] * 30)
            signed_messages = json.loads((home / "batch/signed.json").read_text())["body"]["messages"]
            self.assertEqual([int(message["nonce"]) for message in signed_messages], list(range(1, 32)))
            self.assertEqual(life.doc["native_v3_open_batches"][0]["signed_gas"], 62_100_000)
            self.assertEqual(life.doc["native_v3_open_batches"][0]["committed_bytes"], 4096)
            submit.assert_called_once()

    def test_provider_wave_and_committed_message_are_exact(self):
        providers = dict(enumerate(AUDIT_ADDRESSES[:8]))
        rows = [dict(status="success", http_status=200, curl_returncode=0,
                     session_id="0x" + self.SESSION, cleanup_status="complete",
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

    def test_provider_phase_timing_is_separate_bounded_and_receipt_bound(self):
        provider = AUDIT_ADDRESSES[0]
        txhash = "AB" * 32
        timing = dict(schema=workload.V3_PROVIDER_TIMING_SCHEMA,
            authority_ns=100, proof_preparation_ns=200,
            submission_attempts=[dict(attempt=1, pre_broadcast_ns=300,
                broadcast_tx_sync_ns=400, check_tx_code=0)],
            commit_observation_ns=500, provider_total_ns=1600)
        outcome = dict(status="success", request_id="measured-1-0", provider=provider,
            session_id="0x" + self.SESSION, slot=0, tx_hash=txhash, timing=timing)
        transaction = dict(operation_id="measured-1-0", provider=provider, creator=provider,
            session_id="0x" + self.SESSION, slot=0, txhash=txhash,
            outcome="committed_success", validators=[{"node_id": str(i)} for i in range(4)])
        summary = workload.validate_v3_provider_phase_timings([outcome], [transaction])
        self.assertTrue(summary["qualification"])
        self.assertEqual(summary["percentiles_ns"]["proof_preparation_ns"],
                         {"p50": 200, "p95": 200, "p99": 200})
        self.assertEqual(summary["observations"], [
            {"operation_id": "measured-1-0", "unattributed_ns": 100}])

        retry = copy.deepcopy(outcome)
        retry["timing"]["submission_attempts"] = [
            dict(attempt=1, pre_broadcast_ns=100, broadcast_tx_sync_ns=200, check_tx_code=32),
            dict(attempt=2, pre_broadcast_ns=300, broadcast_tx_sync_ns=400, check_tx_code=0)]
        retry["timing"]["provider_total_ns"] = 1800
        summary = workload.validate_v3_provider_phase_timings([retry], [transaction])
        self.assertTrue(summary["qualification"])
        self.assertEqual(summary["sequence_retry_attempts"], 1)

        cases = {}
        cases["missing"] = copy.deepcopy(outcome)
        del cases["missing"]["timing"]
        cases["negative"] = copy.deepcopy(outcome)
        cases["negative"]["timing"]["authority_ns"] = -1
        cases["overflow"] = copy.deepcopy(outcome)
        cases["overflow"]["timing"]["submission_attempts"][0]["pre_broadcast_ns"] = 1 << 64
        cases["bad_code"] = copy.deepcopy(outcome)
        cases["bad_code"]["timing"]["submission_attempts"][0]["check_tx_code"] = 32
        cases["bool_attempt"] = copy.deepcopy(outcome)
        cases["bool_attempt"]["timing"]["submission_attempts"][0]["attempt"] = True
        cases["bad_slot"] = copy.deepcopy(outcome)
        cases["bad_slot"]["slot"] = "not-an-integer"
        cases["identity"] = copy.deepcopy(outcome)
        cases["identity"]["provider"] = AUDIT_ADDRESSES[1]
        for name, changed in cases.items():
            with self.subTest(name=name):
                result = workload.validate_v3_provider_phase_timings([changed], [transaction])
                self.assertFalse(result["qualification"])
                self.assertNotIn("percentiles_ns", result)
        duplicate = workload.validate_v3_provider_phase_timings(
            [outcome, copy.deepcopy(outcome)], [transaction, dict(transaction,
                operation_id="measured-1-1", txhash="CD" * 32)])
        self.assertFalse(duplicate["qualification"])
        malformed_id = copy.deepcopy(outcome)
        malformed_id["request_id"] = []
        self.assertFalse(workload.validate_v3_provider_phase_timings(
            [malformed_id], [transaction])["qualification"])
        self.assertFalse(workload.validate_v3_provider_phase_timings([], [])["qualification"])

    def test_committed_v3_http_transaction_normalizes_rpc_numbers_and_reconciles_raw_block(self):
        provider = AUDIT_ADDRESSES[0]
        raw = b"production-shaped-signed-transaction"
        txhash = hashlib.sha256(raw).hexdigest().upper()
        response = {"hash": txhash, "height": "219", "tx_result": {
            "code": "0", "gas_wanted": "2000000", "gas_used": "479121"}}
        message = {"@type": "/polystorechain.polystorechain.v1.MsgSubmitRetrievalSessionProofV3",
                   "creator": provider, "slot": "0",
                   "session_id": base64.b64encode(bytes.fromhex(self.SESSION)).decode(),
                   "proofs": [{"ordinal": "0"}]}
        block = {"block_id": {"hash": "CD" * 32}, "block": {
            "header": {"height": "219", "chain_id": "chain", "time": "time", "app_hash": "EF" * 32},
            "data": {"txs": [base64.b64encode(raw).decode()]}}}
        block_results = {"height": "219", "txs_results": [{
            "code": "0", "gas_wanted": "2000000", "gas_used": "479121"}]}
        commit = {"canonical": True, "signed_header": {"header": block["block"]["header"],
            "commit": {"height": "219", "block_id": block["block_id"]}}}
        decoded = {"txhash": txhash, "height": "219", "tx": {"body": {"messages": [message]}}}
        tip_advanced = False
        def wait_height(height):
            nonlocal tip_advanced
            self.assertEqual(height, 220)
            tip_advanced = True
            return height
        def query(node, path):
            if path.startswith("/tx?"):
                return response
            if path.startswith("/block_results"):
                return block_results
            if path.startswith("/block?"):
                return block
            if path.startswith("/commit?"):
                return dict(commit, canonical=tip_advanced)
            raise AssertionError(path)
        with tempfile.TemporaryDirectory() as home:
            lifecycle = SimpleNamespace(home=Path(home), chain="chain",
                nodes=[{"home": "/home", "node_id": str(index)} for index in range(4)],
                query=query, wait_height=Mock(side_effect=wait_height), remaining=Mock(), doc={},
                cli=Mock(return_value=json.dumps(decoded)))
            transaction = workload.committed_v3_http_tx(lifecycle,
                {"tx_hash": txhash}, kind="session-proof", creator=provider, slot=0,
                session_id=self.SESSION, proof_count=1)
            self.assertEqual({key: transaction[key] for key in ("height", "code", "gas_wanted", "gas_used")},
                             {"height": 219, "code": 0, "gas_wanted": 2000000, "gas_used": 479121})
            self.assertTrue(all(isinstance(transaction[key], int)
                                for key in ("height", "code", "gas_wanted", "gas_used")))
            self.assertEqual(transaction["outcome"], "committed_success")
            tip_advanced = False
            lifecycle.wait_height.reset_mock()
            transaction["operation_id"] = "measured-1-0"
            output = Path(home) / "blocks.jsonl"
            observed = []
            self.assertFalse(query(lifecycle.nodes[0], "/commit?height=219")["canonical"])
            workload.reconcile_transaction_blocks(
                lifecycle, [transaction], 219, 219, output,
                observe_transaction=lambda row, height: observed.append((row, height)))
            lifecycle.wait_height.assert_called_once_with(220)
            retained = json.loads(output.read_text())
            self.assertEqual(retained["transactions"][0]["operation_id"], "measured-1-0")
            self.assertEqual(observed, [(retained["transactions"][0], 219)])
            self.assertEqual(lifecycle.doc["committed_block_reconciliation"]["committed_workload_transactions"], 1)
            for field, value in (("txhash", "AB" * 32), ("height", "220")):
                changed = copy.deepcopy(decoded)
                changed[field] = value
                lifecycle.cli.return_value = json.dumps(changed)
                with self.subTest(decoded_identity=field), self.assertRaisesRegex(
                        ValueError, "decoded HTTP transaction identity"):
                    workload.committed_v3_http_tx(lifecycle,
                        {"tx_hash": txhash}, kind="session-proof", creator=provider, slot=0,
                        session_id=self.SESSION, proof_count=1)

    def test_refund_receipt_binds_decoded_owner_and_session(self):
        owner = AUDIT_ADDRESSES[8]
        txhash = "CD" * 32
        message = {"@type": "/polystorechain.polystorechain.v1.MsgRefundRetrievalSessionV3",
                   "creator": owner,
                   "session_id": base64.b64encode(bytes.fromhex(self.SESSION)).decode()}
        decoded = {"txhash": txhash, "height": "301",
                   "tx": {"body": {"messages": [message]}}}
        lifecycle = SimpleNamespace(nodes=[{"home": "/home"}],
            cli=Mock(return_value=json.dumps(decoded)))
        result = dict(txhash=txhash, height=301, code=0, gas_wanted=500000, gas_used=400000)
        validators = [{"node_id": str(index)} for index in range(4)]
        with patch.object(workload, "verify_transaction_nodes", return_value=validators):
            verified = workload.verify_v3_refund_transaction(
                lifecycle, result, owner=owner, session_id=self.SESSION)
        self.assertEqual((verified["message"], verified["validators"]), (message, validators))
        for field, value in (("creator", AUDIT_ADDRESSES[7]),
                             ("session_id", base64.b64encode(bytes(32)).decode())):
            changed = copy.deepcopy(decoded)
            changed["tx"]["body"]["messages"][0][field] = value
            lifecycle.cli.return_value = json.dumps(changed)
            with self.subTest(field=field), patch.object(
                    workload, "verify_transaction_nodes", return_value=validators), \
                    self.assertRaisesRegex(ValueError, "intended owner/session"):
                workload.verify_v3_refund_transaction(
                    lifecycle, copy.deepcopy(result), owner=owner, session_id=self.SESSION)


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

    def test_session_proof_phase_retries_only_exact_pre_admission_busy(self):
        providers = dict(enumerate(AUDIT_ADDRESSES[:8]))
        requests = [dict(provider=providers[slot], url=f"http://provider/{slot}", body={})
                    for slot in range(8)]

        def run_case(tmp, phase, response):
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 30 * 10**9, save=Mock(), remaining=Mock(return_value=1))
            calls = {}
            def run(argv, deadline, env):
                slot = int(argv[-1].rsplit("/", 1)[-1])
                calls[slot] = calls.get(slot, 0) + 1
                body, status, returncode = response(slot, calls[slot])
                Path(argv[argv.index("--output") + 1]).write_text(json.dumps(body))
                return SimpleNamespace(stdout=str(status), stderr="", returncode=returncode)
            with patch.object(artifact, "run_bounded_command", side_effect=run), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES), \
                 patch.object(workload.time, "sleep"):
                outcomes = workload.run_v3_http_phase(lifecycle, "/curl", requests, phase,
                    max_in_flight=8, retry_pre_admission_busy=True)
            return lifecycle, calls, outcomes

        def success(slot):
            return dict(status="success", session_id="0x" + self.SESSION,
                        cleanup_status="complete", slot=slot, proof_count=17 if slot < 7 else 13,
                        tx_hash=f"{slot + 1:064x}")

        with tempfile.TemporaryDirectory() as tmp:
            def one_busy(slot, attempt):
                if slot == 5 and attempt == 1:
                    return ({"error": "retrieval submission busy",
                             "hint": "retrieval submission capacity or signer busy"}, 429, 0)
                return success(slot), 200, 0
            lifecycle, calls, outcomes = run_case(tmp, "busy-then-success", one_busy)
            self.assertEqual(calls, {slot: 2 if slot == 5 else 1 for slot in range(8)})
            self.assertEqual(len(lifecycle.doc["v3_http_phases"]["busy-then-success"]), 9)
            self.assertEqual(len(outcomes), 8)
            self.assertEqual(workload.validate_v3_provider_outcomes(
                outcomes, providers, session_id=self.SESSION)["proof_count"], 132)

        with tempfile.TemporaryDirectory() as tmp:
            def unknown(slot, attempt):
                if slot == 5:
                    return ({"error": "retrieval submission busy",
                             "hint": "retrieval submission capacity or signer busy",
                             "tx_hash": "A" * 64}, 429, 0)
                return success(slot), 200, 0
            _, calls, outcomes = run_case(tmp, "unknown-429", unknown)
            self.assertEqual(calls, {slot: 1 for slot in range(8)})
            with self.assertRaisesRegex(ValueError,
                    "provider .*http_status=429.*status=None.*retrieval submission busy"):
                workload.validate_v3_provider_outcomes(outcomes, providers, session_id=self.SESSION)

        with tempfile.TemporaryDirectory() as tmp:
            def nonzero_curl(slot, attempt):
                return success(slot), 200, 7 if slot == 5 else 0
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 10**9, save=Mock(), remaining=Mock(return_value=1))
            calls = {}
            def run(argv, deadline, env):
                slot = int(argv[-1].rsplit("/", 1)[-1])
                calls[slot] = calls.get(slot, 0) + 1
                body, status, returncode = nonzero_curl(slot, calls[slot])
                Path(argv[argv.index("--output") + 1]).write_text(json.dumps(body))
                return SimpleNamespace(stdout=str(status), stderr="curl failed", returncode=returncode)
            with patch.object(artifact, "run_bounded_command", side_effect=run), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES):
                with self.assertRaisesRegex(ValueError, "provider .*exited 7"):
                    workload.run_v3_http_phase(lifecycle, "/curl", requests, "nonzero-curl",
                        max_in_flight=8, retry_pre_admission_busy=True)
            retained = lifecycle.doc["v3_http_phases"]["nonzero-curl"]
            self.assertEqual(len(retained), 8)
            self.assertEqual(next(row for row in retained if row["provider"] == providers[5])["curl_returncode"], 7)

        with tempfile.TemporaryDirectory() as tmp:
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 30 * 10**9, save=Mock(), remaining=Mock(return_value=1))
            calls = 0
            def run(argv, deadline, env):
                nonlocal calls
                calls += 1
                path = Path(argv[argv.index("--output") + 1])
                if calls == 1:
                    path.write_text(json.dumps({"error": "retrieval submission busy",
                        "hint": "retrieval submission capacity or signer busy"}))
                    return SimpleNamespace(stdout="429", stderr="", returncode=0)
                path.write_text("{")
                return SimpleNamespace(stdout="200", stderr="", returncode=0)
            with patch.object(artifact, "run_bounded_command", side_effect=run), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES), \
                 patch.object(workload.time, "sleep"):
                with self.assertRaises(ValueError):
                    workload.run_v3_http_phase(lifecycle, "/curl", [requests[5]], "retry-parser-error",
                        max_in_flight=1, retry_pre_admission_busy=True)
            retained = lifecycle.doc["v3_http_phases"]["retry-parser-error"]
            self.assertEqual((calls, len(retained), retained[0]["http_status"], retained[1]["status"]),
                             (2, 2, 429, "driver_error"))
            self.assertLessEqual(retained[1]["request_started_ns"],
                                 retained[1]["request_finished_ns"])

    def test_generation_acceptance_retries_only_exact_prebroadcast_signer_busy(self):
        hint = "retrieval submission capacity or signer busy"

        def run_case(tmp, route, response):
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 30 * 10**9, save=Mock(), remaining=Mock(return_value=1))
            requests = [dict(provider="provider-a", url="http://provider" + route,
                             body={"deal_id": 7, "provider": "provider-a"})]
            calls = 0
            def run(argv, deadline, env):
                nonlocal calls
                calls += 1
                body, status = response(calls)
                Path(argv[argv.index("--output") + 1]).write_text(json.dumps(body))
                return SimpleNamespace(stdout=str(status), stderr="", returncode=0)
            with patch.object(artifact, "run_bounded_command", side_effect=run), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES), \
                 patch.object(workload.time, "sleep"):
                outcomes = workload.run_v3_http_phase(lifecycle, "/curl", requests,
                    "generation-busy", max_in_flight=1, retry_pre_admission_busy=True)
            return calls, lifecycle.doc["v3_http_phases"]["generation-busy"], outcomes

        for error in ("provider signer busy", "provider signer busy after generation verification"):
            with self.subTest(error=error), tempfile.TemporaryDirectory() as tmp:
                def busy_then_success(attempt, error=error):
                    if attempt == 1:
                        return {"error": error, "hint": hint}, 429
                    return {"status": "success"}, 200
                calls, retained, outcomes = run_case(tmp, "/sp/generation-v3/accept", busy_then_success)
                self.assertEqual((calls, len(retained), outcomes[0]["status"]), (2, 2, "success"))

        with tempfile.TemporaryDirectory() as tmp:
            calls, retained, outcomes = run_case(tmp, "/sp/generation-v3/accept",
                lambda attempt: ({"error": "provider signer busy", "hint": hint}, 429))
            self.assertEqual((calls, len(retained), outcomes[0]["http_status"], outcomes[0]["attempt"]),
                             (workload.V3_BUSY_MAX_ATTEMPTS, workload.V3_BUSY_MAX_ATTEMPTS, 429,
                              workload.V3_BUSY_MAX_ATTEMPTS))

        rejected = [
            ("/sp/session-proof", {"error": "provider signer busy", "hint": hint}),
            ("/sp/generation-v3/accept",
             {"error": "provider signer busy", "hint": hint, "tx_hash": "A" * 64}),
        ]
        for route, body in rejected:
            with self.subTest(route=route, keys=sorted(body)), tempfile.TemporaryDirectory() as tmp:
                calls, retained, outcomes = run_case(tmp, route, lambda attempt, body=body: (body, 429))
                self.assertEqual((calls, len(retained), outcomes[0]["http_status"]), (1, 1, 429))

    def test_generation_admission_enables_busy_retry_and_reports_terminal_outcome(self):
        candidate = dict(deal_id="7", expected_current_generation="0",
            previous_polyfs_root="", polyfs_root="0x" + self.ROOT,
            integrity_root="0x" + self.INTEGRITY, size_bytes=str(workload.V3_PILOT_BYTES),
            total_mdus="5", witness_mdus="1", integrity_leaf_count="288",
            commit_action="propose-deal-generation-v3", required_acceptances="12")
        providers = dict(enumerate(AUDIT_ADDRESSES))
        lifecycle = SimpleNamespace(signers={"owner0": AUDIT_ADDRESSES[8]}, nodes=[{}],
            wait_height=Mock(), doc={"providers": [
                {"address": provider, "port": 19091 + slot}
                for slot, provider in providers.items()]})
        terminal = dict(provider=providers[0], http_status=429, status=None,
                        error="provider signer busy", hint="retrieval submission capacity or signer busy")
        phase = Mock(return_value=[terminal])
        with patch.object(workload, "verify_transaction_nodes", return_value=[]), \
             patch.object(workload, "run_v3_http_phase", phase), \
             self.assertRaisesRegex(ValueError,
                 "provider=.*http_status='429'.*status='None'.*provider signer busy"):
            workload.admit_native_v3_generation(lifecycle,
                uploaded={"generation_candidate": candidate}, deal_id="7", providers=providers,
                send=Mock(return_value={"height": 10}), curl="/curl")
        self.assertTrue(phase.call_args.kwargs["retry_pre_admission_busy"])

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

    def test_native_chain_proc_accounting_and_identity(self):
        fields = ["S"] + ["0"] * 18 + ["999"] + ["0"] * 4
        fields[11], fields[12] = "101", "17"
        parsed = workload.parse_proc_stat("42 (validator worker) name) " + " ".join(fields), expected_pid=42)
        self.assertEqual(parsed, dict(pid=42, user_ticks=101, system_ticks=17,
                                     starttime_ticks=999, rss_pages=0))
        with self.assertRaises(ValueError):
            workload.parse_proc_stat("42 (validator) " + " ".join(fields), expected_pid=43)
        before = dict(monotonic_ns=10, clock_ticks_per_second=100,
                      validators=[dict(node_id="n", pid=42, starttime_ticks=999, user_ticks=101, system_ticks=17)])
        after = copy.deepcopy(before)
        after.update(monotonic_ns=20)
        after["validators"][0].update(user_ticks=121, system_ticks=22)
        delta = workload.validator_cpu_delta(before, after)
        self.assertEqual((delta["validators"][0]["user_cpu_seconds"], delta["validators"][0]["system_cpu_seconds"]), (.2, .05))
        after["validators"][0]["starttime_ticks"] += 1
        with self.assertRaisesRegex(ValueError, "identity"):
            workload.validator_cpu_delta(before, after)
        after = copy.deepcopy(before)
        after.update(monotonic_ns=20)
        after["validators"][0]["user_ticks"] -= 1
        with self.assertRaisesRegex(ValueError, "backwards"):
            workload.validator_cpu_delta(before, after)

    def test_native_chain_host_identity_is_frozen(self):
        with patch.object(workload.platform, "platform", return_value="Linux-test"), \
             patch.object(workload.platform, "machine", return_value="x86_64"), \
             patch.object(workload.os, "cpu_count", return_value=16):
            self.assertEqual(workload.host_identity(), {
                "host": "Linux-test", "machine": "x86_64", "logical_cpus": 16})

    def test_native_chain_capacity_profiles_cover_distinct_protocol_shapes(self):
        inspect.signature(workload.run_native_v3_chain).bind(
            SimpleNamespace(), deal={}, providers={}, wait=Mock(), audits=Mock(),
            exporter=Path("/exporter"), command=Mock(), epoch_length=100)
        profiles = workload.native_v3_chain_capacity_profiles()
        self.assertEqual([(row["name"], row["range_bytes"], row["population"],
                           row["sample_count"], row["proof_transactions"], row["sessions"],
                           row["measured_transactions"]) for row in profiles], [
            ("1kib", 1024, 1, 1, 1, 1280, 1280),
            ("eight-blobs", 8 * 126_976, 8, 8, 8, 160, 1280),
            ("sample-cap", 16 * 1024 * 1024, 133, 132, 8, 10, 80),
        ])
        selected = workload.native_v3_chain_capacity_profiles("1kib", 4992)
        self.assertEqual([(row["name"], row["sessions"], row["measured_transactions"])
                          for row in selected], [("1kib", 4992, 4992)])
        with self.assertRaisesRegex(ValueError, "transaction count"):
            workload.native_v3_chain_capacity_profiles("1kib")
        with self.assertRaisesRegex(ValueError, "balance provider lanes"):
            workload.native_v3_chain_capacity_profiles("1kib", 4991)
        with self.assertRaisesRegex(ValueError, "must be 1..4999"):
            workload.native_v3_chain_capacity_profiles("1kib", 5000)
        with self.assertRaisesRegex(ValueError, "more than ten"):
            workload.native_v3_minimum_gas_blocks(10 * 64_000_000, 64_000_000)
        self.assertEqual(workload.native_v3_minimum_gas_blocks(
            10 * 64_000_000 + 1, 64_000_000), 11)
        workload.validate_native_v3_capacity_epoch(selected[0], 448_000_000)
        with self.assertRaisesRegex(ValueError, "more than ten"):
            workload.validate_native_v3_capacity_epoch(
                workload.native_v3_chain_capacity_profiles("1kib", 4952)[0], 448_000_000)
        workload.validate_native_v3_capacity_epoch(
            workload.native_v3_chain_capacity_profiles("1kib", 4960)[0], 448_000_000)
        workload.validate_native_v3_capacity_epoch(
            workload.native_v3_chain_capacity_profiles("1kib", 4608)[0], 64_000_000)
        with self.assertRaisesRegex(ValueError, "cannot fit"):
            workload.validate_native_v3_capacity_epoch(
                workload.native_v3_chain_capacity_profiles("1kib", 4616)[0], 64_000_000)
        workload.validate_native_v3_capacity_epoch(
            workload.native_v3_chain_capacity_profiles("sample-cap", 2248)[0], 448_000_000)
        with self.assertRaisesRegex(ValueError, "cannot fit"):
            workload.validate_native_v3_capacity_epoch(
                workload.native_v3_chain_capacity_profiles("sample-cap", 2256)[0], 448_000_000)
        rotated = workload.native_v3_range_shape(1024, range_start=7 * 126_976)
        self.assertEqual((rotated["first_blob"], rotated["last_blob"],
                          rotated["obligation_slots"]), (7, 7, [7]))
        deadlines = [workload.native_v3_capacity_deadline(10, index) for index in range(1450)]
        self.assertEqual((deadlines[0], deadlines[127], deadlines[128], deadlines[-1],
                          max(deadlines.count(value) for value in set(deadlines))),
                         (4106, 4106, 4107, 4117, 128))

    def test_capacity_window_waits_for_next_epoch_and_complete_audits(self):
        heights = iter((95, 103, 104, 105))
        lifecycle = SimpleNamespace(wait_height=lambda _: next(heights))
        waited = []
        audits = Mock(side_effect=(
            ValueError("missing or duplicate all-slot audit evidence"),
            {0: {"audit": {"accepted_count": "0", "sample_count": "1"}}},
            {0: {"audit": {"accepted_count": "1", "sample_count": "1"}}},
        ))
        result = workload.await_native_v3_capacity_window(
            lifecycle, waited.append, audits, 100, 20, 500)
        self.assertEqual((waited, result["height"], result["epoch"], result["next_anchor"]),
                         ([103, 104, 105], 105, 2, 201))
        with self.assertRaisesRegex(ValueError, "cannot fit"):
            workload.await_native_v3_capacity_window(
                SimpleNamespace(wait_height=Mock()), Mock(), Mock(), 100, 99, 500)

    def test_direct_broadcast_and_mempool_responses_fail_closed(self):
        txhash = "AB" * 32
        result = workload.validate_broadcast_tx_sync(
            {"jsonrpc": "2.0", "id": 7, "result": {"code": "0", "hash": txhash.lower()}}, txhash, 7)
        self.assertEqual(result["code"], "0")
        for value in (
            {"jsonrpc": "2.0", "id": 8, "result": {"code": 0, "hash": txhash}},
            {"jsonrpc": "2.0", "id": 7, "result": {"code": 19, "hash": txhash}},
            {"jsonrpc": "2.0", "id": 7, "result": {"code": 0, "hash": "CD" * 32}},
            {"jsonrpc": "2.0", "id": 7, "error": {"code": -1}},
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                workload.validate_broadcast_tx_sync(value, txhash, 7)
        self.assertEqual(workload.validate_mempool_sample(
            {"n_txs": "3", "total": "3", "total_bytes": "99"}),
            {"transactions": 3, "bytes": 99})
        with self.assertRaises(ValueError):
            workload.validate_mempool_sample({"n_txs": "2", "total": "3", "total_bytes": "99"})

    def test_backlog_requires_all_four_validators_and_bounded_sample_gaps(self):
        def sample(second, counts):
            return {"sample_started_monotonic_ns": second * 10**9,
                    "monotonic_ns": second * 10**9, "unix_ns": (100 + second) * 10**9,
                    "observed_height": 10 + second,
                    "nodes": [{"transactions": count, "bytes": count * 10} for count in counts]}
        samples = [sample(second, [1, 1, 1, 1]) for second in range(11)]
        self.assertEqual(workload.native_v3_backlog_duration_ns(samples), 10 * 10**9)
        samples[5] = sample(5, [1, 1, 1, 0])
        self.assertEqual(workload.native_v3_backlog_duration_ns(samples), 4 * 10**9)
        sparse = [sample(0, [1] * 4), sample(3, [1] * 4)]
        self.assertEqual(workload.native_v3_backlog_duration_ns(sparse), 0)
        with self.assertRaisesRegex(ValueError, "height regressed"):
            workload.native_v3_backlog_duration_ns([
                sample(0, [1] * 4), dict(sample(1, [1] * 4), observed_height=9)])
        with self.assertRaisesRegex(ValueError, "monotonic bounds"):
            workload.native_v3_backlog_duration_ns([
                dict(sample(0, [1] * 4), sample_started_monotonic_ns=1)])

    def test_capacity_metrics_use_monotonic_backlog_and_height_fence(self):
        base = 1_700_000_000 * 10**9
        def timestamp(seconds):
            return datetime.datetime.fromtimestamp((base + seconds * 10**9) / 10**9,
                datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        hashes = [f"{index + 1:064X}" for index in range(4)]
        offered = [dict(txhash=txhash, offered_monotonic_ns=10**9,
                        offered_unix_ns=base + 30 * 10**9) for txhash in hashes]
        committed = [dict(txhash=txhash, height=11 + index,
                          committed_time=timestamp(5 * (index + 1)),
                          ordinals=[0, 1], session_index=index, slot=index)
                     for index, txhash in enumerate(hashes)]
        blocks = [dict(height=10, time=timestamp(0), transactions=[], gas_wanted=0, gas_used=0,
                       tx_payload_bytes=0)]
        for index, txhash in enumerate(hashes):
            blocks.append(dict(height=11 + index, time=timestamp(5 * (index + 1)),
                transactions=[dict(txhash=txhash, gas_wanted=10, gas_used=9, bytes=100)],
                gas_wanted=10, gas_used=9, tx_payload_bytes=100))
        def resource_nodes(second, count):
            return [dict(node_id=str(index), transactions=count, bytes=count * 100,
                         pid=100 + index, starttime_ticks=99, user_ticks=second,
                         system_ticks=0, rss_bytes=1_000_000 + index,
                         process_monotonic_ns=second * 10**9) for index in range(4)]
        samples = [{"sample_started_monotonic_ns": second * 10**9,
                    "monotonic_ns": second * 10**9, "unix_ns": base + second * 10**9,
                    "observed_height": 10 + second // 5,
                    "clock_ticks_per_second": 100,
                    "nodes": resource_nodes(second, 1)} for second in range(16)]
        samples.append({"sample_started_monotonic_ns": 20 * 10**9,
                        "monotonic_ns": 20 * 10**9, "unix_ns": base + 20 * 10**9,
                        "observed_height": 14,
                        "clock_ticks_per_second": 100,
                        "nodes": resource_nodes(20, 0)})
        metrics = workload.native_v3_capacity_metrics(
            {"proof_transactions": 1, "obligation_slots": [0], "range_bytes": 1024,
             "sample_count": 2, "sessions": 4},
            offered, committed, blocks,
            0, 2 * 10**9, 25 * 10**9, samples)
        self.assertEqual(metrics["saturated_commit_interval"], {
            "predecessor_height": 10, "first_height": 11, "last_height": 13,
            "observation_start_height": 10, "observation_end_height": 13,
            "elapsed_seconds": 15.0, "transactions": 3, "blocks": 3,
            "timing_basis": "monotonic all-validator-positive observation fence"})
        self.assertEqual(metrics["commit_interval_seconds"]["p95"], 5.0)
        self.assertEqual(metrics["peak_observed_mempool_transactions"], 1)
        self.assertAlmostEqual(metrics["validator_resources_during_backlog"]["validators"][0]
                               ["cpu_percent_of_one_core"], 1.0)
        self.assertAlmostEqual(metrics["committed_transactions_per_second"], .2)
        self.assertAlmostEqual(metrics["committed_sampled_chained_proofs_per_second"], .4)
        self.assertAlmostEqual(metrics["committed_kzg_opening_verifications_per_second"], .8)
        self.assertAlmostEqual(
            metrics["provisional_shared_host_standalone_kzg_session_proxy_per_second"],
            workload.V3_PROVISIONAL_SHARED_HOST_STANDALONE_KZG_SAMPLED_PROOF_PROXY_PER_SECOND / 2)
        self.assertAlmostEqual(
            metrics["provisional_percent_of_shared_host_standalone_kzg_sampled_proof_proxy"],
            .4 / workload.V3_PROVISIONAL_SHARED_HOST_STANDALONE_KZG_SAMPLED_PROOF_PROXY_PER_SECOND * 100)
        self.assertEqual(metrics["provisional_shared_host_standalone_kzg_provenance"]["artifact_path"],
            "bench/retrieval_session_capacity/parallel-ceiling-328/results.json")
        self.assertEqual(metrics["provisional_shared_host_standalone_kzg_provenance"]["artifact_commit"],
            "db9fe2b691935a198e35d3676f2ad71c9aff5f42")
        self.assertIn("does not execute the active VerifyPolyFSSessionProofBatch",
            metrics["provisional_shared_host_standalone_kzg_provenance"]["limitation"])
        self.assertAlmostEqual(metrics["complete_proof_sets_per_second"], .2)
        self.assertEqual(metrics["daily_equivalent_basis"],
            "short saturated rate multiplied by 86400; not a 24-hour sustained or delivery claim")
        self.assertEqual(metrics["inclusion_latency_upper_bound_seconds"], {
            "basis": "offer to first local RPC observation at or above the committed height; conservative upper bound",
            "min": 4.0, "p50": 9.0, "p95": 19.0, "max": 19.0})
        self.assertEqual([metrics[name] for name in ("invalid_transactions", "unknown_transactions",
            "duplicate_transactions", "dropped_transactions", "retried_transactions")], [0] * 5)
        self.assertAlmostEqual(metrics["logical_requested_bytes_per_day"], .2 * 86400 * 1024)
        skewed = [dict(row, time=timestamp(-100 + index)) for index, row in enumerate(blocks)]
        skewed_metrics = workload.native_v3_capacity_metrics(
            {"proof_transactions": 1, "obligation_slots": [0], "range_bytes": 1024,
             "sample_count": 2, "sessions": 4},
            offered, committed, skewed, 0, 2 * 10**9, 25 * 10**9, samples)
        self.assertEqual(skewed_metrics["committed_transactions_per_second"],
                         metrics["committed_transactions_per_second"])
        with self.assertRaisesRegex(ValueError, "did not observe a committed transaction height"):
            workload.native_v3_capacity_metrics(
                {"proof_transactions": 1, "obligation_slots": [0], "range_bytes": 1024,
                 "sample_count": 2, "sessions": 4},
                offered, committed, blocks, 0, 2 * 10**9, 25 * 10**9, samples[:-1])
        with self.assertRaisesRegex(ValueError, "positive mempool backlog"):
            workload.native_v3_capacity_metrics(
                {"proof_transactions": 1, "obligation_slots": [0], "range_bytes": 1024,
                 "sample_count": 2, "sessions": 4}, offered,
                committed, blocks[:2], 0, 2 * 10**9, 25 * 10**9, samples[:10])
        wrong_sample_count = [dict(row) for row in committed]
        wrong_sample_count[0] = dict(wrong_sample_count[0], ordinals=[0])
        with self.assertRaisesRegex(ValueError, "differs from the profile sample count"):
            workload.native_v3_capacity_metrics(
                {"proof_transactions": 1, "obligation_slots": [0], "range_bytes": 1024,
                 "sample_count": 2, "sessions": 4}, offered,
                wrong_sample_count, blocks, 0, 2 * 10**9, 25 * 10**9, samples)

        imbalanced = [dict(row, session_index=index // 2, slot=index % 2)
                      for index, row in enumerate(committed)]
        imbalanced_metrics = workload.native_v3_capacity_metrics(
            {"proof_transactions": 2, "obligation_slots": [0, 1], "range_bytes": 8,
             "sample_count": 4, "sessions": 2},
            offered, imbalanced, blocks, 0, 2 * 10**9, 25 * 10**9, samples)
        self.assertAlmostEqual(imbalanced_metrics["complete_proof_sets_per_second"], 1 / 15)
        self.assertEqual(imbalanced_metrics["partial_proof_sets_in_saturated_interval"], 1)

    def test_128m_qualification_gates_mempool_resources_and_consensus(self):
        metrics = dict(saturated_commit_interval={"blocks": 30}, positive_backlog_seconds=10,
            commit_interval_seconds={"p95": 1.6}, peak_observed_mempool_transactions=4999,
            validator_resources_during_backlog={"validators": [
                {"cpu_percent_of_one_core": 59.9} for _ in range(4)]},
            invalid_transactions=0, unknown_transactions=0, duplicate_transactions=0,
            dropped_transactions=0, retried_transactions=0)
        finalize = [{"summary": {"p95_within_650ms": True}} for _ in range(4)]
        consensus = {"maximum_round": 0, "missed_signatures": 0}
        result = workload.native_v3_128m_qualification(metrics, finalize, consensus,
            4992, 4992, 5000)
        self.assertTrue(result["qualified"])
        metrics["peak_observed_mempool_transactions"] = 5000
        result = workload.native_v3_128m_qualification(metrics, finalize, consensus,
            4992, 4992, 5000)
        self.assertFalse(result["qualified"])
        self.assertIn("mempool", " ".join(result["reasons"]))

    def test_failed_128m_qualification_retains_restart_validation_and_original_failure(self):
        original = "128M qualification gates failed: validator CPU exceeded the gate"
        for restart_result in (
                dict(chain_progress_verified=True, qualification=True),
                RuntimeError("validator restart failed")):
            with self.subTest(restart_result=type(restart_result).__name__):
                lifecycle = SimpleNamespace(doc={"native_v3_chain": {
                    "qualification_error": original}}, save=Mock())
                kwargs = ({"return_value": restart_result}
                          if isinstance(restart_result, dict) else {"side_effect": restart_result})
                with patch.object(workload, "validate_native_v3_candidate_restart", **kwargs) as restart:
                    with self.assertRaisesRegex(ValueError, original) as raised:
                        workload.finalize_native_v3_candidate(lifecycle, Mock(), Mock(), 100)
                restart.assert_called_once()
                self.assertFalse(lifecycle.doc["native_v3_chain"]["qualification"])
                self.assertEqual(lifecycle.doc["native_v3_chain"]["status"],
                                 "native_v3_chain_capacity_qualification_failed")
                if isinstance(restart_result, dict):
                    self.assertTrue(lifecycle.doc["native_v3_chain"]
                                    ["post_qualification_restart"]["chain_progress_verified"])
                    self.assertIsNone(raised.exception.__cause__)
                else:
                    self.assertEqual(lifecycle.doc["native_v3_chain"]
                                     ["post_qualification_restart"]["error"], str(restart_result))
                    self.assertIs(raised.exception.__cause__, restart_result)

    def test_successful_128m_qualification_requires_successful_restart(self):
        lifecycle = SimpleNamespace(doc={"native_v3_chain": {}}, save=Mock())
        restart_result = dict(chain_progress_verified=True, qualification=True)
        with patch.object(workload, "validate_native_v3_candidate_restart",
                          return_value=restart_result) as restart:
            workload.finalize_native_v3_candidate(lifecycle, Mock(), Mock(), 100)
        restart.assert_called_once()
        self.assertTrue(lifecycle.doc["native_v3_chain"]["qualification"])
        self.assertEqual(lifecycle.doc["native_v3_chain"]["status"],
                         "native_v3_chain_capacity_passed")
        self.assertIs(lifecycle.doc["native_v3_chain"]["post_qualification_restart"],
                      restart_result)

    def test_consensus_commit_summary_requires_round_zero_and_all_signatures(self):
        def signed(height, round=0, flags=(2, 2, 2, 2)):
            return {"canonical": True, "signed_header": {
                "header": {"height": str(height), "chain_id": "bench"},
                "commit": {"height": str(height), "round": str(round),
                           "signatures": [{"block_id_flag": flag} for flag in flags]}}}
        rows = [workload.consensus_commit_observation(signed(10), 10, "bench"),
                workload.consensus_commit_observation(signed(11, 1, (2, 2, 1, 2)), 11, "bench")]
        summary = workload.summarize_consensus_commits(rows, 10, 11)
        self.assertEqual((summary["maximum_round"], summary["blocks_above_round_zero"],
                          summary["missed_signatures"]), (1, 1, 1))
        with self.assertRaisesRegex(ValueError, "cover"):
            workload.summarize_consensus_commits(rows[1:], 10, 11)

    def test_cross_audit_profile_and_provider_scheduler_are_fixed_and_serial_per_signer(self):
        profile = workload.native_v3_cross_audit_schedule()
        self.assertEqual((len(profile), profile[0], profile[-1]), (360,
            dict(id="measured-1-0", index=0, session_index=1, slot=0, offered_offset_ns=0),
            dict(id="measured-45-7", index=359, session_index=45, slot=7,
                 offered_offset_ns=179_500_000_000)))
        self.assertEqual({slot: sum(row["slot"] == slot for row in profile) for slot in range(8)},
                         {slot: 45 for slot in range(8)})
        oversized = [dict(id=f"r{index}", provider="provider", offered_offset_ns=index,
                          url="http://provider", body={}) for index in range(361)]
        with self.assertRaisesRegex(ValueError, "invalid bounded"):
            workload.run_v3_http_schedule(SimpleNamespace(), "/curl", oversized, "oversized")
        with tempfile.TemporaryDirectory() as tmp:
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 10 * 10**9, save=Mock(), remaining=Mock(return_value=1))
            lock, active, maxima = threading.Lock(), {}, {}
            requests = []
            for index in range(8):
                provider = f"provider-{index % 2}"
                requests.append(dict(id=f"r{index}", provider=provider,
                    offered_offset_ns=0, url=f"http://provider/{provider}/{index}", body={}))
            def run(argv, deadline, env):
                provider = argv[-1].split("/")[-2]
                with lock:
                    active[provider] = active.get(provider, 0) + 1
                    maxima[provider] = max(maxima.get(provider, 0), active[provider])
                time.sleep(.005)
                Path(argv[argv.index("--output") + 1]).write_text('{"status":"success"}')
                with lock:
                    active[provider] -= 1
                return SimpleNamespace(stdout="200", stderr="", returncode=0)
            with patch.object(artifact, "run_bounded_command", side_effect=run), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES):
                rows = workload.run_v3_http_schedule(lifecycle, "/curl", requests, "fixed-schedule")
            self.assertEqual([row["request_id"] for row in rows], [f"r{i}" for i in range(8)])
            self.assertEqual(maxima, {"provider-0": 1, "provider-1": 1})
            summary = lifecycle.doc["v3_http_schedules"]["fixed-schedule"]
            self.assertEqual((summary["offered"], summary["completed"], summary["queued"], summary["in_flight"]),
                             (8, 8, 0, 0))

    def test_cross_audit_bins_bind_each_offer_start_and_terminal(self):
        schedule = workload.native_v3_cross_audit_schedule()
        start = 1_000_000_000
        outcomes = [dict(request_id=row["id"],
                         initial_dispatch_ns=start + row["offered_offset_ns"],
                         request_started_ns=start + row["offered_offset_ns"],
                         request_finished_ns=start + row["offered_offset_ns"] + 1)
                    for row in schedule]
        requests = [dict(row, provider=f"provider-{row['slot']}", url="http://provider", body={})
                    for row in schedule]
        bins = workload.v3_http_schedule_bins(requests, outcomes, start_ns=start)
        self.assertEqual(len(bins), 6)
        self.assertEqual([row["offered"] for row in bins], [60] * 6)
        self.assertEqual([row["outstanding_at_end"] for row in bins], [0] * 6)
        self.assertEqual([row["queued_at_end"] for row in bins], [0] * 6)
        self.assertEqual([row["in_flight_at_end"] for row in bins], [0] * 6)
        outcomes[60]["initial_dispatch_ns"] += 30 * 10**9
        outcomes[60]["request_started_ns"] += 30 * 10**9
        outcomes[60]["request_finished_ns"] += 30 * 10**9
        outcomes[61]["request_finished_ns"] += 30 * 10**9
        bins = workload.v3_http_schedule_bins(requests, outcomes, start_ns=start)
        self.assertEqual((bins[1]["queued_at_end"], bins[1]["in_flight_at_end"],
                          bins[1]["outstanding_at_end"]), (1, 1, 2))
        self.assertEqual(bins[2]["carryover_queued"], 1)
        self.assertEqual(bins[2]["carryover_in_flight"], 1)
        outcomes[0]["request_started_ns"] = start - 1
        with self.assertRaisesRegex(ValueError, "precedes its offer"):
            workload.v3_http_schedule_bins(requests, outcomes, start_ns=start)

    def test_cross_audit_scheduler_retries_only_exact_busy_and_retains_drained_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 10 * 10**9, save=Mock(), remaining=Mock(return_value=1))
            requests = [dict(id=f"r{index}", provider=f"provider-{index}", offered_offset_ns=0,
                             url=f"http://provider/{index}", body={}) for index in range(2)]
            calls = {}
            def busy_then_success(argv, deadline, env):
                index = int(argv[-1].rsplit("/", 1)[-1])
                calls[index] = calls.get(index, 0) + 1
                if index == 0 and calls[index] == 1:
                    body, status = ({"error": "retrieval submission busy",
                        "hint": "retrieval submission capacity or signer busy"}, 429)
                else:
                    body, status = ({"status": "success"}, 200)
                Path(argv[argv.index("--output") + 1]).write_text(json.dumps(body))
                return SimpleNamespace(stdout=str(status), stderr="", returncode=0)
            with patch.object(artifact, "run_bounded_command", side_effect=busy_then_success), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES), \
                 patch.object(workload.time, "sleep"):
                rows = workload.run_v3_http_schedule(lifecycle, "/curl", requests, "scheduled-busy")
            self.assertEqual((calls, len(rows), len(lifecycle.doc["v3_http_phases"]["scheduled-busy"])),
                             ({0: 2, 1: 1}, 2, 3))

        with tempfile.TemporaryDirectory() as tmp:
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 10 * 10**9, save=Mock(), remaining=Mock(return_value=1))
            def one_failure(argv, deadline, env):
                index = int(argv[-1].rsplit("/", 1)[-1])
                path = Path(argv[argv.index("--output") + 1])
                if index == 0:
                    path.write_text("{")
                else:
                    path.write_text('{"status":"success"}')
                return SimpleNamespace(stdout="200", stderr="", returncode=0)
            with patch.object(artifact, "run_bounded_command", side_effect=one_failure), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES), \
                 self.assertRaises(ValueError):
                workload.run_v3_http_schedule(lifecycle, "/curl", requests, "scheduled-failure")
            retained = lifecycle.doc["v3_http_phases"]["scheduled-failure"]
            self.assertEqual({row.get("status") for row in retained}, {"driver_error", "success"})
            self.assertIn("Expecting property name", lifecycle.doc["v3_http_schedules"]["scheduled-failure"]["terminal_error"])

    def test_cross_audit_scheduler_metrics_use_initial_dispatch_and_peak_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 10 * 10**9, save=Mock(), remaining=Mock(return_value=1))
            requests = [dict(id=f"r{index}", provider=f"provider-{index}", offered_offset_ns=0,
                             url=f"http://provider/{index}", body={}) for index in range(2)]

            def completed_after_retry(_lifecycle, _curl, request, _phase, index, _directory,
                                      _deadline, _retry):
                offered = request["offered_ns"]
                first = dict(http_status=429, provider=request["provider"], request_index=index,
                    request_id=request["id"], offered_ns=offered, request_started_ns=offered + 3,
                    request_finished_ns=offered + 4)
                terminal = dict(status="success", provider=request["provider"], request_index=index,
                    request_id=request["id"], offered_ns=offered,
                    request_started_ns=offered + 2_000_000_003,
                    request_finished_ns=offered + 2_000_000_004)
                return [first, terminal], None

            with patch.object(workload, "_run_v3_http_request", side_effect=completed_after_retry), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES):
                workload.run_v3_http_schedule(lifecycle, "/curl", requests, "scheduled-metrics")
            summary = lifecycle.doc["v3_http_schedules"]["scheduled-metrics"]
            self.assertEqual(summary["max_dispatch_lag_ns"], 3)
            self.assertEqual(summary["max_in_flight"], 2)

    def test_cross_audit_scheduler_enforces_shared_offer_and_drain_deadline(self):
        with tempfile.TemporaryDirectory() as tmp:
            lifecycle = SimpleNamespace(home=Path(tmp), doc={}, env={},
                deadline=artifact.monotonic_ns() + 10 * 10**9, save=Mock(), remaining=Mock(return_value=1))
            request = dict(id="deadline", provider="provider", offered_offset_ns=0,
                           url="http://provider/0", body={})
            def run(argv, deadline, env):
                Path(argv[argv.index("--output") + 1]).write_text('{"status":"success"}')
                return SimpleNamespace(stdout="200", stderr="", returncode=0)
            with patch.object(artifact, "run_bounded_command", side_effect=run), \
                 patch.object(workload, "require_free_disk", return_value=workload.V3_ABORT_FREE_BYTES), \
                 patch.object(workload, "V3_CROSS_AUDIT_OFFER_SECONDS", 0), \
                 patch.object(workload, "V3_CROSS_AUDIT_DRAIN_SECONDS", 0), \
                 self.assertRaisesRegex(TimeoutError, "fixed offer and drain cap"):
                workload.run_v3_http_schedule(lifecycle, "/curl", [request], "scheduled-deadline")
            self.assertEqual(lifecycle.doc["v3_http_schedules"]["scheduled-deadline"]["completed"], 1)

    def test_cross_audit_sequence_reconciliation_counts_measured_proofs_and_audits(self):
        providers = dict(enumerate(AUDIT_ADDRESSES))
        before = {address: dict(account_number=slot, sequence=10) for slot, address in providers.items()}
        views = {epoch: {slot: {"audit": {"sample_count": "1", "accepted_count": "1"}}
                         for slot in providers} for epoch in (4, 5)}
        proofs = []
        for slot in range(8):
            for index in range(45):
                proofs.append(dict(txhash=f"{slot * 45 + index + 1:064X}", provider=providers[slot],
                                   outcome="committed_success"))
        audit_transactions = []
        for slot, provider in providers.items():
            for index in range(2):
                audit_transactions.append(dict(txhash=f"{1000 + slot * 8 + index:064X}", provider=provider,
                                               code=0, epoch=4 + index))
        after = copy.deepcopy(before)
        for slot, address in providers.items():
            after[address]["sequence"] += 2 + (45 if slot < 8 else 0)
        rows = workload.reconcile_cross_audit_sequences(
            before, after, providers, proofs, audit_transactions, views)
        self.assertEqual([(row["proof_transactions"], row["audit_transactions"], row["actual_delta"])
                          for row in rows], [(45, 2, 47)] * 8 + [(0, 2, 2)] * 4)
        after[providers[9]]["sequence"] += 1
        with self.assertRaisesRegex(ValueError, "outside unique workload and audit"):
            workload.reconcile_cross_audit_sequences(
                before, after, providers, proofs, audit_transactions, views)
        after[providers[9]]["sequence"] -= 1
        with self.assertRaisesRegex(ValueError, "not unique"):
            workload.reconcile_cross_audit_sequences(
                before, after, providers, proofs + [proofs[0]], audit_transactions, views)
        with self.assertRaisesRegex(ValueError, "bitmap does not equal"):
            workload.reconcile_cross_audit_sequences(
                before, after, providers, proofs, audit_transactions[:-1], views)
        wrong_epoch = copy.deepcopy(audit_transactions)
        wrong_epoch[-1]["epoch"] = 4
        with self.assertRaisesRegex(ValueError, "epoch bitmap"):
            workload.reconcile_cross_audit_sequences(
                before, after, providers, proofs, wrong_epoch, views)

    def test_cross_audit_proof_commits_span_exactly_two_anchors(self):
        self.assertEqual(workload.validate_v3_cross_audit_span(
            [{"height": "190"}, {"height": "301"}], 190, 201, 100),
            {"first_height": 190, "last_height": 301, "first_anchor": 201,
             "second_anchor": 301})
        for rows in ([{"height": 202}, {"height": 301}],
                     [{"height": 190}, {"height": 300}],
                     [{"height": 189}, {"height": 301}],
                     [{"height": 190}, {"height": 401}]):
            with self.subTest(rows=rows), self.assertRaisesRegex(ValueError, "span exactly"):
                workload.validate_v3_cross_audit_span(rows, 190, 201, 100)

    def test_cross_audit_cpu_fence_waits_for_delayed_audit_completion(self):
        events = []
        before = {"monotonic_ns": 10, "validators": []}
        after = {"monotonic_ns": 30, "validators": []}
        lifecycle = SimpleNamespace(doc={"native_v3_cross_audit": {}})
        providers = {0: AUDIT_ADDRESSES[0]}
        expected = {AUDIT_ADDRESSES[0]: 1}
        views = {0: {"audit": {"sample_count": "1", "accepted_count": "1"}}}

        signals = iter((303, 403))
        def wait_for_signal(*args):
            events.append("event-signal-and-all-node-fence")
            height = next(signals)
            return {"height": height, "signal_height": height}

        def cpu_snapshot(*args):
            events.append("cpu-after")
            return after

        def audits(*args):
            events.append("four-node-audit-validation")
            return views

        def capture(*args, **kwargs):
            events.append("metrics-after")

        with patch.object(workload, "wait_for_crossed_audit_signal", side_effect=wait_for_signal), \
                patch.object(workload, "validator_cpu_snapshot", side_effect=cpu_snapshot), \
                patch.object(workload, "capture_workload_metrics", side_effect=capture), \
                patch.object(workload, "validator_cpu_delta", return_value={"cpu": "delta"}):
            crossed, crossed_views = workload.close_cross_audit_measurement(
                lifecycle, audits, providers, "0", expected, 100, [4, 5], 500, before, 299)

        self.assertEqual(events, ["event-signal-and-all-node-fence"] * 2 + ["cpu-after"] +
                                 ["four-node-audit-validation"] * 2 + ["metrics-after"])
        self.assertEqual([row["height"] for row in crossed], [303, 403])
        self.assertEqual(crossed_views, {4: views, 5: views})
        window = lifecycle.doc["native_v3_cross_audit"]["measured_window"]
        self.assertEqual(window["crossed_audit_completion_heights"], [303, 403])
        self.assertEqual(window["proof_phase_end_height"], 299)
        self.assertIn("crossed-audit completion", window["scope"])

    def test_crossed_audit_signal_uses_production_block_events_and_bounded_fence(self):
        provider = AUDIT_ADDRESSES[0]
        providers = {0: provider}
        expected = {provider: 1}
        event = {"type": "prove_liveness", "attributes": [
            {"key": "provider", "value": provider},
            {"key": "deal_id", "value": "0"},
            {"key": "challenge_kind", "value": "2"},
            {"key": "challenge_ordinal", "value": "0"},
            {"key": "tier", "value": "gold"},
            {"key": "reward_amount", "value": "1stake"},
        ]}
        block_results = {"height": "301", "txs_results": [
            {"code": "0", "gas_wanted": "2000000", "gas_used": "613056",
             "events": [event]},
        ]}
        original_deadline = artifact.monotonic_ns() + 60 * 10**9
        lifecycle = SimpleNamespace(deadline=original_deadline, chain="chain",
            nodes=[{"node_id": "node0"}])

        def query(node, path):
            self.assertLess(lifecycle.deadline, original_deadline)
            if path == "/status":
                return {"node_info": {"id": "node0", "network": "chain"},
                        "sync_info": {"latest_block_height": "301"}}
            self.assertEqual(path, "/block_results?height=301")
            return block_results

        def wait_height(height):
            self.assertEqual(height, 301)
            self.assertLess(lifecycle.deadline, original_deadline)
            return 302

        lifecycle.query = Mock(side_effect=query)
        lifecycle.wait_height = Mock(side_effect=wait_height)
        lifecycle.remaining = lambda: max(0, (lifecycle.deadline - artifact.monotonic_ns()) / 1e9)
        result = workload.wait_for_crossed_audit_signal(
            lifecycle, providers, "0", expected, 100, 4, 500)
        self.assertEqual(result["height"], 302)
        self.assertEqual(result["signal_height"], 301)
        self.assertEqual(result["accepted_events"], 1)
        self.assertEqual(lifecycle.deadline, original_deadline)

        def fail_fence(height):
            self.assertLess(lifecycle.deadline, original_deadline)
            raise TimeoutError("bounded all-node fence")

        lifecycle.wait_height.side_effect = fail_fence
        with self.assertRaisesRegex(TimeoutError, "bounded all-node fence"):
            workload.wait_for_crossed_audit_signal(
                lifecycle, providers, "0", expected, 100, 4, 500)
        self.assertEqual(lifecycle.deadline, original_deadline)

        failed = copy.deepcopy(block_results)
        failed["txs_results"][0]["code"] = "7"
        self.assertEqual(workload.crossed_audit_events(
            failed, 301, providers, "0", expected), set())
        for index, value in ((0, AUDIT_ADDRESSES[1]), (1, "1"), (2, "1")):
            wrong_identity = copy.deepcopy(block_results)
            wrong_identity["txs_results"][0]["events"][0]["attributes"][index]["value"] = value
            with self.subTest(attribute=index):
                self.assertEqual(workload.crossed_audit_events(
                    wrong_identity, 301, providers, "0", expected), set())
        out_of_range = copy.deepcopy(block_results)
        out_of_range["txs_results"][0]["events"][0]["attributes"][3]["value"] = "1"
        with self.assertRaisesRegex(ValueError, "out-of-range ordinal"):
            workload.crossed_audit_events(out_of_range, 301, providers, "0", expected)
        duplicate = copy.deepcopy(block_results)
        duplicate["txs_results"][0]["events"].append(copy.deepcopy(event))
        self.assertEqual(len(workload.crossed_audit_events(
            duplicate, 301, providers, "0", expected)), 1)
        repeated_attribute = copy.deepcopy(block_results)
        repeated_attribute["txs_results"][0]["events"][0]["attributes"].append(
            {"key": "provider", "value": provider})
        with self.assertRaisesRegex(ValueError, "repeats an event attribute"):
            workload.crossed_audit_events(
                repeated_attribute, 301, providers, "0", expected)

    def test_cross_audit_start_fence_follows_metrics_and_target_wait(self):
        events = []
        lifecycle = SimpleNamespace()

        def capture(*args, **kwargs):
            events.append("metrics-before")

        def wait_height(minimum):
            events.append(f"wait-{minimum}")
            return 271 if minimum == 271 else 272

        def cpu_snapshot(*args):
            events.append("cpu-before")
            return {"monotonic_ns": 10, "validators": []}

        lifecycle.wait_height = Mock(side_effect=wait_height)
        with patch.object(workload, "capture_workload_metrics", side_effect=capture), \
                patch.object(workload, "validator_cpu_snapshot", side_effect=cpu_snapshot):
            before, height = workload.open_cross_audit_measurement(lifecycle, 271)
        self.assertEqual((before["monotonic_ns"], height), (10, 272))
        self.assertEqual(events, ["metrics-before", "wait-271", "cpu-before", "wait-1"])

        lifecycle.wait_height = Mock(side_effect=[271, 273])
        with patch.object(workload, "capture_workload_metrics"), \
                patch.object(workload, "validator_cpu_snapshot", return_value=before), \
                self.assertRaisesRegex(ValueError, "fixed anchor alignment"):
            workload.open_cross_audit_measurement(lifecycle, 271)

    def test_cross_audit_receipt_fence_uses_provider_rpc_tip(self):
        node = {"node": "unused", "node_id": "provider-rpc"}
        status = {"node_info": {"id": "provider-rpc", "network": "chain"},
                  "sync_info": {"latest_block_height": "219"}}

        def wait_height(minimum):
            # The old wait_height(1) cutoff could observe the lagging tip 218.
            return 218 if minimum == 1 else minimum

        lifecycle = SimpleNamespace(nodes=[node], chain="chain", query=Mock(return_value=status),
                                    wait_height=Mock(side_effect=wait_height))
        fence = workload.fence_v3_http_receipts(lifecycle)
        self.assertEqual(fence, {"provider_rpc_node_id": "provider-rpc",
            "provider_rpc_observed_height": 219, "all_validator_height": 219})
        lifecycle.wait_height.assert_called_once_with(219)
        self.assertEqual(workload.validate_v3_http_receipt_fence(
            [{"height": "217"}, {"height": 219}], fence), 219)
        with self.assertRaisesRegex(ValueError, "outside its fenced phase"):
            workload.validate_v3_http_receipt_fence([{"height": "220"}], fence)

        lifecycle.query.return_value = copy.deepcopy(status)
        lifecycle.query.return_value["node_info"]["id"] = "other-node"
        with self.assertRaisesRegex(ValueError, "different node or chain"):
            workload.fence_v3_http_receipts(lifecycle)

    def test_cross_audit_cpu_fence_is_not_closed_after_audit_failure(self):
        lifecycle = SimpleNamespace(doc={"native_v3_cross_audit": {}})
        with patch.object(workload, "wait_for_crossed_audit_signal", side_effect=TimeoutError("delayed audit")), \
                patch.object(workload, "validator_cpu_snapshot") as cpu_snapshot, \
                patch.object(workload, "capture_workload_metrics") as capture, \
                self.assertRaisesRegex(TimeoutError, "delayed audit"):
            workload.close_cross_audit_measurement(
                lifecycle, Mock(), {0: AUDIT_ADDRESSES[0]}, "0", {AUDIT_ADDRESSES[0]: 1},
                100, [4, 5], 500, {"monotonic_ns": 10}, 299)
        cpu_snapshot.assert_not_called()
        capture.assert_not_called()
        self.assertNotIn("measured_window", lifecycle.doc["native_v3_cross_audit"])

    def test_cross_audit_post_load_state_freezes_before_slow_receipt_decoding(self):
        events = []
        latest = [250]
        providers = {0: AUDIT_ADDRESSES[0]}
        views = {epoch: {0: {"audit": {"sample_count": "1", "accepted_count": "1"}}}
                 for epoch in (2, 3)}
        lifecycle = SimpleNamespace(doc={"native_v3_cross_audit": {}}, save=Mock())

        def quiescence(_lifecycle, _providers):
            events.append(("quiescence", latest[0]))
            return {"second_height": latest[0], "sequences": {}}

        def audits(height, final, epoch):
            events.append(("audits", height, final, epoch))
            return views[epoch]

        with patch.object(workload, "require_provider_quiescence", side_effect=quiescence):
            post, height, final = workload.freeze_cross_audit_post_load(
                lifecycle, audits, providers, 1, [2, 3], 100, views)
            # The historical RPC/CLI receipt loop is outside the load window and may be slow.
            # Advancing the live tip must not change the already-frozen query height or audits.
            for _ in range(workload.V3_CROSS_AUDIT_MEASURED):
                latest[0] += 1

        self.assertEqual(events, [("quiescence", 250), ("audits", 250, False, 2),
                                  ("audits", 250, False, 3)])
        self.assertEqual((height, post["second_height"], final), (250, 250, views))
        self.assertEqual(lifecycle.doc["native_v3_cross_audit"]["post_load_fence"],
            {"height": 250, "provider_quiescence": post, "audits": views})
        lifecycle.save.assert_called_once_with()

    def test_cross_audit_transaction_classification_binds_committed_system_proof(self):
        providers = dict(enumerate(AUDIT_ADDRESSES))
        raw = b"production-shaped-crossed-audit-transaction"
        txhash = hashlib.sha256(raw).hexdigest().upper()
        message = {"@type": "/polystorechain.polystorechain.v1.MsgProveLiveness",
                   "creator": providers[3], "deal_id": "7", "epoch_id": "4",
                   "system_proof": {"mdu_index": "2"}}
        decoded = dict(txhash=txhash, height="301", tx={"body": {"messages": [message]}})
        block = {"block_id": {"hash": "CD" * 32}, "block": {
            "header": {"height": "301", "chain_id": "chain", "time": "time", "app_hash": "EF" * 32},
            "data": {"txs": [base64.b64encode(raw).decode()]}}}
        block_results = {"height": "301", "txs_results": [{
            "code": "0", "gas_wanted": "10", "gas_used": "9"}]}
        commit = {"canonical": True, "signed_header": {"header": block["block"]["header"],
            "commit": {"height": "301", "block_id": block["block_id"]}}}
        def query(node, path):
            if path.startswith("/block_results"):
                return block_results
            if path.startswith("/block?"):
                return block
            if path.startswith("/commit?"):
                return commit
            raise AssertionError(path)
        with tempfile.TemporaryDirectory() as home:
            lifecycle = SimpleNamespace(home=Path(home), chain="chain",
                nodes=[{"home": "/home", "node_id": str(index)} for index in range(4)],
                cli=Mock(return_value=json.dumps(decoded)), query=query,
                wait_height=Mock(return_value=302), remaining=Mock(), doc={})
            rows = []
            def observe(transaction, height):
                rows.append(workload.classify_cross_audit_transaction(
                    lifecycle, transaction, height, providers, "7", 4))
            workload.reconcile_transaction_blocks(
                lifecycle, [], 301, 301, Path(home) / "blocks.jsonl",
                observe_transaction=observe)
            lifecycle.wait_height.assert_called_once_with(302)
            self.assertEqual((rows[0]["provider"], rows[0]["slot"], rows[0]["txhash"], rows[0]["height"]),
                             (providers[3], 3, txhash, 301))
            lifecycle.cli.return_value = json.dumps(dict(decoded, height="302"))
            with self.assertRaisesRegex(ValueError, "identity differs"):
                workload.classify_cross_audit_transaction(
                    lifecycle, rows[0], 301, providers, "7", 4)
            message["session_proof"] = {}
            lifecycle.cli.return_value = json.dumps(decoded)
            with self.assertRaisesRegex(ValueError, "not a successful"):
                workload.classify_cross_audit_transaction(
                    lifecycle, rows[0], 301, providers, "7", 4)

    def test_native_chain_summary_excludes_warmup_from_measured_counts(self):
        sessions = [dict(accepted_sample_ordinals=[0, 1]),
                    dict(accepted_sample_ordinals=[2, 3, 4])]
        messages = [dict(id="warmup", session_index=0, ordinals=[0, 1]),
                    dict(id="measured", session_index=1, ordinals=[2, 3, 4])]
        summary = workload.native_v3_chain_committed_summary(
            sessions, messages, [dict(id="warmup")], [dict(id="measured")])
        self.assertEqual(summary, dict(total_committed_valid_proof_transactions=2,
            measured_committed_valid_proof_transactions=1,
            total_authoritative_new_sample_ordinals=5,
            measured_authoritative_new_sample_ordinals=3))
        with self.assertRaisesRegex(ValueError, "messages differ"):
            workload.native_v3_chain_committed_summary(
                sessions, messages, [dict(id="warmup")], [dict(id="other")])

    def test_native_chain_inventory_assembles_all_exported_provider_messages(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            providers = dict(enumerate(AUDIT_ADDRESSES[:8]))
            sessions = []
            for index in range(9):
                sessions.append(dict(session_id=f"{index + 1:064x}", evidence_height=70,
                    before_proofs={"session": {"obligations": [{"slot": slot} for slot in range(8)]}},
                    context_hash=f"{index + 9:064x}", seed=f"{index + 17:064x}"))
            directories = {}
            for provider in providers.values():
                directories[provider] = home / provider
                directories[provider].mkdir()
            lifecycle = SimpleNamespace(home=home, chain="polystore_290-1",
                env={"POLYSTORE_TRUSTED_SETUP": "/setup"},
                deadline=artifact.monotonic_ns() + 30 * 10**9)

            def export(argv, deadline, env):
                manifest_path = Path(env["POLYSTORE_RETRIEVAL_EXPORT_MANIFEST"])
                manifest = json.loads(manifest_path.read_text())
                provider = manifest["v3_provider"]
                slot = next(index for index, address in providers.items() if address == provider)
                rows = []
                self.assertLessEqual(len(manifest["v3_sessions"]), 8)
                for request in manifest["v3_sessions"]:
                    self.assertNotIn("session_index", request)
                    index = int(request["session_id"], 16) - 1
                    message_path = Path(request["output_path"])
                    message = dict(creator=provider,
                        session_id=base64.b64encode(bytes.fromhex(request["session_id"])).decode(),
                        slot=str(slot), proofs=[dict(ordinal=str(slot), proof=dict(
                            manifest_opening=base64.b64encode(bytes([1]) * 48).decode(),
                            root_table_du_commitment=base64.b64encode(bytes([2]) * 48).decode(),
                            blob_commitment=base64.b64encode(bytes([3]) * 48).decode(),
                            kzg_opening_proof=base64.b64encode(bytes([4]) * 48).decode()))])
                    raw = json.dumps(message, separators=(",", ":")).encode()
                    message_path.write_bytes(raw)
                    rows.append(dict(session_id=request["session_id"], message_path=str(message_path),
                        message_sha256=hashlib.sha256(raw).hexdigest(),
                        context_hash=sessions[index]["context_hash"], seed=sessions[index]["seed"],
                        slot=slot, ordinals=[slot], generation_ms=1.0))
                Path(str(manifest_path) + ".result.json").write_text(json.dumps({"messages": rows}))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            with patch.object(artifact, "run_bounded_command", side_effect=export):
                inventory = workload.export_native_v3_chain_inventory(
                    lifecycle, Path("/exporter"), sessions, providers, directories)
            self.assertEqual(len(inventory["manifests"]), 16)
            self.assertEqual(len(inventory["messages"]), 72)
            self.assertEqual([(row["session_index"], row["slot"]) for row in inventory["messages"]],
                             [(session, slot) for session in range(9) for slot in range(8)])
            self.assertEqual([row["provider"] for row in inventory["messages"][:8]],
                             list(providers.values()))

    def test_native_chain_inventory_rejects_identity_commitment_or_opening(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            providers = dict(enumerate(AUDIT_ADDRESSES[:8]))
            provider = providers[0]
            directories = {}
            for address in providers.values():
                directories[address] = home / address
                directories[address].mkdir()
            lifecycle = SimpleNamespace(home=home, chain="polystore_290-1",
                env={"POLYSTORE_TRUSTED_SETUP": "/setup"},
                deadline=artifact.monotonic_ns() + 30 * 10**9)
            session = dict(session_id=f"{1:064x}", evidence_height=70,
                before_proofs={"session": {"obligations": [{"slot": 0}]}},
                context_hash=f"{9:064x}", seed=f"{17:064x}")

            for field, identity in (("manifest_opening", bytes(48)),
                                    ("root_table_du_commitment", b"\xc0" + bytes(47)),
                                    ("blob_commitment", bytes(48)),
                                    ("kzg_opening_proof", b"\xc0" + bytes(47))):
                def export(argv, deadline, env, field=field, identity=identity):
                    manifest_path = Path(env["POLYSTORE_RETRIEVAL_EXPORT_MANIFEST"])
                    request = json.loads(manifest_path.read_text())["v3_sessions"][0]
                    chained = {name: base64.b64encode(bytes([index + 1]) * 48).decode()
                               for index, name in enumerate(("manifest_opening",
                                   "root_table_du_commitment", "blob_commitment",
                                   "kzg_opening_proof"))}
                    chained[field] = base64.b64encode(identity).decode()
                    message = dict(creator=provider,
                        session_id=base64.b64encode(bytes.fromhex(request["session_id"])).decode(),
                        slot="0", proofs=[dict(ordinal="0", proof=chained)])
                    raw = json.dumps(message, separators=(",", ":")).encode()
                    message_path = Path(request["output_path"])
                    message_path.write_bytes(raw)
                    result = dict(messages=[dict(session_id=request["session_id"],
                        message_path=str(message_path),
                        message_sha256=hashlib.sha256(raw).hexdigest(),
                        context_hash=session["context_hash"], seed=session["seed"],
                        slot=0, ordinals=[0], generation_ms=1.0)])
                    Path(str(manifest_path) + ".result.json").write_text(json.dumps(result))
                    return SimpleNamespace(returncode=0, stdout="", stderr="")

                with self.subTest(field=field), patch.object(
                        artifact, "run_bounded_command", side_effect=export), \
                        self.assertRaisesRegex(ValueError, "identity " + field):
                    workload.export_native_v3_chain_inventory(lifecycle, Path("/exporter"),
                        [session], providers, directories)
                for path in home.glob("native-v3-chain-inventory*"):
                    if path.is_dir():
                        shutil.rmtree(path)

    def test_native_chain_exporter_identity_records_exact_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            exporter = Path(tmp) / "exporter"
            exporter.write_bytes(b"native-v3-exporter")
            exporter.chmod(0o700)
            resolved, identity = workload.native_v3_chain_exporter_identity(exporter)
            self.assertEqual(resolved, exporter.resolve())
            self.assertEqual(identity, dict(native_chain_exporter=str(exporter.resolve()),
                native_chain_exporter_sha256=hashlib.sha256(exporter.read_bytes()).hexdigest()))

    def test_generate_only_preflight_pins_exact_default_emitting_message_and_explicit_gas(self):
        message = dict(creator=AUDIT_ADDRESSES[0], session_id=base64.b64encode(bytes.fromhex(self.SESSION)).decode(),
                       slot=0, proofs=[dict(ordinal="0", proof=dict(mdu_index="0", blob_index="0"))])
        unsigned = dict(body=dict(messages=[dict(**{"@type": "/polystorechain.polystorechain.v1.MsgSubmitRetrievalSessionProofV3"}, **message)]),
                        auth_info=dict(fee=dict(gas_limit="13530000")))
        life = SimpleNamespace(binary=Path("/chain"), chain="polystore_290-1", deadline=10**18,
            nodes=[dict(home="/home", rpc=26657)], env={"GOMAXPROCS": "2"},
            signers={"provider0": AUDIT_ADDRESSES[0]})
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "message.json"
            path.write_text(json.dumps(message))
            result = SimpleNamespace(returncode=0, stdout=json.dumps(unsigned), stderr="")
            with patch.object(artifact, "run_bounded_command", return_value=result) as run:
                job, evidence = workload.v3_generate_only_gas(life, path, AUDIT_ADDRESSES[0])
            diagnostic = json.loads(Path(evidence["simulation_diagnostic"]).read_text())
            self.assertEqual((diagnostic["returncode"], diagnostic["simulation_key"]), (0, "provider0"))
            self.assertEqual((diagnostic["attempts"], evidence["simulation_attempts"]), (1, 1))
            self.assertEqual(evidence["gas_limit"], 13_530_000)
            self.assertEqual(job["submit"][job["submit"].index("--gas") + 1], "13530000")
            self.assertEqual(run.call_args.args[0][-1], "--generate-only")
            self.assertEqual(run.call_args.args[0][run.call_args.args[0].index("--from") + 1], "provider0")
            self.assertEqual(run.call_args.args[0][run.call_args.args[0].index("--gas-adjustment") + 1], "1.6")
            self.assertEqual(job["submit"][job["submit"].index("--from") + 1], AUDIT_ADDRESSES[0])
            adjusted_path = Path(tmp) / "adjusted.json"
            adjusted_path.write_text(json.dumps(message))
            with patch.object(artifact, "run_bounded_command", return_value=result) as adjusted_run:
                workload.v3_generate_only_gas(life, adjusted_path, AUDIT_ADDRESSES[0], gas_adjustment="1.1")
            adjusted_argv = adjusted_run.call_args.args[0]
            self.assertEqual(adjusted_argv[adjusted_argv.index("--gas-adjustment") + 1], "1.1")
            with self.assertRaisesRegex(ValueError, "outside the benchmark matrix"):
                workload.v3_generate_only_gas(life, Path(tmp) / "missing.json", AUDIT_ADDRESSES[0],
                                              gas_adjustment="1.05")
            changed = copy.deepcopy(unsigned)
            changed["body"]["messages"][0]["slot"] = 1
            changed_path = Path(tmp) / "changed.json"
            changed_path.write_text(json.dumps(message))
            with patch.object(artifact, "run_bounded_command", return_value=SimpleNamespace(
                    returncode=0, stdout=json.dumps(changed), stderr="")), self.assertRaisesRegex(ValueError, "differs"):
                workload.v3_generate_only_gas(life, changed_path, AUDIT_ADDRESSES[0])

            failed_path = Path(tmp) / "failed.json"
            failed_path.write_text(json.dumps(message))
            failed = SimpleNamespace(returncode=1, stdout="partial output", stderr="simulation rejected")
            with patch.object(artifact, "run_bounded_command", return_value=failed), \
                 self.assertRaisesRegex(ValueError, "bounded v3 gas simulation failed"):
                workload.v3_generate_only_gas(life, failed_path, AUDIT_ADDRESSES[0])
            diagnostic = json.loads(Path(str(failed_path) + ".gas-simulation.json").read_text())
            self.assertEqual((diagnostic["returncode"], diagnostic["simulation_key"]), (1, "provider0"))
            self.assertEqual(diagnostic["stdout_tail"], "partial output")
            self.assertEqual(diagnostic["stderr_tail"], "simulation rejected")
            self.assertEqual(diagnostic["stdout_bytes"], len(b"partial output"))
            self.assertEqual(diagnostic["stderr_bytes"], len(b"simulation rejected"))

            retry_path = Path(tmp) / "retry.json"
            retry_path.write_text(json.dumps(message))
            stale = SimpleNamespace(returncode=1, stdout="", stderr="account sequence mismatch, expected 6, got 5")
            with patch.object(artifact, "run_bounded_command", side_effect=[stale, result]) as run, \
                 patch.object(workload.time, "sleep") as sleep:
                _, retry_evidence = workload.v3_generate_only_gas(life, retry_path, AUDIT_ADDRESSES[0])
            self.assertEqual((run.call_count, sleep.call_count, retry_evidence["simulation_attempts"]), (2, 1, 2))

    def test_native_chain_freeze_encodes_provider_transactions_in_parallel(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            providers = dict(enumerate(AUDIT_ADDRESSES[:8]))
            lifecycle = SimpleNamespace(home=home, binary=Path("/chain"), chain="polystore_290-1",
                nodes=[{"home": "/validator"}],
                signers={f"provider{slot}": address for slot, address in providers.items()})
            simulated = []
            for slot, provider in providers.items():
                unsigned = home / f"unsigned-{slot}.json"
                unsigned.write_text(json.dumps({"body": {"messages": [{"slot": slot}]},
                                                "auth_info": {"fee": {"gas_limit": "904801"}}}) + "\n")
                message_path = home / f"message-{slot}.json"
                message_path.write_text("{}")
                simulated.append((dict(id=f"tx-{slot}", profile="1kib", session_index=slot,
                    slot=slot, provider=provider, ordinals=[0], message_path=str(message_path),
                    message_sha256=artifact.sha256(message_path)), None,
                    dict(unsigned_path=str(unsigned), gas_limit=904_801)))
            calls = []
            sign_barrier = threading.Barrier(8)

            def command(argv, _timeout):
                calls.append(argv)
                if argv[2] == "sign-batch":
                    source = Path(argv[3])
                    output = Path(argv[argv.index("--output-document") + 1])
                    sequence = int(argv[argv.index("--sequence") + 1])
                    rows = []
                    for index, line in enumerate(source.read_text().splitlines()):
                        row = json.loads(line)
                        row.update(signatures=["signature"], auth_info={"signer_infos": [
                            {"sequence": str(sequence + index)}], "fee": row["auth_info"]["fee"]})
                        rows.append(json.dumps(row, separators=(",", ":")))
                    output.write_text("\n".join(rows) + "\n")
                    sign_barrier.wait(timeout=5)
                    return ""
                if argv[2] == "encode":
                    slot = json.loads(Path(argv[3]).read_text())["body"]["messages"][0]["slot"]
                    return base64.b64encode(f"raw-{slot}".encode()).decode() + "\n"
                raise AssertionError(f"unexpected per-transaction command: {argv}")

            sequences = {provider: {"account_number": slot + 20, "sequence": slot + 3}
                         for slot, provider in providers.items()}
            profile = {"name": "1kib", "submission_mode": "separate", "batch_size": 1}
            messages = [row[0] for row in simulated]
            intents = workload.build_native_v3_transaction_intents(messages, profile, home / "intents")
            frozen = workload.freeze_native_v3_transactions(
                lifecycle, intents, {row[0]["id"]: row[2] for row in simulated}, [profile],
                providers, sequences, command)
            self.assertEqual(sum(row[2] == "sign-batch" for row in calls), 8)
            self.assertEqual(sum(row[2] == "encode" for row in calls), 8)
            self.assertEqual(sum(row[2] == "encode-batch" for row in calls), 0)
            self.assertEqual([Path(row["raw_path"]).read_bytes() for row in frozen],
                             [f"raw-{slot}".encode() for slot in range(8)])
            self.assertEqual([row["sequence"] for row in frozen], [slot + 3 for slot in range(8)])



class HealthyAuditViewsTest(unittest.TestCase):
    def test_native_v3_browser_cli_is_explicit_and_keeps_other_modes_unchanged(self):
        common = ["diagnostic", "--mode", "native-v3-browser", "--binary", "/chain",
                  "--library", "/lib", "--home", "/new-home", "--gateway-binary", "/gateway",
                  "--cli-binary", "/native-cli", "--product-source", "/source"]
        for extra, expected_browser in (([], {"file_bytes": 1024}),
                (["--browser-bytes", "1073741824"], {"file_bytes": 1_073_741_824}),
                (["--browser-bytes", "1073741824", "--browser-executor-handoff"],
                 {"file_bytes": 1_073_741_824, "executor_handoff": True})):
            with self.subTest(expected_browser=expected_browser), patch.object(workload.sys, "argv", common + extra), \
                 patch.object(artifact, "FourValidatorLifecycle") as constructor, \
                 patch.object(workload, "run_healthy", return_value="evidence") as run, patch("builtins.print"):
                workload.main()
                constructor.assert_called_once_with(binary="/chain", library="/lib", home="/new-home",
                    timeout=600, browser_evm=True)
                run.assert_called_once_with(constructor.return_value, "/gateway", "/native-cli", "/source",
                    native_browser=expected_browser, audit_profile="normal")
        invalid = ["diagnostic", "--mode", "native-v3-providers", "--binary", "/chain",
                   "--library", "/lib", "--home", "/new-home", "--gateway-binary", "/gateway",
                   "--cli-binary", "/native-cli", "--product-source", "/source",
                   "--browser-bytes", "1024"]
        with patch.object(workload.sys, "argv", invalid), patch.object(workload.sys, "stderr"), \
             patch.object(artifact, "FourValidatorLifecycle") as constructor, self.assertRaises(SystemExit):
            workload.main()
        constructor.assert_not_called()
        for size in ("1024", "16777217"):
            with self.subTest(handoff_size=size), patch.object(workload.sys, "argv",
                    common + ["--browser-bytes", size, "--browser-executor-handoff"]), \
                 patch.object(workload.sys, "stderr"), \
                 patch.object(artifact, "FourValidatorLifecycle") as constructor, \
                 self.assertRaises(SystemExit):
                workload.main()
            constructor.assert_not_called()

    def test_native_v3_cross_audit_cli_is_fixed_bounded_and_normal_audit_only(self):
        common = ["diagnostic", "--mode", "native-v3-providers-cross-audit", "--binary", "/chain",
                  "--library", "/lib", "--home", "/new-home"]
        required = ["--gateway-binary", "/gateway", "--cli-binary", "/native-cli", "--product-source", "/source"]
        for extra in ([], required + ["--timeout", "901"], required + ["--audit-profile", "c6"],
                      required + ["--proof-only"]):
            with self.subTest(extra=extra), patch.object(workload.sys, "argv", common + extra), \
                 patch.object(workload.sys, "stderr"), patch.object(artifact, "FourValidatorLifecycle") as constructor:
                with self.assertRaises(SystemExit) as error:
                    workload.main()
                self.assertEqual(error.exception.code, 2)
                constructor.assert_not_called()
        with patch.object(workload.sys, "argv", common + required + ["--timeout", "900"]), \
             patch.object(artifact, "FourValidatorLifecycle") as constructor, \
             patch.object(workload, "run_healthy", return_value="evidence") as run, patch("builtins.print"):
            workload.main()
            run.assert_called_once_with(constructor.return_value, "/gateway", "/native-cli", "/source",
                                        native_cross_audit=True, audit_profile="normal")

    def test_native_v3_chain_cli_requires_exporter_and_fixed_profile(self):
        common = ["diagnostic", "--mode", "native-v3-chain", "--binary", "/chain",
                  "--library", "/lib", "--home", "/new-home"]
        required = ["--gateway-binary", "/gateway", "--cli-binary", "/native-cli",
                    "--product-source", "/source", "--proof-exporter", "/exporter"]
        for extra in ([], required + ["--proof-gas", "100"], required + ["--audit-profile", "c6"],
                      required + ["--timeout", "3601"]):
            with self.subTest(extra=extra), patch.object(workload.sys, "argv", common + extra), \
                 patch.object(workload.sys, "stderr"), patch.object(artifact, "FourValidatorLifecycle") as constructor:
                with self.assertRaises(SystemExit):
                    workload.main()
                constructor.assert_not_called()
        with patch.object(workload.sys, "argv", common + required), \
             patch.object(artifact, "FourValidatorLifecycle") as constructor, \
             patch.object(workload, "run_healthy", return_value="evidence") as run, patch("builtins.print"):
            workload.main()
            constructor.assert_called_once_with(binary="/chain", library="/lib", home="/new-home",
                                                timeout=3600, sustained=True)
            run.assert_called_once_with(constructor.return_value, "/gateway", "/native-cli", "/source",
                                        native_chain=dict(exporter="/exporter"), audit_profile="normal")
        sweep = required + ["--chain-max-gas", "448000000", "--chain-capacity-profile", "1kib",
                            "--chain-capacity-transactions", "4992"]
        with patch.object(workload.sys, "argv", common + sweep), \
             patch.object(artifact, "FourValidatorLifecycle") as constructor, \
             patch.object(workload, "run_healthy", return_value="evidence") as run, patch("builtins.print"):
            workload.main()
            run.assert_called_once_with(constructor.return_value, "/gateway", "/native-cli", "/source",
                native_chain=dict(exporter="/exporter", max_block_gas=448_000_000,
                                  profile="1kib", measured_transactions=4992), audit_profile="normal")
        for profile in ("1kib", "eight-blobs"):
            invalid = required + ["--chain-max-gas", "448000000", "--chain-capacity-profile", profile,
                                  "--chain-capacity-transactions", "4991"]
            with self.subTest(profile=profile), patch.object(workload.sys, "argv", common + invalid), \
                 patch.object(workload.sys, "stderr"), \
                 patch.object(artifact, "FourValidatorLifecycle") as constructor, \
                 self.assertRaises(SystemExit):
                workload.main()
            constructor.assert_not_called()
        impossible = required + ["--chain-max-gas", "448000000", "--chain-capacity-profile", "sample-cap",
                                 "--chain-capacity-transactions", "4992"]
        undersized = required + ["--chain-max-gas", "448000000", "--chain-capacity-profile", "1kib",
                                 "--chain-capacity-transactions", "4944"]
        overhead = required + ["--chain-max-gas", "64000000", "--chain-capacity-profile", "1kib",
                               "--chain-capacity-transactions", "4992"]
        for rejected in (impossible, undersized, overhead):
            with patch.object(workload.sys, "argv", common + rejected), \
                 patch.object(workload.sys, "stderr"), \
                 patch.object(artifact, "FourValidatorLifecycle") as constructor, \
                 self.assertRaises(SystemExit):
                workload.main()
            constructor.assert_not_called()

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

    def fixture(self, *, complete=True, counts=None, k=2, user_mdus=1):
        layout = workload.mode2_layout(k)
        counts = (1, 9, 32) if counts is None and k == 2 else counts or (1,) * layout["assignments"]
        deal = dict(id="7", manifest_root=base64.b64encode(bytes([7]) * 32).decode(),
                    current_gen="1", start_block="5", end_block="1000")
        providers = dict(enumerate(AUDIT_ADDRESSES[:layout["assignments"]]))
        values = []
        for slot, count in enumerate(counts):
            accepted = count if complete else 0
            snapshot = dict(chain_id="polystore_260-1", generation="1", layout=2, k=k, m=layout["m"],
                            slot=slot, metadata_mdus="2", user_mdus=str(user_mdus), deal_end="1000",
                            setup_digest=base64.b64encode(bytes.fromhex(producer.SETUP_DIGEST)).decode())
            context = dict(version=2, chain_id="polystore_260-1", setup_digest=producer.SETUP_DIGEST,
                kind=2, context_id="00"*32, deal_id=7, generation=1, root="07"*32,
                assigned=producer.account(providers[slot]).hex(), payee=producer.account(providers[slot]).hex(),
                layout=2, k=k, m=layout["m"], slot=slot, metadata_mdus=2, user_mdus=user_mdus, start_mdu=0, start_leaf=0,
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

    def test_general_fixture_freezes_cold_quota_when_hot_and_cold_differ(self):
        params = dict(quota_min_blobs="1", quota_max_blobs="64",
                      quota_bps_per_epoch_hot="100", quota_bps_per_epoch_cold="50")
        self.assertEqual(workload.frozen_audit_quota(params, 1064, params["quota_bps_per_epoch_cold"]), 6)
        self.assertEqual(workload.frozen_audit_quota(params, 1064, params["quota_bps_per_epoch_hot"]), 11)
        values, deal, providers = self.fixture(k=8, counts=(6,) * 12, user_mdus=133)
        workload.healthy_audit_views(values, deal, providers, 2, 100, "polystore_260-1",
                                     finalized=True, expected_samples=6, k=8, user_mdus=133)
        with self.assertRaisesRegex(ValueError, "sample count"):
            workload.healthy_audit_views(values, deal, providers, 2, 100, "polystore_260-1",
                                         finalized=True, expected_samples=11, k=8, user_mdus=133)

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


class NativeV3BatchCapacityHarnessTest(unittest.TestCase):
    def _messages(self, directory, count=16):
        provider = AUDIT_ADDRESSES[0]
        rows = []
        for index in range(count):
            path = Path(directory) / f"proof-{index}.json"
            message = {"creator": provider, "session_id": base64.b64encode(index.to_bytes(32, "big")).decode(),
                       "slot": "0", "proofs": [{"ordinal": "0", "proof": {}}]}
            path.write_text(json.dumps(message, separators=(",", ":")) + "\n")
            rows.append(dict(id=f"proof-{index}", profile="1kib", session_index=index * 8,
                slot=0, provider=provider, ordinals=[0], message_path=str(path),
                message_sha256=artifact.sha256(path)))
        return rows

    def test_batch_profiles_require_exact_small_provider_local_groups(self):
        for mode in ("serial-messages", "batch-message"):
            profile = workload.native_v3_chain_capacity_profiles("1kib", measured_sessions=4608,
                submission_mode=mode, batch_size=64)[0]
            self.assertEqual((profile["sessions"], profile["proof_messages"],
                              profile["measured_transactions"]), (4608, 4608, 72))
        for kwargs in (dict(submission_mode="separate", batch_size=8),
                       dict(submission_mode="batch-message", batch_size=1),
                       dict(submission_mode="batch-message", batch_size=64, measured_sessions=4097)):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                workload.native_v3_chain_capacity_profiles("1kib", **kwargs)

    def test_intents_keep_exact_provider_corpus_and_batch_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            messages = self._messages(tmp)
            profile = dict(name="1kib", submission_mode="batch-message", batch_size=8)
            intents = workload.build_native_v3_transaction_intents(messages, profile, Path(tmp) / "intents")
            self.assertEqual([len(row["members"]) for row in intents], [8, 8])
            value = json.loads(Path(intents[0]["message_path"]).read_text())
            self.assertEqual(value["creator"], AUDIT_ADDRESSES[0])
            self.assertEqual(len(value["sessions"]), 8)
            self.assertEqual([row["session_id"] for row in value["sessions"]],
                             [json.loads(Path(row["message_path"]).read_text())["session_id"]
                              for row in messages[:8]])
            messages[-1]["provider"] = AUDIT_ADDRESSES[1]
            with self.assertRaisesRegex(ValueError, "exact local batches"):
                workload.build_native_v3_transaction_intents(messages, profile, Path(tmp) / "bad")

    def test_serial_comparator_append_signs_ordered_existing_messages_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            messages = self._messages(tmp, 8)
            profile = dict(name="1kib", submission_mode="serial-messages", batch_size=8)
            intent = workload.build_native_v3_transaction_intents(messages, profile, home / "intents")[0]
            simulations = {}
            for index, row in enumerate(messages):
                source = json.loads(Path(row["message_path"]).read_text())
                source["padding"] = "x" * 70_000
                unsigned = home / f"unsigned-{index}.json"
                unsigned.write_text(json.dumps({"body": {"messages": [dict({"@type": workload.V3_SINGLE_PROOF_TYPE}, **source)]},
                    "auth_info": {"fee": {"gas_limit": "10"}}}, separators=(",", ":")) + "\n")
                simulations[row["id"]] = {"unsigned_path": str(unsigned), "gas_limit": 10}
            provider = AUDIT_ADDRESSES[0]
            lifecycle = SimpleNamespace(home=home, binary=Path("/chain"), chain="bench",
                nodes=[{"home": "/node"}], signers={f"provider{i}": address
                    for i, address in enumerate(AUDIT_ADDRESSES[:8])})
            calls = []
            def command(argv, timeout):
                calls.append(argv)
                if argv[2] == "sign-batch":
                    source = Path(argv[3])
                    txs = [json.loads(line) for line in source.read_text().splitlines()]
                    value = {"body": {"messages": [message for tx in txs for message in tx["body"]["messages"]]},
                        "auth_info": {"fee": {"gas_limit": str(sum(int(tx["auth_info"]["fee"]["gas_limit"]) for tx in txs))},
                                      "signer_infos": [{"sequence": "4"}]}, "signatures": ["signed"]}
                    Path(argv[argv.index("--output-document") + 1]).write_text(json.dumps(value))
                    return ""
                if argv[2] == "encode":
                    self.assertGreater(Path(argv[3]).stat().st_size, 64 * 1024)
                    return base64.b64encode(b"frozen-tx-0").decode() + "\n"
                raise AssertionError(f"unexpected command: {argv}")
            frozen = workload.freeze_native_v3_transactions(lifecycle, [intent], simulations, [profile],
                dict(enumerate(AUDIT_ADDRESSES[:8])),
                {provider: {"account_number": 3, "sequence": 4}}, command)
            self.assertEqual((len(frozen), frozen[0]["gas_limit"], len(frozen[0]["members"])), (1, 80, 8))
            sign = next(argv for argv in calls if argv[2] == "sign-batch")
            self.assertIn("--append", sign)

    def test_resource_summary_reports_host_and_aggregate_validator_usage(self):
        self.assertEqual(workload.parse_host_proc_stat("cpu  1 2 3 4 5 6 7 8\n")["idle_ticks"], 9)
        self.assertEqual(workload.parse_proc_memory("VmRSS: 12 kB\n", process=True)["VmRSS"], 12288)
        def sample(total, idle, cpu, rss):
            return {"host_cpu": {"total_ticks": total, "idle_ticks": idle},
                    "host_memory": {"MemTotal": 1000, "MemAvailable": 400},
                    "validators": [{"node_id": f"n{i}", "pid": i + 1, "starttime_ticks": 9,
                        "user_ticks": cpu, "system_ticks": 0, "rss_bytes": rss} for i in range(4)]}
        with patch.object(workload.os, "sysconf", return_value=100):
            result = workload.summarize_native_v3_resources([sample(100, 60, 10, 20),
                                                               sample(200, 80, 30, 25)], 2)
        self.assertAlmostEqual(result["host_average_cpu_fraction"], .8)
        self.assertAlmostEqual(result["aggregate_validator_average_cpu_cores"], .4)
        self.assertEqual(result["aggregate_validator_peak_rss_bytes"], 100)

    def test_batch_capacity_cli_passes_explicit_session_shape(self):
        argv = ["diagnostic", "--mode", "native-v3-chain", "--binary", "/chain",
            "--library", "/lib", "--home", "/new-home", "--gateway-binary", "/gateway",
            "--cli-binary", "/native-cli", "--product-source", "/source",
            "--proof-exporter", "/exporter", "--chain-max-gas", "128000000",
            "--chain-capacity-profile", "1kib", "--chain-capacity-sessions", "4608",
            "--chain-proof-submission-mode", "batch-message", "--chain-proof-batch-size", "64",
            "--chain-proof-gas-adjustment", "1.1", "--chain-timeout-commit-ms", "500"]
        with patch.object(workload.sys, "argv", argv), \
             patch.object(artifact, "FourValidatorLifecycle") as constructor, \
             patch.object(workload, "run_healthy", return_value="evidence") as run, patch("builtins.print"):
            workload.main()
        run.assert_called_once_with(constructor.return_value, "/gateway", "/native-cli", "/source",
            native_chain=dict(exporter="/exporter", max_block_gas=128_000_000, profile="1kib",
                measured_transactions=None, measured_sessions=4608,
                submission_mode="batch-message", batch_size=64, gas_adjustment="1.1"), audit_profile="normal")
        self.assertEqual(constructor.call_args.kwargs["consensus_timeout_commit_ms"], 500)

    def test_transaction_members_reject_duplicate_session_slot(self):
        members = [dict(session_index=1, slot=2, ordinals=[0]),
                   dict(session_index=1, slot=2, ordinals=[1])]
        with self.assertRaisesRegex(ValueError, "repeats"):
            workload.native_v3_transaction_members({"members": members})


if __name__ == "__main__":
    unittest.main()
