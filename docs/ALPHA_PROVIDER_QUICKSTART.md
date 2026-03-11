# Alpha Provider Quickstart

This is the shortest supported path for a NilStore alpha Storage Provider.

Recommended target:
- home server behind NAT with Cloudflare Tunnel

Fallback target:
- public VPS or directly reachable host

## What you need from the hub operator

- Repo URL: `https://github.com/Nil-Store/nil-store`
- Hub RPC: `https://rpc.<domain>`
- Hub LCD: `https://lcd.<domain>`
- Chain ID: `<chain-id>`
- Shared provider auth token: `NIL_GATEWAY_SP_AUTH=...`
- Recommended hostname: `sp.<domain>` or `spN.<domain>`

## Fast path

1. Clone the repo on the provider machine.
2. Open Codex or Claude Code locally in the repo.
3. Paste the provider prompt from:
   - `docs/onboarding-prompts/provider_codex.md`
   - `docs/onboarding-prompts/provider_claude_code.md`
4. Let the agent install, configure, register, verify, and retry until healthy.
5. Confirm:
   - local `http://127.0.0.1:8091/health`
   - public `https://sp.<domain>/health`
   - provider appears on `https://lcd.<domain>/nilchain/nilchain/v1/providers`

## Manual references

- Fast join guide: `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- Endpoint formats: `docs/networking/PROVIDER_ENDPOINTS.md`
- Multi-provider guide: `DEVNET_MULTI_PROVIDER.md`

## Success criteria

- Provider key exists and is funded
- Provider endpoint is registered on-chain
- Local `/health` returns `200`
- Public HTTPS endpoint returns `200`
- The provider is visible in the LCD provider list
