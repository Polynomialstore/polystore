import { fetchWithTimeout } from '../lib/http'
import type { ManifestInfoData, MduKzgData, NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type GatewayUploadResultShape = {
  manifest_root?: unknown
  cid?: unknown
  size_bytes?: unknown
  file_size_bytes?: unknown
  logical_size_bytes?: unknown
  content_encoding?: unknown
  allocated_length?: unknown
  total_mdus?: unknown
  witness_mdus?: unknown
}

type GatewayUploadAcceptedShape = {
  status?: unknown
  upload_id?: unknown
  status_url?: unknown
  phase?: unknown
  message?: unknown
}

type GatewayUploadPollShape = GatewayUploadResultShape & {
  status?: unknown
  phase?: unknown
  error?: unknown
  result?: GatewayUploadResultShape
}

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  return normalized
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function createUploadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `gw-${Math.random().toString(16).slice(2)}-${Date.now()}`
}

function normalizeGatewayUploadResult(value: unknown): UploadResult {
  const obj = isRecord(value) ? value : {}
  const sizeBytesRaw = obj.size_bytes ?? obj.sizeBytes ?? obj['size-bytes'] ?? 0
  const fileSizeRaw = obj.file_size_bytes ?? obj.fileSizeBytes ?? obj['file-size-bytes'] ?? sizeBytesRaw
  const logicalSizeRaw = obj.logical_size_bytes ?? obj.logicalSizeBytes
  const encodingRaw = obj.content_encoding ?? obj.contentEncoding
  const allocatedRaw = obj.allocated_length
  const totalMdusRaw = obj.total_mdus ?? obj.totalMdus
  const witnessMdusRaw = obj.witness_mdus ?? obj.witnessMdus
  const cidRaw = obj.cid ?? obj.manifest_root ?? ''

  return {
    cid: String(cidRaw || ''),
    sizeBytes: asNumber(sizeBytesRaw) || 0,
    fileSizeBytes: asNumber(fileSizeRaw) || 0,
    logicalSizeBytes: logicalSizeRaw !== undefined ? Number(logicalSizeRaw) : undefined,
    contentEncoding: asString(encodingRaw),
    allocatedLength: allocatedRaw !== undefined ? Number(allocatedRaw) || undefined : undefined,
    totalMdus: totalMdusRaw !== undefined ? Number(totalMdusRaw) || undefined : undefined,
    witnessMdus: witnessMdusRaw !== undefined ? Number(witnessMdusRaw) || undefined : undefined,
    filename: String(obj.filename ?? ''),
  }
}

function parseAcceptedUploadResponse(value: unknown): GatewayUploadAcceptedShape | null {
  if (!isRecord(value)) return null
  const status = asString(value.status)
  if (status?.toLowerCase() !== 'accepted') return null
  return {
    status: status,
    upload_id: value.upload_id,
    status_url: value.status_url,
    phase: value.phase,
    message: value.message,
  }
}

function parseUploadPollResponse(value: unknown): GatewayUploadPollShape | null {
  if (!isRecord(value)) return null
  const resultObj = isRecord(value.result) ? (value.result as UnknownRecord) : undefined
  return {
    status: value.status,
    phase: value.phase,
    error: value.error,
    result: resultObj,
  }
}

async function waitForGatewayUploadResult(
  statusUrl: string,
  {
    timeoutMs = 60_000,
    pollMs = 1_000,
    totalTimeoutMs = 10 * 60_000,
    fetchFn = fetch,
  }: {
    timeoutMs?: number
    pollMs?: number
    totalTimeoutMs?: number
    fetchFn?: typeof fetch
  },
): Promise<UploadResult> {
  const deadline = Date.now() + totalTimeoutMs
  let lastError: string | null = null
  while (Date.now() < deadline) {
    const statusResponse = await fetchWithTimeout(statusUrl, { method: 'GET' }, timeoutMs, fetchFn)
    if (!statusResponse.ok) {
      lastError = `upload status returned ${statusResponse.status}`
      await sleep(pollMs)
      continue
    }

    const payload = parseUploadPollResponse(await statusResponse.json().catch(() => null))
    if (!payload) {
      lastError = 'invalid upload status payload'
      await sleep(pollMs)
      continue
    }

    const status = asString(payload.status)
    const err = asString(payload.error)
    if (status === 'error') {
      throw new Error(err || 'gateway upload failed')
    }

    if (status === 'success') {
      if (payload.result) {
        return normalizeGatewayUploadResult(payload.result)
      }
      if (payload.phase === 'done') {
        throw new Error('gateway upload finished without result data')
      }
    }

    if (status === 'running') {
      lastError = null
    }
    await sleep(pollMs)
  }

  throw new Error(lastError || `gateway upload polling timed out after ${totalTimeoutMs}ms`)
}

export interface UploadResult {
  cid: string
  sizeBytes: number
  fileSizeBytes: number
  logicalSizeBytes?: number
  contentEncoding?: string
  allocatedLength?: number
  totalMdus?: number
  witnessMdus?: number
  filename: string
}

export async function gatewayUpload(
  gatewayBase: string,
  input: { file: File; owner: string; dealId?: string; maxUserMdus?: number },
): Promise<UploadResult> {
  const uploadId = createUploadId()
  const form = new FormData()
  form.append('file', input.file)
  form.append('owner', input.owner)
  if (input.dealId) form.append('deal_id', String(input.dealId))
  form.append('upload_id', uploadId)
  if (input.maxUserMdus) form.append('max_user_mdus', String(input.maxUserMdus))

  const q = new URLSearchParams()
  if (input.dealId) q.set('deal_id', String(input.dealId))
  q.set('upload_id', uploadId)
  const url = q.size > 0 ? `${gatewayBase}/gateway/upload?${q.toString()}` : `${gatewayBase}/gateway/upload`

  const res = await fetchWithTimeout(
    url,
    { method: 'POST', body: form },
    60_000,
  )

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Upload failed (${res.status})`)
  }

  const responseBody: unknown = await res.json().catch(() => ({}))
  if (res.status === 202) {
    const accepted = parseAcceptedUploadResponse(responseBody)
    if (!accepted) {
      throw new Error('gateway accepted upload without status metadata')
    }
    const statusUrl = asString(accepted.status_url)
    if (!statusUrl) {
      throw new Error('gateway did not provide upload status URL')
    }
    return await waitForGatewayUploadResult(statusUrl, { fetchFn: fetch, totalTimeoutMs: 10 * 60_000, pollMs: 1_000 })
  }

  return normalizeGatewayUploadResult(responseBody)
}

export async function gatewayFetchSlabLayout(
  gatewayBase: string,
  manifestRoot: string,
  params?: { dealId?: string; owner?: string },
  fetchFn: typeof fetch = fetch,
): Promise<SlabLayoutData> {
  let url = `${gatewayBase}/gateway/slab/${encodeURIComponent(manifestRoot)}`
  if (params?.dealId && params?.owner) {
    const q = new URLSearchParams()
    q.set('deal_id', String(params.dealId))
    q.set('owner', params.owner)
    url = `${url}?${q.toString()}`
  }

  const res = await fetchFn(url)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Gateway slab returned ${res.status}`)
  }

  const json = (await res.json().catch(() => null)) as SlabLayoutData | null
  if (!json) throw new Error('Invalid slab JSON')
  return json
}

export async function gatewayListFiles(
  gatewayBase: string,
  manifestRoot: string,
  params: { dealId: string; owner: string },
  fetchFn: typeof fetch = fetch,
): Promise<NilfsFileEntry[]> {
  const url = `${gatewayBase}/gateway/list-files/${encodeURIComponent(
    manifestRoot,
  )}?deal_id=${encodeURIComponent(params.dealId)}&owner=${encodeURIComponent(params.owner)}`

  const res = await fetchFn(url)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Gateway list-files returned ${res.status}`)
  }

  const payload: unknown = await res.json().catch(() => null)
  if (!isRecord(payload)) return []
  const files = payload['files']
  if (!Array.isArray(files)) return []

  return files.filter((f): f is NilfsFileEntry => isRecord(f) && typeof f['path'] === 'string') as NilfsFileEntry[]
}

export async function gatewayFetchManifestInfo(
  gatewayBase: string,
  manifestRoot: string,
  params?: { dealId?: string; owner?: string },
  fetchFn: typeof fetch = fetch,
): Promise<ManifestInfoData> {
  let url = `${gatewayBase}/gateway/manifest-info/${encodeURIComponent(manifestRoot)}`
  if (params?.dealId && params?.owner) {
    const q = new URLSearchParams()
    q.set('deal_id', String(params.dealId))
    q.set('owner', params.owner)
    url = `${url}?${q.toString()}`
  }

  const res = await fetchFn(url)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Gateway manifest-info returned ${res.status}`)
  }

  const json = (await res.json().catch(() => null)) as ManifestInfoData | null
  if (!json) throw new Error('Invalid manifest-info JSON')
  return json
}

export async function gatewayFetchMduKzg(
  gatewayBase: string,
  manifestRoot: string,
  mduIndex: number,
  params?: { dealId?: string; owner?: string },
  fetchFn: typeof fetch = fetch,
): Promise<MduKzgData> {
  let url = `${gatewayBase}/gateway/mdu-kzg/${encodeURIComponent(manifestRoot)}/${encodeURIComponent(
    String(mduIndex),
  )}`
  if (params?.dealId && params?.owner) {
    const q = new URLSearchParams()
    q.set('deal_id', String(params.dealId))
    q.set('owner', params.owner)
    url = `${url}?${q.toString()}`
  }

  const res = await fetchWithTimeout(url, { method: 'GET' }, 60_000, fetchFn)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Gateway mdu-kzg returned ${res.status}`)
  }

  const json = (await res.json().catch(() => null)) as MduKzgData | null
  if (!json) throw new Error('Invalid mdu-kzg JSON')
  return json
}

export interface GatewayPlanResponse {
  deal_id: number
  owner: string
  provider: string
  manifest_root: string
  file_path: string
  range_start: number
  range_len: number
  start_mdu_index: number
  start_blob_index: number
  blob_count: number
}

export async function gatewayPlanRetrievalSession(
  gatewayBase: string,
  manifestRoot: string,
  params: { dealId: string; owner: string; filePath: string; rangeStart?: number; rangeLen?: number },
  fetchFn: typeof fetch = fetch,
): Promise<GatewayPlanResponse> {
  const q = new URLSearchParams()
  q.set('deal_id', params.dealId)
  q.set('owner', params.owner)
  q.set('file_path', params.filePath)
  if (params.rangeStart !== undefined) q.set('range_start', String(params.rangeStart))
  if (params.rangeLen !== undefined) q.set('range_len', String(params.rangeLen))

  const url = `${gatewayBase}/gateway/plan-retrieval-session/${encodeURIComponent(manifestRoot)}?${q.toString()}`
  const res = await fetchWithTimeout(url, { method: 'GET' }, 10_000, fetchFn)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Gateway plan returned ${res.status}`)
  }
  const json = (await res.json().catch(() => null)) as GatewayPlanResponse | null
  if (!json) throw new Error('Invalid plan JSON')
  return json
}
