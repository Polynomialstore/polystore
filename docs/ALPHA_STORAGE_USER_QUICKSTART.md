# Testnet Storage User Quickstart

This is the primary testnet path for users who want to store data on NilStore.

Note: this file keeps a legacy `ALPHA_` prefix for compatibility.

Recommended target:
- browser-first flow through `https://nilstore.org` (fallback `https://web.nilstore.org` if needed)

Optional power-user target:
- local repo checkout with a coding agent for diagnostics and local gateway setup

## Canonical Upload Paths (in order)

1. First File Wizard (small file, browser-first)
- Open `https://nilstore.org`.
- Use the First File wizard and upload a small file (recommended: `10-100 KiB`).
- Complete create deal -> upload/commit -> retrieve.
- Capture evidence: deal ID, tx hash(es), retrieval match.

2. Local Gateway path (large file)
- Start a local gateway at `http://localhost:8080` (Nil Gateway GUI or local `nil_gateway`).
- Re-run the upload flow with a larger file (recommended: `64 MiB+`).
- Confirm the flow succeeds with gateway-assisted routing and retrieval.
- Capture evidence: gateway health, route/cache behavior, retrieval match.

3. CLI upload path (optimistic, UX in progress)
- Preferred helper path (local relay-capable environment): `scripts/enterprise_upload_job.sh <file_path> [deal_id] [nilfs_path]`
- Wallet-first/public path (relay disabled): follow the `Public CLI smoke` section in `docs/TRUSTED_DEVNET_SOFT_LAUNCH.md`.
- Capture evidence: command log, deal ID, manifest root, tx hash(es), retrieval match, and friction points.

## Browser-first flow

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
   - it should walk you through the three canonical paths in order
   - it should do repo sync first, then immediately move you into the website flow
   - it should ask you to perform wallet/file-picker actions in the browser
   - it should validate each checkpoint (connect, fund, create, upload, commit, retrieve)
   - it should produce evidence (deal ID, tx hashes, file details, retrieval match, and CLI friction notes)

## References

- Collaborator packet: `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`
- Dashboard flow: `nil-website/src/pages/FirstFile.tsx`
- Testnet storage page: `nil-website/src/pages/AlphaStorage.tsx`

## Success criteria

- Wallet is connected to the expected chain
- Faucet or manual funding succeeds
- Deal creation succeeds
- Upload succeeds
- Retrieval succeeds with matching content
