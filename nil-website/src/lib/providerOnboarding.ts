import type { LcdPendingProviderLink, LcdProvider, LcdProviderPairing } from '../domain/lcd'
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

export interface ProviderEndpointInputPrefill {
  endpointMode: ProviderEndpointInputMode
  endpointValue: string
  publicPort: number
}

export interface ProviderBootstrapDraft extends ProviderEndpointDraft {
  operatorAddress?: string
  providerKey?: string
  authToken?: string
  providerEndpoint?: string
  expectedProviderAddress?: string
}

export interface ProviderTunnelBootstrapDraft extends ProviderEndpointDraft {
  tunnelName?: string
  localServiceUrl?: string
}

export interface ProviderRunbookReadiness {
  ready: boolean
  missing: Array<'endpoint' | 'operator'>
}

const DEFAULT_PROVIDER_KEY = 'provider1'
const DEFAULT_DOMAIN_PORT = 443
const DEFAULT_IPV4_PORT = 8091
export const DEVNET_SHARED_GATEWAY_AUTH_TOKEN = 'nilstore-devnet-shared-gateway-auth'
const AUTH_PLACEHOLDER = '<shared-provider-auth-token>'
const DEFAULT_TUNNEL_NAME = 'nilstore-sp'
const DEFAULT_TUNNEL_LOCAL_SERVICE_URL = 'http://127.0.0.1:8091'

function trimNonEmpty(input: unknown): string {
  return String(input || '').trim()
}

function shellQuote(input: string): string {
  return `'${String(input).replace(/'/g, `'\\''`)}'`
}

function defaultPortForMode(endpointMode: ProviderEndpointInputMode): number {
  return endpointMode === 'ipv4' ? DEFAULT_IPV4_PORT : DEFAULT_DOMAIN_PORT
}

function suggestTunnelNameFromHost(hostname: string): string {
  const slug = trimNonEmpty(hostname)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) return DEFAULT_TUNNEL_NAME
  const suggested = `nilstore-${slug}`
  return suggested.length <= 63 ? suggested : suggested.slice(0, 63).replace(/-+$/g, '')
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

function isValidIpv4Host(host: string): boolean {
  const value = trimNonEmpty(host)
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false
    const parsed = Number(part)
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255
  })
}

function isValidDomainHostname(host: string): boolean {
  const value = trimNonEmpty(host).toLowerCase()
  if (!value || value.length > 253) return false
  if (!value.includes('.')) return false
  if (value.startsWith('.') || value.endsWith('.')) return false
  const labels = value.split('.')
  return labels.every((label) =>
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9-]+$/.test(label)
    && !label.startsWith('-')
    && !label.endsWith('-'),
  )
}

function looksLikeHttpMultiaddr(endpoint: string): boolean {
  const value = trimNonEmpty(endpoint)
  if (!value.startsWith('/')) return false
  return /\/tcp\/\d+\/(http|https)(\/|$)/i.test(value)
}

function planFromMultiaddr(raw: string): ProviderEndpointPlan | null {
  const providerEndpoint = trimNonEmpty(raw)
  if (!providerEndpoint || !looksLikeHttpMultiaddr(providerEndpoint)) {
    return null
  }
  const publicBase = normalizeHttpBase(providerEndpoint)
  if (!publicBase) {
    return null
  }
  const normalizedUrl = new URL(publicBase)

  return {
    providerEndpoint,
    publicBase,
    publicHealthUrl: publicBase ? `${publicBase}/health` : null,
    normalizedHost: normalizedUrl.hostname.trim().toLowerCase(),
    publicPort: Number(normalizedUrl.port || (normalizedUrl.protocol === 'http:' ? '80' : '443')),
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
  if (endpointMode === 'ipv4' && !isValidIpv4Host(normalizedHost)) return null
  if (endpointMode === 'domain' && !isValidDomainHostname(normalizedHost)) return null

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

export function deriveEndpointInputPrefillFromProviderEndpoint(
  providerEndpoint: string,
): ProviderEndpointInputPrefill | null {
  const raw = trimNonEmpty(providerEndpoint)
  if (!raw) return null

  const dnsMatch = raw.match(/^\/dns4\/([^/]+)\/tcp\/(\d+)\/https(?:\/|$)/i)
  if (dnsMatch) {
    const host = trimNonEmpty(dnsMatch[1]).toLowerCase()
    const publicPort = Number(dnsMatch[2])
    if (isValidDomainHostname(host) && Number.isInteger(publicPort) && publicPort > 0 && publicPort <= 65535) {
      return {
        endpointMode: 'domain',
        endpointValue: host,
        publicPort,
      }
    }
  }

  const ipMatch = raw.match(/^\/ip4\/((?:\d{1,3}\.){3}\d{1,3})\/tcp\/(\d+)\/http(?:\/|$)/i)
  if (ipMatch) {
    const host = trimNonEmpty(ipMatch[1])
    const publicPort = Number(ipMatch[2])
    if (isValidIpv4Host(host) && Number.isInteger(publicPort) && publicPort > 0 && publicPort <= 65535) {
      return {
        endpointMode: 'ipv4',
        endpointValue: host,
        publicPort,
      }
    }
  }

  const plan = buildProviderEndpointPlan({
    hostMode: 'public-vps',
    endpointMode: 'multiaddr',
    endpointValue: raw,
  })
  if (!plan) return null

  return {
    endpointMode: 'multiaddr',
    endpointValue: raw,
    publicPort: plan.publicPort,
  }
}

export function buildProviderBootstrapCommand(draft: ProviderBootstrapDraft): string {
  const providerKey = trimNonEmpty(draft.providerKey) || DEFAULT_PROVIDER_KEY
  const operatorAddress = trimNonEmpty(draft.operatorAddress)
  const expectedProviderAddress = trimNonEmpty(draft.expectedProviderAddress)
  const endpointPlan = buildProviderEndpointPlan(draft)
  const explicitProviderEndpoint = trimNonEmpty(draft.providerEndpoint)
  const providerEndpoint = endpointPlan?.providerEndpoint || explicitProviderEndpoint || '<provider-endpoint>'
  const hasProviderEndpoint = Boolean(endpointPlan?.providerEndpoint || explicitProviderEndpoint)
  const authToken = trimNonEmpty(draft.authToken) || DEVNET_SHARED_GATEWAY_AUTH_TOKEN
  const usingDefaultAuth = !trimNonEmpty(draft.authToken)
  const websiteReady = Boolean(hasProviderEndpoint && operatorAddress)
  const envLines = [
    '# Run this from the nil-store checkout on the provider host after pairing is approved.',
    '# This command starts (or restarts) the provider-daemon, then registers endpoints and runs health checks.',
    '# This command requires OPERATOR_ADDRESS and PROVIDER_ENDPOINT.',
    ...(usingDefaultAuth
      ? ['# Using devnet default NIL_GATEWAY_SP_AUTH. Override it if your hub uses a custom secret.']
      : []),
    ...(!websiteReady ? ['BOOTSTRAP_ALLOW_PARTIAL=1 \\'] : []),
    ...(operatorAddress ? [`OPERATOR_ADDRESS=${shellQuote(operatorAddress)} \\`] : []),
    `PROVIDER_KEY=${shellQuote(providerKey)} \\`,
    ...(expectedProviderAddress ? [`EXPECTED_PROVIDER_ADDRESS=${shellQuote(expectedProviderAddress)} \\`] : []),
    `PROVIDER_ENDPOINT=${shellQuote(providerEndpoint)} \\`,
    `NIL_GATEWAY_SP_AUTH=${shellQuote(authToken || AUTH_PLACEHOLDER)} \\`,
    './scripts/run_devnet_provider.sh bootstrap',
  ]

  return [
    ...envLines,
  ].join('\n')
}

export function buildProviderPairCommand(providerKey: string, operatorAddress: string): string {
  const normalizedProviderKey = trimNonEmpty(providerKey) || DEFAULT_PROVIDER_KEY
  const normalizedOperatorAddress = trimNonEmpty(operatorAddress) || '<operator-nil1-or-0x-address>'

  return [
    '# Run this once on the provider host to create the key if needed and open the link request.',
    '# If the key is unfunded and faucet autofunding is unavailable, fund the printed nil1 address and rerun this same command.',
    `OPERATOR_ADDRESS=${shellQuote(normalizedOperatorAddress)} \\`,
    `PROVIDER_KEY=${shellQuote(normalizedProviderKey)} \\`,
    './scripts/run_devnet_provider.sh pair',
  ].join('\n')
}

export function buildCloudflareTunnelBootstrapCommand(draft: ProviderTunnelBootstrapDraft): string {
  const endpointPlan = buildProviderEndpointPlan(draft)
  const normalizedHost =
    endpointPlan?.normalizedHost ||
    (draft.endpointMode === 'multiaddr' ? '' : stripSchemeAndPath(draft.endpointValue))
  const hostname = normalizedHost || '<public-hostname>'
  const tunnelName = trimNonEmpty(draft.tunnelName) || suggestTunnelNameFromHost(normalizedHost)
  const localServiceUrl = trimNonEmpty(draft.localServiceUrl) || DEFAULT_TUNNEL_LOCAL_SERVICE_URL

  return [
    '# Easy mode: bootstrap a Cloudflare Tunnel for this provider host.',
    '# This is safe to rerun; it creates route/config when missing and then starts cloudflared.',
    `CF_TUNNEL_NAME=${shellQuote(tunnelName)} \\`,
    `CF_TUNNEL_HOSTNAME=${shellQuote(hostname)} \\`,
    `CF_TUNNEL_SERVICE_URL=${shellQuote(localServiceUrl)} \\`,
    "bash <<'NILSTORE_CF_TUNNEL'",
    'set -euo pipefail',
    '',
    'if ! command -v cloudflared >/dev/null 2>&1; then',
    '  echo "cloudflared is required. Install it first: https://developers.cloudflare.com/tunnel/setup/"',
    '  exit 1',
    'fi',
    '',
    'if [ -f "$HOME/.cloudflared/cert.pem" ]; then',
    '  echo "Using existing Cloudflare cert at $HOME/.cloudflared/cert.pem; skipping login."',
    'else',
    '  cloudflared tunnel login',
    'fi',
    '',
    'cloudflared tunnel create "$CF_TUNNEL_NAME" >/dev/null 2>&1 || true',
    'cloudflared tunnel route dns "$CF_TUNNEL_NAME" "$CF_TUNNEL_HOSTNAME"',
    '',
    `TUNNEL_ID="$(cloudflared tunnel list | awk -v name="$CF_TUNNEL_NAME" '$2 == name { print $1; exit }')"`,
    'if [ -z "$TUNNEL_ID" ]; then',
    '  echo "Could not resolve tunnel id for $CF_TUNNEL_NAME"',
    '  exit 1',
    'fi',
    '',
    'mkdir -p "$HOME/.cloudflared"',
    'cat > "$HOME/.cloudflared/config.yml" <<EOF',
    'tunnel: ${TUNNEL_ID}',
    'credentials-file: ${HOME}/.cloudflared/${TUNNEL_ID}.json',
    'ingress:',
    '  - hostname: ${CF_TUNNEL_HOSTNAME}',
    '    service: ${CF_TUNNEL_SERVICE_URL}',
    '  - service: http_status:404',
    'EOF',
    '',
    'echo "Tunnel config written to $HOME/.cloudflared/config.yml"',
    'cloudflared --config "$HOME/.cloudflared/config.yml" tunnel run "$CF_TUNNEL_NAME"',
    'NILSTORE_CF_TUNNEL',
  ].join('\n')
}

export function evaluateProviderRunbookReadiness(input: {
  endpointPlan: ProviderEndpointPlan | null
  providerEndpoint?: string
  operatorAddress?: string
  authToken?: string
}): ProviderRunbookReadiness {
  const missing: ProviderRunbookReadiness['missing'] = []

  if (!input.endpointPlan && !trimNonEmpty(input.providerEndpoint)) missing.push('endpoint')
  if (!trimNonEmpty(input.operatorAddress)) missing.push('operator')

  return {
    ready: missing.length === 0,
    missing,
  }
}

export function buildProviderLinkCommand(providerKey: string, operatorAddress: string): string {
  const normalizedProviderKey = trimNonEmpty(providerKey) || DEFAULT_PROVIDER_KEY
  const normalizedOperatorAddress = trimNonEmpty(operatorAddress) || '<operator-nil1-or-0x-address>'

  return [
    `OPERATOR_ADDRESS=${shellQuote(normalizedOperatorAddress)} \\`,
    `PROVIDER_KEY=${shellQuote(normalizedProviderKey)} \\`,
    './scripts/run_devnet_provider.sh link',
  ].join('\n')
}

export function buildProviderHealthCommands(publicBase: string | null, providerKey?: string): string {
  const normalizedBase = trimNonEmpty(publicBase)
  const normalizedProviderKey = trimNonEmpty(providerKey) || DEFAULT_PROVIDER_KEY
  const providerKeyPrefix = `PROVIDER_KEY=${shellQuote(normalizedProviderKey)} `
  const publicHealthUrl = normalizedBase ? `${normalizedBase.replace(/\/$/, '')}/health` : '<public-health-url>'

  return [
    `${providerKeyPrefix}./scripts/run_devnet_provider.sh doctor`,
    `${providerKeyPrefix}./scripts/run_devnet_provider.sh verify`,
    `${providerKeyPrefix}./scripts/run_devnet_provider.sh print-config`,
    'curl -sf http://127.0.0.1:8091/health',
    `curl -sf ${shellQuote(publicHealthUrl)}`,
  ].join('\n')
}

function providerOperatorContextLines(input: {
  operatorAddress?: string
  providerEndpoint?: string
  publicBase?: string | null
  providerKey?: string
}): string[] {
  const providerKey = trimNonEmpty(input.providerKey)
  const operatorAddress = trimNonEmpty(input.operatorAddress)
  const providerEndpoint = trimNonEmpty(input.providerEndpoint)
  const publicBase = trimNonEmpty(input.publicBase ?? '')

  if (!providerKey && !operatorAddress && !providerEndpoint && !publicBase) {
    return [
      '- Ask for or use these operator-supplied values when available:',
      '  - `NIL_GATEWAY_SP_AUTH`',
      '  - `OPERATOR_ADDRESS` as nil1... or 0x... for provider-link request',
      '  - provider key name such as `provider1`',
      '  - public hostname such as `sp.<domain>` or a full provider multiaddr',
    ]
  }

  const lines = ['- Use these operator values for this run:']
  lines.push(operatorAddress ? `  - \`OPERATOR_ADDRESS=${operatorAddress}\`` : '  - `OPERATOR_ADDRESS` as nil1... or 0x...')
  lines.push(providerKey ? `  - \`PROVIDER_KEY=${providerKey}\`` : '  - provider key name such as `provider1`')
  lines.push(providerEndpoint ? `  - \`PROVIDER_ENDPOINT=${providerEndpoint}\`` : '  - public hostname such as `sp.<domain>` or a full provider multiaddr')
  if (publicBase) {
    lines.push(`  - public health base \`${publicBase}\``)
  }
  lines.push('  - `NIL_GATEWAY_SP_AUTH` supplied by the operator')
  return lines
}

export function buildProviderAgentPrompt(input: {
  operatorAddress?: string
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
- The current website steps are: connect operator wallet, prepare provider host, pair provider identity, configure public access, then bootstrap and verify.
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
- Proceed autonomously through repo sync, toolchain checks, provider key setup, provider-link request, funding preflight, bootstrap, and verification.
- Pause only when the operator must supply \`NIL_GATEWAY_SP_AUTH\`, \`OPERATOR_ADDRESS\`, DNS/Tunnel configuration, or approve an OS/service-manager action.
- Reuse an existing healthy provider key and registration when possible; do not rotate identity unless the operator explicitly asks.

Before running any on-chain step, confirm:
- \`go\`, \`cargo\`, and \`curl\` are installed.
- the repo checkout is current (\`git fetch origin --prune && git checkout main && git pull --ff-only origin main\`) if this is not a fresh clone.
- if using Cloudflare Tunnel, the hostname already resolves and tunnel ingress points to the local provider listener.
- if the provider key is new, prefer \`OPERATOR_ADDRESS=<operator-address> PROVIDER_KEY=<key> ./scripts/run_devnet_provider.sh pair\`; if autofunding is unavailable, fund the printed provider \`nil1...\` address and rerun the same command before registration.

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import provider key.
3. Configure local listener and public endpoint.
4. For a new provider key, use this order:
   - run \`OPERATOR_ADDRESS=<operator-address> PROVIDER_KEY=<key> ./scripts/run_devnet_provider.sh pair\`
   - if the key is new and auto-funding is unavailable, fund the printed provider address with gas and rerun the same \`pair\` command
5. The website-managed flow requires \`OPERATOR_ADDRESS\`, a real \`PROVIDER_ENDPOINT\`, and \`NIL_GATEWAY_SP_AUTH\`.
   - \`./scripts/run_devnet_provider.sh bootstrap\` now fails fast unless all three are present
   - let \`./scripts/run_devnet_provider.sh bootstrap\` request link and continue the full happy path, or
   - run \`./scripts/run_devnet_provider.sh link\` when you want link request as a separate repair step after key setup
   - if you intentionally want a partial manual bootstrap, use staged \`pair\`, \`register\`, and \`start\` commands, or explicitly opt in with \`BOOTSTRAP_ALLOW_PARTIAL=1\`
6. Ask the operator to approve the pending provider link in the website wallet step.
7. Register or update provider endpoints on-chain.
8. Start the provider-daemon if it is not already running.
9. Verify:
   - \`./scripts/run_devnet_provider.sh doctor\`
   - \`./scripts/run_devnet_provider.sh verify\`
   - local \`http://127.0.0.1:8091/health\`
   - ${publicHealthTarget}
   - LCD provider visibility
   - provider link status for the configured operator
   Browser-side public \`/status\` and \`/health\` probing is advisory; rely on CLI/local checks first when diagnosing failures.
10. If anything fails, inspect logs, repair, and retry until healthy.
11. Endpoint rotation is update-aware on the current testnet build. Prefer updating endpoints for an existing provider instead of creating a new key, unless the chain explicitly rejects endpoint updates.

At the end, print:
1. A JSON summary with fields:
   - \`provider_address\`
   - \`configured_operator\`
   - \`pairing_status\`
   - \`registered_endpoints\`
   - \`local_health_url\`
   - \`public_health_url\`
   - \`local_health_ok\`
   - \`public_health_ok\`
   - \`lcd_visible\`
   - \`provider_process_running\`
   - \`provider_registered\`
   - \`provider_paired\`
   - \`pending_link_open\`
   - \`sp_auth_present\`
   - \`commands_run\`
   - \`files_changed\`
2. A short human-readable summary.`
}

function parseHeight(input: string): number {
  const value = Number(input)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

export function findConfirmedProviderPairing(
  pairings: LcdProviderPairing[],
  operatorAddress: string,
): LcdProviderPairing | null {
  const normalizedOperator = trimNonEmpty(operatorAddress)
  if (!normalizedOperator) return null

  const candidates = pairings
    .filter((pairing) => trimNonEmpty(pairing.operator) === normalizedOperator)
    .sort((a, b) => parseHeight(b.paired_height) - parseHeight(a.paired_height))

  return candidates[0] ?? null
}

export function findMostRecentPendingProviderLink(
  links: LcdPendingProviderLink[],
  operatorAddress: string,
): LcdPendingProviderLink | null {
  const normalizedOperator = trimNonEmpty(operatorAddress)
  if (!normalizedOperator) return null

  const candidates = links
    .filter((link) => trimNonEmpty(link.operator) === normalizedOperator)
    .sort((a, b) => parseHeight(b.requested_height) - parseHeight(a.requested_height))

  return candidates[0] ?? null
}

export function findProviderByAddress(
  providers: LcdProvider[],
  providerAddress: string,
): LcdProvider | null {
  const normalizedProvider = trimNonEmpty(providerAddress)
  if (!normalizedProvider) return null
  return providers.find((provider) => trimNonEmpty(provider.address) === normalizedProvider) ?? null
}
