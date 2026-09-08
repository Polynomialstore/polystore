"""Validation/accounting for bench_retrieval_sessions.sh; Python stdlib only.

This is legacy fixture instrumentation, not a v2 challenge generator or capacity
qualification. Malformed query responses never provide completion evidence.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time


def monotonic_ns():
    # Python <3.10 on macOS uses a process-relative monotonic_ns origin. Each
    # shell call is a new process, so use the OS clock's shared origin directly.
    return time.clock_gettime_ns(time.CLOCK_MONOTONIC)


def integer(value, name, minimum=0, maximum=(1 << 63) - 1):
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]+", str(value)):
        raise ValueError(f"{name} must be an integer")
    number = int(value)
    if not minimum <= number <= maximum:
        raise ValueError(f"{name} must be {minimum}..{maximum}")
    return number


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def committed_tx(value, expected_hash):
    if not isinstance(value, dict):
        raise ValueError("committed transaction must be an object")
    txhash = value.get("txhash", "")
    if not isinstance(txhash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", txhash):
        raise ValueError("invalid committed transaction hash")
    if txhash.upper() != expected_hash.upper():
        raise ValueError("committed transaction hash mismatch")
    for name, minimum in (("height", 1), ("code", 0), ("gas_wanted", 0), ("gas_used", 0)):
        integer(value.get(name), name, minimum)
    return value


def fixture(directory, sessions, proofs, pattern):
    if pattern not in {"zero-filled-v1", "be-fr-last-byte-cycle-1-through-251-v1"}:
        raise ValueError("unknown deterministic fixture pattern")
    directory = Path(directory)
    meta = json.loads((directory / "fixture.json").read_text())
    expected = {"schema_version": 1, "challenge_kind": "legacy-fixed-z", "data_pattern": pattern,
                "sessions": sessions, "proofs_per_session": proofs, "total_proofs": sessions * proofs,
                "k": 2, "m": 1, "slot": 0, "rows_per_slot": 32,
                "mdu_index": 2, "metadata_mdus": 2, "user_mdus": 1,
                "data_bytes": 8 * 1024 * 1024, "raw_payload_capacity_bytes": 8126464, "encoded_blob_bytes": 131072}
    for name, want in expected.items():
        if type(meta.get(name)) is not type(want) or meta[name] != want:
            raise ValueError(f"fixture {name} must equal {want!r}")
    for name in ("data_sha256", "trusted_setup_sha256", "proof_payload_sha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", str(meta.get(name, ""))):
            raise ValueError(f"invalid fixture {name}")
    digest = hashlib.sha256()
    if pattern == "zero-filled-v1":
        for _ in range(8):
            digest.update(bytes(1024 * 1024))
    else:
        cycle = b"".join(bytes(31) + bytes([i]) for i in range(1, 252))
        cycles, remaining = divmod(8 * 1024 * 1024, len(cycle))
        for _ in range(cycles):
            digest.update(cycle)
        digest.update(cycle[:remaining])
    if digest.hexdigest() != meta["data_sha256"]:
        raise ValueError("fixture deterministic data hash mismatch")
    root = (directory / "manifest_root.txt").read_text().strip().lower()
    if not re.fullmatch(r"0x[0-9a-f]{64}", root) or meta.get("manifest_root") != root:
        raise ValueError("fixture manifest root mismatch")
    for index in range(1, sessions + 1):
        path = directory / f"{index}.json"
        if sha256(path) != meta["proof_payload_sha256"]:
            raise ValueError(f"fixture proof hash mismatch: {index}")
        value = json.loads(path.read_text())
        if len(value.get("proofs", [])) != proofs:
            raise ValueError("fixture proof count mismatch")
    meta["metadata_sha256"] = sha256(directory / "fixture.json")
    return meta


def profile(sessions, proofs, execution_ms, memory_bytes, consensus):
    sessions = integer(sessions, "sessions", 1, 8192)
    proofs = integer(proofs, "proofs_per_session", 0, 32)
    execution_ms = integer(execution_ms, "execution_budget_ms", 1, 1000)
    memory_bytes = integer(memory_bytes, "memory_ceiling_bytes", 1)
    block = consensus["block"]
    integer(block["max_gas"], "max_gas", 1, 64000000)
    integer(block["max_bytes"], "max_bytes", 1, 2097152)
    return {"sessions": sessions, "proofs_per_session": proofs,
            "mode": "legacy-serial", "challenge_kind": "legacy-fixed-z",
            "target_block_interval_ms": 1000, "execution_budget_ms": execution_ms,
            "memory_ceiling_bytes": memory_bytes, "max_in_flight": 1,
            "warmup_sessions": 0, "measurement": "complete-lifecycle" if proofs else "control-only",
            "execution_memory_budgets_measured": False, "qualification": False,
            "repetitions": 1, "consensus_profile": consensus}


def summarize(doc, start, end):
    wall = (integer(end, "end") - integer(start, "start")) / 1e9
    if wall <= 0:
        raise ValueError("measurement interval must be positive")
    load = [tx for tx in doc["txs"] if tx["kind"] in {"open-session", "submit-proof", "confirm-session"}]
    success = {(tx["index"], tx["kind"]) for tx in load if tx.get("outcome") == "committed_success"}
    states = {item["index"]: item for item in doc.get("session_states", [])}
    completed = sum(1 for index in range(1, doc["config"]["sessions"] + 1)
                    if all((index, kind) in success for kind in ("open-session", "submit-proof", "confirm-session"))
                    and states.get(index, {}).get("completed") is True)
    def counts(items):
        return {name: sum(tx.get("outcome") == name for tx in items) for name in
                ("committed_success", "committed_failure", "checktx_rejected", "unknown", "not_submitted", "skipped")}
    sent = sum(tx.get("outcome") not in {"skipped", "not_submitted"} for tx in load)
    rate = completed / wall
    return {"total_records": len(doc["txs"]), "total_outcomes": counts(doc["txs"]),
            "load_records": len(load), "load_outcomes": counts(load), "load_txs_sent": sent,
            "load_txs_per_sec": sent / wall, "sessions_attempted": doc["config"]["sessions"],
            "sessions_completed": completed, "sessions_per_sec": rate,
            "sessions_per_hour": rate * 3600, "sessions_per_day": rate * 86400,
            "proofs_committed": sum(tx.get("outcome") == "committed_success" and tx["kind"] == "submit-proof" for tx in load) * doc["config"]["proofs_per_session"],
            "committed_gas_used": sum(tx.get("gas_used", 0) for tx in load if tx.get("outcome", "").startswith("committed_")),
            "completion_basis": "committed open+proof+confirm and queried COMPLETED session" if doc["config"]["proofs_per_session"] else "not measured (proof stage skipped)",
            "serial_driver": True, "saturation": False, "qualification": False,
            "wall_seconds": wall}


def opened_session_id(tx):
    # Pinned Cosmos TxMsgData: exactly one field-2 Any, the owning response type,
    # and exactly its field-1 bytes32 session_id. All lengths fit one-byte varints.
    # Reject extra responses/fields, stale MsgData, malformed lengths, and guesses
    # from arbitrary trailing bytes; schema changes require an explicit update.
    response_type = b"/polystorechain.polystorechain.v1.MsgOpenRetrievalSessionResponse"
    any_value = b"\x0a" + bytes([len(response_type)]) + response_type + b"\x12\x22\x0a\x20"
    prefix = b"\x12" + bytes([len(any_value) + 32]) + any_value
    data = tx.get("data", "")
    if not isinstance(data, str) or len(data) != (len(prefix) + 32) * 2 or not re.fullmatch(r"[0-9a-fA-F]+", data):
        raise ValueError("invalid open-session TxMsgData encoding")
    raw = bytes.fromhex(data)
    if not raw.startswith(prefix):
        raise ValueError("expected exactly one MsgOpenRetrievalSessionResponse")
    return raw[len(prefix):].hex()


def session_state(value, session_id, deal, owner, provider, nonce, count, manifest, height):
    session = value["session"]
    if base64.b64decode(session["session_id"], validate=True) != bytes.fromhex(session_id.removeprefix("0x")):
        raise ValueError("session query ID mismatch")
    if base64.b64decode(session["manifest_root"], validate=True) != bytes.fromhex(manifest.removeprefix("0x")):
        raise ValueError("session query manifest mismatch")
    for name, expected in (("deal_id", deal), ("nonce", nonce), ("blob_count", count),
                           ("start_mdu_index", 2), ("start_blob_index", 0),
                           ("total_bytes", int(count) * 131072), ("updated_height", height)):
        # Proto JSON omits default-valued scalar fields, including real deal 0.
        if integer(session.get(name, "0"), name) != int(expected):
            raise ValueError(f"session query {name} mismatch")
    if session["owner"] != owner or session["provider"] != provider:
        raise ValueError("session query actor mismatch")
    return {"session_id": session_id, "completed": session["status"] in
            (4, "RETRIEVAL_SESSION_STATUS_COMPLETED"), "status": session["status"]}


def command(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def provenance(root, binary, library):
    root = Path(root)
    paths = ["scripts/bench_retrieval_sessions.sh", "scripts/retrieval_bench_artifact.py",
             "scripts/retrieval_consensus_profile.json", "scripts/chain_go.sh",
             "polystorechain/x/polystorechain/keeper/retrieval_session_bench_test.go",
             "polystorechain/x/polystorechain/keeper/retrieval_fixture_metadata_test.go"]
    untracked = command("git", "-C", str(root), "ls-files", "--others", "--exclude-standard", "--", "scripts", "polystorechain", "polystore_core").splitlines()
    return {"source_revision": command("git", "-C", str(root), "rev-parse", "HEAD"),
            "working_tree_status": command("git", "-C", str(root), "status", "--porcelain"),
            "untracked_source_sha256": {path: sha256(root / path) for path in untracked},
            "working_tree_diff_sha256": hashlib.sha256(subprocess.check_output(["git", "-C", str(root), "diff", "HEAD", "--", "."])).hexdigest(),
            "host": platform.platform(), "machine": platform.machine(), "logical_cpus": os.cpu_count(),
            "go": command("go", "version"), "rustc": command("rustc", "--version"),
            "binary_sha256": sha256(binary), "native_library_sha256": sha256(library),
            "trusted_setup_sha256": sha256(root / "polystorechain/trusted_setup.txt"),
            "harness_sha256": {path: sha256(root / path) for path in paths},
            "build_mode": "patched-vendor", "go_parallelism": 2, "cargo_jobs": 2,
            "measurement_boundary": "paced serial load including CLI, CheckTx, inclusion and final session query"}


def main():
    action, *args = sys.argv[1:]
    if action == "clock":
        print(monotonic_ns())
    elif action == "pace":
        time.sleep(max(0, (int(args[0]) - monotonic_ns()) / 1e9))
    elif action == "committed":
        print(json.dumps(committed_tx(json.load(sys.stdin), args[0])))
    elif action == "fixture":
        print(json.dumps(fixture(args[0], int(args[1]), int(args[2]), args[3])))
    elif action == "profile":
        print(json.dumps(profile(*args[:4], json.loads(Path(args[4]).read_text()))))
    elif action == "provenance":
        print(json.dumps(provenance(*args)))
    elif action == "summary":
        path = Path(args[0])
        doc = json.loads(path.read_text())
        doc["summary"] = summarize(doc, args[1], args[2])
        doc["status"] = "finished"
        path.write_text(json.dumps(doc, indent=1))
        print(json.dumps(doc["summary"], indent=1))
    elif action == "opened":
        print(opened_session_id(json.load(sys.stdin)))
    elif action == "session":
        print(json.dumps(session_state(json.load(sys.stdin), *args)))
    else:
        raise ValueError("unknown artifact action")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        raise SystemExit(str(error))
