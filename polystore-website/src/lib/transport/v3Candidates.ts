import { allowNonGatewayBackends } from './mode'
import type { RoutePreference, TransportCandidate } from './types'

export function v3RetrievalCandidates<T>(
  preference: RoutePreference,
  gatewayBase: string | undefined,
  directBases: readonly string[],
  execute: (base: string, gateway: boolean, signal: AbortSignal) => Promise<T>,
): TransportCandidate<T>[] {
  const candidates: TransportCandidate<T>[] = []
  const gateway = gatewayBase?.replace(/\/$/, '')
  if (gateway) candidates.push({ backend: 'gateway', endpoint: gateway, execute: (signal) => execute(gateway, true, signal) })
  if (!allowNonGatewayBackends(preference)) return candidates
  const seen = new Set(gateway ? [gateway] : [])
  for (const raw of directBases) {
    const base = raw.trim().replace(/\/$/, '')
    if (!base || seen.has(base)) continue
    seen.add(base)
    candidates.push({ backend: 'direct_sp', endpoint: base, execute: (signal) => execute(base, false, signal) })
  }
  return candidates
}
