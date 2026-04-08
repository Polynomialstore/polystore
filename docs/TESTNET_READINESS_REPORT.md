# PolyStore Testnet Readiness Report

Date: 2026-02-05

This report is the Phase 8 deliverable from `docs/AGENTS_AUTONOMOUS_RUNBOOK.md`.

## One-command local testnet

Start the full local stack (chain + faucet + gateways + optional web UI):

```bash
./scripts/run_local_stack.sh start
```

Notes:
- `run_local_stack.sh start` **always re-initializes** the chain home.
- Default home is `_artifacts/nilchain_data`. If you set `NIL_HOME` outside `_artifacts/`, the script will refuse to wipe it unless you set `NIL_REINIT_HOME=1`.

Stop everything started by the script:

```bash
./scripts/run_local_stack.sh stop
```

### Mainnet parity profile (wallet-first, no faucet)

Run the same local stack but without the dev faucet, auto-funding, or tx relay:

```bash
NIL_START_FAUCET=0 NIL_AUTO_FAUCET_EVM=0 NIL_ENABLE_TX_RELAY=0 ./scripts/run_local_stack.sh start
```

Notes:
- This is the intended “wallet-first / no-relay / no-faucet dependency” posture.
- You will need to fund accounts via genesis or manual transfers.

## One-command end-to-end suite

Runs a full lifecycle test (stack start -> create deal -> upload -> commit -> fetch -> stack stop):

```bash
./scripts/e2e_lifecycle.sh
```

Notes:
- This script is intentionally “dev convenient”: it enables the gateway tx relay and faucet so
  the run is deterministic and does not require a real wallet UX.
- “Wallet-first / no relay” posture is covered by the Playwright suites (see below).

## Manual devnet runbook

For a choreography that mirrors the automated suites but is executed manually (create/upload/commit/fetch, multi-SP proofs, deputy repair, economic checks), follow `docs/manual-devnet-runbook.md`. Keep it in sync with the scripts listed above so the steps remain accurate as the system evolves.

## Trusted devnet soft launch (hub + remote providers)

When you are ready to invite **trusted collaborators** (WAN, multi-host), use these docs:

- Hub + provider operator pack: `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`
  - Includes: **Go/No-Go checklist** (“are we ready to invite people?”)
- “Send this to collaborators” packet: `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`
- Remote SP join quickstart (fast path): `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- Minimal monitoring checklist: `docs/TRUSTED_DEVNET_MONITORING_CHECKLIST.md`

## Verification checklist (gates)

All items below are expected to be verifiable via the unit tests and/or the e2e scripts.

- Deal expiry + extend:
  - Unit tests: `nilchain/x/nilchain/keeper/msg_server_extend_deal_test.go`
- Mandatory retrieval sessions:
  - Chain session enforcement + range checks: `nilchain/x/nilchain/keeper/msg_server_retrieval_sessions_test.go`
  - Gateway-required header enforcement: exercised by `scripts/e2e_open_retrieval_session_cli.sh` and `scripts/e2e_lifecycle.sh`
- Retrieval access control modes (restricted / allowlist / voucher / public):
  - Unit tests: `nilchain/x/nilchain/keeper/msg_server_sponsored_sessions_test.go`
- Voucher one-time use / replay prevention:
  - Unit test: `nilchain/x/nilchain/keeper/msg_server_sponsored_sessions_test.go:TestSponsoredOpen_Voucher_ReplayRejected`
- Protocol audit/repair retrieval sessions (protocol budget funded):
  - Audit budget + task derivation tests: `nilchain/x/nilchain/keeper/epoch_audit_test.go`
  - Protocol session open/consume tests: `nilchain/x/nilchain/keeper/msg_server_protocol_sessions_test.go`
- Compression round-trip:
  - NilCE v1 is **opt-in** (`NIL_NILCE=0` by default). The encode/decode helpers are unit-tested in `polystore_gateway/nilce_test.go`.
  - CI does not currently require NilCE-enabled end-to-end coverage.
- Wallet-first chain writes (MetaMask/EVM signed intents; no relayer required):
  - Covered by Playwright E2E flows (in-page E2E wallet when `VITE_E2E=1`), not by `scripts/e2e_lifecycle.sh`.

## Provider draining / controlled churn (Phase 7)

Provider draining is implemented as:
- On-chain flag: `Provider.draining`
- Tx: `MsgSetProviderDraining`
- Placement filter: draining providers are excluded from new assignments and repair candidate selection.
- Epoch-end deterministic drain scheduler (Mode2-only) bounded by:
  - `Params.max_drain_bytes_per_epoch`
  - `Params.max_repairing_bytes_ratio_bps` (optional global cap)

Unit tests:
- `nilchain/x/nilchain/keeper/draining_test.go`

## How to run unit tests

```bash
cd nilchain
go test ./...
```

## What remains / known gaps

- Mode1 does not yet have explicit make-before-break churn state (drain/rotation schedulers are Mode2-only).
- Mode2 Stripe Playwright E2E asserts **byte-for-byte equality** between uploaded and downloaded payloads (`polystore-website/tests/mode2-stripe.spec.ts`).

## CI does NOT prove (read before inviting collaborators)

CI is **single-machine**. It is a strong regression signal, but it does not replace a real WAN rehearsal.

- WAN / multi-host behavior (real latency, NAT, TLS, firewalling)
- Long-running durability (restarts, disk pressure, compaction, GC)
- Full cryptoeconomic adversarial behavior (griefing, bribery, strategic downtime)
- Comprehensive security review / external audit

For a spec↔code↔CI matrix (and what is explicitly “not proven yet”), see `docs/GAP_REPORT_REPO_ANCHORED.md`.
