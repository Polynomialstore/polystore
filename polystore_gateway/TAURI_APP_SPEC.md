# PolyStore Gateway GUI (Tauri) — Build Specification (Codex-Executable)

**Version:** 0.3.0  
**Date:** 2026-01-16  
**Status:** Draft (Executable plan; unblock autonomous implementation)

This document is written to be **unambiguous enough that a Codex agent can implement it end-to-end**, including **thorough testing** and **CI**, without needing out-of-band “tribal knowledge”.

## 0. Goals, Non‑Goals, and Definition of Done

### 0.1 Goals
- Provide a **desktop GUI** for PolyStore’s devnet workflows using **Tauri**.
- Ship a **self-contained app** that runs a local gateway sidecar and supports:
  - Deal creation (EVM intent + wallet signature)
  - File ingest/upload into the PolyFS striped slab
  - Commit content (EVM intent + wallet signature)
  - Browse deal state, list files, fetch/download, and view proof/receipt status
- Keep UX **“no private key import”**: user ownership is via an external wallet signature flow; the app holds **only a relayer/provider key** for gas sponsorship / proof submission.
 
### 0.2 Non‑Goals (explicit)
- Building a general-purpose “PolyStore Chain desktop wallet”.
- Full replacement of the existing web app (`polystore-website`).
- Production-grade key custody / HSM integration (devnet-grade custody is acceptable; mainnet hardening is a separate spec).
 
### 0.3 Definition of Done (DoD)
The project is “done” when all items below are true:
1. A new Tauri app exists at `polystore_gateway_gui/` and runs on macOS/Linux/Windows.
2. The app bundles (or deterministically provisions) a **local `polystore_gateway` sidecar** and can:
   - show gateway status
   - create a deal via `/gateway/create-deal-evm`
   - upload a file via `/gateway/upload`
   - commit content via `/gateway/update-deal-content-evm`
   - list files via `/gateway/list-files/{manifest_root}`
   - download via `/gateway/fetch/{manifest_root}`
3. Wallet signing works in desktop context (no `window.ethereum` dependency).
4. There are:
   - unit tests (frontend + Rust host)
   - integration tests (host ↔ sidecar, using an in-repo stub or real sidecar in test mode)
   - at least one “happy path” E2E test (mocked chain acceptable for CI; real chain can be nightly)
5. CI runs all relevant checks on every push and blocks merges on failure.
 
## 1. Context and Current Reality (Repo Truth)

### 1.1 Existing Gateway Surface
`polystore_gateway` (Go) already exposes:
- `/health`, `/status`
- `/gateway/create-deal-evm`, `/gateway/update-deal-content-evm`
- `/gateway/upload`, `/gateway/list-files/{cid}`, `/gateway/fetch/{cid}`
 
The GUI must treat `{cid}` as a **legacy alias** for the deal-level **`manifest_root`** (48-byte commitment); it is not a per-file CID.
 
Canonical behavior for these endpoints is documented in `polystore_gateway/polystore-gateway-spec.md`.
 
### 1.2 Existing Cryptography / Striped Ingest
Striped ingest paths already use `polystorechain/x/crypto_ffi` (Go ↔ Rust FFI). The GUI plan assumes **the striped path is the primary supported flow**.
 
## 2. Target Architecture (Monolithic Sidecar + GUI)

### 2.1 Components
1. **Frontend (UI)** — React + TypeScript + Vite + Tailwind.
2. **Host (Tauri Rust)** — owns process lifecycle, filesystem permissions, and IPC.
3. **Sidecar (`polystore_gateway`)** — Go HTTP server running on loopback; configured by the host via env/args.
 
### 2.2 Security Boundary (Important)
- The frontend must not talk directly to `http://127.0.0.1:<port>` (origin/CORS confusion).  
  Instead: Frontend → `tauri::invoke` → Host → Sidecar.
- Only the host knows the sidecar port and performs all HTTP calls.
 
### 2.3 Key Roles
- **User key (external wallet):** signs EVM/EIP-712 intents; never stored locally by the app.
- **Relayer/provider key (local):** used for gas sponsorship and/or provider proof submission (devnet-grade custody).

### 2.4 Sidecar Bundling & Dependency Strategy (Release Requirements)
The GUI must run without requiring the user to install build tools or CLI binaries.

**Supported implementation strategy (choose one and document it in `polystore_gateway_gui/README.md`):**
1. **Bundle required binaries (recommended MVP):**
   - Bundle a `polystore_gateway` sidecar binary per platform.
   - Bundle any runtime assets and binaries the sidecar needs (at minimum `trusted_setup.txt`; possibly a `polystorechaind` client binary if `polystore_gateway` still shells out).
   - The host sets `POLYSTORE_TRUSTED_SETUP`, `POLYSTORECHAIND_BIN`, and other paths to bundle-resident locations.
2. **Eliminate external exec dependencies (target hardening):**
   - Remove `execPolystorechaind` usage from `polystore_gateway` by broadcasting/querying via Cosmos SDK libraries or LCD/gRPC clients.
   - Ensure striped ingest does not require `polystore_cli` subprocesses (prefer `crypto_ffi`, which already exists for RS + KZG primitives).

The plan below assumes Strategy (1) first, then Strategy (2) as a follow-up hardening phase.
 
## 3. Wallet Integration (Desktop-Compatible)

### 3.1 Required Capability
The app must obtain an **EVM signature** for an intent payload and pass it to:
- `POST /gateway/create-deal-evm`
- `POST /gateway/update-deal-content-evm`
 
### 3.2 Supported Wallet Path (Default)
**WalletConnect v2** (recommended default for desktop):
- Works in a Tauri webview.
- Supports typed data signing (`eth_signTypedData_v4`) when the wallet supports it.
 
### 3.3 Fallback Wallet Path (Secondary)
Browser-based “Authorization Bridge” page opened in the system browser to use MetaMask extension, then returns the signature via `http://127.0.0.1:<bridge_port>/callback`.
 
The implementation must choose **WalletConnect** as the default and treat the bridge as optional.
 
## 4. Signing Spec (Normative, No Guessing)

### 4.1 EIP-712 Domain
The domain is defined in `polystorechain/x/polystorechain/types/eip712.go`:
- `name`: `"PolyStore"`
- `version`: `"1"`
- `chainId`: **numeric** `Params.eip712_chain_id` (default devnet: `31337`)
- `verifyingContract`: `"0x0000000000000000000000000000000000000000"`
 
### 4.2 Typed Data: Create Deal
Type name: `CreateDeal`  
Field order (must match `CreateDealTypeHash` in `eip712.go`):
1. `creator` (address)
2. `duration` (uint64)
3. `service_hint` (string)
4. `initial_escrow` (string)
5. `max_monthly_spend` (string)
6. `nonce` (uint64)
 
### 4.3 Typed Data: Update Content
Type name: `UpdateContent`  
Field order (must match `UpdateContentTypeHash` in `eip712.go`):
1. `creator` (address)
2. `deal_id` (uint64)
3. `cid` (string) — legacy alias for `manifest_root` hex string
4. `size` (uint64)
5. `total_mdus` (uint64)
6. `witness_mdus` (uint64)
7. `nonce` (uint64)
 
### 4.4 Payload Shape Sent to `polystore_gateway`
`polystore_gateway` expects JSON:
```json
{
  "intent": { "...": "..." },
  "evm_signature": "0x..."
}
```
Where `intent` uses the on-chain JSON field names (see `polystorechain/proto/polystorechain/polystorechain/v1/tx.proto` and validation in `polystore_gateway/main.go`).
 
**Implementation rule:** Add golden tests that ensure typed-data encoding produces signatures accepted by chain tests (see `polystorechain/x/polystorechain/keeper/msg_server_evmbdg_test.go`).
 
## 5. UX Flows (What the App Must Do)

### 5.1 First Run
1. Create app data directories.
2. Start sidecar.
3. Create or load relayer/provider identity (local key).
4. Show “Gateway is running” and “Wallet disconnected”.
 
### 5.2 Create Deal (User-Owned)
1. User connects wallet (WalletConnect).
2. App determines EIP712 chain id (query via LCD params or configured default).
3. App constructs `CreateDeal` intent and requests wallet signature.
4. App calls `POST /gateway/create-deal-evm`.
5. App displays `deal_id` and tx hash; it polls inclusion status (LCD) or surfaces a link.
 
### 5.3 Upload + Commit Content
1. User selects a `deal_id`.
2. User chooses a PolyFS `file_path` and local file to upload.
3. App calls `POST /gateway/upload` (multipart) with `deal_id`, `owner`, `file_path`.
4. Sidecar responds with `cid` (= new manifest root), `size_bytes`, `total_mdus`, `witness_mdus`.
5. App constructs `UpdateContent` intent and requests wallet signature.
6. App calls `POST /gateway/update-deal-content-evm`.
7. App refreshes deal state and file list.
 
### 5.4 Browse + Download
1. App lists files via `GET /gateway/list-files/{manifest_root}?deal_id=...&owner=...`.
2. Download uses `GET /gateway/fetch/{manifest_root}?deal_id=...&owner=...&file_path=...` and streams to a user-selected output path.
3. App records a local “download receipt” row even if proof submission is devnet-shortcutted (for UX and debugging).
 
## 6. Technical Design (Files, Modules, Commands)

### 6.1 Repo Layout (Normative)
Create a new project at:
```text
polystore_gateway_gui/
  package.json
  src/
    app/
    components/
    hooks/
    lib/
  src-tauri/
    Cargo.toml
    tauri.conf.json
    src/
      main.rs
      sidecar.rs
      api.rs
  tests/
    e2e/
```
 
### 6.2 Tauri Commands (IPC Contract)
The host must implement these commands (names are normative):
- `gateway_start(config)` → `{ base_url, pid }`
- `gateway_stop()` → `ok`
- `gateway_status()` → typed status from `/status`
- `deal_create_evm({ intent, signature })` → `{ deal_id, tx_hash }`
- `deal_update_content_evm({ intent, signature })` → `{ tx_hash }`
- `deal_upload_file({ deal_id, owner, file_path, local_path })` → `{ manifest_root, size_bytes, total_mdus, witness_mdus }`
- `deal_list_files({ deal_id, owner, manifest_root })` → `{ files: [...] }`
- `deal_fetch_file({ deal_id, owner, manifest_root, file_path, output_path })` → `ok`
 
The host must emit events for progress:
- `gateway_log` (streamed stdout/stderr lines)
- `upload_progress` (bytes, phase string)
- `tx_progress` (submitted → included → failed)
 
### 6.3 Sidecar Startup Contract
The sidecar must support:
- deterministic configuration via env vars (preferred) and/or flags
- binding to loopback only
 
**Required engineering change (if not already present):** allow binding to an ephemeral port and reporting the actual bound address to the host. Options:
1) `--listen-addr 127.0.0.1:0` and print `LISTENING_ADDR=127.0.0.1:<port>` on stdout  
or  
2) write a JSON status file path passed by `--status-file <path>`
 
The GUI implementation must include an integration test that starts the sidecar without relying on a fixed port.

### 6.4 App Config and Sidecar Env Mapping
The GUI must maintain a single config file (JSON) in the OS app data directory, e.g.:
- macOS: `~/Library/Application Support/PolyStore Gateway GUI/config.json`
- Linux: `~/.config/com.polynomialstore.gatewaygui/config.json`
- Windows: `%APPDATA%\\PolyStore Gateway GUI\\config.json`

Normative config keys (names may differ on disk, but the meaning must match):
- `chain.chain_id` (default `test-1`)
- `chain.lcd_base` (default `http://localhost:1317`)
- `chain.node_rpc` (default `tcp://127.0.0.1:26657` if needed by gateway)
- `chain.gas_prices` (default `0.001aatom` as used by gateway today)
- `gateway.provider_base` (default `http://localhost:8080` for standalone local SP mode)
- `storage.upload_dir` (default app data dir + `/uploads`)
- `wallet.mode` (`walletconnect` | `bridge`)

The host must map config to sidecar env vars consistently:
- `POLYSTORE_UPLOAD_DIR` ← `storage.upload_dir`
- `POLYSTORE_LCD_BASE` ← `chain.lcd_base`
- `POLYSTORE_CHAIN_ID` ← `chain.chain_id`
- `POLYSTORE_GAS_PRICES` ← `chain.gas_prices`
- `POLYSTORE_NODE` ← `chain.node_rpc`
- `POLYSTORE_PROVIDER_BASE` ← `gateway.provider_base`
- `POLYSTORE_TRUSTED_SETUP` ← bundle-resident `trusted_setup.txt` path (Strategy 1)
- `POLYSTORECHAIND_BIN` ← bundle-resident `polystorechaind` path (Strategy 1, only if still used)
 
## 7. Testing Plan (Thorough, CI-Friendly)

### 7.1 Frontend Unit Tests
- Framework: `vitest` + `@testing-library/react`
- Focus:
  - typed data construction for intents (golden fixtures)
  - UI state transitions for upload/commit/download
  - error surfaces (invalid owner, stale manifest root, missing deal id)
 
### 7.2 Rust Host Unit/Integration Tests
- Use `cargo test` for:
  - sidecar lifecycle manager (start/stop, crash restart)
  - HTTP client wrapper and error mapping
  - file IO (safe path handling, output permissions)
 
### 7.3 Sidecar Integration Tests
Two tiers:
1) **Mock sidecar**: a tiny HTTP server in Rust tests that mimics `/status`, `/gateway/*` for deterministic CI.
2) **Real sidecar smoke**: build `polystore_gateway` and start it in a “test mode” (no chain required), verifying `/health` and `/status`.
 
### 7.4 E2E Tests
Minimum:
- Headless UI E2E (Playwright) running against the **web UI** with a mocked host bridge (recommended for CI).
 
Optional/nightly:
- Full-stack E2E that starts `polystorechaind` + `polystore_gateway` + the GUI and runs a real create-deal/upload/commit/list/fetch lifecycle (can reuse/adapt `polystore_gateway/test_lifecycle.sh`).
 
## 8. CI / Build / Release

### 8.1 CI (on every push)
Update `.github/workflows/ci.yml` to add a job that:
- installs Node 20 and Rust stable
- runs `npm ci`, `npm run lint`, `npm run test`, `npm run build` in `polystore_gateway_gui/`
- runs `cargo fmt --check` and `cargo clippy -- -D warnings` in `polystore_gateway_gui/src-tauri/`
- (optional) builds `polystore_gateway` for smoke tests used by host integration tests
 
### 8.2 Release Builds (tagged)
Add `.github/workflows/tauri_release.yml` that:
- uses `tauri-apps/tauri-action` to build installers for `macos-latest`, `windows-latest`, `ubuntu-latest`
- uploads artifacts to GitHub Releases
 
## 9. Step-by-Step Roadmap (Codex Task Graph)

Each phase is small-commit friendly and includes a test gate.
 
### Phase 0 — Scaffold + CI Skeleton
- [ ] Create `polystore_gateway_gui/` via a Tauri + React + TS + Vite scaffold.
- [ ] Add Tailwind and a basic layout shell (sidebar + main view).
- [ ] Add a CI job that runs UI + Rust checks.
- **Test gate:** `cd polystore_gateway_gui && npm test && npm run build` and `cd src-tauri && cargo test`.
 
### Phase 1 — Sidecar Lifecycle + Status UI
- [ ] Implement Rust sidecar manager and `gateway_start/gateway_stop/gateway_status`.
- [ ] Implement log streaming into a “Logs” panel.
- [ ] Implement status dashboard cards (reachable dependencies from `/status`).
- **Test gate:** Rust integration test starts a mock sidecar and reads `/status`.
 
### Phase 2 — WalletConnect + EIP-712 Golden Tests
- [ ] Add WalletConnect flow and persist session.
- [ ] Implement typed-data builders for `CreateDeal` and `UpdateContent`.
- [ ] Add golden tests that compare typed data JSON against fixtures derived from chain tests.
- **Test gate:** `npm test` passes and fixtures are stable.
 
### Phase 3 — Create Deal (EVM intent → gateway)
- [ ] UI form for create deal → signature request → submit.
- [ ] Display tx hash + deal id; add polling for inclusion (or surface LCD link).
- **Test gate:** mocked-sidecar E2E test verifies correct payload.
 
### Phase 4 — Upload + Commit Content
- [ ] File picker + PolyFS path entry.
- [ ] Upload progress UI driven by host events.
- [ ] Commit intent builder uses upload response (`cid`, `size_bytes`, `total_mdus`, `witness_mdus`).
- **Test gate:** integration tests for upload encoding and commit payload.
 
### Phase 5 — Browse + Download
- [ ] List files view using `/gateway/list-files`.
- [ ] Download button streams to chosen output path.
- [ ] Basic “receipt/proof status” UI row (devnet: informational is OK).
- **Test gate:** E2E test downloads a mocked file and verifies checksum.
 
### Phase 6 — Real Sidecar Smoke (Optional but recommended)
- [ ] Add a “dev smoke” script that builds `polystore_gateway` and runs GUI against it.
- [ ] Add nightly CI job for full stack if feasible.

### Phase 7 — Dependency-Free Sidecar (Hardening)
- [ ] Remove `execPolystorechaind` usage from `polystore_gateway` (broadcast/query via libraries).
- [ ] Ensure all ingest/commit paths used by the GUI do not shell out to `polystore_cli`.
- [ ] Update GUI bundling to only include the `polystore_gateway` sidecar and required static assets.
- **Test gate:** all previous tests still pass; add a “no external exec” unit test that fails if `POLYSTORECHAIND_BIN`/`POLYSTORE_CLI_BIN` is required.
 
## 10. Open Questions (Need Your Clarifications)

These are not blockers; defaults are stated. Please confirm/correct.
 
1. **App name + bundle id**: Default `PolyStore Gateway GUI` / `com.polynomialstore.gatewaygui`.
2. **Wallet choice**: Default WalletConnect v2 only; is browser-bridge required?
3. **Relayer key custody**: Default store in OS keychain when possible; fall back to a local file in app data.
4. **Chain params source**: Default read `eip712_chain_id` from LCD params; fall back to `31337`.
5. **Sidecar port strategy**: Default ephemeral port with host discovery; OK to require an engineering change in `polystore_gateway`?
6. **Target OS support**: Default macOS + Linux first; Windows supported in CI but may lag for local dev.
7. **Proof/receipt UX**: Should downloads auto-submit receipts/proofs (devnet convenience) or only display “ready to sign” payloads?
8. **Bundling approach**: Should we bundle a `polystorechaind` client binary for MVP, or should Phase 7 (dependency-free) be required before shipping a GUI?
