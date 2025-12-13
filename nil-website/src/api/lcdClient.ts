import type { LcdDeal } from '../domain/lcd'
import { normalizeLcdDealsResponse } from '../domain/lcd'

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

