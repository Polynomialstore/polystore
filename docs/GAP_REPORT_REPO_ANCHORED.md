# Gap Report (Repo-Anchored): PolyStore (Spec ↔ Code ↔ CI)

Last updated: 2026-02-05

This is the repo-specific gap matrix required by `docs/AGENTS_AUTONOMOUS_RUNBOOK.md`.
It is intentionally **requirements-first**: each row links a spec/RFC requirement to:
- the *current* implementation (repo-anchored refs),
- the concrete CI/test signal that proves it works,
- and what is **not** proven yet.

Legend:
- **Status**: DONE / PARTIAL / MISSING
  - **DONE**: implemented + has at least one deterministic test gate in CI.
  - **PARTIAL**: implemented, but missing invariants and/or missing test coverage.
  - **MISSING**: spec/RFC requirement not implemented (or not wired end-to-end).

## CI: what is actually exercised (today)

The authoritative CI definition is `.github/workflows/ci.yml` (plus `e2e_playwright.yml` for a standalone Playwright run).

- Unit tests
  - Go:
    - Chain: `cd polystorechain && go test ./...`
    - Gateway: `cd polystore_gateway && go test ./...`
    - Faucet: `cd polystore_faucet && go test ./...`
    - Relayer: `cd polystore_relayer && go test ./...`
  - Rust: `cargo test` in `polystore_core`, `polystore_cli`, `polystore_p2p`, `polystore_mock_l1`
  - Web: `npm -C polystore-website run build` + `npm -C polystore-website run test:unit` + `npm -C polystore-website run lint`
  - Tauri GUI: `npm -C polystore_gateway_gui test` + `cd polystore_gateway_gui/src-tauri && cargo test` (plus fmt/clippy checks)
  - Solidity contracts: `cd polystore_bridge && forge test -vv`
- Cross-target parity
  - Native/WASM parity: CI builds `polystore_core` with `wasm-pack` and runs `tools/parity/compare_parity.ts`.
- E2E scripts (run in CI; single-machine)
  - Lifecycle: `scripts/e2e_lifecycle.sh` (+ `scripts/e2e_lifecycle_no_gateway.sh`) — dev-convenient; uses faucet + **gateway tx relay** for deterministic runs.
  - Retrieval fees: `e2e_retrieval_fees.sh`
  - Retrieval sessions (CLI): `e2e_open_retrieval_session_cli.sh`, `e2e_open_retrieval_session_mode2_cli.sh`
  - Multi-SP regression: `scripts/ci_e2e_gateway_retrieval_multi_sp.sh`
- Browser E2E (Playwright; wallet-first via in-page E2E wallet; single-machine)
  - `scripts/e2e_browser_smoke_no_gateway.sh`
  - `scripts/e2e_browser_libp2p_relay.sh`
  - `scripts/e2e_mode2_stripe_multi_sp.sh`

## CI does NOT prove (be explicit)

- WAN / multi-host devnet behavior (real latency, NAT, TLS, firewalling)
- Long-running durability (restarts, reorgs, disk corruption, GC/compaction)
- Striped retrieval behavior under background `polystore_gateway` system liveness prover load (CI disables it for determinism via `POLYSTORE_DISABLE_SYSTEM_LIVENESS=1`)
- Dynamic pricing stability/tuning beyond bounded, unit-tested epoch adjustments (no long-running devnet evidence)
- Adversarial cryptoeconomic behavior (griefing, strategic downtime, bribery)
- Comprehensive security review / external audit

## Phase 0 — Spec/code divergences to close before “trusted devnet soft launch”

| Requirement | Status | Spec/RFC anchor | Current implementation (refs) | CI proof | Not proven / gap | Planned fix |
|---|---:|---|---|---|---|---|
| Enforce `MAX_DEAL_BYTES` hard cap (avoid unbounded state bloat) | DONE | `spec.md` (“Hard Cap: 512 GiB”); `rfcs/rfc-data-granularity-and-economics.md` | `polystorechain/x/polystorechain/types/types.go` (`MAX_DEAL_BYTES`); `polystorechain/x/polystorechain/keeper/msg_server.go` (`MsgUpdateDealContent*`) | `cd polystorechain && go test ./...` (unit tests) | — | — |
| Striped retrieval: verify downloaded bytes == uploaded bytes | DONE | `rfcs/rfc-blob-alignment-and-striping.md` | Playwright asserts sha256(downloaded) == sha256(uploaded) in `polystore-website/tests/mode2-stripe.spec.ts` | `scripts/e2e_mode2_stripe_multi_sp.sh` | — | — |
| Allowlist retrieval policy verification has test vectors | DONE | `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md` | Allowlist verification in `polystorechain/x/polystorechain/keeper/msg_server.go` (`OpenRetrievalSessionSponsored`) + test vectors in `polystorechain/x/polystorechain/keeper/msg_server_sponsored_sessions_test.go` | `cd polystorechain && go test ./...` | — | — |
| PolyCE round-trip semantics are end-to-end and documented | PARTIAL | `rfcs/rfc-content-encoding-and-compression.md` | Upload-side wrapping + header parsing helpers exist in `polystore_gateway/` (opt-in `POLYSTORE_POLYCE=1`) | `go test ./polystore_gateway/...` (PolyCE unit tests) | Not required by CI E2E; fetch path does not currently auto-decode to match original bytes for Web2-style users | Defer (track separately if needed for launch) |

## Phase 1 — Deal expiry + renewal (ExtendDeal)

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Deal has an explicit `end_block` term bound | DONE | `polystorechain/proto/polystorechain/polystorechain/v1/types.proto` (Deal.end_block); set in `MsgCreateDeal*` handlers (`polystorechain/x/polystorechain/keeper/msg_server.go`) | `cd polystorechain && go test ./...` | — |
| Reject `UpdateDealContent*` once `height >= end_block` | DONE | `polystorechain/x/polystorechain/keeper/msg_server.go` (`UpdateDealContent`, `UpdateDealContentFromEvm`) | `cd polystorechain && go test ./...` | — |
| Reject retrieval session opens once `height >= end_block` and enforce `expires_at <= end_block` | DONE | `polystorechain/x/polystorechain/keeper/msg_server.go` (`OpenRetrievalSession`, `OpenRetrievalSessionSponsored`, `OpenProtocolRetrievalSession`) | `cd polystorechain && go test ./...` | — |
| Reject liveness/retrieval proofs once `height >= end_block` | DONE | `polystorechain/x/polystorechain/keeper/msg_server.go` (`ProveLiveness`, retrieval proof paths) | `cd polystorechain && go test ./...` | — |
| Implement `MsgExtendDeal` with spot pricing at extension time | DONE | `polystorechain/proto/polystorechain/polystorechain/v1/tx.proto` + `polystorechain/x/polystorechain/keeper/msg_server.go` (`ExtendDeal`) | `polystorechain/x/polystorechain/keeper/msg_server_extend_deal_test.go` | — |
| Prevent renewal overcharge via `pricing_anchor_block` | DONE | `polystorechain/proto/.../types.proto` (Deal.pricing_anchor_block); duration uses anchor in `msg_server.go` | `polystorechain/x/polystorechain/keeper/msg_server_extend_deal_test.go` | — |
| Refuse serving expired deals on data plane | DONE | `polystore_gateway/main.go` (`GatewayFetch`, `SpFetchShard`) fetch deal meta and reject expired deals | `go test ./polystore_gateway/...` + CI E2E scripts | Disk GC after grace is not implemented (ops/process gap) |

## Phase 2 — Mandatory retrieval sessions for all served bytes

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Data-plane requests MUST include `X-PolyStore-Session-Id` | DONE | `polystore_gateway/main.go`: `POLYSTORE_REQUIRE_ONCHAIN_SESSION=1` default; enforced in `GatewayFetch` and `SpFetchShard` | `polystore_gateway/session_enforcement_test.go`; `e2e_open_retrieval_session_cli.sh` | — |
| Validate session is `OPEN`, unexpired, and bound to (deal, provider/slot, manifest_root) | DONE | `polystore_gateway/main.go` (`SpFetchShard` validates deal+root+status+expiry); chain validates on open | `polystore_gateway/session_enforcement_test.go`; `polystorechain/x/polystorechain/keeper/msg_server_retrieval_sessions_test.go` | Gateway-wide “all endpoints” auditing is not automated (human review needed when adding new byte-serving endpoints) |
| Enforce striped slot confinement + subset-of-session-range (batching preserved) | DONE | Chain range invariants in `polystorechain/x/polystorechain/keeper/msg_server.go`; gateway enforces slot mapping in `SpFetchShard` | `e2e_open_retrieval_session_mode2_cli.sh`; keeper tests | — |

## Phase 3 — Retrieval policies + sponsored/public sessions

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Deal retrieval policy fields (OwnerOnly/Allowlist/Voucher/Public) | DONE | `polystorechain/proto/polystorechain/polystorechain/v1/types.proto` (RetrievalPolicy); `MsgUpdateDealRetrievalPolicy` in `tx.proto` + `msg_server.go` | `cd polystorechain && go test ./...` | — |
| `MsgOpenRetrievalSession` remains owner-only and owner-paid (frozen semantics) | DONE | `polystorechain/x/polystorechain/keeper/msg_server.go` (`OpenRetrievalSession`) | `polystorechain/x/polystorechain/keeper/msg_server_retrieval_sessions_test.go` | — |
| Implement requester-paid `MsgOpenRetrievalSessionSponsored` | DONE | `polystorechain/x/polystorechain/keeper/msg_server.go` (`OpenRetrievalSessionSponsored`) | `polystorechain/x/polystorechain/keeper/msg_server_sponsored_sessions_test.go` | — |
| Implement allowlist verification (merkle root + proof) | DONE | `OpenRetrievalSessionSponsored` verification + unit tests in `polystorechain/x/polystorechain/keeper/msg_server_sponsored_sessions_test.go` | `cd polystorechain && go test ./...` | — |
| Implement voucher (EIP-712 signature) + one-time nonce anti-replay | DONE | `OpenRetrievalSessionSponsored` + voucher nonce tracking in keeper | `polystorechain/x/polystorechain/keeper/msg_server_sponsored_sessions_test.go` | — |

## Phase 4 — Protocol retrieval hooks (audit/repair) + audit budget

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Implement `MsgOpenProtocolRetrievalSession` | DONE | `polystorechain/proto/.../tx.proto` + `polystorechain/x/polystorechain/keeper/msg_server.go` | `polystorechain/x/polystorechain/keeper/msg_server_protocol_sessions_test.go` | — |
| Deterministic protocol auth (repair sessions only for pending provider of repairing slot) | DONE | `OpenProtocolRetrievalSession` REPAIR auth + striped slot checks in keeper | `polystorechain/x/polystorechain/keeper/msg_server_protocol_sessions_test.go` | Multi-host repair flows are not yet validated (CI is single-machine) |
| Audit budget mint/caps + spending for protocol sessions | DONE | `polystorechain/x/polystorechain/keeper/epoch_audit.go` + protocol budget module accounting | `polystorechain/x/polystorechain/keeper/epoch_audit_test.go` | — |

## Phase 5 — Compression-aware content pipeline (PolyCEv1)

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Optional compression-aware uploads (PolyCE v1 header + zstd) | PARTIAL | `polystore_gateway/polyce.go` + `polystore_gateway/main.go` (`POLYSTORE_POLYCE=1`) | `polystore_gateway/polyce_test.go` | No CI E2E coverage; retrieval semantics are “return stored bytes” (no auto-decode) |

## Phase 6 — Wallet-first UX (no relay/faucet dependency outside dev)

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Disable tx relay by default (dev-only opt-in) | DONE | `polystore_gateway/main.go`: `POLYSTORE_ENABLE_TX_RELAY=0` default; `scripts/run_local_stack.sh` defaults relay off | CI jobs still enable relay for `scripts/e2e_lifecycle.sh` | Add a dedicated “no relay” CLI E2E if desired (wallet-first is already covered in browser E2E) |
| Wallet-first chain writes (browser) | DONE | `polystore-website/src/lib/e2eWallet.ts` injects E2E wallet for Playwright when `VITE_E2E=1` | Playwright suites listed above | Human UX polish for real MetaMask + remote RPC endpoints is still needed for soft launch |

## Phase 7 — Economics (rewards, draining, retrieval fees)

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Base reward pool mint/distribution | DONE | `polystorechain/x/polystorechain/keeper/base_rewards.go` | `polystorechain/x/polystorechain/keeper/base_rewards_test.go` | — |
| Provider draining / exit | DONE | `polystorechain/x/polystorechain/keeper/draining.go`, `polystorechain/x/polystorechain/keeper/msg_provider_draining.go` | `polystorechain/x/polystorechain/keeper/draining_test.go` | — |
| Elasticity (saturation signal → pre-emptive scaling) | PARTIAL | `polystorechain/proto/polystorechain/polystorechain/v1/tx.proto` (`MsgSignalSaturation`); `polystorechain/x/polystorechain/keeper/msg_server.go` (`SignalSaturation`) | `polystorechain/x/polystorechain/keeper/msg_server_test.go` (`TestSignalSaturation`) | Striped overlay replicas are not fully modeled yet: the handler appends to `deal.providers` / updates `current_replication` but does not update `mode2_slots` or any router selection; no E2E coverage; treat as experimental / dev-only. |
| Retrieval fees (base + per-blob) settlement | DONE | `polystorechain/x/polystorechain/keeper/msg_server_retrieval_fees_test.go` | `e2e_retrieval_fees.sh` | Dynamic pricing is optional and not exercised by CI E2E (unit-tested only). Manual smoke: `POLYSTORE_DYNAMIC_PRICING_E2E=1 ./e2e_retrieval_fees.sh` (retrieval only). |
| Dynamic pricing (storage + retrieval params; epoch-based controller) | DONE | `polystorechain/proto/polystorechain/polystorechain/v1/params.proto`; `polystorechain/x/polystorechain/keeper/dynamic_pricing.go` | `polystorechain/x/polystorechain/keeper/dynamic_pricing_test.go` | Disabled by default; economics not tuned; no long-running devnet evidence. Manual smoke: `POLYSTORE_DYNAMIC_PRICING_E2E=1 ./e2e_retrieval_fees.sh` (asserts both `retrieval_price_per_blob` and `storage_price` update at the next epoch). |
