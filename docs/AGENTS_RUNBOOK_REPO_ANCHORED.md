# AGENTS Runbook (Repo-Anchored): nilcoin2 / PolyStore

Last updated: 2026-02-05

This file is the repo-specific companion to `docs/AGENTS_AUTONOMOUS_RUNBOOK.md`.
It maps the runbook phases to real directories, files, and existing test gates in this repository.

## Canonical docs (this repo)

- Protocol spec (normative): `spec.md`
- Gap matrix (spec ↔ code ↔ CI): `docs/GAP_REPORT_REPO_ANCHORED.md`
- Trusted devnet tracker (PR-by-PR): `AGENTS_TRUSTED_DEVNET_SOFT_LAUNCH_TODO.md`
- “How to run locally” onboarding:
  - `DOCS.md`
  - `HAPPY_PATH.md`
  - `docs/TESTNET_READINESS_REPORT.md`
- Trusted devnet ops + onboarding:
  - `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`
  - `docs/REMOTE_SP_JOIN_QUICKSTART.md`
  - `docs/TRUSTED_DEVNET_MONITORING_CHECKLIST.md`
  - `docs/manual-devnet-runbook.md`
- Economy narrative (non-normative): `ECONOMY.md`
- RFCs: `rfcs/`
- Mainnet parity trackers (longer-horizon reference):
  - `MAINNET_GAP_TRACKER.md`
  - `MAINNET_ECON_PARITY_CHECKLIST.md`
  - `AGENTS_MAINNET_PARITY.md`
- Autonomous agent materials:
  - `docs/AGENTS_AUTONOMOUS_RUNBOOK.md`
  - `docs/AGENT_PROMPT_AUTONOMOUS.md`

## Code map (where things live)

### Chain (Cosmos SDK app)

- Protos:
  - `polystorechain/proto/polystorechain/polystorechain/v1/types.proto` (Deal + types)
  - `polystorechain/proto/polystorechain/polystorechain/v1/tx.proto` (Msgs)
  - `polystorechain/proto/polystorechain/polystorechain/v1/params.proto` (Params)
- Msg handlers:
  - `polystorechain/x/polystorechain/keeper/msg_server.go`
    - `CreateDeal` / `CreateDealFromEvm`
    - `UpdateDealContent` / `UpdateDealContentFromEvm`
    - `OpenRetrievalSession` / `ConfirmRetrievalSession` / `CancelRetrievalSession`
    - `ProveLiveness` (unified liveness, includes striped repairing-slot rules)
- Quotas / unified liveness:
  - `polystorechain/x/polystorechain/keeper/unified_liveness.go`
  - `polystorechain/x/polystorechain/keeper/slashing.go` (quota miss -> repair triggers, evidence summaries)
- EVM bridge helpers:
  - `polystorechain/x/polystorechain/types/evm_bridge.go`

### Gateway + Provider data-plane

In this repo, provider byte-serving endpoints are implemented in `polystore_gateway/` (no separate `nil-provider/` dir).

- HTTP router + handlers:
  - `polystore_gateway/main.go`
    - `GatewayFetch` (user-facing download path; **requires** `X-PolyStore-Session-Id` by default via `POLYSTORE_REQUIRE_ONCHAIN_SESSION=1`)
    - `SpFetchShard` (provider shard fetch; validates on-chain session + striped slot/range constraints when sessions are required)
    - dev-only tx relay flows (`POLYSTORE_ENABLE_TX_RELAY=0` by default; CI lifecycle scripts enable it explicitly)
  - `polystore_gateway/router_proxy.go` (gateway proxy/router for provider requests)
  - `polystore_gateway/p2p_server.go` (P2P requests; forwards `X-PolyStore-Session-Id` when present)

### Web UI

- Main UX:
  - `polystore-website/src/components/Dashboard.tsx` (create deal, faucet UX, upload/commit, retrieval flows)
  - `polystore-website/src/hooks/useFaucet.ts` (browser-triggered faucet calls; should be dev-only in wallet-first mode)
  - `polystore-website/src/hooks/useTransportRouter.ts` (adds `X-PolyStore-Session-Id` when downloading)
  - `polystore-website/src/lib/e2eWallet.ts` (Playwright: injects an in-page “wallet” when `VITE_E2E=1`)
- Web contract doc:
  - `polystore-website/website-spec.md`

## Existing test/run gates (use these as the phase “test gates”)

### Local stack

- Multi-provider devnet:
  - `./scripts/run_devnet_alpha_multi_sp.sh start`
  - `./scripts/run_devnet_alpha_multi_sp.sh stop`
- Single-node stack:
  - `./scripts/run_local_stack.sh`
  - Safety note: `run_local_stack.sh start` always re-initializes the chain home. Default home is `_artifacts/polystorechain_data`. If you set `POLYSTORE_HOME` outside `_artifacts/`, wiping requires `POLYSTORE_REINIT_HOME=1`.

### E2E scripts

- Multi-SP gateway retrieval regression:
  - `./scripts/ci_e2e_gateway_retrieval_multi_sp.sh`
  - `./scripts/e2e_gateway_retrieval_multi_sp.sh`
- Lifecycle:
  - `./scripts/e2e_lifecycle.sh`
  - `./scripts/e2e_lifecycle_no_gateway.sh`
- Retrieval fees + sessions (CLI):
  - `./e2e_retrieval_fees.sh`
  - `./e2e_open_retrieval_session_cli.sh`
  - `./e2e_open_retrieval_session_mode2_cli.sh`
- Striped retrieval + repair:
  - `./scripts/e2e_mode2_stripe_multi_sp.sh`
  - `./scripts/e2e_deputy_ghost_repair_multi_sp.sh`

### Unit tests

- Chain:
  - `go test ./polystorechain/...`
- Gateway:
  - `go test ./polystore_gateway/...`
- Rust crates:
  - `cd polystore_core && cargo test`
  - `cd polystore_cli && cargo test`
  - `cd polystore_p2p && cargo test`
  - `cd polystore_mock_l1 && cargo test`
- Website:
  - `npm -C polystore-website run test:unit`
  - `npm -C polystore-website run build`
  - `npm -C polystore-website run lint`
- Tauri GUI:
  - `npm -C polystore_gateway_gui test`
  - `npm -C polystore_gateway_gui run build`
  - `cd polystore_gateway_gui/src-tauri && cargo test`
- Foundry contracts:
  - `cd polystore_bridge && forge test -vv`

## CI truth (GitHub Actions)

The authoritative source of “what CI runs” is `.github/workflows/ci.yml`.

At a high level, CI exercises:
- Go unit tests: `polystorechain`, `polystore_faucet`, `polystore_gateway`, `polystore_relayer`
- Rust unit tests: `polystore_core`, `polystore_cli`, `polystore_p2p`, `polystore_mock_l1`
- Frontend: build + unit tests + lint (`polystore-website`)
- Tauri GUI: build + unit tests + clippy (`polystore_gateway_gui`)
- Native/WASM parity: `polystore_core` wasm-pack build + `tools/parity/compare_parity.ts`
- Local-stack E2E: lifecycle (with and without a local gateway), retrieval fees, and retrieval sessions (legacy full-replica compatibility + striped path)
- Browser E2E (Playwright): gateway-absent, libp2p-relay, striped retrieval (12 SPs)
- Multi-SP regression: `scripts/ci_e2e_gateway_retrieval_multi_sp.sh`
- Solidity: `forge test` under `polystore_bridge`

## Phase mapping (repo-specific)

The authoritative per-requirement status is `docs/GAP_REPORT_REPO_ANCHORED.md`.
This section is a quick index of the phases in `docs/AGENTS_AUTONOMOUS_RUNBOOK.md`.

### Phase 0 — Repo anchoring + docs sync (DONE)

Primary artifacts:
- `docs/AGENTS_RUNBOOK_REPO_ANCHORED.md`
- `docs/GAP_REPORT_REPO_ANCHORED.md`
- `docs/TESTNET_READINESS_REPORT.md`
- `AGENTS_TRUSTED_DEVNET_SOFT_LAUNCH_TODO.md`

### Phase 1 — Deal expiry + renewal (ExtendDeal) (DONE)

CI signals:
- Unit tests: `cd polystorechain && go test ./...` (see extend tests under `polystorechain/x/polystorechain/keeper/*extend*`)
- E2E: `scripts/e2e_lifecycle.sh`

### Phase 2 — Mandatory retrieval sessions for all served bytes (DONE)

CI signals:
- Unit tests: chain + gateway (`go test` suites above)
- E2E: `e2e_open_retrieval_session_cli.sh`, `e2e_open_retrieval_session_mode2_cli.sh`

### Phase 3 — Retrieval policies + sponsored/public sessions (DONE)

CI signals:
- Unit tests: allowlist + vouchers under `polystorechain/x/polystorechain/keeper/*sponsored*`
- E2E: covered by lifecycle + retrieval-session scripts

### Phase 4 — Protocol retrieval hooks (audit/repair) + audit budget (DONE)

CI signals:
- Unit tests: protocol sessions + audit budget under `polystorechain/x/polystorechain/keeper/*protocol*` and `*audit*`

### Phase 5 — Compression-aware content pipeline (PolyCE v1) (PARTIAL)

CI signals:
- Unit tests only: `go test ./polystore_gateway/...` (PolyCE helpers)

Not proven:
- PolyCE-enabled end-to-end upload/fetch semantics are not required by CI E2E (and are opt-in via `POLYSTORE_POLYCE=1`).

### Phase 6 — Wallet-first UX (DONE)

CI signals:
- Playwright suites: `scripts/e2e_browser_smoke_no_gateway.sh`, `scripts/e2e_browser_libp2p_relay.sh`

### Phase 7 — Economics (rewards, draining, retrieval fees, dynamic pricing) (DONE)

CI signals:
- Unit tests: chain keeper suites
- E2E: `e2e_retrieval_fees.sh`

Notes:
- Dynamic pricing is implemented and unit-tested, but is **disabled by default** and is not exercised by long-running devnet evidence.

### Phase 8 — Testnet readiness + trusted devnet soft launch pack (DONE as docs/scripts; ops exercise pending)

Primary artifacts:
- `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md` (hub + collaborator onboarding)
- `docs/REMOTE_SP_JOIN_QUICKSTART.md` (remote provider join)
- `docs/TRUSTED_DEVNET_MONITORING_CHECKLIST.md` + `scripts/devnet_healthcheck.sh` (ops checks)

Not proven:
- WAN/multi-host behavior (latency, TLS/firewalls, NAT) and long-running durability are not proven by CI.
