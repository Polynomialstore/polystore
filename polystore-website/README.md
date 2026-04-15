# PolyStore Website & Explorer

The official frontend for the PolyStore Network. This application serves as the marketing landing page, documentation hub, and interactive block explorer for the Incentivized Testnet ("Store Wars").

## Features

*   **Interactive Simulations:**
    *   **Security:** "The Bankruptcy Model" visualizes how the network economically punishes lazy providers.
    *   **Economy:** Agent-based simulation of token supply, inflation, and slashing events.
*   **Documentation:** Renders Markdown versions of the Whitepaper and Litepaper using `@tailwindcss/typography`.
*   **Lattice Map:** Visualizes real-time proof submissions on the local testnet.
*   **Deep Dives:** Interactive explanations of Sharding, KZG Commitments, and the Performance Market.

## Tech Stack

*   **Framework:** React (Vite)
*   **Language:** TypeScript
*   **Styling:** Tailwind CSS
*   **Animations:** Framer Motion
*   **Icons:** Lucide React

## SDK: Batch Retrieval Precompile

PolyStore exposes an EVM precompile at `0x0000000000000000000000000000000000000900`. For downloads that span multiple providers, use the batch methods (avoid log parsing and reduce MetaMask prompts):

- `computeRetrievalSessionIds(sessions[])` (`eth_call`) → `(providers[], sessionIds[])`
- `openRetrievalSessions(sessions[])` (`eth_sendTransaction`)
- `confirmRetrievalSessions(sessionIds[])` (`eth_sendTransaction`)

TypeScript ABI + helper encoders/decoders live at `src/lib/polystorePrecompile.ts`.

## Development

### Setup
```bash
npm install
```

### Run Locally
```bash
npm run dev
```
The site will launch at `http://localhost:5173`.
When `public/wasm/polystore_core.js` and `public/wasm/polystore_core_bg.wasm` are already present, `npm run dev`
reuses that bundle for fast startup. Force a fresh WASM rebuild with `POLYSTORE_FORCE_WASM_BUILD=1 npm run dev`.
The website-served paper copies in `public/` are synced from the repo-root `whitepaper.md` and `litepaper.md` via `npm run sync:papers`.

### Build for Production
```bash
npm run build
```
Output is generated in the `dist/` directory.

## Deployment

This project is configured for a Cloudflare static-assets Worker via `wrangler.jsonc`.

- Worker name: `polystore`
- Git repository: `Polynomialstore/polystore`
- Project root: `polystore-website`
- Production branch: `main`
- Build command: `npm ci && npm run ci:build`
- Asset output directory: `dist`
- Canonical custom domain: `polynomialstore.com`

The frontend runtime treats `polynomialstore.com` as the canonical public domain and uses that apex to infer `faucet/lcd/evm` service subdomains for production deployments.
