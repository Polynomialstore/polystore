import type { LcdDeal, LcdParams } from '../domain/lcd'
import { normalizeLcdDealsResponse, normalizeLcdParamsResponse } from '../domain/lcd'

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
