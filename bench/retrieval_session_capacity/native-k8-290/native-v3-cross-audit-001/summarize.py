#!/usr/bin/env python3
"""Reconstruct the retained native-v3 cross-audit diagnostic from private inputs."""
import argparse, base64, hashlib, json, math, statistics, sys, types
from collections import Counter, defaultdict
from pathlib import Path

HARNESS_SHA256 = "2ebec09009fad961959ef0dd7fd72a0f471014d97805a782192c92df5cb4a05f"
EVIDENCE_SHA256 = "488e4e629641f272bbc2c5138aa2e1539d6d74f84ed5e3240b79679817627ebe"
BLOCKS_SHA256 = "8a319de7509e73d207252fa9b3dbfb19b1f08a3a366bc438c1396894548bcda4"
TRANSACTIONS_SHA256 = "97621fb3d5edc49d5c1c81b85a82b23ab33f3eaa0784b344f9212807e5f47ee7"
MODULES = {
    "retrieval_bench_artifact": "aeb5f811fb5f93ad4539f49a485c15af3747c765bd3d3997bc38335016a023d8",
    "retrieval_commit_metrics": "e8b272852684639efe6292d3b72eb2396fee0c2bdb99558d52c611b7d638e11f",
    "retrieval_fresh_proof": "74ced497d80442a7d463872623879737b7775ad2a49ec4c5a53ced8a8650e67b",
    "native_harness": HARNESS_SHA256,
}
COMMIT_SHA256 = {
    "2dc1ec9c1cfdcfcd97799d8579faa4378bc292b4": "c50674a94095903ec6031fe04cca4c0abbfb5c040ad736401a480681f80539e9",
    "303e1ba96a846764fc2540d64e2cde2beba4e77b": "4d6c5d59e014f7c94a6cc512bb05b51e1cc6fa867fce7618e086c0a76baa171a",
    "39bf300568acd1729f714b4abece18157fb7278a": "4ecbd72bc6c780f427ad8daf5722e47f1fe994a72511fa17c5f1566c984a6d83",
    "c7bad61aa9f70e24353b72c68671a6d6522a4294": "50945719d13b631cdc6627fb7dbed82ec698cc75b9fce22c425b7cbb2a481ed4",
}

def require(value, message):
    if not value:
        raise ValueError(message)

def sha(data): return hashlib.sha256(data).hexdigest()

def quantiles_ns(values):
    values = sorted(values)
    require(values, "empty latency inventory")
    rank = lambda q: values[math.ceil(q * len(values)) - 1] / 1e6
    return {"count": len(values), "median_ms": statistics.median(values) / 1e6,
            "p50_ms": rank(.50), "p95_ms": rank(.95), "p99_ms": rank(.99),
            "max_ms": values[-1] / 1e6,
            "percentile_method": "nearest rank; median uses conventional midpoint"}

def load_modules(harness_path):
    loaded = {}
    for name, digest in MODULES.items():
        path = harness_path if name == "native_harness" else harness_path.with_name(name + ".py")
        data = path.read_bytes()
        require(sha(data) == digest, f"unpinned harness module {path.name}")
        module = types.ModuleType(name)
        module.__file__ = str(path)
        sys.modules[name] = module
        exec(compile(data, str(path), "exec"), module.__dict__)
        loaded[name] = module
    return loaded

def validate_receipt(row, node_ids):
    require(row["outcome"] == "committed_success" and row["code"] == 0 and row["height"] > 0,
            "non-successful proof/open/refund receipt")
    validators = row["validators"]
    require(len(validators) == 4 and {v["node_id"] for v in validators} == node_ids,
            "receipt does not cover all four validators")
    for validator in validators:
        require(all(validator[key] == row[key] for key in ("txhash", "height", "code", "gas_wanted", "gas_used")),
                "validator receipt differs")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("harness", type=Path)
    parser.add_argument("evidence", type=Path)
    parser.add_argument("blocks", type=Path)
    parser.add_argument("transactions", type=Path)
    parser.add_argument("commit_streams", nargs=4, type=Path)
    args = parser.parse_args()
    raw_evidence, raw_blocks, raw_transactions = (args.evidence.read_bytes(), args.blocks.read_bytes(),
                                                   args.transactions.read_bytes())
    doc, recovered = json.loads(raw_evidence), json.loads(raw_transactions)
    modules = load_modules(args.harness.resolve())
    harness, commit_metrics = modules["native_harness"], modules["retrieval_commit_metrics"]

    require(doc["status"] == "native_v3_cross_audit_diagnostic_passed" and
            doc["mode"] == "four-validator-native-v3-cross-audit-diagnostic" and
            doc["qualification"] is False, "top-level diagnostic status/scope differs")
    require(doc["provenance"]["source_checkout"] == "da54964dc502f14bc73096fb6adc5f8ba0b2be6b" and
            doc["provenance"]["driver_sha256"] == HARNESS_SHA256,
            "retained run does not use the landed reviewed harness")
    require(doc["profile"]["audit_profile"] == "normal" and
            doc["profile"]["consensus"]["block"] == {"max_bytes": "2097152", "max_gas": "64000000"} and
            doc["profile"]["execution_budget_ms"] == 700 and
            doc["profile"]["memory_ceiling_per_validator_bytes"] == 2 * 1024**3 and
            doc["profile"]["budgets_measured"] is False,
            "consensus/audit/diagnostic budget profile differs")
    require((harness.V3_CROSS_AUDIT_SESSIONS, harness.V3_CROSS_AUDIT_WARMUPS,
             harness.V3_CROSS_AUDIT_MEASURED, harness.V3_CROSS_AUDIT_OFFER_SECONDS,
             harness.V3_CROSS_AUDIT_EPOCHS) == (46, 8, 360, 180, 2),
            "harness cross-audit profile differs")
    native = doc["native_v3_cross_audit"]
    require(native["status"] == "native_v3_cross_audit_diagnostic_finished" and
            native["qualification"] is False and native["expiration_verified"] and native["refunds_verified"] and
            not native["owner_acknowledged"] and not native["delivery_verified"],
            "native diagnostic completion/claim boundary differs")
    expected = {"sessions": 46, "warmup": 8, "measured": 360, "total": 368,
                "total_ordinals": 6072, "measured_ordinals": 5940, "audits": 24, "refunds": 46}
    require(len(native["sessions"]) == expected["sessions"] and
            len(native["warmup_proof_transactions"]) == expected["warmup"] and
            len(native["measured_proof_transactions"]) == expected["measured"] and
            len(native["audit_transactions"]) == expected["audits"], "retained transaction counts differ")
    require(native["total_committed_valid_proof_transactions"] == expected["total"] and
            native["measured_committed_valid_proof_transactions"] == expected["measured"] and
            native["total_authoritative_new_sample_ordinals"] == expected["total_ordinals"] and
            native["measured_authoritative_new_sample_ordinals"] == expected["measured_ordinals"],
            "committed proof or authoritative opening count differs")
    node_ids = {node["node_id"] for node in doc["nodes"]}
    require(len(node_ids) == len(doc["nodes"]) == 4, "validator identity set differs")
    admitted = doc["native_v3_generation"]["admitted"]["admitted"]
    providers = dict(enumerate(admitted["providers"]))
    require(len(providers) == 12, "provider assignment set differs")
    systematic = dict(list(providers.items())[:8])

    # Reuse the owning harness's authority and schedule checks.
    sessions = native["sessions"]
    require([row["nonce"] for row in sessions] == list(range(1, 47)), "session nonces differ")
    for index, session in enumerate(sessions):
        deadline = int(session["before_proofs"]["session"]["deadline_height"])
        stage_states = {}
        for name, expired, refunded in (("before_proofs", False, False), ("after_proofs", False, False),
                                        ("expired_before_refund", True, False), ("after_refund", True, True)):
            state, ordinals = harness.validate_v3_session(
                session[name], session_id=session["session_id"], deal_id=admitted["deal_id"],
                owner=admitted["owner"], providers=systematic, nonce=index + 1,
                polyfs_root=base64.b64decode(admitted["polyfs_root"], validate=True).hex(),
                integrity_root=base64.b64decode(admitted["integrity_root"], validate=True).hex(),
                chain_id=doc["chain_id"], deadline_height=deadline, expired=expired, refunded=refunded)
            require(ordinals == ([] if name == "before_proofs" else list(range(132))),
                    "session bitmap differs from committed proof inventory")
            stage_states[name] = state
        mutable_session_fields = {"accepted_sample_bitmap", "acked_slots_mask", "settled_slots_mask",
                                  "refunded_slots_mask", "locked_fee", "updated_height", "expired", "obligations"}
        immutable_sessions = [{key: value for key, value in state.items() if key not in mutable_session_fields}
                              for state in stage_states.values()]
        require(all(projection == immutable_sessions[0] for projection in immutable_sessions[1:]),
                "session immutable authority/economic/height fields changed across lifecycle")
        immutable_obligations = []
        for state in stage_states.values():
            immutable_obligations.append([
                {key: value for key, value in obligation.items() if key != "sample_count"}
                for obligation in state["obligations"]
            ])
        require(all(projection == immutable_obligations[0] for projection in immutable_obligations[1:]),
                "session obligation authority or frozen liability changed across lifecycle")
        proof_counts_by_provider = Counter()
        for receipt in session["proof_transactions"]:
            proof_counts_by_provider[receipt["provider"]] += len(receipt["ordinals"])
        expected_samples = [proof_counts_by_provider[obligation["assigned_provider"]]
                            for obligation in stage_states["after_proofs"]["obligations"]]
        require(sum(expected_samples) == 132 and
                all([int(obligation["sample_count"]) for obligation in stage_states[name]["obligations"]] ==
                    ([0] * 8 if name == "before_proofs" else expected_samples)
                    for name in stage_states),
                "obligation sample counts differ from committed provider ordinals")
        require(all(int(stage_states[name]["locked_fee"]) == 133 for name in
                    ("before_proofs", "after_proofs", "expired_before_refund")) and
                int(stage_states["after_refund"]["locked_fee"]) == 0 and
                all(sum(int(obligation["locked_fee"]) for obligation in stage_states[name]["obligations"]) == 133
                    for name in stage_states), "session or obligation locked fee differs across refund lifecycle")
    outcomes = doc["v3_http_phases"]["cross-audit-measured"]
    successful = [row for row in outcomes if row.get("status") == "success"]
    attempts_by_request = defaultdict(list)
    for row in outcomes: attempts_by_request[row["request_id"]].append(row)
    retried = [rows for rows in attempts_by_request.values() if len(rows) == 2]
    require(len(outcomes) == 373 and len(successful) == 360 and len(attempts_by_request) == 360 and
            len(retried) == 13 and all([row["attempt"] for row in rows] == [1, 2] and
                rows[0]["http_status"] == 429 and rows[0]["error"] == "retrieval submission busy" and
                rows[1].get("status") == "success" and rows[1]["http_status"] == 200 and
                all(rows[0][key] == rows[1][key] for key in
                    ("request_id", "request_index", "provider", "offered_ns", "initial_dispatch_ns"))
                for rows in retried) and
            all(len(rows) in (1, 2) and rows[-1].get("status") == "success" for rows in attempts_by_request.values()),
            "provider HTTP terminal success inventory differs")
    by_session = defaultdict(list)
    for row in successful: by_session[int(row["request_id"].split("-")[1])].append(row)
    for index in range(1, 46):
        harness.validate_v3_provider_outcomes(by_session[index], systematic,
                                              session_id=sessions[index]["session_id"])
    schedule = harness.native_v3_cross_audit_schedule()
    start_ns = doc["v3_http_schedules"]["cross-audit-measured"]["monotonic_start_ns"]
    require(harness.v3_http_schedule_bins(schedule, successful, start_ns=start_ns) == native["schedule_bins"],
            "30-second schedule bins differ from terminal observations")
    pre = native["measurement_preconditions"]
    epoch_lengths = {int(row["epoch_length"]) for row in pre["audits"].values()}
    require(epoch_lengths == {100}, "normal audit epoch length differs")
    require(harness.validate_v3_cross_audit_span(native["measured_proof_transactions"],
            pre["scheduled_start_height"], pre["next_anchor"], epoch_lengths.pop()) == native["proof_anchor_span"],
            "measured proof span differs from the two fixed audit anchors")
    require(harness.validate_v3_http_receipt_fence(native["measured_proof_transactions"], native["proof_receipt_fence"]) ==
            native["measured_window"]["proof_receipt_max_height"], "proof receipt fence differs")
    before = pre["provider_quiescence"]["sequences"]
    after = native["post_load_fence"]["provider_quiescence"]["sequences"]
    crossed = {int(epoch): {int(slot): view for slot, view in views.items()}
               for epoch, views in native["crossed_audits"].items()}
    require(set(crossed) == {4, 5} and all(set(views) == set(providers) for views in crossed.values()) and
            all(int(view["audit"]["accepted_count"]) ==
                int(view["audit"]["sample_count"]) == 1 and int(view["audit"]["missed_epochs"]) == 0
                for views in crossed.values() for view in views.values()),
            "two normal audit epochs did not cover all twelve assignments")
    require(harness.reconcile_cross_audit_sequences(before, after, providers,
            native["measured_proof_transactions"], native["audit_transactions"], crossed) ==
            native["provider_sequence_reconciliation"], "provider sequence reconciliation differs")

    # Bind every receipt to the authoritative stopped-blockstore transaction bytes.
    recovered_rows = recovered["transactions"]
    require(len(recovered_rows) == 440 and Counter(row["kind"] for row in recovered_rows) ==
            Counter(open=2, warmup=8, proof=360, audit=24, refund=46), "recovered transaction family counts differ")
    recovered_by_hash = {row["txhash"]: row for row in recovered_rows}
    require(len(recovered_by_hash) == 440, "recovered transaction hashes are not unique")
    receipt_rows = [batch["transaction"] for batch in doc["native_v3_open_batches"]] + native["warmup_proof_transactions"] + native["measured_proof_transactions"] + [session["refund_transaction"] for session in sessions]
    for row in receipt_rows: validate_receipt(row, node_ids)
    expected_hashes = {row["txhash"] for row in receipt_rows} | {row["txhash"] for row in native["audit_transactions"]}
    require(set(recovered_by_hash) == expected_hashes, "recovered bytes do not cover the exact workload receipts")
    proof_receipts = {row["txhash"]: row for row in native["warmup_proof_transactions"] + native["measured_proof_transactions"]}
    proof_sessions = {tx["txhash"]: session for session in sessions for tx in session["proof_transactions"]}
    audit_receipts = {row["txhash"]: row for row in native["audit_transactions"]}
    refund_receipts = {row["refund_transaction"]["txhash"]: row for row in sessions}
    open_counts = {batch["transaction"]["txhash"]: batch["count"] for batch in doc["native_v3_open_batches"]}
    open_sessions = {txhash: sorted([session for session in sessions if session["open_transaction"]["txhash"] == txhash],
                                    key=lambda session: session["nonce"])
                     for txhash in open_counts}
    for txhash, row in recovered_by_hash.items():
        raw = base64.b64decode(row["raw_tx_base64"], validate=True)
        require(sha(raw) == row["raw_tx_sha256"] == txhash.lower() and len(raw) == row["raw_tx_bytes"],
                "recovered raw transaction hash/size differs")
        require(len(row["validators"]) == 4 and {v["node_id"] for v in row["validators"]} == node_ids and
                all(v["txhash"] == txhash and v["height"] == row["height"] and
                    v["raw_tx_sha256"] == row["raw_tx_sha256"] and v["tx_index"] == row["tx_index"]
                    for v in row["validators"]), "stopped blockstores disagree on transaction bytes")
        messages = row["decoded"]["body"]["messages"]
        if row["kind"] == "open":
            expected_sessions = open_sessions[txhash]
            require(row["height"] == expected_sessions[0]["open_height"] and
                    len(messages) == open_counts[txhash] == len(expected_sessions), "open batch message authority/count differs")
            for message, session in zip(messages, expected_sessions):
                state = session["before_proofs"]["session"]
                expected_range = {"file_record_index": 0, "file_start_offset": "0",
                                  "file_length": "16777216", "range_start": "0", "range_length": "16777216"}
                require(message.get("@type", "").endswith("MsgOpenRetrievalSessionV3") and
                        message.get("creator") == admitted["owner"] and message.get("deal_id") == admitted["deal_id"] and
                        int(message.get("generation", 0)) == 1 and int(message.get("nonce", 0)) == session["nonce"] and
                        int(message.get("deadline_height", 0)) == int(state["deadline_height"]) and
                        message.get("range") == expected_range, "open batch message differs from ordered session authority")
        elif row["kind"] in ("warmup", "proof"):
            receipt = proof_receipts[txhash]
            session = proof_sessions[txhash]
            message = messages[0] if len(messages) == 1 else {}
            require(message.get("@type", "").endswith("MsgSubmitRetrievalSessionProofV3") and
                    message.get("creator") == receipt["provider"] and
                    base64.b64decode(message.get("session_id", ""), validate=True).hex() == session["session_id"] and
                    row["height"] == receipt["height"] and row["raw_tx_bytes"] == receipt["validators"][0]["bytes"] and
                    len(message.get("proofs", [])) == len(receipt["ordinals"]) and
                    [int(p["ordinal"]) for p in message["proofs"]] == receipt["ordinals"],
                    "proof bytes differ from provider, count, or authoritative ordinals")
        elif row["kind"] == "audit":
            receipt, message = audit_receipts[txhash], messages[0] if len(messages) == 1 else {}
            require(message.get("@type", "").endswith("MsgProveLiveness") and message.get("creator") == receipt["provider"] and
                    int(message.get("deal_id", -1)) == int(admitted["deal_id"]) and
                    int(message.get("epoch_id", 0)) == receipt["epoch"] and row["height"] == receipt["height"] and
                    isinstance(message.get("system_proof"), dict) and bool(message["system_proof"]) and set(message).intersection(
                    {"user_receipt", "system_proof", "user_receipt_batch", "session_proof"}) == {"system_proof"},
                    "audit bytes differ from provider/epoch/system proof")
        else:
            session, message = refund_receipts[txhash], messages[0] if len(messages) == 1 else {}
            require(message.get("@type", "").endswith("MsgRefundRetrievalSessionV3") and
                    message.get("creator") == admitted["owner"] and
                    base64.b64decode(message.get("session_id", ""), validate=True).hex() == session["session_id"],
                    "refund bytes differ from owner/session")

    reconciliation = doc["committed_block_reconciliation"]
    require(reconciliation == {"path": reconciliation["path"], "sha256": BLOCKS_SHA256,
            "first_height": 217, "last_height": 434, "committed_workload_transactions": 360,
            "all_four_headers_agree": True, "all_four_results_agree": True, "qualification": False},
            "block reconciliation scope differs")
    blocks = [json.loads(line) for line in raw_blocks.splitlines() if line.strip()]
    require([row["height"] for row in blocks] == list(range(217, 435)), "reconciled block range is not contiguous")
    workload = [(block["height"], tx) for block in blocks for tx in block["transactions"] if tx.get("operation_id")]
    measured_by_hash = {row["txhash"]: row for row in native["measured_proof_transactions"]}
    require({tx["txhash"] for _, tx in workload} == set(measured_by_hash) and len(workload) == 360 and
            all(tx["code"] == 0 and height == measured_by_hash[tx["txhash"]]["height"] for height, tx in workload),
            "reconciled blocks differ from measured successful proof receipts")
    for block in blocks:
        require(block["gas_wanted"] == sum(tx["gas_wanted"] for tx in block["transactions"]) and
                block["gas_used"] == sum(tx["gas_used"] for tx in block["transactions"]),
                "reconciled block gas totals differ")

    # Recompute Commit summaries from exact raw streams plus the independently fenced endpoints.
    phase = doc["commit_step_metrics"]["phases"]
    before_commit = {row["node_id"]: row["sample"] for row in phase["native_v3_cross_audit_before"]["nodes"]}
    after_commit = {row["node_id"]: row["sample"] for row in phase["native_v3_cross_audit_after"]["nodes"]}
    embedded_commit = {row["node_id"]: row for row in doc["native_v3_cross_audit_commit_streams"]}
    commit_rows = []
    seen_commit_nodes = set()
    for path in args.commit_streams:
        node_id = path.stem.rsplit("-", 1)[-1]
        require(node_id in COMMIT_SHA256 and node_id not in seen_commit_nodes and
                sha(path.read_bytes()) == COMMIT_SHA256[node_id], "Commit stream hash/identity differs")
        seen_commit_nodes.add(node_id)
        samples = [json.loads(line) for line in path.read_text().splitlines() if line]
        start, end = before_commit[node_id], after_commit[node_id]
        fenced = [start] + [sample for sample in samples if sample["monotonic_start_ns"] >= start["monotonic_end_ns"] and
                            sample["monotonic_end_ns"] <= end["monotonic_start_ns"]] + [end]
        recomputed = commit_metrics.summarize_commit_metrics(fenced, start_committed_height=start["committed_height"],
                                                              end_committed_height=end["committed_height"], boundaries_reconciled=True)
        require(recomputed == embedded_commit[node_id]["summary"] and recomputed["qualified"] and
                recomputed["within_700ms_budget"], "Commit stream summary differs or is unqualified")
        commit_rows.append({"validator": node_id, "raw_samples": len(samples), "fenced_samples": len(fenced),
                            "observed_blocks": recomputed["observed_blocks"],
                            "p95_upper_bound_ms": float(recomputed["p95_upper_bound_seconds"]) * 1000,
                            "within_700ms_budget": True})
    require(seen_commit_nodes == set(COMMIT_SHA256), "Commit stream validator set differs")

    schedule_doc = doc["v3_http_schedules"]["cross-audit-measured"]
    require(schedule_doc["offered"] == schedule_doc["completed"] == 360 and schedule_doc["queued"] == schedule_doc["in_flight"] == 0 and
            schedule_doc["terminal_error"] is None, "HTTP scheduler did not fully drain")
    cpu = native["measured_window"]["validator_cpu_delta"]
    require(cpu == harness.validator_cpu_delta(native["measured_window"]["validator_cpu_before"],
                                                native["measured_window"]["validator_cpu_after"]),
            "validator CPU delta differs from retained snapshots")
    cpu_seconds = (cpu["monotonic_end_ns"] - cpu["monotonic_start_ns"]) / 1e9
    cpu_rows = [{"validator": row["node_id"], "window_seconds": cpu_seconds,
                 "user_cpu_seconds": row["user_cpu_seconds"], "system_cpu_seconds": row["system_cpu_seconds"],
                 "mean_cores_over_window": (row["user_cpu_seconds"] + row["system_cpu_seconds"]) / cpu_seconds}
                for row in cpu["validators"]]
    resources = [{"validator": row["node_id"], "peak_rss_bytes": row["peak_rss_bytes"],
                  "measurement_scope": row["measurement_scope"], "returncode": row["returncode"]}
                 for row in doc["validator_resources"]]
    require(len(resources) == 4 and {row["validator"] for row in resources} == node_ids and
            all(row["measurement_scope"] == "whole validator process lifetime" and row["returncode"] == 0 and
                0 < row["peak_rss_bytes"] < doc["profile"]["memory_ceiling_per_validator_bytes"] for row in resources),
            "validator resource lifecycle differs")
    terminal = [row["request_finished_ns"] - row["offered_ns"] for row in successful]
    pre_success = [row["request_started_ns"] - row["offered_ns"] for row in successful]
    initial_dispatch = [row["initial_dispatch_ns"] - row["offered_ns"] for row in successful]
    request = [row["request_finished_ns"] - row["request_started_ns"] for row in successful]
    gas_used = sorted(row["gas_used"] for row in native["measured_proof_transactions"])
    proof_counts = Counter(len(row["ordinals"]) for row in native["measured_proof_transactions"])
    block_peak = max(blocks, key=lambda row: row["gas_used"])
    summary = {
        "schema": "polystore.native-v3-cross-audit-retained.v1",
        "status": "passed",
        "qualification": False,
        "claim": "single-host native-v3 provider-route operating-point diagnostic; no maximum-capacity, WAN, or delivered-byte qualification",
        "source": {"harness_commit": doc["provenance"]["source_checkout"],
                   "product_source_commit": doc["provenance"]["product_source_commit"],
                   "chain_id": doc["chain_id"], "runtime_artifact_source_match": doc["provenance"]["artifact_source_match"]},
        "profile": {"validators": 4, "provider_daemons": 12, "systematic_providers": 8,
                    "sessions": 46, "open_batch_sizes": [31, 15], "warmup_transactions": 8,
                    "measured_offer_seconds": 180, "offered_transactions_per_second": 2,
                    "measured_proof_transactions": 360, "measured_openings": 5940,
                    "offered_openings_per_second": 33, "normal_audit_epochs": 2,
                    "normal_audit_transactions": 24, "commit_p95_budget_ms": 700,
                    "validator_memory_ceiling_bytes": 2 * 1024**3,
                    "budgets_measured_for_qualification": False},
        "result": {"measured_committed_valid_proof_transactions": 360,
                   "measured_authoritative_new_openings": 5940,
                   "scheduler_elapsed_seconds": schedule_doc["elapsed_ns"] / 1e9,
                   "scheduler_drain_seconds": (schedule_doc["elapsed_ns"] - schedule_doc["offered_window_ns"]) / 1e9,
                   "committed_valid_transactions_per_scheduler_second": 360 / (schedule_doc["elapsed_ns"] / 1e9),
                   "authoritative_openings_per_scheduler_second": 5940 / (schedule_doc["elapsed_ns"] / 1e9),
                   "rate_denominator": "all 360 client-observed committed successes over scheduler start through final terminal observation, including drain",
                   "maximum_queued": schedule_doc["max_queued"], "maximum_in_flight": schedule_doc["max_in_flight"],
                   "maximum_dispatch_lag_ms": schedule_doc["max_dispatch_lag_ns"] / 1e6,
                   "http_attempts": {"scheduled_requests": 360, "total_attempts": 373,
                                     "successful_http_200": 360, "backpressure_http_429": 13,
                                     "retried_requests": 13, "terminal_failures": 0,
                                     "unclassified_attempts": 0},
                   "terminal_observation_latency": quantiles_ns(terminal),
                   "pre_success_start_delay": quantiles_ns(pre_success),
                   "initial_dispatch_lag": quantiles_ns(initial_dispatch),
                   "request_duration": quantiles_ns(request),
                   "client_observation_bins": native["schedule_bins"],
                   "proof_commit_height_span": native["proof_anchor_span"],
                   "reconciled_block_span": {"first_height": 217, "last_height": 434, "blocks": 218,
                                               "committed_measured_proof_transactions": 360,
                                               "all_four_headers_agree": True, "all_four_results_agree": True},
                   "measured_gas": {"wanted_total": native["measured_gas_wanted"], "used_total": native["measured_gas_used"],
                                    "proof_count_distribution": {str(key): proof_counts[key] for key in sorted(proof_counts)},
                                    "used_per_authoritative_opening": native["measured_gas_used"] / 5940,
                                    "used_per_transaction_min": gas_used[0], "used_per_transaction_median": statistics.median(gas_used),
                                    "used_per_transaction_max": gas_used[-1],
                                    "peak_block_height_by_used_gas": block_peak["height"],
                                    "peak_block_gas_wanted": block_peak["gas_wanted"], "peak_block_gas_used": block_peak["gas_used"]},
                   "audits": {"epochs": native["crossed_audit_epochs"], "transactions": 24,
                              "all_assignments_accepted": True, "missed": 0},
                   "refunds": {"sessions_expired": 46, "refund_transactions": 46, "all_verified": True},
                   "commit_step": sorted(commit_rows, key=lambda row: row["validator"]),
                   "validator_cpu": cpu_rows, "validator_resources": resources},
        "limitations": [
            "Four validators and twelve provider-daemons ran on one Linux host; this is not a realistic deployment.",
            "The 2 transactions/s schedule is an accepted local operating point, not a measured maximum.",
            "HTTP terminal timing combines proof generation, native verification, gas simulation, signing, broadcast, and client commit observation.",
            "Pre-success-start delay includes scheduler delay and, for 13 requests, retry backoff after an HTTP 429; it is not a pure signer-queue measurement.",
            "Commit p95 values are execution upper bounds from the Commit metric; they exclude the documented post-persistence tail.",
            "CPU is a fixed-window process tick delta; RSS is a whole-process-lifetime peak, not a phase peak or 2 GiB usage claim.",
            "Consensus header times are not wall-clock commit-completion timestamps, so this report makes no header-time throughput claim.",
            "The retained HTTP receipts do not separate CheckTx latency from block inclusion; only the combined client terminal observation is reported.",
            "No owner ACK or byte delivery was performed; delivery, resume, cache, WAN, and maximum capacity remain unqualified."],
        "private_inputs": {"evidence": {"sha256": sha(raw_evidence), "bytes": len(raw_evidence)},
                           "blocks": {"sha256": sha(raw_blocks), "bytes": len(raw_blocks)},
                           "transactions": {"sha256": sha(raw_transactions), "bytes": len(raw_transactions)},
                           "commit_streams": {node: {"sha256": digest} for node, digest in sorted(COMMIT_SHA256.items())}},
        "reproduction": {"harness": "$HARNESS_SOURCE/scripts/retrieval_four_validator_workload.py",
                         "inputs_are_private": True}
    }
    # Literal input pins are checked only after the semantic reconstruction above.
    require(sha(raw_evidence) == EVIDENCE_SHA256, "retained evidence bytes differ from the publication pin")
    require(sha(raw_blocks) == BLOCKS_SHA256, "retained block bytes differ from the publication pin")
    require(sha(raw_transactions) == TRANSACTIONS_SHA256, "recovered transaction bytes differ from the publication pin")
    print(json.dumps(summary, indent=2, sort_keys=True))

if __name__ == "__main__": main()
