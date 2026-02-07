# Nil Gateway GUI (Local Gateway)

`nil_gateway_gui` is the desktop local Gateway app for browser users on trusted devnet. It runs a local NilStore gateway on `http://localhost:8080` so the website can use local routing/cache flows without relying on a hosted relay gateway.

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
- Main actions manage the local Gateway lifecycle (`Connect`, `Start gateway`, `Stop`), with API smoke actions behind **Advanced (experimental)**.

## Build From Source

Linux prerequisites (Ubuntu/Debian):

```bash
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
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

## Notes

- The website local Gateway model expects gateway access through localhost.
- Storage provider public endpoints (`sp1/sp2/sp3...`) remain separate and are discovered from on-chain provider records.
