# PoS²‑L Scaffold — Research Supplement v1
**Status:** RESEARCH‑ONLY • NOT FOR MAINNET • DISABLED IN ALL PROFILES  
**File:** `rfcs/archive/pos2l/PoS2L_scaffold_v1.updated.md`  
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

**Note:** These brakes were originally described in older metaspec drafts; the current canonical constraints live in `spec.md` (§5, Appendix B). This file remains a self-contained research runbook snapshot.

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
