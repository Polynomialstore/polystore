# Nil Gateway GUI (Local Gateway)

`nil_gateway_gui` is the desktop local Gateway app for browser users on trusted devnet. It runs a local NilStore **user-gateway** on `http://localhost:8080` so the website can use local routing/cache flows without relying on a hosted relay gateway.

## Download

- Releases: `https://github.com/Nil-Store/nil-store/releases/latest`
- CI release workflow: `.github/workflows/tauri_release.yml`
- Release tags use semver and trigger desktop builds automatically:
  - `nil-gateway-gui-vMAJOR.MINOR.PATCH` (example: `nil-gateway-gui-v0.2.0`)

## User Quick Start

1. Download and install the latest GUI build for your OS from GitHub Releases.
2. Start Nil Gateway GUI (it auto-checks localhost and auto-starts the local Gateway if needed).
3. Verify local health:
   - `curl -sf http://localhost:8080/health`
4. Open `https://nilstore.org/#/dashboard`.
   - The dashboard gateway indicator should show local Gateway connected.

## Local Gateway UX Notes

- Default base URL is `http://127.0.0.1:8080` (website-compatible localhost flow).
- The GUI shows live logs from the embedded local Gateway process.
- The GUI shows a local storage snapshot (cached deals/files/bytes) from the sidecar uploads directory.
- Main actions manage the local Gateway lifecycle (`Connect`, `Start gateway`, `Stop`), with API smoke actions behind **Advanced (experimental)**.

## Build From Source

Linux prerequisites (Ubuntu/Debian):

```bash
sudo apt-get update
sudo apt-get install -y \
  pkg-config \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libsoup-3.0-dev \
  libjavascriptcoregtk-4.1-dev \
  librsvg2-dev
```

```bash
cd nil_gateway_gui
npm ci
npm run tauri build
```

`npm run tauri build` runs `scripts/build_sidecars.mjs`, which builds/stages:
- `nil_gateway`
- `nil_cli`
- `nil_core` shared library (`.so`/`.dylib`/`.dll`)
- `trusted_setup.txt`

On Linux and macOS, the sidecar build stamps a runtime library search path
(`$ORIGIN` / `@loader_path`) into `nil_gateway` so it can find `libnil_core`
next to the binary without manual `LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`.

## Local Development Commands

From `nil_gateway_gui/`:

- `npm run desktop` or `npm run desktop:user`
  - Stops externally managed user-gateway on `:8080`, then launches Tauri so the GUI owns the local `user-gateway`.
- `npm run desktop:with-sp`
  - Ensures local SP daemons are running, then launches GUI-managed desktop mode.
- `npm run sp:ensure` / `npm run sp:stop`
  - Start/stop only provider-daemon processes for local dev.
- `npm run user:ensure` / `npm run user:stop`
  - Start/stop only externally managed user-gateway process on `:8080`.

From repo root (`nil-store/`):

- `./scripts/ensure_stack.sh`
  - Brings up the local dev stack (chain + faucet + providers + user-gateway + optional web) with health checks.
  - This is for local stack orchestration and E2E-style workflows, not GUI-managed ownership mode.

## Notes

- Runtime persona contract reference: `docs/runtime-personas.md` (authoritative naming/ownership for `user-gateway` and `provider-daemon`).
- The website local Gateway model expects gateway access through localhost.
- Storage provider public endpoints (`sp1/sp2/sp3...`) remain separate and are discovered from on-chain provider records.
- Linux GUI default sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` when not explicitly provided.
- Local sidecar default sets `NIL_P2P_ENABLED=0` and `NIL_DISABLE_SYSTEM_LIVENESS=1` (with local import enabled).
