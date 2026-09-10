#!/usr/bin/env python3
import argparse, base64, hashlib, json, math, re, statistics, sys, types
from datetime import datetime, timezone
from pathlib import Path

HARNESS_SHA256 = "7efd7fa4e8bec5f90f8ac09742220f6fa3f961316fb0ac3edfb20e67974cb662"
REFUND_TRANSACTIONS_SHA256 = "8f79860f047faecf580848ea4b801b71aa8c8e4ce00f5c5d9e4712f047b98e85"
HARNESS_MODULES = {
    "retrieval_bench_artifact": "aeb5f811fb5f93ad4539f49a485c15af3747c765bd3d3997bc38335016a023d8",
    "retrieval_commit_metrics": "e8b272852684639efe6292d3b72eb2396fee0c2bdb99558d52c611b7d638e11f",
    "retrieval_fresh_proof": "74ced497d80442a7d463872623879737b7775ad2a49ec4c5a53ced8a8650e67b",
    "native_chain_harness": HARNESS_SHA256,
}


def require(ok, message):
    if not ok: raise ValueError(message)


def quantiles_ns(values):
    values = sorted(values)
    require(values, "empty latency sample")
    at = lambda q: values[max(0, math.ceil(q * len(values)) - 1)] / 1e6
    return {"count": len(values), "min_ms": values[0] / 1e6,
            "median_ms": statistics.median(values) / 1e6,
            "p50_ms": at(.5), "p95_ms": at(.95), "p99_ms": at(.99),
            "max_ms": values[-1] / 1e6,
            "percentile_method": "nearest rank; median uses the conventional midpoint"}


def time_ns(value):
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z", value)
    require(match is not None, f"unsupported block time {value!r}")
    moment = datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    delta = moment - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1_000_000_000 + int((match.group(2) or "").ljust(9, "0"))


def load_harness(path):
    sources = {}
    for name, digest in HARNESS_MODULES.items():
        source = path if name == "native_chain_harness" else path.with_name(name + ".py")
        data = source.read_bytes()
        require(hashlib.sha256(data).hexdigest() == digest, f"unpinned harness module {source.name}")
        sources[name] = (source, data)
    # Execute only verified bytes, without adding the supplied directory to import paths.
    for name, (source, data) in sources.items():
        module = types.ModuleType(name)
        module.__file__ = str(source)
        sys.modules[name] = module
        exec(compile(data, str(source), "exec"), module.__dict__)
    return module


def validate_transaction(row, node_ids):
    require(row["outcome"] == "committed_success" and row["code"] == 0 and
            row["height"] > 0 and row["gas_wanted"] > 0 and row["gas_used"] > 0,
            "non-successful transaction included")
    validators = row["validators"]
    require(len(validators) == 4 and {v["node_id"] for v in validators} == node_ids,
            "transaction validator agreement is incomplete")
    for validator in validators:
        require(all(validator[key] == row[key] for key in ("txhash", "height", "code", "gas_wanted", "gas_used"))
                and validator["bytes"] == validators[0]["bytes"] > 0, "transaction validator outcome differs")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("harness", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("blocks", type=Path)
    parser.add_argument("refund_transactions", type=Path)
    parser.add_argument("--run-scope", required=True,
                        choices=("premerge-correctness-smoke", "landed-retained-diagnostic"))
    args = parser.parse_args()
    doc = json.loads(args.evidence.read_text())
    require(hashlib.sha256(args.harness.read_bytes()).hexdigest() == HARNESS_SHA256 ==
            doc["provenance"]["driver_sha256"], "supplied harness differs from independently pinned driver")
    harness = load_harness(args.harness.resolve())
    if args.run_scope == "landed-retained-diagnostic":
        require(doc["provenance"]["source_checkout"] == "0acb91a2d89073d0e3cb441db97d2dd192d03be9",
                "landed report requires the pinned merged harness")
    require(doc["profile"]["consensus"]["block"] == {"max_bytes": "2097152", "max_gas": "64000000"},
            "consensus gas/byte limits differ from the fixed report")
    node_ids = {node["node_id"] for node in doc["nodes"]}
    require(len(doc["nodes"]) == len(node_ids) == 4, "validator identities are incomplete")
    refunds_raw = args.refund_transactions.read_bytes()
    require(hashlib.sha256(refunds_raw).hexdigest() == REFUND_TRANSACTIONS_SHA256,
            "refund recovery differs from independently pinned blockstore extraction")
    recovered = json.loads(refunds_raw)
    refund_messages = {row["txhash"]: row for row in recovered["transactions"]}
    require(len(recovered["transactions"]) == len(refund_messages) == 8, "refund recovery set is incomplete")
    require(doc["audit_coverage_verified"] and doc["profile"]["audit_profile"] == "normal",
            "normal audit coverage was not verified")
    audit_rows = doc["audit_after"]["audits"]
    require(len(audit_rows) == 12 and doc["audit_after"]["height"] > doc["audit_before"]["height"] and
            all(row["finalized"] and int(row["audit"]["accepted_count"]) == int(row["audit"]["sample_count"]) == 1
                and int(row["audit"]["missed_epochs"]) == 0 for row in audit_rows.values()),
            "twelve normal audit assignments did not complete")
    native = doc["native_v3_chain"]
    require(doc["status"] == "native_v3_chain_diagnostic_passed", "top-level run did not pass")
    require(doc["mode"] == "four-validator-native-v3-chain-diagnostic" and doc["qualification"] is False,
            "top-level evidence mode/qualification mismatch")
    require(native["status"] == "native_v3_chain_diagnostic_finished", "native diagnostic did not finish")
    expected = {"total": 64, "measured": 56, "total_ordinals": 1056, "measured_ordinals": 924}
    require((harness.V3_CHAIN_SESSIONS, harness.V3_CHAIN_WARMUPS, harness.V3_CHAIN_MEASURED,
             harness.V3_MAX_SAMPLES) == (8, 8, 56, 132), "harness profile differs from reviewed diagnostic")
    require(native["total_committed_valid_proof_transactions"] == expected["total"], "total committed-valid count mismatch")
    require(native["measured_committed_valid_proof_transactions"] == expected["measured"], "measured committed-valid count mismatch")
    require(native["total_authoritative_new_sample_ordinals"] == expected["total_ordinals"], "total ordinal count mismatch")
    require(native["measured_authoritative_new_sample_ordinals"] == expected["measured_ordinals"], "measured ordinal count mismatch")
    require(native["offered_proof_transactions"] == 64 and native["warmup_transactions"] == 8 and native["measured_transactions"] == 56, "run profile count mismatch")
    require(native["qualification"] is False and native["expiration_verified"] and native["refunds_verified"], "qualification/expiry/refund validation missing")
    require(not native["owner_acknowledged"] and not native["delivery_verified"], "unexpected ACK/delivery claim")
    reconciliation = doc["committed_block_reconciliation"]
    require(reconciliation["qualification"] is False and reconciliation["all_four_headers_agree"] and reconciliation["all_four_results_agree"], "four-validator reconciliation missing")
    require(reconciliation["committed_workload_transactions"] == expected["measured"], "reconciled measured count mismatch")
    raw = args.blocks.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == reconciliation["sha256"], "reconciled block hash mismatch")
    blocks = [json.loads(line) for line in raw.splitlines() if line.strip()]
    require(len(blocks) == reconciliation["last_height"] - reconciliation["first_height"] + 1, "reconciled block count mismatch")
    require([row["height"] for row in blocks] == list(range(reconciliation["first_height"], reconciliation["last_height"] + 1)), "reconciled height range mismatch")

    measured = native["measured_window"]
    rows = native["scheduler"]["transactions"]
    require(len(rows) == expected["measured"] and all(r["phase"] == "measurement" and r["outcome"] == "committed_success" for r in rows), "measured scheduler outcomes incomplete")
    warmups = native["warmup_scheduler"]["transactions"]
    require(len(warmups) == 8 and all(row["phase"] == "warmup" for row in warmups), "warmup count/phase mismatch")
    all_rows = warmups + rows
    require(len({row["txhash"] for row in all_rows}) == 64, "repeated committed transaction")
    for row in all_rows:
        validate_transaction(row, node_ids)
        require(row["offered_ns"] <= row["started_ns"] <= row["finished_ns"] and
                row["queue_latency_ns"] == row["started_ns"] - row["offered_ns"] and
                row["terminal_latency_ns"] == row["finished_ns"] - row["offered_ns"] and
                0 <= row["checktx_latency_ns"] <= row["commit_observation_latency_ns"] <= row["finished_ns"] - row["started_ns"],
                "transaction timing identities are inconsistent")
    sessions = native["sessions"]
    require(len(sessions) == 8 and len({row["session_id"] for row in sessions}) == 8, "session set differs from fixed profile")
    admitted = doc["native_v3_generation"]["admitted"]["admitted"]
    providers = dict(enumerate(admitted["providers"][:8]))
    refund_hashes = set()
    for session in sessions:
        before = session["before_proofs"]["session"]
        deadline = int(before["deadline_height"])
        immutable = {key: value for key, value in before.items() if key not in
                     {"accepted_sample_bitmap", "updated_height", "expired", "locked_fee", "refunded_slots_mask", "obligations"}}
        for name, expired, refunded in (("before_proofs", False, False), ("after_proofs", False, False),
                                        ("expired_before_refund", True, False), ("after_refund", True, True)):
            state, ordinals = harness.validate_v3_session(
                session[name], session_id=session["session_id"], deal_id=admitted["deal_id"],
                owner=admitted["owner"], providers=providers, nonce=session["nonce"],
                polyfs_root=harness.producer.b64(admitted["polyfs_root"], 32).hex(),
                integrity_root=harness.producer.b64(admitted["integrity_root"], 32).hex(),
                chain_id=doc["chain_id"], deadline_height=deadline, expired=expired, refunded=refunded)
            require(all(state[key] == value for key, value in immutable.items()), "frozen session authority changed")
            require(ordinals == ([] if name == "before_proofs" else list(range(132))),
                    "authoritative accepted ordinals differ from session bitmap")
            require([{k: v for k, v in row.items() if k != "sample_count"} for row in state["obligations"]] ==
                    [{k: v for k, v in row.items() if k != "sample_count"} for row in before["obligations"]],
                    "frozen obligation authority changed")
            if expired:
                require(state["obligations"] == session["after_proofs"]["session"]["obligations"],
                        "terminal obligations differ from accepted proofs")
            require(int(state["locked_fee"]) == (0 if refunded else 133), "session refund liability differs")
            if expired:
                require(session[name]["anchor_seed"] is None and int(state["updated_height"]) > deadline,
                        "expired session retains anchor or predates deadline")
        require(session["accepted_sample_ordinals"] == list(range(132)), "accepted ordinal inventory differs")
        refund = session["refund_transaction"]
        validate_transaction(refund, node_ids)
        recovered_refund = refund_messages[refund["txhash"]]
        raw_tx = base64.b64decode(recovered_refund["raw_tx_base64"], validate=True)
        require(hashlib.sha256(raw_tx).hexdigest().upper() == refund["txhash"] and
                len(raw_tx) == refund["validators"][0]["bytes"] == recovered_refund["raw_tx_bytes"] and
                recovered_refund["height"] == refund["height"], "refund receipt differs from stored transaction bytes")
        require(recovered_refund["messages"] == [{
            "type": "/polystorechain.polystorechain.v1.MsgRefundRetrievalSessionV3",
            "creator": admitted["owner"], "session_id": base64.b64encode(bytes.fromhex(session["session_id"])).decode(),
            "session_id_hex": session["session_id"]}], "refund message differs from session owner or identity")
        stored_validators = recovered_refund["validators"]
        require(len(stored_validators) == 4 and {row["node_id"] for row in stored_validators} == node_ids and
                all(row["height"] == refund["height"] and row["txhash"] == refund["txhash"] and
                    row["raw_tx_sha256"].upper() == refund["txhash"] and
                    row["tx_index"] == recovered_refund["tx_index"] for row in stored_validators),
                "refund blockstore agreement is incomplete")
        require(refund["txhash"] not in refund_hashes and refund["txhash"] not in {row["txhash"] for row in all_rows},
                "repeated refund transaction")
        refund_hashes.add(refund["txhash"])
        require(deadline < int(session["expired_before_refund"]["session"]["updated_height"]) < refund["height"] ==
                int(session["after_refund"]["session"]["updated_height"]), "refund transaction does not join terminal state")
    messages = [dict(row, id=f'v3-chain-{row["session_index"]}-{row["slot"]}') for row in native["inventory"]["messages"]]
    counts = harness.native_v3_chain_committed_summary(sessions, messages, warmups, rows)
    require(all(native[key] == value for key, value in counts.items()), "committed counters differ from authoritative inventory")
    simulations = native["gas_preflight"]
    require(len(simulations) == 64 and {(row["session_index"], row["slot"]) for row in simulations} ==
            {(index, slot) for index in range(8) for slot in range(8)}, "gas simulation inventory is incomplete")
    gas_by_id = {f'v3-chain-{row["session_index"]}-{row["slot"]}': row for row in simulations}
    tx_by_id = {row["id"]: row for row in all_rows}
    require(all(tx_by_id[row["id"]]["signer"] == row["provider"] and
                tx_by_id[row["id"]]["operation_id"] == f'session-{row["session_index"]}' and
                tx_by_id[row["id"]]["kind"] == "submit-proof" for row in messages),
            "committed signer/operation differs from proof inventory")
    require(all(gas_by_id[row["id"]]["message_sha256"] == row["message_sha256"] and
                gas_by_id[row["id"]]["gas_limit"] == tx_by_id[row["id"]]["gas_wanted"] for row in messages),
            "gas simulation differs from committed inventory")
    offsets = harness.native_v3_chain_offsets()
    start = native["scheduler"]["started_ns"]
    require(sorted(r["offered_ns"] - start for r in rows) == offsets, "offered schedule differs from harness profile")
    cohorts = []
    for index in range(3):
        left, right = index * 8_000_000_000, (index + 1) * 8_000_000_000
        offered = [r for r in rows if left <= r["offered_ns"] - start < right]
        require(len(offered) == (8, 16, 32)[index], "fixed cohort size mismatch")
        pending = [r for r in rows if r["offered_ns"] - start < right and r["finished_ns"] >= start + right]
        cohorts.append({"seconds": [index * 8, (index + 1) * 8], "offered": len(offered),
            "offered_rate_tx_s": len(offered) / 8, "eventually_committed_valid": len(offered),
            "client_observed_by_step_end_from_this_cohort": sum(r["finished_ns"] < start + right for r in offered),
            "all_client_completions_observed_in_step": sum(start + left <= r["finished_ns"] < start + right for r in rows),
            "end_fence_backlog": len(pending),
            "end_fence_queued": sum(r["started_ns"] >= start + right for r in pending),
            "end_fence_in_flight": sum(r["started_ns"] < start + right for r in pending)})

    workload = [tx for block in blocks for tx in block["transactions"] if tx.get("operation_id")]
    require(len(workload) == expected["measured"] and all(tx["code"] == 0 for tx in workload), "reconciled workload transactions invalid")
    scheduled = {r["txhash"]: r["operation_id"] for r in rows}
    committed = {tx["txhash"]: tx["operation_id"] for tx in workload}
    require(len(scheduled) == len(rows) and committed == scheduled, "scheduler/reconciliation transaction mapping mismatch")
    by_hash = {row["txhash"]: row for row in rows}
    for block in blocks:
        require(all(block[field] == sum(tx[tx_field] for tx in block["transactions"])
                    for field, tx_field in (("gas_wanted", "gas_wanted"), ("gas_used", "gas_used"),
                                            ("tx_payload_bytes", "bytes"))), "block totals differ from transactions")
        for tx in block["transactions"]:
            if not tx.get("operation_id"):
                continue
            row = by_hash[tx["txhash"]]
            require(row["height"] == block["height"] and tx["bytes"] == row["validators"][0]["bytes"] and
                    all(tx[key] == row[key] for key in ("code", "gas_wanted", "gas_used")),
                    "reconciled transaction differs from validator observations")
    require(sum(tx["gas_wanted"] for tx in workload) == native["measured_gas_wanted"], "measured gas-wanted mismatch")
    require(sum(tx["gas_used"] for tx in workload) == native["measured_gas_used"], "measured gas-used mismatch")
    block_rows = []
    for block in blocks:
        selected = [tx for tx in block["transactions"] if tx.get("operation_id")]
        block_rows.append({"height": block["height"], "transaction_count": len(block["transactions"]),
            "workload_transaction_count": len(selected), "gas_wanted": block["gas_wanted"],
            "gas_used": block["gas_used"], "gas_wanted_fraction_of_64m": block["gas_wanted"] / 64_000_000,
            "workload_gas_wanted": sum(tx["gas_wanted"] for tx in selected),
            "workload_gas_used": sum(tx["gas_used"] for tx in selected),
            "tx_payload_bytes": block["tx_payload_bytes"], "workload_tx_payload_bytes": sum(tx["bytes"] for tx in selected),
            "tx_payload_fraction_of_2mib": block["tx_payload_bytes"] / (2 * 1024 * 1024)})
    header_ns = [time_ns(block["time"]) for block in blocks]
    require(all(b >= a for a, b in zip(header_ns, header_ns[1:])), "block header time moved backwards")
    cpu = measured["validator_cpu_delta"]
    for snapshot in (measured["validator_cpu_before"], measured["validator_cpu_after"]):
        require(len(snapshot["validators"]) == 4 and
                {row["node_id"] for row in snapshot["validators"]} == node_ids and
                snapshot["clock_ticks_per_second"] > 0, "CPU snapshot validator set/tick rate mismatch")
    require(cpu == harness.validator_cpu_delta(measured["validator_cpu_before"], measured["validator_cpu_after"]),
            "CPU delta differs from retained snapshots")
    require(cpu["monotonic_start_ns"] <= measured["monotonic_start_ns"] <= start <= native["scheduler"]["finished_ns"] <=
            measured["monotonic_end_ns"] <= cpu["monotonic_end_ns"], "CPU/scheduler fences are inconsistent")
    cpu_rows = []
    for row in cpu["validators"]:
        seconds = (cpu["monotonic_end_ns"] - cpu["monotonic_start_ns"]) / 1e9
        require(seconds > 0 and row["pid"] > 0 and row["starttime_ticks"] > 0, "invalid validator CPU identity/window")
        cores = (row["user_cpu_seconds"] + row["system_cpu_seconds"]) / seconds
        cpu_rows.append({"validator": row["node_id"], "pid": row["pid"], "window_seconds": seconds,
            "user_cpu_seconds": row["user_cpu_seconds"], "system_cpu_seconds": row["system_cpu_seconds"],
            "average_cpu_cores": cores, "percent_of_one_core": cores * 100})

    resources = doc["validator_resources"]
    require(len(resources) == 4 and {row["node_id"] for row in resources} == node_ids and
            all(row["returncode"] == 0 and row["source"] == "wait4 rusage" and row["raw_unit"] == "KiB" and
                row["peak_rss_bytes"] == row["raw_ru_maxrss"] * 1024 > 0 and
                row["user_cpu_seconds"] >= 0 and row["system_cpu_seconds"] >= 0 for row in resources),
            "validator lifetime resources are incomplete or invalid")
    phases = doc["commit_step_metrics"]["phases"]
    require(set(phases) == {"native_v3_chain_before", "native_v3_chain_after"}, "Commit phases differ")
    for name, phase in phases.items():
        require(phase["complete"] and len(phase["nodes"]) == 4 and
                {row["node_id"] for row in phase["nodes"]} == node_ids, "Commit validator set is incomplete")
        for row in phase["nodes"]:
            sample = row["sample"]
            require(row["returncode"] == 0 and sample == json.loads(row["stdout"]) and
                    sample["boundary_fence"]["fully_observed"] and
                    sample["boundary_fence"]["node_id"] == row["node_id"], "Commit sample identity differs")
            require((sample["committed_height"] < reconciliation["first_height"] if name.endswith("before") else
                     sample["committed_height"] >= reconciliation["last_height"]), "Commit height does not fence workload")

    result = {"inputs": {"harness": str(args.harness.resolve()), "harness_sha256": hashlib.sha256(args.harness.read_bytes()).hexdigest(),
        "evidence_sha256": hashlib.sha256(args.evidence.read_bytes()).hexdigest(), "reconciled_blocks_sha256": reconciliation["sha256"],
        "refund_transactions_sha256": REFUND_TRANSACTIONS_SHA256},
        "scope": {"run_scope": args.run_scope, "qualification": False,
        "scope_note": ("bounded premerge correctness smoke; no retained performance acceptance"
                       if args.run_scope == "premerge-correctness-smoke"
                       else "finite landed chain-only diagnostic; no sustained capacity qualification"),
        "excludes": ["sustained capacity", "WAN or provider delivery", "ACK", "exact submit-to-inclusion latency"],
        "latency_note": "Queue, CheckTx, and client commit-observation timings are client-side observations; block header.Time is not commit completion."},
        "counts": expected, "scheduler_plus_drain_seconds": (native["scheduler"]["finished_ns"] - start) / 1e9,
        "preparation": {"proof_transactions": len(messages), "gas_simulations": len(simulations),
            "declared_gas_sum": sum(row["gas_limit"] for row in simulations),
            "summed_per_message_generation_ms": sum(row["generation_ms"] for row in messages),
            "timing_note": "Generation is summed per-message elapsed time across eight parallel exporters, not wall time. Gas simulation duration was not retained. Both occur before the measured scheduler."},
        "audits": {"profile": "normal", "verified_assignments": len(audit_rows),
            "before_height": doc["audit_before"]["height"], "finalized_height": doc["audit_after"]["height"],
            "measurement_epoch": native["measurement_preconditions"]["epoch"],
            "next_anchor": native["measurement_preconditions"]["next_anchor"]},
        "validator_lifetime_resources": doc["validator_resources"],
        "commit_step_metrics": {"boundary": doc["commit_step_metrics"]["boundary"],
            "qualification": False, "limitation": doc["commit_step_metrics"]["limitation"],
            "phases": {key: [{"node_id": row["node_id"], "sample": row["sample"]} for row in value["nodes"]]
                       for key, value in doc["commit_step_metrics"]["phases"].items()}},
        "finite_eventual_valid_rate_tx_s": expected["measured"] / ((native["scheduler"]["finished_ns"] - start) / 1e9),
        "cohorts": cohorts, "latencies": {"offer_to_worker_start": quantiles_ns([r["queue_latency_ns"] for r in rows]),
            "worker_start_to_checktx_observation": quantiles_ns([r["checktx_latency_ns"] for r in rows]),
            "worker_start_to_client_commit_observation": quantiles_ns([r["commit_observation_latency_ns"] for r in rows]),
            "offer_to_terminal_observation": quantiles_ns([r["terminal_latency_ns"] for r in rows])},
        "consensus": {"reconciled_height_range": [reconciliation["first_height"], reconciliation["last_height"]],
            "header_timestamp_span_seconds": (header_ns[-1] - header_ns[0]) / 1e9,
            "header_span_workload_transactions": len(workload),
            "header_span_note": "First-to-last reconciled block header timestamps; no exact wall-clock commit-completion rate is implied.",
            "header_interblock_time": quantiles_ns([b - a for a, b in zip(header_ns, header_ns[1:])]),
            "block_packing": block_rows, "payload_note": "tx_payload_bytes excludes headers, evidence, and serialization framing."},
        "validator_cpu": {"measurement_note": "Average cores use each validator's exact /proc CPU snapshot window and include consensus and enabled audits.",
            "validators": cpu_rows, "aggregate_average_cores": sum(row["average_cpu_cores"] for row in cpu_rows)}}
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        print(f"native-chain report rejected: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(2)
