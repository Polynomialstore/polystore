# AGENTS TODO — Project Review → Spec/Doc Sync → Trusted Devnet Soft Launch (Feb 2026)

Last updated: 2026-02-05

This file is a **repo-tracked, PR-by-PR TODO list** for getting NilStore to a
**trusted-collaborator devnet soft launch** (hub VPS + remote SPs).

Conventions:
- One PR per section (small, reviewable, test-gated).
- Branch names use the `codex/` prefix.
- Before pushing, run the **Test gate** listed for that PR.
- After merging a PR, come back and check it off in a follow-up PR.

## Launch profile (decisions locked)

- Devnet type: **Trusted devnet** (hub on VPS + remote SPs)
- Collaborators: **10–20**, invite-only; run for **2–3 weeks**
- Economics posture: **low-cost but non-zero** (no “free infinite”)
- Endpoints: **HTTPS subdomains** (e.g. `rpc.*`, `lcd.*`, `gateway.*`, `web.*`, `faucet.*`)
- Deploy style: **systemd** services + static website build
- Faucet: **enabled** (rate-limited; collaborator-only)

## PR plan

### PR1 — Docs reality check + gap matrix (MERGED)

- Branch: `codex/docs-review-gap-matrix`
- Goal: Make it obvious **what exists**, **what CI proves**, and **what is still a gap**.
- PR: https://github.com/Nil-Store/nil-store/pull/57
- Test gate:
  - `bash -n install.sh`

Checklist:
- [x] Add this TODO file.
- [x] Update `docs/GAP_REPORT_REPO_ANCHORED.md` to match repo reality + CI coverage.
- [x] Fix doc index and onboarding docs (`DOCS.md`, `HAPPY_PATH.md`, `docs/TESTNET_READINESS_REPORT.md`).
- [x] Update repo-anchored agent runbook (`docs/AGENTS_RUNBOOK_REPO_ANCHORED.md`).
- [x] Replace Ignite boilerplate chain readme (`nilchain/readme.md`).
- [x] Fix `install.sh` CLI binary name (`nil_cli` vs `nil-cli`).

---

### PR2 — Spec-critical invariants (hard caps + safety rails) (MERGED)

- Branch: `codex/spec-invariants-hard-caps`
- Goal: Close the most dangerous “spec says enforced, code doesn’t” gaps.
- PR: https://github.com/Nil-Store/nil-store/pull/58
- Test gate:
  - `cd nilchain && go test ./...`

Checklist:
- [x] Enforce `MAX_DEAL_BYTES` cap in `MsgUpdateDealContent*` (spec + RFC requirement).
- [x] Add unit tests for cap enforcement and error messages.
- [x] Update `spec.md`/RFC cross-links only if needed (keep spec normative; track implementation status in gap report).

---

### PR3 — Wallet-first local E2E (no relay, no hidden signer) (MERGED)

- Branch: `codex/e2e-wallet-first-no-relay`
- Goal: Prove “no relay” posture works for real flows (not just docs).
- PR: https://github.com/Nil-Store/nil-store/pull/59
- Test gate:
  - `scripts/e2e_browser_libp2p_relay.sh`
  - (optional) `scripts/e2e_browser_smoke_no_gateway.sh`

Checklist:
- [x] Add/extend an E2E script that runs with `NIL_ENABLE_TX_RELAY=0` and still completes create/commit/open-session/fetch.
- [x] Document the exact env var profile in `HAPPY_PATH.md` + `docs/TESTNET_READINESS_REPORT.md`.

---

### PR4 — Mode2 stripe integrity: byte-for-byte retrieval assertion (MERGED)

- Branch: `codex/mode2-stripe-bytes-assert`
- Goal: Upgrade the Mode2 Stripe E2E signal from “downloaded something” to “downloaded the right bytes”.
- PR: https://github.com/Nil-Store/nil-store/pull/60
- Test gate:
  - `scripts/e2e_mode2_stripe_multi_sp.sh`

Checklist:
- [x] Update `nil-website/tests/mode2-stripe.spec.ts` to assert downloaded bytes (or hash) == uploaded.
- [x] Ensure the test continues to work with chunked/ranged gateway fetches.
- [x] Fix Mode2 provider→provider shard fetches: `/sp/shard` requires `X‑Nil‑Gateway‑Auth` and no longer enforces the user session range across the full shard leaf interval (router still enforces user sessions on `/gateway/fetch`).

---

### PR5 — Allowlist access control test vectors (chain) (MERGED)

- Branch: `codex/allowlist-merkle-tests`
- Goal: Turn allowlist logic from “implemented” into “proven”.
- PR: https://github.com/Nil-Store/nil-store/pull/61
- Test gate:
  - `cd nilchain && go test ./...`

Checklist:
- [x] Add unit tests for `OpenRetrievalSessionSponsored` allowlist proof verification (valid + invalid paths).
- [x] Add deterministic merkle test vectors (keccak leaves, indices, paths).

---

### PR6 — Trusted devnet “soft launch” pack (ops + onboarding) (MERGED)

- Branch: `codex/devnet-soft-launch-pack`
- Goal: Make onboarding a collaborator a **30-minute task**, not an archeological dig.
- PR: https://github.com/Nil-Store/nil-store/pull/62
- Test gate:
  - `scripts/run_devnet_alpha_multi_sp.sh start` (local smoke)

Checklist:
- [x] Write `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md` (roles, endpoints, funding, troubleshooting).
- [x] Add systemd unit templates + env-file templates for hub services.
- [x] Add a “remote SP join” quickstart (based on `DEVNET_MULTI_PROVIDER.md`, but simplified).
- [x] Add basic monitoring checklist (disk, RAM, ports, logs, chain height).

---

### PR7 — Website onboarding overhaul (collaborator UX) (MERGED)

- Branch: `codex/website-onboarding-overhaul`
- Goal: A collaborator can store and retrieve a file with minimal context.
- PR: https://github.com/Nil-Store/nil-store/pull/63
- Test gate:
  - `npm -C nil-website run test:unit`
  - `npm -C nil-website run build`

Checklist:
- [x] Guided “First File” flow (connect → fund → alloc → upload → commit → retrieve).
- [x] Prominent environment/status panel (chain/gateway/provider health).
- [x] Copy-paste “share this with the devs” diagnostics bundle.

---

### PR8 — Dynamic pricing experiments (storage + retrieval) (MERGED)

- Branch: `codex/dynamic-pricing-mvp`
- Goal: Add a testable first version of dynamic pricing without destabilizing the devnet.
- PR: https://github.com/Nil-Store/nil-store/pull/64
- Test gate:
  - `cd nilchain && go test ./...`
  - `./e2e_retrieval_fees.sh`

Checklist:
- [x] Define the minimal on-chain signal(s) (params vs. oracle vs. epoch-derived).
- [x] Implement pricing update mechanism + bounds.
- [x] Add simulation harness + invariants (no negative fees, monotonicity caps, etc.).

Notes (MVP design):
- Epoch-derived signals only (no oracle): storage utilization + prior-epoch retrieval demand.
- Bounded, opt-in controller: min/max bounds + optional per-epoch step clamp; disabled by default.

---

### PR9 — Devnet economics knobs (genesis overrides + dynamic pricing enable) (MERGED)

- Branch: `codex/dynamic-pricing-devnet-wiring`
- Goal: Make trusted devnet economics configurable (and make dynamic pricing easy to toggle on for experiments).
- PR: https://github.com/Nil-Store/nil-store/pull/65
- Test gate:
  - `bash -n scripts/run_devnet_alpha_multi_sp.sh`

Checklist:
- [x] Add genesis override env vars in `scripts/run_devnet_alpha_multi_sp.sh` for pricing + dynamic pricing params.
- [x] Document the overrides + example launch command in `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`.
- [x] Add a monitoring check for pricing params in `docs/TRUSTED_DEVNET_MONITORING_CHECKLIST.md`.

---

### PR10 — Faucet access control (auth token) + remove stale endpoints (CURRENT)

- Branch: `codex/faucet-auth-token`
- Goal: Make the devnet faucet truly “collaborator-only” and reduce exposed surface area.
- Test gate:
  - `cd nil_faucet && go test ./...`

Checklist:
- [x] Add optional auth token (`NIL_FAUCET_AUTH_TOKEN`) required via `X-Nil-Faucet-Auth`.
- [x] Improve rate limiting IP parsing (use forwarded headers / host-only).
- [x] Remove stale `/create-deal` endpoint from `nil_faucet`.
- [x] Update trusted devnet docs + systemd env template with the auth knob.
