# Gap Report (Repo-Anchored): NilStore (Spec ↔ Code ↔ CI)

Last updated: 2026-02-04

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

- Unit tests
  - Chain: `go test ./nilchain/...`
  - Gateway: `go test ./nil_gateway/...`
  - Rust: `cargo test` in `nil_core`, `nil_cli`, `nil_p2p`, `nil_mock_l1`
  - Web: `nil-website` build + unit tests + lint
- E2E scripts (run in CI)
  - Lifecycle: `scripts/e2e_lifecycle.sh` (+ `scripts/e2e_lifecycle_no_gateway.sh`) — uses **gateway tx relay** for deterministic runs.
  - Retrieval fees: `e2e_retrieval_fees.sh`
  - Retrieval sessions (CLI): `e2e_open_retrieval_session_cli.sh`, `e2e_open_retrieval_session_mode2_cli.sh`
  - Multi-SP regression: `scripts/ci_e2e_gateway_retrieval_multi_sp.sh`
- Browser E2E (Playwright; wallet-first via in-page E2E wallet)
  - `scripts/e2e_browser_smoke_no_gateway.sh`
  - `scripts/e2e_browser_libp2p_relay.sh`
  - `scripts/e2e_mode2_stripe_multi_sp.sh`

## CI does NOT prove (be explicit)

- WAN / multi-host devnet behavior (real latency, NAT, TLS, firewalling)
- Long-running durability (restarts, reorgs, disk corruption, GC/compaction)
- Dynamic pricing (storage or retrieval) beyond current parameterized fees
- Adversarial cryptoeconomic behavior (griefing, strategic downtime, bribery)
- Comprehensive security review / external audit

## Phase 0 — Spec/code divergences to close before “trusted devnet soft launch”

| Requirement | Status | Spec/RFC anchor | Current implementation (refs) | CI proof | Not proven / gap | Planned fix |
|---|---:|---|---|---|---|---|
| Enforce `MAX_DEAL_BYTES` hard cap (avoid unbounded state bloat) | MISSING | `spec.md` (“Hard Cap: 512 GiB”); `rfcs/rfc-data-granularity-and-economics.md` | No explicit cap enforcement in `nilchain/x/nilchain/keeper/msg_server.go` (`MsgUpdateDealContent*`) | N/A | Spec/RFC claim is not enforced; a malicious client can commit arbitrarily large `size_bytes` | PR2 (`codex/spec-invariants-hard-caps`) |
| Mode2 Stripe retrieval: verify downloaded bytes == uploaded bytes | PARTIAL | `rfcs/rfc-blob-alignment-and-striping.md` | Mode2 flows implemented end-to-end, but Playwright asserts only “downloaded something” | `scripts/e2e_mode2_stripe_multi_sp.sh` | No byte-for-byte assertion in `nil-website/tests/mode2-stripe.spec.ts` | PR4 (`codex/mode2-stripe-bytes-assert`) |
| Allowlist retrieval policy verification has test vectors | PARTIAL | `rfcs/rfc-retrieval-access-control-public-deals-and-vouchers.md` | Allowlist verification is implemented in `nilchain/x/nilchain/keeper/msg_server.go` (`OpenRetrievalSessionSponsored`) | N/A | No unit tests covering keccak merkle proofs; easiest place to regress | PR5 (`codex/allowlist-merkle-tests`) |
| NilCE round-trip semantics are end-to-end and documented | PARTIAL | `rfcs/rfc-content-encoding-and-compression.md` | Upload-side wrapping + header parsing helpers exist in `nil_gateway/` (opt-in `NIL_NILCE=1`) | `go test ./nil_gateway/...` (NilCE unit tests) | Not required by CI E2E; fetch path does not currently auto-decode to match original bytes for Web2-style users | Defer (track separately if needed for launch) |

## Phase 1 — Deal expiry + renewal (ExtendDeal)

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Deal has an explicit `end_block` term bound | DONE | `nilchain/proto/nilchain/nilchain/v1/types.proto` (Deal.end_block); set in `MsgCreateDeal*` handlers (`nilchain/x/nilchain/keeper/msg_server.go`) | `go test ./nilchain/...` | — |
| Reject `UpdateDealContent*` once `height >= end_block` | DONE | `nilchain/x/nilchain/keeper/msg_server.go` (`UpdateDealContent`, `UpdateDealContentFromEvm`) | `go test ./nilchain/...` | — |
| Reject retrieval session opens once `height >= end_block` and enforce `expires_at <= end_block` | DONE | `nilchain/x/nilchain/keeper/msg_server.go` (`OpenRetrievalSession`, `OpenRetrievalSessionSponsored`, `OpenProtocolRetrievalSession`) | `go test ./nilchain/...` | — |
| Reject liveness/retrieval proofs once `height >= end_block` | DONE | `nilchain/x/nilchain/keeper/msg_server.go` (`ProveLiveness`, retrieval proof paths) | `go test ./nilchain/...` | — |
| Implement `MsgExtendDeal` with spot pricing at extension time | DONE | `nilchain/proto/nilchain/nilchain/v1/tx.proto` + `nilchain/x/nilchain/keeper/msg_server.go` (`ExtendDeal`) | `nilchain/x/nilchain/keeper/msg_server_extend_deal_test.go` | — |
| Prevent renewal overcharge via `pricing_anchor_block` | DONE | `nilchain/proto/.../types.proto` (Deal.pricing_anchor_block); duration uses anchor in `msg_server.go` | `nilchain/x/nilchain/keeper/msg_server_extend_deal_test.go` | — |
| Refuse serving expired deals on data plane | DONE | `nil_gateway/main.go` (`GatewayFetch`, `SpFetchShard`) fetch deal meta and reject expired deals | `go test ./nil_gateway/...` + CI E2E scripts | Disk GC after grace is not implemented (ops/process gap) |

## Phase 2 — Mandatory retrieval sessions for all served bytes

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Data-plane requests MUST include `X-Nil-Session-Id` | DONE | `nil_gateway/main.go`: `NIL_REQUIRE_ONCHAIN_SESSION=1` default; enforced in `GatewayFetch` and `SpFetchShard` | `nil_gateway/session_enforcement_test.go`; `e2e_open_retrieval_session_cli.sh` | — |
| Validate session is `OPEN`, unexpired, and bound to (deal, provider/slot, manifest_root) | DONE | `nil_gateway/main.go` (`SpFetchShard` validates deal+root+status+expiry); chain validates on open | `nil_gateway/session_enforcement_test.go`; `nilchain/x/nilchain/keeper/msg_server_retrieval_sessions_test.go` | Gateway-wide “all endpoints” auditing is not automated (human review needed when adding new byte-serving endpoints) |
| Enforce Mode2 slot confinement + subset-of-session-range (batching preserved) | DONE | Chain range invariants in `nilchain/x/nilchain/keeper/msg_server.go`; gateway enforces slot mapping in `SpFetchShard` | `e2e_open_retrieval_session_mode2_cli.sh`; keeper tests | — |

## Phase 3 — Retrieval policies + sponsored/public sessions

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Deal retrieval policy fields (OwnerOnly/Allowlist/Voucher/Public) | DONE | `nilchain/proto/nilchain/nilchain/v1/types.proto` (RetrievalPolicy); `MsgUpdateDealRetrievalPolicy` in `tx.proto` + `msg_server.go` | `go test ./nilchain/...` | — |
| `MsgOpenRetrievalSession` remains owner-only and owner-paid (frozen semantics) | DONE | `nilchain/x/nilchain/keeper/msg_server.go` (`OpenRetrievalSession`) | `nilchain/x/nilchain/keeper/msg_server_retrieval_sessions_test.go` | — |
| Implement requester-paid `MsgOpenRetrievalSessionSponsored` | DONE | `nilchain/x/nilchain/keeper/msg_server.go` (`OpenRetrievalSessionSponsored`) | `nilchain/x/nilchain/keeper/msg_server_sponsored_sessions_test.go` | — |
| Implement allowlist verification (merkle root + proof) | PARTIAL | Implemented in `OpenRetrievalSessionSponsored`, but no tests | N/A | Missing deterministic test vectors (see Phase 0) |
| Implement voucher (EIP-712 signature) + one-time nonce anti-replay | DONE | `OpenRetrievalSessionSponsored` + voucher nonce tracking in keeper | `nilchain/x/nilchain/keeper/msg_server_sponsored_sessions_test.go` | — |

## Phase 4 — Protocol retrieval hooks (audit/repair) + audit budget

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Implement `MsgOpenProtocolRetrievalSession` | DONE | `nilchain/proto/.../tx.proto` + `nilchain/x/nilchain/keeper/msg_server.go` | `nilchain/x/nilchain/keeper/msg_server_protocol_sessions_test.go` | — |
| Deterministic protocol auth (repair sessions only for pending provider of repairing slot) | DONE | `OpenProtocolRetrievalSession` REPAIR auth + Mode2 slot checks in keeper | `nilchain/x/nilchain/keeper/msg_server_protocol_sessions_test.go` | Multi-host repair flows are not yet validated (CI is single-machine) |
| Audit budget mint/caps + spending for protocol sessions | DONE | `nilchain/x/nilchain/keeper/epoch_audit.go` + protocol budget module accounting | `nilchain/x/nilchain/keeper/epoch_audit_test.go` | — |

## Phase 5 — Compression-aware content pipeline (NilCEv1)

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Optional compression-aware uploads (NilCE v1 header + zstd) | PARTIAL | `nil_gateway/nilce.go` + `nil_gateway/main.go` (`NIL_NILCE=1`) | `nil_gateway/nilce_test.go` | No CI E2E coverage; retrieval semantics are “return stored bytes” (no auto-decode) |

## Phase 6 — Wallet-first UX (no relay/faucet dependency outside dev)

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Disable tx relay by default (dev-only opt-in) | DONE | `nil_gateway/main.go`: `NIL_ENABLE_TX_RELAY=0` default; `scripts/run_local_stack.sh` defaults relay off | CI jobs still enable relay for `scripts/e2e_lifecycle.sh` | Add a dedicated “no relay” CLI E2E if desired (wallet-first is already covered in browser E2E) |
| Wallet-first chain writes (browser) | DONE | `nil-website/src/lib/e2eWallet.ts` injects E2E wallet for Playwright when `VITE_E2E=1` | Playwright suites listed above | Human UX polish for real MetaMask + remote RPC endpoints is still needed for soft launch |

## Phase 7 — Economics (rewards, draining, retrieval fees)

| Requirement | Status | Current implementation (refs) | CI proof | Not proven / gap |
|---|---:|---|---|---|
| Base reward pool mint/distribution | DONE | `nilchain/x/nilchain/keeper/base_rewards.go` | `nilchain/x/nilchain/keeper/base_rewards_test.go` | — |
| Provider draining / exit | DONE | `nilchain/x/nilchain/keeper/draining.go`, `nilchain/x/nilchain/keeper/msg_provider_draining.go` | `nilchain/x/nilchain/keeper/draining_test.go` | — |
| Retrieval fees (base + per-blob) settlement | DONE | `nilchain/x/nilchain/keeper/msg_server_retrieval_fees_test.go` | `e2e_retrieval_fees.sh` | “Dynamic” pricing is not implemented (separate track) |
