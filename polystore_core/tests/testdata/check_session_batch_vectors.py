"""Independent PSB1 transcript/coefficient oracle; Python stdlib only.

Transcribed from the reviewed batch-v1 schema, without reading its Rust
implementation or output. This checks encoding and Merkle membership, not G1
subgroup membership, KZG equations, setup authentication, or C2 authorization.
Run normally to check committed vectors; --emit prints independently derived JSON.
"""
import hashlib
import json
from pathlib import Path
import sys


BASE = Path(__file__).parent
FR = int("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001", 16)
OMEGA = pow(7, (FR - 1) // 4096, FR)
# SHA-256 of the complete 807177-byte polystorechain/trusted_setup.txt artifact,
# including its trailing monomial G1 section. Expected profile input, not PSB1 data.
SETUP_DIGEST = "d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7"


def uint(value, width):
    return value.to_bytes(width, "big")


def lp(value):
    value = value.encode("ascii")
    return uint(len(value), 4) + value


def root_opening(mdu, raw_root):
    if not 1 <= mdu <= 65536:
        raise ValueError("root-table MDU outside 1..65536")
    du, cell = divmod(mdu - 1, 4096)
    return du, cell, uint(pow(OMEGA, cell, FR), 32), uint(int.from_bytes(raw_root, "big") % FR, 32)


def merkle_root(commitment, index, leaves, siblings):
    if not 0 <= index < leaves:
        raise ValueError("Merkle index outside tree")
    digest = hashlib.blake2s(commitment).digest()
    consumed = 0
    while leaves > 1:
        if index ^ 1 < leaves:
            if consumed == len(siblings):
                raise ValueError("missing Merkle sibling")
            sibling = siblings[consumed]
            consumed += 1
            pair = sibling + digest if index % 2 else digest + sibling
            digest = hashlib.blake2s(pair).digest()
        index //= 2
        leaves = (leaves + 1) // 2
    if consumed != len(siblings):
        raise ValueError("unused Merkle siblings")
    return digest


def derive(data):
    if len(data) > 60522:
        raise ValueError("PSB1 exceeds bounded transport size")
    offset = 0

    def take(size):
        nonlocal offset
        end = offset + size
        if end > len(data):
            raise ValueError("truncated PSB1")
        result = data[offset:end]
        offset = end
        return result

    def integer(size):
        return int.from_bytes(take(size), "big")

    if take(4) != b"PSB1":
        raise ValueError("wrong PSB1 magic")
    count, leaf_count = integer(2), integer(4)
    if not 1 <= count <= 64 or not 1 <= leaf_count <= 16384:
        raise ValueError("invalid count or leaf count")
    polyfs_root, context, seed = take(32), take(32), take(32)
    transcript = lp("polystore/kzg-batch/v1") + bytes.fromhex(SETUP_DIGEST)
    transcript += uint(4096, 4) + lp("bls12-381/fr-be/polyfs-natural-order")
    transcript += uint(count, 2) + uint(2 * count, 2) + context + seed + polyfs_root
    records = []
    for index in range(count):
        mdu, leaf, raw_root = integer(8), integer(4), take(32)
        root_c, root_p, blob_c = take(48), take(48), take(48)
        blob_z, blob_y, blob_p = take(32), take(32), take(48)
        root_count, blob_count = integer(2), integer(2)
        if root_count != 6 or blob_count > 14:
            raise ValueError("unbounded or malformed path count")
        root_path = [take(32) for _ in range(root_count)]
        blob_path = [take(32) for _ in range(blob_count)]
        du, cell, root_z, root_y = root_opening(mdu, raw_root)
        if merkle_root(root_c, du, 64, root_path) != polyfs_root:
            raise ValueError("root-table commitment membership failed")
        if merkle_root(blob_c, leaf, leaf_count, blob_path) != raw_root:
            raise ValueError("blob commitment membership failed")
        if any(int.from_bytes(v, "big") >= FR for v in (blob_z, blob_y)):
            raise ValueError("noncanonical scalar")
        # PSB1 is the complete ordered single-context list, so C2 ordinal=index.
        transcript += uint(index, 2) + uint(index, 8) + uint(mdu, 8)
        transcript += uint(leaf, 4) + uint(leaf_count, 4) + raw_root + uint(du, 2) + uint(cell, 2)
        transcript += b"\x00" + root_c + root_z + root_y + root_p
        transcript += b"\x01" + blob_c + blob_z + blob_y + blob_p
        records.append({"ordinal": str(index), "mdu": str(mdu), "leaf": leaf,
                        "mdu_root": raw_root.hex(), "root_du": du, "root_cell": cell,
                        "root_z": root_z.hex(), "root_y": root_y.hex()})
    if offset != len(data):
        raise ValueError("trailing PSB1 bytes")
    transcript_hash = hashlib.sha256(transcript).digest()
    coefficients = []
    prefix = lp("polystore/kzg-batch-coefficient/v1") + transcript_hash
    for index in range(2 * count):
        for counter in range(256):
            candidate = hashlib.sha256(prefix + uint(index, 2) + uint(counter, 2)).digest()
            if 0 < int.from_bytes(candidate, "big") < FR:
                coefficients.append({"index": index, "counter": counter, "scalar": candidate.hex()})
                break
        else:
            raise ValueError("coefficient rejection exhausted")
    # Choose a raw digest above Fr so these boundary vectors exercise reduction.
    boundary_root = bytes.fromhex("ff" * 31 + "fe")
    boundaries = []
    for mdu in (1, 4096, 4097, 65536):
        du, cell, z, y = root_opening(mdu, boundary_root)
        boundaries.append({"mdu": str(mdu), "du": du, "cell": cell, "z": z.hex(), "y": y.hex()})
    return {"input_sha256": hashlib.sha256(data).hexdigest(), "input_bytes": len(data),
            "setup_digest": SETUP_DIGEST, "count": count, "opening_count": 2 * count,
            "leaf_count": leaf_count, "polyfs_root": polyfs_root.hex(),
            "context_hash": context.hex(), "anchor_seed": seed.hex(),
            "transcript_hex": transcript.hex(), "transcript_hash": transcript_hash.hex(),
            "records": records, "coefficients": coefficients,
            "root_boundary_raw_digest": boundary_root.hex(), "root_boundaries": boundaries}


def check_rejections(data):
    for invalid in (data[:-1], data + b"\x00", b"BAD!" + data[4:],
                    data[:4] + b"\x00\x00" + data[6:],
                    data[:4] + b"\x00\x41" + data[6:]):
        try:
            derive(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("malformed transport accepted")
    assert pow(OMEGA, 4096, FR) == 1 and pow(OMEGA, 2048, FR) != 1
    for invalid_mdu in (0, 65537):
        try:
            root_opening(invalid_mdu, bytes(32))
        except ValueError:
            pass
        else:
            raise AssertionError("out-of-range root MDU accepted")


if __name__ == "__main__":
    data = (BASE / "session-batch-input.bin").read_bytes()
    actual = derive(data)
    check_rejections(data)
    if sys.argv[1:] == ["--emit"]:
        print(json.dumps(actual, indent=2))
    elif sys.argv[1:]:
        raise SystemExit("usage: check_session_batch_vectors.py [--emit]")
    else:
        expected = json.loads((BASE / "session-batch-golden.json").read_text())
        assert actual == expected, "independent PSB1 batch vectors drifted"
        print("independent PSB1 transcript, coefficients, Merkle and root-boundary vectors match")
