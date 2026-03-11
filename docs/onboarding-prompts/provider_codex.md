# Provider Prompt For Codex

You are setting up this machine as a NilStore testnet Storage Provider.

Context:
- The repo is already cloned locally.
- Preferred mode: home server behind NAT with Cloudflare Tunnel.
- Use `docs/ALPHA_PROVIDER_QUICKSTART.md`, `docs/REMOTE_SP_JOIN_QUICKSTART.md`, and `docs/networking/PROVIDER_ENDPOINTS.md`.
- Use the values supplied by the hub operator for:
  - `CHAIN_ID`
  - `HUB_NODE`
  - `HUB_LCD`
  - `NIL_GATEWAY_SP_AUTH`
  - public hostname such as `sp.<domain>`

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import the provider key.
3. Configure the local listener and public endpoint.
4. Register the provider on-chain.
5. Start the provider service.
6. Verify local `/health`, public reachability, and on-chain provider visibility.
7. If anything fails, inspect logs, repair, and retry until healthy.

At the end, print:
- provider address
- registered endpoint
- local health URL
- public health URL
- service status
- exact files changed
