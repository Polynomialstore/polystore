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
  phase: 'start' | 'end'
  kind: SparseArtifactKind
  target: string
  index?: number
  slot?: number
  bytes: number
  fullSize?: number
  durationMs?: number
  ok?: boolean
  error?: string
}

export interface UploadTransportRequest {
  dealId: string
  manifestRoot: string
  previousManifestRoot?: string
  target: UploadTarget
  artifact: SparseArtifactInput
}

export interface UploadTransportPort {
  sendArtifact(request: UploadTransportRequest): Promise<void>
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
  steps[stepIndex] = { ...current, ...patch }
  return steps
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

function flattenTaskGroups(groups: UploadTask[][]): UploadTask[] {
  return groups.flatMap((group) => group)
}

function interleaveTaskGroups(primary: UploadTask[][], secondary: UploadTask[][]): UploadTask[] {
  const combined: UploadTask[] = []
  const rounds = Math.max(primary.length, secondary.length)
  for (let i = 0; i < rounds; i += 1) {
    if (i < primary.length) combined.push(...primary[i])
    if (i < secondary.length) combined.push(...secondary[i])
  }
  return combined
}

const DEFAULT_DIRECT_UPLOAD_CONCURRENCY = 4
const DEFAULT_STRIPED_METADATA_UPLOAD_CONCURRENCY = 6
const DEFAULT_STRIPED_SHARD_UPLOAD_CONCURRENCY = 6

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
): Promise<UploadEngineResult> {
  let steps = initialSteps
  let nextIndex = 0
  let active = 0
  let firstError: string | null = null

  return await new Promise<UploadEngineResult>((resolve) => {
    const settleIfDone = () => {
      if (active !== 0) return
      if (nextIndex < tasks.length && !firstError) return
      if (firstError) {
        resolve({ ok: false, steps, error: firstError })
      } else {
        resolve({ ok: true, steps })
      }
    }

    const launchNext = () => {
      while (!firstError && active < concurrency && nextIndex < tasks.length) {
        const task = tasks[nextIndex]
        nextIndex += 1
        active += 1
        const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
        const target = task.request.target.label || task.request.target.baseUrl
        onTaskEvent?.({
          phase: 'start',
          kind: task.request.artifact.kind,
          target,
          index: 'index' in task.request.artifact ? task.request.artifact.index : undefined,
          slot: 'slot' in task.request.artifact ? task.request.artifact.slot : undefined,
          bytes: task.request.artifact.bytes.byteLength,
          fullSize: task.request.artifact.fullSize,
        })

        steps = emitProgress(updateStep(steps, task.stepIndex, { status: 'uploading', error: undefined }), onProgress)

        void transport
          .sendArtifact(task.request)
          .then(() => {
            const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
            onTaskEvent?.({
              phase: 'end',
              kind: task.request.artifact.kind,
              target,
              index: 'index' in task.request.artifact ? task.request.artifact.index : undefined,
              slot: 'slot' in task.request.artifact ? task.request.artifact.slot : undefined,
              bytes: task.request.artifact.bytes.byteLength,
              fullSize: task.request.artifact.fullSize,
              durationMs: finishedAt - startedAt,
              ok: true,
            })
            steps = emitProgress(updateStep(steps, task.stepIndex, { status: 'complete' }), onProgress)
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            if (!firstError) firstError = message
            const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
            onTaskEvent?.({
              phase: 'end',
              kind: task.request.artifact.kind,
              target,
              index: 'index' in task.request.artifact ? task.request.artifact.index : undefined,
              slot: 'slot' in task.request.artifact ? task.request.artifact.slot : undefined,
              bytes: task.request.artifact.bytes.byteLength,
              fullSize: task.request.artifact.fullSize,
              durationMs: finishedAt - startedAt,
              ok: false,
              error: message,
            })
            steps = emitProgress(updateStep(steps, task.stepIndex, { status: 'error', error: message }), onProgress)
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
      if (!input.manifestBlob || input.manifestBlob.byteLength === 0) {
        const message = 'manifest blob missing (re-shard to regenerate)'
        const targetLabel = input.target.label || input.target.baseUrl
        if (trackSteps) {
          const manifestIndex = stepIndices.get(stepKey('manifest', targetLabel))
          steps = emitProgress(updateStep(steps, manifestIndex ?? -1, { status: 'error', error: message }), input.onProgress)
        }
        return { ok: false, steps, error: message }
      }

      const targetLabel = input.target.label || input.target.baseUrl

      const tasks: UploadTask[] = [
        ...input.mdus.map((mdu) => ({
          stepIndex: stepIndices.get(stepKey('mdu', targetLabel, mdu.index)) ?? -1,
          request: {
            dealId: input.dealId,
            manifestRoot: input.manifestRoot,
            previousManifestRoot: input.previousManifestRoot,
            target: input.target,
            artifact: { kind: 'mdu', index: mdu.index, bytes: mdu.data, fullSize: mdu.fullSize } as const,
          },
        })),
        {
          stepIndex: stepIndices.get(stepKey('manifest', targetLabel)) ?? -1,
          request: {
            dealId: input.dealId,
            manifestRoot: input.manifestRoot,
            previousManifestRoot: input.previousManifestRoot,
            target: input.target,
            artifact: { kind: 'manifest', bytes: input.manifestBlob, fullSize: input.manifestBlobFullSize } as const,
          },
        },
      ]

      return runUploadTasks(tasks, steps, input.onProgress, input.onTaskEvent, directConcurrency, ports.transport)
    },

    async uploadStriped(input: StripedUploadInput): Promise<UploadEngineResult> {
      const trackSteps = Boolean(input.onProgress)
      let steps = trackSteps ? emitProgress(buildStripedUploadSteps(input), input.onProgress) : []
      const stepIndices = trackSteps ? indexUploadSteps(steps) : new Map<string, number>()
      if (!input.manifestBlob || input.manifestBlob.byteLength === 0) {
        const message = 'manifest blob missing (re-shard to regenerate)'
        if (trackSteps) {
          for (const target of input.metadataTargets) {
            const targetLabel = target.label || target.baseUrl
            const manifestIndex = stepIndices.get(stepKey('manifest', targetLabel))
            steps = updateStep(steps, manifestIndex ?? -1, { status: 'error', error: message })
          }
          steps = emitProgress(steps, input.onProgress)
        }
        return { ok: false, steps, error: message }
      }
      const manifestBlob = input.manifestBlob

      const metadataTaskGroups: UploadTask[][] = []
      for (const mdu of input.metadataMdus) {
        const group: UploadTask[] = []
        for (const target of input.metadataTargets) {
          const targetLabel = target.label || target.baseUrl
          group.push({
            stepIndex: stepIndices.get(stepKey('mdu', targetLabel, mdu.index)) ?? -1,
            request: {
              dealId: input.dealId,
              manifestRoot: input.manifestRoot,
              previousManifestRoot: input.previousManifestRoot,
              target,
              artifact: { kind: 'mdu', index: mdu.index, bytes: mdu.data, fullSize: mdu.fullSize } as const,
            },
          })
        }
        metadataTaskGroups.push(group)
      }
      metadataTaskGroups.push(
        input.metadataTargets.map((target) => {
          const targetLabel = target.label || target.baseUrl
          return {
            stepIndex: stepIndices.get(stepKey('manifest', targetLabel)) ?? -1,
            request: {
              dealId: input.dealId,
              manifestRoot: input.manifestRoot,
              previousManifestRoot: input.previousManifestRoot,
              target,
              artifact: { kind: 'manifest', bytes: manifestBlob, fullSize: input.manifestBlobFullSize } as const,
            },
          } satisfies UploadTask
        }),
      )

      const shardTaskGroups: UploadTask[][] = []
      for (const shardSet of input.shardSets ?? []) {
        const group: UploadTask[] = []
        for (let slot = 0; slot < shardSet.shards.length; slot += 1) {
          const shard = shardSet.shards[slot]
          const target = input.shardTargets?.[slot]
          if (!target) {
            const message = `missing upload target for slot ${slot}`
            if (trackSteps) {
              steps = emitProgress(
                updateStep(
                  steps,
                  stepIndices.get(stepKey('shard', `slot-${slot}`, shardSet.index, slot)) ?? -1,
                  { status: 'error', error: message },
                ),
                input.onProgress,
              )
            }
            return { ok: false, steps, error: message }
          }
          const targetLabel = target.label || target.baseUrl
          group.push({
            stepIndex: stepIndices.get(stepKey('shard', targetLabel, shardSet.index, slot)) ?? -1,
            request: {
              dealId: input.dealId,
              manifestRoot: input.manifestRoot,
              previousManifestRoot: input.previousManifestRoot,
              target,
              artifact: { kind: 'shard', index: shardSet.index, slot, bytes: shard.data, fullSize: shard.fullSize } as const,
            },
          })
        }
        shardTaskGroups.push(group)
      }

      const metadataTasks = flattenTaskGroups(metadataTaskGroups)
      const shardTasks = flattenTaskGroups(shardTaskGroups)
      const combinedTasks = interleaveTaskGroups(metadataTaskGroups, shardTaskGroups)
      const combinedConcurrency =
        shardTasks.length > 0
          ? Math.min(combinedTasks.length, stripedMetadataConcurrency + stripedShardConcurrency)
          : Math.min(combinedTasks.length, stripedMetadataConcurrency)

      if (combinedTasks.length === metadataTasks.length + shardTasks.length) {
        return runUploadTasks(combinedTasks, steps, input.onProgress, input.onTaskEvent, combinedConcurrency, ports.transport)
      }

      return runUploadTasks(
        [...metadataTasks, ...shardTasks],
        steps,
        input.onProgress,
        input.onTaskEvent,
        combinedConcurrency,
        ports.transport,
      )
    },

    async commitPreparedContent(input: PreparedCommitInput): Promise<ChainCommitRequest> {
      const request = buildCommitRequest(input)
      if (!ports.chainCommitter) return request
      await ports.chainCommitter.commitContent(request)
      return request
    },
  }
}
