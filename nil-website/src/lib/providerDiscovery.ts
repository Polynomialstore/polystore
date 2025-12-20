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
