# Gap Report (Repo-Anchored): NilStore Autonomous Runbook v2

Last updated: 2026-01-24

This is the repo-specific gap matrix required by `docs/AGENTS_AUTONOMOUS_RUNBOOK.md`.
It is intentionally “requirements-first”: each row links the runbook/RFC requirement to the *current* implementation and the concrete place to change it.

Legend:
- **Status**: DONE / PARTIAL / NOT STARTED
- **Primary refs**: where to look in code today
- **Test gate**: the minimum bar for considering the item “landed”

## Phase 1 — Deal expiry + renewal (ExtendDeal)

| Requirement | Status | Current implementation (refs) | Gap / Notes | Planned fix (where) | Test gate |
|---|---:|---|---|---|---|
| Deal has an explicit `end_block` term bound | DONE | `nilchain/proto/nilchain/nilchain/v1/types.proto` (Deal.end_block); `nilchain/x/nilchain/keeper/msg_server.go` sets it on create | Term exists but is not enforced consistently | N/A | Covered indirectly by existing keeper tests |
| Reject `UpdateDealContent*` once `height >= end_block` | NOT STARTED | `nilchain/x/nilchain/keeper/msg_server.go` (`UpdateDealContent`, `UpdateDealContentFromEvm`) has no expiry checks | Deals can be mutated after expiry | Add `if ctx.BlockHeight() >= deal.EndBlock { ... }` in both handlers | `go test ./nilchain/...` + new unit tests |
| Reject `OpenRetrievalSession` once `height >= end_block` and enforce `expires_at <= end_block` | NOT STARTED | `nilchain/x/nilchain/keeper/msg_server.go` (`OpenRetrievalSession`) does not check deal term | Sessions can outlive paid term; sessions can open on expired deals | Add term checks in `OpenRetrievalSession` (and future open msgs) | existing retrieval session keeper tests + new expiry cases |
| Reject `ProveLiveness` once `height >= end_block` | NOT STARTED | `nilchain/x/nilchain/keeper/msg_server.go` (`ProveLiveness`) does not check deal term | Providers can keep earning/claiming after expiry (depends on reward logic) | Add deal ACTIVE guard early in `ProveLiveness` | `go test ./nilchain/...` + new unit test |
| Implement `MsgExtendDeal` with spot pricing at extension time | NOT STARTED | No `MsgExtendDeal` proto or handler | Renewal flow missing | Add proto in `nilchain/proto/.../tx.proto`; implement in `nilchain/x/nilchain/keeper/msg_server.go` | new keeper unit tests + extend an e2e script |
| Prevent “duration overcharge after renewal” via `pricing_anchor_block` | NOT STARTED | Term deposit uses `duration := deal.EndBlock - deal.StartBlock` for new bytes | Renewals would overcharge bytes added after renewal | Add `Deal.pricing_anchor_block` + modify term deposit duration to use `EndBlock - PricingAnchorBlock` for *new bytes* | new keeper unit tests around updates-before/after renewal |
| Provider/gateway treat expired deals as gone; GC after `end_block + grace` | NOT STARTED | Gateway can read local shards without consulting deal term (`nil_gateway/main.go` `SpFetchShard`) | Serving expired deals breaks “no sessions after expiry” story and retention horizon | Add chain term checks in `GatewayFetch`/`SpFetchShard`; add GC worker (or document ops) | extend `./scripts/e2e_lifecycle.sh` with expiry + fetch failure |

## Phase 2 — Mandatory retrieval sessions for all served bytes

| Requirement | Status | Current implementation (refs) | Gap / Notes | Planned fix (where) | Test gate |
|---|---:|---|---|---|---|
| Data-plane requests MUST include `X-Nil-Session-Id` | PARTIAL | `nil_gateway/main.go` `GatewayFetch` parses `X-Nil-Session-Id`; CORS allows the header | Header is optional today; SP fetch (`SpFetchShard`) does not require it | Enforce header presence on any byte-serving endpoint in `nil_gateway/main.go` | add/extend e2e to assert out-of-session reads fail |
| Validate session is `OPEN`, unexpired, and bound to (deal, provider/slot, manifest_root) | PARTIAL | Chain session open validates manifest/provider/range (`nilchain/.../msg_server.go`); gateway has on-chain session aware flow for some fetches | Need “always-on” validation on serve path (including SP endpoints) | Centralize “session validate + range validate” helper in `nil_gateway/` and enforce everywhere | gateway unit tests + multi-SP e2e |
| Enforce blob alignment + subset-of-session-range only (batching preserved) | PARTIAL | Chain enforces blob-range invariants at open (Mode 2 slot confinement); gateway supports ranged fetch behavior | Need enforce on serve path (esp. `SpFetchShard`); ensure batching is supported without over-constraining | Implement in gateway/provider read path; document accepted segmentation | e2e segmented vs batched download tests |

## Phase 3 — Retrieval policies + sponsored/public sessions

| Requirement | Status | Current implementation (refs) | Gap / Notes | Planned fix (where) | Test gate |
|---|---:|---|---|---|---|
| Deal retrieval policy fields (OwnerOnly/Allowlist/Voucher/Public) | NOT STARTED | No retrieval policy fields in `types.proto` | Only “owner-only” is enforced implicitly by `OpenRetrievalSession` | Add fields to `nilchain/proto/.../types.proto`; default to OwnerOnly for existing deals | keeper unit tests + protobuf regen |
| `MsgOpenRetrievalSession` remains owner-only and owner-paid (frozen semantics) | DONE | `nilchain/x/nilchain/keeper/msg_server.go` enforces `msg.Creator == deal.Owner` and debits deal escrow | Must stay unchanged | N/A | existing keeper tests |
| Implement requester-paid `MsgOpenRetrievalSessionSponsored` | NOT STARTED | No msg/handler | Needed so public/3p retrieval can’t drain deal escrow | Add proto + handler; add session funding fields; refund routing to payer | new unit tests + e2e public deal retrieval |
| Implement allowlist verification (merkle root + proof) | NOT STARTED | No allowlist fields/logic | | Add merkle root field + proof verification in sponsored open | unit tests with test vectors |
| Implement voucher (EIP-712 signature) + one-time nonce anti-replay | NOT STARTED | Chain has nonces for `OpenRetrievalSession` but not vouchers | Voucher replay prevention needs explicit nonce tracking | Add voucher nonce storage keyed by (deal, signer) or (deal, voucher-id) | unit tests + e2e replay attempt |

## Phase 4 — Protocol retrieval hooks (audit/repair) + audit budget

| Requirement | Status | Current implementation (refs) | Gap / Notes | Planned fix (where) | Test gate |
|---|---:|---|---|---|---|
| Implement `MsgOpenProtocolRetrievalSession` | NOT STARTED | No msg/handler | Required for audits + repairs on restricted deals | Add proto + handler; deterministic auth rules | unit tests + multi-SP repair e2e |
| Deterministic protocol auth: repair sessions only for `pending_provider` of REPAIRING slot | PARTIAL | Mode 2 repair concepts exist in `nilchain/x/nilchain/keeper/slashing_repair_test.go` and slot rules in `ProveLiveness` | Repair traffic is not session-accounted yet | Implement protocol open checks against slot state | `./scripts/e2e_deputy_ghost_repair_multi_sp.sh` extension |
| Audit budget mint/caps + spending for protocol sessions | NOT STARTED | No dedicated audit budget module/accounting | Needed to fund audit traffic without draining users | Implement per RFC under `nilchain/x/nilchain/keeper/` and params | chain unit tests + epoch simulation |

## Phase 5 — Compression-aware content pipeline (NilCEv1)

| Requirement | Status | Current implementation (refs) | Gap / Notes | Planned fix (where) | Test gate |
|---|---:|---|---|---|---|
| Compress plaintext pre-encryption and store ciphertext bytes (pricing on stored size) | NOT STARTED | `nil_core/src/layout.rs` defines compression flags, but gateway does not implement NilCEv1 pipeline | End-to-end compression behavior missing | Implement NilCEv1 header + zstd/gzip in `nil_gateway/` and WASM pipeline | unit tests + browser smoke |
| Decompress post-decrypt on retrieval | NOT STARTED | No NilCEv1 decode path | | Implement decode in gateway/wasm; ensure partial reads fetch header blobs | unit tests around header parsing |

## Phase 6 — Wallet-first UX (no relay/faucet dependency outside dev)

| Requirement | Status | Current implementation (refs) | Gap / Notes | Planned fix (where) | Test gate |
|---|---:|---|---|---|---|
| MetaMask-signed transactions for create/commit/open/confirm/cancel/extend | PARTIAL | EVM bridge msgs exist (`MsgCreateDealFromEvm`, `MsgUpdateDealContentFromEvm`); UI still uses faucet UX flows | Many write paths still rely on faucet/gateway signing in devnet | Remove/flag faucet flows; add missing EVM-msg equivalents where needed | playwright smoke in “no faucet” mode |
| Disable tx relay + faucet by default (dev-only opt-in) | NOT STARTED | `nil_gateway/main.go` contains faucet signing and “creator has no balance” checks; website has `useFaucet` | Mainnet parity posture not default | Add explicit env flags (`ENABLE_TX_RELAY`, `NIL_AUTO_FAUCET_EVM` etc) and default off | e2e smoke with flags disabled |

## Phase 7 — Economics (base rewards, draining, quotas hardening)

| Requirement | Status | Current implementation (refs) | Gap / Notes | Planned fix (where) | Test gate |
|---|---:|---|---|---|---|
| Base reward pool mint/distribution | COMPLETE | `nilchain/x/nilchain/keeper/base_rewards.go` (epoch rent → mint → per-provider distribution) | — | — | `nilchain/x/nilchain/keeper/base_rewards_test.go` |
| Provider draining / exit | COMPLETE | `nilchain/x/nilchain/keeper/draining.go`, `nilchain/x/nilchain/keeper/msg_provider_draining.go` | — | — | `nilchain/x/nilchain/keeper/draining_test.go` |
| Quotas/credits exclude expired deals + exclude REPAIRING for rewards | COMPLETE | Expiry checks in `slashing.go`/`base_rewards.go`; REPAIRING excluded in `slashing.go` and reward weights | — | — | `nilchain/x/nilchain/keeper/slashing_repair_test.go` |
