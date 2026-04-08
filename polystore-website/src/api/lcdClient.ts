import type {
  LcdDeal,
  LcdParams,
  LcdPendingProviderLink,
  LcdProvider,
  LcdProviderPairing,
} from '../domain/lcd'
import {
  normalizeLcdDealResponse,
  normalizeLcdDealsResponse,
  normalizeLcdParamsResponse,
  normalizeLcdPendingProviderLinkResponse,
  normalizeLcdPendingProviderLinksByOperatorResponse,
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

export async function lcdFetchPendingProviderLink(
  lcdBase: string,
  provider: string,
  fetchFn: typeof fetch = fetch,
): Promise<LcdPendingProviderLink | null> {
  const res = await fetchFn(
    `${lcdBase}/nilchain/nilchain/v1/provider-pairings/pending/${encodeURIComponent(provider)}`,
  )
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`LCD pending provider link returned ${res.status}`)
  }
  const json: unknown = await res.json().catch(() => null)
  return normalizeLcdPendingProviderLinkResponse(json)
}

export async function lcdFetchPendingProviderLinksByOperator(
  lcdBase: string,
  operator: string,
  fetchFn: typeof fetch = fetch,
): Promise<LcdPendingProviderLink[]> {
  const res = await fetchFn(
    `${lcdBase}/nilchain/nilchain/v1/provider-pairings/pending-by-operator/${encodeURIComponent(operator)}`,
  )
  if (res.status === 404) return []
  if (!res.ok) {
    throw new Error(`LCD pending provider links returned ${res.status}`)
  }
  const json: unknown = await res.json().catch(() => null)
  return normalizeLcdPendingProviderLinksByOperatorResponse(json)
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
