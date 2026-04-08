# PolyStore Network

PolyStore is a verifiable decentralized storage network (Cosmos-SDK chain + user-gateway + provider-daemon + web UI).

This repo is currently geared toward a **trusted devnet soft launch (Feb 2026)**:
- A hub operator runs the chain + user-gateway + faucet + website on a VPS.
- Invite-only collaborators test end-to-end flows (website) and optionally run Storage Provider gateways on WAN hosts.

## Start here (canonical docs)

- Documentation index: `DOCS.md`
- Branding transition note: `docs/branding-transition.md`
- Runtime persona contract (authoritative naming/ownership): `docs/runtime-personas.md`
- Local runbook (fast): `HAPPY_PATH.md`
- Spec ↔ code ↔ CI gap matrix (what CI proves / doesn’t): `docs/GAP_REPORT_REPO_ANCHORED.md`
- Testnet readiness gates + one-command suites: `docs/TESTNET_READINESS_REPORT.md`
- Trusted devnet pack (hub + remote providers): `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`
- Collaborator packet (“send this to testers”): `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`
- Provider endpoint profiles (`direct` vs `cloudflare-tunnel`): `docs/networking/PROVIDER_ENDPOINTS.md`

## Quick start (local, what CI exercises)

End-to-end lifecycle smoke (stack start → create deal → upload → commit → open retrieval session → fetch → stop):

```bash
scripts/e2e_lifecycle.sh
```

Manual stack (keeps processes running until you stop them):

```bash
scripts/run_local_stack.sh start
scripts/run_local_stack.sh stop
```

Browser E2E (Playwright; wallet-first via in-page E2E wallet when `VITE_E2E=1`):

```bash
# Mode 2 (StripeReplica): 12 providers + user-gateway + browser sharding
scripts/e2e_mode2_stripe_multi_sp.sh

# Gateway absent: upload falls back to direct SP paths
scripts/e2e_browser_smoke_no_gateway.sh

# Retrieval uses libp2p relay transport
scripts/e2e_browser_libp2p_relay.sh
```

## Build prerequisites (current CI profile)

- Go `1.25.x` (see `polystorechain/go.mod`, `polystore_gateway/go.mod`, etc.)
- Rust (stable) + `wasm-pack` + `wasm32-unknown-unknown` target
- Node.js `20.x` + npm
- (Optional) Foundry (`forge`) for `polystore_bridge` contract tests

To build the full release bundle locally:

```bash
./release.sh
```

## Components

- `polystorechain` (L1): Cosmos-SDK chain (deals, proofs, economics, retrieval sessions)
- `polystore_core` (Rust): cryptographic primitives (KZG, Merkle, Reed-Solomon), exposed via C-FFI and WASM
- `polystore_cli`: client tooling (sharding / commitment generation)
- `polystore_gateway`: user-gateway and provider-daemon HTTP APIs (retrieval/session enforcement)
- `polystore_faucet`: devnet faucet service (token-auth capable)
- `polystore-website`: web UI (React/Vite) for onboarding + deal flows

## What CI does (and does not) prove

CI is **single-machine** and is a strong regression signal, but it does **not** replace a real WAN rehearsal (NAT/TLS/firewalls, restarts, disk pressure, adversarial behavior, etc.).

For the authoritative breakdown, read:
- `docs/GAP_REPORT_REPO_ANCHORED.md` (requirement → implementation → CI proof → explicit gaps)
- `docs/TESTNET_READINESS_REPORT.md` (runbooks + readiness gates)
