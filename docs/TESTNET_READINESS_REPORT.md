# NilStore Testnet Readiness Report

Date: 2026-01-25

This report is the Phase 8 deliverable from `docs/AGENTS_AUTONOMOUS_RUNBOOK.md`.

## One-command local testnet

Start the full local stack (chain + faucet + gateways + optional web UI):

```bash
./scripts/run_local_stack.sh start
```

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
  - Gateway NilCE compression flag support is exercised by gateway upload/fetch flows; verify via `scripts/e2e_lifecycle.sh` using a compressible file.
- Wallet-first chain writes (MetaMask/EVM signed intents; no relayer required):
  - EVM bridge/precompile flows are exercised by `scripts/e2e_lifecycle.sh` (EVM-signed create + commit).

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
