import type {
  LcdDeal,
  LcdParams,
  LcdPendingProviderPairing,
  LcdProvider,
  LcdProviderPairing,
} from '../domain/lcd'
import {
  normalizeLcdDealResponse,
  normalizeLcdDealsResponse,
  normalizeLcdParamsResponse,
  normalizeLcdPendingProviderPairingResponse,
  normalizeLcdProviderPairingResponse,
  normalizeLcdProviderPairingsResponse,
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

export async function lcdFetchProviderPairing(
  lcdBase: string,
  provider: string,
  fetchFn: typeof fetch = fetch,
): Promise<LcdProviderPairing | null> {
  const res = await fetchFn(
    `${lcdBase}/nilchain/nilchain/v1/provider-pairings/${encodeURIComponent(provider)}`,
  )
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`LCD provider pairing returned ${res.status}`)
  }
  const json: unknown = await res.json().catch(() => null)
  return normalizeLcdProviderPairingResponse(json)
}

export async function lcdFetchProvidersByOperator(
  lcdBase: string,
  operator: string,
  fetchFn: typeof fetch = fetch,
): Promise<LcdProviderPairing[]> {
  const res = await fetchFn(
    `${lcdBase}/nilchain/nilchain/v1/provider-pairings/by-operator/${encodeURIComponent(operator)}`,
  )
  if (res.status === 404) return []
  if (!res.ok) {
    throw new Error(`LCD operator pairings returned ${res.status}`)
  }
  const json: unknown = await res.json().catch(() => null)
  return normalizeLcdProviderPairingsResponse(json)
}

export async function lcdFetchPendingProviderPairing(
  lcdBase: string,
  pairingId: string,
  fetchFn: typeof fetch = fetch,
): Promise<LcdPendingProviderPairing | null> {
  const res = await fetchFn(
    `${lcdBase}/nilchain/nilchain/v1/provider-pairings/pending/${encodeURIComponent(pairingId)}`,
  )
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`LCD pending provider pairing returned ${res.status}`)
  }
  const json: unknown = await res.json().catch(() => null)
  return normalizeLcdPendingProviderPairingResponse(json)
}

export async function lcdFetchLatestHeight(
  lcdBase: string,
  fetchFn: typeof fetch = fetch,
): Promise<number | null> {
  const res = await fetchFn(`${lcdBase}/cosmos/base/tendermint/v1beta1/blocks/latest`)
  if (!res.ok) {
    throw new Error(`LCD latest height returned ${res.status}`)
  }
  const json: unknown = await res.json().catch(() => null)
  const heightValue =
    typeof json === 'object' &&
    json !== null &&
    typeof (json as { block?: { header?: { height?: unknown } } }).block?.header?.height !== 'undefined'
      ? (json as { block?: { header?: { height?: unknown } } }).block?.header?.height
      : null
  const height = Number(heightValue)
  if (!Number.isFinite(height) || height <= 0) return null
  return Math.floor(height)
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
