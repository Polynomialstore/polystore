"""Validation/accounting for bench_retrieval_sessions.sh; Python stdlib only.

Legacy fixture instrumentation and offline C3/C6 planning arithmetic; neither is
a v2 challenge generator or capacity qualification. Malformed query responses
never provide completion evidence. Print the offline report without a node:
    python3 scripts/retrieval_bench_artifact.py arithmetic
"""
import base64
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import json
from math import comb
import os
from pathlib import Path
import platform
import re
import selectors
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
# Local CLI transport limits, not protocol limits. Keep signed transaction
# bodies out of scheduler records; only bounded TxMsgData is retained.
MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_RESPONSE_DATA_BYTES = 16 * 1024


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


def run_bounded_command(argv, deadline):
    """Drain both CLI pipes within one absolute deadline and a combined cap."""
    def remaining():
        seconds = (deadline - monotonic_ns()) / 1e9
        if seconds <= 0:
            raise subprocess.TimeoutExpired(argv, 0)
        return seconds

    remaining()
    # Only failure to launch is an OSError to the caller. Once launched, pipe
    # failures cannot establish that no broadcast took place.
    with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
        try:
            output = [bytearray(), bytearray()]
            total = 0
            with selectors.DefaultSelector() as pipes:
                for index, stream in enumerate((process.stdout, process.stderr)):
                    pipes.register(stream, selectors.EVENT_READ, index)
                while pipes.get_map():
                    for key, _ in pipes.select(remaining()):
                        chunk = os.read(key.fd, min(65536, MAX_COMMAND_OUTPUT_BYTES - total + 1))
                        total += len(chunk)
                        if total > MAX_COMMAND_OUTPUT_BYTES:
                            raise ValueError("CLI output exceeds byte limit")
                        if chunk:
                            output[key.data].extend(chunk)
                        else:
                            pipes.unregister(key.fileobj)
            process.wait(timeout=remaining())
            remaining()
            return subprocess.CompletedProcess(argv, process.returncode,
                                               output[0].decode("utf-8"), output[1].decode("utf-8", errors="replace"))
        except OSError as error:
            raise ValueError("CLI output unavailable: " + str(error)) from error
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()


def scheduled_transaction(job):
    """CLI submit/query adapter; callers must supply a resolved signer address.

    No retries or local sequence cache. The coordinator exclusively owns each
    signer until a committed result, explicit rejection or launch failure; an
    ambiguous broadcast permanently quarantines that signer for this run.
    A committed result can have unusable response data: response_error does not
    change its outcome. Open-session consumers must call opened_session_id on
    the result before preparing a dependent transaction.
    """
    def last_object(output):
        for line in reversed(output.splitlines()):
            try:
                value = json.loads(line)
                if isinstance(value, dict):
                    return value
            except ValueError:
                pass
        # Queries can also use pretty-printed JSON.
        return json.loads(output)

    started = monotonic_ns()
    deadline = started + job["timeout_seconds"] * 1000000000
    try:
        submitted = run_bounded_command(job["submit"], deadline)
    except OSError as error:
        return {"outcome": "not_submitted", "error": str(error)[-8192:]}
    except subprocess.TimeoutExpired:
        return {"outcome": "unknown", "error": "submit timeout"}
    except ValueError as error:
        return {"outcome": "unknown", "error": str(error)[-8192:]}
    checktx_ns = monotonic_ns()
    result = {"outcome": "unknown", "checktx_latency_ns": checktx_ns - started,
              "error": (submitted.stderr + submitted.stdout)[-8192:]}
    try:
        check = last_object(submitted.stdout)
        code = integer(check["code"], "CheckTx code")
        if code:
            return dict(result, outcome="checktx_rejected", code=code)
        txhash = check["txhash"]
        if not isinstance(txhash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", txhash):
            return result
        result["txhash"] = txhash.upper()
    except (ValueError, KeyError, TypeError):
        return result
    while monotonic_ns() < deadline:
        try:
            queried = run_bounded_command([*job["query"], txhash], deadline)
            committed = committed_tx(last_object(queried.stdout), txhash)
            observed = monotonic_ns()
            if observed >= deadline:
                break
            result.update(outcome="committed_success" if int(committed["code"]) == 0 else "committed_failure",
                          code=int(committed["code"]), height=int(committed["height"]),
                          gas_used=int(committed["gas_used"]), gas_wanted=int(committed["gas_wanted"]),
                          commit_observation_latency_ns=observed - started,
                          error=str(committed.get("raw_log", ""))[-8192:])
            try:
                data = committed.get("data", "")
                if (not isinstance(data, str) or len(data) > 2 * MAX_RESPONSE_DATA_BYTES
                        or len(data) % 2 or not re.fullmatch(r"[0-9a-fA-F]*", data)):
                    raise ValueError("invalid or oversized committed TxMsgData")
                if job.get("kind") == "open-session" and result["outcome"] == "committed_success":
                    opened_session_id({"data": data})
                result["data"] = data.lower()
            except ValueError as error:
                result["response_error"] = str(error)
            return result
        except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError) as error:
            result["error"] = str(error)[-8192:]
        time.sleep(min(0.05, max(0, (deadline - monotonic_ns()) / 1e9)))
    return dict(result, error="committed result unavailable: " + result["error"])


def schedule_transactions(jobs, *, max_in_flight, max_queued, max_queued_per_signer, record_transaction=None):
    """Bounded transaction scheduling foundation, not a runtime benchmark mode.

    Jobs are prepared in offered-offset order, with dependency IDs referring only
    to earlier jobs. Submit argv must use --from <resolved address>, not a key
    alias. Address resolution, funding, authentic command construction, artifact
    persistence and final session-state checks belong to the integrating driver.
    The optional record_transaction callback runs only on the coordinator and
    lets that driver persist each terminal result. This helper does not create
    homes, keys or fixtures.
    """
    max_in_flight = integer(max_in_flight, "max_in_flight", 1, 128)
    max_queued = integer(max_queued, "max_queued", 1, 8192)
    max_queued_per_signer = integer(max_queued_per_signer, "max_queued_per_signer", 1, max_queued)
    integer(len(jobs), "jobs", 1, 8192)
    if record_transaction is not None and not callable(record_transaction):
        raise ValueError("record_transaction must be callable")
    jobs = [dict(job) for job in jobs]
    known, operation_phases, previous_offset, measurement_seen = set(), {}, 0, False
    for job in jobs:
        if not isinstance(job.get("id"), str) or not job["id"] or job["id"] in known:
            raise ValueError("transaction IDs must be unique nonempty strings")
        if not isinstance(job.get("operation_id"), str) or not job["operation_id"]:
            raise ValueError("operation_id is required")
        if job.get("phase") not in {"warmup", "measurement"}:
            raise ValueError("phase must be warmup or measurement")
        if operation_phases.setdefault(job["operation_id"], job["phase"]) != job["phase"]:
            raise ValueError("one operation cannot span warmup and measurement")
        if measurement_seen and job["phase"] == "warmup":
            raise ValueError("warmup cannot follow measurement")
        measurement_seen |= job["phase"] == "measurement"
        offset = integer(job["offered_offset_ns"], "offered_offset_ns", previous_offset)
        job["offered_offset_ns"] = offset
        previous_offset = offset
        if not isinstance(job.get("depends_on", []), list) or any(dep not in known for dep in job.get("depends_on", [])):
            raise ValueError("dependencies must identify earlier transactions")
        signer = job.get("signer", "")
        if not isinstance(signer, str) or not signer or signer != signer.lower():
            raise ValueError("signer must be the resolved canonical address")
        for field in ("submit", "query"):
            if not isinstance(job.get(field), list) or not job[field] or any(not isinstance(arg, str) or not arg for arg in job[field]):
                raise ValueError(field + " must be a nonempty argv list")
        submit = job["submit"]
        if submit.count("--from") != 1 or any(arg.startswith("--from=") for arg in submit):
            raise ValueError("submit must use exactly one --from <resolved signer>")
        position = submit.index("--from")
        if position + 1 == len(submit) or submit[position + 1] != signer:
            raise ValueError("submit --from does not match resolved signer")
        job["timeout_seconds"] = integer(job["timeout_seconds"], "timeout_seconds", 1, 60)
        known.add(job["id"])

    start = monotonic_ns()
    pending, running, active, quarantined, records, finished, seen_hashes = [], {}, set(), {}, [], {}, set()
    peak_pending = peak_running = peak_signer_pending = 0
    warmup_overlap = False

    def record(job, result, started=None):
        # Only this coordinator mutates accounting. Duplicate hashes remain
        # visible but never produce another successful transaction/operation.
        item = {"id": job["id"], "operation_id": job["operation_id"], "phase": job["phase"],
                "signer": job["signer"], "kind": job.get("kind", "transaction"), "attempt": 1,
                "offered_ns": start + job["offered_offset_ns"], "started_ns": started,
                "finished_ns": monotonic_ns(), **result}
        if item["outcome"] == "unknown":
            quarantined[job["signer"]] = job["phase"]
        if item.get("txhash"):
            if item["txhash"] in seen_hashes:
                item["original_outcome"], item["outcome"] = item["outcome"], "duplicate"
            else:
                seen_hashes.add(item["txhash"])
        item["queue_latency_ns"] = None if started is None else started - item["offered_ns"]
        item["terminal_latency_ns"] = item["finished_ns"] - item["offered_ns"]
        records.append(item)
        finished[job["id"]] = item
        if record_transaction is not None:
            record_transaction(dict(item))

    with ThreadPoolExecutor(max_workers=max_in_flight) as executor:
        def dispatch():
            nonlocal peak_running
            for job in pending[:]:
                dependencies = [finished.get(dep) for dep in job.get("depends_on", [])]
                if job["signer"] in quarantined:
                    pending.remove(job)
                    record(job, {"outcome": "not_submitted", "error": "signer_quarantined"})
                elif any(dep is not None and dep["outcome"] != "committed_success" for dep in dependencies):
                    pending.remove(job)
                    record(job, {"outcome": "skipped", "error": "dependency_failed"})
                elif len(quarantined) >= max_in_flight:
                    pending.remove(job)
                    record(job, {"outcome": "not_submitted", "error": "unknown_capacity_exhausted"})
                elif len(running) + len(quarantined) < max_in_flight and job["signer"] not in active and all(dep is not None for dep in dependencies):
                    pending.remove(job)
                    active.add(job["signer"])
                    began = monotonic_ns()
                    running[executor.submit(scheduled_transaction, job)] = (job, began)
                    # Unknown broadcasts still consume the global in-flight
                    # budget, even after their worker stops polling.
                    peak_running = max(peak_running, len(running) + len(quarantined))

        index = 0
        while index < len(jobs) or pending or running:
            for future in list(running):
                if future.done():
                    job, began = running.pop(future)
                    active.remove(job["signer"])
                    try:
                        result = future.result()
                    except Exception as error:
                        # Once work was launched, an unexpected adapter error
                        # cannot establish that no broadcast occurred.
                        result = {"outcome": "unknown", "error": str(error)[-8192:]}
                    record(job, result, began)
            dispatch()
            while index < len(jobs) and start + jobs[index]["offered_offset_ns"] <= monotonic_ns():
                job = jobs[index]
                index += 1
                # A finished worker can leave an unresolved warmup broadcast.
                warmup_overlap |= job["phase"] == "measurement" and ("warmup" in quarantined.values() or any(
                    item["phase"] == "warmup" for item in pending + [item for item, _ in running.values()]))
                signer_queued = sum(item["signer"] == job["signer"] for item in pending)
                if job["signer"] in quarantined:
                    record(job, {"outcome": "not_submitted", "error": "signer_quarantined"})
                elif len(pending) >= max_queued or signer_queued >= max_queued_per_signer:
                    record(job, {"outcome": "not_submitted", "error": "queue_full"})
                else:
                    pending.append(job)
                    peak_pending = max(peak_pending, len(pending))
                    peak_signer_pending = max(peak_signer_pending, signer_queued + 1)
                    dispatch()
            if index < len(jobs) or pending or running:
                delay = max(0, (start + jobs[index]["offered_offset_ns"] - monotonic_ns()) / 1e9) if index < len(jobs) else 0.001
                time.sleep(min(0.001 if running else 0.05, delay))

    phases = {}
    for phase in ("warmup", "measurement"):
        items = [item for item in records if item["phase"] == phase]
        phases[phase] = {"offered": len(items), "outcomes": {
            outcome: sum(item["outcome"] == outcome for item in items) for outcome in
            ("committed_success", "committed_failure", "checktx_rejected", "unknown", "not_submitted", "skipped", "duplicate")}}
    grouped, operations = {}, []
    for item in records:
        grouped.setdefault(item["operation_id"], []).append(item)
    for operation, items in grouped.items():
        operations.append({"operation_id": operation,
                           "phase": items[0]["phase"],
                           "all_transactions_committed": all(item["outcome"] == "committed_success" for item in items),
                           "terminal_latency_ns": max(item["finished_ns"] for item in items) - min(item["offered_ns"] for item in items)})
    return {"schema_version": 1, "kind": "retrieval-scheduler-preparation", "qualification": False,
            "started_ns": start, "finished_ns": monotonic_ns(), "transactions": records,
            "phases": phases, "operations": operations, "completed_sessions": None,
            "automatic_submission_retries": False, "quarantined_signers": sorted(quarantined),
            "peak_queued": peak_pending, "peak_in_flight": peak_running,
            "peak_queued_per_signer": peak_signer_pending, "warmup_overlapped_measurement": warmup_overlap,
            "limits": {"max_in_flight": max_in_flight, "max_queued": max_queued,
                       "max_queued_per_signer": max_queued_per_signer},
            "completion_basis": "transaction evidence only; final session state and fresh-proof runtime integration are required"}


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
