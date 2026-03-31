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
const DEFAULT_PUBLIC_PORT = 443
const AUTH_PLACEHOLDER = '<shared-provider-auth-token>'
const PAIRING_PLACEHOLDER = '<pairing-id-from-website>'

function trimNonEmpty(input: unknown): string {
  return String(input || '').trim()
}

function shellQuote(input: string): string {
  return `'${String(input).replace(/'/g, `'\\''`)}'`
}

function parsePort(input: number | undefined): number {
  const value = Number(input)
  if (!Number.isFinite(value)) return DEFAULT_PUBLIC_PORT
  const rounded = Math.floor(value)
  if (rounded <= 0 || rounded > 65535) return DEFAULT_PUBLIC_PORT
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
  return {
    providerEndpoint,
    publicBase,
    publicHealthUrl: publicBase ? `${publicBase}/health` : null,
    normalizedHost: providerEndpoint,
    publicPort: publicBase ? Number(new URL(publicBase).port || 443) || 443 : DEFAULT_PUBLIC_PORT,
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

  const publicPort = parsePort(draft.publicPort)
  const multiaddrPrefix = endpointMode === 'ipv4' ? 'ip4' : 'dns4'
  const providerEndpoint = `/${multiaddrPrefix}/${normalizedHost}/tcp/${publicPort}/https`
  const publicBase = `https://${normalizedHost}${publicPort === 443 ? '' : `:${publicPort}`}`

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
  const pairingId = trimNonEmpty(draft.pairingId) || PAIRING_PLACEHOLDER
  const endpointPlan = buildProviderEndpointPlan(draft)
  const providerEndpoint = endpointPlan?.providerEndpoint || '<provider-endpoint>'
  const authToken = trimNonEmpty(draft.authToken) || AUTH_PLACEHOLDER

  return [
    '# If the repo is missing on the provider host:',
    `git clone ${PROVIDER_BOOTSTRAP_REPO}`,
    'cd nil-store',
    '',
    '# Canonical public testnet defaults are built in:',
    `PAIRING_ID=${shellQuote(pairingId)} \\`,
    `PROVIDER_KEY=${shellQuote(providerKey)} \\`,
    `PROVIDER_ENDPOINT=${shellQuote(providerEndpoint)} \\`,
    `NIL_GATEWAY_SP_AUTH=${shellQuote(authToken)} \\`,
    './scripts/run_devnet_provider.sh bootstrap',
  ].join('\n')
}

export function buildProviderHealthCommands(publicBase: string | null): string {
  const normalizedBase = trimNonEmpty(publicBase)
  const publicHealthUrl = normalizedBase ? `${normalizedBase.replace(/\/$/, '')}/health` : '<public-health-url>'

  return [
    './scripts/run_devnet_provider.sh doctor',
    './scripts/run_devnet_provider.sh print-config',
    'curl -sf http://127.0.0.1:8091/health',
    `curl -sf ${shellQuote(publicHealthUrl)}`,
  ].join('\n')
}

export function buildProviderAgentPrompt(input: {
  pairingId?: string
  providerEndpoint?: string
  publicBase?: string | null
  providerKey?: string
} = {}): string {
  const providerKey = trimNonEmpty(input.providerKey) || DEFAULT_PROVIDER_KEY
  const pairingId = trimNonEmpty(input.pairingId) || PAIRING_PLACEHOLDER
  const providerEndpoint = trimNonEmpty(input.providerEndpoint) || '<provider-endpoint>'
  const publicBase = trimNonEmpty(input.publicBase ?? '') || 'https://sp.<domain>'

  return `You are setting up this machine as a NilStore testnet provider-daemon for an operator who already started onboarding from the website.

Repo bootstrap (required unless already inside a fresh nil-store checkout):
1. If repo is missing:
   - git clone https://github.com/Nil-Store/nil-store.git
   - cd nil-store
2. Refresh checkout:
   - git fetch origin --prune
   - git checkout main
   - git pull --ff-only origin main

Context:
- The website-first flow is primary. This agent run is the assistive path for the provider host.
- Preferred mode: home server behind NAT with Cloudflare Tunnel.
- Use docs/ALPHA_PROVIDER_QUICKSTART.md, docs/REMOTE_SP_JOIN_QUICKSTART.md, and docs/networking/PROVIDER_ENDPOINTS.md.
- The happy path uses the canonical public testnet defaults already baked into scripts/run_devnet_provider.sh.
- Only ask for CHAIN_ID, HUB_NODE, or HUB_LCD if the operator explicitly says they are targeting a non-public hub.
- Use these operator values:
  - PAIRING_ID=${pairingId}
  - PROVIDER_KEY=${providerKey}
  - PROVIDER_ENDPOINT=${providerEndpoint}
  - public health base ${publicBase}
  - NIL_GATEWAY_SP_AUTH supplied by the operator
- Never print secrets/private keys in full; redact sensitive values.

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import provider key.
3. Configure local listener and public endpoint.
4. Prefer ./scripts/run_devnet_provider.sh bootstrap for the main flow.
5. Confirm pairing on-chain using PAIRING_ID when it is supplied.
6. Register or update provider endpoints on-chain.
7. Start the provider-daemon if it is not already running.
8. Verify:
   - ./scripts/run_devnet_provider.sh doctor
   - local http://127.0.0.1:8091/health
   - public ${publicBase}/health
   - LCD provider visibility
   - pairing status
9. If anything fails, inspect logs, repair, and retry until healthy.

At the end, print:
1. A JSON summary with fields:
   - provider_address
   - pairing_id
   - pairing_status
   - registered_endpoints
   - local_health_url
   - public_health_url
   - local_health_ok
   - public_health_ok
   - lcd_visible
   - service_status
   - commands_run
   - files_changed
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
  if (!Number.isFinite(latestHeight ?? NaN)) return null
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
