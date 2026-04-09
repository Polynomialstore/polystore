# PoS²‑L Scaffold — Research Supplement v1
**Status:** RESEARCH‑ONLY • NOT FOR MAINNET • DISABLED IN ALL PROFILES  
**File:** `rfcs/archive/pos2l/PoS2L_research_annex.v1.md`  
**Relates to:** `spec.md` (canonical), archived research context

---

## 0. Purpose & Scope (Research)

This document archives the **sealed PoS²‑L scaffold** for **research and contingency modeling**. It is **non‑normative** and **not part of the Core**. Mainnet/testnet profiles MUST operate in **plaintext mode** (PoUD + PoDE). This supplement exists to:
- benchmark sequential‑work transforms,
- analyze witness sizes and on‑chain costs,
- rehearse emergency procedures.

**No rewards** or economic paths should rely on this supplement unless explicitly activated under the policy below.

---

## 0.1 Activation Policy (Research Only)

Any experimental activation MUST satisfy **all** items:

1. **Governance Thresholds**
   - **DAO Supermajority** vote.
   - **Emergency 4‑of‑7** role‑diverse signatures (at least one from each group): {Core Team (2)}, {Independent Security Auditor (2)}, {Community/Validator Reps (3)}.

2. **Sunset & One‑Way Door**
   - **Auto‑sunset:** **14 days** post‑activation (cannot be modified by the patch).
   - **Ratification required** for continuation, but the auto‑sunset still executes; ratification only schedules inclusion in a standard upgrade cycle.
   - After sunset, a **post‑mortem** and parameter freeze are required before any re‑activation proposal.

3. **Plaintext Linkage (Payout Guard)**
   - Even during scaffold experiments, payouts MUST remain tied to **plaintext correctness**:
     - `p_link ≥ 0.10` (DU Origin Binding),
     - `p_derive ≥ 0.05` (row‑local PoDE),
     - `micro_seal = row`,
     - `p_kzg ≥ 0.05` for receipt‑level content checks.
   - Rewards for sealed‑only proofs are prohibited.

4. **Verification Load Cap (VLC) Respect**
   - Escalations (e.g., `p`, `p_kzg`) MUST obey the chain’s VLC policies. If VLC is hit, prioritize security‑critical parameters per canonical spec parameters.

**Note:** These brakes were originally described in older metaspec drafts; the current canonical constraints live in `spec.md` (§5, Appendix B). This file remains a self-contained research annex snapshot.

---

## 1. Objective & Security Model (PoS²‑L)

`poss²` is an on‑chain **storage‑liveness** scaffold over a **sealed** replica. For epoch `t` it forces a miner to:
1. Prove that an **authenticated replica** (sealed via `nilseal`) still exists on local disk; and
2. Spend ≥ `Δ/5` wall‑clock time per replica to recompute it (sequential‑work bound).

**Security anchors**
- Sequential‑work bound of `nilseal` via data‑dependent permutation and iterated hashing.
- Collision resistance of Blake2s‑256 and Merkle tree roots.
- Row digest commitment (`delta_head`) per row.

> **Research status:** This scaffold is for benchmarking; plaintext PoUD + PoDE remains the canonical proof path.

---

## 2. Replica Layout (Row/Column Model)

- `S` — Sector size (bytes)
- `rows = S / 2 MiB` (row height fixed)
- `cols = 2 MiB / 64 B = 32 768` (64‑byte leaves per row)
- `window = 1 MiB` (proof reads 8 adjacent windows, ≤ 8 MiB)

**Example:** `S = 32 GiB` → `rows = 16 384`, `cols = 32 768`.

Row `i` has two 1 MiB windows `W₂i` and `W₂i+1`. The row root is `h_row[i]`. The row digest is:
```

Δ\_row\[i] = Blake2s‑256(W₂i ‖ W₂i+1)
delta\_head\[i] = Blake2s‑256("P2Δ" ‖ i ‖ h\_row\[i] ‖ Δ\_row\[i])

```

**Merkle arity (option):** Higher arity (e.g., 16‑ary) MAY be used to reduce path length; witness encoding MUST reflect arity/depth.

---

## 3. Scaffold Profile Dial

Let `φ_seal ∈ (0,1]` be the **sealed‑row fraction** (default `φ_seal = 1/32`) for experiments. Only rows with `(i mod 1/φ_seal == 0)` are sealed and committed (`h_row`, `delta_head`). PoS² challenges target the sealed subset. Unsealed rows MUST be covered by **plaintext PoDE**.

**Origin Binding (research linkage):** Rows MUST bind to DU plaintext via an Origin Map (see § 6) and periodic KZG content openings.

---

## 4. Challenge Derivation (Beacon Mix)

For epoch counter `ctr` and beacon block‑hash `B_t`:
```

ρ = Blake2s‑256("POSS2-MIX" ‖ B\_t ‖ h\_row\_root ‖ delta\_head\_root ‖ miner\_addr ‖ ctr)
row = RejectionSample(u32\_le(ρ\[0..4]), rows)
col = RejectionSample(u32\_le(ρ\[4..8]), cols)
offset = (row \* 2 MiB) + (col \* 64 B)

````
**I/O:** Prover reads eight 1 MiB windows covering `offset − 3 MiB … offset + 4 MiB` (mod `S`), i.e., ≤ 8 MiB.

**RejectionSample:** Use modulo‑bias‑free sampling (power‑of‑two fast path, counter‑mode expansion otherwise).

---

## 5. DU Origin Binding (Linking Mode)

For a governance‑tunable fraction `p_link`:
- Provide a Poseidon‑Merkle inclusion from `origin_root` yielding `{du_id, sliver_index, symbol_range, C_root}` for the row `i`.
- Provide a **KZG opening** at a verifier‑selected symbol index `j ∈ symbol_range` proving `leaf64` content matches the DU commitment `C_root`.
- Provide a hash binding `leaf64 == SealTransform(clear_slice(j), beacon_salt, row)` under the active micro‑seal profile.

Chains with KZG precompiles SHOULD verify on‑chain; otherwise, watchers verify off‑chain with fraud‑proof slashing.

---

## 6. Proof Object & Witness Layout

### 6.1 `Proof64` (binary layout)
```c
struct Proof64 {
    u16  idx_row;        // little‑endian
    u16  idx_col;
    u32  reserved = 0;   // MAY encode {arity: u8, depth: u8} in high/low bytes
    u8   leaf64[64];          // 64‑byte leaf payload at (row,col)
    u8   rowPath[480];        // 15 siblings × 32 B (binary path)
    u8   rowDelta[32];        // Blake2s‑256(W₂i ‖ W₂i+1)
    u8   deltaHeadPath[480];  // 15 siblings × 32 B under deltaHeadRoot
};
````

### 6.2 Witness (baseline)

| Purpose                     |   Bytes | Notes                                 |
| --------------------------- | ------: | ------------------------------------- |
| Row Merkle path             |     480 | 15 × 32‑B siblings (binary)           |
| Row digest `Δ`              |      32 | `Blake2s‑256(W₂i ‖ W₂i+1)`            |
| `delta_head[i]` Merkle path |     480 | 15 × 32‑B siblings                    |
| **Total**                   | **992** |                                       |
| Header (optional)           |       4 | `reserved` MAY carry `{arity, depth}` |

**Security bound:** No per‑sibling truncation in profiles targeting ≥128‑bit security. Prefer higher‑arity trees to improve size/latency trade‑offs.

---

## 7. Prover & Verifier

### 7.1 Prover (`pos2_prove`)

```
fn pos2_prove(path, row_i, col_j, ρ) -> Proof64 {
  // 1) leaf64 at (row_i, col_j)
  // 2) rowPath with full siblings (or configured arity)
  // 3) Δ = Blake2s-256(W₂i ‖ W₂i+1)
  // 4) deltaHeadPath under posted deltaHeadRoot
  // 5) assemble Proof64
}
```

### 7.2 On‑chain verifier (pseudo‑Solidity)

```solidity
function poss2_verify(bytes32 hRowRoot, bytes32 deltaHeadRoot, Proof64 calldata p)
  external pure returns (bool ok)
{
    bytes32 leaf = blake2s_256(bytes.concat(hex"00", p.leaf64));
    bytes32 rootRow = reconstruct(leaf, p.rowPath);        // 15 siblings
    if (rootRow != hRowRoot) return false;

    bytes32 Delta = p.rowDelta;
    bytes32 deltaHead_i = blake2s_256(abi.encode("P2Δ", p.idx_row, rootRow, Delta));
    bytes32 rootDelta = reconstruct(deltaHead_i, p.deltaHeadPath);
    if (rootDelta != deltaHeadRoot) return false;

    return true;
}
```

---

## 8. Sealing & Derivation (Reference Hooks)

For research completeness, the scaffold references the `nilseal` codec and its derivation micro‑profile:

* **Data‑dependent PRP:** 20‑round Feistel keyed by BLAKE2s; no cycle‑walk; domain size `M = N_chunks`.
* **Round offsets `ζ_p`:** 256‑bit offsets derived from an **IteratedHash** over chunk digests of the previous pass.
* **Micro‑seal (`Derive`) window:** deterministic, beacon‑salted local transform over `W = 8 MiB`, domain‑separated from full sealing; recomputable from plaintext.

See Core `spec.md` § 3.3–3.4 and § 3.3.1 for details; these sections remain in Core for parameterization and interop with the plaintext derivation (`PoDE`).

---

## 9. Origin Map (row→DU binding)

For each row `i`, record:

```
OriginEntry := { row_id = i, du_id, sliver_index, symbol_range, C_root }
```

Merkleize all `OriginEntry` objects (Poseidon) into `origin_root`. Any PoS² proof MAY be required to include a Merkle proof from `origin_root` for the challenged row.

---

## 10. Research Dials & Guard‑Rails

* `φ_seal` (sealed row fraction): default `1/32` for experiments.
* `p_link`, `p_derive`, `micro_seal`, `p_kzg` as in Core metaspec § 6.7 defaults (increase during research as needed).
* **Invariant:** Plaintext primacy — content checks and repairs MUST open against the **original DU KZG** `C_root`.

## 10A. Nil‑Lattice Hash / “Nilweave” (`nilhash`) — Research Archive (moved from Core §2)
**Status:** RESEARCH‑ONLY • NOT FOR MAINNET • DISABLED IN ALL PROFILES

> This section is transplanted from Core `spec.md` §2 to keep nil‑lattice commitments available for experiments. Mainnet/testnet use **KZG** commitments (PoUD). Implementers MUST NOT rely on `nilhash` in production.

### 10A.0 Scope
`nilhash` is Nilcoin’s vector‑commitment primitive mapping bytes → `𝔽_q^m`; binding reduces to Module‑SIS. (Moved unchanged from Core.)

### 10A.1 Message→Vector Injection (Padding, 12‑bit limbs, SVT order)
[Verbatim from Core § 2.1, including padding rule, 12‑bit limb parsing, and SVT stride‑vector‑transpose.]

### 10A.2 Algorithms (commit/open/verify), parameter generation, twist, A/B spectral checks
[Verbatim from Core § 2.2 including seed mixing, circulant A/B, spectral twist, Module‑SIS binding notes.]

### 10A.3 On‑chain digest format (CRT option) and Worked Example
[Verbatim from Core § 2.3–§ 2.4.]

### 10A.4 Parameterisation & Notes
[Verbatim from Core § 2.5–§ 2.6.]

## 10B. Sealing Codec (`nilseal`) — Research Archive (moved from Core §3)
**Status:** RESEARCH‑ONLY • NOT FOR MAINNET

> Full sealed‑replica mechanics required only by PoS²‑L studies: Argon2 “drizzle”, NTT pipeline, PRP permutation, ζ derivation, Gaussian noise, row Merkle, delta‑head, origin map, and encoder pseudocode.

- **Scope & Threat Model:** [Core § 3.0]
- **Pre‑processing (Argon2 drizzle):** [§ 3.2]
- **Transform loop (NTT_k + salt):** [§ 3.3]
- **Data‑dependent permutation (PRP) & ζ derivation:** [§ 3.4.1–§ 3.4.2]
- **Gaussian noise compression:** [§ 3.5]
- **Row Merkle tree & delta‑row accumulator:** [§ 3.6–§ 3.7]
- **Origin Map & reference encoder:** [§ 3.7.1–§ 3.8]
- **Dial guardrails & performance:** [§ 3.9–§ 3.10]
- **Security references:** [§ 3.11]

---

## 11. Known‑Answer Tests (KATs)

### 11.0 Research‑only Domain Identifiers
| ID (hex)  | Domain                                  |
|-----------|-----------------------------------------|
| `0x0100`  | nilseal row Merkle roots (`h_row`)      |

### 11.1 Research‑only Domain Strings (Blake2s)
| Tag                  | Purpose                                        |
|----------------------|------------------------------------------------|
| "P2Δ"                | Delta‑head binding for PoS²‑L                 |
| "POSS2-MIX"         | PoS² challenge mixing                          |
| "NILHASH-RANGE"     | nilhash range‑proof transcript tag             |
| "POLYSTORE_SEAL_PRP"      | PRP round‑function key                         |
| "POLYSTORE_SEAL_ZETA"     | ζ offset derivation                            |
| "POLYSTORE_SEAL_ITER_INIT"| IteratedHash init for ζ                        |
| "POLYSTORE_SEAL_ITER_STEP"| IteratedHash step for ζ                        |
| "POLYSTORE_SEAL_NOISE"    | Noise RNG domain                               |
| "POLYSTORE_SEAL_SALT_EXP" | Salt expansion XOF for k‑limbs (also used by PoDE Derive)

For research runs, reuse the machine‑readable KATs defined in Core Annexes with the following files:

* `poss2_mix_roots.toml` — beacon mixing vectors,
* `nilseal_prp.toml` — PRP traces (keyed BLAKE2s),
* `poss2.toml` — sample `Proof64` objects for several beacons,
* `noise_seed.toml` — RNG determinism (if sealing is exercised),
* `sampling_seed.toml` — epoch sampling expansion vectors.

**Reproducibility:** CI MUST regenerate `_artifacts/` and `SHA256SUMS` via `make publish` and assert byte‑for‑byte identity.

**Additional research KAT files (moved from Core):**
- `nilhash.toml` — full vectors & π transcripts
- `nilseal_prp.toml` — PRP traces (keyed BLAKE2s)
- `poss2_mix_roots.toml` — PoS² beacon mixing vectors
- `nilseal.toml` — legacy codec vectors
- `poss2.toml` — sample PoS² `Proof64` objects

---

## 11A. Security Notes for Archived Features
- **nilhash binding (Module‑SIS):** moved from Core § 7.3.
- **Sealed replica sequential‑work & indistinguishability:** moved from Core § 7.4.
- **PoS²‑L rationale:** moved from Core § 7.6.

## 12. Security Notes (Research)

* **Sequential work:** `ζ_p` derived via iterated hashing enforces strict pass order (pre‑images would break Blake2s‑256 in RO model).
* **Replica indistinguishability:** Depends on Gaussian noise parameters (`λ`) and quantization; publish empirical tests with min‑entropy/χ² for research runs.
* **No economic reliance:** Even if scaffold is toggled experimentally, economic flows MUST remain bound to plaintext proofs (PoUD + PoDE).

---

## 13. Removal Plan

This supplement is intended to be **deleted** before Core publication once:

1. KZG + VDF precompiles are stable at target throughput;
2. PoUD + PoDE meet coverage and cost SLOs;
3. Watcher timing + QoS oracle pass adversarial stress tests;
4. No critical liveness gaps require sealed proofs.

A removal PR SHOULD:

* Delete Annex A body from `spec.md`,
* Retain the small pointer that this file existed historically,
* Excise scaffold references from older metaspec drafts (archived).

---

*End of Research Supplement.*


## 10C. Field & NTT Module (`nilfield`) — Research Archive
**Status:** RESEARCH‑ONLY • NOT FOR MAINNET

## § 1 Field & NTT Module (`nilfield`)

### 1.1 Constants – Prime *q₁* = 998 244 353

| Name     |            Value (decimal) | Hex                | Comment                  |
| -------- | -------------------------: | ------------------ | ------------------------ |
| `Q`      |                998 244 353 | 0x3B800001         | NTT-friendly prime (≈2³⁰)|
| `R`      |                932 051 910 | 0x378DFBC6         | 2⁶⁴ mod Q                |
| `R²`     |                299 560 064 | 0x11DAEC80         | *R²* mod Q               |
| `Q_INV`  | 17 450 252 288 407 896 063 | 0xF22BC0003B7FFFFF | −Q⁻¹ mod 2⁶⁴             |
| `g`      |                          3 | —                  | Generator of 𝔽\*\_Q     |
| `ψ_64`   |                922 799 308 | 0x3700CCCC         | Primitive 64‑th root     |
| `ψ_128`  |                781 712 469 | 0x2E97FC55         | Primitive 128‑th root    |
| `ψ_256`  |                476 477 967 | 0x1C667A0F         | Primitive 256‑th root    |
| `ψ_1024` |                258 648 936 | 0x0F6AAB68         | Primitive 1 024‑th root  |
| `ψ_2048` |                584 193 783 | 0x22D216F7         | Primitive 2 048‑th root  |
| `64⁻¹`   |                982 646 785 | 0x3A920001         | For INTT scaling         |
| `128⁻¹`  |                990 445 569 | 0x3B090001         | —                        |
| `256⁻¹`  |                994 344 961 | 0x3B448001         | —                        |
| `1024⁻¹` |                997 269 505 | 0x3B712001         | —                        |
| `2048⁻¹` |                997 756 929 | 0x3B789001         | —                        |

*Origin:* generated verbatim by the normative script in **Annex C**.
All reference implementations embed these literals exactly.

### 1.1.1 Mandatory CRT prime q₂ = 1 004 535 809  (NTT‑friendly)

Constants (ψₖ, k⁻¹, Montgomery params) for q₂ are generated by Annex C with:

```
python3 appendix_c_constants.py 1004535809 3 > constants_q2.txt
```

Implementations MUST embed the q₂ constants exactly as emitted and run the KATs in Annex A for both primes.

### 1.2 API Definition (Rust signature, normative)

```rust
pub mod nilfield {
    /* ---------- modulus & Montgomery ---------- */
    pub const Q:      u32 = 998_244_353;
    pub const R:      u32 = 932_051_910;
    pub const R2:     u32 = 299_560_064;
    pub const Q_INV:  u64 = 0xF22BC0003B7FFFFF;

    /* ---------- field ops (constant‑time) ----- */
    pub fn add(a: u32, b: u32) -> u32;   // (a + b) mod Q
    pub fn sub(a: u32, b: u32) -> u32;   // (a − b) mod Q
    pub fn mul(a: u32, b: u32) -> u32;   // Montgomery product
    pub fn inv(a: u32) -> u32;           // a⁻¹ mod Q (Fermat)

    /* ---------- radix‑k NTT ------------------- */
    pub fn ntt64(f: &mut [u32; 64]);     // forward DIF, in‑place
    pub fn intt64(f: &mut [u32; 64]);    // inverse DIT, scaled 1/64
}
```

Implementations **shall** provide equivalent APIs in other languages.

### 1.3 Constant‑Time Requirement (normative, micro‑arch aware)

All `nilfield` functions operating on secret data **must** execute in time independent of their inputs and **must not** perform secret‑dependent memory accesses or control‑flow.

**Rules (normative):**
1) **No secret‑dependent branches** (including early returns), **no secret‑dependent table lookups**, **no secret‑dependent memory addresses**.
2) **Fixed operation counts**: loops and iteration counts must be independent of secret values.
3) **Instruction selection**: avoid variable‑latency divisions; inversion `inv(a)` **must** use a fixed‑window addition chain or sliding‑window exponentiation with constant‑time selection (no data‑dependent table indices).
   **Normative (Inversion):** Inversion of secret values MUST use Fermat's Little Theorem (a^(q-2) mod q) with a fixed, optimized addition chain.
4) **Montgomery core**: `mul`/`REDC` must use only integer ops; final conditional subtraction must be implemented with constant‑time bit‑masking (no branches).
   **Instruction Latency (Normative):** Implementations MUST use instructions guaranteed to be constant-time (e.g., widening multiplies with fixed cycles, `mulx` on x86-64) and verify this via assembly inspection.
5) **Tooling gates (required)**:
   • **ctgrind**: zero findings;  
   • **dudect**: Welch’s *t*‑test |t| ≤ 4.5 on ≥ 2²⁰ traces at 3 GHz equivalent;  
   • **llvm‑mca (or objdump review)**: verify no data‑dependent instructions (DIV/MOD) in secret‑handling code paths;  
   • **cache‑flow audit**: static check that all memory indices in secret code are public.
   • **Formal Verification (Required):** Use formal methods tools (e.g., EasyCrypt, Jasmin) to provide a machine-checked proof that the reference implementation of `inv(a)` and `mul` is constant-time.
6) **Build flags**: enable constant‑time codegen (e.g., `-fno-builtin-memcmp` or constant‑time intrinsics) and pin target CPU features in CI.

**Formal Auditing Process (Normative):** Reference implementations MUST undergo a formal audit including manual review of generated assembly on target architectures and explicit threat modeling for cache-timing attacks (e.g., Flush+Reload, Prime+Probe).

**CRT (Normative):** With the mandatory CRT profile:
1) **Reconstruction:** The reconstruction algorithm (e.g., Garner's method) MUST be implemented in constant time.

**NTT (Normative):** Memory access patterns during the NTT MUST be data-independent. Twiddle factor tables MUST be accessed using only public indices.

**Documentation**: Reference implementations MUST include a short write‑up explaining how each rule is met in `nilfield`, especially for `inv(a)`.

### 1.4 Radix‑*k* NTT Specification

* The forward transform `ntt_k` is a breadth‑first DIF algorithm using `ψ_k` twiddles; input and output are in natural order.
* The inverse transform `intt_k` is DIT with twiddles `ψ_k⁻¹`.
* Post‑inverse scaling multiplies every coefficient by `k⁻¹ mod Q`.
* For `k ∈ {64,128,256,1024,2048}` the corresponding `ψ_k` **must** be used; extending to higher powers of two requires governance approval (§ 6).

**Memory layout:** vectors are contiguous arrays of `u32` little‑endian limbs.  No bit‑reversal copy is permitted outside the NTT kernels.

**Known‑Answer Tests:** Annex A.1 & A.2 contain round‑trip vectors
`[1,0,…] → NTT → INTT → [1,0,…]` for every supported *k*.

### 1.5 Implementation Guidance (with constant‑time WASM/MCU profile)

* Preferred: 32×32→64 **Montgomery** multiply + `REDC` using only integer ops. On 32‑bit targets, use two‑limb decomposition to synthesize 64‑bit products in constant time.
* **WASM (wasm32):** require native `i64` support; **asm.js** fallbacks or FP must not be used. Constant‑time **Barrett** is permitted with μ = ⌊2⁶⁴/q⌋ and all reductions implemented without division and without secret‑dependent branches. Implementations MUST ship KATs demonstrating equality with Montgomery on the same inputs.
* **Environment probes (normative):** at startup, assert (a) two’s‑complement integers, (b) 32‑ and 64‑bit widths as specified, (c) native 64‑bit integer ops available. Otherwise, **fail fast** and expose a conformance error.
* Inline `k⁻¹` scaling into the last butterfly stage to save one loop **only** if the fused code path preserves constant‑time guarantees above.

---

---

 

### 2.0 Scope


---

### 2.1 Message → Vector Injection (“SVT order”)

#### 2.1.1 Padding

```
msg' = |len_u64|_LE  ‖  msg  ‖  0x80  ‖  0x00 …           // pad to multiple of 3 bytes
```

* `|len_u64|` is the original message length in **bytes**.
* Append `0x80`, then zero‑bytes until `len(msg')` is a multiple of 3 (≥ 8 + |msg| + 1).
  *(ISO/IEC 9797‑1 scheme 1 adapted to 12‑bit limbs.)*

#### 2.1.2 Limb parsing

`x_raw` = `msg'` parsed as packed little‑endian 12‑bit limbs.
For 3 bytes (b₀, b₁, b₂), unpack two limbs: 
  xᵢ = b₀ | (b₁ & 0x0F) << 8; 
  xᵢ₊₁ = (b₁ >> 4) | b₂ << 4.
`x_raw = [x₀, x₁, …, x_{L−1}]` with `L = (len(msg')/3) * 2`.

If `L > m` → **reject** (“message too long for profile”).
If `L < m` pad the tail with zeros.

#### 2.1.3 SVT order (stride‑vector‑transpose)

Let `B = m / k` blocks (baseline `k = 64`, `B = 16`).
Conceptually arrange the limb array as a **k × B** row‑major matrix

```
Row r (0 … k-1) :  x_raw[r·B + c] ,  c = 0 … B-1
```

**SVT order** is the **column‑major read‑out** of this matrix:

```
SVT(x_raw)[ i ] = x_raw[ (i mod k) · B  +  ⌊i / k⌋ ] ,  0 ≤ i < m.
```

Intuition: every NTT block (row) receives one limb from each stride column, maximising inter‑block diffusion.

---
### 2.2 Algorithms (revised)

> **Public parameters** (fixed per dial profile, derived in Annex C)
>
> * **Hash Function H (Normative):** All parameter generation MUST use SHAKE128 as an Extendable Output Function (XOF).
> * **Uniform Sampling (Normative):** All sampling modulo q MUST use uniform rejection sampling (no modulo‑bias), with statistical distance from uniform < 2^-128.
> * **Seed mixing (Normative, strengthened):** All per‑object seeds for parameter generation MUST be drawn from a master XOF stream


>   with the following requirements:
>   1) `GovProposalHash` = Blake2s‑256 of the governance proposal object that introduces the dial/profile change (hash‑pinned on‑chain at proposal open);
>   2) `CRS_commit` / `CRS_reveal`: a *threshold* (≥ t‑of‑n) commit‑reveal from independent parties posted on L1.
>   3) **Stalling Prevention (Normative):** `vrf_beacon_paramgen` MUST be derived from a VRF transcript at a block height determined **after** the commit phase closes. Any missing reveals (for Nonce or CRS) MUST be replaced by `vrf_beacon_paramgen`.
>   3) All sub‑seeds MUST include **explicit domain strings** unique per artifact:
>
>      `H("A-seed"‖Version‖DID‖Nonce‖GovProposalHash‖CRS_commit‖CRS_reveal)`,  
>      `H("B-spectrum"‖Version‖DID‖Nonce‖GovProposalHash‖CRS_commit‖CRS_reveal‖j)`,  
>      `H("twist"‖Version‖DID‖Nonce‖GovProposalHash‖CRS_commit‖CRS_reveal‖j)`.
>
>   Re‑using `Nonce` or `GovProposalHash` across major/minor versions is forbidden. Implementations MUST serialize and store the full paramgen transcript for audit.
>   **Grinding prohibition:** the ceremony and transcript MUST ensure no single party can bias `A`, `B`, or the per‑domain twist values.
> * Circulant matrix **A** generated from first row `α` (derived via H("A-seed"‖Version‖DID‖Nonce)).
> * Independent circulant matrix **B**: sample $\widehat b_j$ uniformly from 𝔽_q using H("B-spectrum"‖Version‖DID‖Nonce‖j) until non‑zero; set **b_vec = INTT( \widehat b )**.   // renamed to avoid collision with the r‑bound β
> * **Spectral Checks (Normative):**
>   1) **B invertibility:** every NTT coefficient of $\widehat b$ MUST be non‑zero (det(B) ≠ 0) **and** the minimal polynomial of $\widehat b$ over 𝔽_q MUST have no factors of order ≤ 2¹⁶. Re‑sample on failure.
>   2) **A robustness:** the NTT of the first row of A, $\widehat α$, MUST pass the same minimal‑polynomial filter (no small‑order factors); additionally, every coefficient of $\widehat α$ MUST be non‑zero.
>   3) **Co‑primeness:** for all indices j, **gcd**$(\widehat α_j, \widehat b_j, q)=1$ (i.e., $(A,B)$ have no shared low‑order spectral factors). Re‑sample on failure.
> * Per‑domain **spectral twist** **D^(DID)**: sample $d_j$ uniformly from 𝔽_q using H("twist"‖Version‖DID‖Nonce‖j), re‑draw zeros. Apply as a diagonal in NTT space on the A·x path.

| Function      | Signature                                                                  | Definition |
| ------------- | ---------------------------------------------------------------------------- | ---------- |
| **commit**    | `fn commit(DID, msg, rng) → h: [u32; m]{×CRT}`                                | Prover samples `r ← D_σ` with `||r||_∞ ≤ β` (constant‑time), computes `h = (A_twisted·x) + (B·r)`, and retains `(r, π)` privately. |
| **open**      | `fn open(msg, r, π) → (msg, r, π)`                                          | Output the original message, blinding vector `r`, and its bound‑proof `π`. The sampling of `r` MUST be constant‑time. |
| **verify**    | `fn verify(h, msg, r, π) → bool`                                             | Recompute `x` and twist; check `h == A_twisted·x + B·r` per prime; verify `π`. |
| **update**    | *unchanged* (requires re‑commit)                                            | Any change to `msg` or `r` requires a fresh `commit`. |
| **aggregate** | `Σ_field`                                                                    | Component‑wise addition of commitment vectors. |

*Complexity* – Commit/Verify: unchanged NTT count (per‑prime); proof adds O(log m) time and ~2 kB to the opening object.

**Sampling (Normative):** The sampling of `r` MUST use a specified constant-time algorithm (e.g., constant-time discrete Gaussian or centered binomial) with published bounds on the statistical distance from the target distribution.

> **Note:** Attribute‑selective openings will appear in v 2.1 using a zero‑knowledge inner‑product argument.  For v 2.0 all openings disclose the entire message.

#### 2.2.1  KAT impact

Note: Known‑Answer Tests updated in Annex A.3.


---

### 2.3 On‑Chain Digest Format

```
commit_digest =
    Blake2s‑256( Version ‖ DomainID ‖ h^{(1)} ‖ h^{(2)} )   // 32 bytes
    // CRT is mandatory. **Both** vectors MUST be included in the digest input and in every `verify` computation; openings MUST satisfy the relation in **each** prime separately. The primes q₁ and q₂ MUST be co‑prime. No per‑prime truncation or mixing is permitted.

where  Version  = {0x02,0x00,0x00}
       DomainID = 0x0000  (internal primitive namespace)
```

The entire vector `h` (2 KiB baseline) **must** be supplied in calldata when `Version.major` increases; otherwise the 32‑byte digest is sufficient.

---

### 2.4 Worked Example (Baseline “S‑512”)

Input: empty string `""`, `DID = 0x0000`.

| Step              | Result (hex, little‑endian)       |
| ----------------- | --------------------------------- |
| `h` (1 024 limbs) | `f170 75ce 9788 65d7 … c386 7881` |
| `commit_digest`   | `af01 c186 … e3d9 990d` (32 B)    |


Note (CRT mode): The mandatory CRT prime `q₂` requires an additional vector `h^{(2)}` computed identically over `q₂`, and `commit_digest` hashes the concatenation `h^{(1)} ‖ h^{(2)}` (see § 2.3).

---

### 2.5 Parameterisation & Extensibility

* Increasing `m` or changing `q` → **major** version bump (§ 0.3).
* Tuning `k` or replacing `α` with a higher‑order root (e.g., `ψ_128`)
  → **minor** bump; implementers must regenerate the *A* row using Annex C.

---

### 2.6 Implementation Notes (informative)

* **Vectorised FFT:** two 64‑point NTTs fit in AVX‑2 registers; unroll eight butterflies per stage for maximum ILP.
* **Memory‑hard variants:** set `k = 256` and keep `B = m/k` fixed to quadruple cache footprint.
* **Open/verify kernels:** the circulant property lets one reuse a single 64‑point NTT per dot‑product.

---


---

 

 

### 3.0 Scope & Threat Model

`S = 2^n` bytes, *n ≥ 26* (≥ 64 MiB)—into a **replica** that:

1. **Binds storage** Reproducing the replica from the clear sector and secret key takes ≥ `t_recreate_replica` seconds (§ 6).
2. **Hides data** The replica is computationally indistinguishable from uniform given only public parameters and the miner’s address.

Adversary capabilities: unbounded offline pre‑computation, full control of public parameters, but cannot learn the miner’s VRF secret key `sk`.

### 3.1 Symbol Glossary (dial profile “S‑512”)

| Symbol   | Type / default | Definition                                |
| -------- | -------------- | ----------------------------------------- |
| `S`      | 32 GiB         | Sector size (benchmark)                   |
| `row_i`  | `u32`          | `BLAKE2s-32(sector_id‖sector_digest) mod rows`, where `sector_id = BLAKE2s-256(miner_addr‖sector_number)` |
| `salt`   | `[u8;32]`      | `vrf(sk, row_i)`                          |
| `chunk`  | `[u32;k]`      | Radix‑*k* NTT buffer (*k = 64*)           |
| `pass`   | `0 … r−1`      | Permutation round (*r = 3*)               |
| `ζ_pass` | `u32`          | Round offset (data‑dependent)             |
| `λ`      | 280            | Gaussian σ (noise compression, fixed‑point ×100) |
| `γ`      | 0              | MiB interleave fragment size              |

### 3.2 Pre‑Processing – Argon2 “Drizzle”

If `H = 0` → skip.
Else perform `H` in‑place passes of **Argon2id** on the sector:

```
argon2id(
    pwd   = sector_bytes,          // streaming mode
    salt  = salt,                  // 32 B
    mem   = ⌈S / 1 MiB⌉  Kib,
    iters = 1,
    lanes = 4,
    paral = 2
)
```

Each 1 MiB Argon2 block XORs back into its original offset.  This yields a *memory‑hard* whitening keyed by the miner.

### 3.3 Radix‑k Transform Loop

Let `N_chunks = S / (2·k)` little‑endian 16‑bit chunks.

For `pass = 0 … r−1` (baseline `r = 3`):

1. **Chunk iteration order** – determined by the **data‑dependent PRP permutation** (3.4).

2. **NTT pipeline**

   ```
   NTT_k(chunk)                    // forward DIF
   // Derive per‑pass salt limbs (deterministic, domain‑separated)
   salt_k = SHAKE128("DERIVE_SALT_EXP" ‖ salt ‖ u8(pass))[0 .. 4k) as k little‑endian u32 limbs mod Q
   for j in 0..k-1:
       chunk[j] = chunk[j] + salt_k[j]   mod Q
   INTT_k(chunk)                   // inverse DIT, scaled k⁻¹
   ```
**Rationale:** Salt is added in the frequency domain (after the NTT) to ensure its influence is uniformly diffused across all output limbs following the inverse transform, rather than being localized.

3. **Interleaved write**

   *If* `γ = 0` → write back to original offset.
   *Else* compute `stride = γ MiB / (2·k)` and write chunk to
   `offset = (logical_index ⋅ stride) mod N_chunks`.

#### 3.3.1 Micro‑Seal Derive (window‑scoped, normative for PoDE)

Purpose: Provide a deterministic, beacon‑salted local transform on a `W`‑byte window (default `W = 8 MiB`) that can be recomputed directly from **plaintext** during PoDE; it MUST be domain‑separated from full sealing and MUST NOT require a sealed replica.

Definition:

```
Derive(clear_window, beacon_salt, row_id):
  1) Partition clear_window into k‑limb chunks (k per dial profile; baseline k = 64).
  2) For pass = 0..r−1:
        NTT_k(chunk);
        salt_k = SHAKE128("DERIVE_SALT_EXP" ‖ beacon_salt ‖ u8(pass) ‖ u32_le(row_id))[0 .. 4k) as k little‑endian u32 limbs mod Q;
        for j in 0..k−1: chunk[j] = (chunk[j] + salt_k[j]) mod Q;
        INTT_k(chunk);
  3) Output:
        leaf64 := first 64 bytes of the window post‑transform;
        Δ_W := Blake2s‑256(window post‑transform).
```

Constraints:
- `salt_k` MUST be domain‑separated from full‑replica sealing salts (§ 3.3).
- No cross‑window state is permitted; `Derive` is local to the window bytes.
- Implementations MUST provide KATs in Annex B for `Derive`.
**Domain separation (normative):** For PoUD/PoDE usage, salt derivation MUST include `epoch_id` and `du_id` in addition to `beacon_salt` and `row_id`, to prevent cross‑deal replay of derived windows within the same epoch.

### 3.4 Data‑Dependent Permutation (normative)

#### 3.4.1 Permutation map (PRP) — normative

Index chunks by linear index `i ∈ [0, N_chunks)`. The PRP MUST be a **20‑round Feistel network** keyed by `ζ_p` over the domain `M = N_chunks`. Because `S = 2^n` and chunk size is fixed, `N_chunks` is a power of two; thus `M` is exact and **no cycle‑walk is performed**. Round function:

```
Derive the round key `K_round` (using the full 256-bit ζ_p, see § 3.4.2):

F(round, halfword, ζ_p) :=
    BLAKE2s-256(
        msg = u32_le(halfword),
        key = K_round
    )[0..4) as little‑endian u32, then masked to half‑width
```

Operate on `w = ceil_log2(M)` bits split into equal halves; mask outputs to the half‑width each round. Let `Feistel_M(x)` be the 20‑round Feistel permutation on `[0, M)`.


#### 3.4.2 Round‑offset ζ<sub>pass</sub>

For `p = 0`, define:

After finishing pass `p−1`, compute a digest of the entire pass's data that is sensitive to chunk order.

`ChunkHashes_{p-1} = [Blake2s‑256(chunk_0^{p-1}), Blake2s‑256(chunk_1^{p-1}), ...]`
`ChunkDigest_{p-1} = IteratedHash(ChunkHashes_{p-1})`


**Normative (Data Integrity):** `ChunkHashes_{p−1}` MUST commit to the exact byte sequence of pass `p−1`; the method of obtaining those bytes (disk, cache, or RAM) is implementation‑defined and outside consensus.

 


 

**Canonical sector identifier:** Replace filesystem `path` in all salts and indices with a canonical `sector_id = Blake2s-256(miner_addr ‖ sector_number)` to prevent miner‑chosen paths from influencing ζ derivation.



**Rationale:** Using an IteratedHash ensures that `ChunkDigest` depends on the precise ordering of all chunks and enforces strict sequential computation.

Round `p` traverses chunks in the order determined by the PRP defined in § 3.4.1 using the computed `ζ_p`.

*Security intuition* – ζ<sub>p</sub> is **unknowable** until all writes of
pass `p−1` complete, enforcing sequential work (§ 7.4.1).

#### 3.4.3 Micro‑seal profile (derivation mode, normative dial)

Dial `micro_seal` controls localized sealing for derivation challenges. When `micro_seal = off` (baseline S‑512), the permutation and ζ‑derivation operate over the entire sector as specified in § 3.4.1–§ 3.4.2.

When `micro_seal = row` (optional profile for PoDE enablement), the sealing transform is localized per 2 MiB row tile:

- Domain separation: All Blake2s invocations used to derive PRP keys and ζ include the row index `i` as an explicit little‑endian field.
- PRP scope: The Feistel permutation in § 3.4.1 is applied over the set of chunk indices belonging to row `i` only; no cycle‑walk is introduced.

This dial is intended solely to enable fast, row‑local derivations required by § 4.2.2 without altering baseline S‑512 behavior. Profiles enabling `micro_seal = row` MUST publish Annex A/B KATs showing identical digest roots to baseline for `micro_seal = off` when § 4 is not in linking/derivation mode.

### 3.5 Gaussian Noise Compression

For every 2 KiB window **W** (post‑transform):

```
σ_Q_100 = ⌊100 · Q / √12⌋             // std‑dev of uniform limb (fixed‑point approximation)
W' = Quantize( W + N(0, (λ·σ_Q_100 / 10000)²) )
```

*Quantize* rounds to the nearest valid limb mod `Q`. Noise MUST be generated by a deterministic, constant‑time sampler (e.g., Knuth‑Yao or fixed‑point Ziggurat) using only integer arithmetic to ensure cross‑platform consensus.
**Normative (RNG Secrecy):** The sampler inputs MUST include the miner-secret `salt` to prevent reversibility by adversaries with knowledge of the original data.
**Integer‑only & UB‑free:** Implementations MUST use two’s‑complement integers with fixed widths, no floating point, no signed overflow (use widening 64‑bit intermediates), and no implementation‑defined shifts.
**Constant‑time:** Samplers MUST NOT branch on secret values and MUST consume the full stream (masking) even if rejection occurs.
**Normative (Quantize tie‑break):** When rounding halfway cases, implementations MUST use ties‑to‑even on the integer preimage before reduction mod `Q` to avoid platform drift. Provide a reference integer pseudocode and KATs to ensure cross‑platform agreement.
**Sampler conformance (Normative):** Implementations MUST use a table‑driven constant‑time method (alias‑table, Knuth–Yao, or fixed‑point Ziggurat) with precomputed CDF tables baked into KATs. Include KATs for: (i) first 4 CTR blocks of the XOF stream per `(row,window,pass)`; (ii) histogram χ² bounds over 2²⁰ samples; (iii) end‑to‑end determinism across big‑endian/little‑endian targets.



### 3.7 Delta‑Row Accumulator

During compression the encoder computes a digest for each 2 MiB row. For row *i* (two windows):

```
Δ_row[i] = Blake2s-256( W_{2i} ‖ W_{2i+1} )
```


### 3.7.1 Origin Map (row→DU binding, normative)

For each row `i` the encoder MUST record an `OriginEntry`:

```
OriginEntry := { row_id = i, du_id, sliver_index, symbol_range, C_root }
```

where `C_root` is the DU KZG commitment recorded at deal creation and
`symbol_range` encodes the contiguous 1 KiB RS symbols from the sliver that occupy row `i`.
All `OriginEntry` objects MUST be Poseidon‑Merkleized into `origin_root`.

from `origin_root` for the challenged row (see § 4.2.1).

### 3.8 Reference Encoder (pseudocode)

```rust
fn seal_sector(path, sector_bytes, miner_sk, params) {
    let sector_digest = blake2s256(sector_bytes);
    let sector_id = blake2s256(miner_addr || sector_number);
    let row_i = blake2s32(sector_id || sector_digest) % rows;
    let salt  = vrf(miner_sk, row_i);                 // 32 B

    argon2_drizzle_if(params.H, sector_bytes, salt);

    for pass in 0..params.r {
        let ζ = compute_offset(pass, salt, sector_bytes);
        for (idx, chunk) in iter_chunks(params.k, ζ, sector_bytes) {
            ntt_k(chunk);
            add_salt(chunk, &salt, params.Q);
            intt_k(chunk);
            interleave_write(chunk, idx, params.γ, sector_bytes);
        }
    }
    gaussian_compress(sector_bytes, params.λ, params.Q);
    build_merkle_and_rowcommit(sector_bytes, salt, path);
}
```

### 3.9 Dial Guardrails (normative limits)

| Dial | Range         | Complexity effect | Guard‑rail                            |
| ---- | ------------- | ----------------- | ------------------------------------- |
| `k`  | 64 → 256      | CPU ∝ k log k     | `k ≤ 256` fits L3 cache               |
| `r`  | 2 → 5         | Time ∝ r          | Seal time ≤ 2× network median         |
| `λ`  | 280 → 500     | Disk ↑            | λ > 400 requires compression‑ratio vote |
| `m`  | 1 024 → 2 048 | CPU ∝ m²          | Proof size constant                   |
| `H`  | 0 → 2         | DRAM × H          | H ≤ 2                                 |
| `γ`  | 0 → 4 MiB     | Seeks ↑           | γ > 0 needs HDD‑impact vote           |

Profiles violating a guard‑rail are **invalid** until approved by governance (§ 6).

---

### 3.10 Performance Targets (baseline hardware, informative)

| Task                   | 4× SATA SSD | 8‑core 2025 CPU |
| ---------------------- | ----------- | --------------- |
| Seal 32 GiB            | ≤ 8 min     | ≤ 20 min        |
| Re‑seal from last leaf | ≤ 1 min     | ≤ 3 min         |

---

### 3.11 Security References

Detailed proofs for sequential‑work and indistinguishability appear in § 7.4.

---



---

 


### Research‑only Domain Tags and IDs (moved from Core)
The following tags/IDs are **removed from Core** and live here for archival use:
- `"P2Δ"`, `"POSS2-MIX"`, `"POLYSTORE_SEAL_PRP"`, `"POLYSTORE_SEAL_ZETA"`, `"POLYSTORE_SEAL_ITER_INIT"`, `"POLYSTORE_SEAL_ITER_STEP"`, `"POLYSTORE_SEAL_NOISE"`, `"NILHASH-RANGE"`
- DomainID `0x0100` (nilseal row Merkle roots)
