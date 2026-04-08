# Testnet Storage User Quickstart

This is the primary testnet path for users who want to store data on PolyStore.

Note: this file keeps a legacy `ALPHA_` prefix for compatibility.

Recommended target:
- fast local onboarding with one identity across CLI, MetaMask, browser, and local Gateway GUI

Fallback target:
- browser-only flow through `https://polynomialstore.com/#/first-file` when local gateway or CLI are unavailable

## Recommended Onboarding Order

1. Fast Bootstrap
- Sync the repo locally.
- Reuse an already healthy local gateway on `http://localhost:8080` if one is running; otherwise install and open Nil Gateway GUI so it owns that address.
- macOS: use the latest release `.dmg` for Apple Silicon or Intel, install `polystore_gateway_gui.app`, and approve the first launch in Gatekeeper if prompted.
- Linux: use the latest release `.deb` on Ubuntu or Debian, or `.rpm` on RPM-based systems, then launch `polystore_gateway_gui` from the app menu or shell.
- Confirm required tools are present (`bash`, `curl`, `jq`, `node`, `npm`, `python3`, and `nilchaind`; `gh` optional).
- Confirm the hosted LCD and faucet are reachable.
- Use the repo-tracked public testnet bootstrap defaults from `.env.testnet.public` unless you intentionally need overrides.
- Before running the burner helper, set a keystore password in `NIL_BURNER_KEYSTORE_PASSWORD` so the exported JSON can be imported into MetaMask.
- Do not rely on the helper's interactive password prompt during an agent-driven run; set `NIL_BURNER_KEYSTORE_PASSWORD` first.
- Run `scripts/testnet_burner_upload.sh <file_path>` with a small file (recommended: `10-100 KiB`); use `[deal_id] [nilfs_path]` only when resuming or overriding defaults.
- Capture the generated EVM address, mapped `nil1...` address, keystore path, deal ID, manifest root, create tx hash, and commit tx hash.
- Treat this as the first autonomous completion milestone, then preserve that same wallet and deal state through the rest of the run.

2. Import the Same Wallet into MetaMask
- Import the exported keystore JSON into MetaMask.
- Confirm the MetaMask address exactly matches the CLI-generated EVM address.
- Confirm the wallet is on the PolyStore testnet network and funded.

3. Verify Browser Continuity
- Confirm the website and EVM RPC are reachable.
- Open `https://polynomialstore.com/#/first-file`.
- Connect the imported MetaMask wallet.
- Verify the site sees the same address and the local gateway on `http://localhost:8080`.
- After deal allocation on `/#/first-file`, continue to `https://polynomialstore.com/#/dashboard` for upload, retrieval, and file listing.
- Perform retrieval and/or a small browser upload/retrieve using that same wallet on `/#/dashboard`.

4. Verify Gateway Large-File Flow
- Re-run upload/commit/retrieve with a larger file (recommended: `64 MiB+`).
- Confirm the flow succeeds with gateway-assisted routing and retrieval.
- Capture evidence: gateway health, route/cache behavior, retrieval match, and any provider endpoint details shown.

5. Run Advanced CLI Checks
- Preferred local-gateway helper: `scripts/enterprise_upload_job.sh <file_path> [deal_id] [nilfs_path]`
  - use it only after the burner flow or another step has already provided `EVM_PRIVKEY` and a healthy local gateway at `http://localhost:8080`
- Testnet bootstrap helper: `scripts/testnet_burner_upload.sh <file_path> [deal_id] [nilfs_path]`
- Wallet-first/public path (relay disabled): follow the `Public CLI smoke` section in `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`.
- Capture evidence: command log, deal ID, manifest root, tx hash(es), retrieval match, and friction points.

## Browser-only fallback

1. Open `https://polynomialstore.com/#/first-file`.
2. Connect MetaMask.
3. Switch to the PolyStore testnet network.
4. Fund your wallet through the faucet if available.
5. Create a deal on `/#/first-file`.
6. Continue to `/#/dashboard`.
7. Upload a small file.
8. Retrieve it back and confirm the bytes match.

## Agent-assisted power-user flow

1. Clone the repo locally.
2. Open your coding agent in the repo.
3. Paste the storage prompt from:
   - `docs/onboarding-prompts/storage.md`
4. Let the agent run as a guided operator:
   - it should walk you through the onboarding milestones in order
   - it should sync the repo, reuse an already healthy local gateway when available, otherwise install or open Nil Gateway GUI, and verify `http://localhost:8080/health`
   - on macOS it should choose the matching Apple Silicon or Intel `.dmg`, install or open `polystore_gateway_gui.app`, and only pause for Gatekeeper approval
   - on Linux it should prefer `.deb` or `.rpm` release packages, launch `polystore_gateway_gui`, and only fall back to a source build if the packaged install path is blocked
   - it should use the repo-tracked public testnet defaults for hosted faucet or chain access instead of setting up a local faucet
   - it should ask for the keystore import password before invoking `scripts/testnet_burner_upload.sh` if `NIL_BURNER_KEYSTORE_PASSWORD` is unset, rather than hanging on the helper's interactive prompt
   - it should create the tiny bootstrap file and complete `scripts/testnet_burner_upload.sh` first, then hand that wallet off to MetaMask
   - it should proceed autonomously through local setup and CLI bootstrap, and only pause for wallet approvals, OS security prompts, browser connection steps, or file-picker actions
   - it should preserve the same wallet, keystore, deal, and gateway state after Fast Bootstrap succeeds unless you explicitly ask it to reset
   - it should validate continuity across CLI, browser, and gateway
   - it should produce evidence for wallet identity, gateway health, upload or retrieve success, and CLI friction notes

## References

- Collaborator packet: `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`
- Dashboard flow: `polystore-website/src/pages/FirstFile.tsx`
- Testnet storage page: `polystore-website/src/pages/AlphaStorage.tsx`

## Success criteria

- Local gateway is healthy
- Burner upload succeeds with a small file
- MetaMask address matches the CLI bootstrap address
- Wallet is connected to the expected chain
- Faucet or manual funding succeeds for the chosen wallet
- Deal creation succeeds
- Upload succeeds
- Retrieval succeeds with matching content
- Browser, CLI, and gateway verification all use the same identity when running the full local path
