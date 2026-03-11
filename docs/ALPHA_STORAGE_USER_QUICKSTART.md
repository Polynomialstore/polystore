# Testnet Storage User Quickstart

This is the primary testnet path for users who want to store data on NilStore.

Note: this file keeps a legacy `ALPHA_` prefix for compatibility.

Recommended target:
- browser-first flow through `https://web.<domain>`

Optional power-user target:
- local repo checkout with Codex or Claude Code for diagnostics and local gateway setup

## Browser-first flow

1. Open `https://web.<domain>`.
2. Connect MetaMask.
3. Switch to the NilStore testnet network.
4. Fund your wallet through the faucet if available.
5. Create a deal.
6. Upload a small file.
7. Retrieve it back and confirm the bytes match.

## Agent-assisted power-user flow

1. Clone the repo locally.
2. Open Codex or Claude Code in the repo.
3. Paste the storage prompt from:
   - `docs/onboarding-prompts/storage_codex.md`
   - `docs/onboarding-prompts/storage_claude_code.md`
4. Let the agent verify wallet/network setup, local gateway health, and the first store/retrieve cycle.

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
