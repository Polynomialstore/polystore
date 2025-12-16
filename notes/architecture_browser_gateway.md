# Architectural Review: The Browser-Based Gateway ("Thick Client")

**Date:** 2025-12-15
**Context:** Pivoting from a local Go daemon (`nil_gateway`) to a pure browser experience.

## 1. Executive Summary

Moving the Gateway logic into the browser transforms NilStore from a "Tethered" application (requiring a local CLI/Server) to a true "Web3" DApp. This removes the biggest friction point for new users (installing software) but shifts the burden of cryptography, file management, and networking onto the browser runtime.

**Recommendation:** Proceed with this architecture for **"Consumer" use cases** (files < 1GB). Retain the Go Gateway/CLI for "Enterprise" bulk data (TB-scale) where browser memory limits and WASM performance are prohibitive.

---

## 2. Architecture: "The Gateway is a Library"

We are effectively moving the `nil_gateway` logic into a TypeScript/WASM library running inside a Web Worker.

### Current Flow (Thin Client)
`Browser UI` -> `Local HTTP` -> `Go Gateway` -> `Disk/Network`

### New Flow (Thick Client)
`Browser UI` -> `Web Worker (WASM)` -> `OPFS (Virtual Disk)` -> `Remote SPs`

---

## 3. Component Analysis & Gap Analysis

### 3.1 Cryptography & Sharding (The Engine)
*   **Current State:** `nil_core` (Rust) compiled to WASM already exists for basic sharding (`expand_file`).
*   **Challenge:** While the atomic unit is a 128KB blob and processing occurs at the MDU (64MB) level, attempting to load an *entire large file* (e.g., 1GB) into WASM linear memory *at once* can still lead to browser tab crashes or significant performance degradation. Processing must be done incrementally.
*   **Solution:** **Streaming Architecture at the MDU/Blob Level.**
    *   The WASM interface must accept input in chunks (e.g., MDU by MDU) via `ReadableStream` or `ArrayBuffer` batches.
    *   KZG Commitments for each MDU must be computed incrementally (streaming MSM if possible) or MDU by MDU.
    *   This leverages our existing data model (128KB blobs, 64MB MDUs) to break down large files into manageable batches, avoiding monolithic memory loads.
*   **Gap:** Update `nil_core` WASM bindings and JavaScript glue code to explicitly support this MDU/blob-level streaming processing, ensuring efficient memory usage and avoiding OOM errors. Verify performance characteristics under this streaming model.

### 3.2 File System (The Slab)
*   **Current State:** Go code manages `uploads/` directory on the OS filesystem.
*   **Challenge:** Browsers cannot access the OS filesystem directly for security.
*   **Solution:** **Origin Private File System (OPFS)**.
    *   OPFS provides a high-performance, private filesystem for the origin.
    *   It supports random access writes (essential for building MDUs and patching tombstones), which standard IndexedDB does not.
*   **Gap:** Implement `ISlabStore` interface in TypeScript backed by OPFS handles.

### 3.3 Networking (Ingest & Retrieval)
*   **Current State:** Gateway accepts upload, writes to disk, then (conceptually) pushes to providers.
*   **Challenge:** Browser must talk directly to Storage Providers (SPs).
*   **Solution:**
    *   **Transport Interface:** Abstract the transport layer. Start with **HTTP/CORS** (easiest for Devnet) and add **libp2p-js** (WebTransport/WebRTC) later.
    *   **Direct Upload:** SPs must expose a public, CORS-enabled ingest endpoint (e.g., `POST /sp/upload`).
*   **Gap:** SPs currently expect the Go Gateway to define the session. We need a "Put Request" flow where the browser proposes a deal/session directly to the SP.

### 3.4 State Management (Metadata)
*   **Current State:** BoltDB (`sessions.db`) stores retrieval sessions and replay caches.
*   **Solution:** **IndexedDB**.
    *   Use `idb` or `Dexie.js` to store "My Deals", "Active Sessions", and "File Table Caches".
    *   This metadata persists across tab reloads.

---

## 4. Detailed Implementation Roadmap

### Phase 1: WASM Parity (The Core)
*   **Goal:** `nil_core` WASM can do everything the Go Gateway needs to do for a single file.
*   **Tasks:**
    1.  Expose `Mdu0Builder` logic (building the NilFS file table) via WASM. currently this logic is in Go (`nil_gateway/pkg/builder`). **Decision:** Port `Mdu0Builder` to Rust in `nil_core` to share logic between CLI and Browser.
    2.  Implement `StreamingSharder` in WASM (input: stream of bytes, output: stream of blobs/commitments).

### Phase 2: The Virtual Gateway (State & Storage)
*   **Goal:** Browser can "hold" a deal locally.
*   **Tasks:**
    1.  Create `GatewayContext` in React (backed by a Web Worker).
    2.  Implement `OpfsSlabStore`: A TS class that manages `root_cid/mdu_X.bin` files in OPFS.
    3.  Implement `IndexedDbSessionStore`: Persist deal metadata.

### Phase 3: Direct-to-Provider Networking
*   **Goal:** Remove the local proxy.
*   **Tasks:**
    1.  Update `nil_provider` (the SP side) to accept uploads directly from browsers (handle CORS, validate signatures).
    2.  Implement `SpClient` in TypeScript:
        *   `put(file, token) -> success`
        *   `get(session) -> stream`

### Phase 4: Retrieval Verification
*   **Goal:** Trustless reading.
*   **Tasks:**
    1.  Port `VerifyChainedProof` (Triple Proof verification) to WASM (if not already exposed).
    2.  Frontend verifies every chunk downloaded from an SP before rendering.

---

## 5. Hybrid Architecture: The Optional Local Gateway

To combine the ease of use of the browser with the raw power of a local daemon, the architecture supports an **Optional "Sidecar" Gateway**.

### 5.1 Connection & "The Green Dot"
*   **Discovery:** On startup, the browser attempts to handshake with `http://localhost:8080/health` (or configured port).
*   **UX:** A status widget (e.g., a "Green Dot" or "Turbo Mode" icon) indicates if the Local Gateway is active.
*   **Security:** Local Gateway must enable CORS for the specific app origin and potentially require a one-time token (pasted into the UI) to prevent arbitrary websites from probing it.

### 5.2 Compute Delegation (KZG Generation)
The system utilizes a **Strategy Pattern** for cryptographic operations:
*   **IF Connected:** Delegate heavy lifting to the Gateway.
    *   Stream file bytes to `POST /gateway/shard`.
    *   Gateway uses Native Rust/AVX-512 or GPU (Icicle) to generate commitments.
    *   Gateway writes slabs to its own OS filesystem (unlimited storage).
    *   Returns `ManifestRoot` to browser.
*   **ELSE (Pure Browser):** Use WASM in Web Workers.
    *   Process chunks in memory-safe batches.
    *   Write slabs to OPFS.

### 5.3 Unified Data Resolution (Tiered Caching)
To prevent the "Bad Scenario" (paying for data you already have in a different local silo), the client implements a **Tiered Storage Resolver**:

1.  **Tier 1: OPFS (Browser Local)**
    *   *Check:* Does `opfs/blobs/<root>/<mdu>` exist?
    *   *Cost:* Zero.
2.  **Tier 2: Local Gateway (OS Local)**
    *   *Check:* Call `HEAD http://localhost:8080/gateway/slab/<root>`.
    *   *Cost:* Localhost loopback (negligible).
    *   *Action:* If found, stream bytes from Gateway to Browser.
3.  **Tier 3: Network (Storage Providers)**
    *   *Check:* Query Chain/DHT for providers.
    *   *Cost:* Paid retrieval + Network latency.

**Metadata Sync:** Upon connection, the Browser queries the Gateway's inventory (`GET /gateway/deals`) and merges it into the local IndexedDB view. This ensures "Deals I made with the CLI" appear in the Web Dashboard, and "Deals I made in the Browser" can be offloaded to the Gateway if desired.

---

## 6. Feasibility Assessment: libp2p in Browser

You mentioned **libp2p**.
*   **Pros:** True peer-to-peer, hole punching, universal identity.
*   **Cons:** Heavy bundle size, connection setup latency, requires SPs to run WebRTC/WebTransport or WebSocket listeners with valid TLS certificates (browsers block non-TLS WS).
*   **Recommendation:** Keep `libp2p-js` as a **Phase 2 Transport**. Start with **HTTP/2 (REST)**. It is natively supported, performant, and trivial to debug. If SPs run standard HTTPS servers (Nginx/Caddy), the browser can upload efficiently.

## 6. Migration Plan

We should not "rewrite" the Go Gateway in JS. We should **move logic to Rust**, then call it from both Go (via FFI or cgo) and JS (via WASM).

1.  **Stop writing Go logic for core formats.** Move `nil_gateway/pkg/builder` (File Table construction) to `nil_core` (Rust).
2.  **Compile Rust to WASM.**
3.  **Build the TS `NilStoreClient`.**

## 7. Immediate Next Steps (Pure Browser Pilot)

1.  **Refactor `nil_core`:** Implement the "Filesystem Builder" (MDU #0 creation) in Rust.
2.  **Browser POC:** Create a React page that:
    *   Takes a file drop.
    *   Uses WASM to generate the `ManifestRoot` and `MDU #0` bytes.
    *   Stores them in OPFS.
    *   Displays the resulting NilFS structure.
    *   *No networking yet—just proof of data structures.*
