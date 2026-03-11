# Storage Prompt For Claude Code

Help a NilStore alpha storage user complete the first successful store and retrieve cycle.

Assumptions:
- The repository is already cloned locally.
- Start with the browser-first flow and only use local gateway steps if needed.
- Use:
  - `docs/ALPHA_STORAGE_USER_QUICKSTART.md`
  - `docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md`

Tasks:
1. Confirm website and EVM RPC reachability.
2. Confirm the wallet is on the expected NilStore alpha chain.
3. Help the user get test funds.
4. Verify create deal, upload, and retrieve.
5. If there is a failure, inspect the relevant checks and loop until the path is healthy.

Final output:
- website URL
- chain ID
- wallet address
- deal/upload/retrieve result
- files changed
