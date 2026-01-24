# AGENTS Autonomous Runbook: NilStore Econ + Deal Lifecycle + Retrieval Control (pre‑alpha)

**Version:** v2.0 (autonomous)  
**Last updated:** 2026-01-23  
**Target operator:** an autonomous coding agent running locally (GPT‑5.2 xhigh) with terminal access.  
**Goal:** land *all* features discussed in the protocol economics + lifecycle + retrieval sessions/access-control/compression thread into the repo, with docs, code, tests, and UX.

This runbook is intentionally verbose and operational. It is designed so an autonomous agent can execute it end-to-end without asking for clarifications.

---

## 0) Non‑negotiables (hard constraints)

1) **Do not change the frozen accounting contract semantics** as defined in:
   - `rfcs/rfc-pricing-and-escrow-accounting.md`

   You MAY add *new messages / new session types* whose settlement is specified in new RFCs, but you MUST NOT change the semantics of the existing messages and flows.

2) **No fiat pegs / no price oracles** in consensus logic.

3) **Deterministic and consensus-safe:** any minting, settlement, authorization, or eligibility rule MUST be computable from chain state + height only.

4) **Mandatory retrieval sessions:** no session → no bytes served (provider/gateway enforcement).

5) **Batching must remain flexible:** segmentation is a transport choice; constraints are blob-alignment + subset-of-session-range only.

6) **Restricted deals must still allow protocol audit/repair retrievals** (protocol hooks).

7) **Wallet-first:** user pays from MetaMask for chain writes (EVM bridge), no relayer/faucet dependency outside dev-mode.

---

## 1) Inputs (authoritative thread artifacts)

The agent MUST add (or update) the following documents in-repo exactly (or with path-normalization):

### Specs / econ narratives
- `spec_UPDATED_DEAL_EXPIRY_WALLETFIRST_SESSIONS_MANDATORY_ACCESS_CONTROL_COMPRESSION_PROTOCOL_HOOKS.md`
- `ECONOMY_UPDATED_DEAL_EXPIRY_WALLETFIRST_SESSIONS_MANDATORY_ACCESS_CONTROL_COMPRESSION_PROTOCOL_HOOKS.md`

### RFCs
- `rfc-pricing-and-escrow-accounting.md` *(frozen reference; no edits)*
- `rfc-challenge-derivation-and-quotas.md`
- `rfc-retrieval-validation_PROTOCOL_HOOKS.md`
- `rfc-deal-expiry-and-extension_SESSIONS_MANDATORY.md`
- `rfc-mandatory-retrieval-sessions-and-batching_ACCESS_CONTROL_PROTOCOL_HOOKS.md`
- `rfc-retrieval-access-control-public-deals-and-vouchers_PROTOCOL_HOOKS.md`
- `rfc-content-encoding-and-compression.md`
- `rfc-provider-exit-and-draining_PROTOCOL_HOOKS.md`
- `rfc-base-reward-pool-and-emissions.md`

### Operational docs
- `UI_UX_RETRIEVAL_POLICIES_VOUCHERS_COMPRESSION_PROTOCOL_HOOKS.md`
- `MAINNET_GAP_TRACKER_UPDATED_DEAL_EXPIRY_WALLETFIRST_SESSIONS_MANDATORY_ACCESS_CONTROL_COMPRESSION_PROTOCOL_HOOKS.md`
- `MAINNET_ECON_PARITY_CHECKLIST_UPDATED_DEAL_EXPIRY_WALLETFIRST_SESSIONS_MANDATORY_ACCESS_CONTROL_COMPRESSION_PROTOCOL_HOOKS.md`
- `NEXT_STEPS_TESTNET_UPDATED_DEAL_EXPIRY_WALLETFIRST_SESSIONS_MANDATORY_ACCESS_CONTROL_COMPRESSION_PROTOCOL_HOOKS.md`

Optionally include the economic modeling bundle (not consensus-critical).

---

## 2) REQUIRED agent behavior (meta-runbook requirement)

**Before changing any code**, the agent MUST do a repo-specific synthesis step:

### 2.1 First output: “Runbook v2.1 (repo-anchored)”
The agent must:
1) Read this runbook and all input docs.
2) Scan the repo to map:
   - chain module layout
   - provider/gateway/UI directories
   - proto layout and message dispatch
   - EVM bridge/precompile integration points
   - existing retrieval session implementation
   - existing deal struct fields (`end_block`, `escrow_balance`, `size_bytes`, etc.)
   - existing repair/REPAIRING state
   - existing quota/synthetic/credit implementation
   - any existing compression/encoding in upload pipeline
   - any existing relayer/faucet code paths
3) Produce and commit two repo-local artifacts:
   - `docs/AGENTS_RUNBOOK_REPO_ANCHORED.md` (a copy of this runbook with *actual paths and commands for your repo*)
   - `docs/GAP_REPORT_REPO_ANCHORED.md` (a matrix: requirement → existing implementation → gap → planned fix → tests)

Only after these are produced should the agent proceed to implementation.

### 2.2 How to scan (command playbook)
The agent should execute (adapt as needed):
- `git status`, `git rev-parse --show-toplevel`
- `rg -n "MsgOpenRetrievalSession" -S .`
- `rg -n "RetrievalSession" -S .`
- `rg -n "end_block" -S .`
- `rg -n "escrow_balance" -S .`
- `rg -n "storage_price" -S .`
- `rg -n "REPAIRING" -S .`
- `rg -n "quota" -S .`
- `rg -n "credit_cap" -S .`
- `rg -n "faucet" -S .`
- `rg -n "relayer|relay" -S .`
- `rg -n "metamask|wallet" -S ui/ web/ apps/ .`
- `rg -n "precompile|evm bridge" -S .`
- `rg -n "zstd|gzip|compress" -S .`
- `rg -n "X-Nil-Session-Id" -S .`

---

## 3) Phase plan (what the operator should expect)

**Phase 0 – Repo anchoring & plan (1–2 PRs)**
- Outputs:
  - `docs/AGENTS_RUNBOOK_REPO_ANCHORED.md`
  - `docs/GAP_REPORT_REPO_ANCHORED.md`
  - “Doc sync PR” that lands all updated specs/RFCs in the right repo locations.

**Phase 1 – Chain deal lifecycle (expiry + extend)**
- Outputs:
  - `MsgExtendDeal` implemented and tested.
  - Deal expiry enforced across all relevant messages.
  - Provider/gateway see expiry in API.
  - No retrieval sessions after expiry; existing sessions cannot extend beyond end_block.

**Phase 2 – Retrieval sessions mandatory (data-plane)**
- Outputs:
  - Provider + gateway reject all byte-serving requests without `X-Nil-Session-Id`.
  - Subset + blob-alignment rules implemented (batching preserved).
  - E2E tests for segmented downloads.

**Phase 3 – Retrieval access control (OwnerOnly/Allowlist/Voucher/Public)**
- Outputs:
  - Deal has retrieval policy fields.
  - Chain validates authorization at session open.
  - Sponsored session open exists for public/voucher flows.

**Phase 4 – Protocol retrieval hooks (audit/repair/healing)**
- Outputs:
  - `MsgOpenProtocolRetrievalSession` implemented with deterministic authorization.
  - Protocol-funded sessions integrated with audit budget module.
  - Repair path uses protocol sessions (restricted deals still repairable).

**Phase 5 – Compression/content encoding (NilCEv1)**
- Outputs:
  - Upload pipeline compresses pre-encryption (gateway/wasm).
  - Stored bytes are compressed ciphertext; pricing applies to stored size.
  - Download pipeline decrypts then decompresses before user handoff.

**Phase 6 – Wallet-first UX + remove relayer dependency**
- Outputs:
  - UI signs and pays all chain writes via MetaMask.
  - Relayer/faucet paths are dev-only, disabled by default.
  - Bridge/precompile integration is the only production path.

**Phase 7 – Economics (base rewards, audit budget, quotas/credits, draining)**
- Outputs:
  - Base reward pool minting + distribution implemented (deterministic).
  - Audit budget minting/caps implemented.
  - Quota/credit logic correct and reward-eligible gating enforced.
  - Provider draining/exit integrated with repair scheduler.

**Phase 8 – Testnet readiness**
- Outputs:
  - A “mainnet parity” config profile (wallet-first, no relay).
  - End-to-end test suite green in CI.
  - Launch checklist completed.

---

## 4) Phase 0: Doc sync + repo anchoring (required)

### 4.1 Create branch
- `git checkout -b feat/deal-expiry-sessions-access-control-protocol-hooks-compression`

### 4.2 Land docs
The agent must:
- Create/Update `docs/spec.md` from the updated spec draft.
- Create/Update `docs/ECONOMY.md` from the updated economy draft.
- Add RFCs under `docs/rfcs/` (or repo’s RFC folder).
- Add operational docs under `docs/`.

### 4.3 Wire up references
Ensure:
- `spec.md` Appendix references point to the RFC filenames actually in repo.
- Any doc index pages are updated.

### 4.4 Commit
- `git add docs/`
- `git commit -m "docs: sync spec/RFCs for deal lifecycle, sessions, access control, protocol hooks, compression, emissions"`

---

## 5) Phase 1: Chain deal expiry + MsgExtendDeal (consensus)

### 5.1 Required fields and params

#### Deal fields (minimum)
- `Deal.start_block`
- `Deal.end_block` (exclusive)
- `Deal.size_bytes`
- `Deal.escrow_balance`
- **NEW:** `Deal.pricing_anchor_block` (uint64)  
  Rationale: prevents overcharging new bytes after renewal. Set at deal creation and updated on ExtendDeal.

#### Params
- `deal_extension_grace_blocks` (uint64) default ~`MONTH_LEN_BLOCKS`

### 5.2 Expiry enforcement points (must implement)
At height `h`:
- If `h >= end_block`, reject:
  - content updates (`MsgUpdateDealContent*`)
  - opening new retrieval sessions (all types)
  - liveness proofs
  - credit submission (if exists)
- Any retrieval session’s `expires_at` must satisfy:
  - `expires_at <= min(session_open_height + spend_window, deal.end_block)` (exact rule per RFC)

### 5.3 MsgExtendDeal
Add:
- `MsgExtendDeal(deal_id, additional_duration_blocks)`
- Charges at spot storage_price:
  - `extension_cost = ceil(storage_price * deal.size_bytes * additional_duration_blocks)`
- Update:
  - `deal.end_block += additional_duration_blocks` (or base=max(end_block,h) + dur)
  - `deal.pricing_anchor_block = current_height` (or `base` used above)
  - `deal.escrow_balance += extension_cost`
- Reject if deal is too far expired:
  - `h > end_block + deal_extension_grace_blocks`

### 5.4 Tests
Unit tests:
- extend before expiry
- extend within grace
- extend after grace fails
- new bytes after renewal use `end_block - pricing_anchor_block` for duration computation
- cannot open sessions after expiry

---

## 6) Phase 2: Mandatory retrieval sessions (provider + gateway)

### 6.1 Data-plane invariant
Any response that includes Deal bytes MUST require:
- `X-Nil-Session-Id: <session_id>` header
- Session must be OPEN and unexpired on-chain
- Session must bind to deal_id, provider/slot assignment, manifest_root (if pinned)

### 6.2 Batching/segmentation rules
Enforce only:
- blob-aligned ranges (start and length multiples of BLOB_SIZE)
- requested range subset of session’s declared blob-range
- responses may include multiple contiguous blobs (batched)
- retries are allowed; do not assume exactly-once delivery at transport layer

### 6.3 Implementation checklist
Provider:
- verify session and range; return 401/403 for missing/invalid session
- return 410 Gone for expired deal (or 404), consistently
Gateway:
- proxy must forward session header upstream
- must not serve cached bytes out-of-session

Tests:
- out-of-session reads fail
- misaligned reads fail
- segmented reads within a session succeed
- batched reads within a session succeed

---

## 7) Phase 3: Retrieval policies (OwnerOnly/Allowlist/Voucher/Public)

### 7.1 Deal retrieval policy fields (minimum)
- `Deal.retrieval_policy_mode` enum:
  - OWNER_ONLY
  - ALLOWLIST
  - VOUCHER
  - ALLOWLIST_OR_VOUCHER
  - PUBLIC
- `Deal.allowlist_root` (bytes32)
- `Deal.voucher_signer` (address; default = owner)
- Optional: `Deal.public_metadata` flags for explorer

### 7.2 Session open authorization rules
- USER sessions (`MsgOpenRetrievalSession`):
  - OWNER_ONLY: only owner
  - ALLOWLIST: owner or allowlisted
  - VOUCHER: owner or valid voucher
  - PUBLIC: anyone
- Sponsored USER sessions (`MsgOpenRetrievalSessionSponsored`):
  - same auth as above, but payer is requester (not owner)

### 7.3 Allowlist proof
- Use merkle root; proof verified at session open

### 7.4 Voucher / one-time signature
- EIP‑712 typed data recommended (MetaMask friendly)
- Voucher includes:
  - deal_id
  - provider/slot (optional binding)
  - blob-range
  - expires_at
  - nonce
  - optional redeemer address binding
- Chain tracks nonce usage per deal (or per signer) to prevent replay.

### 7.5 Sponsored payment WITHOUT changing frozen semantics
Because the frozen RFC defines how deal-escrow sessions behave, implement sponsored sessions as a *new session funding track*:
- payer transfers `base_fee + variable_fee` into a retrieval module account at open
- module burns base fee and locks variable fee in session-local accounting
- settlement/refunds go back to payer
- deal escrow is unchanged

This requires new session fields:
- `session.funding_source` (DEAL_ESCROW | REQUESTER | PROTOCOL)
- `session.payer` (address, when funding_source != DEAL_ESCROW)

The existing `MsgOpenRetrievalSession` remains unchanged and continues to debit deal escrow exactly per the frozen RFC.

Tests:
- public deal: non-owner can open sponsored session and retrieve
- refund/cancel returns variable fee to payer, not owner
- voucher once: second open with same nonce fails

---

## 8) Phase 4: Protocol retrieval hooks (audit/repair/healing)

### 8.1 New message: MsgOpenProtocolRetrievalSession
- Fields:
  - deal_id, provider/slot
  - purpose: PROTOCOL_AUDIT | PROTOCOL_REPAIR
  - blob-range, expires_at
- Funding:
  - from protocol audit budget module account
  - session.funding_source = PROTOCOL
  - session.payer = audit_budget_module_account

### 8.2 Deterministic authorization rules
PROTOCOL_REPAIR:
- Allowed only if:
  - slot is REPAIRING
  - caller is `pending_provider` for that slot (or the provider selected by deterministic repair scheduler)

PROTOCOL_AUDIT:
- Allowed only if:
  - caller is the provider assigned to a deterministic audit task for the epoch
  - audit task derived from chain state (seed) and is bounded by audit budget

### 8.3 Refund routing
- Cancel/expiry refunds return to protocol budget, not to deal escrow.

### 8.4 Provider/gateway handling
- Data-plane does not distinguish protocol vs user sessions; it just checks session validity.
- Protocol sessions are still mandatory for bytes served.

Tests:
- restricted deal: non-owner cannot open user session, but protocol audit session can open and retrieve
- repair path: pending provider can open protocol repair session

---

## 9) Phase 5: Compression/content encoding (NilCEv1)

### 9.1 Goal
- Charge storage and bandwidth on **stored ciphertext bytes**, which are compressed when possible.
- Prevent SPs from “getting lucky” storing compressible plaintext at uncompressed prices.

### 9.2 NilCEv1 format
- A small header in plaintext before encryption:
  - magic `NILC`
  - version
  - encoding enum (NONE, ZSTD)
  - uncompressed length
  - optional checksum
- Pipeline:
  - compress → wrap (NilCEv1) → encrypt → chunk/commit
  - retrieve → verify → decrypt → parse header → decompress → handoff

### 9.3 Implementation points
- gateway/wasm gateway: implement compression pre-encryption and decompression post-decrypt
- UI: default “compress before upload” on; show size reduction + cost estimate
- provider: stores ciphertext only; no decompression

Tests:
- upload compressed file round-trips exactly
- storage_price applies to compressed size
- retrieval returns original bytes

---

## 10) Phase 6: Wallet-first UX + remove relayer/faucet dependence

### 10.1 Requirements
- All chain writes originate from MetaMask (EVM bridge/precompile).
- Gateway relay endpoints are dev-only and disabled by default.
- Faucet is dev-only and not implicitly invoked by UI.

### 10.2 Implementation checklist
- UI:
  - remove hidden faucet calls
  - implement `create deal`, `commit`, `extend`, `open session`, `confirm`, `cancel` as wallet txs
- gateway:
  - config flag `ENABLE_TX_RELAY=false` by default
- docs:
  - update quickstart to require user-funded wallet.

Tests:
- “no relay mode” smoke test passes.

---

## 11) Phase 7: Economics – base rewards, audit budget, quotas/credits, draining

This phase is larger; do it after core lifecycle + retrieval correctness is solid.

### 11.1 Base reward pool (issuance)
Implement per `rfc-base-reward-pool-and-emissions.md`:
- aggregate `TotalActiveSlotBytes`
- compute `epoch_slot_rent = storage_price * TotalActiveSlotBytes * epoch_len_blocks`
- mint `base_reward_pool` as scheduled bps fraction of rent
- distribute by bytes × compliance; burn remainder

### 11.2 Audit budget
Implement deterministic minting:
- bps of epoch_slot_rent
- cap and bounded carryover
- pay for protocol audit sessions from this budget

### 11.3 Quotas / credits
Ensure:
- quota derivation per RFC
- credit caps enforced
- REPAIRING excluded from quotas and rewards

### 11.4 Provider draining
Implement:
- `Provider.draining` flag
- no new assignments to draining providers
- deterministic drain scheduler bounded by churn caps
- repair uses protocol sessions for bytes transfer

---

## 12) Phase 8: Testnet readiness gates

The agent MUST provide:
- a single command to bring up a local testnet (docker-compose or scripts)
- a single command to run e2e tests
- a written checklist confirming:
  - expiry + extend
  - sessions mandatory
  - access control modes
  - vouchers one-time
  - protocol audit/repair sessions
  - compression round-trip
  - wallet-first mode

---

## 13) Expected PR structure

Recommended PR decomposition:
1) Docs sync + repo anchored runbook/gap report
2) Chain: expiry + extend + pricing anchor
3) Provider/gateway: sessions mandatory + batching
4) Chain: access control + allowlist + voucher + sponsored sessions
5) Chain: protocol sessions + audit budget integration
6) Compression pipeline (gateway/wasm/UI)
7) Wallet-first UX + disable relay by default
8) Economics: base rewards + draining + quotas hardening

Each PR must include:
- tests
- migration notes (if state changes)
- backward compatibility notes (especially for existing deals/sessions)

---

## 14) Definition of Done (global)

The agent is done when:
- all phases above are merged (or at least landed behind feature flags),
- CI is green,
- documentation matches behavior,
- and the testnet launch checklist can be executed by a human without tribal knowledge.

