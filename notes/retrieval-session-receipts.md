# Retrieval Sessions & Bundled Receipts (Sprint 2)

**Status:** Implemented (Devnet)  
**Goal:** Reduce wallet prompts and on-chain TX count by moving from “sign per chunk” to “sign once per download session”, while improving auditability (range binding) and operability (batch submission, durable sessions).

---

## 1. What changes (high level)

### Today (chunk-receipt)
- Browser signs **a RetrievalRequest** per chunk/range fetch.
- Gateway serves one blob-range and returns `(proof_details, proof_hash, fetch_session)`.
- Browser signs **a RetrievalReceipt** per chunk.
- Provider submits **one MsgProveLiveness per chunk**.

### Now (session-receipt + batch)
- Browser signs **one RetrievalRequest** to open a *download session* for `{deal_id, file_path, total_range_start, total_range_len}`.
- Browser fetches many chunks **without additional wallet signatures** using the session.
- Browser signs **one DownloadSessionReceipt** at the end, committing to:
  - `{deal_id, epoch_id, provider, file_path, total_bytes, chunk_count, chunk_leaf_root, nonce, expires_at}`
- Gateway/provider submits **one MsgProveLiveness** that carries:
  - the session receipt + signature
  - the per-chunk proofs (triple proof) + Merkle membership paths to `chunk_leaf_root`

This reduces wallet prompts from `O(chunks)` to ~2 per download (open session + finalize receipt), and reduces on-chain tx count to 1 per download (or per batch).

---

## 2. New cryptographic commitments

### 2.1 Per-chunk leaf hash

Each downloaded chunk (a single “proved blob-range”) defines a **leaf commitment**:

```
proof_hash  := keccak256(encode(ChainedProof))
leaf_hash   := keccak256(
  uint64_be(range_start) ||
  uint64_be(range_len)   ||
  proof_hash
)
```

This binds:
- **what** was proven (`proof_hash` → exact `proof_details`)
- **how much** was served (`range_len`)
- **where** in the file it applies (`range_start`)

### 2.2 Chunk root

`chunk_leaf_root` is the Merkle root over `leaf_hash[i]`, ordered by increasing `(range_start, range_len)` (canonical for a session).

Tree rule (deterministic):
- If a layer has odd length, duplicate the last leaf.
- Internal node hash: `keccak256(left || right)`.

---

## 3. Nonce scope redesign

Replace:
- `LastReceiptNonce[owner]` (global per-owner)

With:
- `LastReceiptNonce[(deal_id, file_path)]` (strictly increasing)

Rationale:
- Allows parallel downloads across different files within a deal (no nonce races).
- Makes retries cleaner (scoped to the thing being downloaded).

---

## 4. On-chain range binding (receipt-level)

We extend the on-chain receipt semantics so the chain can store and reason about ranges:
- Per-chunk: `(file_path, range_start, range_len)` is bound via `leaf_hash`.
- Session-level: `(file_path, total_bytes, chunk_count)` is bound via the signed session receipt.

The chain still cannot independently map ranges → `(mdu_index, blob_index)` without NilFS metadata, but it can:
- validate `range_len == bytes_served` for accounting,
- prevent receipt inflation by requiring chunk membership in the signed `chunk_leaf_root`,
- expose exact byte-range evidence for audits and dashboards.

---

## 5. Batch submission

Two batching layers:

1) **Session proof batching (primary)**  
One on-chain message includes `DownloadSessionReceipt + N chunk proofs`.

2) **Legacy receipt batching (secondary / compatibility)**  
Provider accepts an array of `{fetch_session, receipt}` and submits one message carrying repeated `RetrievalReceipt` items.

---

## 6. Chain ID correctness (devnet-safe)

Hardcoded `31337` is replaced with a module parameter `eip712_chain_id`:
- Default genesis value remains **31337** (MetaMask localhost default).
- Chain-side EIP-712 verification always uses the parameter value.

---

## 7. Gateway/provider durability + hardening

### 7.1 Durable session store
- Persist download sessions and replay caches to a small KV store (BoltDB).
- Restart-safe:
  - in-flight sessions can still be finalized (receipt submission won’t brick on restart),
  - request/session replays remain prevented.

### 7.2 Gateway → Provider forwarding + auth
- `/gateway/receipt` becomes a true forwarder to `/sp/receipt`.
- Provider requires a shared secret header (devnet) to accept forwarded receipts.
- Add negative tests:
  - wrong provider,
  - wrong proof hash / mismatched session,
  - replayed/consumed session.
