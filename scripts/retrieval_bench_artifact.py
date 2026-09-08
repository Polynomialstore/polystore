"""Validation/accounting for bench_retrieval_sessions.sh; Python stdlib only.

Legacy fixture instrumentation and offline C3/C6 planning arithmetic; neither is
a v2 challenge generator or capacity qualification. Malformed query responses
never provide completion evidence. Print the offline report without a node:
    python3 scripts/retrieval_bench_artifact.py arithmetic
"""
import base64
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import json
from math import comb
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time


# Encoding/layout from polystore_core/src/{kzg,coding}.rs. The offline report
# uses the default RS(8,12) profile; the legacy fixture below uses RS(2,3).
ENCODED_BLOB_BYTES = 131072
SCALAR_BYTES = 32
SCALAR_PAYLOAD_BYTES = 31
PAYLOAD_BLOB_BYTES = ENCODED_BLOB_BYTES // SCALAR_BYTES * SCALAR_PAYLOAD_BYTES
BLOBS_PER_MDU = 64
DEFAULT_K, DEFAULT_M = 8, 4
# polystorechain/pkg/retrievalchallenge/challenge.go: hard ceiling, not a quota.
MAX_AUDIT_SAMPLES = 4096


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


def retrieval_denominator(offset, length, *, encoded=False, k=DEFAULT_K):
    """Exact contiguous range in untransformed user data, excluding metadata.

    Every touched blob is opened in full. Within each MDU, consecutive original
    blob indices map to (row, slot) by divmod(index, K); each touched slot is one
    legal contiguous session window. Count without allocating the range.
    """
    offset, length = integer(offset, "offset"), integer(length, "length")
    end = integer(offset + length, "range end")
    k = integer(k, "k", 1, BLOBS_PER_MDU)
    if BLOBS_PER_MDU % k or type(encoded) is not bool:
        raise ValueError("k must divide 64 and encoded must be boolean")
    unit = ENCODED_BLOB_BYTES if encoded else PAYLOAD_BLOB_BYTES
    first = offset // unit
    stop = (end + unit - 1) // unit if length else first
    blobs = stop - first
    mdus = sessions = 0
    if blobs:
        first_mdu, last_mdu = first // BLOBS_PER_MDU, (stop - 1) // BLOBS_PER_MDU
        mdus = last_mdu - first_mdu + 1
        if mdus == 1:
            sessions = min(k, blobs)
        else:
            sessions = (min(k, BLOBS_PER_MDU - first % BLOBS_PER_MDU)
                        + (mdus - 2) * k + min(k, (stop - 1) % BLOBS_PER_MDU + 1))
    return {"requested_byte_domain": "encoded" if encoded else "logical-payload",
            "offset_bytes": offset, "requested_bytes": length,
            "unique_data_blobs": blobs, "fresh_blob_openings": blobs,
            "user_mdus_touched": mdus, "legal_session_windows": sessions,
            "verified_encoded_bytes": blobs * ENCODED_BLOB_BYTES,
            "billed_encoded_bytes": blobs * ENCODED_BLOB_BYTES}


def sampling_miss(population, unavailable, samples):
    """Exact probability for uniform distinct draws and fixed unavailability."""
    population = integer(population, "population")
    unavailable = integer(unavailable, "unavailable", 0, population)
    samples = integer(samples, "samples", 0, min(population, MAX_AUDIT_SAMPLES))
    if samples > population - unavailable:
        return Fraction(0)
    return Fraction(comb(population - unavailable, samples), comb(population, samples))


def probability_decimal(value):
    # Serialize 50 significant digits, not binary floats: retain tiny miss
    # probabilities and compute detection as an exact complement before rounding.
    with localcontext() as context:
        context.prec = 50
        return str(Decimal(value.numerator) / Decimal(value.denominator))


def sampling_case(population, unavailable, samples):
    miss = sampling_miss(population, unavailable, samples)
    population, unavailable, samples = map(int, (population, unavailable, samples))
    bound = Fraction(population - unavailable, population) ** samples if population else Fraction(1)
    return {"population": population, "unavailable_fixed_before_seed": unavailable,
            "distinct_samples": samples, "miss_probability": probability_decimal(miss),
            "detection_probability": probability_decimal(1 - miss),
            "conservative_miss_bound": probability_decimal(bound),
            "miss_at_most_1e_minus_6": miss <= Fraction(1, 1000000)}


def arithmetic_report():
    """C3/C6 planning checks only; no chain, fixture, sampler or capacity run."""
    gib = 1 << 30
    logical = retrieval_denominator(0, gib)
    assignment_population = logical["user_mdus_touched"] * (BLOBS_PER_MDU // DEFAULT_K)
    targets = []
    for unavailable_fraction, samples in ((Fraction(1, 10), 64), (Fraction(1, 10), 132),
                                          (Fraction(1, 100), 1375)):
        bound = (1 - unavailable_fraction) ** samples
        targets.append({"minimum_unavailable_fraction": str(unavailable_fraction),
                        "distinct_samples": samples,
                        "conservative_miss_bound": probability_decimal(bound),
                        "bound_at_most_1e_minus_6": bound <= Fraction(1, 1000000)})
    return {"schema_version": 1, "kind": "offline-retrieval-arithmetic",
            "qualification": False, "runtime_measured": False,
            "probability_encoding": "decimal strings rounded to 50 significant digits; exact rational calculations",
            "encoding": {"encoded_blob_bytes": ENCODED_BLOB_BYTES,
                         "payload_blob_bytes": PAYLOAD_BLOB_BYTES,
                         "field_elements_per_blob": ENCODED_BLOB_BYTES // SCALAR_BYTES,
                         "scalar_bytes": SCALAR_BYTES, "scalar_payload_bytes": SCALAR_PAYLOAD_BYTES,
                         "data_blobs_per_mdu": BLOBS_PER_MDU, "k": DEFAULT_K, "m": DEFAULT_M,
                         "maximum_blobs_per_session": BLOBS_PER_MDU // DEFAULT_K},
            "denominators": {"payload_1kib_inside": retrieval_denominator(0, 1024),
                             "payload_1kib_crossing": retrieval_denominator(PAYLOAD_BLOB_BYTES - 512, 1024),
                             "encoded_1gib_aligned": retrieval_denominator(0, gib, encoded=True),
                             "payload_1gib_aligned": logical},
            "audit_population_for_payload_1gib": {
                "stored_encoded_blobs_per_slot_assignment": assignment_population,
                "stored_encoded_blobs_across_all_slots": assignment_population * (DEFAULT_K + DEFAULT_M),
                "includes_padding": True, "all_slots_include_parity": True},
            "sampling": {"model": "C(U-b,Q)/C(U,Q), zero when Q > U-b; bound (1-b/U)^Q",
                         "benchmark_profile": "Q=min(U,132), target f=1/10 and epsilon=1e-6; not a production quota",
                         "maximum_samples": MAX_AUDIT_SAMPLES,
                         "fraction_bound_targets": targets,
                         "cases": [sampling_case(0, 0, 0), sampling_case(1, 1, 1),
                                   sampling_case(64, 7, 64),
                                   sampling_case(assignment_population, (assignment_population + 9) // 10, 132),
                                   sampling_case(8192, 1, 132)]},
            "conditions_and_limits": [
                "Denominators assume an authenticated contiguous untransformed user-data range; metadata is excluded.",
                "Paid retrieval opens every touched blob; synthetic audit sampling does not replace paid openings.",
                "Logical bytes, verified/billed encoded bytes, padding, parity and transport/retries are distinct; transport is not measured.",
                "Sampling requires a population frozen before the seed, unavailability fixed before the seed, and uniform distinct selection.",
                "Future block hashes are proposer-biasable; this arithmetic does not qualify permissionless sampling security.",
                "Adaptive fetching after seed, grinding and selective nonresponse are outside the fixed-unavailability model.",
                "One missing blob or a 1KiB fragment is not a 10-percent-loss guarantee; padding is availability population, not entropy.",
                "RS recovery and correlated slot outages need separate interpretation; epoch/assignment risks accumulate by a union bound.",
                "No runtime capacity, delivery, deployment security or 128-bit security claim is established."]}


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
    # Consistency checks for this run's trusted exporter, not authentication of
    # external data/proof bindings. The driver always generates its own fixture.
    if pattern not in {"zero-filled-v1", "be-fr-last-byte-cycle-1-through-251-v1"}:
        raise ValueError("unknown deterministic fixture pattern")
    directory = Path(directory)
    meta = json.loads((directory / "fixture.json").read_text())
    expected = {"schema_version": 1, "challenge_kind": "legacy-fixed-z", "data_pattern": pattern,
                "sessions": sessions, "proofs_per_session": proofs, "total_proofs": sessions * proofs,
                "k": 2, "m": 1, "slot": 0, "rows_per_slot": 32,
                "mdu_index": 2, "metadata_mdus": 2, "user_mdus": 1,
                "data_bytes": BLOBS_PER_MDU * ENCODED_BLOB_BYTES,
                "raw_payload_capacity_bytes": BLOBS_PER_MDU * PAYLOAD_BLOB_BYTES,
                "encoded_blob_bytes": ENCODED_BLOB_BYTES}
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
            "gas_limit": str(1000000 + proofs * 500000),
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


def abort_run(path, exit_code):
    path = Path(path)
    code = integer(exit_code, "exit_code", 1, 255)
    doc = json.loads(path.read_text())
    if doc.get("status") != "aborted_unknown_transaction":
        doc["status"] = "aborted"
    doc["exit_code"] = code
    path.write_text(json.dumps(doc, indent=1))


def session_state(value, session_id, deal, owner, provider, nonce, count, manifest, height):
    session = value["session"]
    if base64.b64decode(session["session_id"], validate=True) != bytes.fromhex(session_id.removeprefix("0x")):
        raise ValueError("session query ID mismatch")
    if base64.b64decode(session["manifest_root"], validate=True) != bytes.fromhex(manifest.removeprefix("0x")):
        raise ValueError("session query manifest mismatch")
    for name, expected in (("deal_id", deal), ("nonce", nonce), ("blob_count", count),
                           ("start_mdu_index", 2), ("start_blob_index", 0),
                           ("total_bytes", int(count) * ENCODED_BLOB_BYTES), ("updated_height", height)):
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
    if action == "arithmetic":
        if args:
            raise ValueError("arithmetic takes no arguments: it reports the frozen C3/C6 planning profile")
        print(json.dumps(arithmetic_report(), indent=2))
    elif action == "clock":
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
    elif action == "abort":
        abort_run(*args)
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
