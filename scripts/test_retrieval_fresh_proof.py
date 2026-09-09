"""Focused offline producer checks. Optional native checks use a prebuilt library.

POLYSTORE_TEST_NATIVE_LIBRARY=/absolute/libpolystore_core.dylib python3 -m unittest
No node, listener, build, signing or transaction submission is used.
"""
import base64
import copy
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import retrieval_bench_artifact as artifact
import retrieval_fresh_proof as producer

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = json.loads((ROOT / "polystorechain/pkg/retrievalchallenge/testdata/challenge-golden.json").read_text())


def address(byte):
    # Fixed known answers from the browser's independent bech32 package.
    return ("nil1qyqszqgpqyqszqgpqyqszqgpqyqszqgpdqqjtx" if byte == 1 else
            "nil1qgpqyqszqgpqyqszqgpqyqszqgpqyqszuyxhqs")


def fixture_view():
    b64 = lambda v: base64.b64encode(v).decode()
    sid = "ab" * 32
    s = dict(session_id=b64(bytes.fromhex(sid)), manifest_root=b64(bytes.fromhex("cd" * 32)),
             owner=address(1), provider=address(1), authorized_proof_provider=address(2),
             deal_id="9007199254740993", nonce="27", expires_at="150", start_mdu_index="2",
             start_blob_index=0, blob_count="3", total_bytes=str(3 * 131072),
             funding=1, purpose=1, status=1, locked_fee="51", challenge_version=2,
             opened_height="100", updated_height="100")
    x = dict(chain_id="polystore-test-1", setup_digest=b64(bytes.fromhex(producer.SETUP_DIGEST)),
             generation="7", layout=2, k=8, m=4, slot=0, metadata_mdus="2", user_mdus="1", deal_end="200")
    s["challenge_snapshot"] = x
    expected = dict(session=copy.deepcopy(s), snapshot=copy.deepcopy(x), minimum_opened_height="90")
    expected["session"]["manifest_root"] = "cd" * 32
    expected["snapshot"]["setup_digest"] = producer.SETUP_DIGEST
    c = {name: value for name, _, value in GOLDEN["schema"]["fields"]}
    c.update(setup_digest=producer.SETUP_DIGEST, context_id=sid, assigned="01" * 20, payee="02" * 20,
             root="cd" * 32, slot=0, user_mdus=1, start_mdu=2, start_leaf=0)
    raw = producer.context_bytes(c)
    view = dict(session=s, challenge_context=b64(raw), challenge_context_hash=b64(hashlib.sha256(raw).digest()),
                challenge_seed=b64(bytes.fromhex(GOLDEN["schema"]["seed_hex"])))
    return view, expected, sid


class FreshProofTest(unittest.TestCase):
    def test_maintained_context_and_all_challenge_points(self):
        fields = {name: value for name, _, value in GOLDEN["schema"]["fields"]}
        for kind in ("session", "audit", "repair"):
            c = dict(fields)
            if kind != "session":
                c.update(GOLDEN["schema"]["audit_override"])
                if kind == "repair":
                    c["kind"] = 3
            vector = GOLDEN["vectors"][kind]
            raw = producer.context_bytes(c)
            self.assertEqual(raw.hex(), vector["context_hex"])
            digest = hashlib.sha256(raw).digest()
            self.assertEqual(digest.hex(), vector["context_hash"])
            for point in vector["samples"]:
                self.assertEqual(producer.fresh_z(digest, bytes.fromhex(GOLDEN["schema"]["seed_hex"]),
                                 point["ordinal"], point["mdu_index"], point["leaf_index"]).hex(), point["z"])

    def test_full_frozen_context_and_independent_intent(self):
        view, expected, sid = fixture_view()
        c, digest = producer.frozen_context(view, expected, sid, 102)
        self.assertEqual(c["deal_id"], 9007199254740993)
        self.assertEqual(digest.hex(), hashlib.sha256(producer.context_bytes(c)).hexdigest())
        for target, field, value in (("session", "nonce", "28"), ("session", "owner", address(2)),
                                     ("session", "authorized_proof_provider", address(1)),
                                     ("session", "locked_fee", "52"), ("session", "funding", 2),
                                     ("session", "purpose", 2), ("session", "status", 4),
                                     ("session", "opened_height", "149"), ("session", "updated_height", "103"),
                                     ("snapshot", "generation", "8"), ("snapshot", "slot", 1),
                                     ("snapshot", "setup_digest", base64.b64encode(bytes(32)).decode())):
            bad = copy.deepcopy(view)
            (bad["session"] if target == "session" else bad["session"]["challenge_snapshot"])[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                producer.frozen_context(bad, expected, sid, 102)
        for field in ("challenge_context", "challenge_context_hash"):
            bad = copy.deepcopy(view)
            raw = bytearray(base64.b64decode(bad[field])); raw[-1] ^= 1
            bad[field] = base64.b64encode(raw).decode()
            with self.assertRaises(ValueError):
                producer.frozen_context(bad, expected, sid, 102)
        with self.assertRaises(ValueError):
            producer.frozen_context(view, expected, sid, 151)

    def test_frozen_context_accepts_only_the_assigned_slot_range(self):
        view, expected, sid = fixture_view()
        for target in (view, expected):
            snapshot = target["session"]["challenge_snapshot"] if target is view else target["snapshot"]
            snapshot["slot"] = 7
            target["session"]["start_blob_index"] = 56
            target["session"]["blob_count"] = "8"
            target["session"]["total_bytes"] = str(8 * 131072)
        fields = {name: value for name, _, value in GOLDEN["schema"]["fields"]}
        c = dict(fields)
        c.update(chain_id="polystore-test-1", setup_digest=producer.SETUP_DIGEST, context_id=sid,
                 deal_id=9007199254740993, generation=7, root="cd" * 32,
                 assigned="01" * 20, payee="02" * 20, layout=2, k=8, m=4, slot=7,
                 metadata_mdus=2, user_mdus=1, start_mdu=2, start_leaf=56, blob_count=8,
                 snapshot_height=100, anchor_height=101, first_response_height=102,
                 deadline_height=150, deal_end=200)
        raw = producer.context_bytes(c)
        view["challenge_context"] = base64.b64encode(raw).decode()
        view["challenge_context_hash"] = base64.b64encode(hashlib.sha256(raw).digest()).decode()
        self.assertEqual(producer.frozen_context(view, expected, sid, 102)[0]["start_leaf"], 56)
        for start, count in ((0, 8), (55, 8), (56, 9), (64, 1)):
            bad = copy.deepcopy(view)
            bad["session"]["start_blob_index"] = start
            bad["session"]["blob_count"] = str(count)
            bad["session"]["total_bytes"] = str(count * 131072)
            wanted = copy.deepcopy(expected)
            wanted["session"].update(start_blob_index=start, blob_count=str(count), total_bytes=str(count * 131072))
            with self.subTest(start=start, count=count), self.assertRaises(ValueError):
                producer.frozen_context(bad, wanted, sid, 102)

    def test_rows_use_global_scalar_index(self):
        for k in (2, 8):
            for row in (0, 1, 64 // k - 1):
                blob = producer.fixture_blob(k, row)
                self.assertEqual(len(blob), 131072)
                for index in (0, 251, 4095):
                    self.assertEqual(blob[index * 32:(index + 1) * 32], bytes(31) + bytes([1 + (row * k * 4096 + index) % 251]))

    def test_committed_height_poll_anchor_and_output_without_network(self):
        view, expected, sid = fixture_view()
        config = dict(rpc="http://owned-rpc", api="http://owned-api", node_id="owned")
        seed = base64.b64decode(view["challenge_seed"]).hex()
        calls = []
        heights = iter((101, 102))
        current_height = 101
        wrong_header = False

        class Response(io.BytesIO):
            status = 200
            def __init__(self, value, height=None):
                super().__init__(json.dumps(value).encode())
                self.headers = {} if height is None else {"x-cosmos-block-height": str(height)}

        def request(req, timeout):
            nonlocal current_height
            calls.append(req)
            self.assertGreater(timeout, 0)
            if req.full_url.endswith("/status"):
                current_height = next(heights, 102)
                return Response({"result": {"node_info": {"id": "owned", "network": "polystore-test-1"},
                                  "sync_info": {"latest_block_height": str(current_height + 1), "catching_up": False}}})
            if req.full_url.endswith("/abci_info"):
                return Response({"result": {"response": {"last_block_height": str(current_height)}}})
            if "/retrieval-sessions/" in req.full_url:
                self.assertEqual(req.get_header("X-cosmos-block-height"), str(current_height))
                return Response(view, 100 if wrong_header else current_height)
            self.assertTrue(req.full_url.endswith("/block?height=101"))
            return Response({"result": {"block": {"header": {"height": "101", "chain_id": "polystore-test-1"}}, "block_id": {"hash": seed}}})

        with tempfile.TemporaryDirectory() as tmp, patch.object(producer.urllib.request, "urlopen", side_effect=request), patch.object(producer, "native_proofs", return_value={"proofs": ["bounded"]}) as native:
            out = Path(tmp) / "proof.json"
            result = producer.prepare(config, expected, sid, artifact.monotonic_ns() + 10**9, out)
            self.assertEqual(result["session_id"], sid)
            self.assertEqual(out.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(calls), 7)
            self.assertEqual(native.call_count, 1)
            # The same bounded reader retains terminal state without rewriting
            # it to OPEN or invoking native generation, and pins an exact height.
            original_status = view["session"]["status"]
            view["session"]["status"] = "RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED"
            observed = producer.session_evidence(config, expected, sid, artifact.monotonic_ns() + 10**9, height=102)
            self.assertEqual(observed["height"], 102)
            self.assertEqual(observed["view"]["session"]["status"], "RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED")
            self.assertEqual(set(observed["anchor"]), {"block", "block_id"})
            self.assertEqual(native.call_count, 1)
            view["session"]["status"] = original_status
            with self.assertRaisesRegex(ValueError, "not committed"):
                producer.session_evidence(config, expected, sid, artifact.monotonic_ns() + 10**9, height=103)
            wrong_header = True
            with self.assertRaisesRegex(ValueError, "committed response"):
                producer.prepare(config, expected, sid, artifact.monotonic_ns() + 10**9, Path(tmp) / "bad-height.json")
            wrong_header = False
            with self.assertRaisesRegex(ValueError, "owned node"):
                producer.prepare(dict(config, node_id="different"), expected, sid, artifact.monotonic_ns() + 10**9, Path(tmp) / "bad-node.json")
            with self.assertRaises(TimeoutError):
                producer.prepare(config, expected, sid, artifact.monotonic_ns() - 1, Path(tmp) / "late.json")
            view["challenge_seed"] = base64.b64encode(bytes(32)).decode()
            with self.assertRaisesRegex(ValueError, "anchor"):
                producer.prepare(config, expected, sid, artifact.monotonic_ns() + 10**9, Path(tmp) / "bad.json")
            self.assertEqual(native.call_count, 1)

    def test_callback_owned_process_path_and_absolute_deadline(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = dict(library=__file__, setup=__file__, fixture=tmp)
            builder = artifact.fresh_session_proof_builder(config, Path(tmp) / "proofs")
            deadline = artifact.monotonic_ns() + 10**9
            sid = "ab" * 32
            def run(argv, actual_deadline):
                self.assertEqual(actual_deadline, deadline)
                request = json.loads(argv[-1])
                self.assertEqual(request["deadline"], deadline)
                Path(request["output"]).write_text("{}")
                return subprocess.CompletedProcess(argv, 0, json.dumps(dict(session_id=sid, context_hash="cd"*32, seed="ef"*32)), "")
            with patch.object(artifact, "run_bounded_command", side_effect=run):
                operation = dict(proof_expectation={"session": {"authorized_proof_provider": "provider", "owner": "owner"}},
                                 proof_submit=["cli", "submit-retrieval-proof", "{proof_path}", "--from", "provider"],
                                 **{"submit-proof": {"signer": "provider"}, "open-session": {"signer": "owner"}, "confirm": {"signer": "owner"}})
                result = builder(operation, sid, deadline)
                self.assertEqual(result["submit"][2], str(Path(tmp) / "proofs" / (sid + ".json")))
                operation["submit-proof"]["signer"] = "other"
                with self.assertRaisesRegex(ValueError, "authority"):
                    builder(operation, sid, deadline)
            with self.assertRaises(FileExistsError):
                artifact.fresh_session_proof_builder(config, Path(tmp) / "proofs")

    @unittest.skipUnless(os.environ.get("POLYSTORE_TEST_NATIVE_LIBRARY"), "prebuilt native library is opt-in")
    def test_native_multirow_known_answers_and_fresh_replacement(self):
        library = os.environ["POLYSTORE_TEST_NATIVE_LIBRARY"]
        structure = json.loads((ROOT / "polystorechain/x/polystorechain/keeper/testdata/proof_admission_k8.json").read_text())
        with tempfile.TemporaryDirectory() as tmp:
            payload = json.dumps(dict(session_id=base64.b64encode(bytes(32)).decode(), proofs=structure["proofs"])).encode()
            (Path(tmp) / "1.json").write_bytes(payload)
            meta = dict(schema_version=1, challenge_kind="legacy-fixed-z", data_pattern="be-fr-last-byte-cycle-1-through-251-v1",
                        k=8, m=4, slot=0, mdu_index=2, metadata_mdus=2, user_mdus=1, data_bytes=8388608,
                        encoded_blob_bytes=131072, rows_per_slot=8, manifest_root="0x" + base64.b64decode(structure["root"]).hex(),
                        trusted_setup_sha256=producer.SETUP_DIGEST, proofs_per_session=3,
                        proof_payload_sha256=hashlib.sha256(payload).hexdigest())
            (Path(tmp) / "fixture.json").write_text(json.dumps(meta))
            config = dict(library=library, setup=str(ROOT / "polystorechain/trusted_setup.txt"), fixture=tmp)
            c = dict(k=8, m=4, root=meta["manifest_root"][2:], start_leaf=0, blob_count=3, context_id="ab"*32)
            fresh = producer.native_proofs(config, c, bytes(32), bytes([1])*32)
            lib = ctypes.CDLL(library)
            lib.polystore_compute_blob_proof.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
            for row, original in enumerate(structure["proofs"]):
                blob = producer.fixture_blob(8, row)
                proof, y = ctypes.create_string_buffer(48), ctypes.create_string_buffer(32)
                self.assertEqual(lib.polystore_compute_blob_proof(blob, len(blob), base64.b64decode(original["z_value"]), proof, y), 0)
                self.assertEqual(proof.raw, base64.b64decode(original["kzg_opening_proof"]))
                self.assertEqual(y.raw, base64.b64decode(original["y_value"]))
                for field in original.keys() - {"z_value", "y_value", "kzg_opening_proof"}:
                    self.assertEqual(fresh["proofs"][row][field], original[field])
                self.assertNotEqual(fresh["proofs"][row]["z_value"], original["z_value"])
            # Wrong row reconstruction must stop before any proof payload escapes.
            with patch.object(producer, "fixture_blob", return_value=producer.fixture_blob(8, 0)):
                with self.assertRaisesRegex(ValueError, "commitment"):
                    producer.native_proofs(config, c, bytes(32), bytes([1])*32)


if __name__ == "__main__":
    unittest.main()
