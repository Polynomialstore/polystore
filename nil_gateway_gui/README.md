# Nil Gateway GUI (Local Sidecar)

`nil_gateway_gui` is the desktop sidecar for browser users on trusted devnet. It runs a local NilStore gateway on `http://localhost:8080` so the website can use local routing/cache flows without relying on a hosted relay gateway.

## Download

- Releases: `https://github.com/Nil-Store/nil-store/releases`
- CI release workflow: `.github/workflows/tauri_release.yml`

## User Quick Start

1. Download and install the latest GUI build for your OS from GitHub Releases.
2. Start Nil Gateway GUI.
3. Verify local health:
   - `curl -sf http://localhost:8080/health`
4. Open `https://nilstore.org/#/dashboard`.
   - The top-right gateway indicator should show connected.

## Build From Source

```bash
cd nil_gateway_gui
npm ci
npm run tauri build
```

## Notes

- The website sidecar model expects gateway access through localhost.
- Storage provider public endpoints (`sp1/sp2/sp3...`) remain separate and are discovered from on-chain provider records.
