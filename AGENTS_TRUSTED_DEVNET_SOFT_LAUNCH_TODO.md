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

### PR10 — Faucet access control (auth token) + remove stale endpoints (MERGED)

- Branch: `codex/faucet-auth-token`
- Goal: Make the devnet faucet truly “collaborator-only” and reduce exposed surface area.
- PR: https://github.com/Nil-Store/nil-store/pull/66
- Test gate:
  - `cd nil_faucet && go test ./...`

Checklist:
- [x] Add optional auth token (`NIL_FAUCET_AUTH_TOKEN`) required via `X-Nil-Faucet-Auth`.
- [x] Improve rate limiting IP parsing (use forwarded headers / host-only).
- [x] Remove stale `/create-deal` endpoint from `nil_faucet`.
- [x] Update trusted devnet docs + systemd env template with the auth knob.

---

### PR11 — Website faucet auth token (collaborator UX) (MERGED)

- Branch: `codex/website-faucet-auth-token`
- Goal: Allow token-protected faucet funding from the website UI (without baking secrets into the build).
- PR: https://github.com/Nil-Store/nil-store/pull/67
- Test gate:
  - `npm -C nil-website run test:unit`
  - `npm -C nil-website run build`

Checklist:
- [x] Add localStorage-backed faucet auth token helper.
- [x] Send `X-Nil-Faucet-Auth` header from `useFaucet` when token is set.
- [x] Add UI input (Dashboard + First File wizard + Testnet Docs) for collaborators to paste/save/clear the token.
- [x] Update trusted devnet docs with the UI token flow.

---

### PR12 — Caddy reverse proxy templates (HTTPS subdomains) (MERGED)

- Branch: `codex/caddy-reverse-proxy-templates`
- Goal: Provide copy/paste TLS reverse proxy configs for hub + providers to match the soft-launch endpoint profile.
- PR: https://github.com/Nil-Store/nil-store/pull/68
- Test gate:
  - `bash -n scripts/run_devnet_provider.sh`

Checklist:
- [x] Add hub/provider example Caddyfiles under `ops/caddy/`.
- [x] Link templates from `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md` + `ops/systemd/README.md`.
- [x] Update remote SP join quickstart to mention HTTPS endpoint variants.

---

### PR13 — Gap report sync (post-PR12) (MERGED)

- Branch: `codex/gap-report-sync`
- Goal: Keep `docs/GAP_REPORT_REPO_ANCHORED.md` aligned with merged PR reality (no stale “planned fix” refs).
- PR: https://github.com/Nil-Store/nil-store/pull/69
- Test gate:
  - `bash -n install.sh`

Checklist:
- [x] Mark PR12 as merged in this tracker.
- [x] Update `docs/GAP_REPORT_REPO_ANCHORED.md` to reflect current CI assertions (Mode2 byte equality + allowlist proof vectors).
- [x] Add next PR skeleton(s) for remaining trusted-devnet soft-launch work.

---

### PR14 — Stabilize Mode2 Stripe E2E (CI determinism) (MERGED)

- Branch: `codex/mode2-stripe-e2e-stability`
- Goal: Make Mode2 Stripe E2E stable on shared CI runners (reduce background contention).
- PR: https://github.com/Nil-Store/nil-store/pull/70
- Test gate:
  - `bash -n scripts/e2e_mode2_stripe_multi_sp.sh`

Checklist:
- [x] Disable the background system liveness prover during this E2E run (`NIL_DISABLE_SYSTEM_LIVENESS=1` default).
- [x] Cap Mode2 upload parallelism (`NIL_MODE2_UPLOAD_PARALLELISM=16` default).
- [x] Keep both knobs overrideable for local stress runs.

---

### PR15 — Hub VPS “blank box → running devnet” runbook (systemd + caddy + web build) (MERGED)

- Branch: `codex/hub-vps-runbook`
- Goal: Make hub deployment a copy/paste process (DNS → build → systemd → caddy → verify).
- PR: https://github.com/Nil-Store/nil-store/pull/71
- Test gate:
  - `bash -n scripts/run_devnet_alpha_multi_sp.sh`

Checklist:
- [x] Add a hub operator runbook section: required ports, DNS records, Caddy install + reload, and systemd enable/start order.
- [x] Document `nil-website` build env for HTTPS subdomains (`VITE_LCD_BASE`, `VITE_EVM_RPC`, `VITE_GATEWAY_BASE`, `VITE_API_BASE`, `VITE_COSMOS_CHAIN_ID`, `VITE_CHAIN_ID`).
- [x] Add a “MetaMask add network” snippet (RPC URL, chain id, currency, explorer placeholder).

---

### PR16 — Devnet healthcheck script (hub + provider) (MERGED)

- Branch: `codex/devnet-healthcheck-script`
- Goal: Replace “tribal knowledge” monitoring with a single script that fails loudly when the devnet is unhealthy.
- PR: https://github.com/Nil-Store/nil-store/pull/72
- Test gate:
  - `bash -n scripts/devnet_healthcheck.sh`

Checklist:
- [x] Add `scripts/devnet_healthcheck.sh` (hub mode + provider mode) to validate RPC/LCD/EVM/gateway/faucet/health endpoints.
- [x] Wire the script into `docs/TRUSTED_DEVNET_MONITORING_CHECKLIST.md` as an optional daily check.

---

### PR17 — Mode2 Stripe E2E flake reduction (gateway readiness + retries) (MERGED)

- Branch: `codex/mode2-stripe-e2e-retry`
- Goal: Reduce CI flakes in `scripts/e2e_mode2_stripe_multi_sp.sh` by waiting for the local gateway “Connected” state and adding a single retry for the Mode2 Stripe suite in CI.
- PR: https://github.com/Nil-Store/nil-store/pull/73
- Test gate:
  - `npm -C nil-website run test:unit`
  - `npm -C nil-website run lint`
  - `bash -n scripts/e2e_mode2_stripe_multi_sp.sh`

Checklist:
- [x] Add a stable selector/attribute for gateway connection status (so Playwright can wait for it).
- [x] Update `nil-website/tests/mode2-stripe.spec.ts` to wait for gateway “Connected” before selecting files.
- [x] Add a single CI retry for the Mode2 Stripe suite (targeted; not global).

---

### PR18 — Provider onboarding polish (quickstart + systemd + HTTPS + healthcheck) (MERGED)

- Branch: `codex/provider-onboarding-polish`
- Goal: Make a remote SP join (and stay running) feel copy/paste: quickstart docs reference systemd templates, HTTPS proxy options, and the healthcheck script.
- PR: https://github.com/Nil-Store/nil-store/pull/74
- Test gate:
  - `bash -n scripts/run_devnet_provider.sh`

Checklist:
- [x] Update `docs/REMOTE_SP_JOIN_QUICKSTART.md` to reference:
  - `ops/systemd/nil-gateway-provider.service` + `ops/systemd/env/nil-gateway-provider.env`
  - `ops/caddy/Caddyfile.provider.example` for HTTPS
  - `scripts/devnet_healthcheck.sh provider ...` for verification
- [x] Add a short “provider systemd” snippet to `ops/systemd/README.md`.

---

### PR19 — Hub ops safety defaults (bind to localhost by default) (MERGED)

- Branch: `codex/hub-local-bind-defaults`
- Goal: Reduce accidental public exposure of hub-local ports by making the systemd env templates default to localhost bindings (Caddy stays the public entrypoint).
- PR: https://github.com/Nil-Store/nil-store/pull/75
- Test gate:
  - `bash -n scripts/run_devnet_alpha_multi_sp.sh`

Checklist:
- [x] Update `ops/systemd/env/nilchaind.env` to default CometBFT RPC to localhost.
- [x] Update `ops/systemd/env/nil-gateway-router.env` to default router listen addr to localhost.
- [x] Add a brief note in `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md` that these are safe defaults for the HTTPS subdomain profile.

---

### PR20 — Faucet safe bind default (listen addr) (MERGED)

- Branch: `codex/faucet-listen-addr`
- Goal: Make the hub faucet bind to localhost by default (Caddy remains the public entrypoint).
- PR: https://github.com/Nil-Store/nil-store/pull/78
- Test gate:
  - `cd nil_faucet && go test ./...`

Checklist:
- [x] Add `NIL_LISTEN_ADDR` support to `nil_faucet` (default `127.0.0.1:8081`).
- [x] Update `ops/systemd/env/nil-faucet.env` to set `NIL_LISTEN_ADDR=127.0.0.1:8081`.
- [x] Update `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md` to remove the “firewall-only” faucet bind note.

---

### PR21 — Bootstrap scripts: local-only LCD/EVM binds by default (MERGED)

- Branch: `codex/hub-bootstrap-local-binds`
- Goal: Align the bootstrap scripts with the hub safety posture: bind LCD + EVM JSON-RPC to localhost by default, with an opt-in for `0.0.0.0` when needed.
- PR: https://github.com/Nil-Store/nil-store/pull/80
- Test gate:
  - `bash -n scripts/run_devnet_alpha_multi_sp.sh`
  - `bash -n scripts/run_local_stack.sh`

Checklist:
- [x] Add `NIL_BIND_ALL=1` knob (default `0`) to opt into `0.0.0.0` binds for LCD/EVM JSON-RPC.
- [x] Update `scripts/run_devnet_alpha_multi_sp.sh` init-time config patching to respect `NIL_BIND_ALL`.
- [x] Update `scripts/run_local_stack.sh` init-time config patching (perl + python fallback) to respect `NIL_BIND_ALL`.
- [x] Document the knob in `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md` (LAN / non-proxy debugging use only).

---

### PR22 — Bootstrap script: guard against accidental `rm -rf` of persistent home (MERGED)

- Branch: `codex/hub-bootstrap-rmrf-guard`
- Goal: Reduce hub footguns by making `run_devnet_alpha_multi_sp.sh start` refuse to delete a non-artifacts `NIL_HOME` unless explicitly opted-in.
- PR: https://github.com/Nil-Store/nil-store/pull/82
- Test gate:
  - `bash -n scripts/run_devnet_alpha_multi_sp.sh`

Checklist:
- [x] Add `NIL_REINIT_HOME=1` (or similar) opt-in before deleting an existing `NIL_HOME` outside the repo `_artifacts/` tree.
- [x] Update `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md` bootstrap command to include the new opt-in when using a persistent hub home.

---

### PR23 — Local stack bootstrap: guard against accidental `rm -rf` of persistent home (MERGED)

- Branch: `codex/local-stack-rmrf-guard`
- Goal: Mirror the hub bootstrap safety rails in `run_local_stack.sh` so `NIL_HOME` can’t be accidentally wiped without an explicit opt-in.
- PR: https://github.com/Nil-Store/nil-store/pull/84
- Test gate:
  - `bash -n scripts/run_local_stack.sh`

Checklist:
- [x] Add `NIL_REINIT_HOME=1` (or similar) opt-in before deleting an existing `NIL_HOME` outside the repo `_artifacts/` tree.
- [x] Update any local-stack docs that recommend `NIL_HOME=...` to mention the opt-in for re-init runs.

---

### PR24 — Local stack docs: safe reset + `NIL_REINIT_HOME` note (MERGED)

- Branch: `codex/local-stack-reset-docs`
- Goal: Make local dev runs safer and less confusing by documenting when the stack can wipe state, and how to intentionally reset.
- PR: https://github.com/Nil-Store/nil-store/pull/86
- Test gate:
  - `bash -n scripts/run_local_stack.sh`

Checklist:
- [x] Add a short “Reset state” note to `HAPPY_PATH.md` (default `_artifacts` is safe; persistent `NIL_HOME` requires `NIL_REINIT_HOME=1`).
- [x] Update `docs/TESTNET_READINESS_REPORT.md` to mention `NIL_REINIT_HOME` and bump the report date.
- [x] Update `docs/manual-devnet-runbook.md` prerequisites to mention safe reset behavior (and how to opt into wiping a persistent home).

---

### PR25 — Repo-anchored agent runbook refresh (CI truth + devnet tracker links) (MERGED)

- Branch: `codex/agents-runbook-refresh`
- Goal: Make the repo-anchored agent runbook match current CI reality and link to the trusted devnet tracker/docs.
- PR: https://github.com/Nil-Store/nil-store/pull/87
- Test gate:
  - `bash -n scripts/run_local_stack.sh`

Checklist:
- [x] Mark PR24 as MERGED (this PR is the follow-up).
- [x] Refresh `docs/AGENTS_RUNBOOK_REPO_ANCHORED.md` (Feb 2026 reality: CI jobs, test gates, and doc index pointers).

---

### PR26 — Gap report CI truth + docs index pointer (MERGED)

- Branch: `codex/gap-report-ci-truth`
- Goal: Make it explicit what CI jobs prove (and don’t) and make the doc index point to the repo-anchored agent runbook.
- PR: https://github.com/Nil-Store/nil-store/pull/88
- Test gate:
  - `bash -n install.sh`

Checklist:
- [x] Update `docs/GAP_REPORT_REPO_ANCHORED.md` CI section to match `.github/workflows/ci.yml` (Foundry, parity, Tauri, and E2E suites).
- [x] Update `DOCS.md` to include `docs/AGENTS_RUNBOOK_REPO_ANCHORED.md` in the Agent Runbooks section.

---

### PR27 — Trusted devnet go/no-go checklist (MERGED)

- Branch: `codex/devnet-go-no-go-checklist`
- Goal: Add a crisp, operator-focused checklist for when we’re ready to invite collaborators (and what to verify first).
- PR: https://github.com/Nil-Store/nil-store/pull/89
- Test gate:
  - `bash -n scripts/run_devnet_alpha_multi_sp.sh`

Checklist:
- [x] Add a “Go/No-Go checklist” section to `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md` (hub + provider + website + smoke).

---

### PR28 — Trusted devnet collaborator packet (invite + quickstart) (CURRENT)

- Branch: `codex/devnet-collaborator-packet`
- Goal: Give hub operators a single “send this to collaborators” doc covering website testing + (optional) SP joining.
- PR: (pending)
- Test gate:
  - `bash -n scripts/run_devnet_alpha_multi_sp.sh`

Checklist:
- [x] Add `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md` (website tester path + SP operator path).
- [x] Link it from `DOCS.md` (Implementation Onboarding section).
