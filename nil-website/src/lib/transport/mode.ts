import type { RoutePreference } from './types'

export interface ResolveTransportPreferenceInput {
  candidate: RoutePreference
  gatewayDisabled: boolean
  p2pEnabled: boolean
  localGatewayConnected: boolean
}

export interface GatewayTransportEnabledInput {
  gatewayDisabled: boolean
  gatewayBase: string
  localGatewayConnected: boolean
}

export type LocalGatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface GatewayMode2UploadEnabledInput {
  gatewayDisabled: boolean
  gatewayBase: string
  localGatewayStatus: LocalGatewayStatus
}

export function resolveTransportPreference(input: ResolveTransportPreferenceInput): RoutePreference {
  const { candidate, gatewayDisabled, p2pEnabled, localGatewayConnected } = input

  if (candidate === 'gateway_only') {
    return candidate
  }

  if (gatewayDisabled) {
    if (candidate === 'prefer_p2p' && p2pEnabled) return 'prefer_p2p'
    return 'prefer_direct_sp'
  }

  if (!localGatewayConnected) {
    if (candidate === 'prefer_p2p' && p2pEnabled) return 'prefer_p2p'
    return 'prefer_direct_sp'
  }

  if (candidate === 'auto') {
    return 'prefer_gateway'
  }

  if (candidate === 'prefer_p2p' && !p2pEnabled) {
    return 'auto'
  }

  return candidate
}

export function allowNonGatewayBackends(preference: RoutePreference): boolean {
  if (preference === 'gateway_only') return false
  // Even when gateway is preferred, keep direct/p2p candidates available so
  // connection-refused/timeouts can fail over instead of hard failing.
  return true
}

export function isTrustedLocalGatewayBase(base: string): boolean {
  const raw = String(base || '').trim()
  if (!raw) return false
  try {
    const parsed = new URL(raw)
    const host = parsed.hostname.toLowerCase()
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
    if (!isLoopback) return false
    if (parsed.port === '') return false
    return parsed.port === '8080'
  } catch {
    return false
  }
}

export function isGatewayTransportEnabled(input: GatewayTransportEnabledInput): boolean {
  const { gatewayDisabled, gatewayBase, localGatewayConnected } = input
  if (gatewayDisabled) return false
  if (!localGatewayConnected) return false
  return isTrustedLocalGatewayBase(gatewayBase)
}

export function isGatewayMode2UploadEnabled(input: GatewayMode2UploadEnabledInput): boolean {
  const { gatewayDisabled, gatewayBase, localGatewayStatus } = input
  return isGatewayTransportEnabled({
    gatewayDisabled,
    gatewayBase,
    localGatewayConnected: localGatewayStatus === 'connected',
  })
}
