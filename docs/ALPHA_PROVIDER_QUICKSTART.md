# Testnet Provider-Daemon Quickstart

This is the shortest supported path for a NilStore testnet provider-daemon operator.

Note: this file keeps a legacy `ALPHA_` prefix for compatibility.

Recommended target:
- home server behind NAT with Cloudflare Tunnel

Fallback target:
- public VPS or directly reachable host

## What you need from the hub operator

- Repo URL: `https://github.com/Nil-Store/nil-store`
- Shared `user-gateway` to `provider-daemon` auth token: `NIL_GATEWAY_SP_AUTH=...`
- Recommended hostname: `sp.<domain>` or `spN.<domain>`
- Optional but recommended: a website-opened `PAIRING_ID=...` so the provider can be linked to your browser wallet on-chain

Treat `NIL_GATEWAY_SP_AUTH` as a secret. Paste it only on the provider host or into a trusted local agent session. Do not post it in chat, issues, or screenshots.

The happy path now uses the canonical public testnet defaults built into `scripts/run_devnet_provider.sh`.
You only need to override RPC/LCD/chain settings if you are deliberately targeting a non-public hub.

## Fast path

1. Open the NilStore website and go to `/sp-onboarding`.
2. Connect the operator wallet. Open pairing if you want website linking and `My Providers`; bootstrap can still run without pairing.
3. Clone the repo on the provider machine.
4. Optional: open your coding agent locally in the repo.
5. Paste the provider prompt from:
   - `docs/onboarding-prompts/provider.md`
6. Give the agent:
   - `NIL_GATEWAY_SP_AUTH`
   - your public hostname or multiaddr
   - `PAIRING_ID` if you opened pairing from the website
7. Let the agent:
   - initialize the provider key if needed
   - fund the printed `nil1...` address before pairing or registration when the key is new
   - bootstrap, verify, and retry until healthy
   - use `./scripts/run_devnet_provider.sh pair` for pairing-only repair when the host is already configured and only the on-chain link is missing
8. Confirm:
   - local `http://127.0.0.1:8091/health`
   - public `https://sp.<domain>/health` for tunnel / hostname mode, or `http://<ip>:8091/health` for direct IPv4 mode
   - provider appears on `https://lcd.<domain>/nilchain/nilchain/v1/providers`
   - provider appears in the website `My Providers` dashboard when pairing was supplied

## Manual references

- Fast join guide: `docs/REMOTE_SP_JOIN_QUICKSTART.md`
- Endpoint formats: `docs/networking/PROVIDER_ENDPOINTS.md`
- Multi-provider guide: `DEVNET_MULTI_PROVIDER.md`

## Success criteria

- Provider key exists and is funded
- Provider is paired to the intended operator wallet when `PAIRING_ID` is supplied
- Provider endpoint is registered on-chain and can be rotated later if needed
- Local `/health` returns `200`
- Public endpoint returns `200` for the chosen shape (`https://sp.<domain>/health` or `http://<ip>:8091/health`)
- The provider is visible in the LCD provider list
