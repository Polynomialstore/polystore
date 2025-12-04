#!/usr/bin/env python3
"""
Nilcoin PoUD (KZG‑PDP on 1 KiB symbols) — ckzg (EIP‑4844) demo.

What this shows (plaintext mode):
  • Map a file → 1 KiB symbols → Fr values (SHA‑256 mod r).
  • Pack symbols into evaluation‑form blobs of 4096 cells (EIP‑4844 domain).
  • Commit each blob with KZG and produce example point‑evaluation proofs
    that “the j‑th 1 KiB symbol” is part of the commitment.
  • Verify proofs by recomputing the symbol’s Fr and calling ckzg verify.

Design choices (demo‑oriented):
  • Evaluation form (no FFT/IFFT needed).
  • Openings at domain indices z = ω^j (the standard 4096‑point domain).
  • DU root = Blake2s("NIL_DEMO_C_ROOT" || concat(blob commitments)).
    (Production would use Poseidon/Merkle per spec; this is demo‑simple.)

Spec alignment (plaintext PoUD):
  – 1 KiB symbol size, verifier‑chosen indices, KZG openings vs DU commitment. (*Core v2.0, §4′ PoUD; §4.1 DU representation*)  # see citations in the write‑up
"""

from __future__ import annotations
import argparse, hashlib, json, os, random, sys, time
from dataclasses import dataclass
from typing import List, Tuple

try:
    import ckzg  # Python bindings for c-kzg-4844
except Exception as e:
    ckzg = None
    _ckzg_import_err = e
else:
    _ckzg_import_err = None

# -------------------------
# BLS12-381 Fr constants
# -------------------------
FR_MODULUS = int("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001", 16)
FE_BYTES = 32
FE_PER_BLOB = 4096
SRC_SYMBOL = 131072  # 128 KiB per PoUD symbol (normative size in Nilcoin)  # demo
GENERATOR = 5      # multiplicative generator used to derive ω (standard choice)

def fr(x: int) -> int:
    return x % FR_MODULUS

def fr_to_le(x: int) -> bytes:
    if not (0 <= x < FR_MODULUS):
        raise ValueError("Fr out of range")
    return x.to_bytes(FE_BYTES, "little")

def le_to_fr(b: bytes) -> int:
    if len(b) != FE_BYTES:
        raise ValueError("bad Fr length")
    return int.from_bytes(b, "little")

def is_canonical_fe_le(b: bytes) -> bool:
    return len(b) == 32 and int.from_bytes(b, "little") < FR_MODULUS

def sha256_to_fr(block: bytes) -> int:
    return int.from_bytes(hashlib.sha256(block).digest(), "big") % FR_MODULUS

def load_ts(ts_path: str):
    if ckzg is None:
        raise RuntimeError(f"ckzg import failed: {_ckzg_import_err}")
    if not os.path.exists(ts_path):
        raise RuntimeError(f"Trusted setup not found: {ts_path}")
    return ckzg.load_trusted_setup(ts_path, 0)

# -------------------------
# File → symbols → blobs (evaluation form)
# -------------------------

def read_symbols(path: str) -> List[bytes]:
    data = open(path, "rb").read()
    blocks = [data[i:i+SRC_SYMBOL] for i in range(0, len(data), SRC_SYMBOL)]
    if not blocks:
        blocks = [b""]
    if len(blocks[-1]) < SRC_SYMBOL:
        blocks[-1] = blocks[-1] + b"\x00" * (SRC_SYMBOL - len(blocks[-1]))
    return blocks

def symbols_to_fr(blocks: List[bytes]) -> List[int]:
    return [sha256_to_fr(b) for b in blocks]

def frs_to_eval_blobs(ys: List[int]) -> List[bytes]:
    """
    Pack y-values into evaluation-form blobs:
      For blob k: cells j=0..m-1 hold y_{k*4096 + j}; the rest are zeros.
      Each cell is a 32-byte little-endian Fr per c-kzg-4844.
    """
    blobs: List[bytes] = []
    for i in range(0, len(ys), FE_PER_BLOB):
        chunk = ys[i:i+FE_PER_BLOB]
        padded = chunk + [0] * (FE_PER_BLOB - len(chunk))
        blob = b"".join(fr_to_le(v) for v in padded)
        # guard: every cell canonical
        for off in range(0, len(blob), 32):
            if not is_canonical_fe_le(blob[off:off+32]):
                raise ValueError("non-canonical field element in blob")
        blobs.append(blob)
    if not blobs:
        blobs.append(b"\x00" * (FE_PER_BLOB * FE_BYTES))
    return blobs

# -------------------------
# EIP-4844 domain helper: z = ω^j
# -------------------------

def root_of_unity_4096() -> int:
    return pow(GENERATOR, (FR_MODULUS - 1) // FE_PER_BLOB, FR_MODULUS)

def z_for_cell(idx: int) -> bytes:
    if not (0 <= idx < FE_PER_BLOB):
        raise ValueError("cell idx out of range")
    omega = root_of_unity_4096()
    z = pow(omega, idx, FR_MODULUS)
    return fr_to_le(z)

# -------------------------
# Commit / prove / verify
# -------------------------

@dataclass
class Shard:
    start: int        # global symbol start index
    count: int        # number of symbols in this shard (<= 4096)
    commitment: bytes # 48B G1 compressed
    blob: bytes       # 4096 * 32B evaluation-form blob

@dataclass
class DUCommitment:
    C_root: bytes
    commitments: List[bytes]
    total_symbols: int

def commit_du(ys: List[int], ts) -> Tuple[List[Shard], DUCommitment]:
    blobs = frs_to_eval_blobs(ys)
    shards: List[Shard] = []
    start = 0
    commits: List[bytes] = []
    for b in blobs:
        C = ckzg.blob_to_kzg_commitment(b, ts)
        commits.append(C)
        count = min(FE_PER_BLOB, len(ys) - start)
        shards.append(Shard(start=start, count=count, commitment=C, blob=b))
        start += count
    h = hashlib.blake2s()
    h.update(b"NIL_DEMO_C_ROOT")
    for c in commits:
        h.update(c)
    du = DUCommitment(C_root=h.digest(), commitments=commits, total_symbols=len(ys))
    return shards, du

def draw_index(seed: int, N: int) -> int:
    s = hashlib.sha256(f"NIL|seed={seed}|N={N}".encode()).digest()
    return int.from_bytes(s, "big") % N

def prove(shards: List[Shard], du: DUCommitment, blocks: List[bytes], ts, index: int):
    # locate shard and local cell
    sh_idx = 0
    while sh_idx < len(shards):
        sh = shards[sh_idx]
        if sh.start <= index < sh.start + sh.count:
            break
        sh_idx += 1
    if sh_idx == len(shards):
        raise IndexError("index out of range")
    sh = shards[sh_idx]
    local = index - sh.start
    # opening point is the domain cell z = ω^local
    z_le = z_for_cell(local)
    proof, y_le = ckzg.compute_kzg_proof(sh.blob, z_le, ts)
    # binder: recompute y from the 1 KiB symbol
    sym = blocks[index]
    y_from_bytes = sha256_to_fr(sym)
    y_int = le_to_fr(y_le)
    ok_bind = (y_int == y_from_bytes)
    # KZG check vs shard commitment
    ok_kzg = ckzg.verify_kzg_proof(sh.commitment, z_le, y_le, proof, ts)
    return {
        "index": index,
        "shard_idx": sh_idx,
        "local_cell": local,
        "z_hex": "0x" + z_le.hex(),
        "y_hex": "0x" + y_le.hex(),
        "commitment": "0x" + sh.commitment.hex(),
        "symbol_preview_hex": sym[:16].hex() + ("…" if len(sym) > 16 else ""),
        "verified": bool(ok_bind and ok_kzg),
    }

def verify(du: DUCommitment, proof_obj: dict, shards: List[Shard], blocks: List[bytes], ts) -> bool:
    sh = shards[proof_obj["shard_idx"]]
    idx = proof_obj["index"]
    local = proof_obj["local_cell"]
    # recompute DU root (demo-only aggregator)
    h = hashlib.blake2s()
    h.update(b"NIL_DEMO_C_ROOT")
    for c in du.commitments:
        h.update(c)
    if h.digest() != du.C_root:
        return False
    # bind y to bytes
    sym = blocks[idx]
    y_expect = sha256_to_fr(sym)
    y_int = int(proof_obj["y_hex"], 16)
    if y_int != y_expect:
        return False
    # verify KZG
    z_le = bytes.fromhex(proof_obj["z_hex"][2:])
    y_le = bytes.fromhex(proof_obj["y_hex"][2:])
    proof = bytes.fromhex(proof_obj["proof_hex"][2:]) if "proof_hex" in proof_obj else None
    if proof is None:
        # re-compute proof deterministically (optional path)
        proof, _ = ckzg.compute_kzg_proof(sh.blob, z_le, ts)
    return ckzg.verify_kzg_proof(sh.commitment, z_le, y_le, proof, ts)

# -------------------------
# Self‑test (endianness & API sanity)
# -------------------------

def ckzg_selftest(ts):
    # constant-one blob → y must be 1 at any z; verify must pass
    one = fr_to_le(1)
    blob = one * FE_PER_BLOB
    C = ckzg.blob_to_kzg_commitment(blob, ts)
    z = fr_to_le(1)  # any point works for constant 1
    prf, y = ckzg.compute_kzg_proof(blob, z, ts)
    if le_to_fr(y) != 1:
        raise RuntimeError("ckzg self-test: expected y==1 (endianness mismatch).")
    if not ckzg.verify_kzg_proof(C, z, y, prf, ts):
        raise RuntimeError("ckzg self-test: verify_kzg_proof failed (API/domain mismatch).")

# -------------------------
# Orchestration
# -------------------------

def run_demo(filename: str, ts_path: str, seeds: List[int], out_path: str) -> str:
    t0 = time.time()
    ts = load_ts(ts_path)
    ckzg_selftest(ts)  # catches wrong endianness/TS at startup

    blocks = read_symbols(filename)
    ys = symbols_to_fr(blocks)
    shards, du = commit_du(ys, ts)

    proofs = []
    for sd in seeds:
        idx = draw_index(sd, len(blocks))
        p = prove(shards, du, blocks, ts, idx)
        # pack proof as hex (include the proof bytes for future offline verify)
        sh = shards[p["shard_idx"]]
        z = bytes.fromhex(p["z_hex"][2:])
        prf, y_le = ckzg.compute_kzg_proof(sh.blob, z, ts)
        p["proof_hex"] = "0x" + prf.hex()
        p["verified"] = bool(
            p["verified"] and ckzg.verify_kzg_proof(sh.commitment, z, y_le, prf, ts)
        )
        proofs.append(p)

    t1 = time.time()
    out = {
        "filename": filename,
        "file_size_bytes": os.path.getsize(filename),
        "symbols_1KiB": len(blocks),
        "blob_count": len(shards),
        "blob_cell_count": FE_PER_BLOB,
        "du_C_root_hex": "0x" + du.C_root.hex(),
        "commitments_hex": ["0x" + s.commitment.hex() for s in shards],
        "proofs": proofs,
        "note": "Evaluation-form (EIP‑4844) KZG demo; Fr bytes = little‑endian; PoUD‑style single opens.",
        "build_ms": int((t1 - t0) * 1000),
    }
    with open(out_path, "w") as fp:
        json.dump(out, fp, indent=2)
    print(f"[saved] {out_path}")
    return out_path

def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Nilcoin PoUD on ckzg (educational demo)")
    p.add_argument("--file", default="trusted_setup.txt", help="input file path")
    p.add_argument("--trusted-setup", dest="ts_path",
                   default=os.environ.get("CKZG_TRUSTED_SETUP", "trusted_setup.txt"),
                   help="path to ckzg trusted setup")
    p.add_argument("--seeds", type=str, default="5,17,42",
                   help="comma-separated integer seeds")
    p.add_argument("--out", default="nilcoin_poud_ckzg_output.json",
                   help="output JSON path")
    return p.parse_args(argv)

def main():
    args = parse_args()
    if ckzg is None:
        raise SystemExit(f"ckzg not available: {_ckzg_import_err}. Install ckzg and retry.")
    seeds = [int(s.strip()) for s in args.seeds.split(",") if s.strip()]
    run_demo(args.file, args.ts_path, seeds, args.out)

if __name__ == "__main__":
    main()

