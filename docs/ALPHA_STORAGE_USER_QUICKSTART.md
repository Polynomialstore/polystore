# Testnet Storage User Quickstart

This is the primary testnet path for users who want to store data on NilStore.

Note: this file keeps a legacy `ALPHA_` prefix for compatibility.

Recommended target:
- full local onboarding with one identity across CLI, MetaMask, browser, and local gateway

Fallback target:
- browser-only flow through `https://nilstore.org` when local gateway or CLI are unavailable

## Recommended Onboarding Order

1. Environment Ready
- Sync the repo locally.
- Start a local gateway at `http://localhost:8080` (Nil Gateway GUI or local `nil_gateway`).
- Confirm required tools are present (`curl`, `jq`, `npm`, and `gh` if available).
- Confirm the website and EVM RPC are reachable.

2. Bootstrap Wallet Locally
- Run `scripts/testnet_burner_upload.sh <file_path> [deal_id] [nilfs_path]` with a small file (recommended: `10-100 KiB`).
- Capture the generated EVM address, mapped `nil1...` address, keystore path, deal ID, manifest root, and commit tx hash.
- Treat this as the first identity bootstrap and create/upload/commit proof.

3. Import the Same Wallet into MetaMask
- Import the exported keystore JSON into MetaMask.
- Confirm the MetaMask address exactly matches the CLI-generated EVM address.
- Confirm the wallet is on the NilStore testnet network and funded.

4. Verify Browser Continuity
- Open `https://nilstore.org`.
- Connect the imported MetaMask wallet.
- Verify the site sees the same address and local gateway.
- Perform retrieval and/or a small browser upload/retrieve using that same wallet.

5. Verify Gateway Large-File Flow
- Re-run upload/commit/retrieve with a larger file (recommended: `64 MiB+`).
- Confirm the flow succeeds with gateway-assisted routing and retrieval.
- Capture evidence: gateway health, route/cache behavior, retrieval match, and any provider endpoint details shown.

6. Run Advanced CLI Checks
- Preferred relay-capable helper: `scripts/enterprise_upload_job.sh <file_path> [deal_id] [nilfs_path]`
- Testnet bootstrap helper: `scripts/testnet_burner_upload.sh <file_path> [deal_id] [nilfs_path]`
- Wallet-first/public path (relay disabled): follow the `Public CLI smoke` section in `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`.
- Capture evidence: command log, deal ID, manifest root, tx hash(es), retrieval match, and friction points.

## Browser-only fallback

1. Open `https://nilstore.org`.
2. Connect MetaMask.
3. Switch to the NilStore testnet network.
4. Fund your wallet through the faucet if available.
5. Create a deal.
6. Upload a small file.
7. Retrieve it back and confirm the bytes match.

## Agent-assisted power-user flow

1. Clone the repo locally.
2. Open your coding agent in the repo.
3. Paste the storage prompt from:
   - `docs/onboarding-prompts/storage.md`
4. Let the agent run as a guided operator:
   - it should walk you through the onboarding milestones in order
   - it should do repo sync and local readiness before website actions
   - it should bootstrap one wallet locally, then hand that wallet off to MetaMask
   - it should ask you to perform wallet and file-picker actions at the right checkpoints
   - it should validate continuity across CLI, browser, and gateway
   - it should produce evidence for wallet identity, gateway health, upload or retrieve success, and CLI friction notes

## References

- Collaborator packet: `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`
- Dashboard flow: `nil-website/src/pages/FirstFile.tsx`
- Testnet storage page: `nil-website/src/pages/AlphaStorage.tsx`

## Success criteria

- Local gateway is healthy
- MetaMask address matches the CLI bootstrap address
- Wallet is connected to the expected chain
- Faucet or manual funding succeeds for the chosen wallet
- Deal creation succeeds
- Upload succeeds
- Retrieval succeeds with matching content
- Browser, CLI, and gateway verification all use the same identity when running the full local path
