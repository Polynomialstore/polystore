function envString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function detectRuntimeHost(): string {
  if (typeof window === 'undefined') return ''
  return String(window.location.hostname || '').trim().toLowerCase()
}

function detectRuntimeOrigin(): string {
  if (typeof window === 'undefined') return ''
  return String(window.location.origin || '').trim()
}

function inferPublicDomain(runtimeHost: string): string {
  const explicit = envString(import.meta.env.VITE_PUBLIC_DOMAIN).toLowerCase()
  if (explicit) return explicit

  if (!runtimeHost) return ''
  if (runtimeHost === 'nilstore.org' || runtimeHost.endsWith('.nilstore.org')) return 'nilstore.org'
  if (runtimeHost.startsWith('web.') && runtimeHost.split('.').length >= 3) {
    return runtimeHost.slice(4)
  }
  return ''
}

function extractHostname(urlOrHost: string): string {
  const raw = String(urlOrHost || '').trim()
  if (!raw) return ''
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    try {
      return new URL(`http://${raw}`).hostname.toLowerCase()
    } catch {
      return ''
    }
  }
}

function isLoopbackHost(hostname: string): boolean {
  if (!hostname) return false
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  if (hostname.startsWith('127.')) return true
  return false
}

function normalizeLoopbackUrl(url: string): string {
  const raw = String(url || '').trim()
  if (!raw) return raw
  try {
    const parsed = new URL(raw)
    if (isLoopbackHost(parsed.hostname.toLowerCase())) {
      parsed.hostname = '127.0.0.1'
      return parsed.toString()
    }
    return raw
  } catch {
    return raw
  }
}

function localOnlyGatewayBase(candidate: string, fallback: string): string {
  const host = extractHostname(candidate)
  if (isLoopbackHost(host)) return normalizeLoopbackUrl(candidate)
  return normalizeLoopbackUrl(fallback)
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i <= 0) return fallback
  return i
}

const RUNTIME_HOST = detectRuntimeHost()
const RUNTIME_ORIGIN = detectRuntimeOrigin()
const PUBLIC_DOMAIN = inferPublicDomain(RUNTIME_HOST)
const defaultBase = (subdomain: string, localDefault: string): string =>
  PUBLIC_DOMAIN ? `https://${subdomain}.${PUBLIC_DOMAIN}` : localDefault
const LOCAL_GATEWAY_BASE = 'http://127.0.0.1:8080'

const API_BASE = envString(import.meta.env.VITE_API_BASE) || defaultBase('faucet', 'http://localhost:8081')
const LCD_BASE = envString(import.meta.env.VITE_LCD_BASE) || defaultBase('lcd', 'http://localhost:1317')
const GATEWAY_BASE = localOnlyGatewayBase(
  envString(import.meta.env.VITE_GATEWAY_BASE) || LOCAL_GATEWAY_BASE,
  LOCAL_GATEWAY_BASE,
)
const EXPLORER_BASE =
  envString(import.meta.env.VITE_EXPLORER_BASE) ||
  (RUNTIME_ORIGIN || defaultBase('web', 'http://localhost:5173'))
const SP_BASE = envString(import.meta.env.VITE_SP_BASE) || 'http://localhost:8082'
const GATEWAY_DISABLED = import.meta.env.VITE_DISABLE_GATEWAY === '1'
const P2P_ENABLED = (() => {
  const raw = import.meta.env.VITE_P2P_ENABLED
  if (typeof raw === 'string') {
    return raw === '1'
  }
  // Default: enabled (dev/test posture). Disable explicitly via VITE_P2P_ENABLED=0.
  return true
})()
const P2P_BOOTSTRAP = import.meta.env.VITE_P2P_BOOTSTRAP || ''
const P2P_PROTOCOL = import.meta.env.VITE_P2P_PROTOCOL || '/nilstore/http/1.0.0'
const FAUCET_ENABLED = (() => {
  const raw = import.meta.env.VITE_ENABLE_FAUCET
  if (typeof raw === 'string') {
    return raw === '1'
  }
  // Public trusted-devnet deployments (e.g. *.nilstore.org) default to faucet-on.
  // Keep local/dev default off unless explicitly enabled.
  return PUBLIC_DOMAIN !== ''
})()
const COSMOS_CHAIN_ID = envString(import.meta.env.VITE_COSMOS_CHAIN_ID) || '31337'
const BRIDGE_ADDRESS = envString(import.meta.env.VITE_BRIDGE_ADDRESS) || '0x0000000000000000000000000000000000000000'
const NILSTORE_PRECOMPILE =
  envString(import.meta.env.VITE_NILSTORE_PRECOMPILE) || '0x0000000000000000000000000000000000000900'
const EVM_RPC = envString(import.meta.env.VITE_EVM_RPC) || defaultBase('evm', 'http://localhost:8545')
const DEFAULT_RS_K = parsePositiveInt(envString(import.meta.env.VITE_DEFAULT_RS_K), 2)
const DEFAULT_RS_M = parsePositiveInt(envString(import.meta.env.VITE_DEFAULT_RS_M), 1)

export const appConfig = {
  apiBase: API_BASE.replace(/\/$/, ''),
  lcdBase: LCD_BASE.replace(/\/$/, ''),
  evmRpc: EVM_RPC.replace(/\/$/, ''),
  chainId: Number(import.meta.env.VITE_CHAIN_ID || 31337),
  gatewayBase: GATEWAY_BASE.replace(/\/$/, ''),
  spBase: SP_BASE.replace(/\/$/, ''),
  gatewayDisabled: GATEWAY_DISABLED,
  p2pEnabled: P2P_ENABLED,
  p2pBootstrap: P2P_BOOTSTRAP.split(',').map((value: string) => value.trim()).filter(Boolean),
  p2pProtocol: P2P_PROTOCOL.trim() || '/nilstore/http/1.0.0',
  faucetEnabled: FAUCET_ENABLED,
  cosmosChainId: COSMOS_CHAIN_ID,
  bridgeAddress: BRIDGE_ADDRESS,
  nilstorePrecompile: NILSTORE_PRECOMPILE.trim(),
  explorerBase: EXPLORER_BASE.replace(/\/$/, ''),
  defaultRsK: DEFAULT_RS_K,
  defaultRsM: DEFAULT_RS_M,
}
