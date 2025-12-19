import { lcdFetchDeal, lcdFetchProviders } from '../api/lcdClient'
import { multiaddrToHttpUrl } from './multiaddr'

export interface ProviderEndpoint {
  provider: string
  baseUrl: string
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

  for (const ep of entry.endpoints) {
    const url = multiaddrToHttpUrl(ep)
    if (url) {
      return { provider, baseUrl: url }
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
    for (const ep of entry.endpoints) {
      const url = multiaddrToHttpUrl(ep)
      if (url) {
        baseUrl = url
        break
      }
    }
    out.push({ provider, baseUrl })
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
  for (const ep of entry.endpoints) {
    const url = multiaddrToHttpUrl(ep)
    if (url) {
      return { provider: addr, baseUrl: url }
    }
  }
  return null
}
