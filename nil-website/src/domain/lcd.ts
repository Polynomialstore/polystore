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

