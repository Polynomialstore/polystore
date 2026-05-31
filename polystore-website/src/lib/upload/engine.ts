import type { SparseArtifactInput, SparseArtifactKind } from './sparseArtifacts'

export interface PreparedMdu {
  index: number
  data: Uint8Array
  fullSize?: number
}

export interface PreparedShard {
  data: Uint8Array
  fullSize?: number
}

export interface PreparedShardSet {
  index: number
  shards: PreparedShard[]
}

export interface UploadTarget {
  baseUrl: string
  mduPath: string
  manifestPath: string
  shardPath?: string
  bundlePath?: string
  label?: string
}

export interface UploadProgressStep {
  kind: SparseArtifactKind
  label: string
  target: string
  index?: number
  slot?: number
  totalSteps: number
  status: 'pending' | 'uploading' | 'complete' | 'error'
  error?: string
}

export interface UploadTaskEvent {
  phase: 'start' | 'end' | 'fallback'
  kind: SparseArtifactKind
  target: string
  index?: number
  slot?: number
  bytes: number
  fullSize?: number
  durationMs?: number
  ok?: boolean
  error?: string
  transportKind?: 'artifact' | 'bundle'
  bundleId?: string
  bundleArtifactCount?: number
  bundleBytes?: number
  fallbackArtifactCount?: number
  fallbackReason?: string
}

export interface UploadTransportStats {
  artifactCount: number
  perArtifactCount: number
  bundledArtifactCount: number
  bundleCount: number
  requestCount: number
  bytesSent: number
  fallbackCount: number
  fallbackReason?: string
  peakActiveUploads: number
}

export interface UploadTransportRequest {
  dealId: string
  manifestRoot: string
  previousManifestRoot?: string
  uploadGeneration?: string
  target: UploadTarget
  artifact: SparseArtifactInput
}

export interface UploadTransportPort {
  sendArtifact(request: UploadTransportRequest): Promise<void>
  sendBundle?(requests: UploadTransportRequest[]): Promise<void>
}

export interface ChainCommitRequest {
  dealId: string
  previousManifestRoot: string
  manifestRoot: string
  fileSize: number
  totalMdus: number
  witnessMdus: number
}

export interface ChainCommitPort {
  commitContent(request: ChainCommitRequest): Promise<void>
}

export interface UploadEnginePorts {
  transport: UploadTransportPort
  chainCommitter?: ChainCommitPort
}

export interface UploadEngineParallelism {
  direct?: number
  stripedMetadata?: number
  stripedShards?: number
}

export interface UploadEngineOptions extends UploadEnginePorts {
  parallelism?: UploadEngineParallelism
}

export interface UploadEngineResult {
  ok: boolean
  steps: UploadProgressStep[]
  error?: string
  transportStats?: UploadTransportStats
}

export interface DirectUploadInput {
  dealId: string
  manifestRoot: string
  previousManifestRoot?: string
  manifestBlob?: Uint8Array | null
  manifestBlobFullSize?: number
  mdus: PreparedMdu[]
  target: UploadTarget
  onProgress?: (steps: UploadProgressStep[]) => void
  onTaskEvent?: (event: UploadTaskEvent) => void
}

export interface StripedUploadInput {
  dealId: string
  manifestRoot: string
  previousManifestRoot?: string
  manifestBlob?: Uint8Array | null
  manifestBlobFullSize?: number
  metadataMdus: PreparedMdu[]
  shardSets?: PreparedShardSet[]
  metadataTargets: UploadTarget[]
  shardTargets?: UploadTarget[]
  onProgress?: (steps: UploadProgressStep[]) => void
  onTaskEvent?: (event: UploadTaskEvent) => void
}

export interface StripedSlotUploadInput {
  dealId: string
  manifestRoot: string
  previousManifestRoot?: string
  manifestBlob?: Uint8Array | null
  manifestBlobFullSize?: number
  metadataMdus: PreparedMdu[]
  shardSets?: PreparedShardSet[]
  slot: number
  target: UploadTarget
  onProgress?: (steps: UploadProgressStep[]) => void
  onTaskEvent?: (event: UploadTaskEvent) => void
}

export interface PipelinedUploadArtifact {
  target: UploadTarget
  artifact: SparseArtifactInput
}

export interface PipelinedManifestBinding {
  manifestRoot: string
  manifestBlob: Uint8Array
  manifestBlobFullSize?: number
  manifestTargets: UploadTarget[]
}

export interface PipelinedGenerationUploadInput {
  dealId: string
  previousManifestRoot?: string
  uploadGeneration: string
  artifacts: AsyncIterable<PipelinedUploadArtifact>
  manifest: Promise<PipelinedManifestBinding>
  onTaskEvent?: (event: UploadTaskEvent) => void
}

export interface PreparedCommitInput {
  dealId: string
  previousManifestRoot: string
  manifestRoot: string
  isMode2: boolean
  fileBytesTotal: number
  totalWitnessMdus: number
  totalUserMdus: number
  mdus: PreparedMdu[]
}

function cloneSteps(steps: UploadProgressStep[]): UploadProgressStep[] {
  return steps.map((step) => ({ ...step }))
}

function updateStep(
  steps: UploadProgressStep[],
  stepIndex: number,
  patch: Partial<UploadProgressStep>,
): UploadProgressStep[] {
  if (stepIndex < 0 || stepIndex >= steps.length) return steps
  const current = steps[stepIndex]
  if (!current) return steps
  const next = cloneSteps(steps)
  next[stepIndex] = { ...current, ...patch }
  return next
}

function buildDirectUploadSteps(input: DirectUploadInput): UploadProgressStep[] {
  const totalSteps = input.mdus.length + 1
  const targetLabel = input.target.label || input.target.baseUrl
  return [
    ...input.mdus.map((mdu) => ({
      kind: 'mdu' as const,
      label: `MDU #${mdu.index}`,
      index: mdu.index,
      target: targetLabel,
      totalSteps,
      status: 'pending' as const,
    })),
    {
      kind: 'manifest' as const,
      label: 'manifest.bin',
      target: targetLabel,
      totalSteps,
      status: 'pending' as const,
    },
  ]
}

function buildStripedUploadSteps(input: StripedUploadInput): UploadProgressStep[] {
  const shardSets = input.shardSets ?? []
  const totalSteps =
    input.metadataTargets.length * (input.metadataMdus.length + 1) +
    shardSets.reduce((count, shardSet) => count + shardSet.shards.length, 0)
  const steps: UploadProgressStep[] = []
  for (const target of input.metadataTargets) {
    const targetLabel = target.label || target.baseUrl
    for (const mdu of input.metadataMdus) {
      steps.push({
        kind: 'mdu',
        label: `MDU #${mdu.index}`,
        index: mdu.index,
        target: targetLabel,
        totalSteps,
        status: 'pending',
      })
    }
    steps.push({
      kind: 'manifest',
      label: 'manifest.bin',
      target: targetLabel,
      totalSteps,
      status: 'pending',
    })
  }
  for (const shardSet of shardSets) {
    for (let slot = 0; slot < shardSet.shards.length; slot += 1) {
      const target = input.shardTargets?.[slot]
      const targetLabel = target?.label || target?.baseUrl || `slot-${slot}`
      steps.push({
        kind: 'shard',
        label: `Shard mdu=${shardSet.index} slot=${slot}`,
        index: shardSet.index,
        slot,
        target: targetLabel,
        totalSteps,
        status: 'pending',
      })
    }
  }
  return steps
}

function buildStripedSlotUploadSteps(input: StripedSlotUploadInput): UploadProgressStep[] {
  const shardSets = input.shardSets ?? []
  const totalSteps = input.metadataMdus.length + 1 + shardSets.length
  const targetLabel = input.target.label || input.target.baseUrl
  const steps: UploadProgressStep[] = []
  for (const mdu of input.metadataMdus) {
    steps.push({
      kind: 'mdu',
      label: `MDU #${mdu.index}`,
      index: mdu.index,
      target: targetLabel,
      totalSteps,
      status: 'pending',
    })
  }
  steps.push({
    kind: 'manifest',
    label: 'manifest.bin',
    target: targetLabel,
    totalSteps,
    status: 'pending',
  })
  for (const shardSet of shardSets) {
    steps.push({
      kind: 'shard',
      label: `Shard mdu=${shardSet.index} slot=${input.slot}`,
      index: shardSet.index,
      slot: input.slot,
      target: targetLabel,
      totalSteps,
      status: 'pending',
    })
  }
  return steps
}

function emitProgress(steps: UploadProgressStep[], onProgress?: (steps: UploadProgressStep[]) => void): UploadProgressStep[] {
  if (!onProgress) {
    return steps
  }
  const snapshot = cloneSteps(steps)
  onProgress(snapshot)
  return snapshot
}

interface UploadTask {
  stepIndex: number
  request: UploadTransportRequest
}

interface UploadTaskBundle {
  target: string
  tasks: UploadTask[]
}

function stepKey(kind: SparseArtifactKind, target: string, index?: number, slot?: number): string {
  return `${kind}|${target}|${index ?? ''}|${slot ?? ''}`
}

function indexUploadSteps(steps: UploadProgressStep[]): Map<string, number> {
  const indexed = new Map<string, number>()
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]
    indexed.set(stepKey(step.kind, step.target, step.index, step.slot), i)
  }
  return indexed
}

const DEFAULT_DIRECT_UPLOAD_CONCURRENCY = 4
const DEFAULT_STRIPED_METADATA_UPLOAD_CONCURRENCY = 6
const DEFAULT_STRIPED_SHARD_UPLOAD_CONCURRENCY = 6

function createUploadTransportStats(): UploadTransportStats {
  return {
    artifactCount: 0,
    perArtifactCount: 0,
    bundledArtifactCount: 0,
    bundleCount: 0,
    requestCount: 0,
    bytesSent: 0,
    fallbackCount: 0,
    fallbackReason: undefined,
    peakActiveUploads: 0,
  }
}

function artifactPayloadBytes(task: UploadTask): number {
  return Math.max(0, task.request.artifact.bytes.byteLength)
}

function bundlePayloadBytes(bundle: UploadTaskBundle): number {
  return bundle.tasks.reduce((sum, task) => sum + artifactPayloadBytes(task), 0)
}

function mergeUploadTransportStats(...statsList: Array<UploadTransportStats | undefined>): UploadTransportStats | undefined {
  const filtered = statsList.filter((stats): stats is UploadTransportStats => Boolean(stats))
  if (filtered.length === 0) return undefined
  const merged = createUploadTransportStats()
  for (const stats of filtered) {
    merged.artifactCount += stats.artifactCount
    merged.perArtifactCount += stats.perArtifactCount
    merged.bundledArtifactCount += stats.bundledArtifactCount
    merged.bundleCount += stats.bundleCount
    merged.requestCount += stats.requestCount
    merged.bytesSent += stats.bytesSent
    merged.fallbackCount += stats.fallbackCount
    merged.peakActiveUploads = Math.max(merged.peakActiveUploads, stats.peakActiveUploads)
    if (!merged.fallbackReason && stats.fallbackReason) merged.fallbackReason = stats.fallbackReason
  }
  return merged
}

function normalizeConcurrency(value: number | undefined, fallback: number): number {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized <= 0) return fallback
  return Math.max(1, Math.floor(normalized))
}

async function runUploadTasks(
  tasks: UploadTask[],
  initialSteps: UploadProgressStep[],
  onProgress: ((steps: UploadProgressStep[]) => void) | undefined,
  onTaskEvent: ((event: UploadTaskEvent) => void) | undefined,
  concurrency: number,
  transport: UploadTransportPort,
  options?: { continueOnError?: boolean },
): Promise<UploadEngineResult> {
  const trackProgress = Boolean(onProgress) && initialSteps.length > 0
  const trackTaskEvents = Boolean(onTaskEvent)
  const continueOnError = Boolean(options?.continueOnError)
  let steps = initialSteps
  let nextIndex = 0
  let active = 0
  let firstError: string | null = null
  const stats = createUploadTransportStats()
  stats.artifactCount = tasks.length

  return await new Promise<UploadEngineResult>((resolve) => {
    const settleIfDone = () => {
      if (active !== 0) return
      if (nextIndex < tasks.length && (!firstError || continueOnError)) return
      if (firstError) {
        resolve({ ok: false, steps, error: firstError, transportStats: stats })
      } else {
        resolve({ ok: true, steps, transportStats: stats })
      }
    }

    const launchNext = () => {
      while ((continueOnError || !firstError) && active < concurrency && nextIndex < tasks.length) {
        const task = tasks[nextIndex]
        nextIndex += 1
        active += 1
        stats.perArtifactCount += 1
        stats.requestCount += 1
        stats.bytesSent += artifactPayloadBytes(task)
        stats.peakActiveUploads = Math.max(stats.peakActiveUploads, active)
        const startedAt = trackTaskEvents ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) : 0
        const target = trackTaskEvents ? task.request.target.label || task.request.target.baseUrl : ''
        const index = trackTaskEvents && 'index' in task.request.artifact ? task.request.artifact.index : undefined
        const slot = trackTaskEvents && 'slot' in task.request.artifact ? task.request.artifact.slot : undefined
        const bytes = trackTaskEvents ? task.request.artifact.bytes.byteLength : 0
        const fullSize = trackTaskEvents ? task.request.artifact.fullSize : undefined
        if (trackTaskEvents) {
          onTaskEvent?.({
            phase: 'start',
            kind: task.request.artifact.kind,
            target,
            index,
            slot,
            bytes,
            fullSize,
            transportKind: 'artifact',
          })
        }

        if (trackProgress) {
          steps = emitProgress(updateStep(steps, task.stepIndex, { status: 'uploading', error: undefined }), onProgress)
        }

        void transport
          .sendArtifact(task.request)
          .then(() => {
            if (trackTaskEvents) {
              const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
              onTaskEvent?.({
                phase: 'end',
                kind: task.request.artifact.kind,
                target,
                index,
                slot,
                bytes,
                fullSize,
                durationMs: finishedAt - startedAt,
                ok: true,
                transportKind: 'artifact',
              })
            }
            if (trackProgress) {
              steps = emitProgress(updateStep(steps, task.stepIndex, { status: 'complete' }), onProgress)
            }
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            if (!firstError) firstError = message
            if (trackTaskEvents) {
              const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
              onTaskEvent?.({
                phase: 'end',
                kind: task.request.artifact.kind,
                target,
                index,
                slot,
                bytes,
                fullSize,
                durationMs: finishedAt - startedAt,
                ok: false,
                error: message,
                transportKind: 'artifact',
              })
            }
            if (trackProgress) {
              steps = emitProgress(updateStep(steps, task.stepIndex, { status: 'error', error: message }), onProgress)
            }
          })
          .finally(() => {
            active -= 1
            launchNext()
            settleIfDone()
          })
      }

      settleIfDone()
    }

    launchNext()
  })
}

async function runPipelinedUploadTaskProducer(
  input: PipelinedGenerationUploadInput,
  concurrency: number,
  transport: UploadTransportPort,
): Promise<UploadEngineResult> {
  const trackTaskEvents = Boolean(input.onTaskEvent)
  let producerDone = false
  let firstError: string | null = null
  const stats = createUploadTransportStats()
  const queue: PipelinedUploadArtifact[] = []
  const waiters: Array<() => void> = []

  const wakeWorkers = () => {
    while (waiters.length > 0) {
      waiters.shift()?.()
    }
  }

  const waitForWork = async () => {
    if (queue.length > 0 || producerDone || firstError) return
    await new Promise<void>((resolve) => {
      waiters.push(resolve)
    })
  }

  const uploadOne = async (item: PipelinedUploadArtifact): Promise<void> => {
    const request: UploadTransportRequest = {
      dealId: input.dealId,
      manifestRoot: '',
      previousManifestRoot: input.previousManifestRoot,
      uploadGeneration: input.uploadGeneration,
      target: item.target,
      artifact: item.artifact,
    }
    stats.artifactCount += 1
    stats.perArtifactCount += 1
    stats.requestCount += 1
    stats.bytesSent += Math.max(0, request.artifact.bytes.byteLength)
    const startedAt = trackTaskEvents ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) : 0
    const target = trackTaskEvents ? request.target.label || request.target.baseUrl : ''
    const index = trackTaskEvents && 'index' in request.artifact ? request.artifact.index : undefined
    const slot = trackTaskEvents && 'slot' in request.artifact ? request.artifact.slot : undefined
    const bytes = trackTaskEvents ? request.artifact.bytes.byteLength : 0
    const fullSize = trackTaskEvents ? request.artifact.fullSize : undefined
    if (trackTaskEvents) {
      input.onTaskEvent?.({
        phase: 'start',
        kind: request.artifact.kind,
        target,
        index,
        slot,
        bytes,
        fullSize,
        transportKind: 'artifact',
      })
    }
    try {
      await transport.sendArtifact(request)
      if (trackTaskEvents) {
        const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
        input.onTaskEvent?.({
          phase: 'end',
          kind: request.artifact.kind,
          target,
          index,
          slot,
          bytes,
          fullSize,
          durationMs: finishedAt - startedAt,
          ok: true,
          transportKind: 'artifact',
        })
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      if (trackTaskEvents) {
        const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
        input.onTaskEvent?.({
          phase: 'end',
          kind: request.artifact.kind,
          target,
          index,
          slot,
          bytes,
          fullSize,
          durationMs: finishedAt - startedAt,
          ok: false,
          error: message,
          transportKind: 'artifact',
        })
      }
      throw new Error(message)
    }
  }

  const produce = async () => {
    try {
      for await (const item of input.artifacts) {
        if (firstError) break
        queue.push(item)
        wakeWorkers()
      }
    } catch (error: unknown) {
      if (!firstError) firstError = error instanceof Error ? error.message : String(error)
    } finally {
      producerDone = true
      wakeWorkers()
    }
  }

  const worker = async () => {
    for (;;) {
      await waitForWork()
      if (firstError || (producerDone && queue.length === 0)) return
      const item = queue.shift()
      if (!item) continue
      try {
        await uploadOne(item)
      } catch (error: unknown) {
        if (!firstError) firstError = error instanceof Error ? error.message : String(error)
        wakeWorkers()
        return
      }
    }
  }

  await Promise.all([produce(), ...Array.from({ length: Math.max(1, concurrency) }, () => worker())])
  return firstError ? { ok: false, steps: [], error: firstError, transportStats: stats } : { ok: true, steps: [], transportStats: stats }
}

function groupUploadTasksByTarget(tasks: UploadTask[]): UploadTaskBundle[] {
  const bundles = new Map<string, UploadTaskBundle>()
  const ordered: UploadTaskBundle[] = []
  for (const task of tasks) {
    const targetLabel = task.request.target.label || task.request.target.baseUrl
    let bundle = bundles.get(targetLabel)
    if (!bundle) {
      bundle = { target: targetLabel, tasks: [] }
      bundles.set(targetLabel, bundle)
      ordered.push(bundle)
    }
    bundle.tasks.push(task)
  }
  return ordered
}

function isBundleUnsupportedError(error: unknown): boolean {
  return error instanceof Error && error.name === 'BundleUnsupportedUploadError'
}

async function runUploadTaskBundles(
  bundles: UploadTaskBundle[],
  initialSteps: UploadProgressStep[],
  onProgress: ((steps: UploadProgressStep[]) => void) | undefined,
  onTaskEvent: ((event: UploadTaskEvent) => void) | undefined,
  concurrency: number,
  transport: UploadTransportPort & Required<Pick<UploadTransportPort, 'sendBundle'>>,
  options?: { continueOnError?: boolean },
): Promise<UploadEngineResult> {
  const trackProgress = Boolean(onProgress) && initialSteps.length > 0
  const trackTaskEvents = Boolean(onTaskEvent)
  const continueOnError = Boolean(options?.continueOnError)
  let steps = initialSteps
  let nextIndex = 0
  let active = 0
  let firstError: string | null = null
  const stats = createUploadTransportStats()
  stats.artifactCount = bundles.reduce((sum, bundle) => sum + bundle.tasks.length, 0)

  return await new Promise<UploadEngineResult>((resolve) => {
    const settleIfDone = () => {
      if (active !== 0) return
      if (nextIndex < bundles.length && (!firstError || continueOnError)) return
      if (firstError) {
        resolve({ ok: false, steps, error: firstError, transportStats: stats })
      } else {
        resolve({ ok: true, steps, transportStats: stats })
      }
    }

    const launchNext = () => {
      while ((continueOnError || !firstError) && active < concurrency && nextIndex < bundles.length) {
        const bundle = bundles[nextIndex]
        const bundleIndex = nextIndex
        nextIndex += 1
        active += 1
        stats.peakActiveUploads = Math.max(stats.peakActiveUploads, active)
        const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
        const bundleId = `${bundle.target}#${bundleIndex}`
        const bundleBytes = bundlePayloadBytes(bundle)
        const events = trackTaskEvents
          ? bundle.tasks.map((task) => ({
              request: task.request,
              target: task.request.target.label || task.request.target.baseUrl,
              index: 'index' in task.request.artifact ? task.request.artifact.index : undefined,
              slot: 'slot' in task.request.artifact ? task.request.artifact.slot : undefined,
              bytes: task.request.artifact.bytes.byteLength,
              fullSize: task.request.artifact.fullSize,
            }))
          : []

        stats.bundleCount += 1
        stats.bundledArtifactCount += bundle.tasks.length
        stats.requestCount += 1
        stats.bytesSent += bundleBytes

        if (trackTaskEvents) {
          for (const event of events) {
            onTaskEvent?.({
              phase: 'start',
              kind: event.request.artifact.kind,
              target: event.target,
              index: event.index,
              slot: event.slot,
              bytes: event.bytes,
              fullSize: event.fullSize,
              transportKind: 'bundle',
              bundleId,
              bundleArtifactCount: bundle.tasks.length,
              bundleBytes,
            })
          }
        }

        if (trackProgress) {
          for (const task of bundle.tasks) {
            steps = updateStep(steps, task.stepIndex, { status: 'uploading', error: undefined })
          }
          steps = emitProgress(steps, onProgress)
        }

        const completeBundle = (ok: boolean, message?: string) => {
          const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
          if (trackTaskEvents) {
            for (const event of events) {
              onTaskEvent?.({
                phase: 'end',
                kind: event.request.artifact.kind,
                target: event.target,
                index: event.index,
                slot: event.slot,
                bytes: event.bytes,
                fullSize: event.fullSize,
                durationMs: finishedAt - startedAt,
                ok,
                error: message,
                transportKind: 'bundle',
                bundleId,
                bundleArtifactCount: bundle.tasks.length,
                bundleBytes,
              })
            }
          }
          if (trackProgress) {
            for (const task of bundle.tasks) {
              steps = updateStep(steps, task.stepIndex, ok ? { status: 'complete' } : { status: 'error', error: message })
            }
            steps = emitProgress(steps, onProgress)
          }
        }

        const fallbackToArtifacts = async (reason: string): Promise<void> => {
          stats.fallbackCount += 1
          if (!stats.fallbackReason) stats.fallbackReason = reason
          if (trackTaskEvents && events.length > 0) {
            const first = events[0]
            onTaskEvent?.({
              phase: 'fallback',
              kind: first.request.artifact.kind,
              target: first.target,
              bytes: bundleBytes,
              fullSize: bundleBytes,
              transportKind: 'artifact',
              bundleId,
              bundleArtifactCount: bundle.tasks.length,
              bundleBytes,
              fallbackArtifactCount: bundle.tasks.length,
              fallbackReason: reason,
            })
          }

          for (let i = 0; i < bundle.tasks.length; i += 1) {
            const task = bundle.tasks[i]
            const event = events[i]
            stats.perArtifactCount += 1
            stats.requestCount += 1
            stats.bytesSent += artifactPayloadBytes(task)
            try {
              await transport.sendArtifact(task.request)
              if (trackTaskEvents && event) {
                const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
                onTaskEvent?.({
                  phase: 'end',
                  kind: event.request.artifact.kind,
                  target: event.target,
                  index: event.index,
                  slot: event.slot,
                  bytes: event.bytes,
                  fullSize: event.fullSize,
                  durationMs: finishedAt - startedAt,
                  ok: true,
                  transportKind: 'artifact',
                  bundleId,
                  bundleArtifactCount: bundle.tasks.length,
                  bundleBytes,
                  fallbackReason: reason,
                })
              }
              if (trackProgress) {
                steps = emitProgress(updateStep(steps, task.stepIndex, { status: 'complete' }), onProgress)
              }
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error)
              if (!firstError) firstError = message
              if (trackTaskEvents && event) {
                const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
                onTaskEvent?.({
                  phase: 'end',
                  kind: event.request.artifact.kind,
                  target: event.target,
                  index: event.index,
                  slot: event.slot,
                  bytes: event.bytes,
                  fullSize: event.fullSize,
                  durationMs: finishedAt - startedAt,
                  ok: false,
                  error: message,
                  transportKind: 'artifact',
                  bundleId,
                  bundleArtifactCount: bundle.tasks.length,
                  bundleBytes,
                  fallbackReason: reason,
                })
              }
              if (trackProgress) {
                steps = emitProgress(updateStep(steps, task.stepIndex, { status: 'error', error: message }), onProgress)
              }
              if (!continueOnError) return
            }
          }
        }

        void (async () => {
          try {
            await transport.sendBundle(bundle.tasks.map((task) => task.request))
            completeBundle(true)
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error)
            if (isBundleUnsupportedError(error)) {
              await fallbackToArtifacts(message || 'bundle upload unsupported')
              return
            }
            if (!firstError) firstError = message
            completeBundle(false, message)
          } finally {
            active -= 1
            launchNext()
            settleIfDone()
          }
        })()
      }

      settleIfDone()
    }

    launchNext()
  })
}

export function buildCommitRequest(input: PreparedCommitInput): ChainCommitRequest {
  const witnessMdus = Math.max(0, Number(input.totalWitnessMdus) || 0)
  const totalMdus = input.isMode2
    ? Math.max(0, 1 + witnessMdus + Math.max(0, Number(input.totalUserMdus) || 0))
    : Math.max(0, input.mdus.length)

  if (!Number.isFinite(totalMdus) || totalMdus <= 0) {
    throw new Error('Commit requires totalMdus > 0')
  }
  if (!Number.isFinite(witnessMdus) || witnessMdus < 0) {
    throw new Error('Commit requires witnessMdus >= 0')
  }
  if (totalMdus <= 1 + witnessMdus) {
    throw new Error('Commit requires totalMdus > 1 + witnessMdus')
  }

  return {
    dealId: input.dealId,
    previousManifestRoot: input.previousManifestRoot,
    manifestRoot: input.manifestRoot,
    fileSize: input.fileBytesTotal,
    totalMdus,
    witnessMdus,
  }
}

export function createUploadEngine(options: UploadEngineOptions) {
  const { parallelism, ...ports } = options
  const directConcurrency = normalizeConcurrency(parallelism?.direct, DEFAULT_DIRECT_UPLOAD_CONCURRENCY)
  const stripedMetadataConcurrency = normalizeConcurrency(
    parallelism?.stripedMetadata,
    DEFAULT_STRIPED_METADATA_UPLOAD_CONCURRENCY,
  )
  const stripedShardConcurrency = normalizeConcurrency(parallelism?.stripedShards, DEFAULT_STRIPED_SHARD_UPLOAD_CONCURRENCY)

  return {
    async uploadDirect(input: DirectUploadInput): Promise<UploadEngineResult> {
      const trackSteps = Boolean(input.onProgress)
      let steps = trackSteps ? emitProgress(buildDirectUploadSteps(input), input.onProgress) : []
      const stepIndices = trackSteps ? indexUploadSteps(steps) : new Map<string, number>()
      const resolveStepIndex = trackSteps
        ? (kind: SparseArtifactKind, target: string, index?: number, slot?: number) =>
            stepIndices.get(stepKey(kind, target, index, slot)) ?? -1
        : () => -1
      if (!input.manifestBlob || input.manifestBlob.byteLength === 0) {
        const message = 'manifest blob missing (re-shard to regenerate)'
        const targetLabel = input.target.label || input.target.baseUrl
        if (trackSteps) {
          const manifestIndex = resolveStepIndex('manifest', targetLabel)
          steps = emitProgress(updateStep(steps, manifestIndex ?? -1, { status: 'error', error: message }), input.onProgress)
        }
        return { ok: false, steps, error: message }
      }

      const targetLabel = input.target.label || input.target.baseUrl

      const tasks: UploadTask[] = new Array(input.mdus.length + 1)
      for (let i = 0; i < input.mdus.length; i += 1) {
        const mdu = input.mdus[i]
        tasks[i] = {
          stepIndex: resolveStepIndex('mdu', targetLabel, mdu.index),
          request: {
            dealId: input.dealId,
            manifestRoot: input.manifestRoot,
            previousManifestRoot: input.previousManifestRoot,
            target: input.target,
            artifact: { kind: 'mdu', index: mdu.index, bytes: mdu.data, fullSize: mdu.fullSize } as const,
          },
        }
      }
      tasks[input.mdus.length] = {
        stepIndex: resolveStepIndex('manifest', targetLabel),
        request: {
          dealId: input.dealId,
          manifestRoot: input.manifestRoot,
            previousManifestRoot: input.previousManifestRoot,
            target: input.target,
            artifact: { kind: 'manifest', bytes: input.manifestBlob, fullSize: input.manifestBlobFullSize } as const,
        },
      }

      if (ports.transport.sendBundle) {
        const bundleResult = await runUploadTaskBundles(
          groupUploadTasksByTarget(tasks),
          steps,
          input.onProgress,
          input.onTaskEvent,
          1,
          ports.transport as UploadTransportPort & Required<Pick<UploadTransportPort, 'sendBundle'>>,
        )
        return bundleResult
      }

      return runUploadTasks(tasks, steps, input.onProgress, input.onTaskEvent, directConcurrency, ports.transport)
    },

    async uploadStriped(input: StripedUploadInput): Promise<UploadEngineResult> {
      const trackSteps = Boolean(input.onProgress)
      let steps = trackSteps ? emitProgress(buildStripedUploadSteps(input), input.onProgress) : []
      const stepIndices = trackSteps ? indexUploadSteps(steps) : new Map<string, number>()
      const resolveStepIndex = trackSteps
        ? (kind: SparseArtifactKind, target: string, index?: number, slot?: number) =>
            stepIndices.get(stepKey(kind, target, index, slot)) ?? -1
        : () => -1
      if (!input.manifestBlob || input.manifestBlob.byteLength === 0) {
        const message = 'manifest blob missing (re-shard to regenerate)'
        if (trackSteps) {
          for (const target of input.metadataTargets) {
            const targetLabel = target.label || target.baseUrl
            const manifestIndex = resolveStepIndex('manifest', targetLabel)
            steps = updateStep(steps, manifestIndex ?? -1, { status: 'error', error: message })
          }
          steps = emitProgress(steps, input.onProgress)
        }
        return { ok: false, steps, error: message }
      }
      const manifestBlob = input.manifestBlob

      const shardSets = input.shardSets ?? []
      const combinedTasks: UploadTask[] = []
      const metadataRounds = input.metadataMdus.length + 1
      const rounds = Math.max(metadataRounds, shardSets.length)
      for (let i = 0; i < rounds; i += 1) {
        if (i < input.metadataMdus.length) {
          const mdu = input.metadataMdus[i]
          for (const target of input.metadataTargets) {
            const targetLabel = target.label || target.baseUrl
            combinedTasks.push({
              stepIndex: resolveStepIndex('mdu', targetLabel, mdu.index),
              request: {
                dealId: input.dealId,
                manifestRoot: input.manifestRoot,
                previousManifestRoot: input.previousManifestRoot,
                target,
                artifact: { kind: 'mdu', index: mdu.index, bytes: mdu.data, fullSize: mdu.fullSize } as const,
              },
            })
          }
        } else if (i === input.metadataMdus.length) {
          for (const target of input.metadataTargets) {
            const targetLabel = target.label || target.baseUrl
            combinedTasks.push({
              stepIndex: resolveStepIndex('manifest', targetLabel),
              request: {
                dealId: input.dealId,
                manifestRoot: input.manifestRoot,
                previousManifestRoot: input.previousManifestRoot,
                target,
                artifact: { kind: 'manifest', bytes: manifestBlob, fullSize: input.manifestBlobFullSize } as const,
              },
            })
          }
        }

        if (i < shardSets.length) {
          const shardSet = shardSets[i]
          for (let slot = 0; slot < shardSet.shards.length; slot += 1) {
            const shard = shardSet.shards[slot]
            const target = input.shardTargets?.[slot]
            if (!target) {
              const message = `missing upload target for slot ${slot}`
              if (trackSteps) {
                steps = emitProgress(
                  updateStep(
                    steps,
                    resolveStepIndex('shard', `slot-${slot}`, shardSet.index, slot),
                    { status: 'error', error: message },
                  ),
                  input.onProgress,
                )
              }
              return { ok: false, steps, error: message }
            }
            const targetLabel = target.label || target.baseUrl
            combinedTasks.push({
              stepIndex: resolveStepIndex('shard', targetLabel, shardSet.index, slot),
              request: {
                dealId: input.dealId,
                manifestRoot: input.manifestRoot,
                previousManifestRoot: input.previousManifestRoot,
                target,
                artifact: { kind: 'shard', index: shardSet.index, slot, bytes: shard.data, fullSize: shard.fullSize } as const,
              },
            })
          }
        }
      }
      const combinedConcurrency =
        shardSets.length > 0
          ? Math.min(combinedTasks.length, stripedMetadataConcurrency + stripedShardConcurrency)
          : Math.min(combinedTasks.length, stripedMetadataConcurrency)

      if (ports.transport.sendBundle) {
        const groupedBundles = groupUploadTasksByTarget(combinedTasks)
        const bundleResult = await runUploadTaskBundles(
          groupedBundles,
          steps,
          input.onProgress,
          input.onTaskEvent,
          Math.max(1, Math.min(groupedBundles.length, combinedConcurrency)),
          ports.transport as UploadTransportPort & Required<Pick<UploadTransportPort, 'sendBundle'>>,
          { continueOnError: true },
        )
        return bundleResult
      }

      return runUploadTasks(
        combinedTasks,
        steps,
        input.onProgress,
        input.onTaskEvent,
        combinedConcurrency,
        ports.transport,
        { continueOnError: true },
      )
    },

    async uploadStripedSlot(input: StripedSlotUploadInput): Promise<UploadEngineResult> {
      const trackSteps = Boolean(input.onProgress)
      let steps = trackSteps ? emitProgress(buildStripedSlotUploadSteps(input), input.onProgress) : []
      const stepIndices = trackSteps ? indexUploadSteps(steps) : new Map<string, number>()
      const resolveStepIndex = trackSteps
        ? (kind: SparseArtifactKind, target: string, index?: number, slot?: number) =>
            stepIndices.get(stepKey(kind, target, index, slot)) ?? -1
        : () => -1
      if (!input.manifestBlob || input.manifestBlob.byteLength === 0) {
        const message = 'manifest blob missing (re-shard to regenerate)'
        const targetLabel = input.target.label || input.target.baseUrl
        if (trackSteps) {
          const manifestIndex = resolveStepIndex('manifest', targetLabel)
          steps = emitProgress(updateStep(steps, manifestIndex ?? -1, { status: 'error', error: message }), input.onProgress)
        }
        return { ok: false, steps, error: message }
      }

      const targetLabel = input.target.label || input.target.baseUrl
      const tasks: UploadTask[] = []
      for (const mdu of input.metadataMdus) {
        tasks.push({
          stepIndex: resolveStepIndex('mdu', targetLabel, mdu.index),
          request: {
            dealId: input.dealId,
            manifestRoot: input.manifestRoot,
            previousManifestRoot: input.previousManifestRoot,
            target: input.target,
            artifact: { kind: 'mdu', index: mdu.index, bytes: mdu.data, fullSize: mdu.fullSize } as const,
          },
        })
      }
      tasks.push({
        stepIndex: resolveStepIndex('manifest', targetLabel),
        request: {
          dealId: input.dealId,
          manifestRoot: input.manifestRoot,
          previousManifestRoot: input.previousManifestRoot,
          target: input.target,
          artifact: { kind: 'manifest', bytes: input.manifestBlob, fullSize: input.manifestBlobFullSize } as const,
        },
      })
      for (const shardSet of input.shardSets ?? []) {
        const shard = shardSet.shards[input.slot]
        if (!shard) {
          const message = `missing shard for slot ${input.slot}`
          if (trackSteps) {
            steps = emitProgress(
              updateStep(steps, resolveStepIndex('shard', targetLabel, shardSet.index, input.slot), { status: 'error', error: message }),
              input.onProgress,
            )
          }
          return { ok: false, steps, error: message }
        }
        tasks.push({
          stepIndex: resolveStepIndex('shard', targetLabel, shardSet.index, input.slot),
          request: {
            dealId: input.dealId,
            manifestRoot: input.manifestRoot,
            previousManifestRoot: input.previousManifestRoot,
            target: input.target,
            artifact: { kind: 'shard', index: shardSet.index, slot: input.slot, bytes: shard.data, fullSize: shard.fullSize } as const,
          },
        })
      }

      if (ports.transport.sendBundle) {
        const bundleResult = await runUploadTaskBundles(
          groupUploadTasksByTarget(tasks),
          steps,
          input.onProgress,
          input.onTaskEvent,
          1,
          ports.transport as UploadTransportPort & Required<Pick<UploadTransportPort, 'sendBundle'>>,
        )
        return bundleResult
      }

      const slotConcurrency = Math.max(1, Math.min(tasks.length, stripedMetadataConcurrency + stripedShardConcurrency))
      return runUploadTasks(tasks, steps, input.onProgress, input.onTaskEvent, slotConcurrency, ports.transport)
    },

    async uploadPipelinedGeneration(input: PipelinedGenerationUploadInput): Promise<UploadEngineResult> {
      const artifactResult = await runPipelinedUploadTaskProducer(input, directConcurrency, ports.transport)
      if (!artifactResult.ok) {
        return artifactResult
      }
      const manifest = await input.manifest
      const manifestTasks: UploadTask[] = manifest.manifestTargets.map((target) => ({
        stepIndex: -1,
        request: {
          dealId: input.dealId,
          manifestRoot: manifest.manifestRoot,
          previousManifestRoot: input.previousManifestRoot,
          uploadGeneration: input.uploadGeneration,
          target,
          artifact: { kind: 'manifest', bytes: manifest.manifestBlob, fullSize: manifest.manifestBlobFullSize } as const,
        },
      }))
      const manifestResult = await runUploadTasks(manifestTasks, [], undefined, input.onTaskEvent, directConcurrency, ports.transport)
      return {
        ...manifestResult,
        transportStats: mergeUploadTransportStats(artifactResult.transportStats, manifestResult.transportStats),
      }
    },

    async commitPreparedContent(input: PreparedCommitInput): Promise<ChainCommitRequest> {
      const request = buildCommitRequest(input)
      if (!ports.chainCommitter) return request
      await ports.chainCommitter.commitContent(request)
      return request
    },
  }
}
