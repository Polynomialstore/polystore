import { lcdFetchDeal, lcdFetchProviders } from '../api/lcdClient'
import { multiaddrToHttpUrl, multiaddrToP2pTarget, type P2pTarget } from './multiaddr'

export interface ProviderEndpoint {
  provider: string
  baseUrl: string
  p2pTarget?: P2pTarget
}

export interface ProviderP2pEndpoint {
  provider: string
  target: P2pTarget
}

const LOCAL_PROVIDER_BASE_BY_HOST: Record<string, string> = {
  'sp1.nilstore.org': 'http://127.0.0.1:8091',
  'sp2.nilstore.org': 'http://127.0.0.1:8092',
  'sp3.nilstore.org': 'http://127.0.0.1:8093',
}

const localProviderBaseProbeCache = new Map<string, Promise<string | null>>()

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').trim().replace(/\/$/, '')
}

export function localProviderBaseFor(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  if (!normalized) return ''
  try {
    const parsed = new URL(normalized)
    return LOCAL_PROVIDER_BASE_BY_HOST[parsed.hostname.toLowerCase()] || ''
  } catch {
    return ''
  }
}

export function clearLocalProviderBaseProbeCache(): void {
  localProviderBaseProbeCache.clear()
}

async function probeLocalProviderBase(loopbackBase: string, fetchFn: typeof fetch): Promise<string | null> {
  const statusUrl = `${loopbackBase}/status`
  try {
    const res = await fetchFn(statusUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(1_000),
    })
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    if (!payload || typeof payload !== 'object') return null
    const persona = typeof payload.persona === 'string' ? payload.persona.trim().toLowerCase() : ''
    if (persona !== 'provider-daemon' && persona !== 'provider_daemon') return null
    const families = Array.isArray(payload.allowed_route_families)
      ? payload.allowed_route_families
          .filter((value: unknown): value is string => typeof value === 'string')
          .map((value: string) => value.trim().toLowerCase())
      : []
    if (families.length > 0 && !families.some((value: string) => value === 'sp' || value.startsWith('sp/'))) {
      return null
    }
    return loopbackBase
  } catch {
    return null
  }
}

export async function preferLocalProviderBase(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const normalized = normalizeBaseUrl(baseUrl)
  const loopbackBase = localProviderBaseFor(normalized)
  if (!normalized || !loopbackBase) return normalized
  let probe = localProviderBaseProbeCache.get(loopbackBase)
  if (!probe) {
    probe = probeLocalProviderBase(loopbackBase, fetchFn)
    localProviderBaseProbeCache.set(loopbackBase, probe)
  }
  const preferred = await probe.catch(() => null)
  return preferred || normalized
}

export async function resolveProviderEndpoint(
  lcdBase: string,
  dealId: string,
): Promise<ProviderEndpoint | null> {
  const deal = await lcdFetchDeal(lcdBase, dealId)
  if (!deal || !deal.providers || deal.providers.length === 0) return null
  const provider = deal.providers[0]

  const providers = await lcdFetchProviders(lcdBase)
  const entry = providers.find((p) => p.address === provider)
  if (!entry?.endpoints || entry.endpoints.length === 0) return null

  let baseUrl = ''
  let p2pTarget: P2pTarget | undefined
  for (const ep of entry.endpoints) {
    if (!baseUrl) {
      const url = multiaddrToHttpUrl(ep)
      if (url) baseUrl = url
    }
    if (!p2pTarget) {
      const target = multiaddrToP2pTarget(ep)
      if (target) p2pTarget = target
    }
  }
  baseUrl = await preferLocalProviderBase(baseUrl)
  if (!baseUrl && !p2pTarget) return null
  return { provider, baseUrl, p2pTarget }
}

export async function resolveProviderP2pEndpoint(
  lcdBase: string,
  dealId: string,
): Promise<ProviderP2pEndpoint | null> {
  const deal = await lcdFetchDeal(lcdBase, dealId)
  if (!deal || !deal.providers || deal.providers.length === 0) return null
  const provider = deal.providers[0]

  const providers = await lcdFetchProviders(lcdBase)
  const entry = providers.find((p) => p.address === provider)
  if (!entry?.endpoints || entry.endpoints.length === 0) return null

  for (const ep of entry.endpoints) {
    const target = multiaddrToP2pTarget(ep)
    if (target) {
      return { provider, target }
    }
  }
  return null
}

export async function resolveProviderEndpoints(
  lcdBase: string,
  dealId: string,
): Promise<ProviderEndpoint[]> {
  const deal = await lcdFetchDeal(lcdBase, dealId)
  if (!deal || !deal.providers || deal.providers.length === 0) return []

  const providers = await lcdFetchProviders(lcdBase)
  const byAddr = new Map(providers.map((p) => [p.address, p]))
  const out: ProviderEndpoint[] = []

  for (const provider of deal.providers) {
    const entry = byAddr.get(provider)
    if (!entry?.endpoints || entry.endpoints.length === 0) {
      out.push({ provider, baseUrl: '' })
      continue
    }
    let baseUrl = ''
    let p2pTarget: P2pTarget | undefined
    for (const ep of entry.endpoints) {
      if (!baseUrl) {
        const url = multiaddrToHttpUrl(ep)
        if (url) baseUrl = url
      }
      if (!p2pTarget) {
        const target = multiaddrToP2pTarget(ep)
        if (target) p2pTarget = target
      }
    }
    baseUrl = await preferLocalProviderBase(baseUrl)
    out.push({ provider, baseUrl, p2pTarget })
  }
  return out
}

export async function resolveProviderEndpointByAddress(
  lcdBase: string,
  providerAddr: string,
): Promise<ProviderEndpoint | null> {
  const addr = providerAddr.trim()
  if (!addr) return null
  const providers = await lcdFetchProviders(lcdBase)
  const entry = providers.find((p) => p.address === addr)
  if (!entry?.endpoints || entry.endpoints.length === 0) return null
  let baseUrl = ''
  let p2pTarget: P2pTarget | undefined
  for (const ep of entry.endpoints) {
    if (!baseUrl) {
      const url = multiaddrToHttpUrl(ep)
      if (url) baseUrl = url
    }
    if (!p2pTarget) {
      const target = multiaddrToP2pTarget(ep)
      if (target) p2pTarget = target
    }
  }
  baseUrl = await preferLocalProviderBase(baseUrl)
  if (!baseUrl && !p2pTarget) return null
  return { provider: addr, baseUrl, p2pTarget }
}

export async function resolveProviderP2pEndpointByAddress(
  lcdBase: string,
  providerAddr: string,
): Promise<ProviderP2pEndpoint | null> {
  const addr = providerAddr.trim()
  if (!addr) return null
  const providers = await lcdFetchProviders(lcdBase)
  const entry = providers.find((p) => p.address === addr)
  if (!entry?.endpoints || entry.endpoints.length === 0) return null
  for (const ep of entry.endpoints) {
    const target = multiaddrToP2pTarget(ep)
    if (target) {
      return { provider: addr, target }
    }
  }
  return null
}
