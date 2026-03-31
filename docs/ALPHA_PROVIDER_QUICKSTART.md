# Testnet Provider Quickstart

This is the shortest supported path for a NilStore testnet Storage Provider.

Note: this file keeps a legacy `ALPHA_` prefix for compatibility.

Recommended target:
- home server behind NAT with Cloudflare Tunnel

Fallback target:
- public VPS or directly reachable host

## What you need from the hub operator

- Repo URL: `https://github.com/Nil-Store/nil-store`
- Shared provider auth token: `NIL_GATEWAY_SP_AUTH=...`
- Recommended hostname: `sp.<domain>` or `spN.<domain>`
- Optional but recommended: a website-opened `PAIRING_ID=...` so the provider can be linked to your browser wallet on-chain

The happy path now uses the canonical public testnet defaults built into `scripts/run_devnet_provider.sh`.
You only need to override RPC/LCD/chain settings if you are deliberately targeting a non-public hub.

## Fast path

1. Clone the repo on the provider machine.
2. Open your coding agent locally in the repo.
3. Paste the provider prompt from:
   - `docs/onboarding-prompts/provider.md`
4. Give the agent:
   - `NIL_GATEWAY_SP_AUTH`
   - your public hostname or multiaddr
   - `PAIRING_ID` if you opened pairing from the website
5. Let the agent install, configure, pair if applicable, register or update endpoints, verify, and retry until healthy.
6. Confirm:
   - local `http://127.0.0.1:8091/health`
   - public `https://sp.<domain>/health`
   - provider appears on `https://lcd.<domain>/nilchain/nilchain/v1/providers`

## Manual references

- Fast join guide: `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- Endpoint formats: `docs/networking/PROVIDER_ENDPOINTS.md`
- Multi-provider guide: `DEVNET_MULTI_PROVIDER.md`

## Success criteria

- Provider key exists and is funded
- Provider is paired to the intended operator wallet when `PAIRING_ID` is supplied
- Provider endpoint is registered on-chain
- Local `/health` returns `200`
- Public HTTPS endpoint returns `200`
- The provider is visible in the LCD provider list
