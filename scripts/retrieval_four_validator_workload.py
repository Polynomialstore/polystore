#!/usr/bin/env python3
"""Bounded four-validator diagnostics and native-v3 chain-capacity qualification.

Settlement smoke uses exported K8/K2 fixtures without provider transport.
Healthy-providers uses canonical K2 ingest and three provider-daemons to check
normal storage audits. Sustained-providers adds finite K2 or K8 real-artifact
proof load.
Native-v3-browser verifies one delivered file through the production browser,
worker, OPFS, EVM, gateway, and provider path. Owned services start only when
this command is explicitly invoked.
Native-v3-chain saturates proof confirmation from frozen signed transactions;
it excludes provider transport, proof preparation, ACK, refund and full lifecycle.
"""
import argparse
import base64
import calendar
import hashlib
import http.client
import json
import math
import os
import platform
import re
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import time
import threading
import urllib.parse
import urllib.request
from datetime import datetime
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
V3_DATA_BLOB_PAYLOAD_BYTES = 126_976
V3_USER_MDU_BYTES = 8_126_464
V3_BROWSER_DEFAULT_BYTES = 1024
V3_BROWSER_SIZES = (1024, 16_777_217, 130_023_424, 1_073_741_824)
V3_BROWSER_PAYER = "nil1ser7fv30x7e7xr7n62tlr7m7z07ldqj4thdezk"
V3_PILOT_SESSIONS = 2
V3_MAX_SAMPLES = 132
V3_BITMAP_BYTES = (V3_MAX_SAMPLES + 7) // 8
V3_SYSTEMATIC_PROVIDERS = 8
V3_PROVIDER_AUTH_TOKEN = "healthy-diagnostic-owned-local-stack"
V3_BUSY_MAX_ATTEMPTS = 4
V3_BUSY_RETRY_SECONDS = 2
V3_PREFLIGHT_FREE_BYTES = 2 * 1024**3
V3_ABORT_FREE_BYTES = 768 * 1024**2
V3_CHAIN_CAPACITY_RANGES = (1024, 8 * V3_DATA_BLOB_PAYLOAD_BYTES, V3_PILOT_BYTES)
V3_CHAIN_CAPACITY_TRANSACTIONS = (1280, 1280, 80)
V3_CHAIN_SUBMISSION_MODES = ("separate", "serial-messages", "batch-message")
V3_CHAIN_BATCH_SIZES = (8, 32, 64)
V3_CHAIN_GAS_ADJUSTMENTS = ("1.1", "1.2", "1.4", "1.6")
# Leave one provider-balanced batch of headroom below the protocol's 8,192
# live-context limit for the normal audits retained by this workload.
V3_CHAIN_MAX_BATCH_SESSIONS = 7_680
V3_SINGLE_PROOF_TYPE = "/polystorechain.polystorechain.v1.MsgSubmitRetrievalSessionProofV3"
V3_BATCH_PROOF_TYPE = "/polystorechain.polystorechain.v1.MsgSubmitRetrievalSessionProofBatchV3"
V3_CONFIGURED_VALIDATOR_V3_ONE_SAMPLE_SESSIONS_PER_SECOND = 442.56266798019266
V3_VALIDATOR_V3_ONE_SAMPLE_SESSIONS_PER_SECOND = {
    2: V3_CONFIGURED_VALIDATOR_V3_ONE_SAMPLE_SESSIONS_PER_SECOND,
    4: 873.7485736054535,
}
V3_CONFIGURED_VALIDATOR_V3_VERIFIER_PROVENANCE = {
    "artifact_path": "bench/retrieval_session_capacity/parallel-ceiling-328/results.json",
    "artifact_commit": "1bf6762d2bce694917833a6f9a626769e9fd7578",
    "benchmark_source_commit": "53c197a860cbd88e46709d2e6cf3996d685f7902",
    "raw_benchmark_sha256": "be001f7961def5e5da94d165e0bd484e1dcf6d9cf966bffb51efdd8b0f900f71",
    "source_statistic": "comparison.configured_per_validator_verifier_only_sessions_per_second",
    "source_statistic_semantics": (
        "exact pure verifyPolyFSChainedProof throughput for one sampled chained proof per "
        "session at GOMAXPROCS=2; each configured validator repeats the same transaction stream"),
    "linearization": (
        "profiles with more than one sampled chained proof divide the one-sample rate by "
        "sample_count; the current 1 KiB capacity profile has sample_count=1"),
}
V3_CHAIN_SESSION_TTL_BLOCKS = 4096
V3_EXPIRY_REFS_PER_BLOCK = 128
V3_CHAIN_BACKLOG_SECONDS = 10
V3_CHAIN_DRAIN_SECONDS = 300
V3_CHAIN_AUDIT_EPOCH_BLOCKS = 100
V3_CHAIN_MEASUREMENT_MARGIN_BLOCKS = 30
V3_ISSUE_251_QUALIFICATION_SESSIONS = 7680
V3_ISSUE_251_QUALIFICATION_TRANSACTIONS = 120
V3_ISSUE_251_QUALIFICATION_GAS = 160_000_000
V3_ISSUE_251_QUALIFICATION_BATCH_SIZE = 64
V3_ISSUE_251_MINIMUM_SATURATED_BLOCKS = 10
V3_INDEPENDENT_PROOF_CRYPTO_GAS = 1_200_000
V3_AGGREGATE_PROOF_BASE_GAS = 1_000_000
V3_AGGREGATE_PROOF_MARGINAL_GAS = 100_000
V3_PROOF_OPENING_OVERHEAD_GAS = 313_000
V3_PROOF_TRANSACTION_OVERHEAD_GAS = 130_000
V3_PROOF_TRANSACTION_MINIMUM_OVERHEAD_GAS = 404_000
V3_EXPORT_BATCH_MAX = 8
V3_CROSS_AUDIT_SESSIONS = 46
V3_CROSS_AUDIT_WARMUPS = 8
V3_CROSS_AUDIT_MEASURED = 360
V3_CROSS_AUDIT_OFFER_SECONDS = 180
V3_CROSS_AUDIT_DRAIN_SECONDS = 30
V3_CROSS_AUDIT_BIN_SECONDS = 30
V3_CROSS_AUDIT_EPOCHS = 2
V3_CROSS_AUDIT_OPEN_BATCH_MAX = 31
V3_CROSS_AUDIT_OPEN_GAS = 2_000_000
V3_CROSS_AUDIT_OPEN_BATCH_GAS_CAP = (
    OPEN_SESSION_BATCH_BASE_GAS + V3_CROSS_AUDIT_OPEN_GAS * V3_CROSS_AUDIT_OPEN_BATCH_MAX)
V3_PROVIDER_TIMING_SCHEMA = "polystore-v3-provider-timing-v1"
V3_PROVIDER_TIMING_MAX_NS = 90 * 10**9


def host_identity():
    return dict(host=platform.platform(), machine=platform.machine(), logical_cpus=os.cpu_count())


def native_v3_range_shape(range_bytes, *, range_start=0, file_bytes=V3_PILOT_BYTES):
    """Return the exact v3 chain-proof shape for one logical range."""
    range_bytes = artifact.integer(range_bytes, "v3 range bytes", 1, file_bytes)
    range_start = artifact.integer(range_start, "v3 range start", 0, file_bytes - range_bytes)
    first = range_start // V3_DATA_BLOB_PAYLOAD_BYTES
    last = (range_start + range_bytes - 1) // V3_DATA_BLOB_PAYLOAD_BYTES
    population = last - first + 1
    slots = [slot for slot in range(V3_SYSTEMATIC_PROVIDERS)
             if any(blob % V3_SYSTEMATIC_PROVIDERS == slot for blob in range(first, last + 1))]
    return dict(range_bytes=range_bytes, range_start=range_start, first_blob=first,
                last_blob=last, population=population, sample_count=min(population, V3_MAX_SAMPLES),
                obligation_slots=slots, proof_transactions=len(slots))


def native_v3_chain_capacity_profiles(profile_name=None, measured_transactions=None, *,
                                      measured_sessions=None, submission_mode="separate", batch_size=1):
    """The three distinct range shapes needed for a chain-only capacity result."""
    names = ("1kib", "eight-blobs", "sample-cap")
    profiles = []
    for name, size, transactions in zip(
            names, V3_CHAIN_CAPACITY_RANGES, V3_CHAIN_CAPACITY_TRANSACTIONS):
        shape = native_v3_range_shape(size)
        if transactions % shape["proof_transactions"]:
            raise ValueError("native v3 capacity inventory must contain complete proof sets")
        profiles.append(dict(name=name, measured_transactions=transactions,
            sessions=transactions // shape["proof_transactions"], **shape))
    if submission_mode not in V3_CHAIN_SUBMISSION_MODES:
        raise ValueError("invalid native v3 proof submission mode")
    if submission_mode == "separate" and batch_size != 1:
        raise ValueError("separate proof submission requires batch size 1")
    if submission_mode != "separate" and batch_size not in V3_CHAIN_BATCH_SIZES:
        raise ValueError("batched proof submission requires batch size 8, 32, or 64")
    if measured_transactions is not None and measured_sessions is not None:
        raise ValueError("specify measured sessions, not both session and transaction counts")
    if profile_name is not None:
        selected = [profile for profile in profiles if profile["name"] == profile_name]
        if len(selected) != 1 or (measured_sessions is None and measured_transactions is None):
            raise ValueError("selected native v3 capacity profile requires a transaction count or explicit session count")
        profile = selected[0]
        if submission_mode != "separate" and profile_name != "1kib":
            raise ValueError("proof batching comparator requires the one-opening 1KiB profile")
        if measured_sessions is None:
            if submission_mode != "separate":
                raise ValueError("batched proof submission requires an explicit session count")
            transactions = artifact.integer(measured_transactions, "measured transactions", 1, 4999)
            if transactions % profile["proof_transactions"]:
                raise ValueError("native v3 capacity inventory must contain complete proof sets")
            sessions = transactions // profile["proof_transactions"]
        else:
            maximum = 4999 if submission_mode == "separate" else V3_CHAIN_MAX_BATCH_SESSIONS
            sessions = artifact.integer(measured_sessions, "measured sessions", 1, maximum)
        proof_messages = sessions * profile["proof_transactions"]
        balance_count = sessions if measured_sessions is not None else proof_messages
        if balance_count % V3_SYSTEMATIC_PROVIDERS:
            raise ValueError("native v3 capacity inventory must balance provider lanes")
        if proof_messages % batch_size or (measured_sessions is not None and
                                           sessions % (V3_SYSTEMATIC_PROVIDERS * batch_size)):
            raise ValueError("native v3 capacity inventory must form exact provider-local batches")
        profile.update(sessions=sessions, proof_messages=proof_messages,
                       measured_transactions=proof_messages // batch_size,
                       submission_mode=submission_mode, batch_size=batch_size)
        return selected
    if measured_transactions is not None or measured_sessions is not None or submission_mode != "separate" or batch_size != 1:
        raise ValueError("capacity controls require a selected profile")
    for profile in profiles:
        profile.update(proof_messages=profile["measured_transactions"],
                       submission_mode="separate", batch_size=1)
    return profiles


def native_v3_minimum_gas_blocks(total_gas, max_block_gas):
    total_gas = artifact.integer(total_gas, "inventory gas", 1)
    max_block_gas = artifact.integer(max_block_gas, "max block gas", 1)
    blocks = (total_gas + max_block_gas - 1) // max_block_gas
    if blocks <= V3_CHAIN_BACKLOG_SECONDS:
        raise ValueError("fixed inventory must require more than ten maximum-gas blocks")
    return blocks


def validate_native_v3_capacity_epoch(profile, max_block_gas):
    """Reject inventories too small for backlog or too large for the fixed epoch."""
    # The route-specific crypto charge is the protocol floor. The retained
    # native-v3-chain-322 and gas-sweep-324 maxima give a conservative
    # 813k/opening + 130k/transaction envelope.
    # The retained gas-sweep-324 one-opening minimum is 904,051 gas, so 404k of
    # per-transaction overhead is a rounded-down floor for this fixed workload.
    proof_count = profile["sessions"] * profile["sample_count"]
    if profile["submission_mode"] == "batch-message":
        crypto_gas = (profile["measured_transactions"] * V3_AGGREGATE_PROOF_BASE_GAS +
                      (proof_count - profile["measured_transactions"]) * V3_AGGREGATE_PROOF_MARGINAL_GAS)
    else:
        crypto_gas = proof_count * V3_INDEPENDENT_PROOF_CRYPTO_GAS
    minimum_gas = (crypto_gas +
                   profile["measured_transactions"] * V3_PROOF_TRANSACTION_MINIMUM_OVERHEAD_GAS)
    estimated_gas = (crypto_gas + proof_count * V3_PROOF_OPENING_OVERHEAD_GAS +
                     profile["measured_transactions"] * V3_PROOF_TRANSACTION_OVERHEAD_GAS)
    max_block_gas = artifact.integer(max_block_gas, "max block gas", 1)
    # Aggregate gas outside crypto varies enough that this static floor can
    # understate the live transaction by more than 2x. Its exact simulations
    # below are the authoritative backlog gate.
    if profile["submission_mode"] != "batch-message":
        native_v3_minimum_gas_blocks(minimum_gas, max_block_gas)
    minimum_blocks = (estimated_gas + max_block_gas - 1) // max_block_gas
    if minimum_blocks + V3_CHAIN_MEASUREMENT_MARGIN_BLOCKS > V3_CHAIN_AUDIT_EPOCH_BLOCKS - 2:
        raise ValueError("native chain capacity inventory cannot fit within one audit epoch")


def native_v3_capacity_deadline(opened_at, session_index):
    return opened_at + V3_CHAIN_SESSION_TTL_BLOCKS + session_index // V3_EXPIRY_REFS_PER_BLOCK


def native_v3_cross_audit_schedule():
    """Forty-five sessions by eight providers, offered round-robin at 2 tx/s."""
    rows = []
    for index in range(V3_CROSS_AUDIT_MEASURED):
        session_index = 1 + index // V3_SYSTEMATIC_PROVIDERS
        slot = index % V3_SYSTEMATIC_PROVIDERS
        rows.append(dict(id=f"measured-{session_index}-{slot}", index=index,
                         session_index=session_index,
                         slot=slot,
                         offered_offset_ns=index * 500_000_000))
    return rows


def v3_http_schedule_bins(schedule, outcomes, *, start_ns):
    """Six fixed bins: offered cohort, terminal completions, queue, and in-flight."""
    if len(schedule) != V3_CROSS_AUDIT_MEASURED or len(outcomes) != len(schedule):
        raise ValueError("cross-audit bins require every scheduled terminal outcome")
    by_id = {row.get("request_id"): row for row in outcomes}
    if len(by_id) != len(outcomes) or set(by_id) != {row.get("id") for row in schedule}:
        raise ValueError("cross-audit terminal outcomes differ from the schedule")
    for row in schedule:
        offered = start_ns + row["offered_offset_ns"]
        outcome = by_id[row["id"]]
        dispatched = producer.uint(outcome.get("initial_dispatch_ns", 0), 64)
        started = producer.uint(outcome.get("request_started_ns", 0), 64)
        finished = producer.uint(outcome.get("request_finished_ns", 0), 64)
        if not offered <= dispatched <= started <= finished:
            raise ValueError("cross-audit terminal timing precedes its offer")
    width = V3_CROSS_AUDIT_BIN_SECONDS * 10**9
    if V3_CROSS_AUDIT_OFFER_SECONDS % V3_CROSS_AUDIT_BIN_SECONDS:
        raise ValueError("cross-audit bins do not divide the offer window")
    bins = []
    for index in range(V3_CROSS_AUDIT_OFFER_SECONDS // V3_CROSS_AUDIT_BIN_SECONDS):
        begin, end = start_ns + index * width, start_ns + (index + 1) * width
        cohort = [row for row in schedule if begin <= start_ns + row["offered_offset_ns"] < end]
        terminal = [row for row in outcomes
                    if begin <= producer.uint(row.get("request_finished_ns", 0), 64) < end]
        dispatched_by_end = sum(producer.uint(row.get("initial_dispatch_ns", 0), 64) < end
                                for row in outcomes)
        completed_by_end = sum(producer.uint(row.get("request_finished_ns", 0), 64) < end
                               for row in outcomes)
        offered_by_end = sum(start_ns + row["offered_offset_ns"] < end for row in schedule)
        dispatched_before = sum(producer.uint(row.get("initial_dispatch_ns", 0), 64) < begin
                                for row in outcomes)
        completed_before = sum(producer.uint(row.get("request_finished_ns", 0), 64) < begin
                               for row in outcomes)
        offered_before = sum(start_ns + row["offered_offset_ns"] < begin for row in schedule)
        bins.append(dict(index=index, start_offset_ns=index * width,
                         end_offset_ns=(index + 1) * width,
                         offered=len(cohort), terminal=len(terminal),
                         cohort_completed_by_end=sum(
                             producer.uint(by_id[row["id"]].get("request_finished_ns", 0), 64) < end
                             for row in cohort),
                         queued_at_end=offered_by_end - dispatched_by_end,
                         in_flight_at_end=dispatched_by_end - completed_by_end,
                         carryover_queued=offered_before - dispatched_before,
                         carryover_in_flight=dispatched_before - completed_before,
                         outstanding_at_end=offered_by_end - completed_by_end))
    return bins


def parse_proc_stat(raw, *, expected_pid=None):
    """Parse stable /proc/<pid>/stat identity, CPU and resident-page fields."""
    if not isinstance(raw, str) or ")" not in raw:
        raise ValueError("invalid validator proc stat")
    prefix, suffix = raw.rstrip("\n").rsplit(")", 1)
    if "(" not in prefix:
        raise ValueError("invalid validator proc stat command")
    pid_text, _ = prefix.split("(", 1)
    fields = suffix.strip().split()
    if len(fields) < 22:
        raise ValueError("short validator proc stat")
    pid = producer.uint(pid_text.strip())
    if expected_pid is not None and pid != expected_pid:
        raise ValueError("validator proc stat PID changed")
    return dict(pid=pid, user_ticks=producer.uint(fields[11]), system_ticks=producer.uint(fields[12]),
                starttime_ticks=producer.uint(fields[19]), rss_pages=producer.uint(fields[21]))


def parse_host_proc_stat(raw):
    fields = raw.splitlines()[0].split()
    if len(fields) < 5 or fields[0] != "cpu":
        raise ValueError("invalid host proc stat")
    ticks = [producer.uint(value) for value in fields[1:]]
    return dict(total_ticks=sum(ticks), idle_ticks=ticks[3] + (ticks[4] if len(ticks) > 4 else 0))


def parse_proc_memory(raw, *, process=False):
    values = {}
    for line in raw.splitlines():
        match = re.fullmatch(r"(MemTotal|MemAvailable|VmRSS):\s+(\d+)\s+kB", line)
        if match:
            values[match.group(1)] = producer.uint(match.group(2)) * 1024
    required = {"VmRSS"} if process else {"MemTotal", "MemAvailable"}
    if not required.issubset(values):
        raise ValueError("required proc memory fields are absent")
    return values


def native_v3_resource_sample(lifecycle):
    resources = lifecycle.doc.get("validator_resources", [])
    validators = []
    for node in lifecycle.nodes:
        matches = [row for row in resources if row.get("node_id") == node["node_id"]]
        if len(matches) != 1:
            raise ValueError("validator PID is not uniquely retained")
        pid = producer.uint(matches[0]["pid"])
        stat = parse_proc_stat(Path(f"/proc/{pid}/stat").read_text(), expected_pid=pid)
        memory = parse_proc_memory(Path(f"/proc/{pid}/status").read_text(), process=True)
        validators.append(dict(node_id=node["node_id"], **stat, rss_bytes=memory["VmRSS"]))
    memory = parse_proc_memory(Path("/proc/meminfo").read_text())
    return dict(monotonic_ns=artifact.monotonic_ns(),
                host_cpu=parse_host_proc_stat(Path("/proc/stat").read_text()),
                host_memory=memory, validators=validators)


def summarize_native_v3_resources(samples):
    if len(samples) < 2:
        raise ValueError("resource utilization requires two samples")
    first, last = samples[0], samples[-1]
    elapsed_seconds = (producer.uint(last["monotonic_ns"]) -
                       producer.uint(first["monotonic_ns"])) / 1e9
    if elapsed_seconds <= 0:
        raise ValueError("resource sample timestamps did not advance")
    total = last["host_cpu"]["total_ticks"] - first["host_cpu"]["total_ticks"]
    idle = last["host_cpu"]["idle_ticks"] - first["host_cpu"]["idle_ticks"]
    if total <= 0 or idle < 0 or idle > total:
        raise ValueError("host CPU ticks changed invalidly")
    tick_rate = os.sysconf("SC_CLK_TCK")
    if type(tick_rate) is not int or tick_rate <= 0:
        raise ValueError("invalid Linux clock tick rate")
    first_validators = {row["node_id"]: row for row in first["validators"]}
    validator_rows = []
    for node_id in first_validators:
        observations = [{row["node_id"]: row for row in sample["validators"]}[node_id]
                        for sample in samples]
        start, end = observations[0], observations[-1]
        if (start["pid"], start["starttime_ticks"]) != (end["pid"], end["starttime_ticks"]):
            raise ValueError("validator process identity changed during resource sampling")
        cpu_ticks = end["user_ticks"] + end["system_ticks"] - start["user_ticks"] - start["system_ticks"]
        if cpu_ticks < 0:
            raise ValueError("validator CPU ticks moved backwards")
        validator_rows.append(dict(node_id=node_id, pid=start["pid"],
            average_cpu_cores=cpu_ticks / tick_rate / elapsed_seconds,
            peak_rss_bytes=max(row["rss_bytes"] for row in observations)))
    totals = [sample["host_memory"]["MemTotal"] for sample in samples]
    if len(set(totals)) != 1:
        raise ValueError("host memory total changed during resource sampling")
    used = [totals[0] - sample["host_memory"]["MemAvailable"] for sample in samples]
    return dict(sample_count=len(samples), elapsed_seconds=elapsed_seconds,
        host_average_cpu_fraction=(total - idle) / total,
        host_peak_memory_used_bytes=max(used), host_memory_total_bytes=totals[0],
        validators=validator_rows,
        aggregate_validator_average_cpu_cores=sum(row["average_cpu_cores"] for row in validator_rows),
        aggregate_validator_peak_rss_bytes=max(
            sum({row["node_id"]: row for row in sample["validators"]}[node_id]["rss_bytes"]
                for node_id in first_validators) for sample in samples))


def validator_cpu_snapshot(lifecycle):
    ticks = os.sysconf("SC_CLK_TCK")
    if type(ticks) is not int or ticks <= 0:
        raise ValueError("invalid Linux clock tick rate")
    page_size = os.sysconf("SC_PAGE_SIZE")
    if type(page_size) is not int or page_size <= 0:
        raise ValueError("invalid Linux page size")
    at = artifact.monotonic_ns()
    rows = []
    resources = lifecycle.doc.get("validator_resources", [])
    for node in lifecycle.nodes:
        matches = [row for row in resources if row.get("node_id") == node["node_id"]]
        if len(matches) != 1:
            raise ValueError("validator PID is not uniquely retained")
        pid = producer.uint(matches[0]["pid"])
        stat = parse_proc_stat(Path(f"/proc/{pid}/stat").read_text(), expected_pid=pid)
        rss_bytes = stat.pop("rss_pages") * page_size
        rows.append(dict(node_id=node["node_id"], **stat, rss_bytes=rss_bytes))
    return dict(monotonic_ns=at, clock_ticks_per_second=ticks,
                page_size_bytes=page_size, validators=rows)


def validator_cpu_delta(before, after):
    if before["clock_ticks_per_second"] != after["clock_ticks_per_second"]:
        raise ValueError("validator clock tick rate changed")
    earlier = {row["node_id"]: row for row in before["validators"]}
    later = {row["node_id"]: row for row in after["validators"]}
    if set(earlier) != set(later) or after["monotonic_ns"] < before["monotonic_ns"]:
        raise ValueError("validator CPU snapshot set or time changed")
    rows = []
    for node_id, start in earlier.items():
        end = later[node_id]
        if (end["pid"], end["starttime_ticks"]) != (start["pid"], start["starttime_ticks"]):
            raise ValueError("validator process identity changed during measurement")
        user, system = end["user_ticks"] - start["user_ticks"], end["system_ticks"] - start["system_ticks"]
        if user < 0 or system < 0:
            raise ValueError("validator CPU ticks moved backwards")
        rows.append(dict(node_id=node_id, pid=start["pid"], starttime_ticks=start["starttime_ticks"],
                         user_ticks=user, system_ticks=system,
                         user_cpu_seconds=user / before["clock_ticks_per_second"],
                         system_cpu_seconds=system / before["clock_ticks_per_second"],
                         rss_start_bytes=start.get("rss_bytes"), rss_end_bytes=end.get("rss_bytes")))
    return dict(measurement_scope="measured scheduler window", monotonic_start_ns=before["monotonic_ns"],
                monotonic_end_ns=after["monotonic_ns"], clock_ticks_per_second=before["clock_ticks_per_second"],
                validators=rows)


def validator_backlog_resources(samples, backlog, clock_ticks_per_second):
    """CPU and sampled RSS for each validator inside the positive-backlog fence."""
    ticks = producer.uint(clock_ticks_per_second)
    selected = [sample for sample in samples if
                backlog["monotonic_start_ns"] <= sample["monotonic_ns"] <= backlog["monotonic_end_ns"]]
    if len(selected) < 2 or ticks == 0:
        raise ValueError("positive backlog has insufficient validator resource samples")
    node_ids = {row["node_id"] for row in selected[0]["nodes"]}
    if len(node_ids) != 4:
        raise ValueError("validator resource samples do not identify four nodes")
    rows = []
    for node_id in sorted(node_ids):
        observed = []
        for sample in selected:
            matches = [row for row in sample["nodes"] if row.get("node_id") == node_id]
            if len(matches) != 1:
                raise ValueError("validator resource sample set changed")
            observed.append(matches[0])
        first, last = observed[0], observed[-1]
        if (first["pid"], first["starttime_ticks"]) != (last["pid"], last["starttime_ticks"]):
            raise ValueError("validator process identity changed during backlog")
        elapsed = (last["process_monotonic_ns"] - first["process_monotonic_ns"]) / 1e9
        user = last["user_ticks"] - first["user_ticks"]
        system = last["system_ticks"] - first["system_ticks"]
        if elapsed <= 0 or user < 0 or system < 0:
            raise ValueError("validator backlog resource counters are invalid")
        rows.append(dict(node_id=node_id, pid=first["pid"], elapsed_seconds=elapsed,
            cpu_percent_of_one_core=(user + system) / ticks / elapsed * 100,
            user_cpu_seconds=user / ticks, system_cpu_seconds=system / ticks,
            sampled_peak_rss_bytes=max(row["rss_bytes"] for row in observed),
            peak_mempool_transactions=max(row["transactions"] for row in observed),
            peak_mempool_bytes=max(row["bytes"] for row in observed)))
    return {"measurement_scope": "longest all-validator-positive mempool interval",
            "rss_basis": "100ms /proc resident-set samples; sampled peak, not process-lifetime peak",
            "validators": rows}


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
                        file_bytes=V3_PILOT_BYTES, range_start=0, range_length=None,
                        expired=False, refunded=False):
    """Fail closed on the v3 fields that define pilot claims and liabilities."""
    shape = native_v3_range_shape(range_length or file_bytes,
                                  range_start=range_start, file_bytes=file_bytes)
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
            producer.uint(session.get("range_start", 1)) != range_start or
            producer.uint(session.get("range_length", 0)) != shape["range_bytes"] or
            producer.uint(session.get("generation", 0)) != 1 or
            producer.uint(session.get("metadata_mdus", 0)) != 2 or
            producer.uint(session.get("user_mdus", 0)) != 3 or
            producer.uint(session.get("first_blob", 1)) != shape["first_blob"] or
            producer.uint(session.get("last_blob", 0)) != shape["last_blob"] or
            producer.uint(session.get("population", 0)) != shape["population"] or
            producer.uint(session.get("sample_count", 0)) != shape["sample_count"] or
            producer.uint(session.get("deadline_height", 0)) != deadline_height or
            session.get("chain_id") != chain_id or
            producer.b64(session.get("polyfs_root", ""), 32).hex() != polyfs_root or
            producer.b64(session.get("integrity_root", ""), 32).hex() != integrity_root or
            producer.b64(session.get("setup_digest", ""), 32).hex() != producer.SETUP_DIGEST or
            not any(producer.b64(session.get("plan_hash", ""), 32)) or
            bool(session.get("expired", False)) is not expired):
        raise ValueError("v3 session differs from the fixed pilot authority")
    obligations = session.get("obligations")
    if not isinstance(obligations, list) or len(obligations) != len(shape["obligation_slots"]):
        raise ValueError("v3 session has the wrong provider obligation count")
    slots = []
    for obligation in obligations:
        slot = producer.uint(obligation.get("slot", 99))
        if (slot >= V3_SYSTEMATIC_PROVIDERS or obligation.get("assigned_provider") != providers.get(slot) or
                obligation.get("payee") != providers.get(slot) or
                producer.uint(obligation.get("blob_count", 0)) == 0):
            raise ValueError("v3 session obligation differs from the finalized assignment")
        slots.append(slot)
    if (slots != shape["obligation_slots"] or
            sum(producer.uint(row["blob_count"]) for row in obligations) != shape["population"]):
        raise ValueError("v3 systematic obligations must be ordered and unique")
    ordinals = v3_bitmap_ordinals(session)
    if refunded and not expired:
        raise ValueError("v3 session cannot be refunded before expiry")
    expected_mask = sum(1 << slot for slot in shape["obligation_slots"])
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


def _nearest_rank(values, percentile):
    if not values:
        raise ValueError("phase percentile requires observations")
    ordered = sorted(values)
    return ordered[(len(ordered) * percentile + 99) // 100 - 1]


def validate_v3_provider_phase_timings(outcomes, transactions):
    """Qualify monotonic provider phases after authoritative transaction joins."""
    reasons = []
    transaction_operations = [row.get("operation_id") for row in transactions]
    outcome_operations = [row.get("request_id") for row in outcomes]
    operation_ids_valid = (all(isinstance(value, str) and value for value in outcome_operations) and
                           all(isinstance(value, str) and value for value in transaction_operations))
    by_operation = ({row["operation_id"]: row for row in transactions}
                    if operation_ids_valid else {})
    if (not outcomes or not operation_ids_valid or len(outcomes) != len(transactions) or
            len(set(outcome_operations)) != len(outcome_operations) or None in outcome_operations or
            len(by_operation) != len(transactions) or
            set(outcome_operations) != set(by_operation)):
        reasons.append("timing rows do not map one-to-one to committed operations")
    phases = {name: [] for name in ("authority_ns", "proof_preparation_ns",
                                    "pre_broadcast_ns", "broadcast_tx_sync_ns",
                                    "commit_observation_ns", "provider_total_ns",
                                    "unattributed_ns")}
    observations = []
    retries = 0
    for outcome in outcomes:
        operation = outcome.get("request_id")
        if not isinstance(operation, str) or not operation:
            reasons.append("timing outcome has an invalid operation identity")
            continue
        transaction = by_operation.get(operation)
        if transaction is None:
            reasons.append(f"operation {operation!r} lacks an authoritative transaction")
            continue
        validators = transaction.get("validators")
        try:
            slot = producer.uint(outcome.get("slot", 99))
            identity = (outcome.get("status") == "success" and
                        transaction.get("outcome") == "committed_success" and
                        isinstance(outcome.get("tx_hash"), str) and
                        isinstance(transaction.get("txhash"), str) and
                        outcome["tx_hash"].upper() == transaction["txhash"].upper() and
                        outcome.get("provider") == transaction.get("provider") == transaction.get("creator") and
                        outcome.get("session_id") == transaction.get("session_id") and
                        slot == transaction.get("slot") and isinstance(validators, list) and
                        len(validators) == 4 and len({row.get("node_id") for row in validators}) == 4)
        except (TypeError, ValueError):
            identity = False
        if not identity:
            reasons.append(f"operation {operation!r} timing identity is not its all-validator receipt")
            continue
        timing = outcome.get("timing")
        expected = {"schema", "authority_ns", "proof_preparation_ns", "submission_attempts",
                    "commit_observation_ns", "provider_total_ns"}
        if not isinstance(timing, dict) or set(timing) != expected or timing.get("schema") != V3_PROVIDER_TIMING_SCHEMA:
            reasons.append(f"operation {operation!r} has missing or malformed provider timing")
            continue
        values = {}
        try:
            for name in ("authority_ns", "proof_preparation_ns", "commit_observation_ns",
                         "provider_total_ns"):
                value = timing.get(name)
                if type(value) is not int or not 0 <= value <= V3_PROVIDER_TIMING_MAX_NS:
                    raise ValueError(name)
                values[name] = value
            attempts = timing.get("submission_attempts")
            if not isinstance(attempts, list) or not 1 <= len(attempts) <= 5:
                raise ValueError("submission_attempts")
            attempt_total = 0
            attempt_values = {"pre_broadcast_ns": [], "broadcast_tx_sync_ns": []}
            for index, attempt in enumerate(attempts, 1):
                if not isinstance(attempt, dict) or set(attempt) != {
                        "attempt", "pre_broadcast_ns", "broadcast_tx_sync_ns", "check_tx_code"}:
                    raise ValueError("submission_attempt")
                if type(attempt.get("attempt")) is not int or attempt["attempt"] != index or \
                        type(attempt.get("check_tx_code")) is not int:
                    raise ValueError("submission_attempt")
                expected_code = 0 if index == len(attempts) else 32
                if attempt["check_tx_code"] != expected_code:
                    raise ValueError("check_tx_code")
                for name in ("pre_broadcast_ns", "broadcast_tx_sync_ns"):
                    value = attempt.get(name)
                    if type(value) is not int or not 0 <= value <= V3_PROVIDER_TIMING_MAX_NS:
                        raise ValueError(name)
                    attempt_values[name].append(value)
                    attempt_total += value
            if values["provider_total_ns"] < (values["authority_ns"] +
                    values["proof_preparation_ns"] + values["commit_observation_ns"] + attempt_total):
                raise ValueError("provider_total_ns")
        except ValueError as error:
            reasons.append(f"operation {operation!r} has invalid {error.args[0]} timing")
            continue
        retries += len(attempts) - 1
        for name, row_values in attempt_values.items():
            phases[name].extend(row_values)
        for name, value in values.items():
            phases[name].append(value)
        unattributed = values["provider_total_ns"] - (values["authority_ns"] +
            values["proof_preparation_ns"] + values["commit_observation_ns"] + attempt_total)
        phases["unattributed_ns"].append(unattributed)
        observations.append(dict(operation_id=operation, unattributed_ns=unattributed))
    qualified = not reasons and len(phases["provider_total_ns"]) == len(outcomes)
    result = dict(schema=V3_PROVIDER_TIMING_SCHEMA, qualification=qualified,
                  transaction_count=len(outcomes), sequence_retry_attempts=retries,
                  scope=("same-process monotonic durations; provider total starts at V3 dispatch after "
                         "route selection and signer admission; pre-broadcast starts at CLI RunE, not process "
                         "start; unattributed includes process startup, journal work, retry backoff and other "
                         "local overhead; consensus header times remain separate inter-block wall time"),
                  observations=observations, reasons=reasons)
    if qualified:
        result["percentiles_ns"] = {name: {f"p{percentile}": _nearest_rank(values, percentile)
            for percentile in (50, 95, 99)} for name, values in phases.items()}
    return result


def _encode_varint(value):
    if type(value) is not int or value < 0 or value > (1 << 64) - 1:
        raise ValueError("protobuf integer outside uint64")
    out = bytearray()
    while value >= 128:
        out.append((value & 0x7f) | 0x80)
        value >>= 7
    out.append(value)
    return bytes(out)


def opened_v3_sessions(result, count, *, logical_bytes=V3_PILOT_BYTES, shapes=None):
    """Decode exact ordered native v3 open responses retained in one committed tx."""
    artifact.integer(count, "v3 open response count", 1, V3_CROSS_AUDIT_OPEN_BATCH_MAX)
    expected_type = b"/polystorechain.polystorechain.v1.MsgOpenRetrievalSessionV3Response"
    if shapes is None:
        shapes = [dict(range_start=0, range_length=logical_bytes,
                       file_length=logical_bytes)] * count
    if not isinstance(shapes, list) or len(shapes) != count:
        raise ValueError("v3 open response shapes differ from the batch")
    frames = []
    for expected in shapes:
        if producer.uint(expected.get("file_start_offset", 0)) != 0:
            raise ValueError("v3 open response decoder only supports zero file start offset")
        shape = native_v3_range_shape(
            producer.uint(expected.get("range_length", "")),
            range_start=producer.uint(expected.get("range_start", "")),
            file_bytes=producer.uint(expected.get("file_length", "")))
        suffix = (b"\x10" + _encode_varint(shape["range_bytes"]) +
                  b"\x18" + _encode_varint(shape["population"] * artifact.ENCODED_BLOB_BYTES) +
                  b"\x20" + _encode_varint(shape["sample_count"]))
        response = b"\x0a\x20" + bytes(32) + suffix
        any_value = (b"\x0a" + _encode_varint(len(expected_type)) + expected_type +
                     b"\x12" + _encode_varint(len(response)) + response)
        frames.append((b"\x12" + _encode_varint(len(any_value)) + any_value, len(suffix)))
    data = result.get("data", "")
    if (result.get("outcome") != "committed_success" or not isinstance(data, str) or
            len(data) != sum(len(frame) for frame, _ in frames) * 2 or
            not re.fullmatch(r"[0-9a-fA-F]+", data)):
        raise ValueError("invalid committed v3 open response")
    raw = bytes.fromhex(data)
    sessions, offset = [], 0
    for frame, suffix_length in frames:
        value = raw[offset:offset + len(frame)]
        sid_offset = len(frame) - suffix_length - 32
        session = value[sid_offset:sid_offset + 32]
        if (value[:sid_offset] != frame[:sid_offset] or
                value[sid_offset + 32:] != frame[sid_offset + 32:] or not any(session)):
            raise ValueError("v3 open response differs from the fixed pilot geometry")
        sessions.append(session.hex())
        offset += len(frame)
    if len(set(sessions)) != count:
        raise ValueError("v3 open response repeats a session id")
    return sessions


def opened_v3_session(result, *, logical_bytes=V3_PILOT_BYTES):
    return opened_v3_sessions(result, 1, logical_bytes=logical_bytes)[0]


def _run_v3_http_request(lifecycle, curl, request, phase, index, directory,
                         phase_deadline, retry_pre_admission_busy):
    """Run one provider request with the production route's exact safe-busy retry."""
    attempts = []
    limit = V3_BUSY_MAX_ATTEMPTS if retry_pre_admission_busy else 1
    offered_ns = request.get("offered_ns")
    initial_dispatch_ns = None
    for attempt in range(1, limit + 1):
        if attempt > 1:
            if artifact.monotonic_ns() + V3_BUSY_RETRY_SECONDS * 10**9 >= phase_deadline:
                break
            time.sleep(V3_BUSY_RETRY_SECONDS)
        path = directory / f"{phase}-{index}-{attempt}.json"
        began = artifact.monotonic_ns()
        if initial_dispatch_ns is None:
            initial_dispatch_ns = began
        request_deadline = min(phase_deadline,
                               began + request.get("timeout_seconds", 180) * 10**9)
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
                       request_index=index, request_id=request.get("id"), offered_ns=offered_ns,
                       initial_dispatch_ns=initial_dispatch_ns, request_started_ns=began,
                       request_finished_ns=artifact.monotonic_ns(),
                       stderr=result.stderr[-8192:], curl_returncode=result.returncode)
            attempts.append(row)
            if result.returncode != 0:
                return attempts, ValueError(
                    f"v3 HTTP request for provider {request['provider']!r} exited {result.returncode}")
            error = body.get("error")
            generation_busy = (
                urllib.parse.urlsplit(request["url"]).path == "/sp/generation-v3/accept" and
                error in {"provider signer busy",
                          "provider signer busy after generation verification"})
            busy = (code == 429 and set(body) == {"error", "hint"} and
                    (error == "retrieval submission busy" or generation_busy) and
                    body.get("hint") == "retrieval submission capacity or signer busy")
            if not retry_pre_admission_busy or not busy:
                return attempts, None
        except BaseException as error:
            attempts.append(dict(status="driver_error", provider=request["provider"], attempt=attempt,
                                 request_index=index, request_id=request.get("id"), offered_ns=offered_ns,
                                 initial_dispatch_ns=initial_dispatch_ns, request_started_ns=began,
                                 error=str(error)[-8192:],
                                 request_finished_ns=artifact.monotonic_ns()))
            return attempts, error
        finally:
            path.unlink(missing_ok=True)
    return attempts, None


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

    errors = []
    with ThreadPoolExecutor(max_workers=max_in_flight) as executor:
        pending = {executor.submit(_run_v3_http_request, lifecycle, curl, request, phase, index,
                                   directory, phase_deadline, retry_pre_admission_busy): request
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


def run_v3_http_schedule(lifecycle, curl, requests, phase):
    """Offer a fixed provider HTTP schedule with one in-flight request per signer."""
    offsets = [row.get("offered_offset_ns") for row in requests]
    if (not requests or len(requests) > V3_CROSS_AUDIT_MEASURED or
            any(type(value) is not int or value < 0 for value in offsets) or
            offsets != sorted(offsets) or
            len({row.get("id") for row in requests}) != len(requests) or
            not 1 <= len({row.get("provider") for row in requests}) <= V3_SYSTEMATIC_PROVIDERS):
        raise ValueError("invalid bounded v3 HTTP schedule")
    require_free_disk(lifecycle.home, V3_ABORT_FREE_BYTES, phase)
    directory = lifecycle.home / "v3-http"
    directory.mkdir(mode=0o700, exist_ok=True)
    started = artifact.monotonic_ns()
    phase_deadline = min(lifecycle.deadline, started +
        (V3_CROSS_AUDIT_OFFER_SECONDS + V3_CROSS_AUDIT_DRAIN_SECONDS) * 10**9)
    scheduled = [dict(row, offered_ns=started + row["offered_offset_ns"], timeout_seconds=30)
                 for row in requests]
    retained = lifecycle.doc.setdefault("v3_http_phases", {}).setdefault(phase, [])
    summary = lifecycle.doc.setdefault("v3_http_schedules", {}).setdefault(phase, dict(
        monotonic_start_ns=started, offered_window_ns=V3_CROSS_AUDIT_OFFER_SECONDS * 10**9,
        drain_cap_ns=V3_CROSS_AUDIT_DRAIN_SECONDS * 10**9, total=len(requests),
        offered=0, completed=0, queued=0, in_flight=0, max_in_flight_per_provider=1,
        max_queued=0, max_in_flight=0, max_dispatch_lag_ns=0,
        timing_scope="provider HTTP includes proof generation, local verification, gas simulation, signing, broadcast and commit observation"))
    queued, next_index, active, pending, completed, errors = [], 0, set(), {}, [], []
    last_heartbeat = last_progress = started
    with ThreadPoolExecutor(max_workers=V3_SYSTEMATIC_PROVIDERS) as executor:
        while len(completed) < len(scheduled) and (not errors or pending):
            now = artifact.monotonic_ns()
            if not errors:
                while next_index < len(scheduled) and scheduled[next_index]["offered_ns"] <= now:
                    queued.append(next_index)
                    next_index += 1
                for index in list(queued):
                    request = scheduled[index]
                    if request["provider"] in active:
                        continue
                    queued.remove(index)
                    active.add(request["provider"])
                    pending[executor.submit(_run_v3_http_request, lifecycle, curl, request, phase,
                        index, directory, phase_deadline, True)] = (index, request)
                summary["max_in_flight"] = max(summary["max_in_flight"], len(pending))
            timeout = .1
            if not pending and next_index < len(scheduled) and not errors:
                timeout = min(timeout, max(0, (scheduled[next_index]["offered_ns"] - now) / 1e9))
            if pending:
                done = wait_futures(pending, timeout=timeout, return_when=FIRST_COMPLETED)[0]
            else:
                time.sleep(timeout)
                done = set()
            now = artifact.monotonic_ns()
            for future in done:
                index, request = pending.pop(future)
                active.remove(request["provider"])
                future_error = None
                try:
                    attempts, future_error = future.result()
                except BaseException as error:
                    attempts = [dict(status="driver_error", provider=request["provider"],
                        request_index=index, request_id=request["id"], offered_ns=request["offered_ns"],
                        initial_dispatch_ns=now, request_started_ns=now,
                        error=str(error)[-8192:], request_finished_ns=now)]
                    future_error = error
                retained.extend(attempts)
                if future_error is not None:
                    errors.append(future_error)
                else:
                    completed.append(attempts[-1])
                    summary["max_dispatch_lag_ns"] = max(summary["max_dispatch_lag_ns"],
                        attempts[0]["request_started_ns"] - attempts[0]["offered_ns"])
                    last_progress = now
            summary.update(offered=next_index, completed=len(completed), queued=len(queued),
                           in_flight=len(pending), elapsed_ns=now-started,
                           seconds_since_progress=(now-last_progress)/1e9)
            summary["max_queued"] = max(summary["max_queued"], len(queued))
            if now - last_heartbeat >= 60 * 10**9:
                heartbeat = dict(phase=phase, **{key: summary[key] for key in (
                    "offered", "completed", "queued", "in_flight", "elapsed_ns", "seconds_since_progress")})
                lifecycle.doc.setdefault("progress", []).append(heartbeat)
                lifecycle.save()
                print(json.dumps(heartbeat, sort_keys=True), flush=True)
                last_heartbeat = now
            elif done:
                lifecycle.save()
            if not errors:
                try:
                    lifecycle.remaining()
                    if now >= phase_deadline:
                        raise TimeoutError(f"{phase} exceeded its fixed offer and drain cap")
                    require_free_disk(lifecycle.home, V3_ABORT_FREE_BYTES, phase)
                except BaseException as error:
                    errors.append(error)
    finished = artifact.monotonic_ns()
    summary.update(monotonic_end_ns=finished, elapsed_ns=finished-started,
                   offered=next_index, completed=len(completed), queued=len(queued), in_flight=0,
                   terminal_error=str(errors[0])[-8192:] if errors else None)
    lifecycle.save()
    if errors:
        raise errors[0]
    return sorted(completed, key=lambda row: row["request_index"])


def v3_session_query(lifecycle, session_id, height=None):
    if height is None:
        height = lifecycle.wait_height(1)
    encoded = base64.urlsafe_b64encode(bytes.fromhex(session_id)).decode()
    route = API + "/retrieval-sessions-v3/" + encoded
    rows = [lifecycle.query(node, route, height) for node in lifecycle.nodes]
    if any(row != rows[0] for row in rows[1:]):
        raise ValueError("four validators disagree on v3 session state")
    return rows[0]


def v3_session_queries(lifecycle, sessions, height):
    """Read a fixed session inventory concurrently while preserving input order."""
    if not sessions:
        return []
    def query(row):
        return v3_session_query(lifecycle, row["session_id"], height)
    with ThreadPoolExecutor(max_workers=min(V3_SYSTEMATIC_PROVIDERS, len(sessions))) as pool:
        return list(pool.map(query, sessions))


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
    code = producer.uint(response["tx_result"].get("code", 0))
    result = dict(txhash=response["hash"], height=producer.uint(response["height"]),
                  code=code,
                  gas_wanted=producer.uint(response["tx_result"]["gas_wanted"]),
                  gas_used=producer.uint(response["tx_result"]["gas_used"]),
                  raw_log=response["tx_result"].get("log", ""),
                  outcome="committed_success" if code == 0 else "committed_failure")
    artifact.committed_tx(result, txhash)
    result["validators"] = verify_transaction_nodes(lifecycle, result)
    decoded = json.loads(lifecycle.cli(lifecycle.nodes[0]["home"], "query", "tx", txhash, "--output", "json"))
    if (decoded.get("txhash", "").upper() != txhash or
            producer.uint(decoded.get("height", "")) != result["height"]):
        raise ValueError("decoded HTTP transaction identity differs from committed RPC result")
    messages = decoded.get("tx", {}).get("body", {}).get("messages", [])
    if len(messages) != 1:
        raise ValueError("committed HTTP transaction must contain exactly one message")
    result["ordinals"] = validate_v3_committed_message(messages[0], kind=kind, creator=creator,
        slot=slot, deal_id=deal_id, session_id=session_id, proof_count=proof_count)
    if kind == "session-proof":
        result.update(operation_id=row.get("request_id"), provider=creator, creator=creator,
                      slot=slot, session_id="0x" + session_id)
    return result


def verify_v3_refund_transaction(lifecycle, result, *, owner, session_id):
    """Bind a refund receipt to its exact owner/session message on all validators."""
    result["validators"] = verify_transaction_nodes(lifecycle, result)
    txhash = result["txhash"].upper()
    decoded = json.loads(lifecycle.cli(
        lifecycle.nodes[0]["home"], "query", "tx", txhash, "--output", "json"))
    messages = decoded.get("tx", {}).get("body", {}).get("messages", [])
    if (decoded.get("txhash", "").upper() != txhash or
            producer.uint(decoded.get("height", "")) != producer.uint(result["height"]) or
            len(messages) != 1 or
            messages[0].get("@type") != "/polystorechain.polystorechain.v1.MsgRefundRetrievalSessionV3" or
            messages[0].get("creator") != owner or
            producer.b64(messages[0].get("session_id", ""), 32).hex() != session_id):
        raise ValueError("committed v3 refund differs from the intended owner/session")
    result["message"] = messages[0]
    return result


def v3_file_geometry(file_bytes):
    file_bytes = artifact.integer(file_bytes, "v3 fixture bytes", 1, 1_073_741_824)
    user_mdus = (file_bytes + V3_USER_MDU_BYTES - 1) // V3_USER_MDU_BYTES
    return dict(size=file_bytes, metadata_mdus=2, user_mdus=user_mdus,
                total_mdus=2 + user_mdus, witness_mdus=1,
                integrity_leaf_count=96 * user_mdus)


def validate_v3_candidate(value, *, deal_id, file_bytes=V3_PILOT_BYTES):
    geometry = v3_file_geometry(file_bytes)
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
            [producer.uint(deal_id), 0, geometry["size"], geometry["total_mdus"],
             geometry["witness_mdus"], geometry["integrity_leaf_count"]] or
            candidate.get("previous_polyfs_root", "") not in ("", "0x") or
            candidate.get("commit_action") != "propose-deal-generation-v3" or
            producer.uint(candidate.get("required_acceptances", 0)) != 12):
        raise ValueError("FAT v3 candidate differs from the fixed pilot geometry")
    return candidate


def validate_v3_generation(response, candidate, providers, *, owner, admitted,
                           file_bytes=V3_PILOT_BYTES):
    geometry = v3_file_geometry(file_bytes)
    value = response.get("admitted" if admitted else "pending")
    if not isinstance(value, dict) or response.get("pending" if admitted else "admitted"):
        raise ValueError("v3 generation query has the wrong admission state")
    if ([producer.uint(value.get(name, 0)) for name in (
            "deal_id", "generation", "size", "total_mdus", "witness_mdus",
            "metadata_mdus", "user_mdus", "integrity_leaf_count", "accepted_slots_mask")] !=
            [producer.uint(candidate["deal_id"]), 1, geometry["size"], geometry["total_mdus"],
             geometry["witness_mdus"], geometry["metadata_mdus"], geometry["user_mdus"],
             geometry["integrity_leaf_count"],
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
        requests = [dict(id=f"session-{row['nonce']}-{slot}", provider=providers[slot],
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
        phase_timing = validate_v3_provider_phase_timings(outcomes, transactions)
        at = max(producer.uint(tx["height"]) for tx in transactions)
        wait(at + 1)
        after = v3_session_query(lifecycle, row["session_id"], at)
        _, accepted = validate_v3_session(after, session_id=row["session_id"], deal_id=deal["id"],
            owner=owner, providers=providers, nonce=row["nonce"], polyfs_root=polyfs_root,
            integrity_root=integrity_root, chain_id=lifecycle.chain, deadline_height=deadline_height)
        tx_ordinals = sorted(ordinal for tx in transactions for ordinal in tx["ordinals"])
        if accepted != tx_ordinals or len(accepted) != V3_MAX_SAMPLES or summary["proof_count"] != V3_MAX_SAMPLES:
            raise ValueError("committed v3 proof messages do not equal authoritative bitmap deltas")
        row.update(provider_outcomes=outcomes, outcome_summary=summary, phase_timing=phase_timing,
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
        verify_v3_refund_transaction(lifecycle, refunded, owner=owner, session_id=row["session_id"])
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


def classify_cross_audit_transaction(lifecycle, transaction, height, providers, deal_id, epochs):
    """Return one exact committed system-audit transaction or reject provider extras."""
    txhash = transaction["txhash"].upper()
    decoded = json.loads(lifecycle.cli(lifecycle.nodes[0]["home"], "query", "tx", txhash, "--output", "json"))
    if decoded.get("txhash", "").upper() != txhash or producer.uint(decoded.get("height", "")) != height:
        raise ValueError("decoded cross-audit transaction identity differs from committed block")
    messages = decoded.get("tx", {}).get("body", {}).get("messages", [])
    provider_messages = [row for row in messages if row.get("creator") in providers.values()]
    if not provider_messages:
        return None
    if len(messages) != 1 or len(provider_messages) != 1:
        raise ValueError("provider transaction contains an unexpected message set")
    message = provider_messages[0]
    expected_epochs = {producer.uint(value) for value in epochs} if not isinstance(epochs, int) else {epochs}
    epoch = producer.uint(message.get("epoch_id", ""))
    if (message.get("@type") != "/polystorechain.polystorechain.v1.MsgProveLiveness" or
            producer.uint(message.get("deal_id", "")) != producer.uint(deal_id) or
            epoch not in expected_epochs or
            set(message).intersection({"user_receipt", "system_proof", "user_receipt_batch", "session_proof"}) != {"system_proof"} or
            not isinstance(message.get("system_proof"), dict) or not message["system_proof"] or
            producer.uint(transaction.get("code", 0)) != 0):
        raise ValueError("provider transaction is not a successful crossed-epoch system audit")
    provider = message["creator"]
    return dict(txhash=txhash, height=height, provider=provider, epoch=epoch,
                slot=next(slot for slot, address in providers.items() if address == provider),
                code=producer.uint(transaction.get("code", 0)), gas_wanted=transaction["gas_wanted"],
                gas_used=transaction["gas_used"])


def reconcile_cross_audit_sequences(before, after, providers, proof_transactions,
                                    audit_transactions, audit_views):
    """Bind signer sequence deltas to unique successful proof and audit transactions."""
    if set(before) != set(after) or set(before) != set(providers.values()):
        raise ValueError("provider sequence fence has the wrong signer set")
    proof_counts = {address: 0 for address in providers.values()}
    hashes = set()
    for row in proof_transactions:
        txhash, provider = row.get("txhash"), row.get("provider")
        if (not isinstance(txhash, str) or not re.fullmatch(r"[0-9A-F]{64}", txhash) or
                txhash in hashes or provider not in proof_counts or row.get("outcome") != "committed_success"):
            raise ValueError("proof transaction sequence inventory is not unique committed success")
        hashes.add(txhash)
        proof_counts[provider] += 1
    if (not isinstance(audit_views, dict) or len(audit_views) != V3_CROSS_AUDIT_EPOCHS or
            any(type(epoch) is not int for epoch in audit_views)):
        raise ValueError("crossed audit inventory must cover exactly two epochs")
    audit_counts = {address: 0 for address in providers.values()}
    audit_counts_by_epoch = {
        epoch: {address: 0 for address in providers.values()} for epoch in audit_views}
    audit_hashes = set()
    for row in audit_transactions:
        txhash, provider = row.get("txhash"), row.get("provider")
        epoch = producer.uint(row.get("epoch", 0))
        if (not isinstance(txhash, str) or not re.fullmatch(r"[0-9A-F]{64}", txhash) or
                txhash in hashes or txhash in audit_hashes or provider not in audit_counts or
                epoch not in audit_counts_by_epoch or producer.uint(row.get("code", 1)) != 0):
            raise ValueError("audit transaction sequence inventory is not unique committed success")
        audit_hashes.add(txhash)
        audit_counts[provider] += 1
        audit_counts_by_epoch[epoch][provider] += 1
    for slot, provider in providers.items():
        expected = 0
        for epoch, views in audit_views.items():
            view = views.get(slot) if isinstance(views, dict) else None
            if not isinstance(view, dict):
                raise ValueError("crossed audit inventory omits a provider")
            required = producer.uint(view.get("audit", {}).get("sample_count", ""))
            accepted = producer.uint(view.get("audit", {}).get("accepted_count", ""))
            if accepted != required:
                raise ValueError("crossed audit coverage is incomplete")
            if audit_counts_by_epoch[epoch][provider] != accepted:
                raise ValueError("crossed audit epoch bitmap does not equal unique committed audit transactions")
            expected += accepted
        if audit_counts[provider] != expected:
            raise ValueError("crossed audit bitmap does not equal unique committed audit transactions")
    rows = []
    for provider in providers.values():
        start, end = before[provider], after[provider]
        if start["account_number"] != end["account_number"]:
            raise ValueError("provider account number changed")
        actual = end["sequence"] - start["sequence"]
        expected = proof_counts[provider] + audit_counts[provider]
        if actual != expected:
            raise ValueError("provider sequence changed outside unique workload and audit transactions")
        rows.append(dict(provider=provider, before=start["sequence"], after=end["sequence"],
                         proof_transactions=proof_counts[provider], audit_transactions=audit_counts[provider],
                         expected_delta=expected, actual_delta=actual))
    return rows


def crossed_audit_events(results, height, providers, deal_id, expected_counts):
    """Extract only successful system-audit completion events from one committed block."""
    if producer.uint(results.get("height", 0)) != height:
        raise ValueError("cross-audit signal block result has the wrong height")
    responses = results.get("txs_results")
    responses = [] if responses is None else responses
    if not isinstance(responses, list) or len(responses) > 65536:
        raise ValueError("cross-audit signal has malformed transaction results")
    accepted = set()
    for response in responses:
        if not isinstance(response, dict) or producer.uint(response.get("code", 0)) != 0:
            continue
        events = response.get("events", [])
        if not isinstance(events, list) or len(events) > 4096:
            raise ValueError("cross-audit signal has malformed events")
        for event in events:
            if not isinstance(event, dict) or event.get("type") != "prove_liveness":
                continue
            attributes = event.get("attributes", [])
            if not isinstance(attributes, list) or len(attributes) > 64:
                raise ValueError("cross-audit signal has malformed attributes")
            pairs = []
            for attribute in attributes:
                if not isinstance(attribute, dict) or not isinstance(attribute.get("key"), str) or not isinstance(attribute.get("value"), str):
                    raise ValueError("cross-audit signal has malformed attributes")
                pairs.append((attribute["key"], attribute["value"]))
            if len(dict(pairs)) != len(pairs):
                raise ValueError("cross-audit signal repeats an event attribute")
            fields = dict(pairs)
            provider = fields.get("provider")
            if (fields.get("challenge_kind") != "2" or fields.get("deal_id") != str(deal_id) or
                    provider not in providers.values()):
                continue
            ordinal = producer.uint(fields.get("challenge_ordinal", ""))
            if ordinal >= expected_counts[provider]:
                raise ValueError("cross-audit signal reports an out-of-range ordinal")
            accepted.add((provider, ordinal))
    return accepted


def wait_for_crossed_audit_signal(lifecycle, providers, deal_id, expected_counts,
                                  epoch_length, expected_epoch, deadline_height):
    """Use each node-zero block result once as the cheap crossed-audit completion signal."""
    if (set(expected_counts) != set(providers.values()) or
            any(not isinstance(count, int) or count <= 0 for count in expected_counts.values())):
        raise ValueError("cross-audit signal expected counts do not match the providers")
    started = artifact.monotonic_ns()
    original_deadline = lifecycle.deadline
    deadline = min(original_deadline, started + 30 * 10**9)
    node = lifecycle.nodes[0]
    next_height = (expected_epoch - 1) * epoch_length + 1
    accepted, attempts = set(), []
    lifecycle.deadline = deadline
    try:
        while artifact.monotonic_ns() < deadline:
            status = lifecycle.query(node, "/status")
            if (status.get("node_info", {}).get("id") != node["node_id"] or
                    status.get("node_info", {}).get("network") != lifecycle.chain):
                raise ValueError("cross-audit signal RPC belongs to a different node or chain")
            latest = producer.uint(status.get("sync_info", {}).get("latest_block_height", 0))
            while next_height <= latest:
                if artifact.monotonic_ns() >= deadline:
                    raise TimeoutError("crossed audit event signal did not complete within 30 seconds")
                observed = (next_height - 1) // epoch_length + 1
                if observed > expected_epoch or next_height >= deadline_height - 10:
                    raise ValueError("cross-audit verification left its expected epoch/session margin")
                results = lifecycle.query(node, f"/block_results?height={next_height}")
                accepted.update(crossed_audit_events(
                    results, next_height, providers, deal_id, expected_counts))
                attempts.append(dict(height=next_height, accepted=len(accepted),
                                     required=sum(expected_counts.values())))
                if all(sum(1 for address, _ in accepted if address == provider) == required
                       for provider, required in expected_counts.items()):
                    fenced = lifecycle.wait_height(next_height)
                    return dict(height=fenced, signal_height=next_height,
                                signal_node_id=node["node_id"], accepted_events=len(accepted),
                                required_events=sum(expected_counts.values()), attempts=attempts)
                next_height += 1
            time.sleep(min(.2, lifecycle.remaining()))
        raise TimeoutError("crossed audit event signal did not complete within 30 seconds")
    finally:
        lifecycle.deadline = original_deadline


def open_cross_audit_measurement(lifecycle, target_height):
    """Capture the expensive metric boundary before the exact schedule-start fence."""
    capture_workload_metrics(lifecycle, "native_v3_cross_audit_before", fenced=True,
                             finalize_block=True)
    lifecycle.wait_height(target_height)
    before_cpu = validator_cpu_snapshot(lifecycle)
    scheduled_start_height = lifecycle.wait_height(1)
    if scheduled_start_height > target_height + 1:
        raise ValueError("cross-audit start moved beyond its fixed anchor alignment")
    return before_cpu, scheduled_start_height


def fence_v3_http_receipts(lifecycle):
    """Fence all validators to the provider RPC's committed tip after HTTP completion."""
    node = lifecycle.nodes[0]
    status = lifecycle.query(node, "/status")
    if (status.get("node_info", {}).get("id") != node["node_id"] or
            status.get("node_info", {}).get("network") != lifecycle.chain):
        raise ValueError("provider RPC status belongs to a different node or chain")
    observed = producer.uint(status.get("sync_info", {}).get("latest_block_height", 0))
    if observed < 1:
        raise ValueError("provider RPC status has no committed height")
    fenced = lifecycle.wait_height(observed)
    if fenced < observed:
        raise ValueError("all-validator proof receipt fence did not reach the provider RPC tip")
    return dict(provider_rpc_node_id=node["node_id"], provider_rpc_observed_height=observed,
                all_validator_height=fenced)


def validate_v3_http_receipt_fence(transactions, fence):
    """Bind decoded provider receipts to the post-HTTP committed-height cutoff."""
    if not transactions:
        raise ValueError("provider HTTP phase has no committed receipts")
    heights = [producer.uint(row.get("height", 0)) for row in transactions]
    maximum = max(heights)
    if min(heights) < 1 or maximum > producer.uint(fence.get("provider_rpc_observed_height", 0)):
        raise ValueError("provider HTTP receipt committed outside its fenced phase")
    return maximum


def validate_v3_cross_audit_span(transactions, scheduled_start_height, first_anchor, epoch_length):
    """Require measured proof commits on both sides of exactly two audit anchors."""
    heights = [producer.uint(row.get("height", 0)) for row in transactions]
    if not heights:
        raise ValueError("cross-audit profile has no measured proof commits")
    second_anchor = first_anchor + epoch_length
    if (min(heights) < scheduled_start_height or min(heights) > first_anchor or
            max(heights) < second_anchor or max(heights) >= second_anchor + epoch_length):
        raise ValueError("measured proof commits did not span exactly the two crossed audit anchors")
    return dict(first_height=min(heights), last_height=max(heights),
                first_anchor=first_anchor, second_anchor=second_anchor)


def close_cross_audit_measurement(lifecycle, audits, providers, deal_id, expected_counts,
                                  epoch_length, expected_epochs, deadline_height,
                                  before_cpu, measured_end_height):
    """Fence two audit executions in CPU, then validate state across all validators."""
    if len(expected_epochs) != V3_CROSS_AUDIT_EPOCHS:
        raise ValueError("cross-audit measurement requires exactly two epochs")
    crossed = [wait_for_crossed_audit_signal(
        lifecycle, providers, deal_id, expected_counts, epoch_length, epoch, deadline_height)
        for epoch in expected_epochs]
    after_cpu = validator_cpu_snapshot(lifecycle)
    audit_views = {}
    for epoch, signal in zip(expected_epochs, crossed):
        views = audits(signal["height"], False, epoch)
        if set(views) != set(providers):
            raise ValueError("crossed audit state does not cover every provider slot")
        for slot, view in views.items():
            provider = providers[slot]
            if (producer.uint(view["audit"].get("sample_count", 0)) != expected_counts[provider] or
                    producer.uint(view["audit"].get("accepted_count", 0)) != expected_counts[provider]):
                raise ValueError("crossed audit state is incomplete after its event signal")
        signal["audits"] = views
        audit_views[epoch] = views
    capture_workload_metrics(lifecycle, "native_v3_cross_audit_after", fenced=True,
                             finalize_block=True)
    lifecycle.doc["native_v3_cross_audit"]["measured_window"] = dict(
        monotonic_start_ns=before_cpu["monotonic_ns"],
        monotonic_end_ns=after_cpu["monotonic_ns"],
        elapsed_ns=after_cpu["monotonic_ns"] - before_cpu["monotonic_ns"],
        proof_phase_end_height=measured_end_height,
        crossed_audit_completion_heights=[row["height"] for row in crossed],
        validator_cpu_before=before_cpu,
        validator_cpu_after=after_cpu,
        validator_cpu_delta=validator_cpu_delta(before_cpu, after_cpu),
        scope=("fixed HTTP offer, bounded drain, and two crossed-audit completions; includes proof generation, "
               "local verification, gas simulation, signing, broadcast, bounded node-zero event observation, "
               "and the all-validator height fence; excludes the later four-validator LCD audit-state validation; "
               "no RSS phase peak"))
    return crossed, audit_views


def freeze_cross_audit_post_load(lifecycle, audits, providers, ready_epoch, expected_epochs,
                                 epoch_length, crossed_views):
    """Freeze quiescent two-epoch state before slow historical receipt decoding."""
    post_quiescence = require_provider_quiescence(lifecycle, providers)
    final_height = post_quiescence["second_height"]
    if (final_height - 1) // epoch_length + 1 != ready_epoch + V3_CROSS_AUDIT_EPOCHS:
        raise ValueError("cross-audit profile did not cross exactly two epochs")
    final_views = {}
    for epoch in expected_epochs:
        views = audits(final_height, False, epoch)
        if views != crossed_views[epoch]:
            raise ValueError("crossed audit evidence changed after provider quiescence")
        final_views[epoch] = views
    evidence = dict(height=final_height, provider_quiescence=post_quiescence,
                    audits=final_views)
    lifecycle.doc["native_v3_cross_audit"]["post_load_fence"] = evidence
    lifecycle.save()
    return post_quiescence, final_height, final_views


def run_native_v3_cross_audit(lifecycle, *, deal, providers, send, wait, curl, audits,
                              epoch_length, command):
    """Fixed provider-route operating point spanning exactly two normal audit anchors."""
    doc = lifecycle.doc["native_v3_cross_audit"] = dict(qualification=False)
    owner = lifecycle.signers["owner0"]
    opened_at = lifecycle.wait_height(3)
    deadline_height = opened_at + 300
    if deadline_height >= producer.uint(deal["end_block"]):
        raise ValueError("cross-audit sessions reach the deal end")
    root = producer.b64(deal["manifest_root"], 32).hex()
    integrity = lifecycle.doc["native_v3_generation"]["candidate"]["integrity_root"][2:]
    paths = []
    for nonce in range(1, V3_CROSS_AUDIT_SESSIONS + 1):
        path = lifecycle.home / f"native-cross-audit-open-{nonce}.json"
        with path.open("x") as output:
            json.dump(dict(creator=owner, deal_id=str(deal["id"]), generation="1",
                range=dict(file_record_index=0, file_start_offset="0", file_length=str(V3_PILOT_BYTES),
                           range_start="0", range_length=str(V3_PILOT_BYTES)), nonce=str(nonce),
                deadline_height=str(deadline_height)), output, separators=(",", ":"))
        paths.append(path)
    sessions = doc["sessions"] = []
    for batch_index, begin in enumerate(range(0, len(paths), V3_CROSS_AUDIT_OPEN_BATCH_MAX)):
        batch_paths = paths[begin:begin + V3_CROSS_AUDIT_OPEN_BATCH_MAX]
        ids, height = open_v3_session_batch(
            lifecycle, batch_paths, lifecycle.home / f"native-cross-audit-open-batch-{batch_index}", command)
        evidence = lifecycle.doc["native_v3_open_batches"][-1]
        for offset, session_id in enumerate(ids):
            sessions.append(dict(session_id=session_id, nonce=begin + offset + 1,
                                 open_batch_index=batch_index, open_height=height,
                                 open_transaction=evidence["transaction"]))
    if [row["nonce"] for row in sessions] != list(range(1, V3_CROSS_AUDIT_SESSIONS + 1)):
        raise ValueError("native v3 batch responses differ from ordered session intents")
    evidence_height = wait(max(row["open_height"] for row in sessions) + 2)
    for row in sessions:
        view = v3_session_query(lifecycle, row["session_id"], evidence_height)
        _, accepted = validate_v3_session(view, session_id=row["session_id"], deal_id=deal["id"],
            owner=owner, providers=providers, nonce=row["nonce"], polyfs_root=root,
            integrity_root=integrity, chain_id=lifecycle.chain, deadline_height=deadline_height)
        if accepted:
            raise ValueError("cross-audit session starts with accepted samples")
        row["before_proofs"] = view
    warmup_requests = [dict(id=f"warmup-{slot}", provider=providers[slot],
        url=provider_http_url(lifecycle, providers[slot], "/sp/session-proof"),
        body=dict(session_id=sessions[0]["session_id"]), timeout_seconds=30)
        for slot in range(V3_SYSTEMATIC_PROVIDERS)]
    warmup_outcomes = run_v3_http_phase(lifecycle, curl, warmup_requests, "cross-audit-warmup",
        max_in_flight=V3_SYSTEMATIC_PROVIDERS, retry_pre_admission_busy=True)
    validate_v3_provider_outcomes(warmup_outcomes, providers, session_id=sessions[0]["session_id"])
    warmup_transactions = []
    for outcome in warmup_outcomes:
        tx = committed_v3_http_tx(lifecycle, outcome, kind="session-proof", creator=outcome["provider"],
            slot=producer.uint(outcome["slot"]), session_id=sessions[0]["session_id"],
            proof_count=producer.uint(outcome["proof_count"]))
        tx.update(provider=outcome["provider"], operation_id=outcome["request_id"])
        if tx["outcome"] != "committed_success":
            raise ValueError("warmup provider reported success for a failed proof transaction")
        warmup_transactions.append(tx)
    warmup_height = max(row["height"] for row in warmup_transactions)
    wait(warmup_height + 1)
    warmup_view = v3_session_query(lifecycle, sessions[0]["session_id"], warmup_height)
    _, warmup_accepted = validate_v3_session(warmup_view, session_id=sessions[0]["session_id"],
        deal_id=deal["id"], owner=owner, providers=providers, nonce=1, polyfs_root=root,
        integrity_root=integrity, chain_id=lifecycle.chain, deadline_height=deadline_height)
    if warmup_accepted != sorted(ordinal for row in warmup_transactions for ordinal in row["ordinals"]):
        raise ValueError("warmup bitmap differs from committed proof messages")
    doc["warmup_proof_transactions"] = warmup_transactions
    doc["warmup_provider_phase_timing"] = validate_v3_provider_phase_timings(
        warmup_outcomes, warmup_transactions)
    lifecycle.save()

    current = lifecycle.wait_height(1)
    ready_epoch = (current - 1) // epoch_length + 1
    next_anchor = ready_epoch * epoch_length + 1
    target_height = next_anchor - 10
    if target_height - current < 4 or deadline_height - (target_height + epoch_length + 30) < 40:
        raise ValueError("cross-audit profile lacks alignment or session deadline margin")
    quiescence = require_provider_quiescence(lifecycle, providers)
    ready_height = quiescence["second_height"]
    current_audits = audits(ready_height, False, ready_epoch)
    if any(producer.uint(row["audit"].get("accepted_count", 0)) != producer.uint(row["audit"]["sample_count"])
           for row in current_audits.values()):
        raise ValueError("current audit coverage is incomplete before cross-audit load")
    for row in sessions[1:]:
        if v3_session_query(lifecycle, row["session_id"], ready_height) != row["before_proofs"]:
            raise ValueError("prepared cross-audit session changed before timing")
    if lifecycle.wait_height(1) > target_height:
        raise ValueError("cross-audit preflight missed its fixed start alignment")
    schedule = native_v3_cross_audit_schedule()
    requests = []
    for item in schedule:
        session = sessions[item["session_index"]]
        requests.append(dict(item, provider=providers[item["slot"]],
            url=provider_http_url(lifecycle, providers[item["slot"]], "/sp/session-proof"),
            body=dict(session_id=session["session_id"])))

    collectors = []
    completed_measurement = False
    try:
        start_commit_streams(lifecycle, 720, collectors,
                             stream_key="native_v3_cross_audit_commit_streams",
                             filename_prefix="native-v3-cross-audit-commit")
        before_cpu, scheduled_start_height = open_cross_audit_measurement(lifecycle, target_height)
        doc["measurement_preconditions"] = dict(evidence_height=evidence_height, ready_height=ready_height,
            ready_epoch=ready_epoch, next_anchor=next_anchor, target_height=target_height,
            scheduled_start_height=scheduled_start_height, session_deadline=deadline_height,
            audits=current_audits, provider_quiescence=quiescence)
        outcomes = run_v3_http_schedule(lifecycle, curl, requests, "cross-audit-measured")
        schedule_start = lifecycle.doc["v3_http_schedules"]["cross-audit-measured"]["monotonic_start_ns"]
        doc["schedule_bins"] = v3_http_schedule_bins(requests, outcomes, start_ns=schedule_start)
        receipt_fence = doc["proof_receipt_fence"] = fence_v3_http_receipts(lifecycle)
        measured_end_height = receipt_fence["provider_rpc_observed_height"]
        expected_audit_counts = {providers[slot]: producer.uint(view["audit"]["sample_count"])
                                 for slot, view in current_audits.items()}
        expected_epochs = [ready_epoch + offset for offset in range(1, V3_CROSS_AUDIT_EPOCHS + 1)]
        crossed, crossed_views = close_cross_audit_measurement(
            lifecycle, audits, providers, deal["id"], expected_audit_counts, epoch_length,
            expected_epochs, deadline_height, before_cpu, measured_end_height)
        completed_measurement = True
    finally:
        artifact.stop_owned_process_groups(collectors)
    if not completed_measurement:
        raise ValueError("cross-audit measurement did not close")
    summarize_commit_streams(lifecycle, collectors,
        stream_key="native_v3_cross_audit_commit_streams",
        before_phase="native_v3_cross_audit_before", after_phase="native_v3_cross_audit_after")

    # Freeze the post-load state before the historical per-receipt queries below. Those
    # queries are intentionally outside the measured window, but 360 CLI/RPC lookups can
    # take long enough for another audit anchor to pass at the live tip.
    post_quiescence, final_height, final_views = freeze_cross_audit_post_load(
        lifecycle, audits, providers, ready_epoch, expected_epochs, epoch_length, crossed_views)

    grouped = {index: [] for index in range(1, V3_CROSS_AUDIT_SESSIONS)}
    for outcome in outcomes:
        grouped[schedule[outcome["request_index"]]["session_index"]].append(outcome)
    transactions = doc["measured_proof_transactions"] = []
    for session_index, session_outcomes in grouped.items():
        session = sessions[session_index]
        validate_v3_provider_outcomes(session_outcomes, providers, session_id=session["session_id"])
        for outcome in session_outcomes:
            tx = committed_v3_http_tx(lifecycle, outcome, kind="session-proof",
                creator=outcome["provider"], slot=producer.uint(outcome["slot"]),
                session_id=session["session_id"], proof_count=producer.uint(outcome["proof_count"]))
            tx.update(provider=outcome["provider"], operation_id=outcome["request_id"],
                      session_index=session_index)
            if tx["outcome"] != "committed_success":
                raise ValueError("measured provider outcome is not a committed in-window success")
            transactions.append(tx)
        lifecycle.save()
    if len(transactions) != V3_CROSS_AUDIT_MEASURED:
        raise ValueError("measured provider phase omitted a proof transaction")
    doc["provider_phase_timing"] = validate_v3_provider_phase_timings(outcomes, transactions)
    doc["proof_anchor_span"] = validate_v3_cross_audit_span(
        transactions, scheduled_start_height, next_anchor, epoch_length)
    doc["measured_window"]["proof_receipt_max_height"] = validate_v3_http_receipt_fence(
        transactions, receipt_fence)
    lifecycle.save()

    before_metrics = lifecycle.doc["commit_step_metrics"]["phases"]["native_v3_cross_audit_before"]
    first_height = min(row["sample"]["committed_height"] for row in before_metrics["nodes"]) + 1
    proof_hashes = {row["txhash"].upper() for row in transactions}
    audit_transactions = []
    def observe_transaction(transaction, height):
        if transaction["txhash"].upper() in proof_hashes:
            return
        row = classify_cross_audit_transaction(
            lifecycle, transaction, height, providers, deal["id"], expected_epochs)
        if row is not None:
            audit_transactions.append(row)
    reconcile_transaction_blocks(lifecycle, transactions, first_height, final_height,
        lifecycle.home / "native-v3-cross-audit-blocks.jsonl", observe_transaction=observe_transaction)
    completion_heights = {epoch: signal["height"] for epoch, signal in zip(expected_epochs, crossed)}
    if any(row["height"] > completion_heights[row["epoch"]] for row in audit_transactions):
        raise ValueError("crossed audit transaction committed after its CPU measurement fence")
    final_sequences = provider_sequences(lifecycle, providers, final_height)
    doc["audit_transactions"] = audit_transactions
    doc["provider_sequence_reconciliation"] = reconcile_cross_audit_sequences(
        quiescence["sequences"], final_sequences, providers, transactions,
        audit_transactions, final_views)
    for index, row in enumerate(sessions):
        state = v3_session_query(lifecycle, row["session_id"], final_height)
        _, accepted = validate_v3_session(state, session_id=row["session_id"], deal_id=deal["id"],
            owner=owner, providers=providers, nonce=row["nonce"], polyfs_root=root,
            integrity_root=integrity, chain_id=lifecycle.chain, deadline_height=deadline_height)
        source = warmup_transactions if index == 0 else [tx for tx in transactions if tx["session_index"] == index]
        expected = sorted(ordinal for tx in source for ordinal in tx["ordinals"])
        if accepted != expected or len(accepted) != V3_MAX_SAMPLES:
            raise ValueError("authoritative session bitmap differs from committed proof messages")
        row.update(after_proofs=state, accepted_sample_ordinals=accepted, proof_transactions=source)
    doc.update(offered_proof_transactions=V3_CROSS_AUDIT_WARMUPS + V3_CROSS_AUDIT_MEASURED,
        warmup_transactions=V3_CROSS_AUDIT_WARMUPS, measured_offered_transactions=V3_CROSS_AUDIT_MEASURED,
        total_committed_valid_proof_transactions=len(warmup_transactions) + len(transactions),
        measured_committed_valid_proof_transactions=len(transactions),
        total_authoritative_new_sample_ordinals=sum(len(row["accepted_sample_ordinals"]) for row in sessions),
        measured_authoritative_new_sample_ordinals=sum(len(row["accepted_sample_ordinals"]) for row in sessions[1:]),
        crossed_audit_epochs=expected_epochs, crossed_audits=final_views,
        measured_gas_wanted=sum(row["gas_wanted"] for row in transactions),
        measured_gas_used=sum(row["gas_used"] for row in transactions),
        delivery_verified=False, owner_acknowledged=False, qualification=False)
    wait(deadline_height + 2)
    for row in sessions:
        expired = v3_session_query(lifecycle, row["session_id"])
        validate_v3_session(expired, session_id=row["session_id"], deal_id=deal["id"], owner=owner,
            providers=providers, nonce=row["nonce"], polyfs_root=root, integrity_root=integrity,
            chain_id=lifecycle.chain, deadline_height=deadline_height, expired=True)
        refund = send("owner0", ["retrieval-session-v3", "refund",
                                  str(_write_v3_refund(lifecycle, owner, row["session_id"]))])
        verify_v3_refund_transaction(lifecycle, refund, owner=owner, session_id=row["session_id"])
        row.update(expired_before_refund=expired, refund_transaction=refund)
        lifecycle.save()
    wait(max(row["refund_transaction"]["height"] for row in sessions) + 1)
    for row in sessions:
        after = v3_session_query(lifecycle, row["session_id"])
        validate_v3_session(after, session_id=row["session_id"], deal_id=deal["id"], owner=owner,
            providers=providers, nonce=row["nonce"], polyfs_root=root, integrity_root=integrity,
            chain_id=lifecycle.chain, deadline_height=deadline_height, expired=True, refunded=True)
        row["after_refund"] = after
    doc.update(status="native_v3_cross_audit_diagnostic_finished", expiration_verified=True,
               refunds_verified=True, qualification=False)
    lifecycle.save()

def _write_v3_refund(lifecycle, owner, session_id):
    path = lifecycle.home / ("v3-refund-" + session_id + ".json")
    with path.open("x") as output:
        json.dump(dict(creator=owner, session_id=base64.b64encode(bytes.fromhex(session_id)).decode()),
                  output, separators=(",", ":"))
    return path


def provider_sequences(lifecycle, providers, height):
    rows = {}
    for address in providers.values():
        values = []
        for node in lifecycle.nodes:
            response = lifecycle.query(node, "/cosmos/auth/v1beta1/accounts/" + address, height)
            account = response.get("account", {})
            while isinstance(account, dict) and isinstance(account.get("base_account"), dict):
                account = account["base_account"]
            if account.get("address") != address:
                raise ValueError("provider account query returned another signer")
            values.append((producer.uint(account.get("account_number", "")),
                           producer.uint(account.get("sequence", ""))))
        if any(value != values[0] for value in values[1:]):
            raise ValueError("four validators disagree on provider sequence")
        rows[address] = dict(account_number=values[0][0], sequence=values[0][1])
    return rows


def require_provider_quiescence(lifecycle, providers):
    first = lifecycle.wait_height(1)
    before = provider_sequences(lifecycle, providers, first)
    second = lifecycle.wait_height(first + 2)
    after = provider_sequences(lifecycle, providers, second)
    if before != after:
        raise ValueError("provider sequences changed during two-block quiescence fence")
    return dict(first_height=first, second_height=second, sequences=after)


def await_native_v3_capacity_window(lifecycle, wait, audits, epoch_length,
                                    required_margin, deadline_height):
    """Wait for complete normal audits with enough blocks left in the epoch."""
    if required_margin > epoch_length - 2:
        raise ValueError("native chain capacity margin cannot fit within one audit epoch")
    while True:
        height = lifecycle.wait_height(1)
        epoch = (height - 1) // epoch_length + 1
        next_anchor = epoch * epoch_length + 1
        if deadline_height - height < required_margin:
            raise ValueError("native chain capacity sessions lack their required measurement margin")
        if next_anchor - height < required_margin:
            wait(next_anchor + 2)
            continue
        try:
            views = audits(height, False, epoch)
        except ValueError as error:
            if str(error) != "missing or duplicate all-slot audit evidence":
                raise
            wait(height + 1)
            continue
        if any(producer.uint(row["audit"].get("accepted_count", 0)) !=
               producer.uint(row["audit"].get("sample_count", 0)) for row in views.values()):
            wait(height + 1)
            continue
        return dict(height=height, epoch=epoch, next_anchor=next_anchor, audits=views)


def v3_generate_only_gas(lifecycle, message_path, provider, *, action="prove",
                         message_type=V3_SINGLE_PROOF_TYPE, gas_adjustment="1.6",
                         max_gas=64_000_000):
    if gas_adjustment not in V3_CHAIN_GAS_ADJUSTMENTS:
        raise ValueError("native v3 gas adjustment is outside the benchmark matrix")
    message_path = Path(message_path)
    source_raw = message_path.read_bytes()
    if len(source_raw) > 8 * 1024 * 1024:
        raise ValueError("exported v3 message exceeds bound")
    source = json.loads(source_raw)
    aliases = [name for name, address in lifecycle.signers.items() if address == provider]
    if len(aliases) != 1:
        raise ValueError("provider address does not identify exactly one simulation key")
    job = transaction_job(lifecycle, provider,
        ["retrieval-session-v3", action, str(message_path)], kind="submit-proof", gas="auto")
    argv = [*job["submit"], "--generate-only"]
    argv[argv.index("--from") + 1] = aliases[0]
    argv[argv.index("--gas-adjustment") + 1] = gas_adjustment
    deadline = min(lifecycle.deadline, artifact.monotonic_ns() + 60 * 10**9)
    attempts = []
    for attempt in range(3):
        result = artifact.run_bounded_command(argv, deadline,
            env={key: lifecycle.env[key] for key in ENV_KEYS if key in lifecycle.env})
        attempts.append(result)
        if (not result.returncode or "account sequence mismatch" not in result.stderr or attempt == 2 or
                artifact.monotonic_ns() + 10**9 >= deadline):
            break
        time.sleep(1)
    stdout, stderr = result.stdout.encode(), result.stderr.encode()
    diagnostic = message_path.with_name(message_path.name + ".gas-simulation.json")
    with diagnostic.open("x") as output:
        json.dump(dict(message_path=str(message_path), provider=provider, simulation_key=aliases[0], command=argv,
            returncode=result.returncode, attempts=len(attempts), stdout_bytes=len(stdout), stderr_bytes=len(stderr),
            stdout_sha256=hashlib.sha256(stdout).hexdigest(), stderr_sha256=hashlib.sha256(stderr).hexdigest(),
            stdout_tail=stdout[-8192:].decode("utf-8", errors="replace"),
            stderr_tail=stderr[-8192:].decode("utf-8", errors="replace")), output, separators=(",", ":"))
    if result.returncode or len(stdout) > 8 * 1024 * 1024:
        raise ValueError("bounded v3 gas simulation failed")
    unsigned = json.loads(result.stdout)
    messages = unsigned.get("body", {}).get("messages", [])
    if len(messages) != 1 or messages[0].get("@type") != message_type:
        raise ValueError("generated transaction has the wrong message type/count")
    actual = dict(messages[0])
    actual.pop("@type")
    if actual != source:
        raise ValueError("gas simulation message differs from exported proof request")
    gas = producer.uint(unsigned.get("auth_info", {}).get("fee", {}).get("gas_limit", ""))
    if not 1 <= gas <= artifact.integer(max_gas, "chain diagnostic gas bound", 1, 448_000_000):
        raise ValueError("simulated v3 gas exceeds chain diagnostic bound")
    unsigned_path = message_path.with_name(message_path.name + ".unsigned.json")
    unsigned_path.write_text(json.dumps(unsigned, separators=(",", ":")) + "\n")
    job = transaction_job(lifecycle, provider,
        ["retrieval-session-v3", action, str(message_path)], kind="submit-proof", gas=str(gas))
    return job, dict(message_sha256=hashlib.sha256(source_raw).hexdigest(), gas_limit=gas,
                     simulation_attempts=len(attempts),
                     simulation_stdout_sha256=hashlib.sha256(stdout).hexdigest(),
                     simulation_diagnostic=str(diagnostic), unsigned_path=str(unsigned_path),
                     unsigned_sha256=artifact.sha256(unsigned_path))


def v3_simulate_serial_outer_gas(lifecycle, intent, gas_adjustment="1.6", max_gas=64_000_000):
    """Simulate the fully assembled existing-message comparator transaction."""
    if gas_adjustment not in V3_CHAIN_GAS_ADJUSTMENTS:
        raise ValueError("native v3 gas adjustment is outside the benchmark matrix")
    provider = intent["provider"]
    aliases = [name for name, address in lifecycle.signers.items() if address == provider]
    if len(aliases) != 1:
        raise ValueError("provider address does not identify exactly one simulation key")
    messages = []
    member_sha256 = []
    for member in intent["members"]:
        source_path = Path(member["message_path"])
        source_raw = source_path.read_bytes()
        if len(source_raw) > 8 * 1024 * 1024:
            raise ValueError("serial comparator member exceeds transaction diagnostic bound")
        if hashlib.sha256(source_raw).hexdigest() != member["message_sha256"]:
            raise ValueError("serial comparator member changed before outer simulation")
        source = json.loads(source_raw)
        if source.get("creator") != provider or "@type" in source:
            raise ValueError("serial comparator transaction crosses provider authority")
        messages.append(dict({"@type": V3_SINGLE_PROOF_TYPE}, **source))
        member_sha256.append(member["message_sha256"])
    unsigned = {
        "body": {"messages": messages, "memo": "", "timeout_height": "0",
                 "extension_options": [], "non_critical_extension_options": []},
        "auth_info": {"signer_infos": [], "fee": {"amount": [], "gas_limit": "0",
                                                    "payer": "", "granter": ""}, "tip": None},
        "signatures": [],
    }
    unsigned_path = lifecycle.home / "native-v3-chain-frozen" / f"{intent['id']}.unsigned.json"
    unsigned_path.parent.mkdir(mode=0o700, exist_ok=True)
    unsigned_path.write_text(json.dumps(unsigned, separators=(",", ":")) + "\n")
    node = lifecycle.nodes[0]
    argv = [str(lifecycle.binary), "tx", "simulate", str(unsigned_path),
        "--from", aliases[0], "--home", node["home"], "--keyring-backend", "test",
        "--chain-id", lifecycle.chain, "--node", f'http://127.0.0.1:{node["rpc"]}',
        "--gas", "auto", "--gas-adjustment", gas_adjustment, "--output", "json"]
    deadline = min(lifecycle.deadline, artifact.monotonic_ns() + 60 * 10**9)
    result = artifact.run_bounded_command(argv, deadline,
        env={key: lifecycle.env[key] for key in ENV_KEYS if key in lifecycle.env})
    diagnostic = unsigned_path.with_name(unsigned_path.name + ".gas-simulation.json")
    stdout, stderr = result.stdout.encode(), result.stderr.encode()
    diagnostic.write_text(json.dumps(dict(command=argv, returncode=result.returncode,
        member_sha256=member_sha256, unsigned_sha256=artifact.sha256(unsigned_path),
        stdout_bytes=len(stdout), stderr_bytes=len(stderr),
        stdout_sha256=hashlib.sha256(stdout).hexdigest(), stderr_sha256=hashlib.sha256(stderr).hexdigest(),
        stdout_tail=stdout[-8192:].decode("utf-8", errors="replace"),
        stderr_tail=stderr[-8192:].decode("utf-8", errors="replace")), separators=(",", ":")) + "\n")
    if result.returncode or len(stdout) > 8 * 1024 * 1024:
        raise ValueError("bounded serial outer-transaction gas simulation failed")
    try:
        gas_used = producer.uint(json.loads(result.stdout)["gas_info"]["gas_used"])
    except (KeyError, TypeError, json.JSONDecodeError, ValueError) as error:
        raise ValueError("serial outer-transaction gas simulation returned malformed gas") from error
    gas_limit = int(float(gas_adjustment) * gas_used)
    if not 1 <= gas_limit <= artifact.integer(max_gas, "chain diagnostic gas bound", 1, 448_000_000):
        raise ValueError("simulated serial outer-transaction gas exceeds chain diagnostic bound")
    unsigned["auth_info"]["fee"].update(
        gas_limit=str(gas_limit),
        amount=[{"denom": "aatom", "amount": str((gas_limit + 999) // 1000)}])
    unsigned_path.write_text(json.dumps(unsigned, separators=(",", ":")) + "\n")
    return dict(member_message_sha256=member_sha256, gas_limit=gas_limit, simulation_attempts=1,
                simulation_stdout_sha256=hashlib.sha256(stdout).hexdigest(),
                simulation_diagnostic=str(diagnostic), unsigned_path=str(unsigned_path),
                unsigned_sha256=artifact.sha256(unsigned_path), gas_used=gas_used)


def export_native_v3_chain_inventory(lifecycle, exporter, sessions, providers, directories):
    inventory = lifecycle.home / "native-v3-chain-inventory"
    inventory.mkdir(mode=0o700)
    deadline_ms = int(time.time() * 1000 + (lifecycle.deadline - artifact.monotonic_ns()) / 1e6)
    manifests = []
    for slot in range(V3_SYSTEMATIC_PROVIDERS):
        provider = providers[slot]
        directory = Path(directories[provider])
        requests = []
        for index, session in enumerate(sessions):
            slots = [producer.uint(row.get("slot", 99))
                     for row in session.get("before_proofs", {}).get("session", {}).get("obligations", [])]
            if slot not in slots:
                continue
            requests.append(dict(session_id=session["session_id"], height=session["evidence_height"],
                view=session["before_proofs"], session_index=index,
                output_path=str(inventory / f"provider-{slot}-session-{index}.json")))
        batches = []
        for batch_index, offset in enumerate(range(0, len(requests), V3_EXPORT_BATCH_MAX)):
            batch = requests[offset:offset + V3_EXPORT_BATCH_MAX]
            manifest = inventory / f"provider-{slot}-batch-{batch_index}.manifest.json"
            manifest.write_text(json.dumps(dict(chain_id=lifecycle.chain,
                trusted_setup=lifecycle.env["POLYSTORE_TRUSTED_SETUP"], deadline_unix_ms=deadline_ms,
                v3_provider=provider, v3_artifact_directory=str(directory),
                v3_sessions=[{key: value for key, value in request.items() if key != "session_index"}
                             for request in batch]), separators=(",", ":")))
            batches.append((manifest, batch))
        manifests.append((slot, batches))
    def run_one(item):
        slot, batches = item
        requests, rows = [], []
        for manifest, batch in batches:
            env = dict(lifecycle.env, POLYSTORE_RETRIEVAL_EXPORT_MANIFEST=str(manifest))
            result = artifact.run_bounded_command([str(exporter), "-test.run=^TestExportFrozenRetrievalInventory$", "-test.timeout=600s"],
                                                  lifecycle.deadline, env=env)
            manifest.with_suffix(".log").write_text(result.stdout + result.stderr)
            if result.returncode:
                raise ValueError(f"provider {slot} v3 inventory export failed")
            exported = json.loads(Path(str(manifest) + ".result.json").read_text()).get("messages")
            if not isinstance(exported, list) or len(exported) != len(batch):
                raise ValueError("v3 exporter returned incomplete provider batch")
            requests.extend(batch)
            rows.extend(exported)
        return slot, requests, rows
    exported, exported_requests = {}, {}
    with ThreadPoolExecutor(max_workers=V3_SYSTEMATIC_PROVIDERS) as pool:
        futures = [pool.submit(run_one, item) for item in manifests]
        for future in futures:
            slot, requests, rows = future.result()
            expected = sum(slot in [producer.uint(obligation.get("slot", 99))
                                    for obligation in session["before_proofs"]["session"]["obligations"]]
                           for session in sessions)
            if not isinstance(rows, list) or len(rows) != expected:
                raise ValueError("v3 exporter returned incomplete provider inventory")
            exported[slot] = rows
            exported_requests[slot] = requests
    by_session = {(slot, producer.uint(request["session_index"])): row
                  for slot, rows in exported.items()
                  for request, row in zip(exported_requests[slot], rows)}
    ordered = []
    for session_index, session in enumerate(sessions):
        slots = [producer.uint(row.get("slot", 99))
                 for row in session["before_proofs"]["session"]["obligations"]]
        for slot in slots:
            row = by_session[(slot, session_index)]
            provider = providers[slot]
            raw = Path(row["message_path"]).read_bytes()
            message = json.loads(raw)
            if (row.get("session_id") != session["session_id"] or row.get("slot") != slot or
                    row.get("context_hash") != session["context_hash"] or
                    row.get("seed") != session["seed"] or row.get("message_sha256") != hashlib.sha256(raw).hexdigest() or
                    message.get("creator") != provider or producer.b64(message.get("session_id", ""), 32).hex() != session["session_id"] or
                    producer.uint(message.get("slot", 0)) != slot or
                    [producer.uint(proof.get("ordinal", V3_MAX_SAMPLES)) for proof in message.get("proofs", [])] != row.get("ordinals")):
                raise ValueError("v3 exporter changed frozen message/context/provider intent")
            for proof_index, sample in enumerate(message.get("proofs", [])):
                chained = sample.get("proof", {})
                for field in ("manifest_opening", "root_table_du_commitment",
                              "blob_commitment", "kzg_opening_proof"):
                    value = producer.b64(chained.get(field, ""), 48)
                    if value in (bytes(48), b"\xc0" + bytes(47)):
                        raise ValueError(
                            f"v3 exported proof {proof_index} has identity {field}")
            ordered.append(dict(row, session_index=session_index, provider=provider))
    return dict(directory=str(inventory),
                manifests=[str(manifest) for _, batches in manifests for manifest, _ in batches],
                messages=ordered)


def build_native_v3_transaction_intents(messages, profile, directory):
    """Group one frozen provider-local proof corpus into comparable transaction intents."""
    mode, batch_size = profile["submission_mode"], profile["batch_size"]
    selected = [row for row in messages if row["profile"] == profile["name"]]
    grouped = {}
    for row in selected:
        grouped.setdefault((row["slot"], row["provider"]), []).append(row)
    intents = []
    directory = Path(directory)
    directory.mkdir(mode=0o700, exist_ok=True)
    for (slot, provider), rows in sorted(grouped.items()):
        rows.sort(key=lambda row: row["session_index"])
        if len(rows) % batch_size:
            raise ValueError("provider proof corpus does not form exact local batches")
        for offset in range(0, len(rows), batch_size):
            members = rows[offset:offset + batch_size]
            if any(row["slot"] != slot or row["provider"] != provider for row in members):
                raise ValueError("proof transaction crosses provider authority")
            intent = dict(id=f"v3-chain-{mode}-{slot}-{offset // batch_size}",
                profile=profile["name"], submission_mode=mode, batch_size=batch_size,
                slot=slot, provider=provider, members=members)
            if mode == "batch-message":
                sessions = []
                for member in members:
                    message = json.loads(Path(member["message_path"]).read_text())
                    if message.get("creator") != provider or producer.uint(message.get("slot", 99)) != slot:
                        raise ValueError("batch member differs from frozen provider-local intent")
                    sessions.append(dict(session_id=message["session_id"], slot=message["slot"],
                                         proofs=message["proofs"]))
                path = directory / f"batch-{slot}-{offset // batch_size}.json"
                path.write_text(json.dumps(dict(creator=provider, sessions=sessions), separators=(",", ":")) + "\n")
                intent["message_path"] = str(path)
            intents.append(intent)
    expected = len(selected) // batch_size
    if len(intents) != expected or sum(len(row["members"]) for row in intents) != len(selected):
        raise ValueError("transaction intents differ from the frozen proof corpus")
    return intents


def verify_native_v3_chain_transactions(lifecycle, rows, messages):
    expected = {row["id"]: row for row in messages}
    verified = []
    for result in rows:
        if result.get("outcome") != "committed_success" or result["id"] not in expected:
            raise ValueError("native v3 chain submission was rejected or ambiguous")
        result["validators"] = verify_transaction_nodes(lifecycle, result)
        decoded = json.loads(lifecycle.cli(lifecycle.nodes[0]["home"], "query", "tx", result["txhash"], "--output", "json"))
        committed = decoded.get("tx", {}).get("body", {}).get("messages", [])
        raw = json.loads(Path(expected[result["id"]]["message_path"]).read_text())
        if len(committed) != 1 or committed[0].get("@type") != "/polystorechain.polystorechain.v1.MsgSubmitRetrievalSessionProofV3":
            raise ValueError("native v3 chain transaction has the wrong committed message")
        actual = dict(committed[0])
        actual.pop("@type")
        if actual != raw:
            raise ValueError("committed native v3 proof differs from prepared message")
        verified.append(result)
    if len({row["txhash"] for row in verified}) != len(verified):
        raise ValueError("native v3 chain workload repeated a committed transaction")
    return verified


def native_v3_chain_committed_summary(sessions, messages, warmup_rows, measured_rows):
    """Separate authoritative totals from the measured committed subset."""
    warmup_ids = {row["id"] for row in warmup_rows}
    measured_ids = {row["id"] for row in measured_rows}
    if (len(warmup_ids) != len(warmup_rows) or len(measured_ids) != len(measured_rows) or
            warmup_ids & measured_ids):
        raise ValueError("native v3 chain committed transaction identities are inconsistent")
    message_ids = {row["id"] for row in messages}
    if len(message_ids) != len(messages) or message_ids != warmup_ids | measured_ids:
        raise ValueError("native v3 chain messages differ from committed transaction inventory")
    total_ordinals = measured_ordinals = 0
    for index, session in enumerate(sessions):
        accepted = session["accepted_sample_ordinals"]
        expected = sorted(ordinal for row in messages if row["session_index"] == index
                          for ordinal in row["ordinals"])
        measured = sorted(ordinal for row in messages
                          if row["session_index"] == index and row["id"] in measured_ids
                          for ordinal in row["ordinals"])
        if accepted != expected or any(ordinal not in accepted for ordinal in measured):
            raise ValueError("authoritative session bitmap differs from committed proof messages")
        total_ordinals += len(accepted)
        measured_ordinals += len(measured)
    return dict(total_committed_valid_proof_transactions=len(warmup_rows) + len(measured_rows),
                measured_committed_valid_proof_transactions=len(measured_rows),
                total_authoritative_new_sample_ordinals=total_ordinals,
                measured_authoritative_new_sample_ordinals=measured_ordinals)


def native_v3_chain_exporter_identity(value):
    exporter = Path(value).resolve(strict=True)
    if not exporter.is_file() or not os.access(exporter, os.X_OK):
        raise ValueError("native v3 chain exporter must be executable")
    return exporter, dict(native_chain_exporter=str(exporter),
                          native_chain_exporter_sha256=artifact.sha256(exporter))


def native_v3_harness_source():
    """Require the executing driver and its helpers to come from one checkout."""
    driver = Path(__file__).resolve()
    scripts = driver.parent
    helpers = (artifact, commit_metrics, producer)
    if any(Path(module.__file__).resolve().parent != scripts for module in helpers):
        raise ValueError("native v3 harness driver and helpers must come from one checkout")
    return scripts.parent


def verify_native_v3_build_manifest(value, source, harness_source, artifacts):
    """Bind supplied qualification artifacts and harness to one clean commit."""
    path = Path(value).resolve(strict=True)
    manifest = json.loads(path.read_text())
    if not isinstance(manifest, dict) or set(manifest) != {"source_commit", "artifacts"}:
        raise ValueError("native v3 build manifest has an invalid schema")
    checkouts = tuple(dict.fromkeys((Path(source).resolve(), Path(harness_source).resolve())))
    identities = [(checkout,
        artifact.command("git", "-C", str(checkout), "rev-parse", "HEAD").strip(),
        artifact.command("git", "-C", str(checkout), "status", "--porcelain"))
        for checkout in checkouts]
    if any(commit != manifest["source_commit"] or status for _, commit, status in identities):
        raise ValueError("native v3 build manifest requires exact clean source and harness commits")
    expected = {name: artifact.sha256(binary) for name, binary in artifacts.items()}
    if manifest["artifacts"] != expected:
        raise ValueError("native v3 build manifest artifact hashes do not match supplied binaries")
    return dict(path=str(path), sha256=artifact.sha256(path),
                source_commit=manifest["source_commit"],
                checkouts=[str(checkout) for checkout, _, _ in identities],
                artifacts=expected, verified=True)


def validate_broadcast_tx_sync(value, expected_hash, request_id):
    """Accept only an unambiguous CheckTx success for the frozen bytes."""
    if not isinstance(value, dict) or value.get("jsonrpc") != "2.0" or value.get("id") != request_id or value.get("error"):
        raise ValueError("broadcast_tx_sync returned an ambiguous JSON-RPC response")
    result = value.get("result")
    if (not isinstance(result, dict) or producer.uint(result.get("code", 1)) != 0 or
            str(result.get("hash", "")).upper() != expected_hash):
        raise ValueError("broadcast_tx_sync rejected or changed the frozen transaction")
    return result


def validate_mempool_sample(value):
    if not isinstance(value, dict):
        raise ValueError("num_unconfirmed_txs returned no result")
    current = producer.uint(value.get("n_txs", ""))
    total = producer.uint(value.get("total", ""))
    total_bytes = producer.uint(value.get("total_bytes", ""))
    if current != total:
        raise ValueError("num_unconfirmed_txs counters disagree")
    return dict(transactions=total, bytes=total_bytes)


def native_v3_backlog_duration_ns(samples, *, max_gap_ns=2_000_000_000):
    """Longest sufficiently observed interval with a positive mempool."""
    return native_v3_backlog_interval(samples, max_gap_ns=max_gap_ns)["duration_ns"]


def native_v3_backlog_interval(samples, *, max_gap_ns=2_000_000_000):
    best = dict(duration_ns=0)
    start = previous = None
    previous_height = None
    for sample in samples:
        at = producer.uint(sample.get("monotonic_ns", ""))
        sample_started = producer.uint(sample.get("sample_started_monotonic_ns", ""))
        unix = producer.uint(sample.get("unix_ns", ""))
        height = producer.uint(sample.get("observed_height", ""))
        if sample_started > at or (previous is not None and at <= previous):
            raise ValueError("mempool samples have invalid monotonic bounds")
        if previous_height is not None and height < previous_height:
            raise ValueError("mempool sample height regressed")
        nodes = sample.get("nodes", [])
        positive = len(nodes) == 4 and min(producer.uint(row.get("transactions", "")) for row in nodes) > 0
        if positive and (previous is None or at - previous <= max_gap_ns):
            start = (sample_started, unix, height) if start is None else start
        elif positive:
            start = (sample_started, unix, height)
        else:
            start = None
        if start is not None:
            duration = at - start[0]
            if duration > best["duration_ns"]:
                best = dict(duration_ns=duration, monotonic_start_ns=start[0], monotonic_end_ns=at,
                            unix_start_ns=start[1], unix_end_ns=unix,
                            observed_start_height=start[2], observed_end_height=height)
        previous = at
        previous_height = height
    return best


def _rpc_broadcast_lane(node, rows, start_event):
    connection = http.client.HTTPConnection("127.0.0.1", node["rpc"], timeout=5)
    outcomes = []
    start_event.wait()
    try:
        for row in rows:
            request_id = row["rpc_id"]
            body = json.dumps({"jsonrpc": "2.0", "id": request_id,
                "method": "broadcast_tx_sync", "params": {"tx": row["_tx_base64"]}},
                separators=(",", ":")).encode()
            offered_ns, offered_unix_ns = artifact.monotonic_ns(), time.time_ns()
            connection.request("POST", "/", body=body, headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            raw = response.read(1_048_577)
            if response.status != 200 or len(raw) > 1_048_576:
                raise ValueError("broadcast_tx_sync returned an invalid HTTP response")
            try:
                value = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("broadcast_tx_sync returned malformed JSON") from error
            validate_broadcast_tx_sync(value, row["txhash"], request_id)
            outcomes.append(dict(id=row["id"], txhash=row["txhash"], signer=row["signer"],
                sequence=row["sequence"], offered_monotonic_ns=offered_ns,
                offered_unix_ns=offered_unix_ns, accepted_monotonic_ns=artifact.monotonic_ns()))
    finally:
        connection.close()
    return outcomes


def _monitor_native_v3_mempools(lifecycle, start_event, stop_event):
    samples = []
    last_resource_sample_ns = 0
    ticks = os.sysconf("SC_CLK_TCK")
    page_size = os.sysconf("SC_PAGE_SIZE")
    if type(ticks) is not int or ticks <= 0 or type(page_size) is not int or page_size <= 0:
        raise ValueError("invalid Linux process accounting units")
    resources = lifecycle.doc.get("validator_resources", [])
    pids = {}
    for node in lifecycle.nodes:
        matches = [row for row in resources if row.get("node_id") == node["node_id"]]
        if len(matches) != 1:
            raise ValueError("capacity monitor requires one retained validator PID")
        pids[node["node_id"]] = producer.uint(matches[0]["pid"])
    start_event.wait()
    while not stop_event.is_set():
        sample_started = artifact.monotonic_ns()
        nodes = []
        for node in lifecycle.nodes:
            pid = pids[node["node_id"]]
            stat = parse_proc_stat(Path(f"/proc/{pid}/stat").read_text(), expected_pid=pid)
            rss_bytes = stat.pop("rss_pages") * page_size
            nodes.append(dict(node_id=node["node_id"],
                **validate_mempool_sample(lifecycle.query(node, "/num_unconfirmed_txs")), **stat,
                rss_bytes=rss_bytes, process_monotonic_ns=artifact.monotonic_ns()))
        status = lifecycle.query(lifecycle.nodes[0], "/status")
        if (status.get("node_info", {}).get("id") != lifecycle.nodes[0]["node_id"] or
                status.get("node_info", {}).get("network") != lifecycle.chain or
                status.get("sync_info", {}).get("catching_up") is not False):
            raise ValueError("capacity monitor RPC belongs to a different or catching-up chain")
        resources = None
        if sample_started - last_resource_sample_ns >= 1_000_000_000:
            resources = native_v3_resource_sample(lifecycle)
            last_resource_sample_ns = sample_started
        samples.append(dict(sample_started_monotonic_ns=sample_started,
                            monotonic_ns=artifact.monotonic_ns(), unix_ns=time.time_ns(),
                            observed_height=producer.uint(
                                status.get("sync_info", {}).get("latest_block_height", 0)),
                            clock_ticks_per_second=ticks, page_size_bytes=page_size,
                            nodes=nodes, resources=resources))
        stop_event.wait(.1)
    return samples


def freeze_native_v3_transactions(lifecycle, intents, simulations, profiles, providers, sequences, command):
    """Offline sign and encode provider-local intents in bounded parallel lanes."""
    directory = lifecycle.home / "native-v3-chain-frozen"
    directory.mkdir(mode=0o700, exist_ok=True)
    node = lifecycle.nodes[0]
    profile_order = {row["name"]: index for index, row in enumerate(profiles)}
    grouped = {}
    for intent in intents:
        grouped.setdefault((intent["slot"], intent["profile"]), []).append(intent)

    def sign_provider(slot):
        provider = providers[slot]
        aliases = [name for name, address in lifecycle.signers.items() if address == provider]
        if len(aliases) != 1:
            raise ValueError("provider address does not identify exactly one signing key")
        sequence = sequences[provider]["sequence"]
        pending, encoding_sources = [], []
        for profile in sorted((row["name"] for row in profiles), key=profile_order.get):
            rows = grouped.get((slot, profile), [])
            if not rows:
                continue
            if any(intent["provider"] != provider or any(
                    member["provider"] != provider or member["slot"] != slot
                    for member in intent["members"]) for intent in rows):
                raise ValueError("frozen transaction crosses provider authority")
            common = ["--from", aliases[0], "--home", node["home"], "--keyring-backend", "test",
                "--chain-id", lifecycle.chain, "--offline",
                "--account-number", str(sequences[provider]["account_number"]),
                "--sequence", str(sequence), "--sign-mode", "direct"]
            prefix = directory / f"provider-{slot}-{profile}"
            if rows[0]["submission_mode"] == "serial-messages":
                for index, intent in enumerate(rows):
                    simulation = simulations[intent["id"]]
                    unsigned = Path(simulation["unsigned_path"])
                    signed = prefix.with_name(prefix.name + f"-{index}.signed.json")
                    unsigned_value = json.loads(unsigned.read_text())
                    expected_messages = unsigned_value["body"]["messages"]
                    gas_limit = simulation["gas_limit"]
                    serial_common = list(common)
                    serial_common[serial_common.index("--sequence") + 1] = str(sequence + index)
                    command([str(lifecycle.binary), "tx", "sign", str(unsigned),
                             *serial_common, "--output-document", str(signed)], 300)
                    try:
                        signed_values = [json.loads(signed.read_text())]
                    except (OSError, json.JSONDecodeError) as error:
                        raise ValueError("tx sign returned an incomplete serial transaction") from error
                    pending.append(validate_frozen_signed_transaction(
                        intent, signed_values[0], expected_messages,
                        unsigned_value["auth_info"]["fee"].get("amount"),
                        gas_limit, sequence + index, signed))
                    encoding_sources.append(signed)
            else:
                unsigned = prefix.with_suffix(".unsigned.jsonl")
                signed = prefix.with_suffix(".signed.jsonl")
                selected = [simulations[intent["id"] if intent["submission_mode"] == "batch-message"
                                        else intent["members"][0]["id"]] for intent in rows]
                if rows[0]["submission_mode"] == "batch-message":
                    unsigned_values, signed_values = [], []
                    for index, simulation in enumerate(selected):
                        unsigned_one = prefix.with_name(prefix.name + f"-{index}.unsigned.json")
                        signed_one = prefix.with_name(prefix.name + f"-{index}.signed.json")
                        unsigned_one.write_text(Path(simulation["unsigned_path"]).read_text())
                        values = [json.loads(line) for line in unsigned_one.read_text().splitlines()]
                        if len(values) != 1:
                            raise ValueError("batch-message unsigned transaction inventory is incomplete")
                        per_tx_common = list(common)
                        per_tx_common[per_tx_common.index("--sequence") + 1] = str(sequence + index)
                        command([str(lifecycle.binary), "tx", "sign", str(unsigned_one),
                                 *per_tx_common, "--output-document", str(signed_one)], 300)
                        values_signed = [json.loads(line) for line in signed_one.read_text().splitlines()]
                        if len(values_signed) != 1:
                            raise ValueError("tx sign returned an incomplete transaction inventory")
                        unsigned_values.extend(values)
                        signed_values.extend(values_signed)
                else:
                    unsigned.write_text("".join(Path(row["unsigned_path"]).read_text() for row in selected))
                    unsigned_values = [json.loads(line) for line in unsigned.read_text().splitlines()]
                    command([str(lifecycle.binary), "tx", "sign-batch", str(unsigned), *common,
                             "--output-document", str(signed)], 300)
                    signed_values = [json.loads(line) for line in signed.read_text().splitlines()]
                    if len(signed_values) != len(rows) or len(unsigned_values) != len(rows):
                        raise ValueError("sign-batch returned an incomplete transaction inventory")
                for index, (intent, simulation, unsigned_tx, signed_tx) in enumerate(
                        zip(rows, selected, unsigned_values, signed_values)):
                    signed_one = prefix.with_name(prefix.name + f"-{index}.signed.json")
                    if rows[0]["submission_mode"] != "batch-message":
                        signed_one.write_text(json.dumps(signed_tx, separators=(",", ":")))
                    pending.append(validate_frozen_signed_transaction(intent, signed_tx,
                        unsigned_tx["body"]["messages"],
                        unsigned_tx["auth_info"]["fee"].get("amount"),
                        simulation["gas_limit"], sequence + index, signed_one))
                    encoding_sources.append(signed_one)
            sequence += len(rows)
        return pending, encoding_sources

    def validate_frozen_signed_transaction(intent, signed_tx, expected_messages, expected_fee,
                                           gas_limit, sequence, signed_path):
        signer_infos = signed_tx.get("auth_info", {}).get("signer_infos", [])
        signed_fee = signed_tx.get("auth_info", {}).get("fee", {})
        signed_gas = producer.uint(signed_fee.get("gas_limit", ""))
        if (signed_tx.get("body", {}).get("messages") != expected_messages or signed_gas != gas_limit or
                signed_fee.get("amount") != expected_fee or
                len(signed_tx.get("signatures", [])) != 1 or len(signer_infos) != 1 or
                producer.uint(signer_infos[0].get("sequence", "")) != sequence):
            raise ValueError("offline signed transaction differs from frozen intent, gas, or sequence")
        return intent, sequence, gas_limit, signed_path

    slots = [slot for slot in range(V3_SYSTEMATIC_PROVIDERS)
             if any(key[0] == slot for key in grouped)]
    with ThreadPoolExecutor(max_workers=len(slots)) as pool:
        signed_groups = list(pool.map(sign_provider, slots))
    pending = [row for group, _ in signed_groups for row in group]
    encoding_sources = [source for _, sources in signed_groups for source in sources]
    if len(encoding_sources) != len(pending):
        raise ValueError("signed transaction inventory differs from encoding sources")

    # `tx encode-batch` scans newline-delimited JSON with the Go scanner's
    # default token bound. A valid 64-message serial comparator transaction is
    # larger than that bound, while the ordinary `tx encode` command reads one
    # complete JSON document. Encode individual signed transactions in bounded
    # parallel lanes and retain their deterministic provider/profile order.
    def encode_signed(source):
        output = command([str(lifecycle.binary), "tx", "encode", str(source),
            "--home", node["home"], "--chain-id", lifecycle.chain], 300)
        rows = output.strip().splitlines()
        if len(rows) != 1:
            raise ValueError("tx encode returned an incomplete transaction")
        return rows[0]

    with ThreadPoolExecutor(max_workers=min(V3_SYSTEMATIC_PROVIDERS, len(encoding_sources))) as pool:
        encoded_rows = list(pool.map(encode_signed, encoding_sources))
    encoded_path = directory / "transactions.base64"
    encoded_path.write_text("\n".join(encoded_rows) + "\n")
    if len(encoded_rows) != len(pending):
        raise ValueError("tx encode returned an incomplete transaction inventory")

    def encode(item):
        (intent, sequence, gas_limit, signed), encoded = item
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            raise ValueError("tx encode returned malformed TxRaw bytes") from error
        if not raw or len(raw) > 1024 * 1024:
            raise ValueError("frozen TxRaw exceeds the Comet transaction bound")
        raw_path = signed.with_suffix(".tx")
        raw_path.write_bytes(raw)
        members = [dict(id=row["id"], session_index=row["session_index"], slot=row["slot"],
                        ordinals=row["ordinals"], message_path=row["message_path"],
                        message_sha256=row["message_sha256"]) for row in intent["members"]]
        return dict(id=intent["id"], profile=intent["profile"],
            submission_mode=intent["submission_mode"], batch_size=intent["batch_size"],
            slot=intent["slot"], signer=intent["provider"], sequence=sequence,
            gas_limit=gas_limit, members=members, signed_path=str(signed), raw_path=str(raw_path),
            bytes=len(raw), txhash=hashlib.sha256(raw).hexdigest().upper(),
            signed_sha256=artifact.sha256(signed), raw_sha256=artifact.sha256(raw_path),
            _tx_base64=encoded)
    frozen = [encode(row) for row in zip(pending, encoded_rows)]
    if len(frozen) != len(intents) or len({row["txhash"] for row in frozen}) != len(frozen):
        raise ValueError("frozen native v3 transaction inventory is incomplete or repeats a TxRaw hash")
    for rpc_id, row in enumerate(frozen, 1):
        row["rpc_id"] = rpc_id
    return frozen

def _discover_frozen_commits(lifecycle, frozen, first, last):
    expected, found, blocks = {row["txhash"]: row for row in frozen}, {}, []
    for height in range(first, last + 1):
        block = lifecycle.query(lifecycle.nodes[0], f"/block?height={height}")
        summary = artifact.committed_block_summary(block,
            lifecycle.query(lifecycle.nodes[0], f"/block_results?height={height}"), height, lifecycle.chain)
        blocks.append(summary)
        for tx in summary["transactions"]:
            row = expected.get(tx["txhash"])
            if row is None:
                continue
            if tx["txhash"] in found or tx["code"] != 0 or tx["bytes"] != row["bytes"] or tx["gas_wanted"] != row["gas_limit"]:
                raise ValueError("committed frozen transaction differs in identity, result, bytes, or gas")
            found[tx["txhash"]] = dict({key: value for key, value in row.items() if not key.startswith("_")},
                outcome="committed_success", height=height,
                code=tx["code"], gas_wanted=tx["gas_wanted"], gas_used=tx["gas_used"],
                committed_time=summary["time"], operation_id=row["id"])
    if set(found) != set(expected):
        raise ValueError("drained blocks omit an accepted frozen transaction")
    return list(found.values()), blocks


def _unix_ns(value):
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z", value)
    if match is None:
        raise ValueError("block header has a noncanonical UTC timestamp")
    seconds = calendar.timegm(datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S").timetuple())
    return seconds * 10**9 + int((match.group(2) or "").ljust(9, "0"))


def native_v3_transaction_members(row):
    members = row.get("members")
    if members is None:
        members = [{key: row[key] for key in ("session_index", "slot", "ordinals")}]
    if not isinstance(members, list) or not members:
        raise ValueError("proof transaction has no logical proof members")
    identities = [(producer.uint(member["session_index"]), producer.uint(member["slot"]))
                  for member in members]
    if len(set(identities)) != len(identities):
        raise ValueError("proof transaction repeats a logical session obligation")
    return members


def native_v3_capacity_metrics(profile, offered, committed, blocks, start_ns, offer_end_ns,
                               drain_end_ns, mempool_samples, validator_gomaxprocs=2):
    sample_count = artifact.integer(profile["sample_count"], "profile sample count", 1,
                                    V3_MAX_SAMPLES)
    offered_by_hash = {row["txhash"]: row for row in offered}
    elapsed = (drain_end_ns - start_ns) / 1e9
    offer_elapsed = (offer_end_ns - start_ns) / 1e9
    accepted_rate = len(offered) / offer_elapsed
    backlog = native_v3_backlog_interval(mempool_samples)
    if backlog["duration_ns"] < V3_CHAIN_BACKLOG_SECONDS * 10**9:
        raise ValueError("native v3 chain profile did not sustain a positive mempool backlog for ten seconds")
    hashes = set(offered_by_hash)
    measured_blocks = []
    for block in blocks:
        transactions = [row for row in block["transactions"] if row["txhash"] in hashes]
        if transactions:
            measured_blocks.append(dict(height=block["height"], transaction_count=len(transactions),
                txhashes=[row["txhash"] for row in transactions],
                proof_gas_wanted=sum(row["gas_wanted"] for row in transactions),
                proof_gas_used=sum(row["gas_used"] for row in transactions),
                proof_transaction_bytes=sum(row["bytes"] for row in transactions),
                block_gas_wanted=block["gas_wanted"], block_gas_used=block["gas_used"],
                block_transaction_bytes=block["tx_payload_bytes"], time=block["time"]))
    by_height = {row["height"]: row for row in blocks}
    start_height, end_height = backlog["observed_start_height"], backlog["observed_end_height"]
    saturated = [row for row in measured_blocks if start_height < row["height"] <= end_height]
    if not saturated:
        raise ValueError("positive mempool evidence contains no committed workload block")
    saturated_blocks = [by_height.get(height) for height in range(start_height + 1, end_height + 1)]
    if not saturated_blocks or any(row is None for row in saturated_blocks):
        raise ValueError("positive backlog interval is missing a reconciled canonical block")
    predecessor = by_height.get(start_height)
    if predecessor is None:
        raise ValueError("saturated interval is missing its timestamp predecessor")
    commit_intervals = []
    for row in saturated_blocks:
        previous = by_height.get(row["height"] - 1)
        if previous is None:
            raise ValueError("saturated block is missing its timestamp predecessor")
        seconds = (_unix_ns(row["time"]) - _unix_ns(previous["time"])) / 1e9
        if seconds <= 0:
            raise ValueError("saturated block timestamps did not advance")
        commit_intervals.append(seconds)
    commit_seconds = backlog["duration_ns"] / 1e9
    saturated_transactions = sum(row["transaction_count"] for row in saturated)
    if commit_seconds <= 0 or saturated_transactions <= 0:
        raise ValueError("saturated committed interval is empty")
    if commit_seconds < V3_CHAIN_BACKLOG_SECONDS:
        raise ValueError("backlog-saturated consensus interval is shorter than ten seconds")
    committed_rate = saturated_transactions / commit_seconds
    if accepted_rate < 1.5 * committed_rate:
        raise ValueError("native v3 accepted offer rate did not exceed committed rate by 1.5x")
    latencies = []
    for row in committed:
        offered_ns = offered_by_hash[row["txhash"]]["offered_monotonic_ns"]
        observed = next((sample for sample in mempool_samples
                         if sample["monotonic_ns"] >= offered_ns and
                         producer.uint(sample.get("observed_height", 0)) >= row["height"]), None)
        if observed is None:
            raise ValueError("capacity monitor did not observe a committed transaction height")
        latencies.append((observed["monotonic_ns"] - offered_ns) / 1e9)
    saturated_hashes = {txhash for row in saturated for txhash in row["txhashes"]}
    saturated_committed = [row for row in committed if row["txhash"] in saturated_hashes]
    sampled_chained_proofs = sum(len(member["ordinals"]) for row in saturated_committed
                                 for member in native_v3_transaction_members(row))
    inventory_sampled_chained_proofs = sum(
        len(member["ordinals"]) for row in committed
        for member in native_v3_transaction_members(row))
    if inventory_sampled_chained_proofs != profile["sessions"] * sample_count:
        raise ValueError("frozen proof inventory differs from the profile sample count")
    expected_slots = {}
    for row in committed:
        for member in native_v3_transaction_members(row):
            slots = expected_slots.setdefault(member["session_index"], set())
            if member["slot"] in slots:
                raise ValueError("frozen proof inventory repeats a session obligation")
            slots.add(member["slot"])
    if (len(expected_slots) != profile["sessions"] or
            any(len(slots) != profile["proof_transactions"] for slots in expected_slots.values())):
        raise ValueError("frozen proof inventory differs from the profile obligation count")
    session_slots = {}
    for row in saturated_committed:
        for member in native_v3_transaction_members(row):
            slots = session_slots.setdefault(member["session_index"], set())
            if member["slot"] not in expected_slots[member["session_index"]] or member["slot"] in slots:
                raise ValueError("saturated proof transaction has an invalid session obligation")
            slots.add(member["slot"])
    complete_proof_sets = sum(slots == expected_slots[index] for index, slots in session_slots.items())
    if not complete_proof_sets:
        raise ValueError("saturated consensus interval contains no complete proof set")
    proof_sets_per_second = complete_proof_sets / commit_seconds
    proof_sets_per_day = proof_sets_per_second * 86400
    sampled_chained_proofs_per_second = sampled_chained_proofs / commit_seconds
    sampled_chained_proofs_per_day = sampled_chained_proofs_per_second * 86400
    try:
        one_sample_verifier_sessions_per_second = (
            V3_VALIDATOR_V3_ONE_SAMPLE_SESSIONS_PER_SECOND[validator_gomaxprocs])
    except KeyError as error:
        raise ValueError("no retained V3 verifier ceiling for validator GOMAXPROCS") from error
    verifier_sessions_per_second = one_sample_verifier_sessions_per_second / sample_count
    verifier_provenance = dict(V3_CONFIGURED_VALIDATOR_V3_VERIFIER_PROVENANCE)
    verifier_provenance.update(
        validator_gomaxprocs=validator_gomaxprocs,
        source_statistic=(
            ".parallel_verifier[] | select(.workers == "
            f"{validator_gomaxprocs}) | .median_sessions_per_second"),
        source_statistic_semantics=(
            "exact pure verifyPolyFSChainedProof throughput for one sampled chained proof per "
            f"session at GOMAXPROCS={validator_gomaxprocs}; each configured validator repeats "
            "the same transaction stream"))
    resource_metrics = validator_backlog_resources(
        mempool_samples, backlog, mempool_samples[0]["clock_ticks_per_second"])
    max_mempool_transactions = max(row["transactions"] for sample in mempool_samples
                                    for row in sample["nodes"])
    return dict(elapsed_seconds=elapsed, offer_seconds=offer_elapsed,
        daily_equivalent_basis="short saturated rate multiplied by 86400; not a 24-hour sustained or delivery claim",
        invalid_transactions=0, unknown_transactions=0, duplicate_transactions=0,
        dropped_transactions=0, retried_transactions=0,
        accepted_offer_transactions_per_second=accepted_rate,
        committed_transactions_per_second=committed_rate,
        committed_transactions_per_day=committed_rate * 86400,
        committed_logical_sessions_per_second=proof_sets_per_second,
        committed_logical_sessions_per_day=proof_sets_per_day,
        committed_sampled_chained_proofs_per_second=sampled_chained_proofs_per_second,
        committed_sampled_chained_proofs_per_day=sampled_chained_proofs_per_day,
        committed_kzg_opening_verifications_per_second=2 * sampled_chained_proofs_per_second,
        committed_kzg_opening_verifications_per_day=2 * sampled_chained_proofs_per_day,
        configured_validator_v3_one_sample_verifier_sessions_per_second=(
            one_sample_verifier_sessions_per_second),
        configured_validator_v3_linearized_session_ceiling_per_second=(
            verifier_sessions_per_second),
        configured_validator_v3_linearized_session_ceiling_per_day=(
            verifier_sessions_per_second * 86400),
        percent_of_configured_validator_v3_verifier_capacity=(
            sampled_chained_proofs_per_second /
            one_sample_verifier_sessions_per_second * 100),
        configured_validator_v3_verifier_provenance=verifier_provenance,
        complete_proof_sets_per_second=proof_sets_per_second,
        complete_proof_sets_per_day=proof_sets_per_day,
        complete_proof_sets_in_saturated_interval=complete_proof_sets,
        partial_proof_sets_in_saturated_interval=len(session_slots) - complete_proof_sets,
        logical_requested_bytes_per_day=proof_sets_per_day * profile["range_bytes"],
        logical_requested_gib_per_day=proof_sets_per_day * profile["range_bytes"] / 1024**3,
        saturated_commit_interval=dict(predecessor_height=predecessor["height"] if predecessor else None,
            first_height=saturated_blocks[0]["height"], last_height=saturated_blocks[-1]["height"],
            observation_start_height=start_height, observation_end_height=end_height,
            elapsed_seconds=commit_seconds, transactions=saturated_transactions,
            blocks=len(saturated_blocks),
            timing_basis="monotonic all-validator-positive observation fence"),
        commit_interval_seconds=dict(
            basis="differences between consecutive canonical Comet block header timestamps",
            observations=len(commit_intervals), p50=_nearest_rank(commit_intervals, 50),
            p95=_nearest_rank(commit_intervals, 95), p99=_nearest_rank(commit_intervals, 99)),
        positive_backlog_seconds=backlog["duration_ns"] / 1e9,
        positive_backlog_interval=backlog, mempool_samples=mempool_samples,
        validator_resources_during_backlog=resource_metrics,
        peak_observed_mempool_transactions=max_mempool_transactions,
        inclusion_latency_upper_bound_seconds=dict(
            basis="offer to first local RPC observation at or above the committed height; conservative upper bound",
            min=min(latencies), p50=_nearest_rank(latencies, 50),
            p95=_nearest_rank(latencies, 95), max=max(latencies)),
        blocks=measured_blocks,
        average_proof_gas_wanted_per_saturated_block=sum(row["proof_gas_wanted"] for row in saturated) / len(saturated),
        average_proof_transaction_bytes_per_saturated_block=sum(row["proof_transaction_bytes"] for row in saturated) / len(saturated))


def is_issue_251_candidate(profile, max_block_gas, gas_adjustment, gomaxprocs, timeout_commit):
    return (profile["name"] == "1kib" and profile["submission_mode"] == "batch-message" and
            profile["batch_size"] == V3_ISSUE_251_QUALIFICATION_BATCH_SIZE and
            profile["sessions"] == V3_ISSUE_251_QUALIFICATION_SESSIONS and
            profile["measured_transactions"] == V3_ISSUE_251_QUALIFICATION_TRANSACTIONS and
            max_block_gas == V3_ISSUE_251_QUALIFICATION_GAS and gas_adjustment == "1.6" and
            gomaxprocs == 4 and timeout_commit == "1s")


def native_v3_issue_251_qualification(metrics, finalize_blocks, consensus, offered, committed,
                                      comet_mempool_size, memory_ceiling):
    """Evaluate only the fixed issue #251 candidate against its published gates."""
    reasons = []
    if offered != V3_ISSUE_251_QUALIFICATION_TRANSACTIONS or committed != offered:
        reasons.append("the fixed 120-transaction batch inventory was not accepted and committed exactly once")
    if metrics["saturated_commit_interval"]["blocks"] < V3_ISSUE_251_MINIMUM_SATURATED_BLOCKS:
        reasons.append("fewer than 10 saturated blocks were reconciled")
    if metrics["positive_backlog_seconds"] < V3_CHAIN_BACKLOG_SECONDS:
        reasons.append("all-validator positive backlog lasted less than ten seconds")
    if metrics["commit_interval_seconds"]["p95"] > 1.6:
        reasons.append("p95 commit interval exceeded 1.6 seconds")
    if consensus["maximum_round"] != 0 or consensus["missed_signatures"] != 0:
        reasons.append("a saturated block used a nonzero round or missed a validator signature")
    if any(row["sampled_peak_rss_bytes"] >= memory_ceiling for row in
           metrics["validator_resources_during_backlog"]["validators"]):
        reasons.append("a validator reached the per-process memory ceiling during backlog")
    if metrics["peak_observed_mempool_transactions"] >= comet_mempool_size:
        reasons.append("the observed mempool reached its transaction-count cap")
    if len(finalize_blocks) != 4 or any(not row["summary"]["p95_within_700ms"]
                                        for row in finalize_blocks):
        reasons.append("a validator's native FinalizeBlock p95 exceeded the 700ms execution budget or was unknown")
    for name in ("invalid_transactions", "unknown_transactions", "duplicate_transactions",
                 "dropped_transactions", "retried_transactions"):
        if metrics[name] != 0:
            reasons.append(f"{name} was nonzero")
    return dict(qualified=not reasons, reasons=reasons,
        candidate="160M max gas, 2MiB max bytes, 7,680 one-opening 1KiB sessions in 120 batches of 64",
        gates={"minimum_saturated_blocks": V3_ISSUE_251_MINIMUM_SATURATED_BLOCKS,
               "minimum_positive_backlog_seconds": 10,
               "finalize_block_p95_upper_bound_seconds": .7,
               "commit_interval_p95_seconds": 1.6,
               "maximum_consensus_round": 0, "missed_validator_signatures": 0,
               "memory_ceiling_per_validator_bytes": memory_ceiling,
               "comet_mempool_count_cap_must_not_be_reached": comet_mempool_size})


def run_native_v3_chain(lifecycle, *, deal, providers, wait, audits, exporter, command, epoch_length,
                        profile_name=None, measured_transactions=None, measured_sessions=None,
                        submission_mode="separate", batch_size=1, gas_adjustment="1.6"):
    """Measure saturated proof-only chain capacity from frozen native-v3 TxRaw bytes."""
    if epoch_length != V3_CHAIN_AUDIT_EPOCH_BLOCKS:
        raise ValueError("native chain capacity requires the fixed 100-block audit epoch")
    if gas_adjustment not in V3_CHAIN_GAS_ADJUSTMENTS:
        raise ValueError("native v3 gas adjustment is outside the benchmark matrix")
    doc = lifecycle.doc["native_v3_chain"] = dict(qualification=False,
        scope="proof confirmation only; transport, proof preparation, session opens, ACK and refund excluded",
        gas_adjustment=gas_adjustment)
    owner = lifecycle.signers["owner0"]
    profiles = native_v3_chain_capacity_profiles(profile_name, measured_transactions,
        measured_sessions=measured_sessions, submission_mode=submission_mode, batch_size=batch_size)
    max_block_gas = artifact.integer(
        lifecycle.doc["profile"]["consensus"]["block"]["max_gas"], "max block gas", 1)
    issue_251_candidate = (len(profiles) == 1 and is_issue_251_candidate(
        profiles[0], max_block_gas, gas_adjustment, int(lifecycle.env["GOMAXPROCS"]),
        lifecycle.doc["profile"]["timeout_commit"]))
    doc["issue_251_candidate"] = issue_251_candidate
    opened_at = lifecycle.wait_height(3)
    session_count = sum(profile["sessions"] for profile in profiles)
    max_deadline_height = native_v3_capacity_deadline(opened_at, session_count - 1)
    if max_deadline_height >= producer.uint(deal["end_block"]):
        raise ValueError("native chain capacity sessions reach the deal end")
    root = producer.b64(deal["manifest_root"], 32).hex()
    integrity = lifecycle.doc["native_v3_generation"]["candidate"]["integrity_root"][2:]
    sessions, nonce = [], 1
    for profile in profiles:
        profile["session_start"] = len(sessions)
        for profile_session in range(profile["sessions"]):
            deadline_height = native_v3_capacity_deadline(opened_at, len(sessions))
            range_start = (profile_session % V3_SYSTEMATIC_PROVIDERS) * V3_DATA_BLOB_PAYLOAD_BYTES \
                if profile["name"] == "1kib" else 0
            path = lifecycle.home / f"native-chain-open-{nonce}.json"
            path.write_text(json.dumps(dict(creator=owner, deal_id=str(deal["id"]), generation="1",
                range=dict(file_record_index=0, file_start_offset="0", file_length=str(V3_PILOT_BYTES),
                           range_start=str(range_start), range_length=str(profile["range_bytes"])), nonce=str(nonce),
                deadline_height=str(deadline_height)), separators=(",", ":")))
            sessions.append(dict(session_index=len(sessions), nonce=nonce, profile=profile["name"], profile_session=profile_session,
                                 range_start=range_start, deadline_height=deadline_height, open_path=str(path)))
            nonce += 1
        profile["session_end"] = len(sessions)
    opened_heights = []
    for batch_index, offset in enumerate(range(0, len(sessions), V3_CROSS_AUDIT_OPEN_BATCH_MAX)):
        batch = sessions[offset:offset + V3_CROSS_AUDIT_OPEN_BATCH_MAX]
        session_ids, height = open_v3_session_batch(lifecycle, [row["open_path"] for row in batch],
            lifecycle.home / f"native-chain-open-batch-{batch_index}", command)
        for row, session_id in zip(batch, session_ids):
            row["session_id"] = session_id
        opened_heights.append(height)
    evidence_height = wait(max(opened_heights) + 2)
    for row, view in zip(sessions, v3_session_queries(lifecycle, sessions, evidence_height)):
        profile = next(value for value in profiles if value["name"] == row["profile"])
        session, accepted = validate_v3_session(view, session_id=row["session_id"], deal_id=deal["id"],
            owner=owner, providers=providers, nonce=row["nonce"], polyfs_root=root, integrity_root=integrity,
            chain_id=lifecycle.chain, deadline_height=row["deadline_height"], range_start=row["range_start"],
            range_length=profile["range_bytes"])
        if accepted:
            raise ValueError("native chain capacity session starts with accepted samples")
        row.update(before_proofs=view, evidence_height=evidence_height,
                   context_hash=producer.b64(session["context_hash"], 32).hex(),
                   anchor_seed=producer.b64(view["anchor_seed"], 32).hex())
        row["seed"] = hashlib.sha256(producer.lp("polystore/challenge-seed/v3") +
            bytes.fromhex(row["context_hash"]) + bytes.fromhex(row["anchor_seed"])).hexdigest()
    directories = {row["address"]: Path(row["directory"]) / "deals" / str(deal["id"]) / root
                   for row in lifecycle.doc["providers"] if row["address"] in providers.values()}
    inventory = export_native_v3_chain_inventory(lifecycle, Path(exporter).resolve(strict=True),
                                                 sessions, providers, directories)
    for row in inventory["messages"]:
        row["profile"] = sessions[row["session_index"]]["profile"]
        row["id"] = f"v3-chain-{row['session_index']}-{row['slot']}"
    by_slot = {slot: [] for slot in range(V3_SYSTEMATIC_PROVIDERS)}
    for row in inventory["messages"]:
        by_slot[row["slot"]].append(row)
    simulated = []
    expected_messages = sum(row["proof_messages"] for row in profiles)
    if any(profile["submission_mode"] == "separate" for profile in profiles):
        def simulate_slot(slot):
            return [(row, *v3_generate_only_gas(lifecycle, row["message_path"], row["provider"],
                                                gas_adjustment=gas_adjustment, max_gas=max_block_gas))
                    for row in by_slot[slot]]
        with ThreadPoolExecutor(max_workers=V3_SYSTEMATIC_PROVIDERS) as pool:
            for values in pool.map(simulate_slot, range(V3_SYSTEMATIC_PROVIDERS)):
                simulated.extend(values)
    if simulated and len(simulated) != expected_messages:
        raise ValueError("native v3 gas preflight omitted a prepared message")
    doc["profiles"] = profiles
    doc["sessions"] = sessions
    doc["inventory"] = dict(inventory, messages=[{key: value for key, value in row.items()}
        for row in inventory["messages"]])
    doc["gas_preflight"] = [dict(id=row["id"], profile=row["profile"], session_index=row["session_index"],
        slot=row["slot"], **simulation) for row, _, simulation in simulated]
    doc["measurements"] = []
    lifecycle.save()
    for profile in profiles:
        profile_simulated = [row for row in simulated if row[0]["profile"] == profile["name"]]
        simulations = {row[0]["id"]: row[2] for row in profile_simulated}
        intents = build_native_v3_transaction_intents(
            inventory["messages"], profile, lifecycle.home / f"native-v3-chain-{profile['name']}-intents")
        if profile["submission_mode"] == "batch-message":
            def simulate_batch(intent):
                _, simulation = v3_generate_only_gas(lifecycle, intent["message_path"], intent["provider"],
                    action="prove-batch", message_type=V3_BATCH_PROOF_TYPE,
                    gas_adjustment=gas_adjustment, max_gas=max_block_gas)
                return intent["id"], simulation
            with ThreadPoolExecutor(max_workers=V3_SYSTEMATIC_PROVIDERS) as pool:
                simulations.update(pool.map(simulate_batch, intents))
        elif profile["submission_mode"] == "serial-messages":
            def simulate_serial(intent):
                return intent["id"], v3_simulate_serial_outer_gas(
                    lifecycle, intent, gas_adjustment=gas_adjustment, max_gas=max_block_gas)
            with ThreadPoolExecutor(max_workers=V3_SYSTEMATIC_PROVIDERS) as pool:
                simulations.update(pool.map(simulate_serial, intents))
        if profile["submission_mode"] != "separate":
            doc["gas_preflight"].extend(dict(id=intent["id"], profile=profile["name"],
                slot=intent["slot"], submission_mode=profile["submission_mode"],
                member_ids=[member["id"] for member in intent["members"]], **simulations[intent["id"]])
                for intent in intents)
            lifecycle.save()
        if len(intents) != profile["measured_transactions"]:
            raise ValueError("transaction intent count differs from the selected submission shape")
        max_block_gas = artifact.integer(
            lifecycle.doc["profile"]["consensus"]["block"]["max_gas"], "max block gas", 1)
        total_gas = sum(simulations[intent["id"] if profile["submission_mode"] != "separate"
                                    else intent["members"][0]["id"]]["gas_limit"] for intent in intents)
        minimum_gas_blocks = native_v3_minimum_gas_blocks(total_gas, max_block_gas)
        required_margin = minimum_gas_blocks + 10
        profile_deadline_height = min(row["deadline_height"] for row in
                                      sessions[profile["session_start"]:profile["session_end"]])
        while True:
            window = await_native_v3_capacity_window(
                lifecycle, wait, audits, epoch_length,
                minimum_gas_blocks + V3_CHAIN_MEASUREMENT_MARGIN_BLOCKS, profile_deadline_height)
            quiescence = require_provider_quiescence(lifecycle, providers)
            frozen = freeze_native_v3_transactions(
                lifecycle, intents, simulations, [profile], providers, quiescence["sequences"], command)
            if len(frozen) != profile["measured_transactions"]:
                raise ValueError("frozen profile transaction count differs from the fixed inventory")
            frozen_members = [member for row in frozen for member in row["members"]]
            expected_member_ids = {row["id"] for row in inventory["messages"] if row["profile"] == profile["name"]}
            if (len(frozen_members) != profile["proof_messages"] or
                    len({row["id"] for row in frozen_members}) != len(frozen_members) or
                    {row["id"] for row in frozen_members} != expected_member_ids or
                    any(artifact.sha256(row["message_path"]) != row["message_sha256"] for row in frozen_members)):
                raise ValueError("frozen transaction members differ from the exact exported proof bytes")
            mempool = lifecycle.doc["profile"]["comet_mempool"]
            if (len(frozen) >= mempool["size"] or
                    sum(row["bytes"] for row in frozen) >= mempool["max_txs_bytes"]):
                raise ValueError("frozen profile reaches the frozen Comet mempool transaction/byte cap")
            post_freeze = require_provider_quiescence(lifecycle, providers)
            ready_height = post_freeze["second_height"]
            ready_epoch = (ready_height - 1) // epoch_length + 1
            if post_freeze["sequences"] != quiescence["sequences"]:
                if ready_epoch != window["epoch"]:
                    continue
                raise ValueError("provider sequence changed while offline transactions were frozen")
            next_anchor = ready_epoch * epoch_length + 1
            if (ready_epoch != window["epoch"] or next_anchor - ready_height < required_margin):
                continue
            current_audits = audits(ready_height, False, ready_epoch)
            if current_audits != window["audits"]:
                raise ValueError("audit authority or coverage changed while transactions were frozen")
            break
        public_frozen = [{key: value for key, value in row.items() if not key.startswith("_")}
                         for row in frozen]
        measurement = dict(profile={key: value for key, value in profile.items()
                                    if key not in ("session_start", "session_end")},
                           minimum_gas_limited_blocks=minimum_gas_blocks,
                           preconditions=dict(ready_height=ready_height, ready_epoch=ready_epoch,
                                              next_anchor=next_anchor, audits=current_audits,
                                              provider_quiescence=post_freeze),
                           frozen_transactions=public_frozen)
        doc["measurements"].append(measurement)
        lifecycle.save()
        for node in lifecycle.nodes:
            if validate_mempool_sample(lifecycle.query(node, "/num_unconfirmed_txs"))["transactions"]:
                raise ValueError("native v3 profile started with a nonempty mempool")
        before_phase = f"native_v3_chain_{profile['name']}_before"
        after_phase = f"native_v3_chain_{profile['name']}_after"
        commit_processes = []
        stream_key = f"native_v3_chain_{profile['name']}_commit_streams"
        start_commit_streams(lifecycle, V3_CHAIN_DRAIN_SECONDS + 60, commit_processes,
                             stream_key=stream_key, filename_prefix=stream_key)
        try:
            capture_workload_metrics(lifecycle, before_phase, fenced=True, finalize_block=True)
            before_cpu = validator_cpu_snapshot(lifecycle)
            predecessor_height = lifecycle.wait_height(1)
            lanes = [[row for row in frozen if row["slot"] == slot]
                     for slot in range(V3_SYSTEMATIC_PROVIDERS)]
            start_event, stop_event = threading.Event(), threading.Event()
            with ThreadPoolExecutor(max_workers=V3_SYSTEMATIC_PROVIDERS + 1) as pool:
                monitor = pool.submit(_monitor_native_v3_mempools, lifecycle, start_event, stop_event)
                broadcasters = [pool.submit(_rpc_broadcast_lane, lifecycle.nodes[0], lane, start_event)
                                for lane in lanes]
                started_ns = artifact.monotonic_ns()
                start_event.set()
                try:
                    offered = [row for future in broadcasters for row in future.result()]
                    offer_end_ns = artifact.monotonic_ns()
                    drain_deadline = min(lifecycle.deadline,
                        offer_end_ns + V3_CHAIN_DRAIN_SECONDS * 10**9)
                    while True:
                        lifecycle.remaining()
                        if artifact.monotonic_ns() >= drain_deadline:
                            raise TimeoutError("native v3 chain profile exceeded its fixed drain cap")
                        pending = [validate_mempool_sample(lifecycle.query(node, "/num_unconfirmed_txs"))["transactions"]
                                   for node in lifecycle.nodes]
                        if not any(pending):
                            break
                        time.sleep(.1)
                    current_height = lifecycle.wait_height(1)
                    final_height = lifecycle.wait_height(current_height + 2)
                    drain_end_ns = artifact.monotonic_ns()
                finally:
                    stop_event.set()
                mempool_samples = monitor.result()
            after_cpu = validator_cpu_snapshot(lifecycle)
            capture_workload_metrics(lifecycle, after_phase, fenced=True, finalize_block=True)
        finally:
            artifact.stop_owned_process_groups(commit_processes)
        summarize_commit_streams(lifecycle, commit_processes, stream_key=stream_key,
                                 before_phase=before_phase, after_phase=after_phase)
        if len(offered) != len(frozen) or {row["txhash"] for row in offered} != {row["txhash"] for row in frozen}:
            raise ValueError("direct CheckTx outcomes differ from the frozen profile inventory")
        committed, blocks = _discover_frozen_commits(
            lifecycle, frozen, predecessor_height, final_height)
        block_path = lifecycle.home / f"native-v3-chain-{profile['name']}-blocks.jsonl"
        consensus_observations = []
        reconcile_transaction_blocks(lifecycle, committed, predecessor_height, final_height, block_path,
                                     consensus_observations=consensus_observations)
        final_sequences = provider_sequences(lifecycle, providers, final_height)
        for address, before in quiescence["sequences"].items():
            expected = sum(row["signer"] == address for row in frozen)
            if (final_sequences[address]["account_number"] != before["account_number"] or
                    final_sequences[address]["sequence"] - before["sequence"] != expected):
                raise ValueError("provider sequence changed outside the accepted profile inventory")
        if (final_height - 1) // epoch_length + 1 != ready_epoch:
            raise ValueError("native v3 chain capacity profile crossed an audit epoch")
        if audits(final_height, False, ready_epoch) != current_audits:
            raise ValueError("audit authority or coverage changed during the capacity profile")
        profile_sessions = sessions[profile["session_start"]:profile["session_end"]]
        for row, state in zip(profile_sessions,
                              v3_session_queries(lifecycle, profile_sessions, final_height)):
            _, accepted = validate_v3_session(state, session_id=row["session_id"], deal_id=deal["id"],
                owner=owner, providers=providers, nonce=row["nonce"], polyfs_root=root, integrity_root=integrity,
                chain_id=lifecycle.chain, deadline_height=row["deadline_height"], range_start=row["range_start"],
                range_length=profile["range_bytes"])
            expected = sorted(ordinal for message in inventory["messages"]
                              if message["session_index"] == row["session_index"]
                              for ordinal in message["ordinals"])
            if accepted != expected or len(accepted) != profile["sample_count"]:
                raise ValueError("four-validator session bitmap differs from the frozen proof set")
            row["accepted_sample_ordinals"] = accepted
        metrics = native_v3_capacity_metrics(profile, offered, committed, blocks,
            started_ns, offer_end_ns, drain_end_ns, mempool_samples,
            validator_gomaxprocs=int(lifecycle.env["GOMAXPROCS"]))
        metrics["resource_utilization"] = summarize_native_v3_resources(
            [row["resources"] for row in mempool_samples if row["resources"] is not None])
        saturated = metrics["saturated_commit_interval"]
        consensus = summarize_consensus_commits(consensus_observations,
            saturated["first_height"], saturated["last_height"])
        cpu_delta = validator_cpu_delta(before_cpu, after_cpu)
        cpu_delta["measurement_scope"] = "direct broadcast through all-validator mempool drain"
        finalize_blocks = [dict(node_id=row["node_id"], summary=row["finalize_block_precise"])
                           for row in lifecycle.doc[stream_key]]
        if issue_251_candidate:
            qualification = native_v3_issue_251_qualification(
                metrics, finalize_blocks, consensus, len(offered), len(committed),
                lifecycle.doc["profile"]["comet_mempool"]["size"],
                lifecycle.doc["profile"]["memory_ceiling_per_validator_bytes"])
        else:
            qualification = {"qualified": False,
                "reason": "only the exact 160M/7,680-session batch profile is issue #251 qualification"}
        measurement.update(status="passed", offered=offered, committed=committed,
            provider_sequences_after=final_sequences, validator_cpu_delta=cpu_delta,
            blocks=dict(path=str(block_path), sha256=artifact.sha256(block_path)), metrics=metrics,
            consensus=consensus, finalize_block_precise=finalize_blocks,
            issue_251_qualification=qualification)
        lifecycle.save()
        doc.pop("qualification_error", None)
        if issue_251_candidate and not qualification["qualified"]:
            measurement["status"] = "qualification_failed"
            doc["qualification_error"] = (
                "issue #251 qualification gates failed: " + "; ".join(qualification["reasons"]))
    expected_transactions = sum(row["measured_transactions"] for row in profiles)
    doc.update(status=("native_v3_chain_capacity_qualification_pending_restart"
                       if issue_251_candidate else "native_v3_chain_capacity_passed"),
        qualification=not issue_251_candidate,
        offered_proof_transactions=expected_transactions,
        committed_valid_proof_transactions=expected_transactions,
        committed_logical_proof_messages=expected_messages,
        sampled_chained_proofs=sum(row["sample_count"] * row["sessions"] for row in profiles),
        kzg_opening_verifications=(
            2 * sum(row["sample_count"] * row["sessions"] for row in profiles)),
        delivery_verified=False, owner_acknowledged=False, expiration_verified=False,
        refunds_verified=False)
    lifecycle.save()


def validate_native_v3_candidate_restart(lifecycle, wait, audits, epoch_length):
    fixed_height = lifecycle.wait_height(1) - 1
    before_restart = lifecycle.snapshot(fixed_height)
    lifecycle.stop()
    lifecycle.reserve_ports()
    lifecycle.start("post-qualification-restart")
    later = wait(fixed_height + 3) - 1
    original = lifecycle.snapshot(fixed_height)
    if original != before_restart:
        raise ValueError("post-qualification restart changed the fixed committed state")
    consensus = []
    expected_block = lifecycle.doc["profile"]["consensus"]["block"]
    for node in lifecycle.nodes:
        params = lifecycle.query(node, "/cosmos/consensus/v1/params", later)["params"]["block"]
        if {key: params[key] for key in ("max_bytes", "max_gas")} != expected_block:
            raise ValueError("post-qualification consensus profile changed")
        consensus.append(dict(node_id=node["node_id"], block=params))
    restart_epoch = (later - 1) // epoch_length + 2
    audit_height = wait((restart_epoch - 1) * epoch_length + 2)
    restart_audits = None
    for _ in range(21):
        restart_audits = audits(audit_height, False, restart_epoch)
        if sum(producer.uint(row["audit"].get("accepted_count", 0))
               for row in restart_audits.values()) > 0:
            break
        audit_height = wait(audit_height + 1)
    else:
        raise ValueError("normal audit proof did not execute after validator restart")
    return dict(fixed_height=fixed_height, later_height=later, audit_height=audit_height,
        before=before_restart, original_after_restart=original,
        later=lifecycle.snapshot(later), consensus=consensus, normal_audits=restart_audits,
        nonce_ordered_admission=(f"all {V3_ISSUE_251_QUALIFICATION_TRANSACTIONS} frozen "
                                 "per-signer batch sequences committed exactly once before restart"),
        chain_progress_verified=True, qualification=True)


def finalize_native_v3_candidate(lifecycle, wait, audits, epoch_length):
    doc = lifecycle.doc["native_v3_chain"]
    qualification_error = doc.get("qualification_error")
    doc["qualification"] = False
    lifecycle.save()
    try:
        restart = validate_native_v3_candidate_restart(lifecycle, wait, audits, epoch_length)
    except Exception as restart_error:
        doc["post_qualification_restart"] = dict(
            qualification=False, error=str(restart_error)[-8192:])
        doc["status"] = ("native_v3_chain_capacity_qualification_failed"
                         if qualification_error else "native_v3_chain_capacity_restart_failed")
        lifecycle.save()
        if qualification_error:
            raise ValueError(qualification_error) from restart_error
        raise
    doc["post_qualification_restart"] = restart
    if qualification_error:
        doc["status"] = "native_v3_chain_capacity_qualification_failed"
        lifecycle.save()
        raise ValueError(qualification_error)
    doc["qualification"] = True
    doc["status"] = "native_v3_chain_capacity_passed"
    lifecycle.save()

def admit_native_v3_generation(lifecycle, *, uploaded, deal_id, providers, send, curl,
                               file_bytes=V3_PILOT_BYTES, evidence_key="native_v3_generation",
                               http_phase="generation-acceptance"):
    """Use only the owner CLI and production provider admission routes."""
    candidate = validate_v3_candidate(uploaded, deal_id=deal_id, file_bytes=file_bytes)
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
    outcomes = run_v3_http_phase(lifecycle, curl, requests, http_phase, max_in_flight=12,
                                 retry_pre_admission_busy=True)
    seen, transactions = set(), []
    for outcome in outcomes:
        slot = producer.uint(outcome.get("slot", 99))
        txhash = outcome.get("tx_hash", "")
        if (outcome.get("status") != "success" or outcome.get("cleanup_status") != "complete" or
                outcome.get("http_status") != 200 or outcome.get("curl_returncode") != 0 or
                slot >= 12 or providers.get(slot) != outcome["provider"] or
                slot in seen or not re.fullmatch(r"[0-9a-fA-F]{64}", txhash)):
            raise ValueError(
                "provider generation acceptance was not a unique committed success: "
                f"provider={str(outcome.get('provider'))[:128]!r} "
                f"slot={str(outcome.get('slot'))[:32]!r} "
                f"http_status={str(outcome.get('http_status'))[:32]!r} "
                f"status={str(outcome.get('status'))[:128]!r} "
                f"error={str(outcome.get('error'))[:256]!r}")
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
    validate_v3_generation(pending, candidate, providers, owner=owner, admitted=False,
                           file_bytes=file_bytes)
    finalized = send("owner0", ["finalize-deal-generation-v3", "--deal-id", deal_id,
                                "--generation", "1", "--polyfs-root", candidate["polyfs_root"]])
    finalized["validators"] = verify_transaction_nodes(lifecycle, finalized)
    lifecycle.wait_height(finalized["height"] + 1)
    admitted = lifecycle.query(lifecycle.nodes[0], API + f"/deals/{deal_id}/generation-v3", finalized["height"])
    validate_v3_generation(admitted, candidate, providers, owner=owner, admitted=True,
                           file_bytes=file_bytes)
    lifecycle.doc[evidence_key] = dict(candidate=candidate, proposal_transaction=proposed,
        provider_outcomes=outcomes, acceptance_transactions=transactions,
        finalize_transaction=finalized, admitted=admitted)
    lifecycle.save()
    return candidate, finalized["height"]


def set_public_retrieval_policy(lifecycle, *, deal_id, command, directory_name="browser-public-policy",
                                evidence_key="browser_public_policy"):
    """Sign one owner policy message through the SDK's generic JSON transaction path."""
    owner = lifecycle.signers["owner0"]
    directory = lifecycle.home / directory_name
    directory.mkdir(mode=0o700)
    unsigned, signed = directory / "unsigned.jsonl", directory / "signed.json"
    template_job = transaction_job(lifecycle, owner,
        ["create-deal", "1", "1", "1", "--service-hint", "browser-policy-envelope"],
        kind="retrieval-policy", gas="500000")
    template = json.loads(command([*template_job["submit"], "--generate-only"]))
    messages = template.get("body", {}).get("messages", [])
    if len(messages) != 1:
        raise ValueError("policy envelope generation returned unexpected messages")
    intended = {
        "@type": "/polystorechain.polystorechain.v1.MsgUpdateDealRetrievalPolicy",
        "creator": owner,
        "deal_id": str(producer.uint(deal_id)),
        "policy": {"mode": "RETRIEVAL_POLICY_MODE_PUBLIC", "allowlist_root": None, "voucher_signer": ""},
    }
    template["body"]["messages"] = [intended]
    unsigned.write_text(json.dumps(template, separators=(",", ":")) + "\n")
    node = lifecycle.nodes[0]
    common = ["--home", node["home"], "--node", f'http://127.0.0.1:{node["rpc"]}',
              "--keyring-backend", "test", "--chain-id", lifecycle.chain]
    command([str(lifecycle.binary), "tx", "sign-batch", str(unsigned), "--append", "--from", owner,
             *common, "--output-document", str(signed)])
    signed_value = json.loads(signed.read_text())
    if signed_value.get("body", {}).get("messages") != [intended] or len(signed_value.get("signatures", [])) != 1:
        raise ValueError("signed retrieval policy transaction differs from owner intent")
    job = dict(template_job, submit=[str(lifecycle.binary), "tx", "broadcast", str(signed), *common,
                                    "--broadcast-mode", "sync", "--output", "json"])
    result = artifact.scheduled_transaction(job)
    if result["outcome"] != "committed_success":
        raise ValueError("PUBLIC retrieval policy transaction did not commit")
    result["validators"] = verify_transaction_nodes(lifecycle, result)
    decoded = json.loads(lifecycle.cli(node["home"], "query", "tx", result["txhash"], "--output", "json"))
    if decoded.get("tx", {}).get("body", {}).get("messages") != [intended]:
        raise ValueError("committed retrieval policy message differs from signed intent")
    lifecycle.wait_height(result["height"] + 1)
    deal = lifecycle.query(node, API + f"/deals/{deal_id}", result["height"])["deal"]
    policy = deal.get("retrieval_policy", {})
    if (policy.get("mode") != "RETRIEVAL_POLICY_MODE_PUBLIC" or
            policy.get("allowlist_root", "") not in ("", None) or
            policy.get("voucher_signer", "") not in ("", None)):
        raise ValueError("committed retrieval policy is not unqualified PUBLIC")
    evidence = dict(transaction=result, message=intended, authoritative_policy=policy)
    lifecycle.doc[evidence_key] = evidence
    lifecycle.save()
    return evidence


def browser_http_preflight(lifecycle, origin):
    """Check the browser's actual REST and JSON-RPC CORS contract before ingest."""
    node = lifecycle.nodes[0]
    lcd = f'http://127.0.0.1:{node["api"]}{API}/params'
    evm_params = f'http://127.0.0.1:{node["api"]}/cosmos/evm/vm/v1/params'
    evm = f'http://127.0.0.1:{node["evm_rpc"]}'
    checks = []
    for url, method, headers, data in (
        (lcd, "GET", {}, None),
        (evm_params, "GET", {}, None),
        (evm, "OPTIONS", {"Access-Control-Request-Method": "POST",
                          "Access-Control-Request-Headers": "content-type"}, None),
        (evm, "POST", {"Content-Type": "application/json"},
         b'{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'),
    ):
        request = urllib.request.Request(url, method=method, headers={"Origin": origin, **headers}, data=data)
        with urllib.request.urlopen(request, timeout=min(5, lifecycle.remaining())) as response:
            body = response.read(1_048_577)
            allow_origin = response.headers.get("Access-Control-Allow-Origin")
            if not 200 <= response.status < 300 or len(body) > 1_048_576 or allow_origin not in (origin, "*"):
                raise ValueError(f"browser HTTP preflight failed for {method} {url}: missing CORS or invalid response")
            if method == "OPTIONS":
                methods = response.headers.get("Access-Control-Allow-Methods", "").upper().replace(" ", "").split(",")
                allowed = response.headers.get("Access-Control-Allow-Headers", "").lower().replace(" ", "").split(",")
                if "POST" not in methods or "content-type" not in allowed:
                    raise ValueError("browser JSON-RPC preflight does not allow POST application/json")
            else:
                value = json.loads(body)
                if not isinstance(value, dict) or (method == "GET" and not isinstance(value.get("params"), dict)) or \
                        (method == "POST" and value.get("result") != "0x40000"):
                    raise ValueError("browser endpoint returned the wrong chain or REST schema")
                if url == evm_params and "0x0000000000000000000000000000000000000900" not in \
                        value["params"].get("active_static_precompiles", []):
                    raise ValueError("browser chain has not activated the PolyStore EVM precompile")
            checks.append(dict(url=url, method=method, status=response.status, allow_origin=allow_origin))
    return dict(origin=origin, checks=checks)


def run_browser_executor_handoff(lifecycle, *, source, browser_env, faults, check_providers):
    """Publish and await the fixed Mac LAN browser request while the server stack stays owned."""
    request_path = lifecycle.home / "browser-executor-request.json"
    lifecycle.remaining()
    timeout_seconds = max(1, min(3600,
        int((lifecycle.deadline - artifact.monotonic_ns()) / 1e9)))
    request = artifact.create_browser_executor_request(request_path, source=source,
        source_head=lifecycle.doc["provenance"]["product_source_commit"],
        source_status=lifecycle.doc["provenance"]["product_source_status"], env=browser_env,
        timeout_seconds=timeout_seconds,
        browser_bytes=lifecycle.doc["payload"]["bytes"], faults=faults)
    response_path = request_path.with_name("browser-executor-response.json")
    lifecycle.doc["browser_executor"] = dict(request=str(request_path), request_id=request["id"],
        source_head=request["head"], qualification_scope=artifact.BROWSER_EXECUTOR_SCOPE)
    lifecycle.save()
    print(json.dumps({"phase": "browser-executor-await", "request": str(request_path),
                      "source_head": request["head"]}, sort_keys=True), flush=True)
    last_heartbeat = artifact.monotonic_ns()
    try:
        while not response_path.is_file():
            check_providers()
            lifecycle.remaining()
            now = artifact.monotonic_ns()
            if now - last_heartbeat >= 60 * 10**9:
                heartbeat = {"phase": "browser-executor-await", "request_id": request["id"]}
                lifecycle.doc.setdefault("progress", []).append(heartbeat)
                lifecycle.save()
                print(json.dumps(heartbeat, sort_keys=True), flush=True)
                last_heartbeat = now
            time.sleep(min(0.25, lifecycle.remaining()))
        result, memory, response = artifact.read_browser_executor_response(request_path)
        lifecycle.doc["browser_executor"]["response"] = response
        lifecycle.save()
        return result, memory
    except BaseException as error:
        artifact.write_browser_executor_cancel(request_path, error)
        raise


def run_native_v3_browser(lifecycle, *, gateway, source, deal, browser_ports, command,
                          processes, check_providers, faults=False, executor_handoff=False,
                          diagnostics=False):
    """Run one real sponsored DealDetail retrieval through the owned browser stack."""
    website = source / "polystore-website"
    vite = website / "node_modules/.bin/vite"
    playwright = website / "node_modules/.bin/playwright"
    wasm = website / "public/wasm/polystore_core_bg.wasm"
    for path in (vite, playwright, wasm):
        if not path.is_file():
            raise ValueError(f"browser qualification dependency is missing: {path}")
    gateway_port = browser_ports["gateway"]
    website_port = browser_ports["website"]
    gateway_base = f"http://127.0.0.1:{gateway_port}"
    directory = lifecycle.home / "user-gateway"
    directory.mkdir(mode=0o700)
    gateway_env = dict({key: value for key, value in lifecycle.env.items() if not key.startswith("POLYSTORE_")},
        POLYSTORE_RUNTIME_PERSONA="user-gateway", POLYSTORE_GATEWAY_ROUTER="1",
        POLYSTORE_GATEWAY_ROUTER_MODE="1", POLYSTORE_TRUSTED_SETUP=lifecycle.env["POLYSTORE_TRUSTED_SETUP"],
        POLYSTORE_HOME=lifecycle.nodes[0]["home"], POLYSTORE_CHAIN_ID=lifecycle.chain,
        POLYSTORE_NODE=f'http://127.0.0.1:{lifecycle.nodes[0]["rpc"]}',
        POLYSTORE_LCD_BASE=f'http://127.0.0.1:{lifecycle.nodes[0]["api"]}',
        POLYSTORECHAIND_BIN=str(lifecycle.binary), POLYSTORE_CLI_BIN=str(source / "polystore_cli/target/release/polystore_cli"),
        POLYSTORE_ROOT_DIR=str(source), POLYSTORE_GAS_PRICES=artifact.BROWSER_EVM_NATIVE_GAS_PRICES,
        POLYSTORE_UPLOAD_DIR=str(directory), POLYSTORE_SESSION_DB_PATH=str(directory / "sessions.db"),
        POLYSTORE_LISTEN_ADDR=f"127.0.0.1:{gateway_port}", POLYSTORE_P2P_ENABLED="0",
        POLYSTORE_GATEWAY_SP_AUTH=V3_PROVIDER_AUTH_TOKEN, POLYSTORE_CMD_TIMEOUT_SECONDS="120")
    if diagnostics:
        gateway_env["POLYSTORE_RETRIEVAL_DIAGNOSTICS"] = "1"
    # The supplied native CLI may be outside the source checkout.
    gateway_env["POLYSTORE_CLI_BIN"] = lifecycle.doc["provenance"]["cli_binary"]
    browser_ports["gateway_reservation"].close()
    with (directory / "gateway.log").open("xb") as log:
        process = subprocess.Popen([str(gateway)], cwd=directory, env=gateway_env, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
    processes.append(process)
    while True:
        check_providers()
        try:
            value = json.loads(command([lifecycle.doc["provenance"]["curl_binary"], "--silent", "--show-error",
                "--fail", "--max-time", "2", gateway_base + "/status"], 3))
        except (json.JSONDecodeError, ValueError):
            time.sleep(min(0.2, lifecycle.remaining()))
            continue
        if (not isinstance(value, dict) or value.get("persona") != "user-gateway" or
                value.get("allowed_route_families") != ["gateway"]):
            raise ValueError("owned browser gateway did not publish the canonical user-gateway status")
        status = value
        break

    browser_env = dict(os.environ, VITE_E2E="1", VITE_ENABLE_FAUCET="0", VITE_DISABLE_GATEWAY="0",
        VITE_P2P_ENABLED="0", VITE_LCD_BASE=f'http://127.0.0.1:{lifecycle.nodes[0]["api"]}',
        VITE_GATEWAY_BASE=gateway_base, VITE_SP_BASE="http://127.0.0.1:19091",
        VITE_EVM_RPC=f'http://127.0.0.1:{lifecycle.nodes[0]["evm_rpc"]}',
        VITE_CHAIN_ID="262144", VITE_COSMOS_CHAIN_ID=lifecycle.chain,
        E2E_BASE_URL=f"http://127.0.0.1:{website_port}", E2E_NATIVE_V3_BROWSER="1",
        E2E_NATIVE_V3_DEAL_ID=str(deal["id"]), E2E_NATIVE_V3_PAYER=V3_BROWSER_PAYER,
        E2E_NATIVE_V3_FILE="payload.bin", E2E_NATIVE_V3_BYTES=str(lifecycle.doc["payload"]["bytes"]),
        E2E_NATIVE_V3_SHA256=lifecycle.doc["payload"]["sha256"], E2E_NATIVE_V3_EXPIRY="0",
        E2E_NATIVE_V3_FAULTS="1" if faults else "0")
    suffix = "-faults" if faults else ""
    result_path = lifecycle.home / f"native-v3-browser{suffix}-result.json"
    browser_env["E2E_NATIVE_V3_RESULT"] = str(result_path)
    browser_ports["website_reservation"].close()
    with (lifecycle.home / "website.log").open("xb") as log:
        process = subprocess.Popen([str(vite), "--host", "127.0.0.1", "--port", str(website_port), "--strictPort"],
            cwd=website, env=browser_env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    processes.append(process)
    while True:
        check_providers()
        try:
            command([lifecycle.doc["provenance"]["curl_binary"], "--silent", "--show-error", "--fail",
                     "--max-time", "2", f"http://127.0.0.1:{website_port}/"], 3)
            break
        except ValueError:
            time.sleep(min(0.2, lifecycle.remaining()))
    before_height = lifecycle.wait_height(1) - 1
    before = browser_v3_snapshot(lifecycle, before_height, deal)
    argv = [str(playwright), "test", "tests/native-v3-browser-live.spec.ts", "--workers=1", "--retries=0",
            "--max-failures=1",
            "--output", str(lifecycle.home / f"browser{suffix}-results")]
    if executor_handoff:
        result, memory = run_browser_executor_handoff(lifecycle, source=source,
            browser_env=browser_env, faults=faults, check_providers=check_providers)
    else:
        result, memory = artifact.run_bounded_browser_command(argv, lifecycle.deadline,
            lifecycle.home / f"browser{suffix}-memory.json", env=browser_env, cwd=website)
    stdout = lifecycle.home / f"playwright{suffix}.stdout.log"
    stderr = lifecycle.home / f"playwright{suffix}.stderr.log"
    stdout.write_text(result.stdout)
    stderr.write_text(result.stderr)
    if result.returncode:
        raise ValueError("native V3 browser qualification failed: " + (result.stderr + result.stdout)[-8192:])
    check_providers()
    observed = lifecycle.wait_height(1)
    lifecycle.wait_height(observed + 1)
    outcome = json.loads(result_path.read_text())
    if not isinstance(outcome, dict) or outcome.get("success") is not True:
        raise ValueError("browser test did not retain successful qualification evidence")
    validate_browser_cache_mdu_requests(outcome)
    sid = producer.b64(outcome["session"]["session_id"], 32).hex()
    after = browser_v3_snapshot(lifecycle, observed, deal, session_id=sid)
    if faults:
        validate_native_v3_browser_fault_outcome(outcome, after["retrieval"]["sessions"][sid],
            lifecycle.doc["payload"])
    issued = collect_issuance(lifecycle, before, after)
    receipts = browser_v3_committed_receipts(lifecycle, outcome["evmReceipts"])
    rpc_transactions = outcome.get("evmTransactions")
    if (not isinstance(rpc_transactions, list) or len(rpc_transactions) != len(receipts) or
            any(not isinstance(row, dict) or not isinstance(row.get("hash"), str) for row in rpc_transactions) or
            {row["hash"].lower() for row in rpc_transactions} !=
            {row["receipt"]["transactionHash"].lower() for row in receipts}):
        raise ValueError("browser Ethereum transactions differ from committed receipts")
    proof_transactions, proof_outcomes = [], []
    for index, observed_proof in enumerate(outcome["providerProofOutcomes"]):
        row = dict(observed_proof["body"], request_id=f"browser-proof-{index}")
        slot = producer.uint(row["slot"])
        obligations = after["retrieval"]["sessions"][sid]["obligations"]
        matches = [o for o in obligations if producer.uint(o["slot"]) == slot]
        if len(matches) != 1:
            raise ValueError("browser proof targets an unrepresented obligation")
        row["provider"] = matches[0]["assigned_provider"]
        proof_transactions.append(committed_v3_http_tx(lifecycle, row, kind="session-proof",
            creator=row["provider"], slot=slot, session_id=sid, proof_count=producer.uint(row["proof_count"])))
        proof_outcomes.append(row)
    phases = validate_v3_provider_phase_timings(proof_outcomes, proof_transactions)
    if not phases["qualification"]:
        raise ValueError("browser provider phases lack canonical receipts: " + "; ".join(phases["reasons"]))
    ordinals = sorted(ordinal for tx in proof_transactions for ordinal in tx["ordinals"])
    if ordinals != list(range(producer.uint(after["retrieval"]["sessions"][sid]["sample_count"]))):
        raise ValueError("browser proof receipts do not cover each sampled ordinal exactly once")
    economics = verify_browser_v3_economics(before, after, session_id=sid, receipts=receipts,
                                           issued_stake=issued, signers=lifecycle.signers)
    browser_phases = None
    if not faults:
        paid_count = artifact.integer(outcome["paidDiagnosticCount"], "paid diagnostic count", 1,
                                      len(outcome["diagnostics"]))
        browser_phases = browser_phase_intervals(outcome["diagnostics"][:paid_count])
    evidence = dict(diagnostics_enabled=diagnostics,
        gateway=dict(pid=processes[-2].pid, base=gateway_base, status=status,
                                 log=str(directory / "gateway.log")),
        website=dict(pid=processes[-1].pid, base=browser_env["E2E_BASE_URL"], log=str(lifecycle.home / "website.log")),
        playwright=dict(command=getattr(result, "args", argv), stdout=str(stdout), stderr=str(stderr),
                        result=str(result_path), outcome=outcome,
                        memory=memory),
        economics=dict(before=before, after=after, **economics), evm_transactions=receipts,
        evm_rpc_transactions=rpc_transactions, proof_transactions=proof_transactions,
        provider_phases=phases)
    if browser_phases is not None:
        evidence["browser_phases"] = browser_phases
    lifecycle.doc["native_v3_browser_faults" if faults else "native_v3_browser"] = evidence
    lifecycle.save()
    return evidence


def validate_browser_cache_mdu_requests(outcome):
    evidence = outcome.get("cacheMduRequests") if isinstance(outcome, dict) else None
    keys = {"gatewayMetadata", "gatewayData", "directMetadata", "directData"}
    if (not isinstance(evidence, dict) or set(evidence) != {"before", "after"} or
            not all(isinstance(row, dict) and set(row) == keys and
                    all(type(value) is int and value >= 0 for value in row.values())
                    for row in evidence.values()) or evidence["before"] != evidence["after"]):
        raise ValueError("settled cache retrieval performed additional MDU requests")
    return evidence


def validate_native_v3_browser_fault_outcome(outcome, session, payload):
    """Validate the retained one-session fault, resume and cache evidence."""
    planned = outcome.get("planned")
    keys = {"corrupt", "multipart-order", "truncate"}
    deliveries = outcome.get("faultDeliveries")
    snapshots = outcome.get("faultSnapshots")
    expected_file = {"bytes": 16 * 1024 * 1024 + 1, "sha256": payload["sha256"]}
    if (outcome.get("stage") != "settled-cache" or payload.get("bytes") != expected_file["bytes"] or
            outcome.get("downloaded") != expected_file or outcome.get("cached") != expected_file or
            outcome.get("session") != session or not isinstance(planned, dict) or
            [planned.get("population"), planned.get("sampleCount")] != ["133", "132"] or
            not isinstance(planned.get("chunks"), list) or len(planned["chunks"]) != 21 or
            not isinstance(planned.get("unsampled"), list) or len(planned["unsampled"]) != 1 or
            outcome.get("targetT") != planned["unsampled"][0] or
            not isinstance(outcome.get("targetChunk"), dict) or outcome["targetChunk"] not in planned["chunks"] or
            not isinstance(outcome["targetChunk"].get("entries"), list) or
            outcome["targetT"] not in outcome["targetChunk"]["entries"] or
            outcome.get("targetBlob") != outcome["targetChunk"]["entries"].index(outcome["targetT"]) or
            not isinstance(deliveries, dict) or
            set(deliveries) != keys or any(producer.uint(value) < 1 for value in deliveries.values()) or
            not isinstance(snapshots, dict) or set(snapshots) != keys):
        raise ValueError("browser fault result lacks the bounded planner, fault or payload evidence")
    sid = producer.b64(session["session_id"], 32).hex()
    nonce = planned.get("nonce")
    checkpoints = [planned, outcome.get("durableCheckpoint"), *snapshots.values()]
    planned_sid = planned.get("sessionId")
    if (not isinstance(planned_sid, str) or planned_sid.removeprefix("0x").lower() != sid or
            any(not isinstance(row, dict) or row.get("sessionId") != planned["sessionId"] or
                row.get("nonce") != nonce for row in checkpoints)):
        raise ValueError("browser fault recovery changed the frozen session or nonce")
    receipts, transactions = outcome.get("evmReceipts"), outcome.get("evmTransactions")
    obligations = session.get("obligations")
    raw = outcome.get("rawTransactions")
    guards = outcome.get("phaseGuards")
    if (not isinstance(obligations, list) or not isinstance(receipts, list) or
            not isinstance(transactions, list) or raw != len(obligations) + 1 or
            type(raw) is not int or len(receipts) != raw or len(transactions) != raw or
            any(not isinstance(row, dict) for row in receipts + transactions) or
            {row.get("hash", "").lower() for row in transactions} !=
            {row.get("transactionHash", "").lower() for row in receipts} or
            producer.uint(outcome.get("rawTransactionAttempts", 0)) < raw or
            guards != {"openedSessions": 1, "acknowledgedObligations": len(obligations),
                       "targetVerifiedChunks": 1}):
        raise ValueError("browser fault result lacks one canonical open and obligation ACK lifecycle")
    before_nonce = producer.uint(outcome.get("before", {}).get("nonce", {}).get("nonce", ""), 256)
    after_unknown = outcome.get("afterUnknown", {}).get("nonce")
    if (after_unknown != outcome.get("after", {}).get("nonce") or
            not isinstance(after_unknown, dict) or not after_unknown.get("found") or
            producer.uint(after_unknown.get("nonce", ""), 256) != before_nonce + 1):
        raise ValueError("browser fault recovery opened more than one paid session")
    final_counts = {"data": outcome.get("dataRequests"), "target": outcome.get("targetRequests"), "raw": raw}
    before_reopen = outcome.get("requestsBeforeReopen")
    durability = outcome.get("resultDurability")
    if (outcome.get("requestsBeforeCache") != final_counts or not isinstance(before_reopen, dict) or
            before_reopen.get("target") != final_counts["target"] or
            producer.uint(before_reopen.get("data", 0)) > producer.uint(final_counts["data"]) or
            outcome.get("localState") != {"checkpoints": 1, "unbound": 0, "journals": []} or
            not isinstance(durability, dict) or durability.get("atomicReplace") is not True or
            durability.get("verifiedStages") != ["unknown-open", "corrupt", "multipart-order", "truncate",
                                                   "durable-before-reopen", "settled-cache"]):
        raise ValueError("browser fault result lacks durable resume or zero-I/O cache evidence")


def run_native_v3_browser_expiry(lifecycle, *, source, deal, browser_ports, payload,
                                 check_providers):
    """Run the short-deal refund case through the already-owned browser stack."""
    website = source / "polystore-website"
    playwright = website / "node_modules/.bin/playwright"
    result_path = lifecycle.home / "native-v3-browser-expiry-result.json"
    browser_env = dict(os.environ, VITE_E2E="1", VITE_ENABLE_FAUCET="0", VITE_DISABLE_GATEWAY="0",
        VITE_P2P_ENABLED="0", VITE_LCD_BASE=f'http://127.0.0.1:{lifecycle.nodes[0]["api"]}',
        VITE_GATEWAY_BASE=f'http://127.0.0.1:{browser_ports["gateway"]}', VITE_SP_BASE="http://127.0.0.1:19091",
        VITE_EVM_RPC=f'http://127.0.0.1:{lifecycle.nodes[0]["evm_rpc"]}',
        VITE_CHAIN_ID="262144", VITE_COSMOS_CHAIN_ID=lifecycle.chain,
        E2E_BASE_URL=f'http://127.0.0.1:{browser_ports["website"]}', E2E_NATIVE_V3_BROWSER="1",
        E2E_NATIVE_V3_EXPIRY="1", E2E_NATIVE_V3_DEAL_ID=str(deal["id"]),
        E2E_NATIVE_V3_PAYER=V3_BROWSER_PAYER, E2E_NATIVE_V3_FILE="payload.bin",
        E2E_NATIVE_V3_BYTES=str(payload["bytes"]), E2E_NATIVE_V3_SHA256=payload["sha256"],
        E2E_NATIVE_V3_RESULT=str(result_path))
    before_height = lifecycle.wait_height(1) - 1
    before = browser_v3_snapshot(lifecycle, before_height, deal)
    remaining = producer.uint(before["retrieval"]["deals"][str(deal["id"])]["end_block"]) - before_height
    if not 60 <= remaining <= 180:
        raise ValueError("short browser deal lacks the required 60..180 block opening window")
    argv = [str(playwright), "test", "tests/native-v3-browser-live.spec.ts", "--workers=1", "--retries=0",
            "--max-failures=1",
            "--output", str(lifecycle.home / "browser-expiry-results")]
    result, memory = artifact.run_bounded_browser_command(argv, lifecycle.deadline,
        lifecycle.home / "browser-expiry-memory.json", env=browser_env, cwd=website)
    stdout = lifecycle.home / "playwright-expiry.stdout.log"
    stderr = lifecycle.home / "playwright-expiry.stderr.log"
    stdout.write_text(result.stdout)
    stderr.write_text(result.stderr)
    if result.returncode:
        raise ValueError("native V3 browser expiry qualification failed: " + (result.stderr + result.stdout)[-8192:])
    check_providers()
    outcome = json.loads(result_path.read_text())
    if (not isinstance(outcome, dict) or outcome.get("success") is not True or outcome.get("stage") != "refunded" or
            outcome.get("strictExpiryObserved") is not True or outcome.get("rawTransactions") != 2 or
            outcome.get("retryMduRequests") != outcome.get("retryMduRequestsBeforeRefund")):
        raise ValueError("browser expiry test did not retain strict refund evidence")
    sid = outcome.get("requestedSessionId", "").removeprefix("0x").lower()
    if not re.fullmatch(r"[0-9a-f]{64}", sid):
        raise ValueError("browser expiry result has an invalid requested session identity")
    observed = producer.uint(outcome["afterRefund"]["height"])
    lifecycle.wait_height(observed + 1)
    after = browser_v3_snapshot(lifecycle, observed, deal, session_id=sid)
    authoritative = after["retrieval"]["sessions"][sid]
    if outcome.get("session") != authoritative or producer.b64(authoritative["session_id"], 32).hex() != sid:
        raise ValueError("browser expiry result differs from all-validator final session state")
    issued = collect_issuance(lifecycle, before, after)
    receipts = browser_v3_committed_receipts(lifecycle, outcome.get("evmReceipts"))
    transactions = outcome.get("evmTransactions")
    if (not isinstance(transactions, list) or len(transactions) != len(receipts) or
            {row.get("hash", "").lower() for row in transactions} !=
            {row["receipt"]["transactionHash"].lower() for row in receipts}):
        raise ValueError("browser expiry transactions differ from committed receipts")
    economics = verify_browser_v3_refund_economics(before, after, session_id=sid, receipts=receipts,
        issued_stake=issued, signers=lifecycle.signers, outcome=outcome)
    evidence = dict(playwright=dict(command=argv, stdout=str(stdout), stderr=str(stderr),
        result=str(result_path), outcome=outcome, memory=memory),
        economics=dict(before=before, after=after, **economics), evm_transactions=receipts,
        evm_rpc_transactions=transactions)
    lifecycle.doc["native_v3_browser_expiry"] = evidence
    lifecycle.save()
    return evidence


def prepare_native_v3_browser_expiry(lifecycle, *, main_deal, providers, send, wait, command, curl):
    """Create and admit the isolated 180-block fixture after the main fence."""
    created = send("owner0", ["create-deal", "180", "100000000", "10000000",
        "--service-hint", "General:rs=8+4"])
    wait(created["height"] + 1)
    owned = [row for row in lifecycle.query(lifecycle.nodes[0], API + "/deals", created["height"])["deals"]
             if row["owner"] == lifecycle.signers["owner0"] and str(row.get("id", "0")) != str(main_deal["id"])]
    if len(owned) != 1:
        raise ValueError("expected exactly one new short browser deal")
    identity = str(owned[0].get("id", "0"))
    initial = lifecycle.query(lifecycle.nodes[0], API + "/deals/" + identity, created["height"])["deal"]
    assigned = {producer.uint(row["slot"]): row["provider"] for row in initial["mode2_slots"]
                if row["status"] == "SLOT_STATUS_ACTIVE" and not row.get("pending_provider")}
    if (set(assigned) != set(providers) or set(assigned.values()) != set(providers.values()) or
            len(initial["mode2_slots"]) != len(providers)):
        raise ValueError("short browser deal differs from the owned provider placement")
    directory = lifecycle.home / "native-v3-browser-expiry-fixture"
    directory.mkdir(mode=0o700)
    path = directory / "payload.bin"
    with open(lifecycle.doc["payload"]["path"], "rb") as source_file:
        path.write_bytes(source_file.read(1024))
    payload = dict(path=str(path), bytes=path.stat().st_size, sha256=artifact.sha256(path))
    uploaded = json.loads(command([curl, "--silent", "--show-error", "--fail", "--max-time", "180",
        "--form-string", "owner=" + lifecycle.signers["owner0"], "--form-string", "file_path=payload.bin",
        "--form", "file=@" + str(path),
        provider_http_url(lifecycle, assigned[0],
            f"/sp/retrieval/upload?deal_id={identity}&fat_version=3")], 185))
    candidate, height = admit_native_v3_generation(lifecycle, uploaded=uploaded, deal_id=identity,
        providers=assigned, send=send, curl=curl, file_bytes=1024,
        evidence_key="native_v3_browser_expiry_generation",
        http_phase="browser-expiry-generation-acceptance")
    wait(height + 1)
    deal = lifecycle.query(lifecycle.nodes[0], API + "/deals/" + identity, height)["deal"]
    deal["id"] = identity
    geometry = v3_file_geometry(1024)
    if (producer.b64(deal["manifest_root"], 32).hex() != candidate["polyfs_root"][2:] or
            [producer.uint(deal.get(name, 0)) for name in ("size", "total_mdus", "witness_mdus", "current_gen")] !=
            [geometry["size"], geometry["total_mdus"], geometry["witness_mdus"], 1] or
            deal["mode2_slots"] != initial["mode2_slots"]):
        raise ValueError("finalized short browser deal differs from its admitted fixture")
    policy = set_public_retrieval_policy(lifecycle, deal_id=identity, command=command,
        directory_name="browser-expiry-public-policy", evidence_key="native_v3_browser_expiry_policy")
    fixture = dict(deal=deal, payload=payload, ingest=uploaded, candidate=candidate,
                   create_transaction=created, public_policy=policy)
    lifecycle.doc["native_v3_browser_expiry_fixture"] = fixture
    lifecycle.save()
    return fixture


def browser_v3_snapshot(lifecycle, height, deal, *, session_id=None):
    """Reuse the economic fence and add the sponsor without making it a CLI signer."""
    snapshot = retrieval_snapshot(lifecycle, height, {str(deal["id"]): deal}, [])
    balances = []
    for node in lifecycle.nodes:
        row = {}
        for denom in ("stake", "aatom"):
            coin = lifecycle.query(node,
                f"/cosmos/bank/v1beta1/balances/{V3_BROWSER_PAYER}/by_denom?denom={denom}", height)["balance"]
            if coin["denom"] != denom:
                raise ValueError("browser payer balance denomination mismatch")
            row[denom] = str(producer.uint(coin["amount"], 256))
        balances.append(row)
    if any(row != balances[0] for row in balances[1:]):
        raise ValueError("four validators disagree on pinned browser payer balances")
    snapshot["payer"] = dict(address=V3_BROWSER_PAYER, **balances[0])
    if session_id is not None:
        snapshot["retrieval"]["sessions"][session_id] = v3_session_query(lifecycle, session_id, height)["session"]
    return snapshot


def browser_phase_intervals(events):
    """Report concurrent phase work separately from elapsed time on one page clock."""
    if not isinstance(events, list) or not 1 <= len(events) <= 100_000:
        raise ValueError("browser diagnostic count is outside its bound")
    pending, intervals = {}, {}
    for event in events:
        at = event.get("atMs")
        if type(at) not in (int, float) or not math.isfinite(at) or at < 0:
            raise ValueError("browser phase has an invalid monotonic timestamp")
        edge = event.get("edge")
        if edge is None:
            continue
        key = tuple(event.get(field) for field in ("phase", "sessionId", "chunkId", "slot"))
        if not isinstance(key[0], str) or not key[0]:
            raise ValueError("browser phase identity is missing")
        if edge == "start":
            if key in pending:
                raise ValueError("overlapping browser phase lacks a unique chunk identity")
            pending[key] = at
        elif edge == "end":
            start = pending.pop(key, None)
            if start is None or at < start:
                raise ValueError("browser phase ends without its matching monotonic start")
            intervals.setdefault(key[0], []).append([start, at])
        else:
            raise ValueError("unknown browser diagnostic edge")
    if pending or not intervals:
        raise ValueError("browser phase intervals are incomplete")
    summary = {}
    for phase, ranges in intervals.items():
        merged = []
        for start, end in sorted(ranges):
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        summary[phase] = dict(count=len(ranges), summed_work_ms=sum(b-a for a, b in ranges),
            occupied_elapsed_ms=sum(b-a for a, b in merged), intervals_ms=ranges)
    return dict(phases=summary,
        scope="one browser page monotonic clock; summed work may overlap; phase elapsed unions must not be added together")


def browser_v3_committed_receipts(lifecycle, receipts):
    """Join Ethereum hashes to the actual Cosmos transactions on all validators."""
    if not isinstance(receipts, list) or not 1 <= len(receipts) <= 64:
        raise ValueError("browser receipt count exceeds one bounded session lifecycle")
    seen, blocks, result = set(), {}, []
    for receipt in receipts:
        txhash = receipt["transactionHash"].lower()
        if not re.fullmatch(r"0x[0-9a-f]{64}", txhash) or txhash in seen or receipt["status"] != "0x1":
            raise ValueError("browser Ethereum receipt failed, duplicated or malformed")
        seen.add(txhash)
        height = int(receipt["blockNumber"], 16)
        if height not in blocks:
            lifecycle.wait_height(height + 1)
            rows = []
            for node in lifecycle.nodes:
                block = lifecycle.query(node, f"/block?height={height}")
                response = lifecycle.query(node, f"/block_results?height={height}")
                summary = artifact.committed_block_summary(block, response, height, lifecycle.chain)
                rows.append(dict(summary=summary, results=response["txs_results"], txs=block["block"]["data"]["txs"]))
            if any(row != rows[0] for row in rows[1:]):
                raise ValueError("four validators disagree on browser transaction bytes/results")
            blocks[height] = rows[0]
        block = blocks[height]
        if receipt["blockHash"].removeprefix("0x").upper() != block["summary"]["block_hash"]:
            raise ValueError("Ethereum receipt has the wrong canonical block hash")
        matches = []
        for index, response in enumerate(block["results"]):
            hashes = {a["value"].lower() for e in response["events"] for a in e["attributes"]
                      if e["type"] == "ethereum_tx" and a["key"] == "ethereumTxHash"}
            if txhash in hashes:
                if hashes != {txhash} or producer.uint(response["code"]) != 0:
                    raise ValueError("browser receipt is not one successful Ethereum transaction")
                matches.append(dict(receipt=receipt, height=height, **block["summary"]["transactions"][index],
                    transaction_bytes=block["txs"][index], events=response["events"],
                    validators=[node["node_id"] for node in lifecycle.nodes]))
        if len(matches) != 1:
            raise ValueError("browser receipt lacks a unique all-validator committed transaction")
        result.append(matches[0])
    return result


def verify_browser_v3_economics(before, after, *, session_id, receipts, issued_stake, signers):
    """Reconcile requester funding and per-obligation rounding at pinned heights."""
    session = after["retrieval"]["sessions"][session_id]
    if (session["payer"] != V3_BROWSER_PAYER or session["owner"] != V3_BROWSER_PAYER or
            session["funding"] != "RETRIEVAL_SESSION_FUNDING_REQUESTER" or session["price_denom"] != "stake"):
        raise ValueError("browser session has the wrong frozen payer/funding authority")
    obligations = session["obligations"]
    slots = [producer.uint(o["slot"]) for o in obligations]
    if not slots or len(slots) > 8 or slots != sorted(set(slots)) or max(slots) >= 8:
        raise ValueError("browser obligations are not canonical")
    mask = sum(1 << slot for slot in slots)
    if (producer.uint(session["acked_slots_mask"]) != mask or producer.uint(session["settled_slots_mask"]) != mask or
            producer.uint(session["refunded_slots_mask"]) != 0 or producer.uint(session["locked_fee"], 256) != 0):
        raise ValueError("browser obligations are not completely acknowledged and settled")
    if v3_bitmap_ordinals(session) != list(range(producer.uint(session["sample_count"]))):
        raise ValueError("browser session is missing accepted challenge ordinals")
    bps = producer.uint(session["completion_burn_bps"])
    if bps > 10000:
        raise ValueError("browser completion burn exceeds the protocol bound")
    variable, payouts, burned = 0, {}, producer.uint(session["base_fee"], 256)
    for obligation in obligations:
        locked = producer.uint(obligation["locked_fee"], 256)
        if locked != producer.uint(obligation["blob_count"]) * producer.uint(session["price_per_blob"], 256):
            raise ValueError("browser obligation fee differs from its blob denominator")
        burn = (locked * bps + 9999) // 10000
        payee = obligation["payee"]
        if payee != obligation["assigned_provider"] or payee not in signers.values():
            raise ValueError("browser payout is outside the frozen provider assignment")
        payouts[payee] = payouts.get(payee, 0) + locked - burn
        variable += locked
        burned += burn
    charged = producer.uint(session["base_fee"], 256) + variable
    if producer.uint(before["payer"]["stake"], 256) - producer.uint(after["payer"]["stake"], 256) != charged:
        raise ValueError("browser payer stake debit differs from its one session charge")
    gas = 0
    for transaction in receipts:
        receipt = transaction["receipt"]
        if not before["bank"]["height"] < transaction["height"] <= after["bank"]["height"]:
            raise ValueError("browser receipt falls outside the economic fence")
        if receipt["from"].lower() != "0x8647e4b22f37b3e30fd3d297f1fb7e13fdf68255" or receipt["to"].lower() != "0x0000000000000000000000000000000000000900":
            raise ValueError("browser receipt targets the wrong payer/precompile")
        gas += int(receipt["gasUsed"], 16) * int(receipt["effectiveGasPrice"], 16)
    if producer.uint(before["payer"]["aatom"], 256) - producer.uint(after["payer"]["aatom"], 256) != gas:
        raise ValueError("browser payer gas debit differs from committed EVM receipts")
    for name, address in signers.items():
        key = name + ":stake"
        if int(after["bank"]["balances"][key]) - int(before["bank"]["balances"][key]) != payouts.get(address, 0):
            raise ValueError("browser provider/control stake delta differs from frozen payouts")
    if any(after["retrieval"]["deals"][key]["escrow_balance"] != deal["escrow_balance"]
           for key, deal in before["retrieval"]["deals"].items()):
        raise ValueError("sponsored browser retrieval changed deal escrow")
    if (before["retrieval"]["module_stake"] != after["retrieval"]["module_stake"] or
            int(after["bank"]["supply"]["stake"]) - int(before["bank"]["supply"]["stake"]) != issued_stake - burned):
        raise ValueError("browser module/supply conservation mismatch")
    return dict(charged_stake=charged, provider_payouts=payouts, burned_stake=burned,
                issued_stake=issued_stake, payer_gas_aatom=gas, completed_sessions=1)


def verify_browser_v3_refund_economics(before, after, *, session_id, receipts, issued_stake,
                                       signers, outcome):
    """Reconcile one paid, unacknowledged session after strict-expiry refund."""
    if before["retrieval"]["params"] != after["retrieval"]["params"]:
        raise ValueError("retrieval pricing changed across browser expiry recovery")
    session = after["retrieval"]["sessions"][session_id]
    pending = outcome.get("sessionBeforeRefund")
    if not isinstance(pending, dict) or len(receipts) != 2:
        raise ValueError("browser expiry evidence lacks the paid state or two EVM transactions")
    if (session["payer"] != V3_BROWSER_PAYER or session["owner"] != V3_BROWSER_PAYER or
            session["funding"] != "RETRIEVAL_SESSION_FUNDING_REQUESTER" or session["price_denom"] != "stake"):
        raise ValueError("refunded browser session has the wrong frozen payer/funding authority")
    obligations = pending.get("obligations")
    if not isinstance(obligations, list) or not obligations:
        raise ValueError("paid browser expiry state lacks obligations")
    slots = [producer.uint(row["slot"]) for row in obligations]
    mask = sum(1 << slot for slot in slots)
    variable = 0
    for obligation in obligations:
        locked = producer.uint(obligation["locked_fee"], 256)
        if (obligation["assigned_provider"] != obligation["payee"] or
                obligation["payee"] not in signers.values() or
                locked != producer.uint(obligation["blob_count"]) * producer.uint(pending["price_per_blob"], 256)):
            raise ValueError("browser expiry obligation differs from its frozen provider fee")
        variable += locked
    base_fee = producer.uint(pending["base_fee"], 256)
    if (producer.b64(pending["session_id"], 32).hex() != session_id or session.get("obligations") != obligations or
            any(session.get(name) != pending.get(name) for name in ("base_fee", "price_per_blob", "price_denom")) or
            producer.uint(outcome["afterRefund"]["height"]) <= producer.uint(pending["deadline_height"]) or
            slots != sorted(set(slots)) or mask == 0 or producer.uint(pending["locked_fee"], 256) != variable or
            any(producer.uint(pending[name]) for name in ("acked_slots_mask", "settled_slots_mask", "refunded_slots_mask")) or
            session.get("expired") is not True or producer.uint(session["locked_fee"], 256) != 0 or
            producer.uint(session["acked_slots_mask"]) != 0 or producer.uint(session["settled_slots_mask"]) != 0 or
            producer.uint(session["refunded_slots_mask"]) != mask or v3_bitmap_ordinals(session)):
        raise ValueError("browser expiry liabilities were not fully and exclusively refunded")
    if producer.uint(before["payer"]["stake"], 256) - producer.uint(after["payer"]["stake"], 256) != base_fee:
        raise ValueError("browser expiry retained more than its base fee")
    gas = 0
    for transaction in receipts:
        receipt = transaction["receipt"]
        if (not before["bank"]["height"] < transaction["height"] <= after["bank"]["height"] or
                receipt["from"].lower() != "0x8647e4b22f37b3e30fd3d297f1fb7e13fdf68255" or
                receipt["to"].lower() != "0x0000000000000000000000000000000000000900"):
            raise ValueError("browser expiry receipt falls outside its payer/precompile fence")
        gas += int(receipt["gasUsed"], 16) * int(receipt["effectiveGasPrice"], 16)
    if producer.uint(before["payer"]["aatom"], 256) - producer.uint(after["payer"]["aatom"], 256) != gas:
        raise ValueError("browser expiry gas debit differs from committed EVM receipts")
    if any(after["bank"]["balances"][name + ":stake"] != before["bank"]["balances"][name + ":stake"]
           for name in signers):
        raise ValueError("browser expiry changed provider/control stake balances")
    if (any(after["retrieval"]["deals"][key]["escrow_balance"] != deal["escrow_balance"]
            for key, deal in before["retrieval"]["deals"].items()) or
            before["retrieval"]["module_stake"] != after["retrieval"]["module_stake"] or
            int(after["bank"]["supply"]["stake"]) - int(before["bank"]["supply"]["stake"]) != issued_stake - base_fee):
        raise ValueError("browser expiry escrow/module/supply conservation mismatch")
    if (outcome.get("localStateBeforeRefund") != {"checkpoints": 1, "unbound": 0,
            "journals": [{"state": "committed", "hasHash": True}]} or
            outcome.get("phaseGuards") != {"openedSessions": 1, "verifiedWrites": 0, "flushedChunks": 0,
                "verifiedChunks": 0, "acknowledgedObligations": 0} or
            outcome.get("resultDurability", {}).get("verifiedStages") != ["interrupted", "refunded"]):
        raise ValueError("browser expiry recovery did not retain its expected local boundaries")
    return dict(retained_base_fee_stake=base_fee, refunded_variable_fee_stake=variable,
                issued_stake=issued_stake, payer_gas_aatom=gas, refunded_sessions=1)


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


def capture_workload_metrics(lifecycle, phase, *, fenced=False, finalize_block=False):
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
            if finalize_block:
                argv.append("--finalize-block-histogram")
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


def file_is_nonconstant(path):
    with Path(path).open("rb") as source:
        first = source.read(1)
        return bool(first) and any(byte != first[0]
            for chunk in iter(lambda: source.read(1024 * 1024), b"") for byte in chunk)


def transaction_job(lifecycle, signer, args, *, kind="setup", gas="2000000"):
    home, node = lifecycle.nodes[0]["home"], lifecycle.nodes[0]
    common = ["--home", home, "--node", f'http://127.0.0.1:{node["rpc"]}']
    job = dict(signer=signer, kind=kind, timeout_seconds=60,
               env={key: lifecycle.env[key] for key in ENV_KEYS if key in lifecycle.env},
               _deadline_ns=lifecycle.deadline,
               submit=[str(lifecycle.binary), "tx", "nilchain", *map(str, args), *common,
                       "--from", signer, "--keyring-backend", "test", "--chain-id", lifecycle.chain,
                       "--gas", gas, "--gas-adjustment", "1.6", "--gas-prices",
                       artifact.BROWSER_EVM_NATIVE_GAS_PRICES if getattr(lifecycle, "browser_evm", False) else "0.001aatom",
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


def frozen_audit_quota(params, population, quota_bps):
    quota = min(population, producer.uint(params["quota_max_blobs"]),
                max(producer.uint(params["quota_min_blobs"]),
                    (population * producer.uint(quota_bps) + 9999) // 10000))
    if not 1 <= quota <= population:
        raise ValueError("diagnostic requires a nonzero bounded frozen audit quota")
    return quota


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


def open_v3_session_batch(lifecycle, paths, directory, command):
    """Generate, append-sign, and broadcast one exact ordered native-v3 open batch."""
    if not 1 <= len(paths) <= V3_CROSS_AUDIT_OPEN_BATCH_MAX:
        raise ValueError("native v3 open batch must contain 1..31 sessions")
    owner = lifecycle.signers["owner0"]
    expected = [json.loads(Path(path).read_text()) for path in paths]
    if any(row.get("creator") != owner for row in expected):
        raise ValueError("native v3 open batch requires the frozen owner")
    directory.mkdir(mode=0o700)
    unsigned, signed = directory / "unsigned.jsonl", directory / "signed.json"
    def generate(index_path):
        index, path = index_path
        expected_gas = V3_CROSS_AUDIT_OPEN_GAS + (OPEN_SESSION_BATCH_BASE_GAS if index == 0 else 0)
        args = transaction_job(lifecycle, "owner0", ["retrieval-session-v3", "open", str(path)],
                               gas=str(expected_gas))["submit"] + ["--generate-only"]
        tx = json.loads(command(args))
        messages = tx.get("body", {}).get("messages", [])
        gas = producer.uint(tx.get("auth_info", {}).get("fee", {}).get("gas_limit", 0))
        if len(messages) != 1 or gas != expected_gas:
            raise ValueError("generated native v3 open differs from ordered intent or gas")
        message, wanted = messages[0], expected[index]
        if (set(message) != {"@type", "creator", "deal_id", "generation", "range", "nonce", "deadline_height"} or
                message.get("@type") != "/polystorechain.polystorechain.v1.MsgOpenRetrievalSessionV3" or
                message.get("creator") != wanted["creator"] or
                any(producer.uint(message.get(key, "")) != producer.uint(wanted[key])
                    for key in ("deal_id", "generation", "nonce", "deadline_height")) or
                not isinstance(message.get("range"), dict) or
                set(message["range"]) != {"file_record_index", "file_start_offset", "file_length",
                                          "range_start", "range_length"} or
                any(producer.uint(message["range"].get(key, "")) != producer.uint(wanted["range"][key])
                    for key in message["range"])):
            raise ValueError("generated native v3 open differs from ordered intent or gas")
        return tx, gas

    with ThreadPoolExecutor(max_workers=min(8, len(paths))) as pool:
        generated = list(pool.map(generate, enumerate(paths)))
    generated_gas = sum(gas for _, gas in generated)
    with unsigned.open("x") as output:
        for tx, _ in generated:
            output.write(json.dumps(tx, separators=(",", ":")) + "\n")
    node = lifecycle.nodes[0]
    common = ["--home", node["home"], "--node", f'http://127.0.0.1:{node["rpc"]}',
              "--keyring-backend", "test", "--chain-id", lifecycle.chain]
    command([str(lifecycle.binary), "tx", "sign-batch", str(unsigned), "--append", "--from", owner,
             *common, "--output-document", str(signed)])
    value = json.loads(signed.read_text())
    messages = [tx["body"]["messages"][0] for tx, _ in generated]
    signed_gas = producer.uint(value.get("auth_info", {}).get("fee", {}).get("gas_limit", 0))
    expected_gas = OPEN_SESSION_BATCH_BASE_GAS + V3_CROSS_AUDIT_OPEN_GAS * len(paths)
    signed_bytes = signed.stat().st_size
    if (value.get("body", {}).get("messages") != messages or len(value.get("signatures", [])) != 1 or
            generated_gas != expected_gas or signed_gas != expected_gas or
            signed_gas > V3_CROSS_AUDIT_OPEN_BATCH_GAS_CAP or signed_bytes > 2 * 1024 * 1024):
        raise ValueError("signed native v3 batch differs from ordered intent, gas, or byte cap")
    job = dict(signer=owner, kind="open-session-v3-batch", timeout_seconds=60,
               env={key: lifecycle.env[key] for key in ENV_KEYS if key in lifecycle.env},
               _deadline_ns=lifecycle.deadline,
               submit=[str(lifecycle.binary), "tx", "broadcast", str(signed), *common,
                       "--broadcast-mode", "sync", "--output", "json"],
               query=[str(lifecycle.binary), "query", "tx", "--home", node["home"],
                      "--node", f'http://127.0.0.1:{node["rpc"]}', "--output", "json"])
    result = artifact.scheduled_transaction(job)
    evidence = dict(transaction=result, count=len(paths), generated_gas=generated_gas,
                    signed_gas=signed_gas, signed_bytes=signed_bytes,
                    signed_sha256=artifact.sha256(signed))
    lifecycle.doc.setdefault("native_v3_open_batches", []).append(evidence)
    lifecycle.doc.setdefault("preparation_transactions", []).append(result)
    lifecycle.save()
    if result.get("outcome") != "committed_success":
        raise ValueError("atomic native v3 open failed or ambiguous; owner quarantined, no retry")
    result["validators"] = verify_transaction_nodes(lifecycle, result)
    validator_bytes = {producer.uint(row.get("bytes", 0)) for row in result["validators"]}
    if (producer.uint(result.get("gas_wanted", 0)) != signed_gas or len(validator_bytes) != 1 or
            not 1 <= next(iter(validator_bytes)) <= 2 * 1024 * 1024):
        raise ValueError("committed native v3 batch differs from signed gas or byte bounds")
    evidence["committed_bytes"] = next(iter(validator_bytes))
    lifecycle.save()
    return opened_v3_sessions(result, len(paths), shapes=[row["range"] for row in expected]), result["height"]


def start_commit_streams(lifecycle, seconds, processes, *, stream_key="commit_streams",
                         filename_prefix="commit"):
    """The caller owns every unreaped collector until group cleanup."""
    rows = lifecycle.doc[stream_key] = []
    for node in lifecycle.nodes:
        path = lifecycle.home / f'{filename_prefix}-{node["node_id"]}.jsonl'
        log = path.with_suffix(".log")
        argv = [sys.executable, commit_metrics.__file__, f'http://127.0.0.1:{node["metrics"]}/metrics',
                lifecycle.chain, "--stream-output", str(path), "--stream-seconds", str(seconds),
                "--finalize-block-histogram"]
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
    reconcile_transaction_blocks(lifecycle, results, first, last,
                                 lifecycle.home / "sustained-blocks.jsonl")


def consensus_commit_observation(signed, height, chain_id):
    header, commit = signed["signed_header"]["header"], signed["signed_header"]["commit"]
    signatures = commit.get("signatures")
    if (signed.get("canonical") is not True or producer.uint(header.get("height", 0)) != height or
            producer.uint(commit.get("height", 0)) != height or header.get("chain_id") != chain_id or
            not isinstance(signatures, list) or len(signatures) != 4):
        raise ValueError("invalid canonical consensus commit observation")
    flags = [producer.uint(row.get("block_id_flag", 0)) for row in signatures]
    if any(flag not in (1, 2, 3) for flag in flags):
        raise ValueError("consensus commit has an unknown signature flag")
    return dict(height=height, round=producer.uint(commit.get("round", 0)),
                signatures=len(signatures), commit_signatures=sum(flag == 2 for flag in flags),
                missed_signatures=sum(flag != 2 for flag in flags), block_id_flags=flags)


def summarize_consensus_commits(observations, first_height, last_height):
    selected = [row for row in observations if first_height <= row["height"] <= last_height]
    expected = list(range(first_height, last_height + 1))
    if [row["height"] for row in selected] != expected:
        raise ValueError("consensus commit observations do not cover the saturated height range")
    return dict(first_height=first_height, last_height=last_height, blocks=len(selected),
        maximum_round=max(row["round"] for row in selected),
        blocks_above_round_zero=sum(row["round"] != 0 for row in selected),
        missed_signatures=sum(row["missed_signatures"] for row in selected), observations=selected)


def reconcile_transaction_blocks(lifecycle, results, first, last, path, observe_transaction=None,
                                 consensus_observations=None):
    """Retain raw block gas/bytes and validate workload txs on all validators."""
    artifact.integer(last - first + 1, "fenced block count", 1, 1200)
    committed = [row for row in results if row["outcome"] in ("committed_success", "committed_failure")]
    expected = {row["txhash"]: row for row in committed}
    if len(expected) != len(committed):
        raise ValueError("journal repeats a committed transaction hash")
    # Comet reports canonical=false for the current BlockStore tip. Fence every
    # validator past the retained interval before treating that as disagreement.
    lifecycle.wait_height(last + 1)
    matched = set()
    with path.open("x") as output:
        for height in range(first, last + 1):
            lifecycle.remaining()
            node = lifecycle.nodes[0]
            block = lifecycle.query(node, f"/block?height={height}")
            summary = artifact.committed_block_summary(block,
                lifecycle.query(node, f"/block_results?height={height}"), height, lifecycle.chain)
            canonical_commit = None
            for node in lifecycle.nodes:
                signed = lifecycle.query(node, f"/commit?height={height}")
                header, commit = signed["signed_header"]["header"], signed["signed_header"]["commit"]
                if (signed.get("canonical") is not True or producer.uint(header["height"]) != height or
                        producer.uint(commit["height"]) != height or header["chain_id"] != lifecycle.chain or
                        header["time"] != summary["time"] or header["app_hash"].upper() != summary["preceding_app_hash"] or
                        commit["block_id"]["hash"].upper() != summary["block_hash"]):
                    raise ValueError("validators disagree on committed block/application hash or header identity")
                if canonical_commit is None:
                    canonical_commit = commit
                    if consensus_observations is not None:
                        observation = consensus_commit_observation(signed, height, lifecycle.chain)
                elif commit != canonical_commit:
                    raise ValueError("validators disagree on canonical commit signatures or round")
            if consensus_observations is not None:
                consensus_observations.append(observation)
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
            if observe_transaction is not None:
                for tx in summary["transactions"]:
                    observe_transaction(tx, height)
            output.write(json.dumps(summary, sort_keys=True) + "\n")
    if matched != set(expected):
        raise ValueError("fenced blocks omit a committed workload transaction")
    lifecycle.doc["committed_block_reconciliation"] = dict(path=str(path), sha256=artifact.sha256(path),
        first_height=first, last_height=last, committed_workload_transactions=len(matched),
        all_four_headers_agree=True, all_four_results_agree=True, qualification=False)


def summarize_commit_streams(lifecycle, processes, *, stream_key="commit_streams",
                             before_phase="sustained_before", after_phase="sustained_after"):
    """Filter raw observations strictly between the independently pinned fences."""
    phases = lifecycle.doc["commit_step_metrics"]["phases"]
    before = {row["node_id"]: row["sample"] for row in phases[before_phase]["nodes"]}
    after = {row["node_id"]: row["sample"] for row in phases[after_phase]["nodes"]}
    rows = lifecycle.doc[stream_key]
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
                boundaries_reconciled=True),
            finalize_block_precise=commit_metrics.summarize_finalize_block_stream(
                samples, end["committed_height"] - start["committed_height"]))
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
                native_v3=False, native_chain=None, native_cross_audit=False,
                native_browser=None, audit_profile="normal"):
    """Real canonical ingest and normal audits; optional bounded retrieval workload."""
    if native_chain is not None:
        native_v3 = True
    if native_cross_audit:
        native_v3 = True
    if native_browser is not None:
        native_v3 = True
    if native_v3 and sustained is not None:
        raise ValueError("native v3 diagnostic and sustained v2 workload are distinct modes")
    browser_bytes = artifact.integer(native_browser["file_bytes"], "browser fixture bytes", 1,
                                     1_073_741_824) if native_browser is not None else None
    browser_executor_handoff = bool(native_browser.get("executor_handoff", False)) if native_browser is not None else False
    if browser_bytes is not None and browser_bytes not in V3_BROWSER_SIZES:
        raise ValueError("browser fixture size is outside the retained qualification matrix")
    v3_bytes = browser_bytes if browser_bytes is not None else V3_PILOT_BYTES
    v3_geometry = v3_file_geometry(v3_bytes) if native_v3 else None
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
    native_chain_exporter = None
    build_attestation = None
    if native_chain is not None:
        export_binary, native_chain_exporter = native_v3_chain_exporter_identity(native_chain["exporter"])
        exact_candidate = (native_chain.get("profile") == "1kib" and
            native_chain.get("measured_sessions") == V3_ISSUE_251_QUALIFICATION_SESSIONS and
            native_chain.get("submission_mode") == "batch-message" and
            native_chain.get("batch_size") == V3_ISSUE_251_QUALIFICATION_BATCH_SIZE and
            native_chain.get("gas_adjustment", "1.6") == "1.6" and
            native_chain.get("max_block_gas") == V3_ISSUE_251_QUALIFICATION_GAS and
            int(lifecycle.env["GOMAXPROCS"]) == 4 and lifecycle.timeout_commit == "1s")
        if exact_candidate and not native_chain.get("build_manifest"):
            raise ValueError("the exact issue #251 candidate requires --build-manifest")
        if native_chain.get("build_manifest"):
            build_attestation = verify_native_v3_build_manifest(
                native_chain["build_manifest"], source, native_v3_harness_source(), {
                "polystorechaind": lifecycle.binary, "libpolystore_core": lifecycle.library,
                "polystore_gateway": gateway, "polystore_cli": cli,
                "retrieval_inventory_exporter": export_binary})
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
    native_chain_inventory = None
    if native_chain is not None and native_chain.get("profile"):
        if native_chain.get("measured_sessions") is not None:
            native_chain_inventory = f"{native_chain['measured_sessions']:,} logical proof sessions"
        else:
            native_chain_inventory = f"{native_chain['measured_transactions']:,} frozen native proof transactions"
    doc.update(mode=("four-validator-native-v3-browser-qualification" if native_browser is not None else
                     "four-validator-native-v3-chain-capacity" if native_chain is not None else
                     "four-validator-native-v3-cross-audit-diagnostic" if native_cross_audit else
                     "four-validator-native-v3-provider-diagnostic" if native_v3 else "four-validator-healthy-provider-diagnostic"),
        setup_transactions=[], providers=[],
        workload=(f"one {v3_bytes}-byte FAT v3 K8 PUBLIC deal; production DealDetail sponsored browser retrieval"
                  if native_browser is not None else
                  (f"one 16 MiB FAT v3 K8 deal; {native_chain['profile']} range; "
                   f"{native_chain_inventory}"
                   if native_chain.get("profile") else
                   "one 16 MiB FAT v3 K8 deal; 1 KiB, 992 KiB, and 16 MiB ranges; 2,640 frozen native proof transactions")
                  if native_chain is not None else
                  "one 16 MiB FAT v3 K8 deal; 46 sessions; 368 production-route proof transactions across two normal audit anchors"
                  if native_cross_audit else
                  "one 16 MiB FAT v3 K8 deal; twelve production provider-daemons; two preopened native sessions"
                  if native_v3 else f"one real K{k} deal; {layout['assignments']} assigned provider-daemons; one normal audit epoch"),
        qualification=False, limits=([artifact.BROWSER_EXECUTOR_SCOPE if browser_executor_handoff else
                                      "One owned local-host production browser path; no WAN or public activation qualification"]
            if native_browser is not None else
            ["Proof-confirmation chain capacity only; no file transport, proof preparation, signing, ACK, or refund"]
            if native_chain is not None else ["No capacity or delivered retrieval qualification"])+[
            ("Frozen signed transactions are submitted directly; setup and proof work are outside the timed interval"
             if native_chain is not None else
             "Provider HTTP durations combine proof generation, gas simulation, signing, broadcast, and commit observation"
             if native_v3 else "No deputy retrieval yet"),
            ("Normal mint and audit parameters retained; browser payer/provider/supply conservation checked"
             if native_browser is not None else "Normal mint and audit parameters retained; no economic conservation assertion"),
            ("Post-qualification validator restart is required for the exact 160M/7,680-session batch candidate"
             if native_chain is not None and native_chain.get("profile") == "1kib" and
                native_chain.get("measured_sessions") == V3_ISSUE_251_QUALIFICATION_SESSIONS and
                native_chain.get("submission_mode") == "batch-message" and
                native_chain.get("batch_size") == V3_ISSUE_251_QUALIFICATION_BATCH_SIZE and
                native_chain.get("gas_adjustment") == "1.6" and
                native_chain.get("max_block_gas") == V3_ISSUE_251_QUALIFICATION_GAS and
                int(lifecycle.env["GOMAXPROCS"]) == 4 and lifecycle.timeout_commit == "1s"
             else "No post-workload validator restart qualification")])
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
        if (sustained is not None or native_chain is not None or native_cross_audit or
                native_browser is not None) and \
                "--append" not in lifecycle.cli(lifecycle.home, "tx", "sign-batch", "--help").split():
            raise ValueError("batched session preparation requires SDK sign-batch --append")
        lifecycle.reserve_ports()
        browser_ports = None
        if native_browser is not None:
            gateway_port = None
            for candidate in ((8080,) if browser_executor_handoff else (8080, 18080)):
                try:
                    reservation = artifact.reserve_loopback_port(candidate)
                    reservations.append(reservation)
                    gateway_port = candidate
                    break
                except OSError:
                    pass
            if gateway_port is None:
                raise ValueError("browser qualification requires an owned user-gateway on port 8080 or 18080")
            reservation = artifact.reserve_loopback_port(4173)
            reservations.append(reservation)
            browser_ports = dict(gateway=gateway_port, website=4173,
                                 gateway_reservation=reservations[-2],
                                 website_reservation=reservations[-1])
        provider_reservations = []
        for i in range(layout["assignments"]):
            reservation = artifact.reserve_loopback_port(19091 + i)
            reservations.append(reservation)
            provider_reservations.append(reservation)
        doc["provenance"] = dict(**host_identity(),
            source_checkout=command(["git", "-C", str(lifecycle.root), "rev-parse", "HEAD"]).strip(),
            binary=str(lifecycle.binary), native_library=str(lifecycle.library),
            binary_sha256=artifact.sha256(lifecycle.binary), native_library_sha256=artifact.sha256(lifecycle.library),
            trusted_setup_sha256=artifact.sha256(lifecycle.env["POLYSTORE_TRUSTED_SETUP"]), gateway_binary=str(gateway),
            gateway_sha256=artifact.sha256(gateway), driver_sha256=artifact.sha256(__file__),
            cli_binary=str(cli), cli_sha256=artifact.sha256(cli), product_source=str(source),
            product_source_commit=command(["git", "-C", str(source), "rev-parse", "HEAD"]).strip(),
            product_source_status=command(["git", "-C", str(source), "status", "--porcelain", "--",
                "polystore_cli", "polystore_core", "polystore_gateway", "polystorechain",
                "polystore-website", "scripts"]),
            cli_source_sha256=artifact.sha256(source / "polystore_cli/src/main.rs"),
            curl_binary=curl, curl_sha256=artifact.sha256(curl),
            artifact_source_match=("verified exact clean source commit and artifact hashes"
                                   if build_attestation else
                                   "supplied binaries/library; build correspondence not attested"))
        if build_attestation is not None:
            doc["provenance"]["build_attestation"] = build_attestation
        if native_browser is not None:
            doc["provenance"]["browser_source_sha256"] = {
                str(path.relative_to(source)): artifact.sha256(path)
                for path in (
                    source / "polystore-website/tests/native-v3-browser-live.spec.ts",
                    source / "polystore-website/tests/utils/nativeV3DealDetail.tsx",
                    source / "polystore-website/tests/utils/retrievalProgress.ts",
                    source / "polystore-website/src/lib/retrievalV3Flow.ts",
                    source / "polystore-website/src/lib/retrievalDiagnostics.ts",
                    source / "polystore-website/src/hooks/useFetch.ts",
                    source / "polystore-website/src/hooks/useRetrievalSessions.ts",
                )
            }
        if native_chain_exporter is not None:
            doc["provenance"].update(native_chain_exporter)
        if doc["provenance"]["trusted_setup_sha256"] != producer.SETUP_DIGEST:
            raise ValueError("diagnostic requires the maintained trusted setup")
        lifecycle.prepare(audit_profile=audit_profile, provider_count=layout["provisioned_provider_signers"],
                          enable_retrieval_v3=native_v3,
                          browser_payer=V3_BROWSER_PAYER if native_browser is not None else None,
                          max_block_gas=native_chain.get("max_block_gas")
                          if native_chain is not None else None)
        # Normal mint is retained for both explicit audit profiles.
        population = layout["openings_per_bundle"] * (v3_geometry["user_mdus"] if native_v3 else 1)
        expected_samples = frozen_audit_quota(doc["frozen_module_params"], population,
            doc["frozen_module_params"]["quota_bps_per_epoch_cold"])
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
        if native_browser is not None:
            doc["browser_http_preflight"] = browser_http_preflight(lifecycle,
                f'http://127.0.0.1:{browser_ports["website"]}')
            lifecycle.save()
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
                POLYSTORE_CLI_BIN=str(cli), POLYSTORE_ROOT_DIR=str(source),
                POLYSTORE_GAS_PRICES=artifact.BROWSER_EVM_NATIVE_GAS_PRICES if native_browser is not None else "0.001aatom",
                POLYSTORE_PROVIDER_ADDRESS=lifecycle.signers[f"provider{i}"], POLYSTORE_UPLOAD_DIR=str(directory),
                POLYSTORE_SESSION_DB_PATH=str(directory / "sessions.db"), POLYSTORE_LISTEN_ADDR=f"127.0.0.1:{19091+i}",
                POLYSTORE_P2P_ENABLED="0", POLYSTORE_DISABLE_SYSTEM_LIVENESS="0", POLYSTORE_SYSTEM_LIVENESS="1",
                POLYSTORE_SYSTEM_LIVENESS_INTERVAL_SECONDS="10", POLYSTORE_POLYCE="0", POLYSTORE_FAKE_INGEST="0",
                POLYSTORE_FAST_INGEST="0", POLYSTORE_FAST_SHARD="0", POLYSTORE_MODE2_ENCODE_PARALLELISM="1", POLYSTORE_MODE2_UPLOAD_PARALLELISM="2",
                POLYSTORE_GATEWAY_UPLOAD_TIMEOUT_SECONDS="180", POLYSTORE_CMD_TIMEOUT_SECONDS="30",
                POLYSTORE_SHARD_TIMEOUT_SECONDS="180", POLYSTORE_MODE2_UPLOAD_TASK_TIMEOUT_SECONDS="60",
                POLYSTORE_GATEWAY_SP_AUTH=V3_PROVIDER_AUTH_TOKEN)
            if native_browser is not None and native_browser.get("diagnostics", False):
                env["POLYSTORE_RETRIEVAL_DIAGNOSTICS"] = "1"
            provider_reservations[i].close()
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
        service_hint = f"General:rs={k}+{layout['m']}"
        created = send("owner0", ["create-deal", "100000", "100000000", "10000000", "--service-hint", service_hint])
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
        payload_bytes = v3_bytes if native_v3 else 8126464
        with payload.open("xb") as output:
            for _ in range(payload_bytes // len(block)):
                output.write(block)
            output.write(block[:payload_bytes % len(block)])
        if payload.stat().st_size != payload_bytes or not file_is_nonconstant(payload):
            raise ValueError("retrieval payload must be exact-length and nonconstant")
        doc["payload"] = dict(path=str(payload), bytes=payload.stat().st_size, sha256=artifact.sha256(payload))
        uploaded = json.loads(command([curl, "--silent", "--show-error", "--fail", "--max-time", "180",
            "--form-string", "owner=" + lifecycle.signers["owner0"], "--form-string", "file_path=payload.bin",
            "--form", "file=@" + str(payload),
            f"http://127.0.0.1:19091/sp/retrieval/upload?deal_id={identity}" + ("&fat_version=3" if native_v3 else "")], 185))
        doc["ingest"] = uploaded
        if native_v3:
            candidate, height = admit_native_v3_generation(lifecycle, uploaded=uploaded, deal_id=identity,
                                                            providers=providers, send=send, curl=curl,
                                                            file_bytes=v3_bytes)
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
        if deal.get("service_hint") != service_hint:
            raise ValueError("committed deal differs from the fixed General audit policy")
        if producer.b64(deal["manifest_root"], 32).hex() != root[2:]:
            raise ValueError("committed root differs from ingest")
        if native_v3 and [producer.uint(deal.get(name, 0)) for name in
                          ("size", "total_mdus", "witness_mdus", "current_gen")] != [
                              v3_geometry["size"], v3_geometry["total_mdus"], 1, 1]:
            raise ValueError("finalized FAT v3 deal differs from fixed pilot geometry")
        if deal["mode2_slots"] != initial_deal["mode2_slots"]:
            raise ValueError("content admission changed frozen provider assignments")
        doc["deal"] = deal
        doc["canonical_artifacts"] = []
        user_mdus = v3_geometry["user_mdus"] if native_v3 else 1
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
            if native_chain is not None:
                run_native_v3_chain(lifecycle, deal=deal, providers=providers, wait=wait,
                                    audits=audits, exporter=export_binary, command=command,
                                    epoch_length=epoch_length,
                                    profile_name=native_chain.get("profile"),
                                    measured_transactions=native_chain.get("measured_transactions"),
                                    measured_sessions=native_chain.get("measured_sessions"),
                                    submission_mode=native_chain.get("submission_mode", "separate"),
                                    batch_size=native_chain.get("batch_size", 1),
                                    gas_adjustment=native_chain.get("gas_adjustment", "1.6"))
                if lifecycle.doc["native_v3_chain"].get("issue_251_candidate"):
                    finalize_native_v3_candidate(lifecycle, wait, audits, epoch_length)
                doc["status"] = "native_v3_chain_capacity_passed"
            elif native_cross_audit:
                run_native_v3_cross_audit(lifecycle, deal=deal, providers=providers, send=send, wait=wait,
                                          curl=curl, audits=audits, epoch_length=epoch_length, command=command)
                doc["status"] = "native_v3_cross_audit_diagnostic_passed"
            elif native_browser is not None:
                set_public_retrieval_policy(lifecycle, deal_id=identity, command=command)
                doc["status"] = "native_v3_browser_running"
                lifecycle.save()
                run_native_v3_browser(lifecycle, gateway=gateway, source=source, deal=deal,
                    browser_ports=browser_ports, command=command, processes=processes,
                    check_providers=check_providers, faults=browser_bytes == 16 * 1024 * 1024 + 1,
                    executor_handoff=browser_executor_handoff,
                    diagnostics=bool(native_browser.get("diagnostics", False)))
                if browser_bytes == 1024:
                    expiry = prepare_native_v3_browser_expiry(lifecycle, main_deal=deal, providers=providers,
                        send=send, wait=wait, command=command, curl=curl)
                    run_native_v3_browser_expiry(lifecycle, source=source, deal=expiry["deal"],
                        browser_ports=browser_ports, payload=expiry["payload"], check_providers=check_providers)
                doc.update(status="native_v3_browser_qualification_passed", qualification=True)
            else:
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
    for flag in ("fixture-k8", "fixture-k2", "gateway-binary", "cli-binary", "product-source",
                 "proof-exporter", "build-manifest"):
        parser.add_argument("--" + flag)
    parser.add_argument("--mode", choices=("settlement-smoke", "healthy-providers", "sustained-providers",
                                           "native-v3-providers", "native-v3-providers-cross-audit",
                                           "native-v3-chain", "native-v3-browser"), default="settlement-smoke")
    parser.add_argument("--timeout", type=int,
                        help="Owned-run cap in seconds; defaults to 3600 for native-v3-chain and 600 otherwise")
    parser.add_argument("--audit-profile", choices=("normal", "c6"), default="normal")
    parser.add_argument("--step-seconds", type=int, default=180, help="Each of five offered-rate steps; 4 is a same-path pilot")
    parser.add_argument("--sustained-k", type=int, choices=(2, 8), default=2,
                        help="Native Mode 2 data width; full-row bundles contain 64/K openings")
    parser.add_argument("--sustained-rate-scale", type=int, choices=SUSTAINED_RATE_SCALES, default=1,
                        help="Multiply the five fixed offered transaction rates by 1 or 4")
    parser.add_argument("--sustained-deputies", type=int, choices=SUSTAINED_DEPUTY_COUNTS, default=8,
                        help="Use 8 or 32 independent proof-submission signers")
    parser.add_argument("--proof-gas", type=int, help="Explicit locally validated fixed gas limit per proof-submission transaction")
    parser.add_argument("--chain-max-gas", type=int,
                        choices=(64_000_000, 128_000_000, 160_000_000, 192_000_000, 256_000_000,
                                 320_000_000, 384_000_000, 448_000_000),
                        help="Experimental native-v3-chain maximum block gas")
    parser.add_argument("--chain-capacity-profile", choices=("1kib", "eight-blobs", "sample-cap"),
                        help="Run one native-v3-chain range shape")
    parser.add_argument("--chain-capacity-transactions", type=int,
                        help="Legacy separate-message transaction inventory for a selected profile")
    parser.add_argument("--chain-capacity-sessions", type=int,
                        help="Logical session inventory for an exact native-v3-chain comparator")
    parser.add_argument("--chain-proof-submission-mode", choices=V3_CHAIN_SUBMISSION_MODES, default="separate",
                        help="Separate transactions, serial messages in one transaction, or the V3 batch message")
    parser.add_argument("--chain-proof-batch-size", type=int, choices=(1, *V3_CHAIN_BATCH_SIZES), default=1,
                        help="Provider-local proof messages per transaction; 1 for separate, otherwise 8/32/64")
    parser.add_argument("--chain-proof-gas-adjustment", choices=V3_CHAIN_GAS_ADJUSTMENTS, default="1.6",
                        help="Benchmark-only proof simulation gas multiplier; defaults to the historical 1.6")
    parser.add_argument("--chain-timeout-commit-ms", type=int, choices=(250, 500, 1000), default=1000,
                        help="Benchmark-only CometBFT timeout_commit; defaults to the historical 1000ms")
    parser.add_argument("--chain-validator-gomaxprocs", type=int, choices=(2, 4), default=2,
                        help="Benchmark-only Go worker ceiling per validator; defaults to 2")
    parser.add_argument("--browser-bytes", type=int, choices=V3_BROWSER_SIZES,
                        help="Retained browser fixture size; only used by native-v3-browser")
    parser.add_argument("--browser-executor-handoff", action="store_true",
                        help="Run the fixed Playwright worker on the Mac LAN client; native-v3-browser only")
    parser.add_argument("--retrieval-diagnostics", action="store_true",
                        help="Enable bounded V3 fetch timing for an owned native-v3-browser run")
    parser.add_argument("--proof-only", action="store_true", help="Prepare six sessions, verify rejected transactions, time proofs, then verify idempotent settlement retries")
    options = vars(parser.parse_args())
    k8, k2 = options.pop("fixture_k8"), options.pop("fixture_k2")
    proof_only = options.pop("proof_only")
    mode, gateway = options.pop("mode"), options.pop("gateway_binary")
    options["timeout"] = options["timeout"] or (3600 if mode == "native-v3-chain" else 600)
    audit_profile = options.pop("audit_profile")
    cli, source = options.pop("cli_binary"), options.pop("product_source")
    exporter = options.pop("proof_exporter")
    build_manifest = options.pop("build_manifest")
    step_seconds, proof_gas = options.pop("step_seconds"), options.pop("proof_gas")
    sustained_k = options.pop("sustained_k")
    sustained_rate_scale = options.pop("sustained_rate_scale")
    sustained_deputies = options.pop("sustained_deputies")
    browser_bytes = options.pop("browser_bytes")
    browser_executor_handoff = options.pop("browser_executor_handoff")
    retrieval_diagnostics = options.pop("retrieval_diagnostics")
    chain_max_gas = options.pop("chain_max_gas")
    chain_capacity_profile = options.pop("chain_capacity_profile")
    chain_capacity_transactions = options.pop("chain_capacity_transactions")
    chain_capacity_sessions = options.pop("chain_capacity_sessions")
    chain_submission_mode = options.pop("chain_proof_submission_mode")
    chain_batch_size = options.pop("chain_proof_batch_size")
    chain_gas_adjustment = options.pop("chain_proof_gas_adjustment")
    chain_timeout_commit_ms = options.pop("chain_timeout_commit_ms")
    chain_validator_gomaxprocs = options.pop("chain_validator_gomaxprocs")
    if mode != "native-v3-chain" and any(value is not None for value in
            (chain_max_gas, chain_capacity_profile, chain_capacity_transactions,
             chain_capacity_sessions, build_manifest)):
        parser.error("chain capacity controls require native-v3-chain")
    if mode != "native-v3-chain" and (chain_submission_mode != "separate" or chain_batch_size != 1):
        parser.error("chain proof submission controls require native-v3-chain")
    if mode != "native-v3-chain" and (chain_gas_adjustment != "1.6" or
                                      chain_timeout_commit_ms != 1000 or
                                      chain_validator_gomaxprocs != 2):
        parser.error("chain timing and gas controls require native-v3-chain")
    if browser_executor_handoff and (mode != "native-v3-browser" or
            (browser_bytes or V3_BROWSER_DEFAULT_BYTES) != 1_073_741_824):
        parser.error("browser executor handoff requires the clean 1 GiB native-v3-browser pilot")
    if retrieval_diagnostics and mode != "native-v3-browser":
        parser.error("retrieval diagnostics require native-v3-browser")
    if mode == "sustained-providers":
        if not all((gateway, cli, source, exporter, proof_gas)) or k8 or k2 or proof_only or not 4 <= step_seconds <= 180 or not 1 <= proof_gas <= 64000000:
            parser.error("sustained-providers requires product binaries/source, --proof-exporter and --proof-gas; excludes fixtures/--proof-only")
        print(run_healthy(artifact.FourValidatorLifecycle(**options, sustained=True), gateway, cli, source,
            sustained=dict(exporter=exporter, step_seconds=step_seconds, proof_gas=proof_gas, k=sustained_k,
                           rate_scale=sustained_rate_scale, deputy_count=sustained_deputies), audit_profile=audit_profile))
    elif mode == "native-v3-chain":
        selected_chain_profile = any(value is not None for value in
            (chain_max_gas, chain_capacity_profile, chain_capacity_transactions, chain_capacity_sessions)) or \
            chain_submission_mode != "separate" or chain_batch_size != 1 or \
            chain_gas_adjustment != "1.6" or chain_timeout_commit_ms != 1000
        if (not gateway or not cli or not source or not exporter or k8 or k2 or proof_only or
                proof_gas is not None or step_seconds != 180 or sustained_k != 2 or
                sustained_rate_scale != 1 or sustained_deputies != 8 or
                options["timeout"] > 3600 or audit_profile != "normal" or
                (selected_chain_profile and (chain_max_gas is None or chain_capacity_profile is None or
                 (chain_capacity_transactions is None) == (chain_capacity_sessions is None)))):
            parser.error("native-v3-chain requires product binaries/source and --proof-exporter, normal audits, timeout <= 3600, and fixed saturated profile")
        native_chain = dict(exporter=exporter)
        if build_manifest:
            native_chain["build_manifest"] = build_manifest
        if chain_timeout_commit_ms != 1000:
            options["consensus_timeout_commit_ms"] = chain_timeout_commit_ms
        options["gomaxprocs"] = chain_validator_gomaxprocs
        if selected_chain_profile:
            try:
                profiles = native_v3_chain_capacity_profiles(chain_capacity_profile, chain_capacity_transactions,
                    measured_sessions=chain_capacity_sessions, submission_mode=chain_submission_mode,
                    batch_size=chain_batch_size)
                validate_native_v3_capacity_epoch(profiles[0], chain_max_gas)
            except ValueError as error:
                parser.error(str(error))
            native_chain.update(max_block_gas=chain_max_gas, profile=chain_capacity_profile,
                                measured_transactions=chain_capacity_transactions)
            if chain_capacity_sessions is not None:
                native_chain.update(measured_sessions=chain_capacity_sessions,
                                    submission_mode=chain_submission_mode, batch_size=chain_batch_size)
            if chain_gas_adjustment != "1.6":
                native_chain["gas_adjustment"] = chain_gas_adjustment
        print(run_healthy(artifact.FourValidatorLifecycle(**options, sustained=True), gateway, cli, source,
                          native_chain=native_chain, audit_profile="normal"))
    elif mode == "native-v3-browser":
        if (not gateway or not cli or not source or k8 or k2 or proof_only or
                options["timeout"] > 3600 or audit_profile != "normal"):
            parser.error("native-v3-browser requires product binaries/source, normal audits, timeout <= 3600, and excludes fixtures/--proof-only")
        native_browser = dict(file_bytes=browser_bytes or V3_BROWSER_DEFAULT_BYTES)
        if retrieval_diagnostics:
            native_browser["diagnostics"] = True
        if browser_executor_handoff:
            native_browser["executor_handoff"] = True
        print(run_healthy(artifact.FourValidatorLifecycle(**options, browser_evm=True), gateway, cli, source,
                          native_browser=native_browser, audit_profile="normal"))
    elif (exporter or proof_gas is not None or step_seconds != 180 or sustained_k != 2 or
          sustained_rate_scale != 1 or sustained_deputies != 8 or browser_bytes is not None):
        parser.error("exporter, proof gas, sustained K and pilot duration require sustained-providers")
    elif mode == "native-v3-providers":
        if (not gateway or not cli or not source or k8 or k2 or proof_only or
                options["timeout"] > 600 or audit_profile != "normal"):
            parser.error("native-v3-providers requires product binaries/source, normal audits, timeout <= 600, and excludes fixtures/--proof-only")
        print(run_healthy(artifact.FourValidatorLifecycle(**options), gateway, cli, source,
                          native_v3=True, audit_profile="normal"))
    elif mode == "native-v3-providers-cross-audit":
        if (not gateway or not cli or not source or k8 or k2 or proof_only or
                options["timeout"] > 900 or audit_profile != "normal"):
            parser.error("native-v3-providers-cross-audit requires product binaries/source, normal audits, timeout <= 900, and excludes fixtures/--proof-only")
        print(run_healthy(artifact.FourValidatorLifecycle(**options), gateway, cli, source,
                          native_cross_audit=True, audit_profile="normal"))
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
