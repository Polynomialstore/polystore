#!/usr/bin/env python3
"""Bounded four-validator diagnostics; never capacity qualification.

Settlement smoke uses exported K8/K2 fixtures without provider transport.
Healthy-providers uses canonical K2 ingest and three provider-daemons to check
normal storage audits. Neither mode verifies delivered files. Owned services
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

import retrieval_bench_artifact as artifact
import retrieval_commit_metrics as commit_metrics
import retrieval_fresh_proof as producer

API = "/polystorechain/polystorechain/v1"
ENV_KEYS = ("GOMAXPROCS", "POLYSTORE_TRUSTED_SETUP", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH")
COUNTS = (1, 2, 8)


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


def journal_results(path, operations, *, proof_only=False):
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        rows = {identity: json.loads(result) if result else None for identity, result in db.execute("SELECT id, result FROM operations")}
        transactions = [json.loads(row[0]) for row in db.execute("SELECT result FROM transactions ORDER BY rowid")]
    if set(rows) != {op["operation_id"] for op in operations} or any(not row or row.get("all_transactions_committed") is not True for row in rows.values()):
        raise ValueError("lifecycle did not commit every open/proof/confirmation; inspect retained journal")
    if (len(transactions) != (1 if proof_only else 3) * len(operations) or
            any(row["outcome"] != "committed_success" for row in transactions) or
            (proof_only and any(row.get("proof_submitted") is not True for row in rows.values()))):
        raise ValueError("unexpected transaction outcomes")
    ids = [row["session_id"] for row in rows.values()]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate committed session")
    return rows, transactions


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
    observed = []
    for node in lifecycle.nodes:
        response = lifecycle.query(node, "/tx?hash=0x" + expected["txhash"])
        raw = base64.b64decode(response["tx"], validate=True)
        if not raw or len(raw) > 1048576 or hashlib.sha256(raw).hexdigest().upper() != expected["txhash"].upper():
            raise ValueError("validator returned different committed transaction bytes")
        row = dict(txhash=response["hash"], height=response["height"], **{
            key: response["tx_result"].get(key, 0) if key == "code" else response["tx_result"][key]
            for key in ("code", "gas_wanted", "gas_used")})
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


def healthy_audit_views(value, deal, providers, epoch, epoch_length, chain, *, finalized):
    """Check committed inventory/coverage without treating absent audits as success."""
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
                [producer.uint(snapshot[n]) for n in ("layout", "k", "m", "metadata_mdus", "user_mdus")] != [2, 2, 1, 2, 1] or
                snapshot["setup_digest"] != base64.b64encode(bytes.fromhex(producer.SETUP_DIGEST)).decode() or
                producer.uint(snapshot["deal_end"]) != producer.uint(deal["end_block"])):
            raise ValueError("audit differs from the committed K2 assignment")
        count = producer.uint(audit["sample_count"])
        if not 1 <= count <= 32:  # One K2 user MDU has 32 distinct rows per slot.
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
            payee=producer.account(providers[slot]).hex(), layout=2, k=2, m=1, slot=slot, metadata_mdus=2,
            user_mdus=1, start_mdu=0, start_leaf=0, blob_count=0, epoch_id=epoch, epoch_length=epoch_length,
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
    if set(found) != set(providers) or len(found) != 3:
        raise ValueError("missing or duplicate all-slot audit evidence")
    return found


def run_healthy(lifecycle, gateway_binary, cli_binary, product_source):
    """Real canonical ingest and normal audit diagnostic; no retrieval/capacity claim."""
    gateway = Path(gateway_binary).resolve(strict=True)
    cli = Path(cli_binary).resolve(strict=True)
    source = Path(product_source).resolve(strict=True)
    for binary in (gateway, cli):
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise ValueError("gateway and native CLI binaries must be executable")
    if not (source / "polystore_cli/src/main.rs").is_file():
        raise ValueError("product-source must identify the supplied product source checkout")
    curl = shutil.which("curl")
    if not curl:
        raise ValueError("curl is required for bounded multipart upload")
    lifecycle.home.mkdir(mode=0o700)
    processes, reservations = [], []
    previous = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"interrupted by signal {signum}")
    for sig in previous:
        signal.signal(sig, interrupted)
    doc = lifecycle.doc
    doc.pop("transactions_submitted", None)
    doc.update(mode="four-validator-healthy-provider-diagnostic", setup_transactions=[], providers=[],
        workload="one real K2 deal; three assigned provider-daemons; one normal audit epoch",
        qualification=False, limits=["No capacity or delivered retrieval qualification", "No deputy retrieval yet",
            "Normal mint and audit parameters retained; no economic conservation assertion", "No restart qualification"])
    def command(args, timeout=60):
        lifecycle.remaining()
        result = artifact.run_bounded_command(args, min(lifecycle.deadline, artifact.monotonic_ns() + timeout * 10**9), env=lifecycle.env)
        if result.returncode:
            raise ValueError("owned diagnostic command failed: " + (result.stderr + result.stdout)[-8192:])
        return result.stdout
    def send(name, args):
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
        while True:
            check_providers()
            current = lifecycle.wait_height(1)
            if current >= height:
                return current
            time.sleep(min(0.2, lifecycle.remaining()))
    try:
        require_retrieval_cli(lifecycle)
        lifecycle.reserve_ports()
        for i in range(3):
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
        lifecycle.prepare()  # Do not call smoke_genesis: normal mint/audit defaults remain intact.
        genesis = json.loads((Path(lifecycle.nodes[0]["home"]) / "config/genesis.json").read_text())
        doc["normal_mint_profile"] = genesis["app_state"]["mint"]
        epoch_length = producer.uint(doc["frozen_module_params"]["epoch_len_blocks"])
        if epoch_length < 2:
            raise ValueError("normal storage audits require epochs")
        lifecycle.save()
        lifecycle.start("initial")
        lifecycle.wait_height(3)
        for i in range(3):
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
                POLYSTORE_GATEWAY_SP_AUTH="healthy-diagnostic-owned-local-stack")
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
        for i in range(3):
            while True:
                check_providers()
                try:
                    command([curl, "--silent", "--show-error", "--fail", "--max-time", "2", f"http://127.0.0.1:{19091+i}/health"], 3)
                    break
                except ValueError:
                    time.sleep(min(0.2, lifecycle.remaining()))
        created = send("owner0", ["create-deal", "100000", "100000000", "10000000", "--service-hint", "General:rs=2+1"])
        wait(created["height"] + 1)
        owned = [d for d in lifecycle.query(lifecycle.nodes[0], API + "/deals", created["height"])["deals"]
                 if d["owner"] == lifecycle.signers["owner0"]]
        if len(owned) != 1:
            raise ValueError("expected exactly one owner deal")
        identity = str(owned[0].get("id", "0"))
        payload = lifecycle.home / "payload.bin"
        block = bytes((i * 37 + i // 97) % 256 for i in range(4096))
        with payload.open("xb") as output:
            for _ in range(8126464 // len(block)):
                output.write(block)
        doc["payload"] = dict(path=str(payload), bytes=payload.stat().st_size, sha256=artifact.sha256(payload))
        uploaded = json.loads(command([curl, "--silent", "--show-error", "--fail", "--max-time", "180",
            "--form-string", "owner=" + lifecycle.signers["owner0"], "--form-string", "file_path=payload.bin",
            "--form", "file=@" + str(payload), f"http://127.0.0.1:19091/sp/retrieval/upload?deal_id={identity}"], 185))
        root = uploaded["manifest_root"]
        if (not isinstance(root, str) or len(root) != 66 or root != "0x" + bytes.fromhex(root[2:]).hex() or
                [producer.uint(uploaded[n]) for n in ("size_bytes", "file_size_bytes", "logical_size_bytes", "total_mdus", "witness_mdus")] != [8126464, 8126464, 8126464, 3, 1] or
                uploaded.get("content_encoding") != "none"):
            raise ValueError("canonical K2 ingest returned unexpected content")
        doc["ingest"] = uploaded
        updated = send("owner0", ["update-deal-content", "--deal-id", identity, "--cid", root,
            "--size", "8126464", "--total-mdus", "3", "--witness-mdus", "1"])
        height = updated["height"]
        wait(height + 1)
        deal = lifecycle.query(lifecycle.nodes[0], API + "/deals/" + identity, height)["deal"]
        deal["id"] = identity
        if producer.b64(deal["manifest_root"], 32).hex() != root[2:]:
            raise ValueError("committed root differs from ingest")
        providers = {}
        for slot in deal["mode2_slots"]:
            index = producer.uint(slot.get("slot", 0))
            if index in providers or slot["status"] != "SLOT_STATUS_ACTIVE" or slot.get("pending_provider"):
                raise ValueError("K2 slots must be distinct and ACTIVE")
            providers[index] = slot["provider"]
        if set(providers) != {0, 1, 2} or set(providers.values()) != {lifecycle.signers[f"provider{i}"] for i in range(3)}:
            raise ValueError("K2 placement differs from the three owned providers")
        doc["deal"] = deal
        doc["canonical_artifacts"] = []
        for slot, address in providers.items():
            provider = next(row for row in doc["providers"] if row["address"] == address)
            directory = Path(provider["directory"]) / "deals" / identity / root[2:]
            for filename, size in (("mdu_0.bin", 8388608), ("mdu_1.bin", 8388608),
                                   (f"mdu_2_slot_{slot}.bin", 4194304)):
                path = directory / filename
                if path.stat().st_size != size:
                    raise ValueError("provider canonical artifact has wrong size")
                doc["canonical_artifacts"].append(dict(slot=slot, provider=address, path=str(path),
                    bytes=size, sha256=artifact.sha256(path)))
        epoch = (height - 1) // epoch_length + 2
        def audits(at, finalized):
            rows = []
            for node in lifecycle.nodes:
                values = []
                for address in providers.values():
                    values.extend(lifecycle.query(node, API + "/storage-audits/by-provider/" + address, at)["audits"])
                checked = healthy_audit_views(values, deal, providers, epoch, epoch_length, lifecycle.chain, finalized=finalized)
                anchor_height = (epoch - 1) * epoch_length + 1
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
    for flag in ("fixture-k8", "fixture-k2", "gateway-binary", "cli-binary", "product-source"):
        parser.add_argument("--" + flag)
    parser.add_argument("--mode", choices=("settlement-smoke", "healthy-providers"), default="settlement-smoke")
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--proof-only", action="store_true", help="Prepare six sessions, verify rejected transactions, time proofs, then verify idempotent settlement retries")
    options = vars(parser.parse_args())
    k8, k2 = options.pop("fixture_k8"), options.pop("fixture_k2")
    proof_only = options.pop("proof_only")
    mode, gateway = options.pop("mode"), options.pop("gateway_binary")
    cli, source = options.pop("cli_binary"), options.pop("product_source")
    if mode == "healthy-providers":
        if not gateway or not cli or not source or k8 or k2 or proof_only or options["timeout"] > 600:
            parser.error("healthy-providers requires --gateway-binary/--cli-binary/--product-source, timeout <= 600, and excludes fixtures/--proof-only")
        print(run_healthy(artifact.FourValidatorLifecycle(**options), gateway, cli, source))
    else:
        if not k8 or not k2 or gateway or cli or source:
            parser.error("settlement-smoke requires both fixtures and excludes --gateway-binary")
        print(run(artifact.FourValidatorLifecycle(**options), k8, k2, proof_only=proof_only))


if __name__ == "__main__":
    main()
