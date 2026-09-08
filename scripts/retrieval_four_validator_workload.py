#!/usr/bin/env python3
"""Bounded four-validator fresh-proof settlement smoke; never capacity qualification.

Uses exported nonconstant K8/K2 fixtures at slot zero, two owner escrows and two
explicit proof authorities. No provider transport or delivered-file verification
is exercised. This command starts owned validators only when explicitly invoked.
"""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import signal
import sqlite3
import sys
import urllib.parse

import retrieval_bench_artifact as artifact
import retrieval_commit_metrics as commit_metrics
import retrieval_fresh_proof as producer

API = "/polystorechain/polystorechain/v1"
ENV_KEYS = ("GOMAXPROCS", "POLYSTORE_TRUSTED_SETUP", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH")
COUNTS = (1, 2, 8)


def capture_workload_metrics(lifecycle, phase):
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
            result = artifact.run_bounded_command(
                [sys.executable, commit_metrics.__file__, endpoint, lifecycle.chain, "--timeout", "2"],
                deadline, env=lifecycle.env)
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
    mint["minter"]["inflation"] = "0.000000000000000000"
    for field in ("inflation_rate_change", "inflation_min", "inflation_max"):
        mint["params"][field] = "0.000000000000000000"
    raw = json.dumps(genesis, sort_keys=True, indent=1) + "\n"
    for node in lifecycle.nodes:
        (Path(node["home"]) / "config/genesis.json").write_text(raw)
        lifecycle.cli(node["home"], "genesis", "validate")
    lifecycle.doc.update(genesis_sha256=artifact.sha256(first), frozen_module_params=params,
                         smoke_mint_profile=mint,
                         economics_scope="zero mint smoke profile; production mint/issuance qualification outstanding")


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


def journal_results(path, operations):
    with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as db:
        rows = {identity: json.loads(result) if result else None for identity, result in db.execute("SELECT id, result FROM operations")}
        transactions = [json.loads(row[0]) for row in db.execute("SELECT result FROM transactions ORDER BY rowid")]
    if set(rows) != {op["operation_id"] for op in operations} or any(not row or row.get("all_transactions_committed") is not True for row in rows.values()):
        raise ValueError("lifecycle did not commit every open/proof/confirmation; inspect retained journal")
    if len(transactions) != 3 * len(operations) or any(row["outcome"] != "committed_success" for row in transactions):
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


def verify_settlement(before, after, operations, results, transactions, signers):
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
        delta(before["bank"]["supply"]["stake"], after["bank"]["supply"]["stake"]) != -burns):
        raise ValueError("module/supply conservation mismatch")
    return dict(completed_sessions=len(operations), proofs=sum(op["proof_expectation"]["session"]["blob_count"] for op in operations),
                escrow_debits=debits, provider_payouts=payouts, burned_stake=burns,
                byte_counter_scope="protocol counters; no network-delivered bytes verified")


def run(lifecycle, fixture_k8, fixture_k2):
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
                       "Only slot zero; nonzero stripe slots remain outstanding", "Zero mint smoke economics; production issuance remains outstanding"],
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
        capture_workload_metrics(lifecycle, "before_workload")
        doc["scheduler"] = artifact.schedule_retrieval_lifecycles(operations, journal_path=journal,
            signers=list(lifecycle.signers.values()), prepare_session_proof=prepare,
            max_in_flight=2, max_queued=16, max_queued_per_signer=8)
        results, transactions = journal_results(journal, operations)
        doc.update(operation_results=results, workload_transactions=transactions,
                   transactions_submitted=len(doc["setup_transactions"]) + len(transactions))
        capture_workload_metrics(lifecycle, "after_workload")
        doc["fresh_proof_artifacts"] = {}
        for op in operations:
            sid = results[op["operation_id"]]["session_id"]
            k = op["proof_expectation"]["snapshot"]["k"]
            path = lifecycle.home / f"fresh-k{k}" / (sid + ".json")
            doc["fresh_proof_artifacts"][sid] = dict(path=str(path), sha256=artifact.sha256(path))
        height = lifecycle.wait_height(max(row["height"] for row in transactions) + 1) - 1
        ids = [row["session_id"] for row in results.values()]
        after = retrieval_snapshot(lifecycle, height, deals, ids)
        doc["settlement"] = verify_settlement(before, after, operations, results, transactions, lifecycle.signers)
        doc["after_workload"] = after
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
        verify_settlement(before, doc["after_restart_later_height"], operations, results, transactions, lifecycle.signers)
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ("binary", "library", "home", "fixture-k8", "fixture-k2"):
        parser.add_argument("--" + flag, required=True)
    parser.add_argument("--timeout", type=int, default=600)
    options = vars(parser.parse_args())
    k8, k2 = options.pop("fixture_k8"), options.pop("fixture_k2")
    print(run(artifact.FourValidatorLifecycle(**options), k8, k2))


if __name__ == "__main__":
    main()
