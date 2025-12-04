# Nilcoin KZG Demo (educational, NOT for production).
# NOTE: This file was moved to demos/kzg as kzg_toy.py.
# --------------------------------------------------
# This notebook implements a toy, fully self-contained demonstration of
# Kate–Zaverucha–Goldberg (KZG) polynomial commitments in the style used by
# Nilcoin/NilStore for PoUD-style plaintext possession checks.
#
# ⚠️ SECURITY WARNING:
#   - This is a didactic simulation. It uses a "pairing simulator" (we track
#     exponents relative to fixed generators), *not* real elliptic-curve pairings.
#   - DO NOT use any of this code in production.
#
# What it shows:
#   1) We split an input file into 1 KiB data units.
#   2) We map each 1 KiB block to a field element y_i = H(block) mod r.
#   3) We choose domain points x_i = i / N in the field (i=0..N-1; division means
#      multiply by N^{-1} mod r).
#   4) We interpolate a polynomial P of degree < N with P(x_i) = y_i.
#   5) We generate a KZG commitment C = g1^{P(τ)} using an SRS for secret τ.
#   6) For a random index i (drawn from a seed), we prove possession:
#         π = KZG opening proof at x_i for y_i (and return the raw 1 KiB bytes).
#   7) The verifier recomputes y_i = H(bytes), checks x_i == i/N, and verifies
#      the KZG pairing equation e(C - g1^{y_i}, g2) == e(π, g2^{τ - x_i}).
#
# API (main helpers):
#   - setup(max_degree): creates a toy SRS with secret τ and group generators.
#   - commit_file(path, srs): returns a Pledge object with commitment + internals.
#   - prove_chunk(pledge, seed): returns a Proof object for a challenge index i.
#   - verify_proof(pledge, proof): boolean; checks hash binding + KZG opening.
#
# A demo run is performed at the bottom using this very notebook's environment.
#
# --------------------------------------------------

import hashlib, json, os, math, random, time, base64
from dataclasses import dataclass
from typing import List, Tuple

# ---------- Field setup (BN254 scalar field prime; any large prime would do here) ----------
r = 21888242871839275222246405745257275088548364400416034343698204186575808495617  # BN254 Fr

def mod(x: int) -> int:
    return x % r

def inv(x: int) -> int:
    # Fermat's little theorem; r is prime
    return pow(x % r, r-2, r)

# ---------- Toy bilinear groups (G1, G2, GT) implemented as exponent trackers ----------
class GT:
    __slots__ = ("e",)
    def __init__(self, e: int): self.e = mod(e)
    def __mul__(self, other): return GT(self.e + other.e)
    def __pow__(self, k: int): return GT(self.e * (k % r))
    def inv(self): return GT(-self.e)
    def __eq__(self, other): return (self.e % r) == (other.e % r)
    def __repr__(self): return f"GT(exp={self.e})"

class G1:
    __slots__ = ("e",)  # exponent wrt fixed generator g1
    def __init__(self, e: int): self.e = mod(e)
    def __mul__(self, other): return G1(self.e + other.e)  # group mul => add exponents
    def __pow__(self, k: int): return G1(self.e * (k % r))
    def inv(self): return G1(-self.e)
    def __repr__(self): return f"G1(exp={self.e})"

class G2:
    __slots__ = ("e",)  # exponent wrt fixed generator g2
    def __init__(self, e: int): self.e = mod(e)
    def __mul__(self, other): return G2(self.e + other.e)
    def __pow__(self, k: int): return G2(self.e * (k % r))
    def inv(self): return G2(-self.e)
    def __repr__(self): return f"G2(exp={self.e})"

def pair(g1: G1, g2: G2) -> GT:
    # Bilinear: e(g1^a, g2^b) = GT^{a*b}. Here we use the exponent tracker.
    return GT(g1.e * g2.e)

# Fixed generators (exponent 1 in the tracker model)
G1_GEN, G2_GEN = G1(1), G2(1)

# ---------- SRS / Trusted Setup ----------
@dataclass
class SRS:
    tau: int                 # secret scalar (kept only for the trusted-setup authority; NOT needed by prover)
    g1_pows: List[G1]        # [g1^{tau^0}, g1^{tau^1}, ..., g1^{tau^maxdeg}]
    g2_gen: G2               # g2
    g2_tau: G2               # g2^{tau}

def setup(max_degree: int, seed: int = 42) -> SRS:
    rnd = random.Random(seed)  # deterministic for demo reproducibility
    tau = rnd.randrange(1, r-1)
    g1_pows = []
    tau_pow = 1
    for _ in range(max_degree + 1):
        g1_pows.append(G1(tau_pow))     # "g1^{tau^j}" tracked by exponent tau_pow
        tau_pow = mod(tau_pow * tau)
    return SRS(tau=tau, g1_pows=g1_pows, g2_gen=G2_GEN, g2_tau=G2(tau))

# ---------- Polynomial helpers (mod r) ----------
def poly_add(a: List[int], b: List[int]) -> List[int]:
    m = max(len(a), len(b))
    out = [(0) for _ in range(m)]
    for i in range(m):
        av = a[i] if i < len(a) else 0
        bv = b[i] if i < len(b) else 0
        out[i] = mod(av + bv)
    return out

def poly_sub(a: List[int], b: List[int]) -> List[int]:
    m = max(len(a), len(b))
    out = [(0) for _ in range(m)]
    for i in range(m):
        av = a[i] if i < len(a) else 0
        bv = b[i] if i < len(b) else 0
        out[i] = mod(av - bv)
    return out

def poly_mul(a: List[int], b: List[int]) -> List[int]:
    out = [0] * (len(a) + len(b) - 1)
    for i, av in enumerate(a):
        for j, bv in enumerate(b):
            out[i+j] = mod(out[i+j] + av * bv)
    return out

def poly_eval(coeffs: List[int], x: int) -> int:
    acc = 0
    for c in reversed(coeffs):
        acc = mod(acc * x + c)
    return acc

def poly_div_by_x_minus_a(p: List[int], a_scalar: int) -> Tuple[List[int], int]:
    """Return (q, rem) such that p(X) = q(X)*(X-a) + rem."""
    n = len(p) - 1
    if n < 0:
        return [0], 0
    q = [0] * n
    rem = p[-1]
    for i in range(n-1, -1, -1):
        q[i] = rem
        rem = mod(p[i] + rem * a_scalar)
    # After synthetic division with (X - a), the final remainder is p(a)
    rem = rem  # already mod r
    return q, rem

def lagrange_interpolate_coeffs(xs: List[int], ys: List[int]) -> List[int]:
    """Compute coeffs of P of degree < len(xs) with P(xs[i]) = ys[i]. O(N^2)."""
    n = len(xs)
    assert n == len(ys)
    # Build monic polynomial M(X) = ∏ (X - x_j)
    M = [1]
    for x in xs:
        M = poly_mul(M, [mod(-x), 1])
    # Precompute M'(x_i) = derivative of M evaluated at x_i
    # Derivative coefficients
    M_deriv = [mod((i+1) * M[i+1]) for i in range(len(M)-1)]
    denom = [poly_eval(M_deriv, xi) for xi in xs]  # M'(x_i)
    # Build P(X) = Σ y_i * [ M(X) / ((X - x_i) * M'(x_i)) ]
    P = [0] * (n)
    for i in range(n):
        # Q_i = M / (X - x_i)
        Qi, rem = poly_div_by_x_minus_a(M, xs[i])
        assert rem == 0, "Division had non-zero remainder; xs must be distinct"
        scale = mod(ys[i] * inv(denom[i]))
        term = [(mod(c * scale)) for c in Qi]  # degree n-1
        P = poly_add(P, term)
    # Trim trailing zeros
    while len(P) > 1 and P[-1] == 0:
        P.pop()
    return P

# ---------- Hashing a 1 KiB block to a field element ----------
def hash_block_to_field(block: bytes) -> int:
    h = hashlib.sha256(block).digest()
    return int.from_bytes(h, "big") % r

# ---------- Commitment / Proof types ----------
@dataclass
class Pledge:
    filename: str
    N: int
    xs: List[int]            # domain points (i/N mod r)
    ys: List[int]            # H(1KiB block) mod r
    coeffs: List[int]        # polynomial coefficients for P(X)
    commit: G1               # C = g1^{P(τ)}
    srs: SRS                 # include for simplicity in this demo

@dataclass
class Proof:
    i: int
    xi: int
    yi: int
    block: bytes             # the raw 1 KiB bytes (possession witness)
    pi: G1                   # KZG proof π = g1^{Q(τ)} where Q = (P - yi) / (X - xi)

# ---------- SRS-based multi-exponentiation ----------
def commit_from_coeffs(coeffs: List[int], srs: SRS) -> G1:
    assert len(coeffs) <= len(srs.g1_pows), "SRS not large enough for polynomial degree"
    acc = G1(0)
    for j, cj in enumerate(coeffs):
        if cj % r == 0: 
            continue
        # Multiply the j-th SRS element by scalar cj (→ add exponents)
        acc = acc * (srs.g1_pows[j] ** cj)
    return acc

# ---------- File → pledge (commitment) ----------
def commit_file(path: str, srs: SRS) -> Pledge:
    with open(path, "rb") as f:
        data = f.read()
    # Split into 1 KiB units
    CHUNK = 131072
    blocks = [data[i:i+CHUNK] for i in range(0, len(data), CHUNK)]
    if len(blocks) == 0:
        blocks = [b""]  # handle empty file as one empty block
    # Pad last block to 1 KiB for determinism
    if len(blocks[-1]) < CHUNK:
        blocks[-1] = blocks[-1] + b"\x00" * (CHUNK - len(blocks[-1]))
    N = len(blocks)
    # Map to field
    ys = [hash_block_to_field(b) for b in blocks]
    invN = inv(N)
    xs = [mod(i * invN) for i in range(N)]  # i/N mod r
    # Interpolate polynomial P
    coeffs = lagrange_interpolate_coeffs(xs, ys)
    # Commitment C = g1^{P(τ)} via SRS multi-exponentiation
    commit = commit_from_coeffs(coeffs, srs)
    return Pledge(filename=path, N=N, xs=xs, ys=ys, coeffs=coeffs, commit=commit, srs=srs)

# ---------- Prove one opening at index i ----------
def prove_index(pledge: Pledge, i: int) -> Proof:
    assert 0 <= i < pledge.N
    xi, yi = pledge.xs[i], pledge.ys[i]
    # Build Q(X) = (P(X) - yi) / (X - xi)
    P_minus_yi = pledge.coeffs[:]  # copy
    P_minus_yi[0] = mod(P_minus_yi[0] - yi)
    Q, rem = poly_div_by_x_minus_a(P_minus_yi, xi)
    assert rem == 0, "P(xi) != yi; interpolation or hashing mismatch"
    # π = commit(Q)
    pi = commit_from_coeffs(Q, pledge.srs)
    # Return the raw block for possession check
    CHUNK = 131072
    with open(pledge.filename, "rb") as f:
        f.seek(i * CHUNK)
        block = f.read(CHUNK)
        if len(block) < CHUNK:
            block = block + b"\x00" * (CHUNK - len(block))
    return Proof(i=i, xi=xi, yi=yi, block=block, pi=pi)

# ---------- Challenge generator ----------
def draw_challenge_index(N: int, seed: int) -> int:
    rnd = random.Random(seed)
    return rnd.randrange(N)

def prove_with_seed(pledge: Pledge, seed: int) -> Proof:
    i = draw_challenge_index(pledge.N, seed)
    return prove_index(pledge, i)

# ---------- Verifier ----------
def verify_proof(pledge: Pledge, proof: Proof) -> bool:
    # 1) Check xi == i/N mod r
    if mod(proof.xi - mod(proof.i * inv(pledge.N))) != 0:
        return False
    # 2) Check yi binds to block
    if hash_block_to_field(proof.block) != proof.yi:
        return False
    # 3) Check pairing e(C - g1^{yi}, g2) == e(π, g2^{τ - xi})
    left = pair(pledge.commit * (G1_GEN ** (-proof.yi)), pledge.srs.g2_gen)
    right = pair(proof.pi, pledge.srs.g2_tau * (pledge.srs.g2_gen ** (-proof.xi)))
    return left == right

# ---------- Pretty helpers ----------
def short_hex(x: int, bytes_len=32) -> str:
    h = x.to_bytes(bytes_len, "big").hex()
    return f"0x{h[:8]}…{h[-8:]}"

def hex_be(x: int, size_bytes: int = 32) -> str:
    """Full big-endian hex (0x-prefixed) padded to size_bytes."""
    return "0x" + x.to_bytes(size_bytes, "big").hex()

def hex_min(x: int) -> str:
    """Minimal-length big-endian hex (0x-prefixed)."""
    if x == 0:
        return "0x0"
    blen = (x.bit_length() + 7) // 8
    return "0x" + x.to_bytes(blen, "big").hex()

def print_pledge(pledge: Pledge):
    print("PLEDGE")
    print("------")
    print(f"file:        {pledge.filename}")
    print(f"N (blocks):  {pledge.N}")
    deg = len(pledge.coeffs) - 1
    print(f"poly degree: {deg}")
    print(f"commit (G1): exp={short_hex(pledge.commit.e)}")
    print()

def print_proof(proof: Proof, ok: bool):
    print("PROOF")
    print("-----")
    print(f"index i:         {proof.i}")
    print(f"x_i (i/N mod r): {short_hex(proof.xi)}")
    print(f"y_i = H(block):  {short_hex(proof.yi)}")
    print(f"π (G1):          exp={short_hex(proof.pi.e)}")
    print(f"valid?           {ok}")
    print()

# ---------- Demo runner ----------
def demo(filename: str, seeds=(123, 456, 789), max_degree_hint: int = None, srs_seed: int = 1337):
    # Compute max degree; if not provided, use #blocks - 1 after reading file once.
    CHUNK = 131072
    size = os.path.getsize(filename)
    N = (size + CHUNK - 1) // CHUNK
    if N == 0: N = 1
    if max_degree_hint is None:
        max_degree_hint = max(N - 1, 0)
    # SRS
    srs = setup(max_degree=max_degree_hint, seed=srs_seed)
    # Pledge
    t0 = time.time()
    pledge = commit_file(filename, srs)
    t1 = time.time()
    print_pledge(pledge)
    # Prove/verify multiple seeds
    results = []
    for sd in seeds:
        pr = prove_with_seed(pledge, sd)
        ok = verify_proof(pledge, pr)
        print_proof(pr, ok)
        block_sha256 = hashlib.sha256(pr.block).hexdigest()
        results.append({
            "seed": sd,
            "i": pr.i,
            # Backwards-compatible short fields
            "xi_hex": short_hex(pr.xi),
            "yi_hex": short_hex(pr.yi),
            "pi_exp_hex": short_hex(pr.pi.e),
            # New, full-detail fields
            "xi_dec": pr.xi,
            "yi_dec": pr.yi,
            "pi_exp_dec": pr.pi.e,
            "xi_hex_32": hex_be(pr.xi),
            "yi_hex_32": hex_be(pr.yi),
            "pi_exp_hex_32": hex_be(pr.pi.e),
            "block_sha256_hex": "0x" + block_sha256,
            "block_b64": base64.b64encode(pr.block).decode("ascii"),
            "valid": ok,
        })
    # Summarize + save JSON artifact
    # File metadata
    with open(filename, "rb") as _f:
        file_sha256 = hashlib.sha256(_f.read()).hexdigest()

    # Rich, backwards-compatible output
    out = {
        "filename": filename,
        "file_size_bytes": size,
        "chunk_size": CHUNK,
        "file_sha256_hex": "0x" + file_sha256,
        "N": pledge.N,
        "degree": len(pledge.coeffs) - 1,
        # Commitment (keep short, add full forms)
        "commit_g1_exp_hex": short_hex(pledge.commit.e),
        "commit": {
            "g1_exp_dec": pledge.commit.e,
            "g1_exp_hex_32": hex_be(pledge.commit.e),
            "g1_exp_hex_min": hex_min(pledge.commit.e),
        },
        # SRS info
        "srs_seed": srs_seed,
        "tau_hex": short_hex(srs.tau),
        "srs": {
            "tau_dec": srs.tau,
            "tau_hex_32": hex_be(srs.tau),
            "tau_hex_min": hex_min(srs.tau),
            "g1_pows_count": len(srs.g1_pows),
            "max_degree": len(srs.g1_pows) - 1,
        },
        # Domain and polynomial (thorough)
        "xs_dec": pledge.xs,
        "ys_dec": pledge.ys,
        "coeffs_dec": pledge.coeffs,
        "xs_hex_32": [hex_be(x) for x in pledge.xs],
        "ys_hex_32": [hex_be(y) for y in pledge.ys],
        "coeffs_hex_32": [hex_be(c) for c in pledge.coeffs],
        # Proofs
        "seeds": results,
        # Timing/meta
        "build_ms": int((t1 - t0) * 1000),
        "all_valid": all(r["valid"] for r in results),
        "note": "Toy pairing simulator; for education only. DO NOT USE IN PRODUCTION."
    }
    out_path = "nilcoin_kzg_demo_output.json"
    with open(out_path, "w") as fp:
        json.dump(out, fp, indent=2)
    print(f"[Saved demo artifact] {out_path}")
    return out_path

# --------- Run the demo on one of the uploaded files ---------
artifact_path = demo("spec.md", seeds=(5, 17, 42), srs_seed=20250925)
artifact_path
