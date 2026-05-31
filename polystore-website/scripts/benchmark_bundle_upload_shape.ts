import { performance } from 'node:perf_hooks'

import { createUploadEngine, type UploadTransportRequest } from '../src/lib/upload/engine'

const MDU_SIZE = 8 * 1024 * 1024
const BLOB_SIZE = 128 * 1024

const userMdus = Number(process.env.BUNDLE_BENCH_USER_MDUS || 13)
const witnessMdus = Number(process.env.BUNDLE_BENCH_WITNESS_MDUS || 1)
const k = Number(process.env.BUNDLE_BENCH_K || 8)
const m = Number(process.env.BUNDLE_BENCH_M || 4)
const latencyMs = Number(process.env.BUNDLE_BENCH_LATENCY_MS || 25)
const unsupportedProviderIndex = Number(process.env.BUNDLE_BENCH_UNSUPPORTED_PROVIDER || -1)

const providerCount = k + m

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function target(index: number, bundled: boolean) {
  return {
    baseUrl: `http://provider-${index}.test`,
    mduPath: '/sp/upload_mdu',
    manifestPath: '/sp/upload_manifest',
    shardPath: '/sp/upload_shard',
    bundlePath: bundled ? '/sp/upload_bundle' : undefined,
    label: `provider-${index}`,
  }
}

function requestBytes(request: UploadTransportRequest): number {
  return Math.max(0, request.artifact.bytes.byteLength)
}

function makeUnsupportedError(): Error {
  const err = new Error('bundle upload unsupported')
  err.name = 'BundleUnsupportedUploadError'
  return err
}

async function runScenario(name: string, options: { bundled: boolean; unsupportedIndex?: number }) {
  let artifactRequests = 0
  let bundleRequests = 0
  let bytesSent = 0
  let active = 0
  let peakActiveUploads = 0
  const bundleSizes: number[] = []

  const transport = {
    async sendArtifact(request: UploadTransportRequest) {
      artifactRequests += 1
      bytesSent += requestBytes(request)
      active += 1
      peakActiveUploads = Math.max(peakActiveUploads, active)
      await sleep(latencyMs)
      active -= 1
    },
    async sendBundle(requests: UploadTransportRequest[]) {
      const label = String(requests[0]?.target.label || '')
      const maybeIndex = Number(label.replace(/^provider-/, ''))
      if (options.unsupportedIndex === maybeIndex) {
        throw makeUnsupportedError()
      }
      const size = requests.reduce((sum, request) => sum + requestBytes(request), 0)
      bundleRequests += 1
      bundleSizes.push(size)
      bytesSent += size
      active += 1
      peakActiveUploads = Math.max(peakActiveUploads, active)
      await sleep(latencyMs)
      active -= 1
    },
  }

  const engine = createUploadEngine({
    transport: options.bundled ? transport : { sendArtifact: transport.sendArtifact },
    parallelism: { stripedMetadata: 6, stripedShards: 6 },
  })

  const metadataMdus = Array.from({ length: 1 + witnessMdus }, (_, index) => ({
    index,
    data: new Uint8Array([index + 1]),
    fullSize: MDU_SIZE,
  }))
  const shardSets = Array.from({ length: userMdus }, (_, userIndex) => ({
    index: 1 + witnessMdus + userIndex,
    shards: Array.from({ length: providerCount }, (_, slot) => ({
      data: new Uint8Array([slot + 1]),
      fullSize: MDU_SIZE / k,
    })),
  }))
  const targets = Array.from({ length: providerCount }, (_, index) => target(index, options.bundled))

  const started = performance.now()
  const result = await engine.uploadStriped({
    dealId: '198',
    manifestRoot: '0x' + 'ab'.repeat(48),
    previousManifestRoot: '',
    manifestBlob: new Uint8Array([9]),
    manifestBlobFullSize: BLOB_SIZE,
    metadataMdus,
    shardSets,
    metadataTargets: targets,
    shardTargets: targets,
  })
  const wallMs = performance.now() - started
  if (!result.ok) {
    throw new Error(`${name} failed: ${result.error || 'unknown error'}`)
  }

  const stats = result.transportStats
  return {
    name,
    wallMs: Math.round(wallMs * 10) / 10,
    latencyMs,
    providerCount,
    rsProfile: `${k}+${m}`,
    userMdus,
    witnessMdus,
    logicalArtifacts: stats?.artifactCount ?? metadataMdus.length * providerCount + userMdus * providerCount + providerCount,
    requestCount: stats?.requestCount ?? artifactRequests + bundleRequests,
    artifactRequests,
    bundleRequests,
    fallbackCount: stats?.fallbackCount ?? 0,
    fallbackReason: stats?.fallbackReason ?? null,
    bytesSentPayload: stats?.bytesSent ?? bytesSent,
    bundleSizes,
    peakActiveUploads: Math.max(peakActiveUploads, stats?.peakActiveUploads ?? 0),
  }
}

const perArtifact = await runScenario('per-artifact', { bundled: false })
const bundled = await runScenario('bundled', { bundled: true })
const fallback = unsupportedProviderIndex >= 0
  ? await runScenario('bundled-with-one-unsupported-provider', { bundled: true, unsupportedIndex: unsupportedProviderIndex })
  : null

const rows = fallback ? [perArtifact, bundled, fallback] : [perArtifact, bundled]
console.table(rows.map((row) => ({
  scenario: row.name,
  requests: row.requestCount,
  bundles: row.bundleRequests,
  artifactRequests: row.artifactRequests,
  wallMs: row.wallMs,
  bytesSentPayload: row.bytesSentPayload,
  fallbackCount: row.fallbackCount,
  peakActiveUploads: row.peakActiveUploads,
})))
console.log(JSON.stringify({
  shape: {
    file: '100MiB-equivalent sparse Mode 2 RS upload shape',
    rsProfile: `${k}+${m}`,
    providerCount,
    userMdus,
    witnessMdus,
    metadataMduReplicaUploads: providerCount * (1 + witnessMdus),
    userShardUploads: providerCount * userMdus,
    manifestUploads: providerCount,
    baselineArtifactRequests: providerCount * (1 + witnessMdus) + providerCount * userMdus + providerCount,
  },
  rows,
}, null, 2))
