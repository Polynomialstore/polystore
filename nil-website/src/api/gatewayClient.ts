import { fetchWithTimeout } from '../lib/http'
import type { ManifestInfoData, MduKzgData, NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null
}

export interface UploadResult {
  cid: string
  sizeBytes: number
  fileSizeBytes: number
  allocatedLength?: number
  filename: string
}

export async function gatewayUpload(
  gatewayBase: string,
  input: { file: File; owner: string; dealId?: string; maxUserMdus?: number },
): Promise<UploadResult> {
  const form = new FormData()
  form.append('file', input.file)
  form.append('owner', input.owner)
  if (input.dealId) form.append('deal_id', String(input.dealId))
  if (input.maxUserMdus) form.append('max_user_mdus', String(input.maxUserMdus))

  const q = new URLSearchParams()
  if (input.dealId) q.set('deal_id', String(input.dealId))
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

  const json: unknown = await res.json().catch(() => ({}))
  const obj = isRecord(json) ? json : {}

  const sizeBytesRaw = obj['size_bytes'] ?? obj['sizeBytes'] ?? 0
  const fileSizeRaw = obj['file_size_bytes'] ?? obj['fileSizeBytes'] ?? sizeBytesRaw
  const allocatedRaw = obj['allocated_length']

  return {
    cid: String(obj['cid'] ?? obj['manifest_root'] ?? ''),
    sizeBytes: Number(sizeBytesRaw) || 0,
    fileSizeBytes: Number(fileSizeRaw) || 0,
    allocatedLength: allocatedRaw !== undefined ? Number(allocatedRaw) : undefined,
    filename: String(obj['filename'] ?? ''),
  }
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
