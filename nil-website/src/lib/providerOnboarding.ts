import type { LcdPendingProviderPairing, LcdProvider, LcdProviderPairing } from '../domain/lcd'
import { normalizeHttpBase } from './spDashboard'

export type ProviderHostMode = 'home-tunnel' | 'public-vps'
export type ProviderEndpointInputMode = 'domain' | 'ipv4' | 'multiaddr'

export interface ProviderEndpointDraft {
  hostMode: ProviderHostMode
  endpointMode: ProviderEndpointInputMode
  endpointValue: string
  publicPort?: number
}

export interface ProviderEndpointPlan {
  providerEndpoint: string
  publicBase: string | null
  publicHealthUrl: string | null
  normalizedHost: string
  publicPort: number
}

export interface ProviderBootstrapDraft extends ProviderEndpointDraft {
  pairingId: string
  providerKey?: string
  authToken?: string
}

const PROVIDER_BOOTSTRAP_REPO = 'https://github.com/Nil-Store/nil-store.git'
const DEFAULT_PROVIDER_KEY = 'provider1'
const DEFAULT_DOMAIN_PORT = 443
const DEFAULT_IPV4_PORT = 8091
const AUTH_PLACEHOLDER = '<shared-provider-auth-token>'

function trimNonEmpty(input: unknown): string {
  return String(input || '').trim()
}

function shellQuote(input: string): string {
  return `'${String(input).replace(/'/g, `'\\''`)}'`
}

function defaultPortForMode(endpointMode: ProviderEndpointInputMode): number {
  return endpointMode === 'ipv4' ? DEFAULT_IPV4_PORT : DEFAULT_DOMAIN_PORT
}

function parsePort(input: number | undefined, endpointMode: ProviderEndpointInputMode): number {
  const fallback = defaultPortForMode(endpointMode)
  const value = Number(input)
  if (!Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded <= 0 || rounded > 65535) return fallback
  return rounded
}

function stripSchemeAndPath(raw: string): string {
  const input = trimNonEmpty(raw)
  if (!input) return ''

  try {
    const parsed = new URL(input)
    return parsed.hostname.trim().toLowerCase()
  } catch {
    try {
      const parsed = new URL(`https://${input}`)
      return parsed.hostname.trim().toLowerCase()
    } catch {
      return input.replace(/^https?:\/\//i, '').split('/')[0]?.split(':')[0]?.trim().toLowerCase() ?? ''
    }
  }
}

function planFromMultiaddr(raw: string): ProviderEndpointPlan {
  const providerEndpoint = trimNonEmpty(raw)
  const publicBase = normalizeHttpBase(providerEndpoint)
  const normalizedUrl = publicBase ? new URL(publicBase) : null
  const fallbackPort = providerEndpoint.includes('/http') ? DEFAULT_IPV4_PORT : DEFAULT_DOMAIN_PORT

  return {
    providerEndpoint,
    publicBase,
    publicHealthUrl: publicBase ? `${publicBase}/health` : null,
    normalizedHost: providerEndpoint,
    publicPort: normalizedUrl ? Number(normalizedUrl.port || (normalizedUrl.protocol === 'http:' ? '80' : '443')) : fallbackPort,
  }
}

export function buildProviderEndpointPlan(draft: ProviderEndpointDraft): ProviderEndpointPlan | null {
  const endpointMode = draft.endpointMode
  const rawValue = trimNonEmpty(draft.endpointValue)
  if (!rawValue) return null

  if (endpointMode === 'multiaddr') {
    return planFromMultiaddr(rawValue)
  }

  const normalizedHost = stripSchemeAndPath(rawValue)
  if (!normalizedHost) return null

  const publicPort = parsePort(draft.publicPort, endpointMode)
  const multiaddrPrefix = endpointMode === 'ipv4' ? 'ip4' : 'dns4'
  const scheme = endpointMode === 'ipv4' ? 'http' : 'https'
  const defaultPort = scheme === 'http' ? 80 : 443
  const providerEndpoint = `/${multiaddrPrefix}/${normalizedHost}/tcp/${publicPort}/${scheme}`
  const publicBase = `${scheme}://${normalizedHost}${publicPort === defaultPort ? '' : `:${publicPort}`}`

  return {
    providerEndpoint,
    publicBase,
    publicHealthUrl: `${publicBase}/health`,
    normalizedHost,
    publicPort,
  }
}

export function buildProviderBootstrapCommand(draft: ProviderBootstrapDraft): string {
  const providerKey = trimNonEmpty(draft.providerKey) || DEFAULT_PROVIDER_KEY
  const pairingId = trimNonEmpty(draft.pairingId)
  const endpointPlan = buildProviderEndpointPlan(draft)
  const providerEndpoint = endpointPlan?.providerEndpoint || '<provider-endpoint>'
  const authToken = trimNonEmpty(draft.authToken) || AUTH_PLACEHOLDER

  const bootstrapLines = [
    '# 1. Initialize the provider key if it does not already exist:',
    `PROVIDER_KEY=${shellQuote(providerKey)} ./scripts/run_devnet_provider.sh init`,
    '',
    '# 2. If init created a new key, fund the printed nil1 address with aatom before continuing.',
    '# 3. Bootstrap once the key is funded. Pairing is optional but enables website linking and My Providers:',
  ]

  const envLines = [
    ...(pairingId ? [`PAIRING_ID=${shellQuote(pairingId)} \\`] : []),
    `PROVIDER_KEY=${shellQuote(providerKey)} \\`,
    `PROVIDER_ENDPOINT=${shellQuote(providerEndpoint)} \\`,
    `NIL_GATEWAY_SP_AUTH=${shellQuote(authToken)} \\`,
    './scripts/run_devnet_provider.sh bootstrap',
  ]

  return [
    '# If the repo is missing on the provider host:',
    `git clone ${PROVIDER_BOOTSTRAP_REPO}`,
    'cd nil-store',
    '',
    '# Canonical public testnet defaults are built in:',
    ...bootstrapLines,
    ...envLines,
  ].join('\n')
}

export function buildProviderHealthCommands(publicBase: string | null): string {
  const normalizedBase = trimNonEmpty(publicBase)
  const publicHealthUrl = normalizedBase ? `${normalizedBase.replace(/\/$/, '')}/health` : '<public-health-url>'

  return [
    './scripts/run_devnet_provider.sh doctor',
    './scripts/run_devnet_provider.sh verify',
    './scripts/run_devnet_provider.sh print-config',
    'curl -sf http://127.0.0.1:8091/health',
    `curl -sf ${shellQuote(publicHealthUrl)}`,
  ].join('\n')
}

function providerOperatorContextLines(input: {
  pairingId?: string
  providerEndpoint?: string
  publicBase?: string | null
  providerKey?: string
}): string[] {
  const providerKey = trimNonEmpty(input.providerKey)
  const pairingId = trimNonEmpty(input.pairingId)
  const providerEndpoint = trimNonEmpty(input.providerEndpoint)
  const publicBase = trimNonEmpty(input.publicBase ?? '')

  if (!providerKey && !pairingId && !providerEndpoint && !publicBase) {
    return [
      '- Ask for or use these operator-supplied values when available:',
      '  - `NIL_GATEWAY_SP_AUTH`',
      '  - `PAIRING_ID` if the operator opened pairing from the website',
      '  - provider key name such as `provider1`',
      '  - public hostname such as `sp.<domain>` or a full provider multiaddr',
    ]
  }

  const lines = ['- Use these operator values for this run:']
  lines.push(pairingId ? `  - \`PAIRING_ID=${pairingId}\`` : '  - `PAIRING_ID` only if the operator opened pairing from the website')
  lines.push(providerKey ? `  - \`PROVIDER_KEY=${providerKey}\`` : '  - provider key name such as `provider1`')
  lines.push(providerEndpoint ? `  - \`PROVIDER_ENDPOINT=${providerEndpoint}\`` : '  - public hostname such as `sp.<domain>` or a full provider multiaddr')
  if (publicBase) {
    lines.push(`  - public health base \`${publicBase}\``)
  }
  lines.push('  - `NIL_GATEWAY_SP_AUTH` supplied by the operator')
  return lines
}

export function buildProviderAgentPrompt(input: {
  pairingId?: string
  providerEndpoint?: string
  publicBase?: string | null
  providerKey?: string
} = {}): string {
  const publicBase = trimNonEmpty(input.publicBase ?? '')
  const publicHealthTarget = publicBase ? `public \`${publicBase}/health\`` : 'public health for the chosen endpoint shape'
  const providerContext = providerOperatorContextLines(input).join('\n')

  return `# Provider-Daemon Prompt

You are setting up this machine as a NilStore testnet provider-daemon for an operator who already initiated onboarding from the website.

Repo bootstrap (required unless already inside a fresh \`nil-store\` checkout):
1. If repo is missing:
   - \`git clone https://github.com/Nil-Store/nil-store.git\`
   - \`cd nil-store\`
2. Refresh checkout:
   - \`git fetch origin --prune\`
   - \`git checkout main\`
   - \`git pull --ff-only origin main\`

Context:
- The website-first flow is primary. This agent run is the assistive path for the provider host.
- Supported endpoint modes:
  - direct public HTTP/HTTPS endpoint
  - home server behind NAT with Cloudflare Tunnel
- Use \`docs/ALPHA_PROVIDER_QUICKSTART.md\`, \`docs/REMOTE_SP_JOIN_QUICKSTART.md\`, and \`docs/networking/PROVIDER_ENDPOINTS.md\`.
- The happy path uses the canonical public testnet defaults already baked into \`scripts/run_devnet_provider.sh\`.
- Only ask for \`CHAIN_ID\`, \`HUB_NODE\`, or \`HUB_LCD\` if the operator explicitly says they are targeting a non-public hub.
${providerContext}
- Endpoint guidance:
  - direct public IP: \`/ip4/<ip>/tcp/8091/http\` and verify \`http://<ip>:8091/health\`
  - Cloudflare Tunnel / HTTPS hostname: \`/dns4/<host>/tcp/443/https\` and verify \`https://<host>/health\`
- Treat \`NIL_GATEWAY_SP_AUTH\` as a secret. Paste it only on the provider host or into a trusted local agent session. Do not post it in chat, issues, or screenshots.
- Never print secrets/private keys in full; redact sensitive values (especially \`NIL_GATEWAY_SP_AUTH\`).

Operating mode:
- This is a guided provider-host run, not a loose advisory chat.
- Proceed autonomously through repo sync, toolchain checks, provider key setup, funding preflight, bootstrap, and verification.
- Pause only when the operator must supply \`NIL_GATEWAY_SP_AUTH\`, \`PAIRING_ID\`, DNS/Tunnel configuration, or approve an OS/service-manager action.
- Reuse an existing healthy provider key and registration when possible; do not rotate identity unless the operator explicitly asks.

Before running any on-chain step, confirm:
- \`go\`, \`cargo\`, and \`curl\` are installed.
- the repo checkout is current (\`git fetch origin --prune && git checkout main && git pull --ff-only origin main\`) if this is not a fresh clone.
- if using Cloudflare Tunnel, the hostname already resolves and tunnel ingress points to the local provider listener.
- if the provider key is new, run \`PROVIDER_KEY=<key> ./scripts/run_devnet_provider.sh init\`, print the provider \`nil1...\` address, and make sure it has \`aatom\` for gas before pairing or registration.

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import provider key.
3. Configure local listener and public endpoint.
4. For a new provider key, use this order:
   - \`PROVIDER_KEY=<key> ./scripts/run_devnet_provider.sh init\`
   - fund the printed provider address with gas
   - then run \`./scripts/run_devnet_provider.sh bootstrap\`
   If the key already exists and is funded, \`bootstrap\` may be used directly.
5. If \`PAIRING_ID\` is present, confirm the pending pairing on-chain during bootstrap before final verification. If the pairing is expired or not open, stop and tell the operator to open a fresh pairing from the website.
6. Register or update provider endpoints on-chain.
7. Start the provider-daemon if it is not already running.
8. Verify:
   - \`./scripts/run_devnet_provider.sh doctor\`
   - \`./scripts/run_devnet_provider.sh verify\`
   - local \`http://127.0.0.1:8091/health\`
   - ${publicHealthTarget}
   - LCD provider visibility
   - pairing status when \`PAIRING_ID\` is supplied
9. If anything fails, inspect logs, repair, and retry until healthy.
10. Endpoint rotation is update-aware on the current testnet build. Prefer updating endpoints for an existing provider instead of creating a new key, unless the chain explicitly rejects endpoint updates.

At the end, print:
1. A JSON summary with fields:
   - \`provider_address\`
   - \`pairing_id\`
   - \`pairing_status\`
   - \`registered_endpoints\`
   - \`local_health_url\`
   - \`public_health_url\`
   - \`local_health_ok\`
   - \`public_health_ok\`
   - \`lcd_visible\`
   - \`provider_daemon_status\`
   - \`commands_run\`
   - \`files_changed\`
2. A short human-readable summary.`
}

export function findConfirmedProviderPairing(
  pairings: LcdProviderPairing[],
  pairingId: string,
): LcdProviderPairing | null {
  const normalizedPairingId = trimNonEmpty(pairingId)
  if (!normalizedPairingId) return null
  return pairings.find((pairing) => trimNonEmpty(pairing.pairing_id) === normalizedPairingId) ?? null
}

export function findProviderByAddress(
  providers: LcdProvider[],
  providerAddress: string,
): LcdProvider | null {
  const normalizedProvider = trimNonEmpty(providerAddress)
  if (!normalizedProvider) return null
  return providers.find((provider) => trimNonEmpty(provider.address) === normalizedProvider) ?? null
}

export function pairingBlocksRemaining(
  pendingPairing: LcdPendingProviderPairing | null,
  latestHeight: number | null,
): number | null {
  if (!pendingPairing) return null
  const expiresAt = Number(pendingPairing.expires_at)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null
  if (!Number.isFinite(latestHeight ?? Number.NaN)) return null
  return Math.max(0, expiresAt - Number(latestHeight))
}

export function pairingExpired(
  pendingPairing: LcdPendingProviderPairing | null,
  latestHeight: number | null,
): boolean {
  const remaining = pairingBlocksRemaining(pendingPairing, latestHeight)
  if (remaining === null) return false
  return remaining === 0
}
