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
