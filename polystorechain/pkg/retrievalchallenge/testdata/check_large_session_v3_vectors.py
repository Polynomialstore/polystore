#!/usr/bin/env python3
"""Independent stdlib oracle for the inactive retrieval-v3 contract vectors."""

import hashlib
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIXTURE = HERE / "large-session-v3-golden.json"
FR = int("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001", 16)


def u8(n): return n.to_bytes(1, "big")
def u32(n): return n.to_bytes(4, "big")
def u64(n): return n.to_bytes(8, "big")
def le16(n): return n.to_bytes(2, "little")
def le32(n): return n.to_bytes(4, "little")
def le64(n): return n.to_bytes(8, "little")


def lp(value):
    value = value.encode() if isinstance(value, str) else value
    return u32(len(value)) + value


def sha(data): return hashlib.sha256(data).digest()


def pattern(name):
    if name == "zero": return bytes(131072)
    if name == "valid_incrementing":
        return b"".join(b"\x00" + bytes((i + j) & 255 for j in range(31)) for i in range(4096))
    if name == "valid_ff": return (b"\x00" + bytes([255]) * 31) * 4096
    raise ValueError(name)


def leaf(mdu, leaf_index, blob):
    assert len(blob) == 131072
    return sha(lp("polystore/integrity-leaf/v3") + u64(mdu) + u32(leaf_index) + u32(len(blob)) + blob)


def parent(left, right): return sha(lp("polystore/integrity-node/v3") + left + right)


def tree_with_paths(nodes):
    levels = [nodes]
    while len(levels[-1]) > 1:
        level = levels[-1]
        if len(level) & 1: level = level + [level[-1]]
        levels.append([parent(level[i], level[i + 1]) for i in range(0, len(level), 2)])
    paths = []
    for original in range(len(nodes)):
        pos, siblings = original, []
        for level0 in levels[:-1]:
            level = level0 if not len(level0) & 1 else level0 + [level0[-1]]
            siblings.append(level[pos ^ 1])
            pos //= 2
        paths.append(siblings)
    return levels[-1][0], paths


def verify_path(value, position, leaf_count, siblings, expected):
    if position < 0 or position >= leaf_count or leaf_count < 1: return False
    width, used, current = leaf_count, 0, value
    while width > 1:
        if used >= len(siblings): return False
        sibling = siblings[used]
        if width & 1 and position == width - 1 and sibling != current: return False
        current = parent(sibling, current) if position & 1 else parent(current, sibling)
        position //= 2
        width = (width + 1) // 2
        used += 1
    return used == len(siblings) and current == expected


def range_population(start, length, capacity=126976):
    assert start >= 0 and length > 0
    return (start + length - 1) // capacity - start // capacity + 1


def coordinate(t, metadata_mdus=2):
    data_blob = t % 64
    slot, row = data_blob % 8, data_blob // 8
    return {"t": t, "mdu_index": metadata_mdus + t // 64, "leaf_index": slot * 8 + row, "slot": slot}


def plan(first, last):
    counts = []
    for slot in range(8):
        count = sum(1 for t in range(first, last + 1) if coordinate(t)["slot"] == slot)
        if count:
            provider = bytes([0x40 + slot]) * 20
            counts.append((slot, provider, provider, count))
    population = last - first + 1
    transcript = lp("polystore/retrieval-plan/v3") + u64(first) + u64(last) + u64(population) + u32(len(counts))
    for slot, assigned, payee, count in counts:
        transcript += u32(slot) + assigned + payee + u64(count)
    return sha(transcript), transcript, counts


def full_transcripts(integrity_root, range_start, range_length, file_start_offset=0):
    chain, session_owner = "polystore-test-1", bytes([0x11]) * 20
    deal, generation, record = 42, 7, 3
    nonce = 9
    absolute_start = file_start_offset + range_start
    first = absolute_start // 126976
    last = (absolute_start + range_length - 1) // 126976
    population = last - first + 1
    proof_count = min(population, 132)
    user_mdus = (last + 64) // 64
    plan_hash, plan_bytes, counts = plan(first, last)
    session_bytes = (lp("polystore/retrieval-session/v3") + u32(3) + lp(chain) + session_owner
        + u64(deal) + u64(generation) + u32(record) + u64(range_start)
        + u64(range_length) + plan_hash + u64(nonce))
    session_id = sha(session_bytes)
    setup = bytes.fromhex("d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7")
    context_bytes = (lp("polystore/challenge-context/v3") + u32(3) + lp(chain) + setup
        + session_id + session_owner + u64(deal) + u64(generation) + bytes([0x22]) * 32
        + integrity_root + u32(record) + u64(file_start_offset) + u64(range_start + range_length)
        + u64(range_start) + u64(range_length) + u8(2) + u32(8) + u32(4)
        + u64(2) + u64(user_mdus) + plan_hash + u64(population) + u64(proof_count) + u64(nonce)
        + lp("stake") + lp("3") + lp("5") + u32(250) + u8(1) + session_owner
        + u64(100) + u64(101) + u64(102) + u64(200) + u64(300))
    context_hash = sha(context_bytes)
    anchor_hash = bytes(range(160, 192))
    seed = sha(lp("polystore/challenge-seed/v3") + context_hash + anchor_hash)
    acceptance_bytes = (lp("polystore/generation-acceptance/v3") + lp(chain) + setup
        + u64(deal) + u64(generation) + bytes([0x22]) * 32 + integrity_root
        + u8(2) + u32(8) + u32(4) + u64(2) + u64(user_mdus) + u32(0) + bytes([0x40]) * 20)
    first_obligation = counts[0]
    slot, assigned, payee, count = first_obligation
    ack_bytes = (lp("polystore/retrieval-obligation-ack/v3") + lp(chain) + session_id
        + context_hash + plan_hash + u32(slot) + assigned + payee + u64(count)
        + u64(count * 131072) + integrity_root)
    return {"file_start_offset": str(file_start_offset), "range_start": str(range_start),
        "range_length": str(range_length), "first": first, "last": last,
        "population": population, "sample_count": proof_count,
        "plan_hex": plan_bytes.hex(), "plan_hash": plan_hash.hex(),
        "obligations": [{"slot": s, "assigned": a.hex(), "payee": p.hex(), "blob_count": c} for s, a, p, c in counts],
        "session_hex": session_bytes.hex(), "session_id": session_id.hex(),
        "context_hex": context_bytes.hex(), "context_hash": context_hash.hex(),
        "anchor_hash": anchor_hash.hex(), "seed": seed.hex(),
        "acceptance_slot0_hex": acceptance_bytes.hex(), "acceptance_slot0_hash": sha(acceptance_bytes).hex(),
        "ack_first_obligation_hex": ack_bytes.hex(), "ack_first_obligation_hash": sha(ack_bytes).hex()}, context_hash, seed


def sample(context_hash, seed, population, count):
    assert len(context_hash) == len(seed) == 32 and 0 <= count <= population
    swaps, result = {}, []
    prefix = lp("polystore/session-position/v3") + context_hash + seed
    for i in range(count):
        n = population - i
        if n == 1: r = 0
        else:
            limit = (1 << 256) // n * n
            for counter in range(256):
                x = int.from_bytes(sha(prefix + u64(i) + u32(counter)), "big")
                if x < limit:
                    r = x % n
                    break
            else: raise RuntimeError("sample rejection exhausted")
        selected = swaps.get(r, r)
        swaps[r] = swaps.get(n - 1, n - 1)
        swaps.pop(n - 1, None)
        result.append(selected)
    return result


def challenge_z(context_hash, seed, ordinal, coord):
    prefix = lp("polystore/blob-challenge/v3") + context_hash + seed
    for counter in range(256):
        digest = sha(prefix + u64(ordinal) + u64(coord["t"]) + u64(coord["mdu_index"]) + u32(coord["leaf_index"]) + u32(counter))
        z = int.from_bytes(digest, "big")
        if 0 < z < FR and pow(z, 4096, FR) != 1: return digest.hex(), counter
    raise RuntimeError("field rejection exhausted")


def make_fixture():
    names = ["zero", "valid_incrementing", "valid_ff"]
    leaves = [leaf(10, i, pattern(name)) for i, name in enumerate(names)]
    integrity_root, paths = tree_with_paths(leaves)
    small_transcript, small_hash, small_seed = full_transcripts(integrity_root, 0, 17 * 126976)
    large_transcript, context_hash, seed = full_transcripts(integrity_root, 0, 1073741824)
    offset_file_start = 61 * 126976 + 125000
    offset_range_start, offset_range_length = 2 * 126976 + 1000, 130000
    offset_transcript, offset_hash, offset_seed = full_transcripts(
        integrity_root, offset_range_start, offset_range_length, offset_file_start)
    positions = sample(small_hash, small_seed, 17, 17)
    challenges = []
    for i, position in enumerate(positions):
        coord = coordinate(position)
        z, counter = challenge_z(small_hash, small_seed, i, coord)
        challenges.append({"ordinal": i, "position": position, **coord, "z": z, "counter": counter})
    large_positions = sample(context_hash, seed, 8457, 132)
    offset_positions = sample(offset_hash, offset_seed, 3, 3)
    offset_challenges = []
    for i, position in enumerate(offset_positions):
        coord = coordinate(offset_transcript["first"] + position)
        z, counter = challenge_z(offset_hash, offset_seed, i, coord)
        offset_challenges.append({"ordinal": i, "position": position, **coord,
            "z": z, "counter": counter})
    bad = math.ceil(8457 / 10)
    return {"version": 3, "note": "Three-blob tree and transcript values are primitive vectors, not a complete admitted generation.",
        "fat_header": {"record_count": 2, "leaf_count": "96", "integrity_root": integrity_root.hex(),
            "header_hex": (b"NILF" + le16(3) + le16(256) + le32(2) + u8(1) + u8(1) + b"\0\0" + le32(131072) + le64(96) + integrity_root + bytes(68)).hex()},
        "integrity": {"mdu_index": "10", "patterns": names, "leaf_hashes": [v.hex() for v in leaves], "paths": [[x.hex() for x in path] for path in paths], "root": integrity_root.hex()},
        "small_transcript": small_transcript, "small_samples": challenges,
        "large_transcript": large_transcript,
        "large_sample": {"population": 8457, "count": 132, "first_eight": large_positions[:8], "positions_sha256": sha(b"".join(u64(v) for v in large_positions)).hex()},
        "offset_transcript": offset_transcript, "offset_samples": offset_challenges,
        "ranges": [{"start": "0", "length": "1024", "population": 1}, {"start": "126975", "length": "1024", "population": 2}, {"start": "0", "length": "1073741824", "population": 8457}, {"start": "126975", "length": "1073741824", "population": 8458}],
        "confidence": {"population": 8457, "count": 132, "bad": bad, "miss_numerator": str(math.comb(8457-bad, 132)), "miss_denominator": str(math.comb(8457, 132)), "one_bad_numerator": "8325", "one_bad_denominator": "8457"}}


def negative_checks(fixture):
    info, root = fixture["integrity"], bytes.fromhex(fixture["integrity"]["root"])
    paths = [[bytes.fromhex(x) for x in path] for path in info["paths"]]
    leaves = [bytes.fromhex(x) for x in info["leaf_hashes"]]
    assert all(verify_path(value, i, 3, paths[i], root) for i, value in enumerate(leaves))
    changed = bytearray(pattern(info["patterns"][0])); changed[-1] ^= 1
    assert not verify_path(leaf(10, 0, changed), 0, 3, paths[0], root)
    assert not verify_path(leaf(10, 1, pattern(info["patterns"][0])), 0, 3, paths[0], root)
    # Witness growth shifts absolute MDU indices even for unchanged bytes.
    assert not verify_path(leaf(11, 0, pattern(info["patterns"][0])), 0, 3, paths[0], root)
    assert not verify_path(leaves[0], 0, 3, paths[0], bytes(32))
    assert not verify_path(leaves[2], -1, 3, paths[2], root)
    assert not verify_path(leaves[0], 0, 3, paths[0][:-1], root)
    odd_bad = list(paths[2]); odd_bad[0] = bytes(32)
    assert not verify_path(leaves[2], 2, 3, odd_bad, root)

    transcript = fixture["offset_transcript"]
    assert transcript["first"] == 63 and transcript["last"] == 65
    omitted_firsts = (int(transcript["range_start"]) // 126976,
        int(transcript["file_start_offset"]) // 126976)
    assert omitted_firsts == (2, 61) and transcript["first"] not in omitted_firsts
    context_hash = bytes.fromhex(transcript["context_hash"])
    seed = bytes.fromhex(transcript["seed"])
    for item in fixture["offset_samples"]:
        coord = coordinate(transcript["first"] + item["position"])
        assert all(item[key] == coord[key] for key in ("t", "mdu_index", "leaf_index", "slot"))
        assert challenge_z(context_hash, seed, item["ordinal"], coord) == (item["z"], item["counter"])
        omitted_offset_coord = coordinate(item["position"])
        assert challenge_z(context_hash, seed, item["ordinal"], omitted_offset_coord)[0] != item["z"]
        corrupt_coord = dict(coord)
        corrupt_coord["leaf_index"] ^= 1
        assert challenge_z(context_hash, seed, item["ordinal"], corrupt_coord)[0] != item["z"]


def header_checks(fixture):
    header = bytes.fromhex(fixture["fat_header"]["header_hex"])
    assert len(header) == 128 and header[:4] == b"NILF"
    assert int.from_bytes(header[4:6], "little") == 3
    assert int.from_bytes(header[6:8], "little") == 256
    assert int.from_bytes(header[8:12], "little") == 2
    assert header[12:16] == b"\x01\x01\x00\x00"
    assert int.from_bytes(header[16:20], "little") == 131072
    assert int.from_bytes(header[20:28], "little") == 96
    assert header[28:60].hex() == fixture["fat_header"]["integrity_root"]
    assert header[60:] == bytes(68)


def main():
    actual = make_fixture()
    header_checks(actual)
    negative_checks(actual)
    for case in actual["ranges"]: assert range_population(int(case["start"]), int(case["length"])) == case["population"]
    for key in ("small_samples", "offset_samples"):
        positions = [item["position"] for item in actual[key]]
        assert len(positions) == len(set(positions))
    large = sample(bytes.fromhex(actual["large_transcript"]["context_hash"]), bytes.fromhex(actual["large_transcript"]["seed"]), 8457, 132)
    assert len(large) == len(set(large)) == 132
    if len(sys.argv) == 2 and sys.argv[1] == "--generate":
        FIXTURE.write_text(json.dumps(actual, indent=2) + "\n")
        return
    assert actual == json.loads(FIXTURE.read_text())
    print("retrieval-v3 header, bindings, integrity, sampling and confidence vectors: ok")


if __name__ == "__main__": main()
