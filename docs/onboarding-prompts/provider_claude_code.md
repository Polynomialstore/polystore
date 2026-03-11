# Provider Prompt For Claude Code

Set up this machine as a NilStore testnet Storage Provider.

Assumptions:
- The repository is already cloned locally.
- Preferred mode is `home server + Cloudflare Tunnel`.
- Use:
  - `docs/ALPHA_PROVIDER_QUICKSTART.md`
  - `docs/REMOTE_SP_JOIN_QUICKSTART.md`
  - `docs/networking/PROVIDER_ENDPOINTS.md`

Inputs from the hub operator:
- `CHAIN_ID`
- `HUB_NODE`
- `HUB_LCD`
- `NIL_GATEWAY_SP_AUTH`
- provider hostname such as `sp.<domain>`

Tasks:
1. Check the local machine and repo prerequisites.
2. Create or import the provider key.
3. Configure endpoint and local listener values.
4. Register the provider on-chain.
5. Start the provider and persist it under a service manager if appropriate.
6. Verify:
   - local `http://127.0.0.1:8091/health`
   - public `https://sp.<domain>/health`
   - LCD provider visibility
7. Loop on failures until the provider is healthy.

Final output:
- provider address
- registered endpoint
- local and public health URLs
- service status
- files changed
