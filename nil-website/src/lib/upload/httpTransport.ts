import type { UploadTarget, UploadTransportPort } from './engine'
import type { SparseArtifactInput } from './sparseArtifacts'
import { postSparseArtifact } from './sparseTransport'

function targetUrl(target: UploadTarget, artifact: SparseArtifactInput): string {
  const base = target.baseUrl.replace(/\/$/, '')
  if (artifact.kind === 'mdu') return `${base}${target.mduPath}`
  if (artifact.kind === 'manifest') return `${base}${target.manifestPath}`
  if (!target.shardPath) {
    throw new Error(`target ${target.label || target.baseUrl} does not support shard uploads`)
  }
  return `${base}${target.shardPath}`
}

function buildHeaders(dealId: string, manifestRoot: string, artifact: SparseArtifactInput): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Nil-Deal-ID': dealId,
    'X-Nil-Manifest-Root': manifestRoot,
    'Content-Type': 'application/octet-stream',
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
        headers: buildHeaders(request.dealId, request.manifestRoot, request.artifact),
        artifact: request.artifact,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(text || `${request.artifact.kind} upload failed (${response.status})`)
      }
    },
  }
}
