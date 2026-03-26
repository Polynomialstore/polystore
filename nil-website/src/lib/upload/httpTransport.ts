import type { UploadTarget, UploadTransportPort } from './engine'
import type { SparseArtifactInput } from './sparseArtifacts'
import { postSparseArtifact } from './sparseTransport'

interface TargetUrlSet {
  mdu: string
  manifest: string
  shard?: string
}

const targetUrlCache = new WeakMap<UploadTarget, TargetUrlSet>()

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

function targetUrls(target: UploadTarget): TargetUrlSet {
  const cached = targetUrlCache.get(target)
  if (cached) return cached

  const base = normalizeBaseUrl(target.baseUrl)
  const urls: TargetUrlSet = {
    mdu: `${base}${target.mduPath}`,
    manifest: `${base}${target.manifestPath}`,
    shard: target.shardPath ? `${base}${target.shardPath}` : undefined,
  }
  targetUrlCache.set(target, urls)
  return urls
}

function targetUrl(target: UploadTarget, artifact: SparseArtifactInput): string {
  const urls = targetUrls(target)
  if (artifact.kind === 'mdu') return urls.mdu
  if (artifact.kind === 'manifest') return urls.manifest
  if (!urls.shard) {
    throw new Error(`target ${target.label || target.baseUrl} does not support shard uploads`)
  }
  return urls.shard
}

function buildHeaders(
  dealId: string,
  manifestRoot: string,
  previousManifestRoot: string | undefined,
  artifact: SparseArtifactInput,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Nil-Deal-ID': dealId,
    'X-Nil-Manifest-Root': manifestRoot,
    'Content-Type': 'application/octet-stream',
  }
  const normalizedPreviousManifestRoot = String(previousManifestRoot || '').trim()
  if (normalizedPreviousManifestRoot !== '') {
    headers['X-Nil-Previous-Manifest-Root'] = normalizedPreviousManifestRoot
  }
  if (artifact.kind === 'mdu' || artifact.kind === 'shard') {
    headers['X-Nil-Mdu-Index'] = String(artifact.index)
  }
  if (artifact.kind === 'shard') {
    headers['X-Nil-Slot'] = String(artifact.slot)
  }
  return headers
}

export function createSparseHttpTransportPort(): UploadTransportPort {
  return {
    async sendArtifact(request) {
      const response = await postSparseArtifact({
        url: targetUrl(request.target, request.artifact),
        headers: buildHeaders(request.dealId, request.manifestRoot, request.previousManifestRoot, request.artifact),
        artifact: request.artifact,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(text || `${request.artifact.kind} upload failed (${response.status})`)
      }
    },
  }
}
