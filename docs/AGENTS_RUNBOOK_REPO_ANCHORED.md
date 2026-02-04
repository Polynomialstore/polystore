# AGENTS Runbook (Repo-Anchored): nilcoin2 / NilStore

Last updated: 2026-01-24

This file is the repo-specific companion to `docs/AGENTS_AUTONOMOUS_RUNBOOK.md`.
It maps the runbook phases to real directories, files, and existing test gates in this repository.

## Canonical docs (this repo)

- Protocol spec (canonical): `spec.md`
- Economy narrative (non-normative): `ECONOMY.md`
- RFCs: `rfcs/`
- Tracking/checklists:
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
  - `nil-website/src/components/Dashboard.tsx` (create deal, faucet UX, upload/commit, retrieval flows)
  - `nil-website/src/hooks/useFaucet.ts` (browser-triggered faucet calls; should be dev-only in wallet-first mode)
  - `nil-website/src/hooks/useTransportRouter.ts` (adds `X-Nil-Session-Id` when downloading)
  - `nil-website/src/lib/e2eWallet.ts` (Playwright: injects an in-page “wallet” when `VITE_E2E=1`)
- Web contract doc:
  - `nil-website/website-spec.md`

## Existing test/run gates (use these as the phase “test gates”)

### Local stack

- Multi-provider devnet:
  - `./scripts/run_devnet_alpha_multi_sp.sh start`
  - `./scripts/run_devnet_alpha_multi_sp.sh stop`
- Single-node stack:
  - `./scripts/run_local_stack.sh`

### E2E scripts

- Multi-SP gateway retrieval regression:
  - `./scripts/ci_e2e_gateway_retrieval_multi_sp.sh`
  - `./scripts/e2e_gateway_retrieval_multi_sp.sh`
- Lifecycle:
  - `./scripts/e2e_lifecycle.sh`
  - `./scripts/e2e_lifecycle_no_gateway.sh`
- Mode 2 + repair:
  - `./scripts/e2e_mode2_stripe_multi_sp.sh`
  - `./scripts/e2e_deputy_ghost_repair_multi_sp.sh`

### Unit tests

- Chain:
  - `go test ./nilchain/...`
- Gateway:
  - `go test ./nil_gateway/...`

## Phase mapping (repo-specific)

This is the recommended PR/commit decomposition to execute the autonomous runbook in this repo.

### Phase 0 — Repo anchoring + docs sync (DONE in docs-only commits)

Land/refresh:
- `spec.md`, `ECONOMY.md`, and the RFC set under `rfcs/`.
- `docs/AGENTS_AUTONOMOUS_RUNBOOK.md` + `docs/AGENT_PROMPT_AUTONOMOUS.md`
- This file + `docs/GAP_REPORT_REPO_ANCHORED.md`

### Phase 1 — Deal expiry + renewal (ExtendDeal) (chain + gateway behaviors)

Where to implement:
- Add new fields/params in protos:
  - `nilchain/proto/nilchain/nilchain/v1/types.proto` (Deal fields like `pricing_anchor_block`)
  - `nilchain/proto/nilchain/nilchain/v1/params.proto` (e.g. `deal_extension_grace_blocks`)
  - `nilchain/proto/nilchain/nilchain/v1/tx.proto` (new `MsgExtendDeal`)
- Add keeper/MsgServer logic:
  - `nilchain/x/nilchain/keeper/msg_server.go`
    - enforce `current_height < deal.end_block` on:
      - `UpdateDealContent*`
      - `OpenRetrievalSession*` (and `expires_at <= end_block`)
      - `ProveLiveness`
    - implement `ExtendDeal` spot pricing + renewal grace window
- Add gateway/provider “expired deal” behavior:
  - `nil_gateway/main.go` (`GatewayFetch`, `SpFetchShard` should treat expired deals as gone and refuse)

Test gates:
- `go test ./nilchain/...`
- extend `./scripts/e2e_lifecycle.sh` or add a dedicated expiry/renewal script

### Phase 2 — Mandatory retrieval sessions for all served bytes (gateway/provider)

Where to implement:
- Enforce `X-Nil-Session-Id` on any endpoint that returns Deal bytes:
  - `nil_gateway/main.go` (`GatewayFetch`, `SpFetchShard`)
  - `nil_gateway/router_proxy.go` (ensure proxy does not serve/cached bytes out-of-session)
- Enforce blob-alignment + subset-of-session-range only (batching preserved).

Test gates:
- extend `./scripts/e2e_gateway_retrieval_multi_sp.sh` to include out-of-session failure cases
- add unit coverage in `nil_gateway/` around range validation helpers

### Phase 3 — Retrieval access control + requester-paid sessions (chain + UI)

Where to implement:
- Deal retrieval policy fields + session funding tracks:
  - `nilchain/proto/.../types.proto`, `tx.proto`
  - `nilchain/x/nilchain/keeper/msg_server.go`
- UI:
  - `nil-website/src/components/Dashboard.tsx` (policy selection + sponsored session open flow)

Test gates:
- chain unit tests under `nilchain/x/nilchain/keeper/*retrieval*`
- browser e2e in `nil-website/tests/` (playwright)

### Phase 4 — Protocol retrieval hooks (audit/repair) + audit budget

Where to implement:
- New msg `MsgOpenProtocolRetrievalSession` and deterministic authorization:
  - `nilchain/x/nilchain/keeper/*` (repairs live in Mode2 slot logic; quotas in unified liveness)

Test gates:
- `./scripts/e2e_deputy_ghost_repair_multi_sp.sh` extended to ensure repair traffic is session-accounted

### Phase 5 — Compression-aware pipeline (gateway/WASM/UI)

Where to implement:
- Gateway upload/download pipeline in `nil_gateway/`
- WASM path in `nil_core/` + `nil-website/src/workers/`

Test gates:
- unit tests for header parsing + round-trip
- browser smoke for upload/download parity

### Phase 6 — Wallet-first UX (disable relayer/faucet in non-dev mode)

Where to implement:
- UI: `nil-website/src/**` (stop requiring faucet flows in production posture)
- Gateway: `nil_gateway/main.go` (disable tx relay signing by default)

Test gates:
- `./scripts/e2e_browser_smoke.sh` (and “no gateway” variants) in mainnet-parity mode

### Phase 7 — Economics integration (emissions, audit budget, draining)

Where to implement:
- `nilchain/x/nilchain/keeper/*` issuance + audit budget module accounting
- provider draining policy additions to provider state types/keepers

Test gates:
- chain unit tests + e2e “epoch progression” scripts (to be added)
