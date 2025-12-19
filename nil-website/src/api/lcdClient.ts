import type { LcdDeal, LcdParams, LcdProvider } from '../domain/lcd'
import {
  normalizeLcdDealResponse,
  normalizeLcdDealsResponse,
  normalizeLcdParamsResponse,
  normalizeLcdProvidersResponse,
} from '../domain/lcd'

export async function lcdFetchDeals(
  lcdBase: string,
  fetchFn: typeof fetch = fetch,
): Promise<LcdDeal[]> {
  const res = await fetchFn(`${lcdBase}/nilchain/nilchain/v1/deals`)
  if (!res.ok) {
    throw new Error(`LCD deals returned ${res.status}`)
  }
  const json: unknown = await res.json().catch(() => null)
  return normalizeLcdDealsResponse(json)
}

export async function lcdFetchDeal(
  lcdBase: string,
  dealId: string,
  fetchFn: typeof fetch = fetch,
): Promise<LcdDeal | null> {
  const res = await fetchFn(`${lcdBase}/nilchain/nilchain/v1/deals/${encodeURIComponent(dealId)}`)
  if (!res.ok) {
    throw new Error(`LCD deal returned ${res.status}`)
  }
  const json: unknown = await res.json().catch(() => null)
  return normalizeLcdDealResponse(json)
}

export async function lcdFetchProviders(
  lcdBase: string,
  fetchFn: typeof fetch = fetch,
): Promise<LcdProvider[]> {
  const res = await fetchFn(`${lcdBase}/nilchain/nilchain/v1/providers`)
  if (!res.ok) {
    throw new Error(`LCD providers returned ${res.status}`)
  }
  const json: unknown = await res.json().catch(() => null)
  return normalizeLcdProvidersResponse(json)
}

export async function lcdFetchParams(
  lcdBase: string,
  fetchFn: typeof fetch = fetch,
): Promise<LcdParams | null> {
  const res = await fetchFn(`${lcdBase}/nilchain/nilchain/v1/params`)
  if (!res.ok) {
    throw new Error(`LCD params returned ${res.status}`)
  }
  const json: unknown = await res.json().catch(() => null)
  return normalizeLcdParamsResponse(json)
}
