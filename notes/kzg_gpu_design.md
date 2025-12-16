# RFC: Hybrid CPU / WebGPU Architecture for Browser-Side KZG Commitment & Proof Generation

**Date:** December 2025
**Status:** Design / Implementation Guide
**Audience:** Systems + Crypto Engineers
**Scope:** Browser execution (WASM + WebGPU)

---

## 0. Executive Summary

This document specifies a **hybrid CPU/WASM + WebGPU architecture** for **high-throughput KZG commitment and proof generation in the browser**, targeting sustained upload saturation (>100 Mbps) for large file ingestion (128KB chunks ≈ 4096 field elements).

The core insight is that **only the Multi-Scalar Multiplication (MSM)** portion of KZG benefits materially from GPU acceleration. All other logic remains simpler, safer, and more maintainable on the CPU.

> **Design principle:**
> **“Dumb GPU, Smart CPU.”**
> The GPU performs massive parallel point accumulation; the CPU owns all protocol logic, windowing, reductions, and correctness.

This avoids a fragile “full GPU prover” while still capturing most of the performance upside.

---

## 1. Architectural Overview

### 1.1 What runs where

| Component                     | Location         | Rationale                        |
| ----------------------------- | ---------------- | -------------------------------- |
| Byte → Fr decoding            | CPU (WASM)       | Control-heavy, already optimized |
| FFT / IFFT (4096)             | CPU (WASM)       | Fast enough; complex on GPU      |
| Transcript / Fiat–Shamir      | CPU (WASM)       | Branching + hashing              |
| **MSM (commitments, proofs)** | **GPU (WebGPU)** | Massive parallelism              |
| Final Pippenger reduction     | CPU (WASM)       | Small cost, simpler              |
| Serialization / upload        | CPU              | I/O-bound                        |

The GPU is treated as a **stateless accelerator** behind a single boundary:

```text
msm_g1(srs_handle, scalars_batch) -> g1_points
```

The KZG pipeline does not know (or care) whether MSM is CPU or GPU backed.

---

## 2. Pipeline Model (Per Batch)

### High-level flow

1. **CPU Pre-Process**

   * Parse bytes → Fr scalars
   * IFFT into coefficient form
   * Perform Pippenger *windowing* (bit slicing)
   * Emit bucket indices

2. **GPU Accumulation**

   * Add SRS points into buckets (parallel)
   * No reductions, no control flow

3. **CPU Finalization**

   * Read back bucket sums
   * Perform final Pippenger reduction
   * Emit commitment / proof

### Why this split works

* GPU excels at *“add these points to piles”*
* CPU excels at *“decide which piles exist and how they’re combined”*
* This avoids atomic-heavy GPU reductions and keeps shaders simple and fast

---

## 3. MSM Strategy: Hybrid Bucket Method

### 3.1 CPU responsibilities (“the brain”)

* Choose window size `c` (e.g. 13–16 bits)
* Split each 256-bit scalar into `K` windows
* Generate a flat buffer of **bucket indices**

  ```text
  “Add SRS point i to bucket j”
  ```
* Schedule batches and overlap CPU/GPU work

### 3.2 GPU responsibilities (“the muscle”)

* Given:

  * SRS points (read-only)
  * Bucket indices
  * Bucket accumulators (read/write)
* Perform **point addition only**
* No scalar arithmetic
* No window logic
* No final reductions

### 3.3 CPU final reduction

* Buckets count ≈ `2^c` (e.g. ~65k)
* Final reduction cost is tiny vs MSM
* Keeps correctness logic in trusted libraries

---

## 4. Technology Stack

### 4.1 Language & runtime

* **Rust → WASM (`wasm32-unknown-unknown`)**
* `wasm-bindgen` for JS interop
* Web Workers for CPU parallelism

### 4.2 GPU interface

* **`wgpu` crate**

  * Abstracts WebGPU (Metal / Vulkan / DX12)
  * Safer than raw JS bindings
  * Browser-compatible

### 4.3 CPU cryptography

Recommended:

* `grandinetech/rust-kzg`

  * Pure Rust (WASM-friendly)
  * Already implements Ethereum Blob KZG
  * Parallel-ready
* (Alternative: `c-kzg-4844` if you already use it)

### 4.4 GPU math source

* **ICME-Lab/msm-webgpu**

  * ZPrize-derived WGSL
  * Contains *critical* big-integer math
  * **Not a library** — a source of shader code

> You are assembling a system, not importing a crate.

---

## 5. SRS Handling

### 5.1 Integrity & caching

* SRS is public but **must be integrity-pinned**
* On first load:

  * Download
  * Verify hash
  * Store in IndexedDB

### 5.2 GPU residency

* Upload SRS to GPU **once per session**
* Store in `STORAGE | COPY_DST` buffer
* Reuse across all batches

### 5.3 Representation

* Store SRS in **affine coordinates**
* Convert to projective inside shader if needed
* Prefer mixed-addition paths

---

## 6. WebGPU Shader Design

### 6.1 Shader scope (intentionally narrow)

* Field arithmetic (`Fp`, 256-bit limbs)
* Curve point addition (BLS12-381 G1)
* Bucket accumulation

Nothing else.

### 6.2 Collision handling

Bucket collisions are the hardest part.

**Recommended approach:**

* Accept collisions
* Accumulate partial sums
* Resolve final reduction on CPU

Avoid complex atomic-heavy GPU reductions early.

### 6.3 Watchdog constraints

* Browser kills shaders running >~2s
* Keep dispatches small (<100ms)
* Prefer multiple passes over giant kernels

---

## 7. Memory Layout & Data Movement

### 7.1 Scalars

* Layout: `batch × 4096 × limbs`
* Upload once per batch
* Avoid per-chunk uploads

### 7.2 Buckets

* GPU writes bucket accumulators
* CPU reads back **once per batch**
* No ping-pong per window

### 7.3 Zero-copy discipline

* Allocate WASM buffers once
* Reuse across calls
* Avoid JS↔WASM Vec reallocations (GC risk)

---

## 8. Batching & Scheduling

### 8.1 Why batching matters

At `n = 4096`, GPU wins only when overhead is amortized.

### 8.2 Recommended policy

* Batch until:

  * `batch_size >= B` (e.g. 8–64), **or**
  * `latency_budget` hit (e.g. 20ms)

### 8.3 Overlap

* CPU:

  * decode + IFFT for batch `N+1`
* GPU:

  * MSM for batch `N`

Never idle either side.

---

## 9. Fallback & Feature Detection

* Detect `navigator.gpu`
* Detect buffer limits
* If unsupported or error:

  * Disable GPU backend
  * Fall back to pure WASM

**Correctness must never depend on GPU availability.**

---

## 10. Correctness & Testing Strategy

### 10.1 Golden reference

* CPU MSM is canonical
* GPU results must match group equality

### 10.2 Tests

* Field ops vs arkworks
* Point ops vs CPU
* MSM small-n exhaustive tests
* Randomized full-n tests
* End-to-end chunk commitments

### 10.3 Failure policy

On mismatch:

* Disable GPU backend for session
* Log device + shader info
* Continue on CPU

---

## 11. Development Milestones

1. **wgpu in browser** (vector add shader)
2. **Field add/mul correctness**
3. **G1 point add correctness**
4. **Bucket accumulation pipeline**
5. **Batch MSM wins vs CPU**
6. **Proof MSM integration**
7. **Production fallback hardening**

---

## 12. The Reality Check (Important)

There is **no**:

* `kzg-webgpu`
* `bls381-gpu-wasm`
* drop-in browser prover

What you build is a **Frankenstein stack**:

| Role           | Component             |
| -------------- | --------------------- |
| Infrastructure | `wgpu`                |
| Protocol brain | `rust-kzg`            |
| Raw math       | ICME-Lab WGSL shaders |

This is normal. The ecosystem simply isn’t packaged yet.

---

## 13. Final Takeaway

You do **not** need a full GPU prover.

You need:

* a **correct CPU pipeline**
* a **narrow, brutal GPU MSM**
* smart batching
* ruthless fallback discipline

That gets you **most of the speedup** with **minimal protocol risk**.
