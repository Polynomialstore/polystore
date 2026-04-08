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
  - `nilchain/proto/nilchain/nilchain/v1/types.proto` (Deal + types)
  - `nilchain/proto/nilchain/nilchain/v1/tx.proto` (Msgs)
  - `nilchain/proto/nilchain/nilchain/v1/params.proto` (Params)
- Msg handlers:
  - `nilchain/x/nilchain/keeper/msg_server.go`
    - `CreateDeal` / `CreateDealFromEvm`
    - `UpdateDealContent` / `UpdateDealContentFromEvm`
    - `OpenRetrievalSession` / `ConfirmRetrievalSession` / `CancelRetrievalSession`
    - `ProveLiveness` (unified liveness, includes Mode 2 repairing slot rules)
- Quotas / unified liveness:
  - `nilchain/x/nilchain/keeper/unified_liveness.go`
  - `nilchain/x/nilchain/keeper/slashing.go` (quota miss -> repair triggers, evidence summaries)
- EVM bridge helpers:
  - `nilchain/x/nilchain/types/evm_bridge.go`

### Gateway + Provider data-plane

In this repo, provider byte-serving endpoints are implemented in `nil_gateway/` (no separate `nil-provider/` dir).

- HTTP router + handlers:
  - `nil_gateway/main.go`
    - `GatewayFetch` (user-facing download path; **requires** `X-Nil-Session-Id` by default via `NIL_REQUIRE_ONCHAIN_SESSION=1`)
    - `SpFetchShard` (provider shard fetch; validates on-chain session + Mode2 slot/range constraints when sessions are required)
    - dev-only tx relay flows (`NIL_ENABLE_TX_RELAY=0` by default; CI lifecycle scripts enable it explicitly)
  - `nil_gateway/router_proxy.go` (gateway proxy/router for provider requests)
  - `nil_gateway/p2p_server.go` (P2P requests; forwards `X-Nil-Session-Id` when present)

### Web UI

- Main UX:
  - `polystore-website/src/components/Dashboard.tsx` (create deal, faucet UX, upload/commit, retrieval flows)
  - `polystore-website/src/hooks/useFaucet.ts` (browser-triggered faucet calls; should be dev-only in wallet-first mode)
  - `polystore-website/src/hooks/useTransportRouter.ts` (adds `X-Nil-Session-Id` when downloading)
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
  - Safety note: `run_local_stack.sh start` always re-initializes the chain home. Default home is `_artifacts/nilchain_data`. If you set `NIL_HOME` outside `_artifacts/`, wiping requires `NIL_REINIT_HOME=1`.

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
- Mode 2 + repair:
  - `./scripts/e2e_mode2_stripe_multi_sp.sh`
  - `./scripts/e2e_deputy_ghost_repair_multi_sp.sh`

### Unit tests

- Chain:
  - `go test ./nilchain/...`
- Gateway:
  - `go test ./nil_gateway/...`
- Rust crates:
  - `cd nil_core && cargo test`
  - `cd nil_cli && cargo test`
  - `cd nil_p2p && cargo test`
  - `cd nil_mock_l1 && cargo test`
- Website:
  - `npm -C polystore-website run test:unit`
  - `npm -C polystore-website run build`
  - `npm -C polystore-website run lint`
- Tauri GUI:
  - `npm -C polystore_gateway_gui test`
  - `npm -C polystore_gateway_gui run build`
  - `cd polystore_gateway_gui/src-tauri && cargo test`
- Foundry contracts:
  - `cd nil_bridge && forge test -vv`

## CI truth (GitHub Actions)

The authoritative source of “what CI runs” is `.github/workflows/ci.yml`.

At a high level, CI exercises:
- Go unit tests: `nilchain`, `nil_faucet`, `nil_gateway`, `nil_relayer`
- Rust unit tests: `nil_core`, `nil_cli`, `nil_p2p`, `nil_mock_l1`
- Frontend: build + unit tests + lint (`polystore-website`)
- Tauri GUI: build + unit tests + clippy (`polystore_gateway_gui`)
- Native/WASM parity: `nil_core` wasm-pack build + `tools/parity/compare_parity.ts`
- Local-stack E2E: lifecycle (with and without a local gateway), retrieval fees, and retrieval sessions (Mode1 + Mode2)
- Browser E2E (Playwright): gateway-absent, libp2p-relay, Mode2 stripe (12 SPs)
- Multi-SP regression: `scripts/ci_e2e_gateway_retrieval_multi_sp.sh`
- Solidity: `forge test` under `nil_bridge`

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
- Unit tests: `cd nilchain && go test ./...` (see extend tests under `nilchain/x/nilchain/keeper/*extend*`)
- E2E: `scripts/e2e_lifecycle.sh`

### Phase 2 — Mandatory retrieval sessions for all served bytes (DONE)

CI signals:
- Unit tests: chain + gateway (`go test` suites above)
- E2E: `e2e_open_retrieval_session_cli.sh`, `e2e_open_retrieval_session_mode2_cli.sh`

### Phase 3 — Retrieval policies + sponsored/public sessions (DONE)

CI signals:
- Unit tests: allowlist + vouchers under `nilchain/x/nilchain/keeper/*sponsored*`
- E2E: covered by lifecycle + retrieval-session scripts

### Phase 4 — Protocol retrieval hooks (audit/repair) + audit budget (DONE)

CI signals:
- Unit tests: protocol sessions + audit budget under `nilchain/x/nilchain/keeper/*protocol*` and `*audit*`

### Phase 5 — Compression-aware content pipeline (NilCE v1) (PARTIAL)

CI signals:
- Unit tests only: `go test ./nil_gateway/...` (NilCE helpers)

Not proven:
- NilCE-enabled end-to-end upload/fetch semantics are not required by CI E2E (and are opt-in via `NIL_NILCE=1`).

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
