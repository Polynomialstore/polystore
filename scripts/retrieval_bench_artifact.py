"""Validation/accounting for bench_retrieval_sessions.sh; Python stdlib only.

Legacy fixture instrumentation, offline C3/C6 arithmetic and bounded v2 proof
preparation; these do not establish capacity qualification. Malformed query responses
never provide completion evidence. Print the offline report without a node:
    python3 scripts/retrieval_bench_artifact.py arithmetic
"""
import base64
import argparse
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
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request


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


def run_bounded_command(argv, deadline, *, env=None):
    """Drain both CLI pipes within one absolute deadline and a combined cap."""
    def remaining():
        seconds = (deadline - monotonic_ns()) / 1e9
        if seconds <= 0:
            raise subprocess.TimeoutExpired(argv, 0)
        return seconds

    remaining()
    # Only failure to launch is an OSError to the caller. Once launched, pipe
    # failures cannot establish that no broadcast took place.
    with subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True, env=env) as process:
        failed = True
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
            result = subprocess.CompletedProcess(argv, process.returncode,
                                                 output[0].decode("utf-8"), output[1].decode("utf-8", errors="replace"))
            failed = False
            return result
        except OSError as error:
            raise ValueError("CLI output unavailable: " + str(error)) from error
        finally:
            if failed:
                # Descendants can inherit the pipes after the leader exits.
                # The new session makes this group exclusively ours to stop.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.wait()


def scheduled_environment(job):
    overrides = job.get("env", {})
    allowed = {"GOMAXPROCS", "POLYSTORE_TRUSTED_SETUP", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"}
    if (not isinstance(overrides, dict) or set(overrides) - allowed or
        any(not isinstance(value, str) or not value or "\0" in value for value in overrides.values())):
        raise ValueError("invalid transaction runtime environment overrides")
    return {"env": dict(os.environ, **overrides)} if overrides else {}


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

    command_options = scheduled_environment(job)
    started = monotonic_ns()
    deadline = min(started + job["timeout_seconds"] * 1000000000, job.get("_deadline_ns", (1 << 63) - 1))
    try:
        submitted = run_bounded_command(job["submit"], deadline, **command_options)
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
        # SDK code 19 reports an identical transaction already in the mempool;
        # it can still commit, so retain signer ownership and query its hash.
        if code and code != 19:
            return dict(result, outcome="checktx_rejected", code=code)
        txhash = check["txhash"]
        if not isinstance(txhash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", txhash):
            return result
        result["txhash"] = txhash.upper()
    except (ValueError, KeyError, TypeError):
        return result
    while monotonic_ns() < deadline:
        try:
            queried = run_bounded_command([*job["query"], txhash], deadline, **command_options)
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


def validate_scheduled_command(job):
    scheduled_environment(job)
    signer = job.get("signer", "")
    if not isinstance(signer, str) or not signer or signer != signer.lower():
        raise ValueError("signer must be the resolved canonical address")
    for field in ("submit", "query"):
        argv = job.get(field)
        if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) or not arg for arg in argv):
            raise ValueError(field + " must be a nonempty argv list")
        if sum(len(arg.encode()) for arg in argv) > 1024 * 1024:
            raise ValueError(field + " argv exceeds 1 MiB")
    submit = job["submit"]
    if submit.count("--from") != 1 or any(arg.startswith("--from=") for arg in submit):
        raise ValueError("submit must use exactly one --from <resolved signer>")
    position = submit.index("--from")
    if position + 1 == len(submit) or submit[position + 1] != signer:
        raise ValueError("submit --from does not match resolved signer")
    job["timeout_seconds"] = integer(job["timeout_seconds"], "timeout_seconds", 1, 60)
    if "_deadline_ns" in job:
        job["_deadline_ns"] = integer(job["_deadline_ns"], "absolute deadline", 1)


def execute_scheduled_transaction(job):
    if "_lifecycle" in job and job["_lifecycle"].mode == "prepared-proof-only":
        return execute_prepared_retrieval_proof(job)
    if "_lifecycle" not in job or job["kind"] != "submit-proof":
        return scheduled_transaction(job)
    lifecycle, state = job["_lifecycle"], job["_state"]
    began = monotonic_ns()
    deadline = min(began + job["timeout_seconds"] * 10**9, job.get("_deadline_ns", (1 << 63) - 1))
    try:
        if began >= deadline:
            raise TimeoutError("proof preparation started after the run deadline")
        # The sole integration function must query the canonical anchored
        # context and build the existing proof, honoring this absolute deadline.
        # It runs on this already bounded worker, never the admission writer.
        prepared = lifecycle.prepare_session_proof(state["operation"], state["session_id"], deadline)
        if not isinstance(prepared, dict) or prepared.get("session_id") != state["session_id"]:
            raise ValueError("prepared proof session does not match committed open")
        for field in ("context_hash", "seed"):
            if not isinstance(prepared.get(field), str) or not re.fullmatch(r"[0-9a-f]{64}", prepared[field]):
                raise ValueError("prepared proof requires canonical " + field)
        command_job = dict(job, submit=prepared["submit"], _deadline_ns=deadline)
        validate_scheduled_command(command_job)
        if monotonic_ns() >= deadline:
            raise TimeoutError("proof preparation exhausted the stage deadline")
    except Exception as error:
        # Preparation has no broadcast authority. A failed/malformed builder
        # must never turn into a signed transaction or quarantine the account.
        return {"outcome": "not_submitted", "error": "proof_preparation_failed: " + str(error)[-8192:],
                "preparation_latency_ns": monotonic_ns() - began}
    preparation_ns = monotonic_ns() - began
    result = scheduled_transaction(command_job)
    return dict(result, session_id=state["session_id"], context_hash=prepared["context_hash"], seed=prepared["seed"],
                preparation_latency_ns=preparation_ns)


def prepared_session_pin(operation, evidence):
    """Validate an owned-node, height-attested OPEN response and its anchor.

    The integrating read callback owns HTTP/node identity and height attestation.
    This helper authenticates response contents against independent caller intent;
    it neither fetches data nor changes the producer's accepted state contract.
    """
    import retrieval_fresh_proof as producer
    if not isinstance(evidence, dict) or len(json.dumps(evidence).encode()) > 65536:
        raise ValueError("prepared session evidence exceeds 64 KiB or is not an object")
    height = integer(evidence["height"], "attested session height", 1)
    sid = operation["prepared"]["session_id"]
    if not isinstance(sid, str) or not re.fullmatch(r"[0-9a-f]{64}", sid):
        raise ValueError("prepared session ID must be canonical hex")
    view = evidence["view"]
    c, digest = producer.frozen_context(view, operation["proof_expectation"], sid, height)
    if view["session"]["status"] not in (1, "RETRIEVAL_SESSION_STATUS_OPEN") or height < c["first_response_height"]:
        raise ValueError("prepared proof-only session must be anchored and OPEN")
    if operation["submit-proof"]["signer"] != view["session"]["authorized_proof_provider"]:
        raise ValueError("prepared proof signer differs from frozen payee")
    seed = producer.b64(view["challenge_seed"], 32)
    anchor = evidence["anchor"]
    header = anchor["block"]["header"]
    block_hash = anchor["block_id"]["hash"]
    if (producer.uint(header["height"]) != c["anchor_height"] or header["chain_id"] != c["chain_id"] or
        not isinstance(block_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", block_hash) or bytes.fromhex(block_hash) != seed):
        raise ValueError("prepared seed differs from committed anchor")
    return dict(height=height, context=c, context_hash=digest.hex(), seed=seed.hex(), view=view)


def validate_prepared_proof_file(operation, pin):
    """Bind the exact CLI payload, session and ordered fresh challenges to a hash."""
    import retrieval_fresh_proof as producer
    prepared, job = operation["prepared"], operation["submit-proof"]
    path, digest = prepared["proof_path"], prepared["proof_sha256"]
    if (not isinstance(path, str) or not Path(path).is_absolute() or not Path(path).is_file() or
        not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest)):
        raise ValueError("prepared proof requires an absolute path and canonical SHA256")
    argv = job["submit"]
    if argv[1:5] != ["tx", "nilchain", "submit-retrieval-proof", path] or argv.count(path) != 1:
        raise ValueError("prepared command must submit the pinned proof file")
    payload, raw = producer.read_json(path)
    if hashlib.sha256(raw).hexdigest() != digest or producer.b64(payload["session_id"], 32).hex() != prepared["session_id"]:
        raise ValueError("prepared proof digest or session mismatch")
    c = pin["context"]
    proofs = payload["proofs"]
    if not isinstance(proofs, list) or len(proofs) != c["blob_count"]:
        raise ValueError("prepared proof count differs from pinned range")
    for ordinal, proof in enumerate(proofs):
        leaf = c["start_leaf"] + ordinal
        z = producer.fresh_z(bytes.fromhex(pin["context_hash"]), bytes.fromhex(pin["seed"]), ordinal, c["start_mdu"], leaf)
        if (producer.uint(proof["mdu_index"]) != c["start_mdu"] or producer.uint(proof.get("blob_index", 0)) != leaf or
            producer.b64(proof["z_value"], 32) != z):
            raise ValueError("prepared proof tuple or challenge differs from anchored context")


def execute_prepared_retrieval_proof(job):
    lifecycle, state = job["_lifecycle"], job["_state"]
    operation, sid = state["operation"], state["session_id"]
    began = monotonic_ns()
    deadline = min(began + job["timeout_seconds"] * 10**9, job.get("_deadline_ns", (1 << 63) - 1))
    try:
        if began >= deadline:
            raise TimeoutError("prepared proof started after the run deadline")
        evidence = lifecycle.read_session_evidence(operation, sid, None, deadline)
        pin = prepared_session_pin(operation, evidence)
        original = state["proof_pin"]
        if pin["height"] < original["height"] or any(pin[name] != original[name] for name in ("context", "context_hash", "seed", "view")):
            raise ValueError("prepared session changed or response height regressed")
        validate_prepared_proof_file(operation, pin)
        if monotonic_ns() >= deadline:
            raise TimeoutError("prepared validation exhausted the stage deadline")
    except Exception as error:
        return {"outcome": "not_submitted", "error": "prepared_proof_validation_failed: " + str(error)[-8192:]}
    validation_ns = monotonic_ns() - began
    result = scheduled_transaction(dict(job, _deadline_ns=deadline))
    result.update(session_id=sid, context_hash=pin["context_hash"], seed=pin["seed"],
                  proof_sha256=operation["prepared"]["proof_sha256"], proof_state_verified=False,
                  pre_submission_evidence=evidence, prepared_validation_latency_ns=validation_ns)
    if result["outcome"] == "committed_success":
        try:
            if monotonic_ns() >= deadline:
                raise TimeoutError("committed state verification deadline")
            height = integer(result["height"], "committed proof height", pin["height"])
            after = lifecycle.read_session_evidence(operation, sid, height, deadline)
            if monotonic_ns() >= deadline or after["height"] != height or height > pin["context"]["deadline_height"]:
                raise ValueError("proof state response has wrong height or expired deadline")
            if len(json.dumps(after).encode()) > 65536:
                raise ValueError("proof state response exceeds 64 KiB")
            view = after["view"]
            session = view["session"]
            if session["status"] not in (2, "RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED") or integer(session["updated_height"], "proof updated height") != height:
                raise ValueError("committed proof did not attest PROOF_SUBMITTED at its transaction height")
            # Compare immutable fields directly to the authenticated OPEN pin.
            # No status rewriting or broadened producer trust semantics.
            for name in ("challenge_context", "challenge_context_hash", "challenge_seed"):
                if view[name] != pin["view"][name]:
                    raise ValueError("committed proof changed frozen context or seed")
            if ({k: v for k, v in session.items() if k not in ("status", "updated_height")} !=
                {k: v for k, v in pin["view"]["session"].items() if k not in ("status", "updated_height")} or after["anchor"] != evidence["anchor"]):
                raise ValueError("committed proof changed session funding, identity or anchor")
            result.update(proof_state_verified=True, post_submission_evidence=after)
        except Exception as error:
            # The known committed transaction remains known; it is not a verified
            # proof-state result and never authorizes confirmation or resubmission.
            result["state_evidence_error"] = str(error)[-8192:]
    return result


def fresh_session_proof_builder(config, output_directory):
    """Build the existing lifecycle callback; no signing authority in the child.

    config supplies owned rpc/api URLs, node_id, library, setup and Go fixture
    directory. Each operation supplies proof_expectation (the pinned intent
    documented in retrieval_fresh_proof.frozen_context) and proof_submit argv
    containing one {proof_path}. Outputs live in a newly owned private directory.
    Native setup/loading, node queries and file writes share the stage deadline.
    """
    config = dict(config)
    for name in ("library", "setup", "fixture"):
        config[name] = str(Path(config[name]).resolve(strict=True))
    output_directory = Path(output_directory).absolute()
    output_directory.mkdir(mode=0o700)

    def prepare_session_proof(operation, session_id, deadline_ns):
        if not isinstance(session_id, str) or not re.fullmatch(r"[0-9a-f]{64}", session_id):
            raise ValueError("invalid committed session ID")
        argv = operation["proof_submit"]
        if not isinstance(argv, list) or not argv or any(not isinstance(arg, str) or not arg for arg in argv) or argv.count("{proof_path}") != 1:
            raise ValueError("proof_submit requires exactly one standalone {proof_path}")
        expected = operation["proof_expectation"]
        if expected["session"]["authorized_proof_provider"] != operation["submit-proof"]["signer"]:
            raise ValueError("frozen proof authority differs from scheduled signer")
        if expected["session"]["owner"] != operation["open-session"]["signer"] or expected["session"]["owner"] != operation["confirm"]["signer"]:
            raise ValueError("frozen owner differs from scheduled lifecycle signer")
        output = output_directory / (session_id + ".json")
        request = dict(config=config, expected=expected, session_id=session_id,
                       deadline=deadline_ns, output=str(output))
        encoded = json.dumps(request, separators=(",", ":"))
        if len(encoded.encode()) > 65536:
            raise ValueError("proof preparation request exceeds 64 KiB")
        result = run_bounded_command([sys.executable, str(Path(__file__).with_name("retrieval_fresh_proof.py")), encoded], deadline_ns)
        if result.returncode:
            raise ValueError("native proof preparation failed: " + result.stderr[-8192:])
        prepared = json.loads(result.stdout.strip().splitlines()[-1])
        if prepared.get("session_id") != session_id or not output.is_file():
            raise ValueError("producer did not retain the expected proof")
        return dict(prepared, submit=[str(output) if arg == "{proof_path}" else arg for arg in argv])

    return prepare_session_proof


class RetrievalLifecycleJournal:
    """One writer, disk-backed run-wide dedup, and the concrete open/proof/confirm stages.

    This does not establish proof validity from metadata. The integrating native
    builder owns authoritative context/anchor reads and cryptographic generation.
    No session-completion count is exposed until final state/economic checks land.
    """
    stages = ("open-session", "submit-proof", "confirm")

    def __init__(self, path, signers, prepare_session_proof, *, mode="lifecycle", read_session_evidence=None):
        self.path = Path(path)
        if mode not in ("lifecycle", "prepared-proof-only"):
            raise ValueError("invalid retrieval scheduling mode")
        if mode == "lifecycle" and not callable(prepare_session_proof):
            raise ValueError("prepare_session_proof is required")
        if mode == "prepared-proof-only" and not callable(read_session_evidence):
            raise ValueError("read_session_evidence is required for prepared proof-only scheduling")
        self.mode, self.read_session_evidence = mode, read_session_evidence
        if not isinstance(signers, (list, tuple)) or not 1 <= len(signers) <= 128:
            raise ValueError("declare 1..128 resolved signers before admission")
        if any(not isinstance(s, str) or not s or s != s.lower() for s in signers) or len(set(signers)) != len(signers):
            raise ValueError("declared signers must be unique canonical addresses")
        self.signers, self.prepare_session_proof = frozenset(signers), prepare_session_proof
        # Exclusive creation prevents accidental append/replay of an old run.
        descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
        self.db = sqlite3.connect(self.path)
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            PRAGMA cache_size=-2048;
            CREATE TABLE operations (id TEXT PRIMARY KEY, phase TEXT NOT NULL, result TEXT);
            CREATE TABLE hashes (hash TEXT PRIMARY KEY);
            CREATE TABLE proof_sessions (session_id TEXT PRIMARY KEY);
            CREATE TABLE transactions (id TEXT PRIMARY KEY, phase TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL);
            CREATE TABLE run (status TEXT NOT NULL, result TEXT);
            INSERT INTO run(status) VALUES ('running');
        """)
        self.previous_offset, self.measurement_seen = 0, False

    def initial(self, operation):
        if not isinstance(operation, dict) or len(json.dumps(operation).encode()) > 65536:
            raise ValueError("operation must be a JSON object of at most 64 KiB")
        operation = json.loads(json.dumps(operation))
        identity, phase = operation.get("operation_id"), operation.get("phase")
        if not isinstance(identity, str) or not 1 <= len(identity) <= 256:
            raise ValueError("operation_id must contain 1..256 characters")
        if phase not in ("warmup", "measurement") or (self.measurement_seen and phase == "warmup"):
            raise ValueError("warmup must precede measurement")
        self.measurement_seen |= phase == "measurement"
        offset = integer(operation["offered_offset_ns"], "offered_offset_ns", self.previous_offset)
        self.previous_offset = offset
        operation["offered_offset_ns"] = offset
        if self.mode == "prepared-proof-only":
            if "open-session" in operation or "confirm" in operation:
                raise ValueError("prepared proof-only operations cannot contain open or confirm stages")
            job = operation["submit-proof"]
            if job.get("signer") not in self.signers:
                raise ValueError("proof signer is not a declared resolved account")
            prepared = operation["prepared"]
            check = dict(job)
            if prepared is None:
                check["submit"] = ["inventory-depleted", "--from", job["signer"]]
                pin, sid = None, None
            else:
                pin = prepared_session_pin(operation, prepared["evidence"])
                validate_prepared_proof_file(operation, pin)
                sid = prepared["session_id"]
            validate_scheduled_command(check)
            job["timeout_seconds"] = check["timeout_seconds"]
            return self.stage_job(dict(operation=operation, session_id=sid, proof_pin=pin, committed_stages=0), "submit-proof")
        for stage in self.stages:
            template = operation[stage]
            if template.get("signer") not in self.signers:
                raise ValueError("stage signer is not a declared resolved account")
            # The provider submit argv is supplied only after the anchored
            # proof exists. Validate the known query/deadline/signing identity now.
            check = dict(template)
            if stage == "submit-proof":
                if "submit" in template:
                    raise ValueError("fresh proof submit must be built after committed open")
                check["submit"] = ["pending-proof", "--from", template["signer"]]
            validate_scheduled_command(check)
            template["timeout_seconds"] = check["timeout_seconds"]
        if not any("{session_id}" in arg for arg in operation["confirm"]["submit"]):
            raise ValueError("confirmation must bind the newly opened session ID")
        state = {"operation": operation, "session_id": None, "committed_stages": 0}
        return self.stage_job(state, "open-session")

    def stage_job(self, state, stage):
        operation = state["operation"]
        template = json.loads(json.dumps(operation[stage]))
        if stage == "confirm":
            template["submit"] = [arg.replace("{session_id}", state["session_id"]) for arg in template["submit"]]
        return dict(template, id=json.dumps([operation["operation_id"], stage], separators=(",", ":")),
                    operation_id=operation["operation_id"], phase=operation["phase"],
                    offered_offset_ns=operation["offered_offset_ns"], kind=stage, depends_on=[],
                    _state=state, _lifecycle=self)

    def admit(self, job):
        with self.db:
            self.db.execute("INSERT INTO operations(id, phase) VALUES (?, ?)", (job["operation_id"], job["phase"]))
            if self.mode == "prepared-proof-only" and job["_state"]["session_id"] is not None:
                self.db.execute("INSERT INTO proof_sessions VALUES (?)", (job["_state"]["session_id"],))

    def record(self, job, item):
        state = job["_state"]
        next_job, error = None, None
        with self.db:
            txhash = item.get("txhash")
            if txhash:
                if not re.fullmatch(r"[0-9a-fA-F]{64}", txhash):
                    raise ValueError("invalid adapter transaction hash")
                item["txhash"] = txhash.upper()
                inserted = self.db.execute("INSERT OR IGNORE INTO hashes VALUES (?)", (item["txhash"],)).rowcount
                if not inserted:
                    item["original_outcome"], item["outcome"] = item["outcome"], "duplicate"
            if item["outcome"] == "committed_success":
                state["committed_stages"] += 1
                try:
                    if self.mode == "prepared-proof-only":
                        pass  # No followup stage, including for a committed proof.
                    elif job["kind"] == "open-session":
                        state["session_id"] = opened_session_id(item)
                        next_job = self.stage_job(state, "submit-proof")
                    elif job["kind"] == "submit-proof":
                        next_job = self.stage_job(state, "confirm")
                except (ValueError, KeyError, TypeError) as invalid:
                    error = "stage_response_invalid: " + str(invalid)
            depleted = self.mode == "prepared-proof-only" and state["operation"]["prepared"] is None
            if not depleted:
                self.db.execute("INSERT INTO transactions VALUES (?, ?, ?, ?)",
                                (item["id"], item["phase"], item["outcome"], json.dumps(item)))
            if next_job is None:
                result = {"operation_id": job["operation_id"], "phase": job["phase"],
                          "all_transactions_committed": state["committed_stages"] == 3 and error is None,
                          "session_id": state["session_id"], "last_stage": job["kind"],
                          "terminal_latency_ns": item["terminal_latency_ns"],
                          "error": error or item.get("error", "")}
                if self.mode == "prepared-proof-only":
                    result.update(outcome=item["outcome"], all_transactions_committed=state["committed_stages"] == 1,
                        proof_submitted=item["outcome"] == "committed_success" and item.get("proof_state_verified") is True,
                        completed_session=False, inventory_depleted=depleted,
                        state_evidence_error=item.get("state_evidence_error", ""))
                self.db.execute("UPDATE operations SET result=? WHERE id=?", (json.dumps(result), job["operation_id"]))
        return next_job

    def phases(self):
        phases = {phase: {"offered": 0, "offered_operations": 0, "outcomes": {}} for phase in ("warmup", "measurement")}
        for phase, outcome, count in self.db.execute("SELECT phase, outcome, COUNT(*) FROM transactions GROUP BY phase, outcome"):
            phases[phase]["offered"] += count
            phases[phase]["outcomes"][outcome] = count
        for phase, count in self.db.execute("SELECT phase, COUNT(*) FROM operations GROUP BY phase"):
            phases[phase]["offered_operations"] = count
        if self.mode == "prepared-proof-only":
            for counts in phases.values():
                counts.update(proof_submitted=0, inventory_depleted=0, completed_sessions=0)
            for phase, result in self.db.execute("SELECT phase, result FROM operations WHERE result IS NOT NULL"):
                row = json.loads(result)
                for field in ("proof_submitted", "inventory_depleted"):
                    phases[phase][field] += int(row[field])
        return phases


def schedule_retrieval_lifecycles(operations, *, journal_path, signers, prepare_session_proof=None,
                                 max_in_flight, max_queued, max_queued_per_signer,
                                 mode="lifecycle", read_session_evidence=None):
    """Incremental open -> anchored proof -> confirm preparation; no runtime qualification.

    Operations arrive in absolute offered-offset order with one lookahead. The
    builder may only read context/build a proof, never broadcast, and must honor
    its deadline. It returns existing submit argv plus session_id/context_hash/
    seed provenance. All stages retain the operation's original offered time.
    Final rows live in the SQLite ledger, not an ever-growing in-memory list.

    mode='prepared-proof-only' accepts offered slots with submit-proof plus
    prepared={session_id,proof_path,proof_sha256,evidence:{height,view,anchor}}
    and independent proof_expectation. prepared=None declares an empty inventory
    slot, not an offered transaction. read_session_evidence(operation, session_id,
    height, deadline_ns) returns owned-node height-attested evidence: height=None
    requests current state, otherwise exactly that committed height. The callback
    must honor the shared absolute deadline and cannot broadcast. Pre-opening and
    proof generation are excluded; fresh state reads and digest checks are included.
    Prepared inputs retain the producer's maintained slot-zero K8/K2 fixture
    restrictions. This mode does not qualify delivered bytes or storage audits.
    """
    lifecycle = RetrievalLifecycleJournal(journal_path, signers, prepare_session_proof,
                                          mode=mode, read_session_evidence=read_session_evidence)
    try:
        result = schedule_transactions(operations, max_in_flight=max_in_flight, max_queued=max_queued,
                                       max_queued_per_signer=max_queued_per_signer, _lifecycle=lifecycle)
        with lifecycle.db:
            lifecycle.db.execute("UPDATE run SET status='finished', result=?", (json.dumps(result),))
        return result
    except BaseException as error:
        with lifecycle.db:
            lifecycle.db.execute("UPDATE run SET status='aborted', result=?", (str(error)[-8192:],))
        raise
    finally:
        lifecycle.db.close()


def schedule_transactions(jobs, *, max_in_flight, max_queued, max_queued_per_signer, record_transaction=None, _lifecycle=None):
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
    if _lifecycle is None:
        integer(len(jobs), "jobs", 1, 8192)
    if record_transaction is not None and not callable(record_transaction):
        raise ValueError("record_transaction must be callable")
    jobs = [dict(job) for job in jobs] if _lifecycle is None else iter(jobs)
    known, operation_phases, previous_offset, measurement_seen = set(), {}, 0, False
    for job in jobs if _lifecycle is None else ():
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
        validate_scheduled_command(job)
        known.add(job["id"])

    start = monotonic_ns()
    pending, running, active, quarantined, records, finished, seen_hashes = [], {}, set(), {}, [], {}, set()
    peak_pending = peak_running = peak_signer_pending = peak_operation_states = 0
    warmup_overlap = False
    followups = []

    def record(job, result, started=None):
        # Only this coordinator mutates accounting. Duplicate hashes remain
        # visible but never produce another successful transaction/operation.
        item = {"id": job["id"], "operation_id": job["operation_id"], "phase": job["phase"],
                "signer": job["signer"], "kind": job.get("kind", "transaction"), "attempt": 1,
                "offered_ns": start + job["offered_offset_ns"], "started_ns": started,
                "finished_ns": monotonic_ns(), **result}
        if item["outcome"] == "unknown":
            quarantined[job["signer"]] = job["phase"]
        if _lifecycle is None and item.get("txhash"):
            if item["txhash"] in seen_hashes:
                item["original_outcome"], item["outcome"] = item["outcome"], "duplicate"
            else:
                seen_hashes.add(item["txhash"])
        item["queue_latency_ns"] = None if started is None else started - item["offered_ns"]
        item["terminal_latency_ns"] = item["finished_ns"] - item["offered_ns"]
        if _lifecycle is not None:
            item["enqueued_ns"] = job["_enqueued_ns"]
            item["queue_latency_ns"] = None if started is None else started - item["enqueued_ns"]
            item["stage_latency_ns"] = item["finished_ns"] - item["enqueued_ns"]
        if _lifecycle is None:
            records.append(item)
            finished[job["id"]] = item
        else:
            next_job = _lifecycle.record(job, item)
            if next_job is not None:
                followups.append(next_job)
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
                    running[executor.submit(execute_scheduled_transaction, job)] = (job, began)
                    # Unknown broadcasts still consume the global in-flight
                    # budget, even after their worker stops polling.
                    peak_running = max(peak_running, len(running) + len(quarantined))

        source = iter(jobs)
        exhausted = object()
        def next_offered():
            item = next(source, exhausted)
            if item is exhausted:
                return None
            return _lifecycle.initial(item) if _lifecycle is not None else item

        offered = next_offered()
        def enqueue(job):
            nonlocal warmup_overlap, peak_pending, peak_signer_pending
            job["_enqueued_ns"] = monotonic_ns()
            if _lifecycle is not None and _lifecycle.mode == "prepared-proof-only" and job["_state"]["operation"]["prepared"] is None:
                record(job, {"outcome": "not_submitted", "error": "inventory_depleted"})
                return
            # A finished worker can leave an unresolved warmup broadcast.
            warmup_overlap |= job["phase"] == "measurement" and ("warmup" in quarantined.values() or any(
                item["phase"] == "warmup" for item in pending + followups + [item for item, _ in running.values()]))
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

        def collect(future):
            job, began = running.pop(future)
            active.remove(job["signer"])
            try:
                result = future.result()
            except Exception as error:
                # Once work was launched, an unexpected adapter error
                # cannot establish that no broadcast occurred.
                result = {"outcome": "unknown", "error": str(error)[-8192:]}
            record(job, result, began)

        try:
            while offered is not None or pending or running or followups:
                for future in list(running):
                    if future.done():
                        collect(future)
                dispatch()
                while followups:
                    enqueue(followups.pop(0))
                while offered is not None and start + offered["offered_offset_ns"] <= monotonic_ns():
                    job = offered
                    if _lifecycle is not None:
                        _lifecycle.admit(job)
                    enqueue(job)
                    offered = next_offered()
                    # Yield to completed workers even under an indefinitely due
                    # offered stream. The schedule never resets to completion time.
                    if _lifecycle is not None:
                        break
                if _lifecycle is not None:
                    retained = pending + followups + [item for item, _ in running.values()] + ([offered] if offered else [])
                    peak_operation_states = max(peak_operation_states, len({id(item["_state"]) for item in retained}))
                if offered is not None or pending or running or followups:
                    delay = max(0, (start + offered["offered_offset_ns"] - monotonic_ns()) / 1e9) if offered is not None else 0.001
                    time.sleep(min(0.001 if running else 0.05, delay))
        except BaseException:
            # Stopping admission does not undo a broadcast. Drain the bounded
            # launched attempts before closing the journal, without dispatching
            # their followups or any other queued stage.
            for future in list(running):
                collect(future)
            for job in pending + followups:
                job.setdefault("_enqueued_ns", monotonic_ns())
                record(job, {"outcome": "not_submitted", "error": "run_aborted"})
            raise

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
    report = {"schema_version": 1, "kind": "retrieval-scheduler-preparation", "qualification": False,
            "started_ns": start, "finished_ns": monotonic_ns(), "transactions": records,
            "phases": phases, "operations": operations, "completed_sessions": None,
            "automatic_submission_retries": False, "quarantined_signers": sorted(quarantined),
            "peak_queued": peak_pending, "peak_in_flight": peak_running,
            "peak_queued_per_signer": peak_signer_pending, "warmup_overlapped_measurement": warmup_overlap,
            "limits": {"max_in_flight": max_in_flight, "max_queued": max_queued,
                       "max_queued_per_signer": max_queued_per_signer},
            "completion_basis": "transaction evidence only; final session state and fresh-proof runtime integration are required"}
    if _lifecycle is not None:
        report.update(kind="incremental-retrieval-lifecycle-preparation", journal_path=str(_lifecycle.path),
                      transactions=None, operations=None, phases=_lifecycle.phases(),
                      peak_retained_operation_states=peak_operation_states)
        if _lifecycle.mode == "prepared-proof-only":
            report.update(kind="prepared-retrieval-proof-only-preparation", completed_sessions=0,
                proof_submitted=sum(phase["proof_submitted"] for phase in report["phases"].values()),
                inventory_depleted=sum(phase["inventory_depleted"] for phase in report["phases"].values()),
                source_exhausted=True,
                preparation_excluded=["session opening", "anchor waiting", "native proof generation"],
                completion_basis="committed transaction plus pinned PROOF_SUBMITTED state; no confirmations or completed sessions")
    return report


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
             "scripts/retrieval_fresh_proof.py",
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


def set_toml_value(text, section, key, value):
    """Change one generated setting, rejecting template drift instead of guessing."""
    current, matches, lines = "", 0, []
    for line in text.splitlines(keepends=True):
        header = re.fullmatch(r"\s*\[([^]]+)\]\s*", line.strip())
        if header:
            current = header[1]
        if current == section and re.match(r"\s*" + re.escape(key) + r"\s*=", line):
            line = f"{key} = {value}\n"
            matches += 1
        lines.append(line)
    if matches != 1:
        raise ValueError(f"expected one [{section}] {key} setting, got {matches}")
    return "".join(lines)


class FourValidatorLifecycle:
    """Owned local startup/persistence evidence, not a transaction load driver."""

    def __init__(self, binary, library, home, timeout=180, gomaxprocs=2):
        self.root = Path(__file__).resolve().parent.parent
        self.binary, self.library = Path(binary).resolve(strict=True), Path(library).resolve(strict=True)
        if not self.binary.is_file() or not os.access(self.binary, os.X_OK):
            raise ValueError("binary must be an executable file")
        if not self.library.is_file() or self.library.name not in ("libpolystore_core.so", "libpolystore_core.dylib"):
            raise ValueError("library must be the supplied libpolystore_core.so or .dylib")
        requested = Path(os.path.abspath(home))
        self.home = requested.parent.resolve(strict=True) / requested.name
        # No cleanup by pathname. These private persistent homes are retained,
        # including on failure; multi-node receives only a new child directory.
        if os.path.lexists(self.home):
            raise ValueError("home must not already exist: " + str(self.home))
        self.deadline = monotonic_ns() + integer(timeout, "timeout", 30, 900) * 10**9
        self.env = dict(os.environ, GOMAXPROCS=str(integer(gomaxprocs, "gomaxprocs", 1, 64)),
                        POLYSTORE_TRUSTED_SETUP=str(self.root / "polystorechain/trusted_setup.txt"))
        for variable in ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
            self.env[variable] = str(self.library.parent) + (":" + self.env[variable] if self.env.get(variable) else "")
        self.chain = "polystore_260-1"
        self.nodes = [{"home": str(self.home / "nodes" / f"validator{i}"), "rpc": 26657 - 3*i,
                       "p2p": 26656 - 3*i, "grpc": 9090 - 2*i, "api": 1317 - i,
                       "metrics": 26660 + i} for i in range(4)]
        self.processes, self.reservations, self.signers = [], [], {}
        self.doc = {"schema_version": 1, "mode": "four-validator-lifecycle", "qualification": False,
                    "status": "preparing", "topology": "four processes on one local host",
                    "workload": "none", "transactions_submitted": 0, "chain_id": self.chain,
                    "commands": [], "nodes": self.nodes, "signers": self.signers, "validator_resources": [],
                    "limits": ["No retrieval, delivery, adversarial transaction or capacity qualification",
                               "Fixed-height bank state only; no retrieval economic conservation claim",
                               "Restart preserves homes; no export/import or migration claim"]}

    def remaining(self):
        seconds = (self.deadline - monotonic_ns()) / 1e9
        if seconds <= 0:
            raise TimeoutError("four-validator lifecycle deadline exceeded")
        return min(seconds, 5)

    def cli(self, home, *args):
        argv = [str(self.binary), *map(str, args), "--home", str(home)]
        self.doc["commands"].append(argv)
        result = run_bounded_command(argv, self.deadline, env=self.env)
        if result.returncode:
            raise ValueError("CLI failed: " + (result.stderr + result.stdout)[-8192:])
        return result.stdout.strip()

    def save(self):
        temporary = self.home / "evidence.json.tmp"
        temporary.write_text(json.dumps(self.doc, indent=2) + "\n")
        temporary.replace(self.home / "evidence.json")

    def reserve_ports(self):
        for node in self.nodes:
            for name in ("rpc", "p2p", "grpc", "api", "metrics"):
                reservation = socket.socket()
                self.reservations.append(reservation)
                # Allow our stopped server's TIME_WAIT connections, while
                # listen keeps the reservation exclusive (no SO_REUSEPORT).
                reservation.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                reservation.bind(("127.0.0.1", node[name]))
                reservation.listen(1)

    def prepare(self):
        self.cli(self.home / "bootstrap", "multi-node", "--v", "4", "--output-dir", self.home / "nodes",
                 "--node-dir-prefix", "validator", "--chain-id", self.chain,
                 "--starting-ip-address", "127.0.0.1", "--list-ports", "26657,26654,26651,26648",
                 "--validators-stake-amount", "100000000,100000000,100000000,100000000",
                 "--keyring-backend", "test")
        first = Path(self.nodes[0]["home"])
        # Sixteen independent owners can offer full lifecycle traffic while twelve
        # providers cover the default RS(8,12) placement. Control transactions
        # use their own signer and cannot race workload account sequences.
        names = [f"owner{i}" for i in range(16)] + [f"provider{i}" for i in range(12)] + ["control"]
        for name in names:
            self.cli(first, "keys", "add", name, "--keyring-backend", "test", "--output", "json")
            address = self.cli(first, "keys", "show", name, "-a", "--keyring-backend", "test")
            if not re.fullmatch(r"nil1[0-9a-z]{20,80}", address) or address in self.signers.values():
                raise ValueError("workload signers must resolve to distinct actual accounts")
            self.signers[name] = address
            self.cli(first, "genesis", "add-genesis-account", address,
                     "100000000000stake,1000000000000000000aatom", "--keyring-backend", "test")
        genesis = json.loads((first / "config/genesis.json").read_text())
        consensus = json.loads((self.root / "scripts/retrieval_consensus_profile.json").read_text())
        if consensus["block"] != {"max_bytes": "2097152", "max_gas": "64000000"}:
            raise ValueError("four-validator frozen consensus profile changed")
        genesis["consensus"]["params"]["block"].update(consensus["block"])
        params = genesis["app_state"]["nilchain"]["params"]
        if "retrieval_v2_activation_height" not in params:
            raise ValueError("binary genesis does not expose v2 activation")
        params["retrieval_v2_activation_height"] = "1"
        metadata = genesis["app_state"]["bank"].setdefault("denom_metadata", [])
        if any(item.get("base") == "aatom" for item in metadata):
            raise ValueError("aatom metadata already present; review generated defaults")
        metadata.append({"description": "EVM fee token metadata", "denom_units": [
            {"denom": "aatom", "exponent": 0, "aliases": ["uatom"]},
            {"denom": "atom", "exponent": 18, "aliases": []}], "base": "aatom", "display": "atom",
            "name": "Atom", "symbol": "ATOM", "uri": "", "uri_hash": ""})
        frozen = json.dumps(genesis, sort_keys=True, indent=1) + "\n"
        for node in self.nodes:
            home = Path(node["home"])
            (home / "config/genesis.json").write_text(frozen)
            self.cli(home, "genesis", "validate")
            path = home / "config/config.toml"
            config = path.read_text()
            for section, key, value in (("consensus", "timeout_commit", '"1s"'),
                                        ("p2p", "addr_book_strict", "false"),
                                        ("instrumentation", "prometheus", "true"),
                                        ("instrumentation", "prometheus_listen_addr", f'"127.0.0.1:{node["metrics"]}"')):
                config = set_toml_value(config, section, key, value)
            path.write_text(config)
            app_path = home / "config/app.toml"
            app_path.write_text(set_toml_value(app_path.read_text(), "api", "address",
                                              f'"tcp://127.0.0.1:{node["api"]}"'))
            node["node_id"] = self.cli(home, "comet", "show-node-id")
            if not re.fullmatch(r"[0-9a-f]{40}", node["node_id"]):
                raise ValueError("invalid generated node identity")
            # Retain only the public half of the consensus identity in artifacts.
            node["validator_key"] = json.loads((home / "config/priv_validator_key.json").read_text())["pub_key"]
            key = node["validator_key"]
            if key.get("type") != "tendermint/PubKeyEd25519" or len(base64.b64decode(key["value"], validate=True)) != 32:
                raise ValueError("invalid generated validator public key")
            node["config_sha256"] = sha256(path)
            node["app_config_sha256"] = sha256(home / "config/app.toml")
        if len({node["node_id"] for node in self.nodes}) != 4 or len({json.dumps(node["validator_key"], sort_keys=True) for node in self.nodes}) != 4:
            raise ValueError("expected four independent node and voting keys")
        self.doc.update(genesis_sha256=sha256(first / "config/genesis.json"), frozen_module_params=params,
                        profile={"consensus": consensus, "timeout_commit": "1s", "execution_budget_ms": 700,
                                 "memory_ceiling_per_validator_bytes": 2147483648, "budgets_measured": False,
                                 "GOMAXPROCS": self.env["GOMAXPROCS"]})

    def start(self, phase):
        for field, path in (("binary_sha256", self.binary), ("native_library_sha256", self.library),
                            ("trusted_setup_sha256", self.env["POLYSTORE_TRUSTED_SETUP"])):
            if sha256(path) != self.doc["provenance"][field]:
                raise ValueError("supplied runtime artifact changed before start/restart")
        for reservation in self.reservations:
            reservation.close()
        self.reservations.clear()
        for node in self.nodes:
            home = Path(node["home"])
            if (sha256(home / "config/genesis.json") != self.doc["genesis_sha256"] or
                sha256(home / "config/config.toml") != node["config_sha256"] or
                sha256(home / "config/app.toml") != node["app_config_sha256"]):
                raise ValueError("persistent node configuration changed")
            argv = [str(self.binary), "start", "--home", str(home),
                    "--rpc.laddr", f'tcp://127.0.0.1:{node["rpc"]}',
                    "--p2p.laddr", f'tcp://127.0.0.1:{node["p2p"]}',
                    "--grpc.address", f'127.0.0.1:{node["grpc"]}',
                    "--api.enable=true",
                    "--grpc-web.enable=false", "--json-rpc.enable=false", "--minimum-gas-prices", "0.001aatom"]
            self.doc["commands"].append(argv)
            with (home / f"{phase}.log").open("xb") as log:
                process = subprocess.Popen(argv, env=self.env, stdout=log, stderr=subprocess.STDOUT,
                                           start_new_session=True)
            self.processes.append(process)
            self.doc["validator_resources"].append({"pid": process.pid, "node_id": node["node_id"],
                "phase": phase, "peak_rss_bytes": None, "source": "wait4 ru_maxrss"})

    def poll_validator(self, process):
        # wait4 is the sole reaper: Popen.poll/wait would discard per-child peak
        # RSS. A child PID cannot be reused until we reap it; signals below only
        # target still-owned children. Never infer peak memory from sampled RSS.
        if process.returncode is None:
            record = next(row for row in reversed(self.doc["validator_resources"]) if row["pid"] == process.pid)
            try:
                pid, status, usage = os.wait4(process.pid, os.WNOHANG)
            except ChildProcessError:
                process.returncode = 255
                record["error"] = "child reaped elsewhere; peak memory unavailable"
                return process.returncode
            if pid:
                process.returncode = os.waitstatus_to_exitcode(status)
                system = platform.system()
                if system in ("Darwin", "Linux") and usage.ru_maxrss > 0:
                    record["peak_rss_bytes"] = int(usage.ru_maxrss) * (1 if system == "Darwin" else 1024)
                    record["raw_ru_maxrss"] = usage.ru_maxrss
                    record["raw_unit"] = "bytes" if system == "Darwin" else "KiB"
                else:
                    record["error"] = "unsupported or unavailable wait4 peak memory units"
                record["returncode"] = process.returncode
        return process.returncode

    def stop(self):
        # Popen objects own these children. Never discover/kill by port, name or
        # a PID from an old artifact. Reap before restart; preserve signing state.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            for process in self.processes:
                if self.poll_validator(process) is None:
                    try:
                        os.kill(process.pid, sig)
                    except ProcessLookupError:
                        pass  # Exit raced the signal; wait4 still owns reaping.
            deadline = monotonic_ns() + 5 * 10**9
            while any(self.poll_validator(process) is None for process in self.processes):
                if monotonic_ns() >= deadline:
                    break
                time.sleep(0.05)
        if any(self.poll_validator(process) is None for process in self.processes):
            self.doc.update(status="failed", error="owned validator did not exit after SIGKILL")
            raise TimeoutError("owned validator did not exit after SIGKILL")
        self.processes.clear()

    def query(self, node, route, height=None):
        headers = {} if height is None else {"x-cosmos-block-height": str(height)}
        port = node["rpc"] if height is None else node["api"]
        request = urllib.request.Request(f"http://127.0.0.1:{port}{route}", headers=headers)
        with urllib.request.urlopen(request, timeout=self.remaining()) as response:
            body = bytearray()
            while len(body) <= MAX_COMMAND_OUTPUT_BYTES:
                self.remaining()
                chunk = response.read1(min(65536, MAX_COMMAND_OUTPUT_BYTES - len(body) + 1))
                if not chunk:
                    break
                body.extend(chunk)
            self.remaining()
            if response.status != 200 or len(body) > MAX_COMMAND_OUTPUT_BYTES:
                raise ValueError("invalid or oversized node response")
            if height is not None and response.headers.get("x-cosmos-block-height") != str(height):
                raise ValueError("economic response does not attest the requested height")
        value = json.loads(body)
        if not isinstance(value, dict) or not value or value.get("error"):
            raise ValueError("malformed node response")
        return value if height is not None else value["result"]

    def wait_height(self, minimum):
        while True:
            self.remaining()
            if any(self.poll_validator(process) is not None for process in self.processes):
                raise ValueError("owned validator exited; inspect retained node logs")
            try:
                heights = []
                for node in self.nodes:
                    status = self.query(node, "/status")
                    if status["node_info"]["id"] != node["node_id"] or status["node_info"]["network"] != self.chain:
                        raise ValueError("RPC endpoint belongs to a different node or chain")
                    heights.append(integer(status["sync_info"]["latest_block_height"], "height"))
                if min(heights) >= minimum:
                    return min(heights)
            except (urllib.error.URLError, TimeoutError):
                pass  # Initial listener availability is not committed evidence.
            time.sleep(min(0.2, self.remaining()))

    def snapshot(self, height):
        """Block H+1 commits execution of H; all economic reads attest H."""
        rows = []
        expected_keys = {json.dumps(node["validator_key"], sort_keys=True) for node in self.nodes}
        for node in self.nodes:
            block = self.query(node, f"/block?height={height + 1}")
            header = block["block"]["header"]
            if integer(header["height"], "block height", 1) != height + 1 or header["chain_id"] != self.chain:
                raise ValueError("wrong app-hash block boundary")
            if not re.fullmatch(r"[0-9a-fA-F]{64}", header["app_hash"]) or not re.fullmatch(r"[0-9a-fA-F]{64}", block["block_id"]["hash"]):
                raise ValueError("invalid committed app/block hash")
            validators = self.query(node, f"/validators?height={height}&per_page=100")
            voting = validators["validators"]
            if (integer(validators["block_height"], "validator height") != height or
                integer(validators["total"], "validator total") != 4 or len(voting) != 4 or
                {json.dumps(v["pub_key"], sort_keys=True) for v in voting} != expected_keys or
                len({integer(v["voting_power"], "voting power", 1) for v in voting}) != 1):
                raise ValueError("committed validator set is not the four expected equal-power keys")
            row = {"height": height, "app_hash_block_height": height + 1,
                   "app_hash": header["app_hash"].upper(), "block_id": block["block_id"]["hash"].upper(),
                   "balances": {}, "supply": {}}
            for denom in ("stake", "aatom"):
                for name, address in self.signers.items():
                    coin = self.query(node, f"/cosmos/bank/v1beta1/balances/{address}/by_denom?denom={denom}", height)["balance"]
                    if coin["denom"] != denom:
                        raise ValueError("balance denomination mismatch")
                    row["balances"][name + ":" + denom] = str(integer(coin["amount"], "balance", maximum=10**60))
                coin = self.query(node, f"/cosmos/bank/v1beta1/supply/by_denom?denom={denom}", height)["amount"]
                if coin["denom"] != denom:
                    raise ValueError("supply denomination mismatch")
                row["supply"][denom] = str(integer(coin["amount"], "supply", 1, 10**60))
            rows.append(row)
        if any(row != rows[0] for row in rows[1:]):
            raise ValueError("validators disagree at the same committed height")
        return {"nodes_checked": [node["node_id"] for node in self.nodes], **rows[0]}

    def run(self):
        self.home.mkdir(mode=0o700)
        previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        def interrupted(signum, frame):
            raise KeyboardInterrupt(f"interrupted by signal {signum}")
        for sig in previous:
            signal.signal(sig, interrupted)
        try:
            self.reserve_ports()
            self.doc["provenance"] = {"source_checkout": command("git", "-C", str(self.root), "rev-parse", "HEAD"),
                "binary_sha256": sha256(self.binary), "native_library_sha256": sha256(self.library),
                "trusted_setup_sha256": sha256(self.env["POLYSTORE_TRUSTED_SETUP"]),
                "harness_sha256": sha256(__file__), "host": platform.platform(),
                "artifact_source_match": "supplied binary/library; build correspondence not attested"}
            self.prepare()
            self.save()
            self.start("initial")
            height = self.wait_height(3) - 1
            self.doc["before_restart"] = self.snapshot(height)
            expected = {name + ":" + denom: amount for name in self.signers for denom, amount in
                        (("stake", "100000000000"), ("aatom", "1000000000000000000"))}
            if self.doc["before_restart"]["balances"] != expected:
                raise ValueError("independent signers do not have the declared genesis funding")
            self.save()
            self.stop()
            self.reserve_ports()
            self.start("restart")
            later = self.wait_height(height + 3) - 1
            self.doc["after_restart_original_height"] = self.snapshot(height)
            if self.doc["after_restart_original_height"] != self.doc["before_restart"]:
                raise ValueError("restart changed the original committed state boundary")
            self.doc["after_restart_later_height"] = self.snapshot(later)
            if self.doc["after_restart_later_height"]["balances"] != expected:
                raise ValueError("unsubmitted workload signer balances changed after restart")
            self.doc["status"] = "lifecycle_checks_passed"
        except BaseException as error:
            self.doc.update(status="failed", error=str(error)[-8192:])
            raise
        finally:
            try:
                try:
                    self.stop()
                finally:
                    for reservation in self.reservations:
                        reservation.close()
                    self.save()
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
        return self.home / "evidence.json"


def four_validator_main(args):
    parser = argparse.ArgumentParser(description="Four-validator lifecycle preparation; retains private homes and logs. No capacity qualification.",
        epilog="Fixed local ports: RPC 26657/26654/26651/26648; P2P 26656/26653/26650/26647; gRPC 9090/9088/9086/9084; API 1317..1314; metrics 26660..26663.")
    parser.add_argument("--binary", required=True)
    parser.add_argument("--library", required=True)
    parser.add_argument("--home", required=True, help="new directory whose parent already exists; never deleted")
    parser.add_argument("--timeout", type=int, default=180, help="absolute preparation + lifecycle deadline, 30..900 seconds")
    parser.add_argument("--gomaxprocs", type=int, default=2)
    options = parser.parse_args(args)
    print(FourValidatorLifecycle(**vars(options)).run())


def main():
    action, *args = sys.argv[1:]
    if action == "four-validator-lifecycle":
        four_validator_main(args)
    elif action == "arithmetic":
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
