# RFC: Content-Encoding (Compression) for NilFS Files (Draft)

**Status:** Draft (pre‑alpha)  
**Last updated:** 2026-01-23  
**Scope:** Client/WASM (`nil_core`), Gateway ingest (`nil_gateway`), download UX, and provider storage format (bytes only)  
**Hard constraints respected:** does not modify escrow settlement; no oracles; deterministic on-chain.

---

## 1. Motivation

NilStore charges for storage and retrieval as a function of stored bytes (ciphertext) and blob counts. If clients upload highly-compressible plaintext **without** compressing before encryption, they pay more than necessary and (depending on SP storage stacks) may inadvertently enable storage “data reduction arbitrage”.

We want:
- a **default-on** compression pipeline for compressible inputs,
- a minimal, forward-compatible way to record content-encoding metadata,
- and a retrieval path that transparently returns the original bytes to the user.

Key constraint: **encryption destroys compressibility**. Therefore compression MUST occur **before** encryption.

---

## 2. Goals and non-goals

### Goals
1) Strongly encourage compressible data to be compressed **before being shared with SPs**.
2) Store compression metadata in-band in a way that:
   - works for both gateway and browser/WASM ingestion,
   - remains compatible with NilFS,
   - does not require new on-chain state.
3) Ensure the user receives the original bytes on download (decompress after decrypt).
4) Ensure economics charge on **stored bytes** (compressed+encrypted), not on uncompressed logical bytes.

### Non-goals
- Perfect cross-runtime byte-identical compression outputs (nice-to-have). Commitments bind to the resulting ciphertext bytes; this is not a consensus issue.
- Support for many codecs in v1. Start with a small enum.

---

## 3. Normative pipeline

### 3.1 Upload pipeline (normative)

For each file payload (plaintext):

1) **(Optional) Compress plaintext**
2) **Wrap** with a small header that declares the encoding and original size.
3) **Encrypt** client-side (FMK-derived key) over the wrapped bytes.
4) Chunk into MDUs/blobs, compute commitments, upload ciphertext bytes.

### 3.2 Download pipeline (normative)

1) Retrieve ciphertext bytes (session-gated).
2) Verify proofs against `Deal.manifest_root`.
3) Decrypt to recover wrapped bytes.
4) Parse header and:
   - if `encoding == NONE`: return payload bytes,
   - else decompress and return original plaintext bytes.

---

## 4. Encoding header format (v1)

To avoid NilFS schema churn, we store encoding metadata **inside the file bytes** as a fixed header, then encrypt the entire wrapped content.

### 4.1 Byte layout

All fields are little-endian.

```
struct NilCEv1 {
  magic[4]            = 0x4E 0x49 0x4C 0x43   // "NILC"
  version_u8          = 1
  encoding_u8         // ContentEncoding enum (see below)
  flags_u16           // reserved, must be 0
  uncompressed_len_u64
  payload[]           // either raw plaintext (NONE) or compressed bytes
}
```

### 4.2 ContentEncoding enum (v1)

- `0 = NONE`
- `1 = ZSTD`  (fixed parameters; see §5)

Future versions may add Brotli/LZ4/etc by bumping the header version.

---

## 5. Compression parameters (ZSTD v1)

To keep behavior consistent across implementations:

- ZSTD compression level: **3** (fast default)
- No dictionary (dictionary support is v2+ only)
- Window size: library default (acceptable for v1), but implementations SHOULD pin an upper bound to avoid pathological memory use.

**Safety requirements (normative):**
- Clients MUST cap `uncompressed_len_u64` to a protocol maximum per file (e.g., deal hard cap or UI cap).
- Decompressors MUST enforce:
  - output length equals `uncompressed_len_u64`,
  - and abort if decompression would exceed a memory/CPU budget (zip-bomb protection).

---

## 6. “Strongly encourage” policy (client behavior)

This RFC recommends a default client behavior:

- Compression is **enabled by default**.
- The client MAY decide not to compress if the benefit is below a threshold.

Suggested heuristic (non-normative):
- sample first 256 KiB of the file,
- try zstd level 3,
- if savings < 5% (500 bps), store as `NONE`.

The UI should clearly show:
- “Estimated savings”,
- and allow opting out.

---

## 7. Economics: how charging maps to compression (normative)

- `Deal.size_bytes` and `total_mdus` reflect the **ciphertext byte size** of the wrapped content.
- Storage lock-in pricing applies to stored ciphertext bytes.
- Retrieval session variable fees apply to blob counts required to serve the stored ciphertext bytes.

Therefore:
- users pay less when their content compresses well,
- SPs cannot “get lucky” via transparent compression of ciphertext (ciphertext is not compressible).

---

## 8. Compatibility notes

- This header is inside the encrypted payload; SPs remain oblivious.
- NilFS path semantics are unchanged.
- Partial-range reads remain valid; clients that download a subrange MUST ensure they include the header region to interpret encoding.  
  (UI should avoid “start from middle” downloads unless it also fetches the header blob(s).)

---

## 9. Acceptance tests (DoD)

1) Upload a compressible file with compression on → stored byte size decreases; download returns original bytes exactly.
2) Upload a non-compressible file → encoding NONE; download identical.
3) Corrupt header → download path fails with a clear error.
4) Zip-bomb defense: malformed compressed payload triggers safe abort.

