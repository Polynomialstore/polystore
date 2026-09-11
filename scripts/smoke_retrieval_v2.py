#!/usr/bin/env python3
"""Bounded CLI -> live node -> query smoke; no throughput or delivery claim.

Build the current native library and daemon first. Run with --binary and
--library absolute paths, and a new --output directory. Keeps its isolated home
and evidence; terminates only the child it starts. No existing chain is reused.
"""
import argparse
import base64
import copy
import ctypes
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

from retrieval_bench_artifact import committed_tx, opened_session_id, sha256
from retrieval_consensus_profile import load_consensus_profile

ROOT = Path(__file__).resolve().parent.parent
FR = int("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001", 16)
API = "/polystorechain/polystorechain/v1"


def fresh_z(context_hash, seed):
    # C2 for ordinal 0, MDU 2, leaf 0. The independent maintained golden oracle
    # covers the complete schema; here the live node supplies canonical context.
    domain = b"polystore/blob-challenge/v2"
    prefix = len(domain).to_bytes(4, "big") + domain + context_hash + seed
    prefix += (0).to_bytes(8, "big") + (2).to_bytes(8, "big") + (0).to_bytes(4, "big")
    for counter in range(256):
        z = hashlib.sha256(prefix + counter.to_bytes(4, "big")).digest()
        value = int.from_bytes(z, "big")
        if 0 < value < FR and pow(value, 4096, FR) != 1:
            return z
    raise ValueError("C2 scalar rejection exhausted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--library", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    binary, library = args.binary.resolve(strict=True), args.library.resolve(strict=True)
    output = args.output.absolute()
    output.mkdir(mode=0o700)  # Deliberately refuses any existing output/home.
    home = output / "home"
    home.mkdir(mode=0o700)
    chain = "polystore_257-1"
    env = dict(os.environ, POLYSTORE_TRUSTED_SETUP=str(ROOT / "polystorechain/trusted_setup.txt"), GOMAXPROCS="2")
    report = {"status": "running", "qualification": False,
              "scope": "native CLI proof settlement; no browser byte-delivery or capacity claim",
              "binary_sha256": sha256(binary), "library_sha256": sha256(library),
              "setup_sha256": sha256(env["POLYSTORE_TRUSTED_SETUP"]),
              "harness_sha256": sha256(__file__),
              "fixture_sha256": sha256(ROOT / "polystorechain/x/polystorechain/keeper/testdata/proof_admission_k8.json"),
              "source_revision": subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip(),
              "source_diff_sha256": hashlib.sha256(subprocess.check_output(["git", "-C", str(ROOT), "diff", "HEAD", "--", "polystorechain", "polystore_core"])).hexdigest(),
              "transactions": []}
    node = None
    log = None
    deadline = time.monotonic() + 300

    def run(*command):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("five-minute smoke deadline")
        p = subprocess.run([str(binary), *map(str, command), "--home", str(home)], env=env,
                           capture_output=True, text=True, timeout=min(30, remaining))
        if p.returncode:
            raise RuntimeError(f"{command[:3]}: {p.stderr[-4000:]}")
        return p.stdout

    def request(url, method="GET", headers=None):
        with urllib.request.urlopen(urllib.request.Request(url, method=method, headers=headers or {}), timeout=3) as response:
            body = response.read(4 * 1024 * 1024 + 1)
            if len(body) > 4 * 1024 * 1024:
                raise ValueError("oversized response")
            return response.status, {k.lower(): v for k, v in response.headers.items()}, body

    # Keep distinct port reservations until immediately before node startup.
    sockets = [socket.socket() for _ in range(4)]
    for reservation in sockets:
        reservation.bind(("127.0.0.1", 0))
    rpc, p2p, grpc, api = [s.getsockname()[1] for s in sockets]
    rpc_url, api_url = f"http://127.0.0.1:{rpc}", f"http://127.0.0.1:{api}"

    def query(path):
        return json.loads(request(api_url + path)[2])

    def send(key, *command, gas="2000000"):
        start = time.monotonic()
        raw = run("tx", "nilchain", *command, "--from", key, "--keyring-backend", "test",
                  "--chain-id", chain, "--node", rpc_url, "--gas", gas, "--gas-adjustment", "1.6",
                  "--gas-prices", "0.001aatom", "--broadcast-mode", "sync", "--output", "json", "--yes")
        check = json.loads(raw)
        if type(check.get("code")) is not int or check["code"] != 0:
            raise ValueError(f"CheckTx rejected: {check}")
        txhash = check["txhash"]
        until = min(deadline, time.monotonic() + 20)
        while time.monotonic() < until:
            try:
                tx = committed_tx(query("/cosmos/tx/v1beta1/txs/" + txhash)["tx_response"], txhash)
                row = {k: tx[k] for k in ("txhash", "height", "code", "gas_wanted", "gas_used")}
                row.update(command=list(map(str, command)), signer=key, wall_seconds=time.monotonic() - start)
                report["transactions"].append(row)
                if int(tx["code"]) != 0:
                    raise ValueError(f"committed failure: {tx.get('raw_log')}")
                return tx
            except urllib.error.HTTPError as exc:
                if exc.code != 404:
                    raise
            time.sleep(.25)
        raise TimeoutError(f"unknown transaction {txhash}; stopping before signer reuse")

    def balance(address):
        return int(query(f"/cosmos/bank/v1beta1/balances/{address}/by_denom?denom=stake")["balance"]["amount"])

    def session(session_id):
        encoded = urllib.parse.quote(base64.urlsafe_b64encode(bytes.fromhex(session_id)).decode(), safe="")
        return query(API + "/retrieval-sessions/" + encoded)

    try:
        run("init", "retrieval-v2-smoke", "--chain-id", chain)
        keys = ["owner0", "owner1"] + [f"provider{i}" for i in range(12)]
        addresses = {}
        for key in keys:
            run("keys", "add", key, "--keyring-backend", "test", "--output", "json")
            addresses[key] = run("keys", "show", key, "-a", "--keyring-backend", "test").strip()
            run("genesis", "add-genesis-account", addresses[key], "100000000000stake,1000000000000000000aatom", "--keyring-backend", "test")
        run("genesis", "gentx", "owner0", "50000000000stake", "--chain-id", chain, "--keyring-backend", "test")
        run("genesis", "collect-gentxs")
        genesis_path = home / "config/genesis.json"
        genesis = json.loads(genesis_path.read_text())
        genesis["consensus"]["params"]["block"].update(
            load_consensus_profile(ROOT / "scripts/retrieval_consensus_profile.json")["block"])
        params = genesis["app_state"]["nilchain"]["params"]
        params.update(retrieval_v2_activation_height="1", retrieval_burn_bps="3333",
                      base_retrieval_fee={"denom": "stake", "amount": "3"},
                      retrieval_price_per_blob={"denom": "stake", "amount": "17"})
        genesis["app_state"]["bank"]["denom_metadata"].append({
            "description": "EVM fee token metadata", "denom_units": [
                {"denom": "aatom", "exponent": 0, "aliases": ["uatom"]}, {"denom": "atom", "exponent": 18, "aliases": []}],
            "base": "aatom", "display": "atom", "name": "Atom", "symbol": "ATOM", "uri": "", "uri_hash": ""})
        genesis_path.write_text(json.dumps(genesis))
        run("genesis", "validate")
        config = home / "config/config.toml"
        config.write_text(config.read_text().replace('timeout_commit = "5s"', 'timeout_commit = "1s"'))
        config = home / "config/app.toml"
        config.write_text(config.read_text().replace('address = "tcp://localhost:1317"', f'address = "tcp://127.0.0.1:{api}"'))
        expected_node = run("comet", "show-node-id").strip()
        log = (output / "node.log").open("w")
        for reservation in sockets:
            reservation.close()
        node = subprocess.Popen([str(binary), "start", "--home", str(home), "--rpc.laddr", f"tcp://127.0.0.1:{rpc}",
                                 "--p2p.laddr", f"tcp://127.0.0.1:{p2p}", "--grpc.address", f"127.0.0.1:{grpc}",
                                 "--api.enable=true", "--api.enabled-unsafe-cors=true", "--grpc-web.enable=false",
                                 "--json-rpc.enable=false", "--minimum-gas-prices", "0.001aatom"], env=env, stdout=log, stderr=subprocess.STDOUT)
        until = time.monotonic() + 30
        while time.monotonic() < until:
            if node.poll() is not None:
                raise RuntimeError((output / "node.log").read_text()[-4000:])
            try:
                status = json.loads(request(rpc_url + "/status")[2])["result"]
                assert status["node_info"]["id"] == expected_node, "wrong node"
                if int(status["sync_info"]["latest_block_height"]) >= 2:
                    break
            except OSError:
                pass
            time.sleep(.25)
        else:
            raise TimeoutError("node startup")
        report["node_id"] = expected_node
        cors_url = api_url + API + "/params"
        code, headers, _ = request(cors_url, "OPTIONS", {"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-cosmos-block-height"})
        assert 200 <= code < 300 and "x-cosmos-block-height" in headers.get("access-control-allow-headers", "").lower()
        report["cors_preflight_status"] = code
        _, headers, _ = request(cors_url, headers={"Origin": "http://localhost:5173", "x-cosmos-block-height": "1"})
        assert headers.get("x-cosmos-block-height") == "1"
        assert "x-cosmos-block-height" in headers.get("access-control-expose-headers", "").lower()
        report["cors_pinned_height"] = "1"

        structure = json.loads((ROOT / "polystorechain/x/polystorechain/keeper/testdata/proof_admission_k8.json").read_text())
        manifest = "0x" + base64.b64decode(structure["root"]).hex()
        for i in range(12):
            send(f"provider{i}", "register-provider", "General", "100000000000", "--endpoint", f"/ip4/127.0.0.1/tcp/{9000+i}/http")
        deals = []
        for i in range(2):
            owner = f"owner{i}"
            send(owner, "create-deal", "100000", "100000000", "10000000", "--service-hint", "General:rs=8+4")
            created = query(API + "/deals")["deals"]
            deal = next(d for d in created if d["owner"] == addresses[owner])
            send(owner, "update-deal-content", "--deal-id", deal["id"], "--cid", manifest, "--size", "8126464", "--total-mdus", "3", "--witness-mdus", "1")
            deals.append(deal)
        ids = []
        for i in range(3):
            owner, deal = f"owner{i % 2}", deals[i % 2]
            slot = next(s for s in deal["mode2_slots"] if int(s["slot"]) == 0)
            opened = send(owner, "open-retrieval-session", "--deal-id", deal["id"], "--provider", slot["provider"],
                          "--manifest-root", manifest, "--start-mdu-index", "2", "--start-blob-index", "0", "--blob-count", "1",
                          "--nonce", str(i+1), "--expires-at", "500", "--challenge-version", "2", "--authorized-proof-provider", addresses["provider0"])
            sid = opened_session_id(opened)
            send(owner, "confirm-retrieval-session", "--session-id", sid)
            ids.append(sid)
        lib = ctypes.CDLL(str(library))
        lib.polystore_init.argtypes = [ctypes.c_char_p]
        lib.polystore_commit_received_blob.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
        lib.polystore_compute_blob_proof.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        assert lib.polystore_init(os.fsencode(env["POLYSTORE_TRUSTED_SETUP"])) == 0
        blob = bytearray(131072)
        for i in range(31, len(blob), 32):
            blob[i] = 1 + (i // 32) % 251
        blob = bytes(blob)
        commitment = ctypes.create_string_buffer(48)
        assert lib.polystore_commit_received_blob(blob, len(blob), commitment) == 0
        assert commitment.raw == base64.b64decode(structure["proofs"][0]["blob_commitment"])
        payloads, points = [], []
        for sid in ids:
            view = session(sid)
            frozen = view["session"]
            assert frozen["challenge_version"] == 2 and frozen["authorized_proof_provider"] == addresses["provider0"]
            assert frozen["status"] == "RETRIEVAL_SESSION_STATUS_USER_CONFIRMED"
            assert int(frozen["locked_fee"]) == 17
            context_hash = base64.b64decode(view["challenge_context_hash"])
            assert hashlib.sha256(base64.b64decode(view["challenge_context"])).digest() == context_hash
            seed = base64.b64decode(view["challenge_seed"])
            assert len(seed) == 32
            z = fresh_z(context_hash, seed)
            points.append(z.hex())
            proof, y = ctypes.create_string_buffer(48), ctypes.create_string_buffer(32)
            assert lib.polystore_compute_blob_proof(blob, len(blob), z, proof, y) == 0
            item = copy.deepcopy(structure["proofs"][0])
            item.update(z_value=base64.b64encode(z).decode(), y_value=base64.b64encode(y.raw).decode(), kzg_opening_proof=base64.b64encode(proof.raw).decode())
            payloads.append({"session_id": base64.b64encode(bytes.fromhex(sid)).decode(), "proofs": [item]})
        assert len(set(points)) == 3
        before = balance(addresses["provider0"])
        for name, payload in (("batch", {"sessions": payloads[:2]}), ("single", payloads[2])):
            path = output / (name + ".json")
            path.write_text(json.dumps(payload))
            send("provider0", "submit-retrieval-proof", path, gas="auto")
        terminal = [session(sid)["session"] for sid in ids]
        for sid, s in zip(ids, terminal):
            assert base64.b64decode(s["session_id"]).hex() == sid
            assert s["status"] == "RETRIEVAL_SESSION_STATUS_COMPLETED"
            assert s["authorized_proof_provider"] == addresses["provider0"]
        paid = balance(addresses["provider0"]) - before
        assert paid == 33, ("three independent ceil(17*3333/10000)=6 burns and 11 payouts", paid)
        report.update(status="pass", session_ids=ids, challenge_points=points, payout_stake=paid,
                      per_session_locked_stake=17, per_session_burn_stake=6, terminal_sessions=terminal)
    except BaseException as exc:
        report.update(status="failed", error=str(exc))
        raise
    finally:
        for reservation in sockets:
            reservation.close()
        if node is not None and node.poll() is None:
            node.terminate()
            try:
                node.wait(timeout=10)
            except subprocess.TimeoutExpired:
                node.kill()
                node.wait()
        if log:
            log.close()
        (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "result": str(output / "result.json")}))


if __name__ == "__main__":
    main()
