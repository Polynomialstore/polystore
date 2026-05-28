import { createUploadEngine, type PipelinedUploadArtifact, type UploadTarget, type UploadTransportRequest } from '../src/lib/upload/engine'

const artifactCount = Math.max(1, Number(process.env.ARTIFACTS || 8))
const computeMs = Math.max(0, Number(process.env.COMPUTE_MS || 40))
const uploadMs = Math.max(0, Number(process.env.UPLOAD_MS || 30))
const concurrency = Math.max(1, Number(process.env.CONCURRENCY || 3))

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

const target: UploadTarget = {
  baseUrl: 'http://provider.test',
  mduPath: '/sp/upload_mdu',
  manifestPath: '/sp/upload_manifest',
  label: 'provider.test',
}

function makeArtifact(index: number): PipelinedUploadArtifact {
  return {
    target,
    artifact: {
      kind: 'mdu',
      index,
      bytes: new Uint8Array([index & 0xff]),
      fullSize: 8,
    },
  }
}

function makeTransport() {
  const starts: Array<{ kind: string; tMs: number; manifestRoot: string; generation: string }> = []
  return {
    starts,
    transport: {
      async sendArtifact(request: UploadTransportRequest) {
        starts.push({
          kind: request.artifact.kind,
          tMs: nowMs(),
          manifestRoot: request.manifestRoot,
          generation: request.uploadGeneration || '',
        })
        await sleep(uploadMs)
      },
    },
  }
}

async function runSequential(): Promise<number> {
  const prepared: PipelinedUploadArtifact[] = []
  const startedAt = nowMs()
  for (let i = 0; i < artifactCount; i += 1) {
    await sleep(computeMs)
    prepared.push(makeArtifact(i))
  }
  const transport = makeTransport()
  const engine = createUploadEngine({ transport: transport.transport, parallelism: { direct: concurrency } })
  await engine.uploadDirect({
    dealId: '1',
    manifestRoot: '0xnext',
    manifestBlob: new Uint8Array([0xff]),
    mdus: prepared.map((item) => {
      if (item.artifact.kind !== 'mdu') throw new Error('expected mdu artifact')
      return { index: item.artifact.index, data: item.artifact.bytes, fullSize: item.artifact.fullSize }
    }),
    target,
  })
  return nowMs() - startedAt
}

async function runPipelined(): Promise<{ elapsedMs: number; starts: ReturnType<typeof makeTransport>['starts'] }> {
  const transport = makeTransport()
  const engine = createUploadEngine({ transport: transport.transport, parallelism: { direct: concurrency } })
  let computed = 0

  async function* artifacts() {
    for (let i = 0; i < artifactCount; i += 1) {
      await sleep(computeMs)
      computed += 1
      yield makeArtifact(i)
    }
  }

  const startedAt = nowMs()
  const result = await engine.uploadPipelinedGeneration({
    dealId: '1',
    uploadGeneration: 'pipelined',
    artifacts: artifacts(),
    manifest: (async () => {
      while (computed < artifactCount) {
        await sleep(1)
      }
      return {
        manifestRoot: '0xnext',
        manifestBlob: new Uint8Array([0xff]),
        manifestTargets: [target],
      }
    })(),
  })
  if (!result.ok) throw new Error(result.error || 'pipelined upload failed')
  return { elapsedMs: nowMs() - startedAt, starts: transport.starts }
}

const sequentialMs = await runSequential()
const pipelined = await runPipelined()
const speedup = sequentialMs / pipelined.elapsedMs

console.log(JSON.stringify({
  scenario: {
    artifact_count: artifactCount,
    compute_ms_per_artifact: computeMs,
    upload_ms_per_artifact: uploadMs,
    upload_concurrency: concurrency,
  },
  sequential_ms: sequentialMs,
  pipelined_ms: pipelined.elapsedMs,
  speedup,
  decision: speedup > 1.05 ? 'improvement' : speedup < 0.95 ? 'regression' : 'same',
  pipelined_started_before_manifest_count: pipelined.starts.filter((start) => start.kind !== 'manifest' && start.manifestRoot === '').length,
}, null, 2))
