export type UploadPipelinePhase =
  | 'idle'
  | 'read_file'
  | 'gateway_ingest'
  | 'prepare'
  | 'append_bootstrap'
  | 'plan_upload'
  | 'browser_memory'
  | 'opfs_staging'
  | 'expand_user'
  | 'expand_witness'
  | 'mdu0_builder'
  | 'manifest'
  | 'upload_transport'
  | 'chain_handoff'
  | 'done'
  | 'error'

export type UploadPipelineStorageStage =
  | 'none'
  | 'browser_memory'
  | 'opfs'
  | 'upload_queue'
  | 'provider'
  | 'chain'

export type KzgBackendDisplay = 'pending' | 'webgpu-msm' | 'wasm-blst' | 'fallback' | 'unavailable' | 'unknown'

export type UploadStatusTone = 'idle' | 'active' | 'success' | 'warning' | 'error'

export type KzgBackendStatus = {
  display: KzgBackendDisplay
  label: string
  backend: string
  rustBackend: string
  webGpuAvailable: boolean | null
  fallbackReason: string | null
  probeStatus: string | null
  circuitOpen: boolean | null
  bucketWidth: number | null
  reductionMode: string | null
  calibrationStatus: string | null
  calibrationSource: string | null
  calibrationCacheKey: string | null
  schedulerQueueWaitMs: number | null
  schedulerTotalMs: number | null
  schedulerQueueDepth: number | null
  schedulerActive: number | null
  schedulerMaxQueueDepth: number | null
  schedulerFallbackCount: number | null
  probeTimeoutMs: number | null
  commitTimeoutMs: number | null
  minBlobs: number | null
  commitWorkerCount: number | null
}

export type UploadPipelineTiming = {
  startedAtMs: number | null
  updatedAtMs: number
  elapsedMs: number | null
  phases: Record<string, number>
}

export type UploadPipelineStatus = {
  version: 1
  runId: number | null
  dealId: string
  phase: UploadPipelinePhase
  phaseLabel: string
  tone: UploadStatusTone
  file: {
    name: string | null
    bytes: number | null
    logicalBytes: number | null
  }
  totals: {
    userMdus: number | null
    witnessMdus: number | null
    totalMdus: number | null
    bytesDone: number | null
    bytesTotal: number | null
    workDone: number | null
    workTotal: number | null
  }
  storage: {
    stage: UploadPipelineStorageStage
    browserMemoryBytes: number | null
    opfsBytes: number | null
    queuedArtifacts: number | null
    uploadedArtifacts: number | null
  }
  transport: {
    mode: 'gateway' | 'direct-provider' | 'striped-provider' | 'none' | 'unknown'
    target: string | null
    retries: number
    lastError: string | null
    artifactCount: number | null
    perArtifactCount: number | null
    bundledArtifactCount: number | null
    bundleCount: number | null
    requestCount: number | null
    bytesSent: number | null
    fallbackCount: number | null
    fallbackReason: string | null
    peakActiveUploads: number | null
  }
  kzg: KzgBackendStatus
  timing: UploadPipelineTiming
  latestEvent: string | null
  error: string | null
}

export type KzgDiagnosticsInput = {
  rustCommitBackend?: string
  workerRustCommitBackend?: string
  kzgCommitBackend?: string
  workerKzgCommitBackend?: string
  kzgWebGpuAvailable?: boolean
  workerKzgWebGpuAvailable?: boolean
  kzgWebGpuFallbackReason?: string
  workerKzgWebGpuFallbackReason?: string
  kzgWebGpuProbeStatus?: string
  workerKzgWebGpuProbeStatus?: string
  kzgWebGpuCircuitOpen?: boolean
  workerKzgWebGpuCircuitOpen?: boolean
  kzgWebGpuBucketWidth?: number
  workerKzgWebGpuBucketWidth?: number
  kzgWebGpuReductionMode?: string
  workerKzgWebGpuReductionMode?: string
  kzgWebGpuCalibrationStatus?: string
  workerKzgWebGpuCalibrationStatus?: string
  kzgWebGpuCalibrationSource?: string
  workerKzgWebGpuCalibrationSource?: string
  kzgWebGpuCalibrationCacheKey?: string
  workerKzgWebGpuCalibrationCacheKey?: string
  kzgSchedulerQueueWaitMs?: number
  workerKzgSchedulerQueueWaitMs?: number
  kzgSchedulerTotalMs?: number
  workerKzgSchedulerTotalMs?: number
  kzgSchedulerDepthAtEnqueue?: number
  workerKzgSchedulerDepthAtEnqueue?: number
  kzgSchedulerActiveAtEnqueue?: number
  workerKzgSchedulerActiveAtEnqueue?: number
  kzgSchedulerMaxQueueDepth?: number
  workerKzgSchedulerMaxQueueDepth?: number
  kzgSchedulerFallbackCount?: number
  workerKzgSchedulerFallbackCount?: number
  kzgWebGpuProbeTimeoutMs?: number
  workerKzgWebGpuProbeTimeoutMs?: number
  kzgWebGpuCommitTimeoutMs?: number
  workerKzgWebGpuCommitTimeoutMs?: number
  kzgWebGpuMinBlobs?: number
  workerKzgWebGpuMinBlobs?: number
  commitWorkerCount?: number
  workerCommitWorkerCount?: number
}

export type DeepPartialUploadPipelineStatus = Omit<
  Partial<UploadPipelineStatus>,
  'file' | 'totals' | 'storage' | 'transport' | 'kzg' | 'timing'
> & {
  file?: Partial<UploadPipelineStatus['file']>
  totals?: Partial<UploadPipelineStatus['totals']>
  storage?: Partial<UploadPipelineStatus['storage']>
  transport?: Partial<UploadPipelineStatus['transport']>
  kzg?: Partial<UploadPipelineStatus['kzg']>
  timing?: Partial<UploadPipelineStatus['timing']> & {
    phases?: Record<string, number>
  }
}

export const PENDING_KZG_BACKEND_STATUS: KzgBackendStatus = {
  display: 'pending',
  label: 'KZG backend pending',
  backend: 'pending',
  rustBackend: 'pending',
  webGpuAvailable: null,
  fallbackReason: null,
  probeStatus: null,
  circuitOpen: null,
  bucketWidth: null,
  reductionMode: null,
  calibrationStatus: null,
  calibrationSource: null,
  calibrationCacheKey: null,
  schedulerQueueWaitMs: null,
  schedulerTotalMs: null,
  schedulerQueueDepth: null,
  schedulerActive: null,
  schedulerMaxQueueDepth: null,
  schedulerFallbackCount: null,
  probeTimeoutMs: null,
  commitTimeoutMs: null,
  minBlobs: null,
  commitWorkerCount: null,
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value !== 'number') continue
    if (Number.isFinite(value) && value > 0) return value
  }
  return null
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === 'boolean') return value
  }
  return null
}

export function normalizeKzgBackendStatus(input?: KzgDiagnosticsInput | null): KzgBackendStatus {
  if (!input) return { ...PENDING_KZG_BACKEND_STATUS }

  const backend = firstString(input.kzgCommitBackend, input.workerKzgCommitBackend) ?? 'unknown'
  const rustBackend = firstString(input.rustCommitBackend, input.workerRustCommitBackend) ?? 'unknown'
  const fallbackReason = firstString(input.kzgWebGpuFallbackReason, input.workerKzgWebGpuFallbackReason)
  const probeStatus = firstString(input.kzgWebGpuProbeStatus, input.workerKzgWebGpuProbeStatus)
  const circuitOpen = firstBoolean(input.kzgWebGpuCircuitOpen, input.workerKzgWebGpuCircuitOpen)
  const webGpuAvailable = firstBoolean(input.kzgWebGpuAvailable, input.workerKzgWebGpuAvailable)
  const bucketWidth = firstNumber(input.kzgWebGpuBucketWidth, input.workerKzgWebGpuBucketWidth)
  const reductionMode = firstString(input.kzgWebGpuReductionMode, input.workerKzgWebGpuReductionMode)
  const calibrationStatus = firstString(input.kzgWebGpuCalibrationStatus, input.workerKzgWebGpuCalibrationStatus)
  const calibrationSource = firstString(input.kzgWebGpuCalibrationSource, input.workerKzgWebGpuCalibrationSource)
  const calibrationCacheKey = firstString(input.kzgWebGpuCalibrationCacheKey, input.workerKzgWebGpuCalibrationCacheKey)
  const settingParts = [reductionMode, bucketWidth ? `bucket ${bucketWidth}` : null, calibrationSource].filter(Boolean)

  let display: KzgBackendDisplay = 'unknown'
  let label = 'KZG backend unknown'
  if (backend === 'webgpu' || rustBackend === 'webgpu-msm') {
    display = 'webgpu-msm'
    label = settingParts.length ? `WebGPU MSM (${settingParts.join(', ')})` : 'WebGPU MSM'
  } else if (backend === 'wasm-blst' || backend === 'webgpu-wasm-fallback' || rustBackend === 'blst') {
    display = fallbackReason ? 'fallback' : 'wasm-blst'
    label = fallbackReason ? 'WASM blst fallback' : 'WASM blst'
  } else if (webGpuAvailable === false || fallbackReason) {
    display = webGpuAvailable === false ? 'unavailable' : 'fallback'
    label = webGpuAvailable === false ? 'WebGPU unavailable' : 'WebGPU fallback'
  }

  return {
    display,
    label,
    backend,
    rustBackend,
    webGpuAvailable,
    fallbackReason,
    probeStatus,
    circuitOpen,
    bucketWidth,
    reductionMode,
    calibrationStatus,
    calibrationSource,
    calibrationCacheKey,
    schedulerQueueWaitMs: firstNumber(input.kzgSchedulerQueueWaitMs, input.workerKzgSchedulerQueueWaitMs),
    schedulerTotalMs: firstNumber(input.kzgSchedulerTotalMs, input.workerKzgSchedulerTotalMs),
    schedulerQueueDepth: firstNumber(input.kzgSchedulerDepthAtEnqueue, input.workerKzgSchedulerDepthAtEnqueue),
    schedulerActive: firstNumber(input.kzgSchedulerActiveAtEnqueue, input.workerKzgSchedulerActiveAtEnqueue),
    schedulerMaxQueueDepth: firstNumber(input.kzgSchedulerMaxQueueDepth, input.workerKzgSchedulerMaxQueueDepth),
    schedulerFallbackCount: firstNumber(input.kzgSchedulerFallbackCount, input.workerKzgSchedulerFallbackCount),
    probeTimeoutMs: firstNumber(input.kzgWebGpuProbeTimeoutMs, input.workerKzgWebGpuProbeTimeoutMs),
    commitTimeoutMs: firstNumber(input.kzgWebGpuCommitTimeoutMs, input.workerKzgWebGpuCommitTimeoutMs),
    minBlobs: firstNumber(input.kzgWebGpuMinBlobs, input.workerKzgWebGpuMinBlobs),
    commitWorkerCount: firstNumber(input.commitWorkerCount, input.workerCommitWorkerCount),
  }
}

export function createUploadPipelineStatus(input: {
  dealId: string
  runId?: number | null
  fileName?: string | null
  fileBytes?: number | null
  nowMs?: number
}): UploadPipelineStatus {
  const now = input.nowMs ?? 0
  return {
    version: 1,
    runId: input.runId ?? null,
    dealId: input.dealId,
    phase: 'idle',
    phaseLabel: 'Idle',
    tone: 'idle',
    file: {
      name: input.fileName ?? null,
      bytes: input.fileBytes ?? null,
      logicalBytes: input.fileBytes ?? null,
    },
    totals: {
      userMdus: null,
      witnessMdus: null,
      totalMdus: null,
      bytesDone: null,
      bytesTotal: input.fileBytes ?? null,
      workDone: null,
      workTotal: null,
    },
    storage: {
      stage: 'none',
      browserMemoryBytes: null,
      opfsBytes: null,
      queuedArtifacts: null,
      uploadedArtifacts: null,
    },
    transport: {
      mode: 'none',
      target: null,
      retries: 0,
      lastError: null,
      artifactCount: null,
      perArtifactCount: null,
      bundledArtifactCount: null,
      bundleCount: null,
      requestCount: null,
      bytesSent: null,
      fallbackCount: null,
      fallbackReason: null,
      peakActiveUploads: null,
    },
    kzg: { ...PENDING_KZG_BACKEND_STATUS },
    timing: {
      startedAtMs: now,
      updatedAtMs: now,
      elapsedMs: null,
      phases: {},
    },
    latestEvent: null,
    error: null,
  }
}

export function patchUploadPipelineStatus(
  current: UploadPipelineStatus | null,
  patch: DeepPartialUploadPipelineStatus,
  nowMs: number,
): UploadPipelineStatus {
  const base =
    current ??
    createUploadPipelineStatus({
      dealId: typeof patch.dealId === 'string' ? patch.dealId : '',
      nowMs,
    })
  const startedAtMs = patch.timing?.startedAtMs ?? base.timing.startedAtMs
  return {
    ...base,
    ...patch,
    file: { ...base.file, ...(patch.file ?? {}) },
    totals: { ...base.totals, ...(patch.totals ?? {}) },
    storage: { ...base.storage, ...(patch.storage ?? {}) },
    transport: { ...base.transport, ...(patch.transport ?? {}) },
    kzg: { ...base.kzg, ...(patch.kzg ?? {}) },
    timing: {
      ...base.timing,
      ...(patch.timing ?? {}),
      startedAtMs,
      updatedAtMs: nowMs,
      elapsedMs: startedAtMs === null ? null : nowMs - startedAtMs,
      phases: {
        ...base.timing.phases,
        ...(patch.timing?.phases ?? {}),
      },
    },
  }
}

export function sanitizeUploadPipelineStatus(status: UploadPipelineStatus): UploadPipelineStatus {
  const truncate = (value: string | null, maxLength: number) => (value ? value.slice(0, maxLength) : null)
  return {
    ...status,
    dealId: status.dealId.slice(0, 160),
    phaseLabel: status.phaseLabel.slice(0, 240),
    file: {
      ...status.file,
      name: truncate(status.file.name, 160),
    },
    latestEvent: truncate(status.latestEvent, 160),
    error: truncate(status.error, 500),
    transport: {
      ...status.transport,
      target: truncate(status.transport.target, 240),
      lastError: truncate(status.transport.lastError, 500),
      fallbackReason: truncate(status.transport.fallbackReason, 500),
    },
    kzg: {
      ...status.kzg,
      fallbackReason: truncate(status.kzg.fallbackReason, 500),
      calibrationCacheKey: truncate(status.kzg.calibrationCacheKey, 240),
    },
  }
}
