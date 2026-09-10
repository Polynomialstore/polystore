#!/usr/bin/env python3
"""Bounded four-validator diagnostics; never capacity qualification.

Settlement smoke uses exported K8/K2 fixtures without provider transport.
Healthy-providers uses canonical K2 ingest and three provider-daemons to check
normal storage audits. Sustained-providers adds finite K2 or K8 real-artifact
proof load.
No mode verifies delivered files. Owned services
start only when this command is explicitly invoked.
"""
import argparse
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import urllib.parse
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait as wait_futures

import retrieval_bench_artifact as artifact
import retrieval_commit_metrics as commit_metrics
import retrieval_fresh_proof as producer

API = "/polystorechain/polystorechain/v1"
ENV_KEYS = ("GOMAXPROCS", "POLYSTORE_TRUSTED_SETUP", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH")
COUNTS = (1, 2, 8)
SUSTAINED_RATES = (0.25, 0.5, 1, 2, 4)
SUSTAINED_RATE_SCALES = (1, 4)
SUSTAINED_DEPUTY_COUNTS = (8, 32)
OPEN_SESSION_PREPARATION_GAS = 400_000
OPEN_SESSION_BATCH_BASE_GAS = 100_000
OPEN_SESSION_BATCH_MAX = 64
OPEN_SESSION_BATCH_GAS_CAP = OPEN_SESSION_BATCH_BASE_GAS + OPEN_SESSION_PREPARATION_GAS * OPEN_SESSION_BATCH_MAX
V3_PILOT_BYTES = 16 * 1024 * 1024
V3_PILOT_SESSIONS = 2
V3_MAX_SAMPLES = 132
V3_BITMAP_BYTES = (V3_MAX_SAMPLES + 7) // 8
V3_SYSTEMATIC_PROVIDERS = 8
V3_PROVIDER_AUTH_TOKEN = "healthy-diagnostic-owned-local-stack"
V3_BUSY_MAX_ATTEMPTS = 4
V3_BUSY_RETRY_SECONDS = 2
V3_PREFLIGHT_FREE_BYTES = 2 * 1024**3
V3_ABORT_FREE_BYTES = 768 * 1024**2


def require_free_disk(path, minimum, phase):
    free = shutil.disk_usage(path).free
    if free < minimum:
        raise ValueError(f"{phase} requires {minimum} free bytes; found {free}")
    return free


def provider_http_url(lifecycle, address, route):
    matches = [row for row in lifecycle.doc.get("providers", []) if row.get("address") == address]
    if len(matches) != 1:
        raise ValueError("provider address does not identify exactly one owned daemon")
    port = producer.uint(matches[0].get("port", 0))
    if not 1 <= port <= 65535 or not route.startswith("/"):
        raise ValueError("owned provider daemon has an invalid HTTP endpoint")
    return f"http://127.0.0.1:{port}{route}"


def v3_bitmap_ordinals(session):
    """Return authoritative accepted sample ordinals from one v3 query."""
    count = producer.uint(session.get("sample_count", 0))
    if not 1 <= count <= V3_MAX_SAMPLES:
        raise ValueError("v3 session sample count is outside the protocol bound")
    try:
        bitmap = base64.b64decode(session["accepted_sample_bitmap"], validate=True)
    except (KeyError, ValueError) as error:
        raise ValueError("v3 session has invalid accepted sample bitmap") from error
    if len(bitmap) != V3_BITMAP_BYTES or bitmap[-1] & 0xf0:
        raise ValueError("v3 session has noncanonical accepted sample bitmap")
    ordinals = [ordinal for ordinal in range(V3_MAX_SAMPLES)
                if bitmap[ordinal // 8] & (1 << (ordinal % 8))]
    if any(ordinal >= count for ordinal in ordinals):
        raise ValueError("v3 bitmap accepts an ordinal beyond the frozen sample count")
    return ordinals


def validate_v3_session(response, *, session_id, deal_id, owner, providers, nonce,
                        polyfs_root, integrity_root, chain_id, deadline_height,
                        file_bytes=V3_PILOT_BYTES, expired=False, refunded=False):
    """Fail closed on the v3 fields that define pilot claims and liabilities."""
    session = response.get("session")
    if not isinstance(session, dict):
        raise ValueError("v3 session query is missing session state")
    try:
        got_id = base64.b64decode(session["session_id"], validate=True).hex()
    except (KeyError, ValueError) as error:
        raise ValueError("v3 session query has an invalid identity") from error
    if (got_id != session_id or producer.uint(session.get("deal_id", 0)) != producer.uint(deal_id) or
            session.get("owner") != owner or session.get("payer") != owner or
            producer.uint(session.get("nonce", 0)) != nonce or
            producer.uint(session.get("file_record_index", 1)) != 0 or
            producer.uint(session.get("file_start_offset", 1)) != 0 or
            producer.uint(session.get("file_length", 0)) != file_bytes or
            producer.uint(session.get("range_start", 1)) != 0 or
            producer.uint(session.get("range_length", 0)) != file_bytes or
            producer.uint(session.get("generation", 0)) != 1 or
            producer.uint(session.get("metadata_mdus", 0)) != 2 or
            producer.uint(session.get("user_mdus", 0)) != 3 or
            producer.uint(session.get("first_blob", 1)) != 0 or
            producer.uint(session.get("last_blob", 0)) != 132 or
            producer.uint(session.get("population", 0)) != 133 or
            producer.uint(session.get("sample_count", 0)) != V3_MAX_SAMPLES or
            producer.uint(session.get("deadline_height", 0)) != deadline_height or
            session.get("chain_id") != chain_id or
            producer.b64(session.get("polyfs_root", ""), 32).hex() != polyfs_root or
            producer.b64(session.get("integrity_root", ""), 32).hex() != integrity_root or
            producer.b64(session.get("setup_digest", ""), 32).hex() != producer.SETUP_DIGEST or
            not any(producer.b64(session.get("plan_hash", ""), 32)) or
            bool(session.get("expired", False)) is not expired):
        raise ValueError("v3 session differs from the fixed pilot authority")
    obligations = session.get("obligations")
    if not isinstance(obligations, list) or len(obligations) != V3_SYSTEMATIC_PROVIDERS:
        raise ValueError("v3 session must bind all eight systematic providers")
    slots = []
    for obligation in obligations:
        slot = producer.uint(obligation.get("slot", 99))
        if (slot >= V3_SYSTEMATIC_PROVIDERS or obligation.get("assigned_provider") != providers.get(slot) or
                obligation.get("payee") != providers.get(slot) or
                producer.uint(obligation.get("blob_count", 0)) == 0):
            raise ValueError("v3 session obligation differs from the finalized assignment")
        slots.append(slot)
    if (slots != list(range(V3_SYSTEMATIC_PROVIDERS)) or
            sum(producer.uint(row["blob_count"]) for row in obligations) != 133):
        raise ValueError("v3 systematic obligations must be ordered and unique")
    ordinals = v3_bitmap_ordinals(session)
    if refunded and not expired:
        raise ValueError("v3 session cannot be refunded before expiry")
    expected_mask = (1 << V3_SYSTEMATIC_PROVIDERS) - 1
    if (producer.uint(session.get("refunded_slots_mask", 0)) != (expected_mask if refunded else 0) or
            producer.uint(session.get("settled_slots_mask", 0)) != 0 or
            producer.uint(session.get("acked_slots_mask", 0)) != 0 or
            (producer.uint(session.get("locked_fee", 0), 256) == 0) is not refunded):
        raise ValueError("unacknowledged v3 session has inconsistent settlement liabilities")
    return session, ordinals


def validate_v3_provider_outcomes(rows, providers, *, session_id):
    """Validate one production proof wave without treating HTTP as chain authority."""
    if len(rows) != V3_SYSTEMATIC_PROVIDERS:
        raise ValueError("v3 proof wave must contact all eight systematic providers")
    slots, hashes = set(), set()
    proofs = 0
    for row in rows:
        slot = producer.uint(row.get("slot", 99))
        count = producer.uint(row.get("proof_count", 0))
        txhash = row.get("tx_hash", "")
        if (row.get("status") != "success" or row.get("http_status") != 200 or
                row.get("curl_returncode") != 0 or
                row.get("session_id") != "0x" + session_id or
                row.get("cleanup_status") != "complete" or slot >= V3_SYSTEMATIC_PROVIDERS or
                providers.get(slot) != row.get("provider") or not 1 <= count <= 64 or
                not isinstance(txhash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", txhash) or
                slot in slots or txhash.upper() in hashes):
            error = str(row.get("error", ""))[-512:]
            raise ValueError(
                f"v3 provider {row.get('provider')!r} response rejected: "
                f"http_status={row.get('http_status')!r} status={row.get('status')!r} error={error!r}")
        slots.add(slot)
        hashes.add(txhash.upper())
        proofs += count
    if slots != set(range(V3_SYSTEMATIC_PROVIDERS)):
        raise ValueError("v3 proof wave omitted a systematic provider")
    return dict(unique_tx_hashes=sorted(hashes), proof_count=proofs,
                slot_count=len(slots), payees=[providers[slot] for slot in sorted(slots)])


def _encode_varint(value):
    if type(value) is not int or value < 0 or value > (1 << 64) - 1:
        raise ValueError("protobuf integer outside uint64")
    out = bytearray()
    while value >= 128:
        out.append((value & 0x7f) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def opened_v3_session(result, *, logical_bytes=V3_PILOT_BYTES):
    """Decode the exact native v3 open response retained in a committed tx."""
    data = result.get("data", "")
    if (result.get("outcome") != "committed_success" or not isinstance(data, str) or
            len(data) > 2048 or len(data) % 2 or not re.fullmatch(r"[0-9a-fA-F]+", data)):
        raise ValueError("invalid committed v3 open response")
    raw = bytes.fromhex(data)
    expected_type = b"/polystorechain.polystorechain.v1.MsgOpenRetrievalSessionV3Response"
    suffix = (b"\x10" + _encode_varint(logical_bytes) +
              b"\x18" + _encode_varint(133 * artifact.ENCODED_BLOB_BYTES) +
              b"\x20" + _encode_varint(V3_MAX_SAMPLES))
    response = b"\x0a\x20" + bytes(32) + suffix
    any_value = (b"\x0a" + _encode_varint(len(expected_type)) + expected_type +
                 b"\x12" + _encode_varint(len(response)) + response)
    expected = b"\x12" + _encode_varint(len(any_value)) + any_value
    sid_offset = len(expected) - len(suffix) - 32
    if (len(raw) != len(expected) or raw[:sid_offset] != expected[:sid_offset] or
            raw[sid_offset + 32:] != expected[sid_offset + 32:] or
            not any(raw[sid_offset:sid_offset + 32])):
        raise ValueError("v3 open response differs from the fixed pilot geometry")
    return raw[sid_offset:sid_offset + 32].hex()


def run_v3_http_phase(lifecycle, curl, requests, phase, *, max_in_flight,
                      retry_pre_admission_busy=False):
    """Run one bounded disjoint-signer HTTP phase and retain every outcome."""
    if (not requests or not 1 <= max_in_flight <= 12 or
            len({row["provider"] for row in requests}) != len(requests)):
        raise ValueError("v3 HTTP phase requires distinct provider signers")
    require_free_disk(lifecycle.home, V3_ABORT_FREE_BYTES, phase)
    directory = lifecycle.home / "v3-http"
    directory.mkdir(mode=0o700, exist_ok=True)
    started = artifact.monotonic_ns()
    phase_deadline = min(lifecycle.deadline,
                         started + max(row.get("timeout_seconds", 180) for row in requests) * 10**9)
    last_heartbeat = started
    last_progress = started
    completed = []
    retained = lifecycle.doc.setdefault("v3_http_phases", {}).setdefault(phase, [])

    def execute(index, request):
        attempts = []
        limit = V3_BUSY_MAX_ATTEMPTS if retry_pre_admission_busy else 1
        request_deadline = min(phase_deadline,
                               started + request.get("timeout_seconds", 180) * 10**9)
        for attempt in range(1, limit + 1):
            if attempt > 1:
                if artifact.monotonic_ns() + V3_BUSY_RETRY_SECONDS * 10**9 >= request_deadline:
                    break
                time.sleep(V3_BUSY_RETRY_SECONDS)
            path = directory / f"{phase}-{index}-{attempt}.json"
            began = artifact.monotonic_ns()
            try:
                result = artifact.run_bounded_command([
                    curl, "--silent", "--show-error", "--max-time", str(request.get("timeout_seconds", 180)),
                    "--request", "POST", "--header", "Content-Type: application/json",
                    "--header", "X-PolyStore-Gateway-Auth: " + V3_PROVIDER_AUTH_TOKEN,
                    "--data", json.dumps(request["body"], separators=(",", ":")),
                    "--max-filesize", str(1024 * 1024), "--output", str(path),
                    "--write-out", "%{http_code}", request["url"],
                ], request_deadline, env=lifecycle.env)
                with path.open("rb") as source:
                    raw = source.read(1024 * 1024 + 1)
                if len(raw) > 1024 * 1024:
                    raise ValueError("v3 HTTP response exceeds 1 MiB")
                body = json.loads(raw)
                if not isinstance(body, dict):
                    raise ValueError("v3 HTTP response must be a JSON object")
                try:
                    code = producer.uint(result.stdout.strip())
                except ValueError as error:
                    raise ValueError("v3 HTTP request did not return a status code") from error
                row = dict(body, http_status=code, provider=request["provider"], attempt=attempt,
                           request_started_ns=began, request_finished_ns=artifact.monotonic_ns(),
                           stderr=result.stderr[-8192:], curl_returncode=result.returncode)
                attempts.append(row)
                if result.returncode != 0:
                    return attempts, ValueError(
                        f"v3 HTTP request for provider {request['provider']!r} exited {result.returncode}")
                busy = (code == 429 and set(body) == {"error", "hint"} and
                        body.get("error") == "retrieval submission busy" and
                        body.get("hint") == "retrieval submission capacity or signer busy")
                if not retry_pre_admission_busy or not busy:
                    return attempts, None
            except BaseException as error:
                attempts.append(dict(status="driver_error", provider=request["provider"], attempt=attempt,
                                     error=str(error)[-8192:], request_finished_ns=artifact.monotonic_ns()))
                return attempts, error
            finally:
                path.unlink(missing_ok=True)
        return attempts, None

    errors = []
    with ThreadPoolExecutor(max_workers=max_in_flight) as executor:
        pending = {executor.submit(execute, index, request): request
                   for index, request in enumerate(requests)}
        while pending:
            done, _ = wait_futures(pending, timeout=1, return_when=FIRST_COMPLETED)
            now = artifact.monotonic_ns()
            for future in done:
                request = pending.pop(future)
                future_error = None
                try:
                    attempts, future_error = future.result()
                except BaseException as error:
                    attempts = [dict(status="driver_error", provider=request["provider"],
                               error=str(error)[-8192:], request_finished_ns=now)
                    ]
                    future_error = error
                retained.extend(attempts)
                if future_error is not None:
                    errors.append(future_error)
                    lifecycle.save()
                    continue
                row = attempts[-1]
                completed.append(row)
                lifecycle.save()
                last_progress = now
            if not errors and now - last_progress >= 600 * 10**9:
                errors.append(TimeoutError(f"{phase} made no progress for 600 seconds"))
            if now - last_heartbeat >= 60 * 10**9:
                heartbeat = dict(
                    phase=phase, completed=len(completed), total=len(requests),
                    elapsed_ns=now - started, seconds_since_progress=(now - last_progress) / 1e9)
                lifecycle.doc.setdefault("progress", []).append(heartbeat)
                lifecycle.save()
                print(json.dumps(heartbeat, sort_keys=True), flush=True)
                last_heartbeat = now
            if not errors:
                try:
                    lifecycle.remaining()
                    require_free_disk(lifecycle.home, V3_ABORT_FREE_BYTES, phase)
                except BaseException as error:
                    errors.append(error)
    if errors:
        raise errors[0]
    heartbeat = dict(
        phase=phase, completed=len(completed), total=len(requests),
        elapsed_ns=artifact.monotonic_ns() - started, seconds_since_progress=0)
    lifecycle.doc.setdefault("progress", []).append(heartbeat)
    lifecycle.save()
    print(json.dumps(heartbeat, sort_keys=True), flush=True)
    return sorted(completed, key=lambda row: row["provider"])


def v3_session_query(lifecycle, session_id, height=None):
    if height is None:
        height = lifecycle.wait_height(1)
    encoded = base64.urlsafe_b64encode(bytes.fromhex(session_id)).decode()
    route = API + "/retrieval-sessions-v3/" + encoded
    rows = [lifecycle.query(node, route, height) for node in lifecycle.nodes]
    if any(row != rows[0] for row in rows[1:]):
        raise ValueError("four validators disagree on v3 session state")
    return rows[0]


def v3_retained_generations(lifecycle, *, deal_id, root, height=None):
    """Record the all-validator retention union without attributing its source."""
    if height is None:
        height = lifecycle.wait_height(1)
    rows = [lifecycle.query(node, API + "/retained-generations", height) for node in lifecycle.nodes]
    if any(row != rows[0] for row in rows[1:]):
        raise ValueError("four validators disagree on retained generations")
    expected = dict(deal_id=str(deal_id), generation="1",
                    manifest_root=base64.b64encode(bytes.fromhex(root)).decode())
    if expected not in rows[0].get("generations", []):
        raise ValueError("active v3 generation is absent from the retention union")
    return rows[0]


def validate_v3_committed_message(message, *, kind, creator, slot, deal_id=None,
                                  session_id=None, proof_count=None):
    """Bind a committed hash to the one native message the HTTP route intended."""
    expected_type = {
        "generation-acceptance": "/polystorechain.polystorechain.v1.MsgAcceptDealGenerationV3",
        "session-proof": "/polystorechain.polystorechain.v1.MsgSubmitRetrievalSessionProofV3",
    }.get(kind)
    if expected_type is None or message.get("@type") != expected_type or message.get("creator") != creator or producer.uint(message.get("slot", 99)) != slot:
        raise ValueError("committed HTTP transaction message differs from route intent")
    if kind == "generation-acceptance":
        if producer.uint(message.get("deal_id", 0)) != producer.uint(deal_id) or not any(producer.b64(message.get("acceptance_digest", ""), 32)):
            raise ValueError("committed generation acceptance differs from frozen intent")
        return []
    if producer.b64(message.get("session_id", ""), 32).hex() != session_id:
        raise ValueError("committed proof transaction targets the wrong session")
    proofs = message.get("proofs")
    if not isinstance(proofs, list) or len(proofs) != proof_count or not 1 <= len(proofs) <= 64:
        raise ValueError("committed proof count differs from provider response")
    ordinals = [producer.uint(proof.get("ordinal", V3_MAX_SAMPLES)) for proof in proofs]
    if len(set(ordinals)) != len(ordinals) or any(value >= V3_MAX_SAMPLES for value in ordinals):
        raise ValueError("committed proof transaction has duplicate or out-of-range ordinals")
    return ordinals


def committed_v3_http_tx(lifecycle, row, *, kind, creator, slot, deal_id=None,
                         session_id=None, proof_count=None):
    """Bind an HTTP result to exact committed bytes and all four validators."""
    txhash = row["tx_hash"].upper()
    response = lifecycle.query(lifecycle.nodes[0], "/tx?hash=0x" + txhash)
    result = dict(txhash=response["hash"], height=response["height"],
                  code=response["tx_result"].get("code", 0),
                  gas_wanted=response["tx_result"]["gas_wanted"],
                  gas_used=response["tx_result"]["gas_used"],
                  raw_log=response["tx_result"].get("log", ""),
                  outcome="committed_success" if not response["tx_result"].get("code", 0) else "committed_failure")
    artifact.committed_tx(result, txhash)
    result["validators"] = verify_transaction_nodes(lifecycle, result)
    decoded = json.loads(lifecycle.cli(lifecycle.nodes[0]["home"], "query", "tx", txhash, "--output", "json"))
    messages = decoded.get("tx", {}).get("body", {}).get("messages", [])
    if len(messages) != 1:
        raise ValueError("committed HTTP transaction must contain exactly one message")
    result["ordinals"] = validate_v3_committed_message(messages[0], kind=kind, creator=creator,
        slot=slot, deal_id=deal_id, session_id=session_id, proof_count=proof_count)
    return result


def validate_v3_candidate(value, *, deal_id):
    candidate = value.get("generation_candidate")
    if not isinstance(candidate, dict):
        raise ValueError("FAT v3 upload omitted the generation candidate")
    roots = []
    for name in ("polyfs_root", "integrity_root"):
        raw = candidate.get(name, "")
        if not isinstance(raw, str) or len(raw) != 66 or not raw.startswith("0x"):
            raise ValueError("FAT v3 candidate has an invalid root")
        roots.append(bytes.fromhex(raw[2:]))
    if (not all(any(root) for root in roots) or
            [producer.uint(candidate.get(name, 0)) for name in (
                "deal_id", "expected_current_generation", "size_bytes", "total_mdus",
                "witness_mdus", "integrity_leaf_count")] !=
            [producer.uint(deal_id), 0, V3_PILOT_BYTES, 5, 1, 288] or
            candidate.get("previous_polyfs_root", "") not in ("", "0x") or
            candidate.get("commit_action") != "propose-deal-generation-v3" or
            producer.uint(candidate.get("required_acceptances", 0)) != 12):
        raise ValueError("FAT v3 candidate differs from the fixed pilot geometry")
    return candidate


def validate_v3_generation(response, candidate, providers, *, owner, admitted):
    value = response.get("admitted" if admitted else "pending")
    if not isinstance(value, dict) or response.get("pending" if admitted else "admitted"):
        raise ValueError("v3 generation query has the wrong admission state")
    if ([producer.uint(value.get(name, 0)) for name in (
            "deal_id", "generation", "size", "total_mdus", "witness_mdus",
            "metadata_mdus", "user_mdus", "integrity_leaf_count", "accepted_slots_mask")] !=
            [producer.uint(candidate["deal_id"]), 1, V3_PILOT_BYTES, 5, 1, 2, 3, 288,
             4095] or
            value.get("owner") != owner or
            producer.b64(value.get("polyfs_root", ""), 32).hex() != candidate["polyfs_root"][2:] or
            producer.b64(value.get("integrity_root", ""), 32).hex() != candidate["integrity_root"][2:] or
            value.get("providers") != [providers[index] for index in range(12)]):
        raise ValueError("v3 generation authority differs from the accepted candidate")
    return value


def run_native_v3_sessions(lifecycle, *, deal, providers, send, wait, curl):
    """Two real preopened sessions; production providers generate and submit proofs."""
    doc = lifecycle.doc.setdefault("native_v3", {})
    owner = lifecycle.signers["owner0"]
    opened_at = lifecycle.wait_height(3)
    deadline_height = opened_at + 180
    if deadline_height >= producer.uint(deal["end_block"]):
        raise ValueError("v3 pilot session deadline reaches the deal end")
    polyfs_root = producer.b64(deal["manifest_root"], 32).hex()
    integrity_root = lifecycle.doc["native_v3_generation"]["candidate"]["integrity_root"][2:]
    doc["retained_generations_before_sessions"] = v3_retained_generations(
        lifecycle, deal_id=deal["id"], root=polyfs_root)
    sessions = []
    doc["sessions"] = sessions
    lifecycle.save()
    for nonce in range(1, V3_PILOT_SESSIONS + 1):
        path = lifecycle.home / f"v3-open-{nonce}.json"
        message = dict(creator=owner, deal_id=str(deal["id"]), generation="1",
            range=dict(file_record_index=0, file_start_offset="0", file_length=str(V3_PILOT_BYTES),
                       range_start="0", range_length=str(V3_PILOT_BYTES)),
            nonce=str(nonce), deadline_height=str(deadline_height))
        with path.open("x") as output:
            json.dump(message, output, separators=(",", ":"))
        result = send("owner0", ["retrieval-session-v3", "open", str(path)])
        result["validators"] = verify_transaction_nodes(lifecycle, result)
        sid = opened_v3_session(result)
        sessions.append(dict(session_id=sid, nonce=nonce, open_transaction=result))
        lifecycle.save()
    wait(max(row["open_transaction"]["height"] for row in sessions) + 2)
    for row in sessions:
        before = v3_session_query(lifecycle, row["session_id"])
        _, ordinals = validate_v3_session(before, session_id=row["session_id"], deal_id=deal["id"],
            owner=owner, providers=providers, nonce=row["nonce"], polyfs_root=polyfs_root,
            integrity_root=integrity_root, chain_id=lifecycle.chain, deadline_height=deadline_height)
        if ordinals or before.get("anchor_seed", "") in ("", None):
            raise ValueError("preopened v3 session lacks an anchor or starts with accepted samples")
        row["before_proofs"] = before
    capture_workload_metrics(lifecycle, "native_v3_before_proofs", fenced=True)
    for row in sessions:
        requests = [dict(provider=providers[slot],
                         url=provider_http_url(lifecycle, providers[slot], "/sp/session-proof"),
                         body=dict(session_id=row["session_id"]))
                    for slot in range(V3_SYSTEMATIC_PROVIDERS)]
        outcomes = run_v3_http_phase(lifecycle, curl, requests,
                                     f"session-{row['nonce']}-proofs", max_in_flight=8,
                                     retry_pre_admission_busy=True)
        summary = validate_v3_provider_outcomes(outcomes, providers, session_id=row["session_id"])
        transactions = []
        for outcome in outcomes:
            transaction = committed_v3_http_tx(lifecycle, outcome, kind="session-proof",
                creator=outcome["provider"], slot=producer.uint(outcome["slot"]),
                session_id=row["session_id"], proof_count=producer.uint(outcome["proof_count"]))
            if transaction["outcome"] != "committed_success":
                raise ValueError("provider reported success for a failed v3 proof transaction")
            transactions.append(transaction)
        at = max(producer.uint(tx["height"]) for tx in transactions)
        wait(at + 1)
        after = v3_session_query(lifecycle, row["session_id"], at)
        _, accepted = validate_v3_session(after, session_id=row["session_id"], deal_id=deal["id"],
            owner=owner, providers=providers, nonce=row["nonce"], polyfs_root=polyfs_root,
            integrity_root=integrity_root, chain_id=lifecycle.chain, deadline_height=deadline_height)
        tx_ordinals = sorted(ordinal for tx in transactions for ordinal in tx["ordinals"])
        if accepted != tx_ordinals or len(accepted) != V3_MAX_SAMPLES or summary["proof_count"] != V3_MAX_SAMPLES:
            raise ValueError("committed v3 proof messages do not equal authoritative bitmap deltas")
        row.update(provider_outcomes=outcomes, outcome_summary=summary,
                   proof_transactions=transactions, committed_height=at,
                   accepted_sample_ordinals=accepted)
        lifecycle.save()
    capture_workload_metrics(lifecycle, "native_v3_after_proofs", fenced=True)
    wait(deadline_height + 2)
    for row in sessions:
        expired = v3_session_query(lifecycle, row["session_id"])
        validate_v3_session(expired, session_id=row["session_id"], deal_id=deal["id"], owner=owner,
                            providers=providers, nonce=row["nonce"], polyfs_root=polyfs_root,
                            integrity_root=integrity_root, chain_id=lifecycle.chain,
                            deadline_height=deadline_height, expired=True)
        if expired.get("anchor_seed", "") not in ("", None):
            raise ValueError("expired v3 session retained its anchor")
        row["expired_before_refund"] = expired
        refunded = send("owner0", ["retrieval-session-v3", "refund", str(_write_v3_refund(lifecycle, owner, row["session_id"]))])
        refunded["validators"] = verify_transaction_nodes(lifecycle, refunded)
        wait(refunded["height"] + 1)
        after = v3_session_query(lifecycle, row["session_id"], refunded["height"])
        validate_v3_session(after, session_id=row["session_id"], deal_id=deal["id"], owner=owner,
                            providers=providers, nonce=row["nonce"], polyfs_root=polyfs_root,
                            integrity_root=integrity_root, chain_id=lifecycle.chain,
                            deadline_height=deadline_height, expired=True, refunded=True)
        row.update(refund_transaction=refunded, after_refund=after)
        lifecycle.save()
    doc["retained_generations_after_refund"] = v3_retained_generations(
        lifecycle, deal_id=deal["id"], root=polyfs_root)
    doc.update(offered_proof_transactions=16,
               committed_valid_proof_transactions=sum(len(row["proof_transactions"]) for row in sessions),
               authoritative_new_sample_ordinals=sum(len(row["accepted_sample_ordinals"]) for row in sessions),
               logical_bytes_per_session=V3_PILOT_BYTES, sample_population=133,
               samples_per_session=V3_MAX_SAMPLES, delivery_verified=False, owner_acknowledged=False,
               qualification=False, timing_scope="provider HTTP includes proof generation, local verification, gas simulation, signing, broadcast and commit observation",
               retention_limit="normal audits retain the same generation, so retained-generation union cannot independently attribute session reference release")
    lifecycle.save()


def _write_v3_refund(lifecycle, owner, session_id):
    path = lifecycle.home / ("v3-refund-" + session_id + ".json")
    with path.open("x") as output:
        json.dump(dict(creator=owner, session_id=base64.b64encode(bytes.fromhex(session_id)).decode()),
                  output, separators=(",", ":"))
    return path


def admit_native_v3_generation(lifecycle, *, uploaded, deal_id, providers, send, curl):
    """Use only the owner CLI and production provider admission routes."""
    candidate = validate_v3_candidate(uploaded, deal_id=deal_id)
    owner = lifecycle.signers["owner0"]
    proposed = send("owner0", ["propose-deal-generation-v3", "--deal-id", deal_id,
        "--expected-current-generation", candidate["expected_current_generation"],
        "--previous-polyfs-root", candidate["previous_polyfs_root"] or "0x",
        "--polyfs-root", candidate["polyfs_root"], "--integrity-root", candidate["integrity_root"],
        "--size", candidate["size_bytes"], "--total-mdus", candidate["total_mdus"],
        "--witness-mdus", candidate["witness_mdus"],
        "--integrity-leaf-count", candidate["integrity_leaf_count"]])
    proposed["validators"] = verify_transaction_nodes(lifecycle, proposed)
    lifecycle.wait_height(proposed["height"] + 1)
    requests = [dict(provider=providers[slot],
                     url=provider_http_url(lifecycle, providers[slot], "/sp/generation-v3/accept"),
                     body=dict(deal_id=producer.uint(deal_id), provider=providers[slot]))
                for slot in range(12)]
    outcomes = run_v3_http_phase(lifecycle, curl, requests, "generation-acceptance", max_in_flight=12)
    seen, transactions = set(), []
    for outcome in outcomes:
        slot = producer.uint(outcome.get("slot", 99))
        txhash = outcome.get("tx_hash", "")
        if (outcome.get("status") != "success" or outcome.get("cleanup_status") != "complete" or
                outcome.get("http_status") != 200 or outcome.get("curl_returncode") != 0 or
                slot >= 12 or providers.get(slot) != outcome["provider"] or
                slot in seen or not re.fullmatch(r"[0-9a-fA-F]{64}", txhash)):
            raise ValueError("provider generation acceptance was not a unique committed success")
        seen.add(slot)
        tx = committed_v3_http_tx(lifecycle, outcome, kind="generation-acceptance",
                                  creator=outcome["provider"], slot=slot, deal_id=deal_id)
        if tx["outcome"] != "committed_success":
            raise ValueError("provider reported success for failed generation acceptance")
        transactions.append(tx)
    if seen != set(range(12)):
        raise ValueError("generation admission omitted a provider")
    height = max(producer.uint(tx["height"]) for tx in transactions)
    lifecycle.wait_height(height + 1)
    pending = lifecycle.query(lifecycle.nodes[0], API + f"/deals/{deal_id}/generation-v3", height)
    validate_v3_generation(pending, candidate, providers, owner=owner, admitted=False)
    finalized = send("owner0", ["finalize-deal-generation-v3", "--deal-id", deal_id,
                                "--generation", "1", "--polyfs-root", candidate["polyfs_root"]])
    finalized["validators"] = verify_transaction_nodes(lifecycle, finalized)
    lifecycle.wait_height(finalized["height"] + 1)
    admitted = lifecycle.query(lifecycle.nodes[0], API + f"/deals/{deal_id}/generation-v3", finalized["height"])
    validate_v3_generation(admitted, candidate, providers, owner=owner, admitted=True)
    lifecycle.doc["native_v3_generation"] = dict(candidate=candidate, proposal_transaction=proposed,
        provider_outcomes=outcomes, acceptance_transactions=transactions,
        finalize_transaction=finalized, admitted=admitted)
    lifecycle.save()
    return candidate, finalized["height"]


def mode2_layout(k, deputy_count=8):
    """Return the complete supported full-row geometry for one Mode 2 MDU."""
    if type(k) is not int or k not in (2, 8):
        raise ValueError("sustained retrieval requires native K2 or K8")
    if type(deputy_count) is not int or deputy_count not in SUSTAINED_DEPUTY_COUNTS:
        raise ValueError("sustained retrieval requires 8 or 32 deputies")
    m = 1 if k == 2 else 4
    openings = artifact.BLOBS_PER_MDU // k
    assignments = k + m
    return dict(k=k, m=m, assignments=assignments,
                deputy_indices=list(range(assignments, assignments + deputy_count)),
                provisioned_provider_signers=max(12, assignments + deputy_count), openings_per_bundle=openings,
                bytes_per_opening=artifact.ENCODED_BLOB_BYTES,
                bytes_per_bundle=openings * artifact.ENCODED_BLOB_BYTES)


def sustained_rates(rate_scale=1):
    """Return one of the two bounded offered-rate profiles."""
    if type(rate_scale) is not int or rate_scale not in SUSTAINED_RATE_SCALES:
        raise ValueError("sustained retrieval requires rate scale 1 or 4")
    return tuple(rate * rate_scale for rate in SUSTAINED_RATES)


def sustained_profile(k, step_seconds, offsets, proof_gas, rate_scale=1, deputy_count=8):
    """Describe rates with explicit transaction-bundle and opening denominators."""
    layout = mode2_layout(k, deputy_count)
    rates = list(sustained_rates(rate_scale))
    inventory = len(offsets) + deputy_count
    openings = layout["openings_per_bundle"]
    return dict(step_seconds=step_seconds, measurement_seconds=step_seconds * len(rates), rates=rates,
        rate_unit="offered proof-submission transactions per second",
        offered_openings_per_second=[rate * openings for rate in rates],
        bundle_unit="one MsgSubmitRetrievalSessionProof transaction for one retrieval session",
        inventory=inventory, warmup_sessions=deputy_count, measured_sessions=len(offsets),
        proofs_per_session=openings, openings_per_bundle=openings,
        proofs_per_session_unit="individual chained openings (legacy field name)",
        warmup_openings=deputy_count * openings, measured_openings=len(offsets) * openings,
        bundle_opening_distribution={str(openings): inventory},
        native_message_batching=dict(open_session_messages_per_preparation_transaction_max=OPEN_SESSION_BATCH_MAX,
            open_session_gas_limit_per_message=OPEN_SESSION_PREPARATION_GAS,
            open_session_base_gas_per_preparation_transaction=OPEN_SESSION_BATCH_BASE_GAS,
            open_session_batch_gas_limit_max=OPEN_SESSION_BATCH_GAS_CAP,
            open_session_gas_limit_note="conservative per-message and transaction-base ceilings, not measured full execution cost",
            proof_sessions_per_submission_transaction=1, cross_provider_crypto_aggregation=False),
        k=k, m=layout["m"], assignment_count=layout["assignments"], rate_scale=rate_scale,
        provider_daemon_count=layout["assignments"],
        deputy_signer_count=deputy_count,
        deputy_signer_indices=layout["deputy_indices"],
        provisioned_provider_signers=layout["provisioned_provider_signers"],
        max_in_flight=deputy_count, max_queued=128, max_queued_per_signer=16,
        proof_gas=proof_gas,
        proof_gas_limit_per_submission_transaction=proof_gas,
        proof_gas_limit_per_opening=dict(gas=proof_gas, openings=openings),
        proof_gas_limit_note="declared transaction limit, not committed gas used",
        qualification=False)


def capture_workload_metrics(lifecycle, phase, *, fenced=False):
    """Retain raw per-node captures, with one hard deadline for the whole phase."""
    evidence = lifecycle.doc.setdefault("commit_step_metrics", dict(
        boundary=commit_metrics.BOUNDARY, qualification=False, boundaries_reconciled=False,
        limitation="Two wide scrapes do not establish p95 or reconcile workload block boundaries; trailing observations may be missing",
        excluded="post-persistence state-transition tail, validator-key refresh, next-round scheduling",
        phases={}))
    capture = dict(complete=False, nodes=[])
    evidence["phases"][phase] = capture
    deadline = min(lifecycle.deadline, artifact.monotonic_ns() + 5 * 10**9)
    for node in lifecycle.nodes:
        endpoint = f'http://127.0.0.1:{node["metrics"]}/metrics'
        row = dict(node_id=node["node_id"], endpoint=endpoint)
        capture["nodes"].append(row)
        try:
            argv = [sys.executable, commit_metrics.__file__, endpoint, lifecycle.chain, "--timeout", "2"]
            if fenced:
                argv += ["--rpc-url", f'http://127.0.0.1:{node["rpc"]}/status', "--node-id", node["node_id"],
                         "--process-initial-height", "0"]  # Only the initial fresh process, before restart.
            while True:
                result = artifact.run_bounded_command(argv, deadline, env=lifecycle.env)
                if result.returncode == 0 or not fenced or "boundary is moving or not fully observed" not in result.stderr:
                    break
                lifecycle.remaining()
            row.update(stdout=result.stdout, stderr=result.stderr, returncode=result.returncode)
            if result.returncode != 0:
                raise ValueError("Commit metric capture command failed")
            sample = json.loads(result.stdout)
            if sample["chain_id"] != lifecycle.chain:
                raise ValueError("Commit metric capture chain mismatch")
            row["sample"] = sample
        except Exception as error:
            row["error"] = str(error)[-8192:]
            raise ValueError(f'{phase} Commit metric capture failed for {node["node_id"]}: {error}') from error
    capture["complete"] = True


def require_retrieval_cli(lifecycle):
    """Reject older binaries before fixture work, validator startup or funding."""
    required = {
        "open-retrieval-session": ("--challenge-version", "--authorized-proof-provider"),
        "submit-retrieval-proof": ("[json-file]",),
        "confirm-retrieval-session": ("--session-id",),
    }
    for command, flags in required.items():
        try:
            help_text = lifecycle.cli(lifecycle.home, "tx", "nilchain", command, "--help")
            if any(token not in help_text.split() for token in (command, *flags)):
                raise ValueError("missing required command or flags")
        except (ValueError, OSError) as error:
            raise ValueError(f"#257 compatible CLI required: {command}: {error}") from error
    lifecycle.doc["retrieval_cli_capabilities"] = required


def require_v3_cli(lifecycle):
    required = {
        "retrieval-session-v3": ("open", "prove", "refund"),
        "propose-deal-generation-v3": ("--integrity-root", "--integrity-leaf-count"),
        "finalize-deal-generation-v3": ("--generation", "--polyfs-root"),
    }
    for command, tokens in required.items():
        help_text = lifecycle.cli(lifecycle.home, "tx", "nilchain", command, "--help")
        if any(token not in help_text for token in (command, *tokens)):
            raise ValueError("native v3 compatible CLI required: " + command)
    lifecycle.doc["retrieval_v3_cli_capabilities"] = required


def smoke_genesis(lifecycle):
    """Explicit smoke economics; consensus/audit settings remain lifecycle defaults."""
    first = Path(lifecycle.nodes[0]["home"]) / "config/genesis.json"
    genesis = json.loads(first.read_text())
    params = genesis["app_state"]["nilchain"]["params"]
    params.update(base_retrieval_fee={"denom": "stake", "amount": "3"},
                  retrieval_price_per_blob={"denom": "stake", "amount": "17"},
                  retrieval_price_per_blob_min={"denom": "stake", "amount": "17"},
                  retrieval_price_per_blob_max={"denom": "stake", "amount": "17"},
                  retrieval_burn_bps="3333")
    mint = genesis["app_state"]["mint"]
    if mint["params"]["mint_denom"] != "stake":
        raise ValueError("settlement smoke requires normal stake mint denomination")
    raw = json.dumps(genesis, sort_keys=True, indent=1) + "\n"
    for node in lifecycle.nodes:
        (Path(node["home"]) / "config/genesis.json").write_text(raw)
        lifecycle.cli(node["home"], "genesis", "validate")
    lifecycle.doc.update(genesis_sha256=artifact.sha256(first), frozen_module_params=params,
                         smoke_mint_profile=mint,
                         economics_scope="normal SDK mint independently reconciled; unexpected module issuance rejected")


def copy_fixture(source, destination, k):
    meta, raw_meta = producer.read_json(Path(source) / "fixture.json")
    payload, raw_payload = producer.read_json(Path(source) / "1.json")
    expected = dict(schema_version=1, k=k, m=4 if k == 8 else 1, slot=0, mdu_index=2,
                    metadata_mdus=2, user_mdus=1, data_bytes=8388608, encoded_blob_bytes=131072,
                    rows_per_slot=64 // k, proofs_per_session=64 // k,
                    challenge_kind="legacy-fixed-z", data_pattern="be-fr-last-byte-cycle-1-through-251-v1",
                    trusted_setup_sha256=producer.SETUP_DIGEST)
    if any(meta.get(key) != value for key, value in expected.items()):
        raise ValueError("requires full-row exported nonconstant slot-zero K8/K2 fixture")
    root = meta.get("manifest_root", "")
    if not isinstance(root, str) or not root.startswith("0x") or len(root) != 66 or not any(bytes.fromhex(root[2:])):
        raise ValueError("invalid fixture manifest root")
    if hashlib.sha256(raw_payload).hexdigest() != meta["proof_payload_sha256"]:
        raise ValueError("fixture payload digest mismatch")
    if len(payload["proofs"]) != 64 // k:
        raise ValueError("incomplete fixture rows")
    for row, proof in enumerate(payload["proofs"]):
        if producer.uint(proof["mdu_index"]) != 2 or producer.uint(proof.get("blob_index", 0)) != row or not any(producer.b64(proof["blob_commitment"], 48)):
            raise ValueError("invalid fixture row/commitment")
    destination.mkdir(mode=0o700)
    (destination / "fixture.json").write_bytes(raw_meta)
    (destination / "1.json").write_bytes(raw_payload)
    return dict(meta, directory=str(destination), source_directory=str(Path(source).resolve()),
                metadata_sha256=hashlib.sha256(raw_meta).hexdigest())


def transaction_job(lifecycle, signer, args, *, kind="setup", gas="2000000"):
    home, node = lifecycle.nodes[0]["home"], lifecycle.nodes[0]
    common = ["--home", home, "--node", f'http://127.0.0.1:{node["rpc"]}']
    job = dict(signer=signer, kind=kind, timeout_seconds=60,
               env={key: lifecycle.env[key] for key in ENV_KEYS if key in lifecycle.env},
               _deadline_ns=lifecycle.deadline,
               submit=[str(lifecycle.binary), "tx", "nilchain", *map(str, args), *common,
                       "--from", signer, "--keyring-backend", "test", "--chain-id", lifecycle.chain,
                       "--gas", gas, "--gas-adjustment", "1.6", "--gas-prices", "0.001aatom",
                       "--broadcast-mode", "sync", "--output", "json", "--yes"],
               query=[str(lifecycle.binary), "query", "tx", *common, "--output", "json"])
    artifact.validate_scheduled_command(job)
    return job


def build_operations(lifecycle, fixtures, deals, minimum_height):
    operations = []
    for i, k in enumerate((8, 2)):
        deal, fixture = deals[k], fixtures[k]
        owner, payee = lifecycle.signers[f"owner{i}"], lifecycle.signers[f"provider{i}"]
        if deal["owner"] != owner or producer.b64(deal["manifest_root"], 32).hex() != fixture["manifest_root"][2:]:
            raise ValueError("committed deal differs from owner/fixture intent")
        slots = [slot for slot in deal["mode2_slots"] if producer.uint(slot.get("slot", 0)) == 0]
        if len(slots) != 1 or slots[0]["status"] not in (1, "SLOT_STATUS_ACTIVE") or slots[0].get("pending_provider", ""):
            raise ValueError("requires one active slot-zero assignment")
        provider = slots[0]["provider"]
        producer.account(provider)
        if provider not in lifecycle.signers.values():
            raise ValueError("assignment belongs to an unexpected provider")
        if producer.uint(deal["total_mdus"]) != 3 or producer.uint(deal["witness_mdus"]) != 1 or producer.uint(deal["redundancy_mode"]) != 2:
            raise ValueError("committed deal allocation mismatch")
        expiry = minimum_height + 200
        if expiry > producer.uint(deal["end_block"]):
            raise ValueError("insufficient deal lifetime")
        for nonce, count in enumerate(COUNTS, 1):
            opened = transaction_job(lifecycle, owner, ["open-retrieval-session", "--deal-id", deal["id"],
                "--provider", provider, "--manifest-root", fixture["manifest_root"], "--start-mdu-index", "2",
                "--start-blob-index", "0", "--blob-count", count, "--nonce", nonce, "--expires-at", expiry,
                "--challenge-version", "2", "--authorized-proof-provider", payee])
            proof = transaction_job(lifecycle, payee, ["submit-retrieval-proof", "{proof_path}"], gas="auto")
            confirmation = transaction_job(lifecycle, owner, ["confirm-retrieval-session", "--session-id", "{session_id}"])
            operations.append(dict(operation_id=f"k{k}-blobs{count}", phase="measurement", offered_offset_ns=0,
                **{"open-session": opened, "submit-proof": {key: value for key, value in proof.items() if key != "submit"},
                   "confirm": confirmation}, proof_submit=proof["submit"],
                proof_expectation=dict(minimum_opened_height=minimum_height,
                    session=dict(deal_id=deal["id"], owner=owner, provider=provider, authorized_proof_provider=payee,
                        manifest_root=fixture["manifest_root"][2:], nonce=nonce, expires_at=expiry, start_mdu_index=2,
                        start_blob_index=0, blob_count=count, total_bytes=count * 131072, funding=1, locked_fee=str(count * 17)),
                    snapshot=dict(chain_id=lifecycle.chain, setup_digest=producer.SETUP_DIGEST,
                        generation=deal.get("current_gen", "0"), layout=2, k=k, m=fixture["m"], slot=0,
                        metadata_mdus=2, user_mdus=1, deal_end=deal["end_block"]))))
    return operations


def journal_results(path, operations, *, proof_only=False, require_all_committed=True):
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        rows = {identity: json.loads(result) if result else None for identity, result in db.execute("SELECT id, result FROM operations")}
        transactions = [json.loads(row[0]) for row in db.execute("SELECT result FROM transactions ORDER BY rowid")]
    expected = [op["operation_id"] for op in operations]
    if len(set(expected)) != len(expected) or set(rows) != set(expected) or any(not row for row in rows.values()):
        raise ValueError("incomplete lifecycle journal")
    if require_all_committed and any(row.get("all_transactions_committed") is not True for row in rows.values()):
        raise ValueError("lifecycle did not commit every open/proof/confirmation; inspect retained journal")
    if len(transactions) != (1 if proof_only else 3) * len(operations):
        raise ValueError("unexpected transaction outcomes")
    if proof_only:
        outcomes = {"committed_success", "committed_failure", "checktx_rejected", "unknown",
                    "not_submitted", "skipped", "duplicate"}
        mapped = {}
        hashes = set()
        for transaction in transactions:
            identity = transaction.get("operation_id")
            if identity not in rows or identity in mapped or transaction.get("outcome") not in outcomes:
                raise ValueError("unexpected transaction outcomes")
            txhash = transaction.get("txhash")
            if transaction["outcome"] == "duplicate":
                if not txhash or txhash not in hashes:
                    raise ValueError("inconsistent duplicate transaction outcome")
            elif txhash:
                if txhash in hashes:
                    raise ValueError("duplicate transaction hash was counted twice")
                hashes.add(txhash)
            mapped[identity] = transaction
        if set(mapped) != set(expected):
            raise ValueError("unexpected transaction outcomes")
        for identity, transaction in mapped.items():
            valid = (transaction["outcome"] == "committed_success" and
                     transaction.get("proof_state_verified") is True)
            if (rows[identity].get("operation_id") != identity or
                rows[identity].get("outcome") != transaction["outcome"] or
                rows[identity].get("proof_submitted") is not valid):
                raise ValueError("inconsistent proof lifecycle outcome")
    if require_all_committed and (any(row["outcome"] != "committed_success" for row in transactions) or
            (proof_only and any(row.get("proof_submitted") is not True for row in rows.values()))):
        raise ValueError("unexpected transaction outcomes")
    ids = [row["session_id"] for row in rows.values()]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate committed session")
    return rows, transactions


def assignment_submission_counts(operations, transactions):
    """Report bundle and opening outcomes per native storage assignment."""
    expected = {operation["operation_id"]: operation for operation in operations}
    counts = {}
    for operation in operations:
        slot = str(operation["proof_expectation"]["snapshot"]["slot"])
        openings = producer.uint(operation["proof_expectation"]["session"]["blob_count"])
        row = counts.setdefault(slot, dict(offered_bundles=0, offered_openings=0,
            submitted_bundles=0, submitted_openings=0, committed_valid_bundles=0,
            committed_valid_openings=0))
        row["offered_bundles"] += 1
        row["offered_openings"] += openings
    seen = set()
    hashes = set()
    for transaction in transactions:
        identity = transaction.get("operation_id")
        if identity not in expected or identity in seen:
            raise ValueError("assignment accounting requires one transaction per operation")
        seen.add(identity)
        txhash = transaction.get("txhash")
        if transaction.get("outcome") == "duplicate":
            if not txhash or txhash not in hashes:
                raise ValueError("assignment accounting has inconsistent duplicate transaction")
        elif txhash:
            if txhash in hashes:
                raise ValueError("assignment accounting counted a transaction hash twice")
            hashes.add(txhash)
        operation = expected[identity]
        slot = str(operation["proof_expectation"]["snapshot"]["slot"])
        openings = producer.uint(operation["proof_expectation"]["session"]["blob_count"])
        row = counts[slot]
        if transaction.get("outcome") not in ("not_submitted", "skipped"):
            row["submitted_bundles"] += 1
            row["submitted_openings"] += openings
        if (transaction.get("outcome") == "committed_success" and
                transaction.get("proof_state_verified") is True):
            row["committed_valid_bundles"] += 1
            row["committed_valid_openings"] += openings
    if seen != set(expected):
        raise ValueError("assignment accounting is missing transaction outcomes")
    return counts


def export_inventory_request(operation, session_id, evidence, output_path, directories):
    """Bind an exported proof request to its assigned provider artifact."""
    expectation = operation["proof_expectation"]
    session, snapshot = expectation["session"], expectation["snapshot"]
    rows = artifact.BLOBS_PER_MDU // producer.uint(snapshot["k"])
    if producer.uint(session["start_blob_index"]) != producer.uint(snapshot["slot"]) * rows:
        raise ValueError("full-row exporter request does not start at its assignment")
    assigned = session["provider"]
    if assigned not in directories:
        raise ValueError("missing artifact directory for assigned provider")
    return dict(artifact_directory=str(directories[assigned]), evidence=evidence,
                expected=expectation, session_id=session_id, output_path=output_path)


def retrieval_snapshot(lifecycle, height, deals, session_ids):
    bank = lifecycle.snapshot(height)
    rows = []
    for node in lifecycle.nodes:
        module = lifecycle.query(node, "/cosmos/auth/v1beta1/module_accounts/nilchain", height)["account"]["base_account"]["address"]
        producer.account(module)
        coin = lifecycle.query(node, f"/cosmos/bank/v1beta1/balances/{module}/by_denom?denom=stake", height)["balance"]
        if coin["denom"] != "stake":
            raise ValueError("wrong module denomination")
        row = dict(module_address=module, module_stake=coin["amount"], deals={}, activities={}, sessions={},
                   params=lifecycle.query(node, API + "/params", height)["params"])
        for deal in deals.values():
            identity = str(deal["id"])
            row["deals"][identity] = lifecycle.query(node, API + "/deals/" + identity, height)["deal"]
            row["activities"][identity] = lifecycle.query(node, API + "/deals/" + identity + "/activity", height)["activity"]
        for sid in session_ids:
            encoded = urllib.parse.quote(base64.urlsafe_b64encode(bytes.fromhex(sid)).decode(), safe="")
            row["sessions"][sid] = lifecycle.query(node, API + "/retrieval-sessions/" + encoded, height)["session"]
        rows.append(row)
    if any(row != rows[0] for row in rows[1:]):
        raise ValueError("four validators disagree on pinned retrieval state/economics")
    return dict(bank=bank, retrieval=rows[0])


def block_issuance(result, height, mint_address):
    """Reconcile committed bank coinbase events against the SDK mint event."""
    if producer.uint(result["height"]) != height:
        raise ValueError("issuance block height mismatch")
    final = result["finalize_block_events"]
    txs = result["txs_results"]
    if not isinstance(final, list) or (txs is not None and not isinstance(txs, list)):
        raise ValueError("missing committed event lists")
    successful = [row["events"] for row in (txs or []) if producer.uint(row.get("code", 0)) == 0]
    minted, bank = [], []
    for source, events in [("finalize", final)] + [("transaction", events) for events in successful]:
        if not isinstance(events, list):
            raise ValueError("missing successful transaction events")
        for event in events:
            if event["type"] not in ("mint", "coinbase"):
                continue
            pairs = event["attributes"]
            attrs = {pair["key"]: pair["value"] for pair in pairs}
            if len(attrs) != len(pairs) or source != "finalize":
                raise ValueError("duplicate mint attributes or unexpected transaction issuance")
            if event["type"] == "mint":
                if not isinstance(attrs["amount"], str) or not re.fullmatch(r"0|[1-9][0-9]*", attrs["amount"]):
                    raise ValueError("malformed SDK mint amount")
                minted.append(producer.uint(attrs["amount"], 256))
            else:
                if attrs["minter"] != mint_address or not isinstance(attrs["amount"], str) or not re.fullmatch(r"[1-9][0-9]*stake", attrs["amount"]):
                    raise ValueError("unexpected mint module, denomination or amount")
                bank.append(producer.uint(attrs["amount"][:-5], 256))
    if len(minted) != 1 or len(bank) > 1 or sum(bank) != minted[0]:
        raise ValueError("missing or inconsistent SDK mint/coinbase evidence")
    return dict(height=height, issued_stake=sum(bank), finalize_block_events=final,
                successful_transaction_events=successful)


def collect_issuance(lifecycle, before, after):
    """Bounded, cached four-node evidence for the exact snapshot interval."""
    start, end = (producer.uint(row["bank"]["height"]) for row in (before, after))
    if end < start or end - start > 4096 or len({node["node_id"] for node in lifecycle.nodes}) != 4 or len(lifecycle.nodes) != 4:
        raise ValueError("invalid four-validator issuance interval")
    evidence = lifecycle.doc.setdefault("mint_issuance", dict(blocks={}))
    if "module_address" not in evidence:
        accounts = [lifecycle.query(node, "/cosmos/auth/v1beta1/module_accounts/mint", start)["account"] for node in lifecycle.nodes]
        if any(account != accounts[0] for account in accounts[1:]) or accounts[0]["name"] != "mint":
            raise ValueError("validators disagree on SDK mint module")
        producer.account(accounts[0]["base_account"]["address"])
        evidence["module_address"] = accounts[0]["base_account"]["address"]
        evidence["validators"] = [node["node_id"] for node in lifecycle.nodes]
    for height in range(start + 1, end + 1):
        key = str(height)
        if key not in evidence["blocks"]:
            rows = [block_issuance(lifecycle.query(node, f"/block_results?height={height}"), height,
                                  evidence["module_address"]) for node in lifecycle.nodes]
            if any(row != rows[0] for row in rows[1:]):
                raise ValueError("validators disagree on committed issuance events")
            evidence["blocks"][key] = rows[0]
    return sum(evidence["blocks"][str(height)]["issued_stake"] for height in range(start + 1, end + 1))


def verify_settlement(before, after, operations, results, transactions, signers, *, issued_stake=0):
    if before["retrieval"]["params"] != after["retrieval"]["params"]:
        raise ValueError("retrieval pricing changed across the smoke")
    params = after["retrieval"]["params"]
    if (params["base_retrieval_fee"] != {"denom": "stake", "amount": "3"} or
        params["retrieval_price_per_blob"] != {"denom": "stake", "amount": "17"} or producer.uint(params["retrieval_burn_bps"]) != 3333):
        raise ValueError("unexpected smoke prices")
    payouts, debits, counts, byte_counts = {}, {}, {}, {}
    burns = 0
    confirmations = {row["operation_id"]: row for row in transactions if row["kind"] == "confirm"}
    for op in operations:
        expected = op["proof_expectation"]["session"]
        sid = results[op["operation_id"]]["session_id"]
        session = after["retrieval"]["sessions"][sid]
        checked = artifact.session_state({"session": session}, sid, expected["deal_id"], expected["owner"],
            expected["provider"], expected["nonce"], expected["blob_count"], expected["manifest_root"], confirmations[op["operation_id"]]["height"])
        if not checked["completed"] or producer.uint(session["challenge_version"]) != 2 or producer.uint(session["locked_fee"], 256) != 0 or session["authorized_proof_provider"] != expected["authorized_proof_provider"] or session.get("payer", ""):
            raise ValueError("session has not settled under its frozen authority")
        if session["funding"] not in (1, "RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW"):
            raise ValueError("wrong funding source")
        variable = int(expected["locked_fee"])
        burn = (variable * 3333 + 9999) // 10000
        payee, deal = expected["authorized_proof_provider"], str(expected["deal_id"])
        payouts[payee] = payouts.get(payee, 0) + variable - burn
        debits[deal] = debits.get(deal, 0) + 3 + variable
        counts[deal] = counts.get(deal, 0) + 1
        byte_counts[deal] = byte_counts.get(deal, 0) + expected["total_bytes"]
        burns += 3 + burn
    def delta(old, new):
        return producer.uint(new, 256) - producer.uint(old, 256)
    for name, address in signers.items():
        label = name + ":stake"
        if delta(before["bank"]["balances"][label], after["bank"]["balances"][label]) != payouts.get(address, 0):
            raise ValueError("owner/provider/control stake balance mismatch: " + name)
    for identity, debit in debits.items():
        if delta(before["retrieval"]["deals"][identity]["escrow_balance"], after["retrieval"]["deals"][identity]["escrow_balance"]) != -debit:
            raise ValueError("owner escrow debit mismatch")
        for field, expected in (("successful_retrievals_total", counts[identity]), ("bytes_served_total", byte_counts[identity]), ("failed_challenges_total", 0)):
            if delta(before["retrieval"]["activities"][identity].get(field, 0), after["retrieval"]["activities"][identity].get(field, 0)) != expected:
                raise ValueError("retrieval activity accounting mismatch")
    if (delta(before["retrieval"]["module_stake"], after["retrieval"]["module_stake"]) != -sum(debits.values()) or
        delta(before["bank"]["supply"]["stake"], after["bank"]["supply"]["stake"]) != producer.uint(issued_stake, 256) - burns):
        raise ValueError("module/supply conservation mismatch")
    return dict(completed_sessions=len(operations), proofs=sum(op["proof_expectation"]["session"]["blob_count"] for op in operations),
                escrow_debits=debits, provider_payouts=payouts, burned_stake=burns, issued_stake=issued_stake,
                byte_counter_scope="protocol counters; no network-delivered bytes verified")


def read_session_evidence(lifecycle, operation, sid, height, deadline):
    node = lifecycle.nodes[0]
    deadline = min(deadline, lifecycle.deadline)
    request = dict(action="evidence", config=dict(rpc=f'http://127.0.0.1:{node["rpc"]}',
        api=f'http://127.0.0.1:{node["api"]}', node_id=node["node_id"]),
        expected=operation["proof_expectation"], session_id=sid, height=height, deadline=deadline)
    result = artifact.run_bounded_command([sys.executable, producer.__file__, json.dumps(request)],
                                         min(deadline, lifecycle.deadline), env=lifecycle.env)
    if result.returncode:
        raise ValueError("committed proof evidence read failed: " + result.stderr[-8192:])
    return json.loads(result.stdout)


def prepared_cohort(lifecycle, operations, prepare):
    """Prepare this bounded smoke inventory before the measured proof-only stage."""
    prepared = []
    transactions = lifecycle.doc["preparation_transactions"] = []
    for operation in operations:
        result = artifact.scheduled_transaction(operation["open-session"])
        result.update(operation_id=operation["operation_id"], kind="open-session")
        transactions.append(result)
        lifecycle.save()
        if result["outcome"] != "committed_success":
            raise ValueError("prepared cohort open failed or ambiguous; no signer retry")
        sid = artifact.opened_session_id(result)
        proof = prepare(operation, sid, lifecycle.deadline)
        path = proof["submit"][4]
        item = {key: value for key, value in operation.items() if key not in ("open-session", "confirm", "proof_submit")}
        item["submit-proof"] = dict(operation["submit-proof"], submit=proof["submit"])
        item["prepared"] = dict(session_id=sid, proof_path=path, proof_sha256=artifact.sha256(path),
            evidence=read_session_evidence(lifecycle, operation, sid, None, lifecycle.deadline))
        artifact.prepared_session_pin(item, item["prepared"]["evidence"])
        prepared.append(item)
    return prepared


def assert_unchanged_retrieval(before, after, *, issued_stake=0):
    """Failed messages and terminal retries cannot change stake liabilities/credit.

    Ante fees and sequences use aatom and may change even for failed execution.
    Independent committed SDK issuance is the only permitted stake supply change.
    """
    def stake(snapshot):
        return {key: value for key, value in snapshot["bank"]["balances"].items() if key.endswith(":stake")}
    if (before["retrieval"] != after["retrieval"] or stake(before) != stake(after) or
            producer.uint(after["bank"]["supply"]["stake"], 256) - producer.uint(before["bank"]["supply"]["stake"], 256) != producer.uint(issued_stake, 256)):
        raise ValueError("rejected message or terminal retry changed retrieval state/stake")


def verify_transaction_nodes(lifecycle, result):
    """Independently bind all four committed outcomes to the actual signed bytes."""
    if len(lifecycle.nodes) != 4 or len({node["node_id"] for node in lifecycle.nodes}) != 4:
        raise ValueError("four distinct validators required")
    expected = artifact.committed_tx(result, result["txhash"])
    height = producer.uint(expected["height"])
    # A node can report the committed transaction before its peers' transaction
    # indexes expose it. Fence every validator, then read the authoritative block
    # bytes/results rather than polling eventually consistent secondary indexes.
    lifecycle.wait_height(height + 1)
    observed = []
    for node in lifecycle.nodes:
        summary = artifact.committed_block_summary(
            lifecycle.query(node, f"/block?height={height}"),
            lifecycle.query(node, f"/block_results?height={height}"), height, lifecycle.chain)
        matches = [tx for tx in summary["transactions"]
                   if tx["txhash"].upper() == expected["txhash"].upper()]
        if len(matches) != 1:
            raise ValueError("validator block does not contain the exact committed transaction")
        row = dict(matches[0], height=height)
        artifact.committed_tx(row, expected["txhash"])
        if any(producer.uint(row[key]) != producer.uint(expected[key]) for key in ("height", "code", "gas_wanted", "gas_used")):
            raise ValueError("validators disagree on committed transaction outcome/gas")
        observed.append(dict(node_id=node["node_id"], **row))
    return observed


def run_adversarial_phase(lifecycle, deals, prepared, *, completed=False):
    """Five rejected transactions before proofs; four terminal idempotent retries."""
    phase = "after-settlement" if completed else "before-proof"
    directory = lifecycle.home / phase
    directory.mkdir(mode=0o700)
    record = dict(transactions=[], qualification=False,
                  economics_scope="normal SDK mint reconciled; stake liabilities unchanged; aatom ante fees excluded")
    lifecycle.doc.setdefault("adversarial_phases", {})[phase] = record
    ids = [op["prepared"]["session_id"] for op in prepared]
    before = retrieval_snapshot(lifecycle, lifecycle.wait_height(3) - 1, deals, ids)
    record["before"] = before
    def payload(op):
        return json.loads(Path(op["prepared"]["proof_path"]).read_text())
    def changed_scalar(value):
        old = producer.b64(value, 32)
        return base64.b64encode(bytes(32) if any(old) else bytes([1]) + bytes(31)).decode()
    cases = []
    for k in (8, 2):
        op = next(op for op in prepared if op["proof_expectation"]["snapshot"]["k"] == k)
        payee = op["proof_expectation"]["session"]["authorized_proof_provider"]
        if completed:
            cases += [(f"duplicate-proof-k{k}", payee, payload(op), "", None),
                      (f"duplicate-confirm-k{k}", op["proof_expectation"]["session"]["owner"], None, "", op["prepared"]["session_id"])]
        else:
            wrong = payload(op)
            wrong["proofs"][0]["z_value"] = changed_scalar(wrong["proofs"][0]["z_value"])
            cases += [(f"wrong-signer-k{k}", lifecycle.signers["control"], payload(op), "authorized proof provider", None),
                      (f"wrong-z-k{k}", payee, wrong, "exact session challenge tuple and z", None)]
    if not completed:
        first, second = [op for op in prepared if op["proof_expectation"]["snapshot"]["k"] == 8][:2]
        payee = first["proof_expectation"]["session"]["authorized_proof_provider"]
        if second["proof_expectation"]["session"]["authorized_proof_provider"] != payee:
            raise ValueError("rollback test requires two distinct sessions with one signer")
        bad = payload(second)
        bad["proofs"][0]["y_value"] = changed_scalar(bad["proofs"][0]["y_value"])
        cases.append(("later-native-failure", payee, dict(sessions=[payload(first), bad]), "invalid retrieval proof", None))
    for name, signer, body, reason, sid in cases:
        if body is None:
            args = ["confirm-retrieval-session", "--session-id", sid]
        else:
            path = directory / (name + ".json")
            with path.open("x") as target:
                json.dump(body, target)
            args = ["submit-retrieval-proof", str(path)]
        # Fixed gas forces actual execution: auto simulation must not replace rejection evidence.
        job = transaction_job(lifecycle, signer, args, kind=name, gas="20000000")
        result = artifact.scheduled_transaction(job)
        row = dict(result, kind=name, signer=signer, submit=job["submit"])
        record["transactions"].append(row)
        lifecycle.save()
        expected = "committed_success" if completed else "committed_failure"
        if result["outcome"] != expected or (reason and reason not in result.get("error", "")):
            raise ValueError("unexpected adversarial outcome; no retry: " + name)
        lifecycle.wait_height(result["height"] + 1)
        row["validators"] = verify_transaction_nodes(lifecycle, result)
        after = retrieval_snapshot(lifecycle, result["height"], deals, ids)
        row["issued_stake_since_phase_start"] = collect_issuance(lifecycle, before, after)
        assert_unchanged_retrieval(before, after, issued_stake=row["issued_stake_since_phase_start"])
        row["state_unchanged"] = True
        record["after"] = after
        lifecycle.save()
    return record["after"]


def run(lifecycle, fixture_k8, fixture_k2, *, proof_only=False):
    lifecycle.home.mkdir(mode=0o700)
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"interrupted by signal {signum}")
    for sig in previous:
        signal.signal(sig, interrupted)
    doc = lifecycle.doc
    doc.pop("transactions_submitted", None)  # On failure the retained journal is authoritative.
    doc.update(mode="four-validator-fresh-settlement-smoke", workload="two owner escrows; K8/K2 slot zero; 1/2/8 blobs each",
               limits=["Preparation only; no capacity qualification", "No provider transport or delivered-file verification",
                       "Only slot zero; nonzero stripe slots remain outstanding", "Normal SDK mint reconciled; unexpected module issuance rejected"],
               setup_transactions=[])
    try:
        require_retrieval_cli(lifecycle)
        fixtures = {k: copy_fixture(path, lifecycle.home / f"fixture-k{k}", k) for k, path in ((8, fixture_k8), (2, fixture_k2))}
        doc["fixtures"] = fixtures
        lifecycle.reserve_ports()
        doc["provenance"] = {"source_checkout": artifact.command("git", "-C", str(lifecycle.root), "rev-parse", "HEAD"),
            "binary_sha256": artifact.sha256(lifecycle.binary), "native_library_sha256": artifact.sha256(lifecycle.library),
            "trusted_setup_sha256": artifact.sha256(lifecycle.env["POLYSTORE_TRUSTED_SETUP"]),
            "driver_sha256": artifact.sha256(__file__), "harness_sha256": artifact.sha256(artifact.__file__),
            "producer_sha256": artifact.sha256(producer.__file__),
            "commit_metrics_sha256": artifact.sha256(commit_metrics.__file__),
            "working_tree_status": artifact.command("git", "-C", str(lifecycle.root), "status", "--porcelain"),
            "source_diff_sha256": hashlib.sha256(artifact.command("git", "-C", str(lifecycle.root), "diff", "HEAD", "--", "polystorechain", "polystore_core", "scripts").encode()).hexdigest(),
            "artifact_source_match": "supplied binary/library; build correspondence not attested"}
        lifecycle.prepare()
        smoke_genesis(lifecycle)
        lifecycle.save()
        lifecycle.start("initial")
        lifecycle.wait_height(3)
        def send(name, args):
            lifecycle.remaining()
            job = transaction_job(lifecycle, lifecycle.signers[name], args)
            result = artifact.scheduled_transaction(job)
            doc["setup_transactions"].append(dict(result, signer=job["signer"], submit=job["submit"]))
            lifecycle.save()
            if result["outcome"] != "committed_success":
                raise ValueError("setup transaction failed or ambiguous; no signer retry")
            return result
        for i in range(12):
            send(f"provider{i}", ["register-provider", "General", "100000000000", "--endpoint", f"/ip4/127.0.0.1/tcp/{9000+i}/http"])
        deals = {}
        for i, k in enumerate((8, 2)):
            created = send(f"owner{i}", ["create-deal", "100000", "100000000", "10000000", "--service-hint", f'General:rs={k}+{fixtures[k]["m"]}'])
            lifecycle.wait_height(created["height"] + 1)
            found = lifecycle.query(lifecycle.nodes[0], API + "/deals", created["height"])["deals"]
            owned = [deal for deal in found if deal["owner"] == lifecycle.signers[f"owner{i}"]]
            if len(owned) != 1:
                raise ValueError("expected exactly one newly committed owner deal")
            identity = str(owned[0].get("id", "0"))
            updated = send(f"owner{i}", ["update-deal-content", "--deal-id", identity, "--cid", fixtures[k]["manifest_root"],
                "--size", "8126464", "--total-mdus", "3", "--witness-mdus", "1"])
            lifecycle.wait_height(updated["height"] + 1)
            deal = lifecycle.query(lifecycle.nodes[0], API + "/deals/" + identity, updated["height"])["deal"]
            deal["id"] = identity  # Proto JSON can omit the legitimate first deal ID zero.
            deals[k] = deal
        height = lifecycle.wait_height(3) - 1
        before = retrieval_snapshot(lifecycle, height, deals, [])
        operations = build_operations(lifecycle, fixtures, deals, height + 1)
        doc.update(before_workload=before, operations=operations)
        builders = {k: artifact.fresh_session_proof_builder(dict(library=str(lifecycle.library),
            setup=lifecycle.env["POLYSTORE_TRUSTED_SETUP"], fixture=fixtures[k]["directory"],
            rpc=f'http://127.0.0.1:{lifecycle.nodes[0]["rpc"]}', api=f'http://127.0.0.1:{lifecycle.nodes[0]["api"]}',
            node_id=lifecycle.nodes[0]["node_id"]), lifecycle.home / f"fresh-k{k}") for k in (8, 2)}
        def prepare(operation, sid, deadline):
            return builders[operation["proof_expectation"]["snapshot"]["k"]](operation, sid, min(deadline, lifecycle.deadline))
        journal = lifecycle.home / "workload.sqlite"
        doc["workload_journal"] = str(journal)
        lifecycle.save()
        scheduled = prepared_cohort(lifecycle, operations, prepare) if proof_only else operations
        if proof_only:
            run_adversarial_phase(lifecycle, deals, scheduled)
        doc["measurement_mode"] = "prepared-proof-only" if proof_only else "lifecycle"
        lifecycle.save()
        capture_workload_metrics(lifecycle, "before_workload", fenced=proof_only)
        doc["scheduler"] = artifact.schedule_retrieval_lifecycles(scheduled, journal_path=journal,
            signers=list(lifecycle.signers.values()), prepare_session_proof=prepare,
            mode=doc["measurement_mode"], read_session_evidence=lambda op, sid, h, d: read_session_evidence(lifecycle, op, sid, h, d),
            max_in_flight=2, max_queued=16, max_queued_per_signer=8)
        results, transactions = journal_results(journal, operations, proof_only=proof_only)
        doc.update(operation_results=results, workload_transactions=transactions)
        capture_workload_metrics(lifecycle, "after_workload", fenced=proof_only)
        if proof_only:
            doc["commit_step_metrics"]["boundaries_reconciled"] = True
            doc["commit_step_metrics"]["limitation"] = "Proof-only smoke; per-node fenced intervals, no sustained-load or capacity qualification"
            doc["commit_step_metrics"]["node_intervals"] = []
            for index in range(4):
                samples = [doc["commit_step_metrics"]["phases"][phase]["nodes"][index]["sample"]
                           for phase in ("before_workload", "after_workload")]
                if not all(samples[0]["committed_height"] < row["height"] <= samples[-1]["committed_height"] for row in transactions):
                    raise ValueError("proof workload transactions fall outside fenced measurement blocks")
                doc["commit_step_metrics"]["node_intervals"].append(dict(node_id=lifecycle.nodes[index]["node_id"],
                    **commit_metrics.summarize_commit_metrics(samples,
                        start_committed_height=samples[0]["committed_height"], end_committed_height=samples[-1]["committed_height"],
                        boundaries_reconciled=True)))
            confirmations = doc["post_measurement_transactions"] = []
            for op in operations:
                job = dict(op["confirm"], submit=[arg.replace("{session_id}", results[op["operation_id"]]["session_id"])
                                                for arg in op["confirm"]["submit"]])
                result = artifact.scheduled_transaction(job)
                result.update(operation_id=op["operation_id"], kind="confirm")
                confirmations.append(result)
                lifecycle.save()
                if result["outcome"] != "committed_success":
                    raise ValueError("post-measurement confirmation failed or ambiguous; no signer retry")
            transactions = doc["preparation_transactions"] + transactions + confirmations
        doc["transactions_submitted"] = len(doc["setup_transactions"]) + len(transactions)
        doc["fresh_proof_artifacts"] = {}
        for op in operations:
            sid = results[op["operation_id"]]["session_id"]
            k = op["proof_expectation"]["snapshot"]["k"]
            path = lifecycle.home / f"fresh-k{k}" / (sid + ".json")
            doc["fresh_proof_artifacts"][sid] = dict(path=str(path), sha256=artifact.sha256(path))
        height = lifecycle.wait_height(max(row["height"] for row in transactions) + 1) - 1
        ids = [row["session_id"] for row in results.values()]
        after = retrieval_snapshot(lifecycle, height, deals, ids)
        doc["settlement"] = verify_settlement(before, after, operations, results, transactions, lifecycle.signers,
            issued_stake=collect_issuance(lifecycle, before, after))
        doc["after_workload"] = after
        if proof_only:
            after = run_adversarial_phase(lifecycle, deals, scheduled, completed=True)
            height = after["bank"]["height"]
            doc["after_adversarial_retries"] = after
            doc["transactions_submitted"] += sum(len(phase["transactions"]) for phase in doc["adversarial_phases"].values())
        doc["workload_transaction_validators"] = [verify_transaction_nodes(lifecycle, row) for row in transactions]
        lifecycle.save()
        lifecycle.stop()
        lifecycle.reserve_ports()
        lifecycle.start("restart")
        later = lifecycle.wait_height(height + 3) - 1
        restarted = retrieval_snapshot(lifecycle, height, deals, ids)
        if restarted != after:
            raise ValueError("restart changed the fixed-height settlement state")
        doc["after_restart_original_height"] = restarted
        doc["after_restart_later_height"] = retrieval_snapshot(lifecycle, later, deals, ids)
        verify_settlement(before, doc["after_restart_later_height"], operations, results, transactions, lifecycle.signers,
            issued_stake=collect_issuance(lifecycle, before, doc["after_restart_later_height"]))
        doc["status"] = "settlement_smoke_passed"
    except BaseException as error:
        doc.update(status="failed", error=str(error)[-8192:])
        raise
    finally:
        try:
            try:
                lifecycle.stop()
            finally:
                for reservation in lifecycle.reservations:
                    reservation.close()
                lifecycle.save()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    return lifecycle.home / "evidence.json"


def healthy_audit_views(value, deal, providers, epoch, epoch_length, chain, *, finalized,
                        expected_samples=None, k=2, user_mdus=1):
    """Check committed inventory/coverage without treating absent audits as success."""
    layout = mode2_layout(k)
    found = {}
    for view in value:
        audit = view["audit"]
        if producer.uint(audit["epoch_id"]) != epoch:
            continue
        assignment = audit["assignment"]
        snapshot = assignment["snapshot"]
        slot = producer.uint(snapshot.get("slot", 0), 32)
        if (slot in found or slot not in providers or assignment["provider"] != providers[slot] or
                producer.uint(assignment.get("deal_id", 0)) != producer.uint(deal.get("id", 0)) or
                producer.uint(assignment.get("deal_start", 0)) != producer.uint(deal.get("start_block", 0)) or
                assignment["manifest_root"] != deal["manifest_root"] or producer.uint(assignment["kind"]) != 2 or
                snapshot["chain_id"] != chain or producer.uint(snapshot["generation"]) != producer.uint(deal["current_gen"]) or
                [producer.uint(snapshot[n]) for n in ("layout", "k", "m", "metadata_mdus", "user_mdus")] != [2, k, layout["m"], 2, user_mdus] or
                snapshot["setup_digest"] != base64.b64encode(bytes.fromhex(producer.SETUP_DIGEST)).decode() or
                producer.uint(snapshot["deal_end"]) != producer.uint(deal["end_block"])):
            raise ValueError(f"audit differs from the committed K{k} assignment")
        count = producer.uint(audit["sample_count"])
        if not 1 <= count <= user_mdus * layout["openings_per_bundle"] or (expected_samples is not None and count != expected_samples):
            raise ValueError("invalid audit sample count")
        coverage = producer.b64(audit["coverage"], (count + 7) // 8)
        accepted = producer.uint(audit.get("accepted_count", 0))
        if (sum(bin(byte).count("1") for byte in coverage) != accepted or accepted > count or
                (count % 8 and coverage[-1] >> (count % 8))):
            raise ValueError("audit coverage count or padding mismatch")
        producer.b64(view["seed"], 32)
        snapshot_height = (epoch - 1) * epoch_length
        expected = dict(version=2, chain_id=chain, setup_digest=producer.SETUP_DIGEST, kind=2,
            context_id="00" * 32, deal_id=producer.uint(deal["id"]), generation=producer.uint(deal["current_gen"]),
            root=producer.b64(deal["manifest_root"], 32).hex(), assigned=producer.account(providers[slot]).hex(),
            payee=producer.account(providers[slot]).hex(), layout=2, k=k, m=layout["m"], slot=slot, metadata_mdus=2,
            user_mdus=user_mdus, start_mdu=0, start_leaf=0, blob_count=0, epoch_id=epoch, epoch_length=epoch_length,
            sample_count=count, snapshot_height=snapshot_height, anchor_height=snapshot_height + 1,
            first_response_height=snapshot_height + 2, deadline_height=min(epoch * epoch_length, producer.uint(deal["end_block"]) - 1),
            deal_end=producer.uint(deal["end_block"]))
        context = producer.context_bytes(expected)
        if (producer.uint(view["epoch_length"]) != epoch_length or
                producer.b64(view["canonical_context"], len(context)) != context):
            raise ValueError("invalid canonical audit context")
        if finalized and (view.get("finalized") is not True or accepted != count or producer.uint(audit.get("missed_epochs", 0)) != 0):
            raise ValueError("normal audit did not finalize with complete coverage")
        found[slot] = view
    if set(found) != set(providers) or len(found) != layout["assignments"]:
        raise ValueError("missing or duplicate all-slot audit evidence")
    return found


def sustained_offsets(step_seconds, rate_scale=1):
    """Five fixed offered-rate steps with one bounded rate multiplier."""
    artifact.integer(step_seconds, "step seconds", 4, 180)
    rates = sustained_rates(rate_scale)
    return [(step * step_seconds * 10**9 + index * interval)
            for step, rate in enumerate(rates)
            for interval in (int(10**9 / rate),)
            for index in range((step_seconds * 10**9 + interval - 1) // interval)]


def open_session_batch(lifecycle, operations, directory, command):
    """SDK append signs one atomic transaction with one owner sequence."""
    if not 1 <= len(operations) <= OPEN_SESSION_BATCH_MAX:
        raise ValueError("open batch must contain 1..64 sessions")
    owner = operations[0]["open-session"]["signer"]
    if any(op["open-session"]["signer"] != owner for op in operations):
        raise ValueError("atomic batch requires one owner")
    unsigned, signed = directory / "unsigned.jsonl", directory / "signed.json"
    directory.mkdir(mode=0o700)
    generated_gas = 0
    with unsigned.open("x") as output:
        for index, operation in enumerate(operations):
            args = operation["open-session"]["submit"].copy()
            gas_index = args.index("--gas") + 1
            expected_gas = OPEN_SESSION_PREPARATION_GAS + (OPEN_SESSION_BATCH_BASE_GAS if index == 0 else 0)
            args[gas_index] = str(expected_gas)
            args.append("--generate-only")
            tx = json.loads(command(args))
            messages = tx["body"]["messages"]
            if len(messages) != 1 or messages[0]["@type"] != "/polystorechain.polystorechain.v1.MsgOpenRetrievalSession":
                raise ValueError("generated open transaction has unexpected messages")
            gas = producer.uint(tx.get("auth_info", {}).get("fee", {}).get("gas_limit", 0))
            if gas != expected_gas:
                raise ValueError("generated open transaction has unexpected gas limit")
            generated_gas += gas
            message, expected = messages[0], operation["proof_expectation"]["session"]
            if (message["creator"] != owner or message["provider"] != expected["provider"] or
                    message["authorized_proof_provider"] != expected["authorized_proof_provider"] or
                    producer.b64(message["manifest_root"], 32).hex() != expected["manifest_root"] or
                    producer.uint(message["challenge_version"]) != 2 or any(
                        producer.uint(message.get(key, 0)) != producer.uint(expected[key]) for key in
                        ("deal_id", "start_mdu_index", "start_blob_index", "blob_count", "nonce", "expires_at"))):
                raise ValueError("generated open transaction differs from independent session intent")
            output.write(json.dumps(tx, separators=(",", ":")) + "\n")
    node = lifecycle.nodes[0]
    common = ["--home", node["home"], "--node", f'http://127.0.0.1:{node["rpc"]}',
              "--keyring-backend", "test", "--chain-id", lifecycle.chain]
    command([str(lifecycle.binary), "tx", "sign-batch", str(unsigned), "--append", "--from", owner,
             *common, "--output-document", str(signed)])
    value = json.loads(signed.read_text())
    original = [json.loads(line)["body"]["messages"][0] for line in unsigned.read_text().splitlines()]
    if value["body"]["messages"] != original or len(value["signatures"]) != 1:
        raise ValueError("signed batch differs from ordered open intent")
    signed_gas = producer.uint(value.get("auth_info", {}).get("fee", {}).get("gas_limit", 0))
    expected_batch_gas = OPEN_SESSION_BATCH_BASE_GAS + OPEN_SESSION_PREPARATION_GAS * len(operations)
    if generated_gas != expected_batch_gas or signed_gas != expected_batch_gas or signed_gas > OPEN_SESSION_BATCH_GAS_CAP:
        raise ValueError("signed batch gas differs from bounded generated gas sum")
    job = dict(operations[0]["open-session"], kind="open-session-batch",
               submit=[str(lifecycle.binary), "tx", "broadcast", str(signed), *common,
                       "--broadcast-mode", "sync", "--output", "json"])
    result = artifact.scheduled_transaction(job)
    lifecycle.doc.setdefault("preparation_transactions", []).append(result)
    lifecycle.save()
    if result["outcome"] != "committed_success":
        raise ValueError("atomic open failed or ambiguous; owner quarantined, no retry")
    return artifact.opened_session_ids(result, len(operations)), result["height"]


def start_commit_streams(lifecycle, seconds, processes):
    """The caller owns every unreaped collector until group cleanup."""
    rows = lifecycle.doc["commit_streams"] = []
    for node in lifecycle.nodes:
        path = lifecycle.home / f'commit-{node["node_id"]}.jsonl'
        log = path.with_suffix(".log")
        argv = [sys.executable, commit_metrics.__file__, f'http://127.0.0.1:{node["metrics"]}/metrics',
                lifecycle.chain, "--stream-output", str(path), "--stream-seconds", str(seconds)]
        with log.open("xb") as output:
            process = subprocess.Popen(argv, env=lifecycle.env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(process)
        rows.append(dict(node_id=node["node_id"], path=str(path), log=str(log), pid=process.pid, command=argv))
    return rows


def reconcile_sustained_blocks(lifecycle, journal):
    """Retain bounded public block summaries and verify every committed workload tx."""
    phases = lifecycle.doc["commit_step_metrics"]["phases"]
    before, after = phases["sustained_before"], phases["sustained_after"]
    if not before["complete"] or not after["complete"] or len(before["nodes"]) != 4 or len(after["nodes"]) != 4:
        raise ValueError("four complete metric boundaries required")
    first = min(row["sample"]["committed_height"] for row in before["nodes"]) + 1
    last = max(row["sample"]["committed_height"] for row in after["nodes"])
    artifact.integer(last - first + 1, "fenced block count", 1, 1200)
    with sqlite3.connect(f"file:{journal}?mode=ro", uri=True) as db:
        results = [json.loads(row[0]) for row in db.execute("SELECT result FROM transactions")]
    committed = [row for row in results if row["outcome"] in ("committed_success", "committed_failure")]
    expected = {row["txhash"]: row for row in committed}
    if len(expected) != len(committed):
        raise ValueError("journal repeats a committed transaction hash")
    path = lifecycle.home / "sustained-blocks.jsonl"
    matched = set()
    with path.open("x") as output:
        for height in range(first, last + 1):
            lifecycle.remaining()
            node = lifecycle.nodes[0]
            block = lifecycle.query(node, f"/block?height={height}")
            summary = artifact.committed_block_summary(block,
                lifecycle.query(node, f"/block_results?height={height}"), height, lifecycle.chain)
            for node in lifecycle.nodes:
                signed = lifecycle.query(node, f"/commit?height={height}")
                header, commit = signed["signed_header"]["header"], signed["signed_header"]["commit"]
                if (signed.get("canonical") is not True or producer.uint(header["height"]) != height or
                        producer.uint(commit["height"]) != height or header["chain_id"] != lifecycle.chain or
                        header["time"] != summary["time"] or header["app_hash"].upper() != summary["preceding_app_hash"] or
                        commit["block_id"]["hash"].upper() != summary["block_hash"]):
                    raise ValueError("validators disagree on committed block/application hash or header identity")
            for node in lifecycle.nodes[1:]:
                other = artifact.committed_block_summary(block,
                    lifecycle.query(node, f"/block_results?height={height}"), height, lifecycle.chain)
                if other["transactions"] != summary["transactions"]:
                    raise ValueError("validators disagree on committed transaction results")
            for tx in summary["transactions"]:
                if tx["txhash"] not in expected:
                    continue
                row = expected[tx["txhash"]]
                if tx["txhash"] in matched or row["height"] != height or any(row[key] != tx[key] for key in ("code", "gas_used", "gas_wanted")):
                    raise ValueError("committed workload transaction differs from retained journal")
                tx["operation_id"] = row["operation_id"]
                matched.add(tx["txhash"])
            output.write(json.dumps(summary, sort_keys=True) + "\n")
    if matched != set(expected):
        raise ValueError("fenced blocks omit a committed workload transaction")
    lifecycle.doc["committed_block_reconciliation"] = dict(path=str(path), sha256=artifact.sha256(path),
        first_height=first, last_height=last, committed_workload_transactions=len(matched),
        all_four_headers_agree=True, all_four_results_agree=True, qualification=False)


def summarize_commit_streams(lifecycle, processes):
    """Filter raw observations strictly between the independently pinned fences."""
    phases = lifecycle.doc["commit_step_metrics"]["phases"]
    before = {row["node_id"]: row["sample"] for row in phases["sustained_before"]["nodes"]}
    after = {row["node_id"]: row["sample"] for row in phases["sustained_after"]["nodes"]}
    rows = lifecycle.doc["commit_streams"]
    if len(rows) != 4 or len(processes) != 4 or set(before) != set(after) or {row["node_id"] for row in rows} != set(before):
        raise ValueError("four distinct Commit collectors and matching fences required")
    for row, process in zip(rows, processes):
        row["returncode"] = process.returncode
        if process.returncode not in (0, -signal.SIGTERM):
            raise ValueError("Commit metric collector failed; inspect retained log")
        path = Path(row["path"])
        if path.stat().st_size > 32 * 1024 * 1024:
            raise ValueError("Commit stream exceeds bounded capture size")
        start, end = before[row["node_id"]], after[row["node_id"]]
        samples, count = [start], 0
        with path.open() as source:
            for line in source:
                if len(line) > 16384 or count >= 12000:
                    raise ValueError("Commit stream line/count exceeds capture bound")
                sample = json.loads(line)
                count += 1
                if sample["chain_id"] != lifecycle.chain:
                    raise ValueError("Commit stream belongs to another chain")
                if sample["monotonic_start_ns"] >= start["monotonic_end_ns"] and sample["monotonic_end_ns"] <= end["monotonic_start_ns"]:
                    samples.append(sample)
        if count == 0:
            raise ValueError("Commit collector produced no samples")
        samples.append(end)
        row.update(sha256=artifact.sha256(path), raw_samples=count, fenced_samples=len(samples),
            summary=commit_metrics.summarize_commit_metrics(samples,
                start_committed_height=start["committed_height"], end_committed_height=end["committed_height"],
                boundaries_reconciled=True))
        if row["summary"]["qualified"] is not True:
            raise ValueError("Commit samples do not cover the fenced workload blocks")


def build_sustained_operations(lifecycle, deal, providers, deputies, offsets, minimum, expiry, price, proof_gas, k):
    """Build one native full-row submission bundle per prepared session."""
    layout = mode2_layout(k)
    openings = layout["openings_per_bundle"]
    slots = sorted(providers)
    if slots != list(range(layout["assignments"])):
        raise ValueError("providers must cover every native assignment exactly once")
    owner = lifecycle.signers["owner0"]
    root = producer.b64(deal["manifest_root"], 32).hex()
    operations = []
    warmup_count = len(deputies)
    for index, offset in enumerate([0] * warmup_count + offsets):
        slot = slots[index % len(slots)]
        assigned = providers[slot]
        start_blob_index = slot * openings
        payee, end = deputies[index % len(deputies)], expiry + index // 128
        opening = transaction_job(lifecycle, owner, ["open-retrieval-session", "--deal-id", deal["id"],
            "--provider", assigned, "--manifest-root", "0x" + root, "--start-mdu-index", "2", "--start-blob-index", str(start_blob_index),
            "--blob-count", str(openings), "--nonce", index + 1, "--expires-at", end, "--challenge-version", "2",
            "--authorized-proof-provider", payee], kind="open-session", gas=str(OPEN_SESSION_PREPARATION_GAS))
        proof = transaction_job(lifecycle, payee, ["submit-retrieval-proof", "{proof_path}"], gas=str(proof_gas))
        operations.append(dict(operation_id=f"sustained-{index}", phase="warmup" if index < warmup_count else "measurement",
            offered_offset_ns=offset, **{"open-session": opening, "submit-proof": proof},
            proof_expectation=dict(minimum_opened_height=minimum,
                session=dict(deal_id=deal["id"], owner=owner, provider=assigned, authorized_proof_provider=payee,
                    manifest_root=root, nonce=index + 1, expires_at=end, start_mdu_index=2, start_blob_index=start_blob_index,
                    blob_count=openings, total_bytes=layout["bytes_per_bundle"], funding=1,
                    locked_fee=str(price * openings)),
                snapshot=dict(chain_id=lifecycle.chain, setup_digest=producer.SETUP_DIGEST,
                    generation=deal.get("current_gen", "0"), layout=2, k=k, m=layout["m"], slot=slot,
                    metadata_mdus=2, user_mdus=1, deal_end=deal["end_block"]))))
    return operations


def run_sustained(lifecycle, deal, providers, send, command, audits, wait, exporter, step_seconds, proof_gas,
                  k=2, rate_scale=1, deputy_count=8):
    """Real per-assignment inventory and bounded scheduler; no client ACK claim."""
    import threading
    layout = mode2_layout(k, deputy_count)
    offsets = sustained_offsets(step_seconds, rate_scale)
    rates = sustained_rates(rate_scale)
    duration = step_seconds * len(rates)
    exporter = Path(exporter).resolve(strict=True)
    if not exporter.is_file() or not os.access(exporter, os.X_OK):
        raise ValueError("proof exporter must be executable")
    artifact.integer(proof_gas, "proof gas", 1, 64000000)
    for i in layout["deputy_indices"]:
        send(f"provider{i}", ["register-provider", "General", "100000000000", "--endpoint", "/ip4/127.0.0.1/tcp/1/http"])
    deputies = [lifecycle.signers[f"provider{i}"] for i in layout["deputy_indices"]]
    doc = lifecycle.doc
    profile = sustained_profile(k, step_seconds, offsets, proof_gas, rate_scale, deputy_count)
    openings = profile["openings_per_bundle"]
    doc.update(mode="four-validator-sustained-retrieval",
        workload=f"real K{k} assignment round-robin, {openings} fresh openings/submission transaction; {deputy_count} deputy signers",
        sustained_profile=profile,
        limits=["Proof acceptance capacity only; no delivered bytes or client ACKs",
                "Normal mint retained; raw economics are not a conservation assertion",
                "Assignment round-robin binds each proof to its provider artifact and snapshot slot",
                "Four local processes do not establish WAN capacity", "No restart qualification"])
    epoch_length = producer.uint(doc["frozen_module_params"]["epoch_len_blocks"])
    monitor_stop, failures = threading.Event(), []
    streams = []
    observations = lifecycle.home / "sustained-audits.jsonl"
    def monitor():
        last = None
        try:
            with observations.open("x") as output:
                while not monitor_stop.is_set():
                    heights = []
                    for node in lifecycle.nodes:
                        status = lifecycle.query(node, "/status")
                        if status["node_info"]["id"] != node["node_id"] or status["node_info"]["network"] != lifecycle.chain:
                            raise ValueError("audit monitor RPC node identity mismatch")
                        heights.append(producer.uint(status["sync_info"]["latest_block_height"]))
                    height = min(heights) - 1
                    epoch = (height - 1) // epoch_length + 1
                    if height >= (epoch - 1) * epoch_length + 2 and epoch != last:
                        if last is not None and epoch > last + 1:
                            raise ValueError("audit monitor missed an epoch retention window")
                        row = dict(height=height, epoch=epoch, current=audits(height, False, epoch),
                                   previous=audits(height, True, epoch - 1))
                        output.write(json.dumps(row) + "\n")
                        output.flush()
                        last = epoch
                    monitor_stop.wait(5)
        except BaseException as error:
            failures.append(error)
    worker = threading.Thread(target=monitor, name="sustained-audit-monitor")
    worker.start()
    try:
        minimum = lifecycle.wait_height(3)
        # Keep all expiry buckets below128 and TTL <=4096 at every open.
        expiry = minimum + 4000
        if expiry + (len(offsets) + deputy_count - 1) // 128 >= producer.uint(deal["end_block"]):
            raise ValueError("insufficient deal lifetime for inventory")
        price = producer.uint(doc["frozen_module_params"]["retrieval_price_per_blob"]["amount"], 256)
        root = producer.b64(deal["manifest_root"], 32).hex()
        directories = {row["address"]: Path(row["directory"]) / "deals" / str(deal["id"]) / root
                       for row in doc["providers"]}
        operations = build_sustained_operations(lifecycle, deal, providers, deputies, offsets, minimum, expiry,
                                                price, proof_gas, k)
        inventory = lifecycle.home / "inventory"
        inventory.mkdir(mode=0o700)
        requests = []
        for start in range(0, len(operations), OPEN_SESSION_BATCH_MAX):
            if failures:
                raise failures[0]
            batch = operations[start:start + OPEN_SESSION_BATCH_MAX]
            ids, opened_height = open_session_batch(lifecycle, batch, inventory / f"batch-{start}", command)
            wait(opened_height + 3)
            for operation, sid in zip(batch, ids):
                path = str(inventory / (sid + ".json"))
                operation.pop("open-session")
                operation["submit-proof"]["submit"][4] = path
                evidence = read_session_evidence(lifecycle, operation, sid, None, lifecycle.deadline)
                operation["prepared"] = dict(session_id=sid, proof_path=path, evidence=evidence)
                artifact.prepared_session_pin(operation, evidence)
                requests.append(export_inventory_request(operation, sid, evidence, path, directories))
        manifest = inventory / "manifest.json"
        manifest.write_text(json.dumps(dict(chain_id=lifecycle.chain, trusted_setup=lifecycle.env["POLYSTORE_TRUSTED_SETUP"],
            deadline_unix_ms=int(time.time() * 1000 + (lifecycle.deadline - artifact.monotonic_ns()) / 1e6), sessions=requests)))
        env = dict(lifecycle.env, POLYSTORE_RETRIEVAL_EXPORT_MANIFEST=str(manifest))
        result = artifact.run_bounded_command([str(exporter), "-test.run=^TestExportFrozenRetrievalInventory$", "-test.timeout=7200s"], lifecycle.deadline, env=env)
        (inventory / "exporter.log").write_text(result.stdout + result.stderr)
        if result.returncode or failures:
            raise ValueError("real inventory export or audit monitor failed")
        results = json.loads(Path(str(manifest) + ".result.json").read_text())["proofs"]
        if len(results) != len(operations):
            raise ValueError("exporter returned incomplete inventory")
        for operation, result in zip(operations, results):
            prepared = operation["prepared"]
            pin = artifact.prepared_session_pin(operation, prepared["evidence"])
            if any(result[key] != value for key, value in dict(session_id=prepared["session_id"], proof_path=prepared["proof_path"],
                    context_hash=pin["context_hash"], seed=pin["seed"]).items()):
                raise ValueError("exporter changed ordered session intent")
            prepared["proof_sha256"] = result["proof_sha256"]
            artifact.validate_prepared_proof_file(operation, pin)
        warmup, operations = operations[:deputy_count], operations[deputy_count:]
        warmup_journal = lifecycle.home / "warmup.sqlite"
        warmup_deadline = min(lifecycle.deadline, artifact.monotonic_ns() + 60 * 10**9)
        for operation in warmup:
            operation["submit-proof"]["_deadline_ns"] = warmup_deadline
        doc["warmup_scheduler"] = artifact.schedule_retrieval_lifecycles(warmup,
            journal_path=warmup_journal, signers=deputies, max_in_flight=deputy_count, max_queued=deputy_count,
            max_queued_per_signer=1, mode="prepared-proof-only",
            read_session_evidence=lambda operation, sid, height, deadline: read_session_evidence(lifecycle, operation, sid, height, deadline))
        _, warmup_transactions = journal_results(warmup_journal, warmup, proof_only=True)
        doc["warmup"] = dict(journal=str(warmup_journal), sessions=deputy_count, submission_transactions=deputy_count,
                             proofs=profile["warmup_openings"], proof_unit="individual chained openings",
                             committed_transactions=warmup_transactions, all_committed=True)
        # One-second minimum local block time gives a conservative remaining-height floor.
        current = lifecycle.wait_height(3)
        if current + duration + 120 >= expiry or (lifecycle.deadline - artifact.monotonic_ns()) / 1e9 < duration + 120:
            raise ValueError("prepared inventory cannot cover measurement and bounded drain before expiry/deadline")
        doc["inventory"] = dict(manifest=str(manifest), sha256=artifact.sha256(manifest), exporter_sha256=artifact.sha256(exporter),
                                 first_expiry=expiry, ready_height=current)
        doc["economics_before"] = lifecycle.snapshot(current - 1)
        capture_workload_metrics(lifecycle, "sustained_before", fenced=True)
        lifecycle.save()
        start_commit_streams(lifecycle, duration + 120, streams)
        started = artifact.monotonic_ns()
        for operation in operations:
            operation["submit-proof"]["_deadline_ns"] = min(lifecycle.deadline, started + (duration + 120) * 10**9)
        progress_path = lifecycle.home / "sustained-progress.jsonl"
        def progress(row):
            with progress_path.open("a") as output:
                output.write(json.dumps(row, sort_keys=True) + "\n")
        doc["scheduler"] = artifact.schedule_retrieval_lifecycles(operations,
            journal_path=lifecycle.home / "sustained.sqlite", signers=deputies,
            max_in_flight=deputy_count, max_queued=128, max_queued_per_signer=16, mode="prepared-proof-only",
            read_session_evidence=lambda operation, sid, height, deadline: read_session_evidence(lifecycle, operation, sid, height, deadline),
            progress_callback=progress, heartbeat_seconds=60, stall_timeout_seconds=600)
        doc["progress"] = dict(path=str(progress_path), sha256=artifact.sha256(progress_path),
                               heartbeat_seconds=60, no_progress_timeout_seconds=600,
                               source="scheduler in-memory counters; no additional chain query")
        _, sustained_transactions = journal_results(lifecycle.home / "sustained.sqlite", operations,
                                                     proof_only=True, require_all_committed=False)
        doc["assignment_submission_counts"] = assignment_submission_counts(operations, sustained_transactions)
        # The last offered operation precedes the declared end by one interval.
        while artifact.monotonic_ns() < started + duration * 10**9:
            time.sleep(min(0.2, lifecycle.remaining()))
        doc["offered_window_ns"] = duration * 10**9
        doc["scheduler_and_drain_elapsed_ns"] = artifact.monotonic_ns() - started
        capture_workload_metrics(lifecycle, "sustained_after", fenced=True)
        stopped, streams = streams, []
        artifact.stop_owned_process_groups(stopped)
        reconcile_sustained_blocks(lifecycle, lifecycle.home / "sustained.sqlite")
        summarize_commit_streams(lifecycle, stopped)
        end_height = lifecycle.wait_height(3) - 1
        doc["economics_after"] = lifecycle.snapshot(end_height)
        measured_epoch = (end_height - 1) // epoch_length + 1
        final_height = measured_epoch * epoch_length + 1
        wait(final_height + 1)
        doc["final_measured_epoch_audit"] = dict(height=final_height, epoch=measured_epoch,
                                                audits=audits(final_height, True, measured_epoch))
        if failures:
            raise failures[0]
        doc.update(status="sustained_retrieval_diagnostic_finished", audit_observations=str(observations), qualification=False)
    finally:
        owned, streams = streams, []
        try:
            artifact.stop_owned_process_groups(owned)
        finally:
            monitor_stop.set()
            # A capture can query every selected provider on each validator,
            # plus four bounded anchor reads.
            stop_deadline = artifact.monotonic_ns() + 90 * 10**9
            while worker.is_alive() and artifact.monotonic_ns() < stop_deadline:
                worker.join(timeout=1)
            if worker.is_alive():
                raise TimeoutError("audit monitor did not stop")
            if failures:
                raise ValueError("audit monitor failed: " + str(failures[0]))


def run_healthy(lifecycle, gateway_binary, cli_binary, product_source, *, sustained=None,
                native_v3=False, audit_profile="normal"):
    """Real canonical ingest and normal audits; optional bounded retrieval workload."""
    if native_v3 and sustained is not None:
        raise ValueError("native v3 diagnostic and sustained v2 workload are distinct modes")
    k = 8 if native_v3 else sustained.get("k", 2) if sustained is not None else 2
    deputy_count = sustained.get("deputy_count", 8) if sustained is not None else 8
    rate_scale = sustained.get("rate_scale", 1) if sustained is not None else 1
    layout = mode2_layout(k, deputy_count)
    gateway = Path(gateway_binary).resolve(strict=True)
    cli = Path(cli_binary).resolve(strict=True)
    source = Path(product_source).resolve(strict=True)
    for binary in (gateway, cli):
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise ValueError("gateway and native CLI binaries must be executable")
    if not (source / "polystore_cli/src/main.rs").is_file():
        raise ValueError("product-source must identify the supplied product source checkout")
    if sustained is not None:
        export_binary = Path(sustained["exporter"]).resolve(strict=True)
        if not export_binary.is_file() or not os.access(export_binary, os.X_OK):
            raise ValueError("proof exporter must be executable")
        artifact.integer(sustained["proof_gas"], "proof gas", 1, 64000000)
        sustained_offsets(sustained["step_seconds"], rate_scale)
    curl = shutil.which("curl")
    if not curl:
        raise ValueError("curl is required for bounded multipart upload")
    preflight_free = None
    if native_v3:
        preflight_free = require_free_disk(lifecycle.home.parent, V3_PREFLIGHT_FREE_BYTES,
                                           "native v3 preflight")
    lifecycle.home.mkdir(mode=0o700)
    processes, reservations = [], []
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"interrupted by signal {signum}")
    for sig in previous:
        signal.signal(sig, interrupted)
    doc = lifecycle.doc
    doc.pop("transactions_submitted", None)
    if native_v3:
        doc["disk_guard"] = dict(preflight_free_bytes=preflight_free,
                                 preflight_minimum_bytes=V3_PREFLIGHT_FREE_BYTES,
                                 runtime_minimum_bytes=V3_ABORT_FREE_BYTES)
    doc.update(mode="four-validator-native-v3-provider-diagnostic" if native_v3 else "four-validator-healthy-provider-diagnostic",
        setup_transactions=[], providers=[],
        workload=("one 16 MiB FAT v3 K8 deal; twelve production provider-daemons; two preopened native sessions"
                  if native_v3 else f"one real K{k} deal; {layout['assignments']} assigned provider-daemons; one normal audit epoch"),
        qualification=False, limits=["No capacity or delivered retrieval qualification",
            ("Provider HTTP durations combine proof generation, gas simulation, signing, broadcast, and commit observation"
             if native_v3 else "No deputy retrieval yet"),
            "Normal mint and audit parameters retained; no economic conservation assertion", "No restart qualification"])
    def check_disk(phase):
        if native_v3:
            free = require_free_disk(lifecycle.home, V3_ABORT_FREE_BYTES, phase)
            doc["disk_guard"]["last_checked_free_bytes"] = free
            doc["disk_guard"]["last_checked_phase"] = phase
        return None
    def command(args, timeout=60):
        lifecycle.remaining()
        check_disk("command")
        result = artifact.run_bounded_command(args, min(lifecycle.deadline, artifact.monotonic_ns() + timeout * 10**9), env=lifecycle.env)
        if result.returncode:
            raise ValueError("owned diagnostic command failed: " + (result.stderr + result.stdout)[-8192:])
        return result.stdout
    def send(name, args):
        check_disk("transaction")
        job = transaction_job(lifecycle, lifecycle.signers[name], args)
        result = artifact.scheduled_transaction(job)
        doc["setup_transactions"].append(dict(result, signer=job["signer"], submit=job["submit"]))
        lifecycle.save()
        if result["outcome"] != "committed_success":
            raise ValueError("setup transaction failed or ambiguous; no signer retry")
        return result
    def check_providers():
        # Keep leaders unreaped until group cleanup, so their PIDs cannot be
        # reused while a CLI descendant still needs termination. Health/audit
        # requests below detect service failure within the shared deadline.
        for process in processes:
            os.kill(process.pid, 0)
    def wait(height):
        # Keep provider failures visible while the validators advance.
        started = last_heartbeat = last_progress = artifact.monotonic_ns()
        previous_height = 0
        while True:
            check_providers()
            check_disk("height wait")
            current = lifecycle.wait_height(1)
            now = artifact.monotonic_ns()
            if current > previous_height:
                previous_height = current
                last_progress = now
            if now - last_heartbeat >= 60 * 10**9:
                heartbeat = dict(phase="height-wait", current_height=current,
                    target_height=height, elapsed_ns=now - started,
                    seconds_since_progress=(now - last_progress) / 1e9)
                doc.setdefault("progress", []).append(heartbeat)
                lifecycle.save()
                print(json.dumps(heartbeat, sort_keys=True), flush=True)
                last_heartbeat = now
            if current >= height:
                return current
            time.sleep(min(0.2, lifecycle.remaining()))
    try:
        require_retrieval_cli(lifecycle)
        if native_v3:
            require_v3_cli(lifecycle)
        if sustained is not None and "--append" not in lifecycle.cli(lifecycle.home, "tx", "sign-batch", "--help").split():
            raise ValueError("sustained workload requires SDK sign-batch --append")
        lifecycle.reserve_ports()
        for i in range(layout["assignments"]):
            reservation = socket.socket()
            reservations.append(reservation)
            reservation.bind(("127.0.0.1", 19091 + i))
            reservation.listen(1)
        doc["provenance"] = dict(source_checkout=command(["git", "-C", str(lifecycle.root), "rev-parse", "HEAD"]).strip(),
            binary=str(lifecycle.binary), native_library=str(lifecycle.library),
            binary_sha256=artifact.sha256(lifecycle.binary), native_library_sha256=artifact.sha256(lifecycle.library),
            trusted_setup_sha256=artifact.sha256(lifecycle.env["POLYSTORE_TRUSTED_SETUP"]), gateway_binary=str(gateway),
            gateway_sha256=artifact.sha256(gateway), driver_sha256=artifact.sha256(__file__),
            cli_binary=str(cli), cli_sha256=artifact.sha256(cli), product_source=str(source),
            product_source_commit=command(["git", "-C", str(source), "rev-parse", "HEAD"]).strip(),
            product_source_status=command(["git", "-C", str(source), "status", "--porcelain", "--",
                "polystore_cli", "polystore_core", "polystore_gateway", "polystorechain"]),
            cli_source_sha256=artifact.sha256(source / "polystore_cli/src/main.rs"),
            curl_binary=curl, curl_sha256=artifact.sha256(curl),
            artifact_source_match="supplied binaries/library; build correspondence not attested")
        if doc["provenance"]["trusted_setup_sha256"] != producer.SETUP_DIGEST:
            raise ValueError("diagnostic requires the maintained trusted setup")
        lifecycle.prepare(audit_profile=audit_profile, provider_count=layout["provisioned_provider_signers"],
                          enable_retrieval_v3=native_v3)
        # Normal mint is retained for both explicit audit profiles.
        population = layout["openings_per_bundle"] * (3 if native_v3 else 1)
        quotas = {min(population, producer.uint(doc["frozen_module_params"]["quota_max_blobs"]),
                      max(producer.uint(doc["frozen_module_params"]["quota_min_blobs"]),
                          (population * producer.uint(doc["frozen_module_params"][key]) + 9999) // 10000))
                  for key in ("quota_bps_per_epoch_hot", "quota_bps_per_epoch_cold")}
        if len(quotas) != 1 or not 1 <= next(iter(quotas)) <= population:
            raise ValueError(f"K{k} diagnostic requires an unambiguous nonzero frozen audit quota")
        expected_samples = quotas.pop()
        doc["audit_sampling_profile"] = dict(name=audit_profile, population_per_slot=population, samples_per_slot=expected_samples,
            samples_per_epoch=layout["assignments"] * expected_samples, qualification=False)
        genesis = json.loads((Path(lifecycle.nodes[0]["home"]) / "config/genesis.json").read_text())
        doc["normal_mint_profile"] = genesis["app_state"]["mint"]
        epoch_length = producer.uint(doc["frozen_module_params"]["epoch_len_blocks"])
        if epoch_length < 2:
            raise ValueError("normal storage audits require epochs")
        lifecycle.save()
        lifecycle.start("initial")
        lifecycle.wait_height(3)
        for i in range(layout["assignments"]):
            send(f"provider{i}", ["register-provider", "General", "100000000000", "--endpoint", f"/ip4/127.0.0.1/tcp/{19091+i}/http"])
            directory = lifecycle.home / f"provider{i}"
            directory.mkdir(mode=0o700)
            env = dict({key: value for key, value in lifecycle.env.items() if not key.startswith("POLYSTORE_")},
                POLYSTORE_RUNTIME_PERSONA="provider-daemon", POLYSTORE_GATEWAY_ROUTER="0",
                POLYSTORE_TRUSTED_SETUP=lifecycle.env["POLYSTORE_TRUSTED_SETUP"],
                POLYSTORE_HOME=lifecycle.nodes[0]["home"], POLYSTORE_CHAIN_ID=lifecycle.chain,
                POLYSTORE_NODE=f'http://127.0.0.1:{lifecycle.nodes[0]["rpc"]}',
                POLYSTORE_LCD_BASE=f'http://127.0.0.1:{lifecycle.nodes[0]["api"]}',
                POLYSTORECHAIND_BIN=str(lifecycle.binary), POLYSTORE_PROVIDER_KEY=f"provider{i}",
                POLYSTORE_CLI_BIN=str(cli), POLYSTORE_ROOT_DIR=str(source), POLYSTORE_GAS_PRICES="0.001aatom",
                POLYSTORE_PROVIDER_ADDRESS=lifecycle.signers[f"provider{i}"], POLYSTORE_UPLOAD_DIR=str(directory),
                POLYSTORE_SESSION_DB_PATH=str(directory / "sessions.db"), POLYSTORE_LISTEN_ADDR=f"127.0.0.1:{19091+i}",
                POLYSTORE_P2P_ENABLED="0", POLYSTORE_DISABLE_SYSTEM_LIVENESS="0", POLYSTORE_SYSTEM_LIVENESS="1",
                POLYSTORE_SYSTEM_LIVENESS_INTERVAL_SECONDS="10", POLYSTORE_POLYCE="0", POLYSTORE_FAKE_INGEST="0",
                POLYSTORE_FAST_INGEST="0", POLYSTORE_FAST_SHARD="0", POLYSTORE_MODE2_ENCODE_PARALLELISM="1", POLYSTORE_MODE2_UPLOAD_PARALLELISM="2",
                POLYSTORE_GATEWAY_UPLOAD_TIMEOUT_SECONDS="180", POLYSTORE_CMD_TIMEOUT_SECONDS="30",
                POLYSTORE_SHARD_TIMEOUT_SECONDS="180", POLYSTORE_MODE2_UPLOAD_TASK_TIMEOUT_SECONDS="60",
                POLYSTORE_GATEWAY_SP_AUTH=V3_PROVIDER_AUTH_TOKEN)
            reservations[i].close()
            if (artifact.sha256(gateway) != doc["provenance"]["gateway_sha256"] or
                    artifact.sha256(cli) != doc["provenance"]["cli_sha256"]):
                raise ValueError("gateway or native CLI binary changed before startup")
            with (directory / "provider.log").open("xb") as log:
                process = subprocess.Popen([str(gateway)], cwd=directory, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append(process)
            doc["providers"].append(dict(pid=process.pid, address=lifecycle.signers[f"provider{i}"], port=19091+i, directory=str(directory),
                signer_key=f"provider{i}", home=lifecycle.nodes[0]["home"], system_liveness_interval_seconds=10,
                environment={key: value for key, value in env.items() if key.startswith("POLYSTORE_") and key != "POLYSTORE_GATEWAY_SP_AUTH"}))
            lifecycle.save()
        for i in range(layout["assignments"]):
            while True:
                check_providers()
                try:
                    command([curl, "--silent", "--show-error", "--fail", "--max-time", "2", f"http://127.0.0.1:{19091+i}/health"], 3)
                    break
                except ValueError:
                    time.sleep(min(0.2, lifecycle.remaining()))
        created = send("owner0", ["create-deal", "100000", "100000000", "10000000", "--service-hint", f"General:rs={k}+{layout['m']}"])
        wait(created["height"] + 1)
        owned = [d for d in lifecycle.query(lifecycle.nodes[0], API + "/deals", created["height"])["deals"]
                 if d["owner"] == lifecycle.signers["owner0"]]
        if len(owned) != 1:
            raise ValueError("expected exactly one owner deal")
        identity = str(owned[0].get("id", "0"))
        initial_deal = lifecycle.query(lifecycle.nodes[0], API + "/deals/" + identity, created["height"])["deal"]
        providers = {}
        for slot in initial_deal["mode2_slots"]:
            index = producer.uint(slot.get("slot", 0))
            if index in providers or slot["status"] != "SLOT_STATUS_ACTIVE" or slot.get("pending_provider"):
                raise ValueError(f"K{k} slots must be distinct and ACTIVE")
            providers[index] = slot["provider"]
        if (set(providers) != set(range(layout["assignments"])) or
                set(providers.values()) != {lifecycle.signers[f"provider{i}"] for i in range(layout["assignments"])}):
            raise ValueError(f"K{k} placement differs from the owned providers")
        payload = lifecycle.home / "payload.bin"
        block = bytes((i * 37 + i // 97) % 256 for i in range(4096))
        payload_bytes = V3_PILOT_BYTES if native_v3 else 8126464
        with payload.open("xb") as output:
            for _ in range(payload_bytes // len(block)):
                output.write(block)
        doc["payload"] = dict(path=str(payload), bytes=payload.stat().st_size, sha256=artifact.sha256(payload))
        uploaded = json.loads(command([curl, "--silent", "--show-error", "--fail", "--max-time", "180",
            "--form-string", "owner=" + lifecycle.signers["owner0"], "--form-string", "file_path=payload.bin",
            "--form", "file=@" + str(payload),
            f"http://127.0.0.1:19091/sp/retrieval/upload?deal_id={identity}" + ("&fat_version=3" if native_v3 else "")], 185))
        doc["ingest"] = uploaded
        if native_v3:
            candidate, height = admit_native_v3_generation(lifecycle, uploaded=uploaded, deal_id=identity,
                                                            providers=providers, send=send, curl=curl)
            root = candidate["polyfs_root"]
        else:
            root = uploaded["manifest_root"]
            if (not isinstance(root, str) or len(root) != 66 or root != "0x" + bytes.fromhex(root[2:]).hex() or
                    [producer.uint(uploaded[n]) for n in ("size_bytes", "file_size_bytes", "logical_size_bytes", "total_mdus", "witness_mdus")] != [8126464, 8126464, 8126464, 3, 1] or
                    uploaded.get("content_encoding") != "none"):
                raise ValueError(f"canonical K{k} ingest returned unexpected content")
            updated = send("owner0", ["update-deal-content", "--deal-id", identity, "--cid", root,
                "--size", "8126464", "--total-mdus", "3", "--witness-mdus", "1"])
            height = updated["height"]
        wait(height + 1)
        deal = lifecycle.query(lifecycle.nodes[0], API + "/deals/" + identity, height)["deal"]
        deal["id"] = identity
        if producer.b64(deal["manifest_root"], 32).hex() != root[2:]:
            raise ValueError("committed root differs from ingest")
        if native_v3 and [producer.uint(deal.get(name, 0)) for name in
                          ("size", "total_mdus", "witness_mdus", "current_gen")] != [V3_PILOT_BYTES, 5, 1, 1]:
            raise ValueError("finalized FAT v3 deal differs from fixed pilot geometry")
        if deal["mode2_slots"] != initial_deal["mode2_slots"]:
            raise ValueError("content admission changed frozen provider assignments")
        doc["deal"] = deal
        doc["canonical_artifacts"] = []
        user_mdus = 3 if native_v3 else 1
        for slot, address in providers.items():
            provider = next(row for row in doc["providers"] if row["address"] == address)
            directory = Path(provider["directory"]) / "deals" / identity / root[2:]
            expected_artifacts = [("mdu_0.bin", 8388608), ("mdu_1.bin", 8388608)]
            expected_artifacts += [(f"mdu_{mdu}_slot_{slot}.bin", layout["bytes_per_bundle"])
                                   for mdu in range(2, 2 + user_mdus)]
            if native_v3:
                expected_artifacts.append(("integrity_leaves_v3.bin", user_mdus * 96 * 32))
            for filename, size in expected_artifacts:
                path = directory / filename
                if path.stat().st_size != size:
                    raise ValueError("provider canonical artifact has wrong size")
                doc["canonical_artifacts"].append(dict(slot=slot, provider=address, path=str(path),
                    bytes=size, sha256=artifact.sha256(path)))
        epoch = (height - 1) // epoch_length + 2
        def audits(at, finalized, observed_epoch=None):
            selected_epoch = epoch if observed_epoch is None else observed_epoch
            observation = dict(height=at, epoch=selected_epoch, finalized=finalized, nodes=[])
            doc["current_audit_observation"] = observation
            rows = []
            for node_index, node in enumerate(lifecycle.nodes):
                values = []
                observation["nodes"].append(dict(node_index=node_index, audits=values))
                for address in providers.values():
                    values.extend(lifecycle.query(node, API + "/storage-audits/by-provider/" + address, at)["audits"])
                checked = healthy_audit_views(values, deal, providers, selected_epoch, epoch_length, lifecycle.chain,
                                              finalized=finalized, expected_samples=expected_samples, k=k,
                                              user_mdus=user_mdus)
                anchor_height = (selected_epoch - 1) * epoch_length + 1
                anchor = lifecycle.query(node, f"/block?height={anchor_height}")
                if (producer.uint(anchor["block"]["header"]["height"]) != anchor_height or
                        anchor["block"]["header"]["chain_id"] != lifecycle.chain or
                        any(producer.b64(view["seed"], 32).hex() != anchor["block_id"]["hash"].lower() for view in checked.values())):
                    raise ValueError("audit seed differs from committed epoch anchor")
                rows.append(checked)
            if any(row != rows[0] for row in rows[1:]):
                raise ValueError("four validators disagree on pinned audit evidence")
            return rows[0]
        first = (epoch - 1) * epoch_length + 2
        wait(first + 1)
        doc["audit_before"] = dict(height=first, audits=audits(first, False))
        lifecycle.save()
        final = epoch * epoch_length + 1
        wait(final + 1)
        complete = audits(final, True)
        for slot, view in complete.items():
            before = doc["audit_before"]["audits"][slot]
            if any(view[name] != before[name] for name in ("canonical_context", "seed", "epoch_length")):
                raise ValueError("frozen audit authority changed during epoch")
        doc["audit_after"] = dict(height=final, audits=complete,
            accepted_samples=sum(producer.uint(view["audit"].get("accepted_count", 0)) for view in complete.values()),
            required_samples=sum(producer.uint(view["audit"]["sample_count"]) for view in complete.values()))
        doc["same_height_state"] = lifecycle.snapshot(final)
        for node in lifecycle.nodes:
            current = lifecycle.query(node, API + "/deals/" + identity, final)["deal"]
            if current["mode2_slots"] != deal["mode2_slots"] or current["manifest_root"] != deal["manifest_root"]:
                raise ValueError("healthy audit changed active placement/content")
        check_providers()
        doc.update(status="healthy_provider_audit_diagnostic_passed", audit_coverage_verified=True)
        if native_v3:
            run_native_v3_sessions(lifecycle, deal=deal, providers=providers, send=send, wait=wait, curl=curl)
            doc["status"] = "native_v3_provider_diagnostic_passed"
        elif sustained is not None:
            run_sustained(lifecycle, deal, providers, send, command, audits, wait, **sustained)
    except BaseException as error:
        doc.update(status="failed", error=str(error)[-8192:])
        raise
    finally:
        try:
            try:
                artifact.stop_owned_process_groups(processes)
            finally:
                try:
                    lifecycle.stop()
                finally:
                    for reservation in reservations + lifecycle.reservations:
                        reservation.close()
        except BaseException as error:
            doc.update(status="failed", cleanup_error=str(error)[-8192:])
            raise
        finally:
            try:
                lifecycle.save()
            finally:
                for sig, handler in previous.items():
                    signal.signal(sig, handler)
    return lifecycle.home / "evidence.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("binary", "library", "home"):
        parser.add_argument("--" + flag, required=True)
    for flag in ("fixture-k8", "fixture-k2", "gateway-binary", "cli-binary", "product-source", "proof-exporter"):
        parser.add_argument("--" + flag)
    parser.add_argument("--mode", choices=("settlement-smoke", "healthy-providers", "sustained-providers",
                                           "native-v3-providers"), default="settlement-smoke")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--audit-profile", choices=("normal", "c6"), default="normal")
    parser.add_argument("--step-seconds", type=int, default=180, help="Each of five offered-rate steps; 4 is a same-path pilot")
    parser.add_argument("--sustained-k", type=int, choices=(2, 8), default=2,
                        help="Native Mode 2 data width; full-row bundles contain 64/K openings")
    parser.add_argument("--sustained-rate-scale", type=int, choices=SUSTAINED_RATE_SCALES, default=1,
                        help="Multiply the five fixed offered transaction rates by 1 or 4")
    parser.add_argument("--sustained-deputies", type=int, choices=SUSTAINED_DEPUTY_COUNTS, default=8,
                        help="Use 8 or 32 independent proof-submission signers")
    parser.add_argument("--proof-gas", type=int, help="Explicit locally validated fixed gas limit per proof-submission transaction")
    parser.add_argument("--proof-only", action="store_true", help="Prepare six sessions, verify rejected transactions, time proofs, then verify idempotent settlement retries")
    options = vars(parser.parse_args())
    k8, k2 = options.pop("fixture_k8"), options.pop("fixture_k2")
    proof_only = options.pop("proof_only")
    mode, gateway = options.pop("mode"), options.pop("gateway_binary")
    audit_profile = options.pop("audit_profile")
    cli, source = options.pop("cli_binary"), options.pop("product_source")
    exporter = options.pop("proof_exporter")
    step_seconds, proof_gas = options.pop("step_seconds"), options.pop("proof_gas")
    sustained_k = options.pop("sustained_k")
    sustained_rate_scale = options.pop("sustained_rate_scale")
    sustained_deputies = options.pop("sustained_deputies")
    if mode == "sustained-providers":
        if not all((gateway, cli, source, exporter, proof_gas)) or k8 or k2 or proof_only or not 4 <= step_seconds <= 180 or not 1 <= proof_gas <= 64000000:
            parser.error("sustained-providers requires product binaries/source, --proof-exporter and --proof-gas; excludes fixtures/--proof-only")
        print(run_healthy(artifact.FourValidatorLifecycle(**options, sustained=True), gateway, cli, source,
            sustained=dict(exporter=exporter, step_seconds=step_seconds, proof_gas=proof_gas, k=sustained_k,
                           rate_scale=sustained_rate_scale, deputy_count=sustained_deputies), audit_profile=audit_profile))
    elif (exporter or proof_gas is not None or step_seconds != 180 or sustained_k != 2 or
          sustained_rate_scale != 1 or sustained_deputies != 8):
        parser.error("exporter, proof gas, sustained K and pilot duration require sustained-providers")
    elif mode == "native-v3-providers":
        if (not gateway or not cli or not source or k8 or k2 or proof_only or
                options["timeout"] > 600 or audit_profile != "normal"):
            parser.error("native-v3-providers requires product binaries/source, normal audits, timeout <= 600, and excludes fixtures/--proof-only")
        print(run_healthy(artifact.FourValidatorLifecycle(**options), gateway, cli, source,
                          native_v3=True, audit_profile="normal"))
    elif mode == "healthy-providers":
        if not gateway or not cli or not source or k8 or k2 or proof_only or options["timeout"] > 600:
            parser.error("healthy-providers requires --gateway-binary/--cli-binary/--product-source, timeout <= 600, and excludes fixtures/--proof-only")
        print(run_healthy(artifact.FourValidatorLifecycle(**options), gateway, cli, source, audit_profile=audit_profile))
    else:
        if not k8 or not k2 or gateway or cli or source or audit_profile != "normal":
            parser.error("settlement-smoke requires both fixtures and excludes --gateway-binary")
        print(run(artifact.FourValidatorLifecycle(**options), k8, k2, proof_only=proof_only))


if __name__ == "__main__":
    main()
