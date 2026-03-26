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

const BUNDLE_V2_CONTENT_TYPE = 'application/x.nilstore-bundle-v2'
const bundleHeaderEncoder = new TextEncoder()

const targetUrlCache = new WeakMap<UploadTarget, TargetUrlSet>()

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl
}

function asBlobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart
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

function buildBundleV2Header(metaJson: string): Uint8Array {
  const metaBytes = bundleHeaderEncoder.encode(metaJson)
  const header = new Uint8Array(8 + metaBytes.byteLength)
  header[0] = 0x4e // N
  header[1] = 0x4c // L
  header[2] = 0x42 // B
  header[3] = 0x32 // 2
  const metaLen = metaBytes.byteLength >>> 0
  header[4] = metaLen & 0xff
  header[5] = (metaLen >>> 8) & 0xff
  header[6] = (metaLen >>> 16) & 0xff
  header[7] = (metaLen >>> 24) & 0xff
  header.set(metaBytes, 8)
  return header
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

      const artifacts = requests.map((request, index) => {
        const sparseArtifact = makeSparseArtifact(request.artifact)
        const part = `artifact_${String(index).padStart(2, '0')}`
        return { request, sparseArtifact, part }
      })
      const metaJson = JSON.stringify({
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
      })
      const header = buildBundleV2Header(metaJson)
      const body = new Blob([
        asBlobPart(header),
        ...artifacts.map(({ sparseArtifact }) => asBlobPart(sparseArtifact.bytes)),
      ])
      const response = await fetch(bundleUrl, {
        method: 'POST',
        headers: {
          'Content-Type': BUNDLE_V2_CONTENT_TYPE,
        },
        body,
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
