import { toHexFromBase64OrHex } from './hex'

export interface LcdDeal {
  id: string
  cid: string
  size: string
  owner: string
  escrow: string
  end_block: string
  start_block?: string
  service_hint?: string
  current_replication?: string
  max_monthly_spend?: string
  providers?: string[]
  retrieval_policy?: {
    mode?: number
    allowlist_root?: string
    voucher_signer?: string
  }
}

export interface LcdProvider {
  address: string
  endpoints?: string[]
  status?: string
}

export interface LcdProviderPairing {
  provider: string
  operator: string
  paired_height: string
}

export interface LcdPendingProviderLink {
  provider: string
  operator: string
  requested_height: string
}

export interface LcdCoin {
  amount: string
  denom: string
}

export interface LcdParams {
  base_retrieval_fee: LcdCoin
  retrieval_price_per_blob: LcdCoin
  retrieval_burn_bps: string
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return fallback
}

export function normalizeLcdDeal(input: unknown): LcdDeal | null {
  if (!isRecord(input)) return null

  const manifestRootHex = toHexFromBase64OrHex(input['manifest_root'], { expectedBytes: [48] })
  const cid = asString(input['cid']) || manifestRootHex
  const retrievalPolicy = isRecord(input['retrieval_policy'])
    ? {
        mode: Number(input['retrieval_policy']['mode'] ?? 0) || 0,
        allowlist_root: toHexFromBase64OrHex(input['retrieval_policy']['allowlist_root'], {
          expectedBytes: [32],
        }) as string,
        voucher_signer: asString(input['retrieval_policy']['voucher_signer'] ?? ''),
      }
    : undefined

  return {
    id: asString(input['id']),
    cid,
    size: asString(input['size'] ?? input['size_bytes'] ?? '0', '0'),
    owner: asString(input['owner']),
    escrow: asString(input['escrow_balance'] ?? input['escrow'] ?? ''),
    end_block: asString(input['end_block']),
    start_block: asString(input['start_block']),
    service_hint: asString(input['service_hint']),
    current_replication: asString(input['current_replication']),
    max_monthly_spend: asString(input['max_monthly_spend']),
    providers: Array.isArray(input['providers'])
      ? (input['providers'].filter((p) => typeof p === 'string') as string[])
      : [],
    retrieval_policy: retrievalPolicy,
  }
}

export function normalizeLcdDealsResponse(payload: unknown): LcdDeal[] {
  if (!isRecord(payload)) return []
  const deals = payload['deals']
  if (!Array.isArray(deals)) return []
  const out: LcdDeal[] = []
  for (const item of deals) {
    const deal = normalizeLcdDeal(item)
    if (deal) out.push(deal)
  }
  return out
}

export function normalizeLcdDealResponse(payload: unknown): LcdDeal | null {
  if (!isRecord(payload)) return null
  const deal = payload['deal']
  if (!deal) return null
  return normalizeLcdDeal(deal)
}

export function normalizeLcdProvidersResponse(payload: unknown): LcdProvider[] {
  if (!isRecord(payload)) return []
  const providers = payload['providers']
  if (!Array.isArray(providers)) return []
  const out: LcdProvider[] = []
  for (const item of providers) {
    if (!isRecord(item)) continue
    const endpoints = Array.isArray(item['endpoints'])
      ? (item['endpoints'].filter((e) => typeof e === 'string') as string[])
      : []
    out.push({
      address: asString(item['address']),
      status: asString(item['status']),
      endpoints: endpoints.length > 0 ? endpoints : undefined,
    })
  }
  return out
}

export function normalizeLcdProviderPairing(input: unknown): LcdProviderPairing | null {
  if (!isRecord(input)) return null
  return {
    provider: asString(input['provider']),
    operator: asString(input['operator']),
    paired_height: asString(input['paired_height'], '0'),
  }
}

export function normalizeLcdProviderPairingResponse(payload: unknown): LcdProviderPairing | null {
  if (!isRecord(payload)) return null
  return normalizeLcdProviderPairing(payload['pairing'])
}

export function normalizeLcdProviderPairingsResponse(payload: unknown): LcdProviderPairing[] {
  if (!isRecord(payload)) return []
  const pairings = payload['pairings']
  if (!Array.isArray(pairings)) return []
  const out: LcdProviderPairing[] = []
  for (const item of pairings) {
    const pairing = normalizeLcdProviderPairing(item)
    if (pairing) out.push(pairing)
  }
  return out
}

export function normalizeLcdPendingProviderLink(input: unknown): LcdPendingProviderLink | null {
  if (!isRecord(input)) return null
  return {
    provider: asString(input['provider']),
    operator: asString(input['operator']),
    requested_height: asString(input['requested_height'], '0'),
  }
}

export function normalizeLcdPendingProviderLinkResponse(payload: unknown): LcdPendingProviderLink | null {
  if (!isRecord(payload)) return null
  return normalizeLcdPendingProviderLink(payload['link'])
}

export function normalizeLcdPendingProviderLinksByOperatorResponse(payload: unknown): LcdPendingProviderLink[] {
  if (!isRecord(payload)) return []
  const links = payload['links']
  if (!Array.isArray(links)) return []
  const out: LcdPendingProviderLink[] = []
  for (const item of links) {
    const link = normalizeLcdPendingProviderLink(item)
    if (link) out.push(link)
  }
  return out
}

function normalizeLcdCoin(input: unknown): LcdCoin {
  if (!isRecord(input)) {
    return { amount: '0', denom: '' }
  }
  return {
    amount: asString(input['amount'], '0'),
    denom: asString(input['denom'], ''),
  }
}

export function normalizeLcdParamsResponse(payload: unknown): LcdParams | null {
  if (!isRecord(payload)) return null
  const params = payload['params']
  if (!isRecord(params)) return null
  return {
    base_retrieval_fee: normalizeLcdCoin(params['base_retrieval_fee']),
    retrieval_price_per_blob: normalizeLcdCoin(params['retrieval_price_per_blob']),
    retrieval_burn_bps: asString(params['retrieval_burn_bps'], '0'),
  }
}
