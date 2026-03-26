import type { UploadTarget, UploadTransportPort } from './engine'
import type { SparseArtifactInput } from './sparseArtifacts'
import { makeSparseArtifact } from './sparseArtifacts'
import { postSparseArtifact } from './sparseTransport'

interface TargetUrlSet {
  mdu: string
  manifest: string
  shard?: string
  bundle?: string
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
    bundle: target.bundlePath ? `${base}${target.bundlePath}` : undefined,
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
  const sendArtifact: UploadTransportPort['sendArtifact'] = async (request) => {
    const response = await postSparseArtifact({
      url: targetUrl(request.target, request.artifact),
      headers: buildHeaders(request.dealId, request.manifestRoot, request.previousManifestRoot, request.artifact),
      artifact: request.artifact,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(text || `${request.artifact.kind} upload failed (${response.status})`)
    }
  }

  return {
    sendArtifact,
    async sendBundle(requests) {
      if (requests.length === 0) return
      const first = requests[0]
      const bundleUrl = targetUrls(first.target).bundle
      if (!bundleUrl) {
        const unsupported = new Error('bundle upload unsupported')
        unsupported.name = 'BundleUnsupportedUploadError'
        throw unsupported
      }

      const form = new FormData()
      const artifacts = requests.map((request, index) => {
        const sparseArtifact = makeSparseArtifact(request.artifact)
        const part = `artifact_${String(index).padStart(2, '0')}`
        return { request, sparseArtifact, part }
      })
      form.append(
        'meta',
        new Blob(
          [
            JSON.stringify({
              deal_id: first.dealId,
              manifest_root: first.manifestRoot,
              previous_manifest_root: String(first.previousManifestRoot || '').trim(),
              artifacts: artifacts.map(({ request, sparseArtifact, part }) => ({
                part,
                kind: request.artifact.kind,
                mdu_index: request.artifact.kind === 'mdu' || request.artifact.kind === 'shard' ? request.artifact.index : undefined,
                slot: request.artifact.kind === 'shard' ? request.artifact.slot : undefined,
                full_size: sparseArtifact.fullSize,
                send_size: sparseArtifact.bytes.byteLength,
              })),
            }),
          ],
          { type: 'application/json' },
        ),
      )
      for (const { request, sparseArtifact, part } of artifacts) {
        const filename =
          request.artifact.kind === 'manifest'
            ? 'manifest.bin'
            : request.artifact.kind === 'mdu'
              ? `mdu_${request.artifact.index}.bin`
              : `mdu_${request.artifact.index}_slot_${request.artifact.slot}.bin`
        form.append(part, new Blob([Uint8Array.from(sparseArtifact.bytes)]), filename)
      }

      const response = await fetch(bundleUrl, {
        method: 'POST',
        body: form,
      })
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        const unsupported = new Error(`bundle upload unsupported (${response.status})`)
        unsupported.name = 'BundleUnsupportedUploadError'
        throw unsupported
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(text || `bundle upload failed (${response.status})`)
      }
    },
  }
}
