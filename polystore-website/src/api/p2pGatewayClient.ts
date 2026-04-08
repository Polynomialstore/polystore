import type { ManifestInfoData, MduKzgData, NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'
import type { P2pTarget } from '../lib/multiaddr'
import type { GatewayPlanResponse } from './gatewayClient'
import { p2pRequest, p2pRequestJson } from '../lib/p2pClient'
import { TransportError } from '../lib/transport/errors'
import { classifyStatus } from '../lib/transport/errors'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

export async function p2pGatewayListFiles(
  target: P2pTarget,
  manifestRoot: string,
  params: { dealId: string; owner: string },
  signal?: AbortSignal,
): Promise<NilfsFileEntry[]> {
  const path = `/gateway/list-files/${encodeURIComponent(manifestRoot)}?deal_id=${encodeURIComponent(
    params.dealId,
  )}&owner=${encodeURIComponent(params.owner)}`
  const res = await p2pRequestJson<unknown>(target, { method: 'GET', path }, signal)
  if (res.status >= 400) {
    throw new Error(res.text || `Gateway list-files returned ${res.status}`)
  }
  if (!isRecord(res.json)) return []
  const files = res.json['files']
  if (!Array.isArray(files)) return []
  return files.filter((f): f is NilfsFileEntry => isRecord(f) && typeof f['path'] === 'string') as NilfsFileEntry[]
}

export async function p2pGatewayFetchSlabLayout(
  target: P2pTarget,
  manifestRoot: string,
  params?: { dealId?: string; owner?: string },
  signal?: AbortSignal,
): Promise<SlabLayoutData> {
  let path = `/gateway/slab/${encodeURIComponent(manifestRoot)}`
  if (params?.dealId && params?.owner) {
    const q = new URLSearchParams()
    q.set('deal_id', String(params.dealId))
    q.set('owner', params.owner)
    path = `${path}?${q.toString()}`
  }

  const res = await p2pRequestJson<SlabLayoutData>(target, { method: 'GET', path }, signal)
  if (res.status >= 400) {
    throw new Error(res.text || `Gateway slab returned ${res.status}`)
  }
  if (!res.json) throw new Error('Invalid slab JSON')
  return res.json
}

export async function p2pGatewayFetchManifestInfo(
  target: P2pTarget,
  manifestRoot: string,
  params?: { dealId?: string; owner?: string },
  signal?: AbortSignal,
): Promise<ManifestInfoData> {
  let path = `/gateway/manifest-info/${encodeURIComponent(manifestRoot)}`
  if (params?.dealId && params?.owner) {
    const q = new URLSearchParams()
    q.set('deal_id', String(params.dealId))
    q.set('owner', params.owner)
    path = `${path}?${q.toString()}`
  }

  const res = await p2pRequestJson<ManifestInfoData>(target, { method: 'GET', path }, signal)
  if (res.status >= 400) {
    throw new Error(res.text || `Gateway manifest-info returned ${res.status}`)
  }
  if (!res.json) throw new Error('Invalid manifest-info JSON')
  return res.json
}

export async function p2pGatewayFetchMduKzg(
  target: P2pTarget,
  manifestRoot: string,
  mduIndex: number,
  params?: { dealId?: string; owner?: string },
  signal?: AbortSignal,
): Promise<MduKzgData> {
  let path = `/gateway/mdu-kzg/${encodeURIComponent(manifestRoot)}/${encodeURIComponent(String(mduIndex))}`
  if (params?.dealId && params?.owner) {
    const q = new URLSearchParams()
    q.set('deal_id', String(params.dealId))
    q.set('owner', params.owner)
    path = `${path}?${q.toString()}`
  }

  const res = await p2pRequestJson<MduKzgData>(target, { method: 'GET', path }, signal)
  if (res.status >= 400) {
    throw new Error(res.text || `Gateway mdu-kzg returned ${res.status}`)
  }
  if (!res.json) throw new Error('Invalid mdu-kzg JSON')
  return res.json
}

export async function p2pGatewayPlanRetrievalSession(
  target: P2pTarget,
  manifestRoot: string,
  params: { dealId: string; owner: string; filePath: string; rangeStart?: number; rangeLen?: number },
  signal?: AbortSignal,
): Promise<GatewayPlanResponse> {
  const q = new URLSearchParams()
  q.set('deal_id', params.dealId)
  q.set('owner', params.owner)
  q.set('file_path', params.filePath)
  if (params.rangeStart !== undefined) q.set('range_start', String(params.rangeStart))
  if (params.rangeLen !== undefined) q.set('range_len', String(params.rangeLen))

  const path = `/gateway/plan-retrieval-session/${encodeURIComponent(manifestRoot)}?${q.toString()}`
  const res = await p2pRequestJson<GatewayPlanResponse>(target, { method: 'GET', path }, signal)
  if (res.status >= 400) {
    throw new Error(res.text || `Gateway plan returned ${res.status}`)
  }
  if (!res.json) throw new Error('Invalid plan JSON')
  return res.json
}

export async function p2pGatewayFetchRange(
  target: P2pTarget,
  params: {
    manifestRoot: string
    owner: string
    dealId: string
    filePath: string
    rangeStart: number
    rangeEnd: number
    sessionId: string
    expectedProvider?: string
  },
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; provider: string }> {
  const q = new URLSearchParams({
    deal_id: params.dealId,
    owner: params.owner,
    file_path: params.filePath,
  })
  const path = `/gateway/fetch/${encodeURIComponent(params.manifestRoot)}?${q.toString()}`

  const res = await p2pRequest(
    target,
    {
      method: 'GET',
      path,
      headers: {
        range: `bytes=${params.rangeStart}-${params.rangeEnd}`,
        'x-nil-session-id': params.sessionId,
      },
    },
    signal,
  )

  if (res.status >= 400) {
    const text = new TextDecoder().decode(res.body)
    throw new TransportError(text || `fetch failed (${res.status})`, classifyStatus(res.status), res.status)
  }

  const provider = res.headers['x-nil-provider'] || ''
  if (!provider) {
    throw new TransportError('missing X-Nil-Provider', 'invalid_response')
  }
  if (params.expectedProvider && provider !== params.expectedProvider) {
    throw new TransportError(
      `provider mismatch: expected ${params.expectedProvider} got ${provider}`,
      'provider_mismatch',
    )
  }

  return { bytes: res.body, provider }
}
