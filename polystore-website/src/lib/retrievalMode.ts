import { appConfig } from '../config'
import { isTrustedLocalGatewayBase } from './transport/mode'

export const LOCAL_GATEWAY_CONNECTED_KEY = 'polystore_local_gateway_connected'
export const LOCAL_GATEWAY_CONNECTED_BASE_KEY = 'polystore_local_gateway_connected_base'

export interface GatewayModeInput {
  preference?: string
  gatewayBase?: string
  localGatewayConnected?: boolean
}

export interface PrimaryCacheIndicatorInput {
  gatewayModePreferred: boolean
  browserAvailable: boolean
  gatewayCached: boolean
}

export function readLocalGatewayConnectedHint(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LOCAL_GATEWAY_CONNECTED_KEY) === '1'
  } catch {
    return false
  }
}

export function readLocalGatewayConnectedBase(): string | undefined {
  if (!readLocalGatewayConnectedHint() || typeof window === 'undefined') return undefined
  try {
    const base = String(window.localStorage.getItem(LOCAL_GATEWAY_CONNECTED_BASE_KEY) || '').trim().replace(/\/$/, '')
    return isTrustedLocalGatewayBase(base) ? base : undefined
  } catch {
    return undefined
  }
}

export function persistLocalGatewayConnection(base?: string): void {
  if (typeof window === 'undefined') return
  try {
    const clean = String(base || '').trim().replace(/\/$/, '')
    if (isTrustedLocalGatewayBase(clean)) {
      window.localStorage.setItem(LOCAL_GATEWAY_CONNECTED_BASE_KEY, clean)
      window.localStorage.setItem(LOCAL_GATEWAY_CONNECTED_KEY, '1')
    } else {
      window.localStorage.setItem(LOCAL_GATEWAY_CONNECTED_KEY, '0')
      window.localStorage.removeItem(LOCAL_GATEWAY_CONNECTED_BASE_KEY)
    }
  } catch {
    // best-effort only
  }
}

export function isGatewayModePreferred(input: GatewayModeInput): boolean {
  const preference = String(input.preference || '').trim()
  const gatewayBase = String(input.gatewayBase || appConfig.gatewayBase || '').trim()
  const localGatewayConnected = input.localGatewayConnected ?? readLocalGatewayConnectedHint()
  const gatewayTrusted = isTrustedLocalGatewayBase(gatewayBase)
  if (!gatewayTrusted) return false

  if (preference === 'prefer_direct_sp' || preference === 'prefer_p2p') return false
  if (preference === 'prefer_gateway' || preference === 'gateway_only') return true
  if (preference === 'auto' || preference === '') return localGatewayConnected
  return localGatewayConnected
}

export function formatCacheSourceLabel(source: string): string {
  const normalized = String(source || '').trim().toLowerCase()
  switch (normalized) {
    case 'gateway_mdu_cache':
      return 'gateway mdu cache'
    case 'browser_mdu_cache':
      return 'browser mdu cache'
    case 'browser_cached_file':
      return 'browser file cache'
    case 'network_fetch':
      return 'provider network fetch'
    case 'network_fetch_p2p':
      return 'libp2p network fetch'
    default:
      return normalized ? normalized.replace(/_/g, ' ') : ''
  }
}

export function primaryCacheIndicatorLabel(input: PrimaryCacheIndicatorInput): string {
  if (input.gatewayModePreferred) {
    if (input.gatewayCached) return 'Gateway'
    if (input.browserAvailable) return 'Browser fallback'
    return 'None'
  }
  if (input.browserAvailable) return 'Browser'
  if (input.gatewayCached) return 'Gateway'
  return 'None'
}
