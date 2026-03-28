# Testnet Storage User Quickstart

This is the primary testnet path for users who want to store data on NilStore.

Note: this file keeps a legacy `ALPHA_` prefix for compatibility.

Recommended target:
- browser-first flow through `https://nilstore.org` (fallback `https://web.nilstore.org` if needed)

Optional power-user target:
- local repo checkout with a coding agent for diagnostics and local gateway setup

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
   - it should ask you to perform wallet/file-picker actions in the browser
   - it should validate each checkpoint (connect, fund, create, upload, commit, retrieve)
   - it should produce evidence (deal ID, tx hashes, file details, retrieval match)

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
