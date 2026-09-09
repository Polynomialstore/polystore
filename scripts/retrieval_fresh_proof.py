#!/usr/bin/env python3
"""Offline fixture openings and bounded, committed-session proof preparation.

This module never signs or broadcasts. The scheduler invokes its child through
run_bounded_command, which also bounds native initialization and HTTP draining.
The Go exporter supports nonconstant native K8/K2 assignment artifacts. The
small Python known-answer fixture remains slot zero only.
"""
import base64
import copy
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.parse
import urllib.request

FR = int("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001", 16)
SETUP_DIGEST = "d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7"
BLOB_BYTES = 131072
MAX_BYTES = 4 * 1024 * 1024


def uint(value, bits=64):
    if type(value) is str and re.fullmatch(r"0|[1-9][0-9]*", value):
        value = int(value)
    if type(value) is not int or not 0 <= value < 1 << bits:
        raise ValueError("invalid unsigned integer")
    return value


def b64(value, size):
    raw = base64.b64decode(value, validate=True)
    if len(raw) != size or base64.b64encode(raw).decode() != value:
        raise ValueError("noncanonical base64")
    return raw


def account(value):
    # Standard bech32 checksum, fixed nil HRP and exactly twenty account bytes.
    alphabet = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
    if not isinstance(value, str) or not value.startswith("nil1") or len(value) != 42:
        raise ValueError("noncanonical account")
    words = [alphabet.index(c) for c in value[4:]]
    check = 1
    for v in [ord(c) >> 5 for c in "nil"] + [0] + [ord(c) & 31 for c in "nil"] + words:
        top, check = check >> 25, ((check & 0x1ffffff) << 5) ^ v
        for i, generator in enumerate((0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3)):
            if (top >> i) & 1:
                check ^= generator
    if check != 1:
        raise ValueError("invalid account checksum")
    number = 0
    for word in words[:-6]:
        number = number * 32 + word
    return number.to_bytes(20, "big")


def lp(value):
    raw = value.encode()
    return len(raw).to_bytes(4, "big") + raw


def context_bytes(c):
    """Canonical Context.Bytes field order; callers authenticate/validate fields."""
    def u(name, size):
        return uint(c[name], size * 8).to_bytes(size, "big")
    raw = lp("polystore/challenge-context/v2") + u("version", 4) + lp(c["chain_id"])
    for name, size in (("setup_digest", 32), ("kind", 1), ("context_id", 32),
                       ("deal_id", 8), ("generation", 8), ("root", 32),
                       ("assigned", 20), ("payee", 20), ("layout", 1)):
        if name in ("setup_digest", "context_id", "root", "assigned", "payee"):
            value = bytes.fromhex(c[name])
            if len(value) != size:
                raise ValueError("invalid context bytes")
            raw += value
        else:
            raw += u(name, size)
    raw += b"".join(u(n, 4) for n in ("k", "m", "slot"))
    raw += b"".join(u(n, 8) for n in ("metadata_mdus", "user_mdus", "start_mdu"))
    raw += u("start_leaf", 4)
    raw += b"".join(u(n, 8) for n in ("blob_count", "epoch_id", "epoch_length", "sample_count",
                                      "snapshot_height", "anchor_height", "first_response_height", "deadline_height", "deal_end"))
    return raw


def fresh_z(context_hash, seed, ordinal, mdu, leaf):
    # Generalized from smoke_retrieval_v2.py; maintained C2 golden vectors pin it.
    if len(context_hash) != 32 or len(seed) != 32:
        raise ValueError("invalid challenge hash or seed")
    prefix = lp("polystore/blob-challenge/v2") + context_hash + seed
    prefix += uint(ordinal).to_bytes(8, "big") + uint(mdu).to_bytes(8, "big") + uint(leaf, 32).to_bytes(4, "big")
    for counter in range(256):
        z = hashlib.sha256(prefix + counter.to_bytes(4, "big")).digest()
        value = int.from_bytes(z, "big")
        if 0 < value < FR and pow(value, 4096, FR) != 1:
            return z
    raise ValueError("C2 scalar rejection exhausted")


def enum(value, names):
    return names.index(value) if isinstance(value, str) and value in names else uint(value, 32)


def frozen_context(view, expected, session_id, height):
    """Authenticate every frozen field against the operation's pinned intent.

    expected has session (all fields below), snapshot (all fields below), and
    minimum_opened_height. It is supplied by the harness, never copied from the
    response under validation. Enum expectations use their integer values.
    """
    s, x = view["session"], view["session"]["challenge_snapshot"]
    es, ex = expected["session"], expected["snapshot"]
    fields64 = ("deal_id", "nonce", "expires_at", "start_mdu_index", "blob_count", "total_bytes")
    for name in fields64 + ("start_blob_index",):
        if uint(s.get(name, 0), 32 if name == "start_blob_index" else 64) != uint(es[name]):
            raise ValueError("session intent mismatch: " + name)
    for name in ("owner", "provider", "authorized_proof_provider"):
        account(s[name])
        if s[name] != es[name]:
            raise ValueError("session actor mismatch: " + name)
    root, setup = b64(s["manifest_root"], 32), b64(x["setup_digest"], 32)
    if root.hex() != es["manifest_root"] or setup.hex() != SETUP_DIGEST or setup.hex() != ex["setup_digest"]:
        raise ValueError("root or setup mismatch")
    if b64(s["session_id"], 32).hex() != session_id or uint(s["challenge_version"], 32) != 2:
        raise ValueError("wrong committed session or version")
    chain = x["chain_id"]
    if chain != ex["chain_id"] or not 1 <= len(chain.encode()) <= 50 or "\0" in chain:
        raise ValueError("wrong chain")
    for name in ("generation", "layout", "k", "m", "slot", "metadata_mdus", "user_mdus", "deal_end"):
        if uint(x.get(name, 0), 32 if name in ("layout", "k", "m", "slot") else 64) != uint(ex[name]):
            raise ValueError("snapshot mismatch: " + name)
    funding = enum(s.get("funding", 0), ["RETRIEVAL_SESSION_FUNDING_" + v for v in ("UNSPECIFIED", "DEAL_ESCROW", "REQUESTER", "PROTOCOL")])
    purpose = enum(s.get("purpose", 0), ["RETRIEVAL_SESSION_PURPOSE_" + v for v in ("UNSPECIFIED", "USER", "PROTOCOL_AUDIT", "PROTOCOL_REPAIR")])
    status = enum(s.get("status", 0), ["RETRIEVAL_SESSION_STATUS_" + v for v in ("UNSPECIFIED", "OPEN", "PROOF_SUBMITTED", "USER_CONFIRMED", "COMPLETED", "EXPIRED", "CANCELED")])
    if funding not in (1, 2) or funding != es["funding"] or purpose != 1 or status not in (1, 3):
        raise ValueError("invalid funding, purpose or proof submission state")
    if s.get("payer", "") != (s["owner"] if funding == 2 else ""):
        raise ValueError("invalid payer")
    if not isinstance(s["locked_fee"], str) or uint(s["locked_fee"], 256) != uint(es["locked_fee"], 256):
        raise ValueError("locked fee mismatch")
    opened, expiry = uint(s["opened_height"]), uint(s["expires_at"])
    updated = uint(s.get("updated_height", 0))
    if not 1 <= uint(expected["minimum_opened_height"]) <= opened <= height <= expiry <= uint(x["deal_end"]) < 1 << 63 or opened + 2 > expiry or not opened <= updated <= height:
        raise ValueError("invalid committed response window")
    k, m, slot = uint(x["k"]), uint(x["m"]), uint(x.get("slot", 0))
    if uint(x["layout"]) != 2 or (k, m) not in ((8, 4), (2, 1)) or slot >= k + m:
        raise ValueError("unsupported native K8/K2 assignment")
    start, count = uint(s.get("start_blob_index", 0)), uint(s["blob_count"])
    rows = 64 // k
    if (uint(x["metadata_mdus"]) != 2 or uint(x["user_mdus"]) != 1 or
            uint(s["start_mdu_index"]) != 2 or not 1 <= count or
            not slot * rows <= start < start + count <= (slot + 1) * rows or
            uint(s["total_bytes"]) != count * BLOB_BYTES):
        raise ValueError("fixture range mismatch")
    c = dict(version=2, chain_id=chain, setup_digest=setup.hex(), kind=1, context_id=session_id,
             deal_id=uint(s.get("deal_id", 0)), generation=uint(x.get("generation", 0)), root=root.hex(),
             assigned=account(s["provider"]).hex(), payee=account(s["authorized_proof_provider"]).hex(),
             layout=2, k=k, m=m, slot=slot, metadata_mdus=2, user_mdus=1, start_mdu=2,
             start_leaf=start, blob_count=count, epoch_id=0, epoch_length=0, sample_count=0,
             snapshot_height=opened, anchor_height=opened + 1, first_response_height=opened + 2,
             deadline_height=expiry, deal_end=uint(x["deal_end"]))
    context = context_bytes(c)
    digest = hashlib.sha256(context).digest()
    if b64(view["challenge_context"], len(context)) != context or b64(view["challenge_context_hash"], 32) != digest:
        raise ValueError("canonical context/hash mismatch")
    return c, digest


def fixture_blob(k, row):
    if k not in (2, 8) or not 0 <= row < 64 // k:
        raise ValueError("invalid fixture row")
    # benchBlobBytesForLeaf: original blob index = row*K + slot (slot=0).
    first_scalar = row * k * 4096
    blob = bytearray(BLOB_BYTES)
    for i in range(4096):
        blob[i * 32 + 31] = 1 + (first_scalar + i) % 251
    return bytes(blob)


def read_json(path):
    with Path(path).open("rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("oversized fixture")
    return json.loads(raw), raw


def native_proofs(config, c, digest, seed):
    if uint(c.get("slot", 0), 32) != 0:
        raise ValueError("Python known-answer fixture supports slot zero only")
    meta, _ = read_json(Path(config["fixture"]) / "fixture.json")
    payload, raw = read_json(Path(config["fixture"]) / "1.json")
    for name, expected in dict(schema_version=1, challenge_kind="legacy-fixed-z", data_pattern="be-fr-last-byte-cycle-1-through-251-v1",
                               k=c["k"], m=c["m"], slot=0, mdu_index=2, metadata_mdus=2, user_mdus=1,
                               data_bytes=8388608, encoded_blob_bytes=BLOB_BYTES, rows_per_slot=64 // c["k"],
                               manifest_root="0x" + c["root"], trusted_setup_sha256=SETUP_DIGEST).items():
        if meta.get(name) != expected:
            raise ValueError("fixture metadata mismatch: " + name)
    if hashlib.sha256(raw).hexdigest() != meta["proof_payload_sha256"]:
        raise ValueError("fixture payload digest mismatch")
    if hashlib.sha256(Path(config["setup"]).read_bytes()).hexdigest() != SETUP_DIGEST:
        raise ValueError("setup artifact mismatch")
    templates = payload["proofs"]
    if len(templates) != uint(meta["proofs_per_session"]) or not c["start_leaf"] + c["blob_count"] <= len(templates) <= 64 // c["k"]:
        raise ValueError("fixture does not cover requested rows")
    lib = ctypes.CDLL(config["library"])
    lib.polystore_init.argtypes = [ctypes.c_char_p]
    lib.polystore_commit_received_blob.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p]
    lib.polystore_compute_blob_proof.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
    if lib.polystore_init(os.fsencode(config["setup"])) != 0:
        raise ValueError("native setup initialization failed")
    proofs = []
    for ordinal in range(c["blob_count"]):
        leaf = c["start_leaf"] + ordinal
        item = copy.deepcopy(templates[leaf])
        if uint(item["mdu_index"]) != 2 or uint(item.get("blob_index", 0)) != leaf:
            raise ValueError("fixture tuple mismatch")
        blob, commitment = fixture_blob(c["k"], leaf), ctypes.create_string_buffer(48)
        if lib.polystore_commit_received_blob(blob, len(blob), commitment) != 0 or commitment.raw != b64(item["blob_commitment"], 48):
            raise ValueError("reconstructed fixture commitment mismatch")
        z = fresh_z(digest, seed, ordinal, 2, leaf)
        proof, y = ctypes.create_string_buffer(48), ctypes.create_string_buffer(32)
        if lib.polystore_compute_blob_proof(blob, len(blob), z, proof, y) != 0:
            raise ValueError("native proof generation failed")
        item.update(z_value=base64.b64encode(z).decode(), y_value=base64.b64encode(y.raw).decode(),
                    kzg_opening_proof=base64.b64encode(proof.raw).decode())
        proofs.append(item)
    return {"session_id": base64.b64encode(bytes.fromhex(c["context_id"])).decode(), "proofs": proofs}


def session_evidence(config, expected, session_id, deadline, height=None):
    def remaining():
        seconds = (deadline - time.clock_gettime_ns(time.CLOCK_MONOTONIC)) / 1e9
        if seconds <= 0:
            raise TimeoutError("proof preparation deadline")
        return seconds

    def query(base, route, height=None):
        request = urllib.request.Request(base + route, headers={} if height is None else {"x-cosmos-block-height": str(height)})
        with urllib.request.urlopen(request, timeout=remaining()) as response:
            body = bytearray()
            while len(body) <= MAX_BYTES:
                remaining()
                chunk = response.read1(min(65536, MAX_BYTES - len(body) + 1))
                if not chunk:
                    break
                body.extend(chunk)
            remaining()
            if response.status != 200 or len(body) > MAX_BYTES or (height is not None and response.headers.get("x-cosmos-block-height") != str(height)):
                raise ValueError("invalid bounded committed response")
        result = json.loads(body)
        if not isinstance(result, dict) or result.get("error"):
            raise ValueError("invalid node response")
        return result if height is not None else result["result"]

    encoded = urllib.parse.quote(base64.urlsafe_b64encode(bytes.fromhex(session_id)).decode(), safe="")
    status = query(config["rpc"], "/status")
    if status["node_info"]["id"] != config["node_id"] or status["node_info"]["network"] != expected["snapshot"]["chain_id"] or status["sync_info"]["catching_up"] is not False:
        raise ValueError("wrong owned node or uncommitted state")
    # BlockStore /status can advance before application persistence and the
    # height-pinned API. ABCI Info reads the committed application height.
    latest = uint(query(config["rpc"], "/abci_info")["response"]["last_block_height"])
    height = latest if height is None else uint(height)
    if not 1 <= height <= latest:
        raise ValueError("requested evidence height is not committed")
    view = query(config["api"], "/polystorechain/polystorechain/v1/retrieval-sessions/" + encoded, height)
    anchor_height = uint(view["session"]["opened_height"]) + 1
    anchor = None
    if height >= anchor_height + 1:
        block = query(config["rpc"], "/block?height=" + str(anchor_height))
        # Retain only authenticated anchor fields, never block transaction bodies.
        anchor = {"block_id": {"hash": block["block_id"]["hash"]}, "block": {"header": {
            key: block["block"]["header"][key] for key in ("height", "chain_id")}}}
    return dict(height=height, view=view, anchor=anchor)


def prepare(config, expected, session_id, deadline, output):
    def remaining():
        seconds = (deadline - time.clock_gettime_ns(time.CLOCK_MONOTONIC)) / 1e9
        if seconds <= 0:
            raise TimeoutError("proof preparation deadline")
        return seconds

    while True:
        evidence = session_evidence(config, expected, session_id, deadline)
        height, view = evidence["height"], evidence["view"]
        c, digest = frozen_context(view, expected, session_id, height)
        if height >= c["first_response_height"] and view.get("challenge_seed"):
            seed = b64(view["challenge_seed"], 32)
            anchor = evidence["anchor"]
            header = anchor["block"]["header"]
            if uint(header["height"]) != c["anchor_height"] or header["chain_id"] != c["chain_id"] or not re.fullmatch(r"[0-9A-Fa-f]{64}", anchor["block_id"]["hash"]) or bytes.fromhex(anchor["block_id"]["hash"]) != seed:
                raise ValueError("seed does not match committed anchor")
            break
        time.sleep(min(.1, remaining()))
    payload = native_proofs(config, c, digest, seed)
    remaining()
    with open(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as stream:
        json.dump(payload, stream)
    remaining()
    return dict(session_id=session_id, context_hash=digest.hex(), seed=seed.hex())


if __name__ == "__main__":
    request = json.loads(sys.argv[1])
    action = request.pop("action", "prepare")
    if action not in ("prepare", "evidence"):
        raise ValueError("unknown proof producer action")
    print(json.dumps((prepare if action == "prepare" else session_evidence)(**request)))
