# Retrieval v2 cryptographic verification

This is the internal verifier for the [v2 session contract](retrieval-v2-session-profile.md).
It preserves public `ChainedProof` encoding, authorization, whole-list gas and
once-only settlement. Deployment activation remains disabled pending provider/client
adoption and integrated qualification. Proof acceptance establishes the challenged
algebraic statement; it does not independently establish fresh byte delivery.

## Authenticated setup and input boundaries

The native loader and WASM constructor authenticate the **entire** approved setup:
SHA-256 `d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7`.
The 807177-byte file includes 4096 Lagrange G1 points, 65 G2 points and the
4096-point monomial trailer. The required domain/basis and nondegenerate points
are checked. A later initialization request rechecks its supplied file/bytes;
an existing singleton cannot make a missing or substituted setup succeed.
Validator `start` and `in-place-testnet` fail on initialization errors. Read-only
CLI commands do not require setup. Chain, browser and demos use this same digest.
The repository marks `trusted_setup.txt` as `-text` so Git preserves the approved
bytes even with `core.autocrlf=true`; verification never normalizes received bytes.

Received blobs use `commit_received_blob`: exactly 131072 bytes, with all 4096
big-endian scalar encodings strictly below Fr. Only then does the existing
commitment implementation run. This avoids silently reducing received raw bytes.
Packed payloads separately require a zero reserved byte and deterministic padding,
including the producer's right-aligned final partial scalar. Root-table cells
are full canonical reduced digest values and do not use the payload rule.
The WASM length boundary rejects nonintegers, negative, nonfinite and oversized
values before conversion. The legacy raw FAT requires the #257 versioned migration.

Consumers must compare the recomputed full blob commitment with the authenticated
commitment before decoding/acknowledging bytes. Matching a public-z evaluation is
insufficient. Canonical zero and constant blobs remain valid.

## One bounded synchronous call

Go authenticates the stored C2 context, frozen payee, fixed anchor, full ordered
range and every expected z; it validates every shape and prepays **500000 gas per
proof** before entering native code. All admitted v2 lists, including singleton
lists, use `polystore_verify_polyfs_session_batch_v1` once. Legacy sessions retain
the corrected independent primitives. Retry/admission rejection performs no batch
call. An invalid opening rejects the complete batch before pinning or settlement.

PSB1 is a transport for a **complete ordered single session**, not a second public
proof schema. The C2 ordinal is the list index. A supplied C2 hash does not confer
authorization; callers must authenticate the full context and seed themselves.
There is no support for arbitrary audit subsets, partial or cross-session lists.

All integers are unsigned big endian. Fixed header (106 bytes):

```text
"PSB1" || N:u16 || leaf_count:u32 || PolyFS_root:32 || C2_hash:32 || seed:32
```

Each record has 304 fixed bytes followed immediately by its two paths:

```text
MDU_index:u64 || blob_index:u32 || MDU_root:32
root_DU_commitment:48 || root_opening:48 || blob_commitment:48
z:32 || y:32 || blob_opening:48 || root_siblings:u16 || blob_siblings:u16
root_path:(32*root_siblings) || blob_path:(32*blob_siblings)
```

Both boundaries enforce `1 <= N <= 64`, `1 <= leaf_count <= 16384`,
`1 <= MDU_index <= 65536`, fixed field lengths and at most **60522 bytes**.
Native parsing requires exactly six root siblings and the exact index-dependent
blob path (at most 14), with odd-node promotion and no trailing bytes. Public
Mode 2 session caps can be smaller: K8 permits eight blobs per slot/MDU; K2 permits
32. A core 64-proof test is not a public K8 session.

Native code independently derives each expected z from C2 hash/seed/ordinal/tuple,
checks both Merkle memberships, derives root-table DU/cell/z/reduced-y, and parses
canonical scalar and compressed subgroup-valid point encodings. It retains no
caller pointers. Scratch is bounded by the admitted list and path sizes.

## Equation and transcript

Flatten each admitted proof into root-table then blob opening, giving `m = 2N`.
For opening `(C_i,z_i,y_i,P_i)`, use independently derived nonzero weights `r_i`:

```text
A = sum(r_i*C_i) + sum((r_i*z_i)*P_i) - sum(r_i*y_i)*G
B = sum(r_i*P_i)
accept iff e(A,H) * e(-B,T) == 1
```

Here G is the approved G1 generator, H = setup.G2[0], T = setup.G2[1]. Two MSMs,
one generator multiplication and a two-term Miller loop with one final
exponentiation implement the equation. Only the two fixed prepared G2 points are
cached. Every MSM has an exact dimension check and a bounded deterministic window;
browser producer tuning cannot change verifier resource use. Independent verification
of 2N openings instead uses 4N pairing terms.

`LP(x) = U32BE(byte_length(x)) || x`; ASCII domains have no NUL. After all statement
and membership checks, construct the entire transcript:

```text
LP("polystore/kzg-batch/v1") || setup_digest:32 || U32BE(4096)
LP("bls12-381/fr-be/polyfs-natural-order") || N:u16 || 2N:u16
C2_hash:32 || seed:32 || PolyFS_root:32
for each proof:
  list_index:u16 || ordinal:u64 || MDU_index:u64 || blob_index:u32
  leaf_count:u32 || MDU_root:32 || derived_root_DU:u16 || derived_cell:u16
  for role in [root=0, blob=1]:
    role:u8 || C:48 || z:32 || y:32 || P:48
```

Set `h = SHA256(transcript)`. For each global opening index `i`, try `j=0..255`:

```text
candidate = SHA256(LP("polystore/kzg-batch-coefficient/v1") || h || i:u16 || j:u16)
```

Accept the big-endian candidate only when `1 <= candidate < Fr`; do not reduce or
mask it. Exhaustion rejects. Coefficients follow the complete response transcript;
they are distinct from the future-anchor challenge fixed before the response.
Merkle siblings are omitted from this transcript because strict membership already
binds their authenticated roots, indices and commitments.

For a fixed invalid subgroup-valid batch, independent uniform nonzero weights
give false acceptance probability at most `1/(Fr-1)`. Deterministic Fiat-Shamir
derivation relies on random-oracle/hash assumptions; adaptive whole-transcript
attempts accumulate this bound, with hash collisions an additional consideration.
This is not unconditional soundness. The aggregation equation agrees with
[Ethereum Deneb v1.4.0](https://github.com/ethereum/consensus-specs/blob/v1.4.0/specs/deneb/polynomial-commitments.md#verify_kzg_proof_batch);
PolyStore's independent weights and transcript differ from Ethereum's powers of
one challenge. An unweighted sum is invalid: opposing residuals can cancel.

## Maintained evidence

- `polystore_core/tests/testdata/check_session_batch_vectors.py` independently
  reconstructs the exact transcript and 16 coefficients from the committed
  eight-proof input, including rejection counters and high-index root coordinates.
  It checks Merkle/scalar/transport semantics; it does not duplicate pairing code.
- `kzg_external_vectors_test.rs` uses pinned external Ethereum known answers,
  with explicit natural-order conversion and original source hashes.
- Rust tests retain nonconstant, cancellation, malformed, subgroup, zero/constant,
  exact-path, context and finite-rejection checks. C2 derives from the existing
  independent Go/Python golden contexts, including uint64 values above JS precision.
- `TestRetrievalV2BatchFirstMiddleLastFailure` exercises actual eight-proof keeper
  acceptance, three invalid positions, full prepayment, unchanged failure state
  and cheap retry. Go count coverage at the C call reports exactly four dispatches:
  three failed batches and one accepted batch; OOG/retry add zero.
- `retrievalCrypto.test.ts` runs the real maintained WASM bundle against the same
  challenge/batch vectors and strict setup, scalar, padding and numeric boundaries.
- `scripts/test_validator_setup_startup.py` runs fresh daemon processes; the existing
  retrieval benchmark supplies the valid node/committed-proof smoke.

The [keeper comparison](../performance/retrieval-v2-crypto.md) records repeated
public-profile timings, gas, generation, allocations and reproduction commands;
`polystore_core/examples/verifier_allocations.md` records separate native scratch. There is no dedup cache,
recursive failure isolation, worker scheduler, GPU path or gas discount here.
