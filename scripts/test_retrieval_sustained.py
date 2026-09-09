"""Bounded sustained preparation contracts; no service startup."""
import base64
import copy
import json
from pathlib import Path
import tempfile
import sqlite3
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import retrieval_bench_artifact as artifact
import retrieval_four_validator_workload as workload
from test_retrieval_four_validator_workload import AUDIT_ADDRESSES, fixture_state
from test_bench_retrieval_sessions import OPEN_RESPONSE_DATA


class SustainedTest(unittest.TestCase):
    def test_native_layout_and_reported_denominators_cannot_drift(self):
        offsets = workload.sustained_offsets(4)
        expected = {
            2: dict(m=1, assignments=3, openings=32, bytes=4 * 1024 * 1024,
                    rates=[8.0, 16.0, 32, 64, 128]),
            8: dict(m=4, assignments=12, openings=8, bytes=1024 * 1024,
                    rates=[2.0, 4.0, 8, 16, 32]),
        }
        for k, want in expected.items():
            with self.subTest(k=k):
                layout = workload.mode2_layout(k)
                profile = workload.sustained_profile(k, 4, offsets, 20_000_000)
                self.assertEqual((layout["m"], layout["assignments"], layout["openings_per_bundle"],
                                  layout["bytes_per_bundle"]),
                                 (want["m"], want["assignments"], want["openings"], want["bytes"]))
                self.assertEqual(len(layout["deputy_indices"]), 8)
                self.assertFalse(set(layout["deputy_indices"]) & set(range(layout["assignments"])))
                self.assertEqual(layout["deputy_indices"], list(range(want["assignments"], want["assignments"] + 8)))
                self.assertEqual(profile["openings_per_bundle"], want["openings"])
                self.assertEqual(profile["proofs_per_session"], want["openings"])
                self.assertEqual(profile["offered_openings_per_second"], want["rates"])
                self.assertEqual(profile["proofs_per_session_unit"], "individual chained openings (legacy field name)")
                self.assertEqual(profile["warmup_openings"], 8 * want["openings"])
                self.assertEqual(profile["measured_openings"], 31 * want["openings"])
                self.assertEqual(profile["bundle_opening_distribution"], {str(want["openings"]): 39})
                self.assertEqual(profile["deputy_signer_indices"], layout["deputy_indices"])
                self.assertEqual(profile["provider_daemon_count"], want["assignments"])
                self.assertEqual(profile["provisioned_provider_signers"], max(12, want["assignments"] + 8))
                self.assertEqual(profile["proof_gas_limit_per_submission_transaction"], 20_000_000)
                self.assertEqual(profile["proof_gas_limit_per_opening"],
                                 dict(gas=20_000_000, openings=want["openings"]))
                self.assertEqual(profile["native_message_batching"]["proof_sessions_per_submission_transaction"], 1)
                self.assertFalse(profile["native_message_batching"]["cross_provider_crypto_aggregation"])
        for k in (0, 4, 16, True, "8"):
            with self.subTest(k=k), self.assertRaises(ValueError):
                workload.mode2_layout(k)

    def test_fixed_rates_and_pilot_are_absolute_and_bounded(self):
        for seconds, expected in ((4, 31), (180, 1395)):
            values = workload.sustained_offsets(seconds)
            self.assertEqual(len(values), expected)
            self.assertEqual(values, sorted(set(values)))
            self.assertEqual(values[0], 0)
            self.assertLess(values[-1], seconds * 5 * 10**9)
        for seconds in (0, 3, 181, True, 4.5):
            with self.assertRaises(ValueError):
                workload.sustained_offsets(seconds)

    def test_k8_operations_derive_full_row_fees_and_exporter_expectations(self):
        owner = AUDIT_ADDRESSES[0]
        life = SimpleNamespace(binary=Path("/chain"), chain="polystore_290-1",
            deadline=artifact.monotonic_ns() + 60 * 10**9,
            nodes=[dict(home="/home/validator0", rpc=26657)], env={},
            signers={"owner0": owner})
        deal = dict(id="7", manifest_root=base64.b64encode(bytes([8]) * 32).decode(),
                    current_gen="1", end_block="5000")
        providers = {0: AUDIT_ADDRESSES[1]}
        deputies = AUDIT_ADDRESSES[2:10]
        operations = workload.build_sustained_operations(
            life, deal, providers, deputies, [0, 250_000_000], 10, 4000, 17, 9_000_000, 8)
        self.assertEqual(len(operations), 10)
        for index, operation in enumerate(operations):
            session = operation["proof_expectation"]["session"]
            snapshot = operation["proof_expectation"]["snapshot"]
            submit = operation["open-session"]["submit"]
            self.assertEqual((session["blob_count"], session["total_bytes"], session["locked_fee"]), (8, 1024 * 1024, "136"))
            self.assertEqual((snapshot["k"], snapshot["m"], snapshot["slot"]), (8, 4, 0))
            self.assertEqual(session["authorized_proof_provider"], deputies[index % 8])
            self.assertEqual(submit[submit.index("--blob-count") + 1], "8")
            self.assertEqual(operation["submit-proof"]["submit"][
                operation["submit-proof"]["submit"].index("--gas") + 1], "9000000")
        self.assertEqual([row["phase"] for row in operations], ["warmup"] * 8 + ["measurement"] * 2)

    def test_atomic_response_count_order_type_and_uniqueness(self):
        second = OPEN_RESPONSE_DATA[:-64] + '31' * 32
        ids = artifact.opened_session_ids(dict(data=OPEN_RESPONSE_DATA + second), 2)
        self.assertEqual(ids[1], '31' * 32)
        for data, count in ((OPEN_RESPONSE_DATA * 2, 2), (OPEN_RESPONSE_DATA, 2),
                            (OPEN_RESPONSE_DATA + second + '00', 2),
                            (OPEN_RESPONSE_DATA + second.replace('4D7367', '587367', 1), 2),
                            (OPEN_RESPONSE_DATA[:-64] + '00' * 32, 1)):
            with self.subTest(count=count), self.assertRaises(ValueError):
                artifact.opened_session_ids(dict(data=data), count)
        self.assertEqual(len(artifact.opened_session_ids(dict(data=''.join(
            OPEN_RESPONSE_DATA[:-64] + bytes([i + 1]).hex() * 32 for i in range(64))), 64)), 64)
        with self.assertRaises(ValueError):
            artifact.opened_session_ids(dict(data=OPEN_RESPONSE_DATA), 65)

    def test_batch_pins_unsigned_signed_and_committed_order_before_proofs(self):
        for corruption in (None, 'generated_nonce', 'signed_order', 'unknown'):
            life, _, _, operations = fixture_state()
            operations = operations[:2]
            life.doc, life.save = {}, Mock()
            generated = []
            def command(args):
                if '--generate-only' in args:
                    expected = operations[len(generated)]['proof_expectation']['session']
                    message = {key: str(expected[key]) for key in ('deal_id', 'provider', 'authorized_proof_provider',
                        'start_mdu_index', 'start_blob_index', 'blob_count', 'nonce', 'expires_at')}
                    message.update(creator=operations[0]['open-session']['signer'], challenge_version=2,
                        manifest_root=base64.b64encode(bytes.fromhex(expected['manifest_root'])).decode(),
                        **{'@type': '/polystorechain.polystorechain.v1.MsgOpenRetrievalSession'})
                    if corruption == 'generated_nonce':
                        message['nonce'] = '999'
                    tx = dict(body=dict(messages=[message]))
                    generated.append(tx)
                    return json.dumps(tx)
                self.assertIn('--append', args)
                messages = [copy.deepcopy(tx['body']['messages'][0]) for tx in generated]
                if corruption == 'signed_order':
                    messages.reverse()
                Path(args[args.index('--output-document') + 1]).write_text(json.dumps(dict(body=dict(messages=messages), signatures=['signed'])))
                return ''
            response = dict(outcome='unknown' if corruption == 'unknown' else 'committed_success', height=12,
                            data=OPEN_RESPONSE_DATA + OPEN_RESPONSE_DATA[:-64] + '31' * 32)
            with tempfile.TemporaryDirectory() as home, patch.object(artifact, 'scheduled_transaction', return_value=response) as submit:
                if corruption:
                    with self.assertRaises(ValueError):
                        workload.open_session_batch(life, operations, Path(home) / 'batch', command)
                    self.assertEqual(submit.call_count, int(corruption == 'unknown'))
                else:
                    ids, height = workload.open_session_batch(life, operations, Path(home) / 'batch', command)
                    self.assertEqual((len(ids), height), (2, 12))
                    self.assertEqual(submit.call_count, 1)
                    self.assertEqual(life.doc['preparation_transactions'], [response])


    def test_block_reconciliation_rejects_missing_transaction_gas_and_header_drift(self):
        for corrupt in (None, "missing", "gas", "header", "validator_gas"):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory() as home:
                journal = Path(home) / "journal.sqlite"
                tx = dict(txhash="AB" * 32, code=0, gas_used=12, gas_wanted=20)
                result = dict(tx, outcome="committed_success", height=11, operation_id="proof-1")
                with sqlite3.connect(journal) as db:
                    db.execute("CREATE TABLE transactions(result TEXT)")
                    db.execute("INSERT INTO transactions VALUES (?)", (json.dumps(result),))
                summary = dict(height=11, time="time", block_hash="CD" * 32,
                    preceding_app_hash="EF" * 32, transactions=[] if corrupt == "missing" else [dict(tx)])
                if corrupt == "gas":
                    summary["transactions"][0]["gas_used"] += 1
                phases = {name: dict(complete=True, nodes=[dict(node_id=str(i), sample=dict(committed_height=h))
                    for i in range(4)]) for name, h in (("sustained_before", 10), ("sustained_after", 11))}
                def query(node, path):
                    if path.startswith("/commit"):
                        return dict(canonical=True, signed_header=dict(header=dict(height="11", chain_id="chain",
                            time="drift" if corrupt == "header" and node == 3 else "time", app_hash="EF" * 32),
                            commit=dict(height="11", block_id=dict(hash="CD" * 32))))
                    return dict(node=node)
                def summarize(block, results, height, chain):
                    value = json.loads(json.dumps(summary))
                    if corrupt == "validator_gas" and results["node"] == 3:
                        value["transactions"][0]["gas_used"] += 1
                    return value
                life = SimpleNamespace(home=Path(home), chain="chain", nodes=list(range(4)), remaining=Mock(),
                    query=query, doc=dict(commit_step_metrics=dict(phases=phases)))
                with patch.object(artifact, "committed_block_summary", side_effect=summarize):
                    if corrupt:
                        with self.assertRaises(ValueError):
                            workload.reconcile_sustained_blocks(life, journal)
                    else:
                        workload.reconcile_sustained_blocks(life, journal)
                        self.assertEqual(life.doc["committed_block_reconciliation"]["committed_workload_transactions"], 1)
                        self.assertEqual(json.loads((Path(home) / "sustained-blocks.jsonl").read_text())["transactions"][0]["operation_id"], "proof-1")

    def test_stream_filter_requires_four_collectors_and_uses_only_fenced_samples(self):
        with tempfile.TemporaryDirectory() as home:
            start = dict(chain_id="chain", monotonic_start_ns=10, monotonic_end_ns=20, committed_height=1)
            end = dict(chain_id="chain", monotonic_start_ns=50, monotonic_end_ns=60, committed_height=2)
            inside = dict(chain_id="chain", monotonic_start_ns=21, monotonic_end_ns=49)
            outside = dict(chain_id="chain", monotonic_start_ns=1, monotonic_end_ns=9)
            phases = {name: dict(nodes=[dict(node_id=str(i), sample=sample) for i in range(4)])
                for name, sample in (("sustained_before", start), ("sustained_after", end))}
            streams = []
            for i in range(4):
                path = Path(home) / f"{i}.jsonl"
                path.write_text(json.dumps(outside) + "\n" + json.dumps(inside) + "\n")
                streams.append(dict(node_id=str(i), path=str(path)))
            life = SimpleNamespace(chain="chain", doc=dict(commit_step_metrics=dict(phases=phases), commit_streams=streams))
            processes = [SimpleNamespace(returncode=0) for _ in range(4)]
            with patch.object(workload.commit_metrics, "summarize_commit_metrics", return_value=dict(qualified=True)) as summarize:
                workload.summarize_commit_streams(life, processes)
                self.assertEqual(summarize.call_count, 4)
                self.assertEqual(summarize.call_args.args[0], [start, inside, end])
                self.assertEqual(streams[0]["raw_samples"], 2)
                with self.assertRaises(ValueError):
                    workload.summarize_commit_streams(life, processes[:3])
                processes[0].returncode = 1
                with self.assertRaises(ValueError):
                    workload.summarize_commit_streams(life, processes)


if __name__ == '__main__':
    unittest.main()
