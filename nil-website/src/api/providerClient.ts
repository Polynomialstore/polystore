import { fetchWithTimeout } from '../lib/http'
import type { ManifestInfoData, MduKzgData, NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'
import type { GatewayPlanResponse, UploadResult } from './gatewayClient'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type ProviderUploadResultShape = {
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

type ProviderUploadAcceptedShape = {
  status?: unknown
  upload_id?: unknown
  status_url?: unknown
  phase?: unknown
  message?: unknown
}

type ProviderUploadPollShape = ProviderUploadResultShape & {
  status?: unknown
  phase?: unknown
  error?: unknown
  result?: ProviderUploadResultShape
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
  return `sp-${Math.random().toString(16).slice(2)}-${Date.now()}`
}

function normalizeProviderUploadResult(value: unknown): UploadResult {
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

function parseAcceptedUploadResponse(value: unknown): ProviderUploadAcceptedShape | null {
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

function parseUploadPollResponse(value: unknown): ProviderUploadPollShape | null {
  if (!isRecord(value)) return null
  const resultObj = isRecord(value.result) ? (value.result as UnknownRecord) : undefined
  return {
    status: value.status,
    phase: value.phase,
    error: value.error,
    result: resultObj,
  }
}

async function waitForProviderUploadResult(
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
      throw new Error(err || 'provider upload failed')
    }
    if (status === 'success') {
      if (payload.result) return normalizeProviderUploadResult(payload.result)
      if (payload.phase === 'done') throw new Error('provider upload finished without result data')
    }

    if (status === 'running') {
      lastError = null
    }
    await sleep(pollMs)
  }
  throw new Error(lastError || `provider upload polling timed out after ${totalTimeoutMs}ms`)
}

export async function providerUpload(
  providerBase: string,
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
  const url = `${providerBase}/sp/retrieval/upload?${q.toString()}`

  const res = await fetchWithTimeout(url, { method: 'POST', body: form }, 60_000)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Upload failed (${res.status})`)
  }

  const responseBody: unknown = await res.json().catch(() => ({}))
  if (res.status === 202) {
    const accepted = parseAcceptedUploadResponse(responseBody)
    if (!accepted) {
      throw new Error('provider accepted upload without status metadata')
    }
    const statusUrl = asString(accepted.status_url)
    if (!statusUrl) {
      throw new Error('provider did not provide upload status URL')
    }
    return await waitForProviderUploadResult(statusUrl, { fetchFn: fetch, totalTimeoutMs: 10 * 60_000, pollMs: 1_000 })
  }
  return normalizeProviderUploadResult(responseBody)
}

export async function providerFetchSlabLayout(
  providerBase: string,
  manifestRoot: string,
  params?: { dealId?: string; owner?: string },
  fetchFn: typeof fetch = fetch,
): Promise<SlabLayoutData> {
  let url = `${providerBase}/sp/retrieval/slab/${encodeURIComponent(manifestRoot)}`
  if (params?.dealId && params?.owner) {
    const q = new URLSearchParams()
    q.set('deal_id', String(params.dealId))
    q.set('owner', params.owner)
    url = `${url}?${q.toString()}`
  }

  const res = await fetchFn(url)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Provider slab returned ${res.status}`)
  }

  const json = (await res.json().catch(() => null)) as SlabLayoutData | null
  if (!json) throw new Error('Invalid slab JSON')
  return json
}

export async function providerListFiles(
  providerBase: string,
  manifestRoot: string,
  params: { dealId: string; owner: string },
  fetchFn: typeof fetch = fetch,
): Promise<NilfsFileEntry[]> {
  const url = `${providerBase}/sp/retrieval/list-files/${encodeURIComponent(
    manifestRoot,
  )}?deal_id=${encodeURIComponent(params.dealId)}&owner=${encodeURIComponent(params.owner)}`

  const res = await fetchFn(url)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Provider list-files returned ${res.status}`)
  }

  const payload: unknown = await res.json().catch(() => null)
  if (!isRecord(payload)) return []
  const files = payload['files']
  if (!Array.isArray(files)) return []

  return files
    .filter((f): f is Record<string, unknown> => isRecord(f) && typeof f['path'] === 'string')
    .map((f): NilfsFileEntry => ({
      path: String(f['path']),
      size_bytes: asNumber(f['size_bytes']) ?? 0,
      logical_size_bytes: asNumber(f['logical_size_bytes']),
      content_encoding: asString(f['content_encoding']),
      start_offset: asNumber(f['start_offset']) ?? 0,
      flags: asNumber(f['flags']) ?? 0,
      cache_present: f['cache_present'] === true,
    }))
}

export async function providerFetchManifestInfo(
  providerBase: string,
  manifestRoot: string,
  params?: { dealId?: string; owner?: string },
  fetchFn: typeof fetch = fetch,
): Promise<ManifestInfoData> {
  let url = `${providerBase}/sp/retrieval/manifest-info/${encodeURIComponent(manifestRoot)}`
  if (params?.dealId && params?.owner) {
    const q = new URLSearchParams()
    q.set('deal_id', String(params.dealId))
    q.set('owner', params.owner)
    url = `${url}?${q.toString()}`
  }

  const res = await fetchFn(url)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Provider manifest-info returned ${res.status}`)
  }

  const json = (await res.json().catch(() => null)) as ManifestInfoData | null
  if (!json) throw new Error('Invalid manifest-info JSON')
  return json
}

export async function providerFetchMduKzg(
  providerBase: string,
  manifestRoot: string,
  mduIndex: number,
  params?: { dealId?: string; owner?: string },
  fetchFn: typeof fetch = fetch,
): Promise<MduKzgData> {
  let url = `${providerBase}/sp/retrieval/mdu-kzg/${encodeURIComponent(manifestRoot)}/${encodeURIComponent(
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
    throw new Error(txt || `Provider mdu-kzg returned ${res.status}`)
  }

  const json = (await res.json().catch(() => null)) as MduKzgData | null
  if (!json) throw new Error('Invalid mdu-kzg JSON')
  return json
}

export async function providerPlanRetrievalSession(
  providerBase: string,
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

  const url = `${providerBase}/sp/retrieval/plan/${encodeURIComponent(manifestRoot)}?${q.toString()}`
  const res = await fetchWithTimeout(url, { method: 'GET' }, 10_000, fetchFn)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(txt || `Provider retrieval plan returned ${res.status}`)
  }
  const json = (await res.json().catch(() => null)) as GatewayPlanResponse | null
  if (!json) throw new Error('Invalid plan JSON')
  return json
}

