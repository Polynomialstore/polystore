import { performance } from 'node:perf_hooks'

import {
  createUploadEngine,
  type PipelinedUploadArtifact,
  type UploadTarget,
  type UploadTaskEvent,
  type UploadTransportRequest,
} from '../src/lib/upload/engine'

const artifactCount = Math.max(1, Number(process.env.ARTIFACTS || 24))
const computeMs = Math.max(0, Number(process.env.COMPUTE_MS || 35))
const uploadMs = Math.max(0, Number(process.env.UPLOAD_MS || 45))
const concurrency = Math.max(1, Number(process.env.CONCURRENCY || 4))
const providers = Math.max(1, Number(process.env.PROVIDERS || 1))

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowMs(): number {
  return performance.now()
}

function target(index: number): UploadTarget {
  return {
    baseUrl: `http://provider-${index}.test`,
    mduPath: '/sp/upload_mdu',
    manifestPath: '/sp/upload_manifest',
    shardPath: '/sp/upload_shard',
    label: `provider-${index}`,
  }
}

const targets = Array.from({ length: providers }, (_, index) => target(index))

function makeArtifact(index: number): PipelinedUploadArtifact {
  const slot = index % providers
  return {
    target: targets[slot],
    artifact: {
      kind: 'shard',
      index: 1 + index,
      slot,
      bytes: new Uint8Array([index & 0xff]),
      fullSize: 1024 * 1024,
    },
  }
}

function requestBytes(request: UploadTransportRequest): number {
  return Math.max(0, request.artifact.bytes.byteLength)
}

function makeTransport() {
  const starts: Array<{ kind: string; tMs: number; manifestRoot: string; generation: string }> = []
  let active = 0
  let peakActiveUploads = 0
  let requestCount = 0
  let bytesSent = 0
  return {
    metrics: {
      starts,
      get peakActiveUploads() {
        return peakActiveUploads
      },
      get requestCount() {
        return requestCount
      },
      get bytesSent() {
        return bytesSent
      },
    },
    transport: {
      async sendArtifact(request: UploadTransportRequest) {
        starts.push({
          kind: request.artifact.kind,
          tMs: nowMs(),
          manifestRoot: request.manifestRoot,
          generation: request.uploadGeneration || '',
        })
        requestCount += 1
        bytesSent += requestBytes(request)
        active += 1
        peakActiveUploads = Math.max(peakActiveUploads, active)
        await sleep(uploadMs)
        active -= 1
      },
    },
  }
}

async function prepareArtifacts(): Promise<{ artifacts: PipelinedUploadArtifact[]; prepareWallMs: number }> {
  const prepared: PipelinedUploadArtifact[] = []
  const startedAt = nowMs()
  for (let i = 0; i < artifactCount; i += 1) {
    await sleep(computeMs)
    prepared.push(makeArtifact(i))
  }
  return { artifacts: prepared, prepareWallMs: nowMs() - startedAt }
}

async function runSequential() {
  const startedAt = nowMs()
  const prepared = await prepareArtifacts()
  const transport = makeTransport()
  const engine = createUploadEngine({ transport: transport.transport, parallelism: { direct: concurrency } })
  const uploadStartedAt = nowMs()
  async function* artifacts() {
    for (const artifact of prepared.artifacts) {
      yield artifact
    }
  }
  const result = await engine.uploadPipelinedGeneration({
    dealId: '197',
    previousManifestRoot: '0xprev',
    uploadGeneration: 'benchmark-sequential',
    artifacts: artifacts(),
    manifest: Promise.resolve({
      manifestRoot: '0xnext',
      manifestBlob: new Uint8Array([0xff]),
      manifestTargets: targets,
    }),
  })
  if (!result.ok) throw new Error(result.error || 'sequential upload failed')
  const finishedAt = nowMs()
  const stats = result.transportStats
  return {
    scenario: 'sequential_prepare_then_upload',
    prepareWallMs: prepared.prepareWallMs,
    uploadWallMs: finishedAt - uploadStartedAt,
    overlapWallMs: 0,
    endToEndWallMs: finishedAt - startedAt,
    artifactCount: stats?.artifactCount ?? artifactCount + 1,
    peakActiveUploads: Math.max(transport.metrics.peakActiveUploads, stats?.peakActiveUploads ?? 0),
    requestCount: stats?.requestCount ?? transport.metrics.requestCount,
    bundleCount: stats?.bundleCount ?? 0,
    fallbackCount: stats?.fallbackCount ?? 0,
    bytesSent: stats?.bytesSent ?? transport.metrics.bytesSent,
  }
}

async function runPipelined() {
  const transport = makeTransport()
  const engine = createUploadEngine({ transport: transport.transport, parallelism: { direct: concurrency } })
  const taskEvents: UploadTaskEvent[] = []
  let computed = 0
  let prepareDoneAt = 0
  let resolveManifest!: (value: { manifestRoot: string; manifestBlob: Uint8Array; manifestTargets: UploadTarget[] }) => void
  const manifest = new Promise<{ manifestRoot: string; manifestBlob: Uint8Array; manifestTargets: UploadTarget[] }>((resolve) => {
    resolveManifest = resolve
  })

  async function* artifacts() {
    for (let i = 0; i < artifactCount; i += 1) {
      await sleep(computeMs)
      computed += 1
      yield makeArtifact(i)
    }
    prepareDoneAt = nowMs()
    resolveManifest({
      manifestRoot: '0xnext',
      manifestBlob: new Uint8Array([0xff]),
      manifestTargets: targets,
    })
  }

  const startedAt = nowMs()
  const result = await engine.uploadPipelinedGeneration({
    dealId: '197',
    previousManifestRoot: '0xprev',
    uploadGeneration: 'benchmark-pipelined',
    artifacts: artifacts(),
    manifest,
    onTaskEvent(event) {
      taskEvents.push(event)
    },
  })
  if (!result.ok) throw new Error(result.error || 'pipelined upload failed')
  const finishedAt = nowMs()
  const stats = result.transportStats
  const prepareWallMs = prepareDoneAt - startedAt
  const firstTransportStart = transport.metrics.starts[0]?.tMs ?? startedAt
  const uploadWallMs = finishedAt - firstTransportStart
  const overlapWallMs = Math.max(0, Math.min(prepareDoneAt, finishedAt) - firstTransportStart)
  return {
    scenario: 'pipelined_prepare_and_upload',
    prepareWallMs,
    uploadWallMs,
    overlapWallMs,
    endToEndWallMs: finishedAt - startedAt,
    artifactCount: stats?.artifactCount ?? artifactCount + providers,
    queuedArtifactCount: stats?.queuedArtifactCount ?? artifactCount,
    stagedArtifactCount: stats?.stagedArtifactCount ?? artifactCount,
    activatedArtifactCount: stats?.activatedArtifactCount ?? providers,
    peakActiveUploads: Math.max(transport.metrics.peakActiveUploads, stats?.peakActiveUploads ?? 0),
    requestCount: stats?.requestCount ?? transport.metrics.requestCount,
    bundleCount: stats?.bundleCount ?? 0,
    fallbackCount: stats?.fallbackCount ?? 0,
    bytesSent: stats?.bytesSent ?? transport.metrics.bytesSent,
    preparedArtifacts: computed,
    stagedBeforeManifest: transport.metrics.starts.filter((start) => start.kind !== 'manifest' && start.manifestRoot === '').length,
  }
}

const sequential = await runSequential()
const pipelined = await runPipelined()
const speedup = sequential.endToEndWallMs / pipelined.endToEndWallMs

const rows = [sequential, pipelined].map((row) => ({
  ...row,
  prepareWallMs: Math.round(row.prepareWallMs * 10) / 10,
  uploadWallMs: Math.round(row.uploadWallMs * 10) / 10,
  overlapWallMs: Math.round(row.overlapWallMs * 10) / 10,
  endToEndWallMs: Math.round(row.endToEndWallMs * 10) / 10,
}))

console.table(rows.map((row) => ({
  scenario: row.scenario,
  prepareMs: row.prepareWallMs,
  uploadMs: row.uploadWallMs,
  overlapMs: row.overlapWallMs,
  e2eMs: row.endToEndWallMs,
  artifacts: row.artifactCount,
  requests: row.requestCount,
  bundles: row.bundleCount,
  fallbacks: row.fallbackCount,
  peakActive: row.peakActiveUploads,
})))
console.log(JSON.stringify({
  scenario: {
    artifact_count: artifactCount,
    provider_count: providers,
    compute_ms_per_artifact: computeMs,
    upload_ms_per_request: uploadMs,
    upload_concurrency: concurrency,
    note: 'Mocked latency benchmark; measures end-to-end overlap, not KZG speedup.',
  },
  speedup,
  rows,
}, null, 2))
