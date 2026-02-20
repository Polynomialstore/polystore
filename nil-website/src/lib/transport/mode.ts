import type { RoutePreference } from './types'

export interface ResolveTransportPreferenceInput {
  candidate: RoutePreference
  gatewayDisabled: boolean
  p2pEnabled: boolean
  localGatewayConnected: boolean
}

export function resolveTransportPreference(input: ResolveTransportPreferenceInput): RoutePreference {
  const { candidate, gatewayDisabled, p2pEnabled, localGatewayConnected } = input

  if (gatewayDisabled) {
    if (candidate === 'prefer_p2p' && p2pEnabled) return 'prefer_p2p'
    return 'prefer_direct_sp'
  }

  if (candidate === 'auto' && localGatewayConnected) {
    return 'prefer_gateway'
  }

  if (candidate === 'prefer_p2p' && !p2pEnabled) {
    return 'auto'
  }

  return candidate
}

export function allowNonGatewayBackends(preference: RoutePreference): boolean {
  void preference
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
