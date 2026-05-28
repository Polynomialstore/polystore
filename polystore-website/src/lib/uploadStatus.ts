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
  reductionMode: string | null
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
  kzgWebGpuReductionMode?: string
  workerKzgWebGpuReductionMode?: string
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
  reductionMode: null,
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
    if (Number.isFinite(value)) return value
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
  const reductionMode = firstString(input.kzgWebGpuReductionMode, input.workerKzgWebGpuReductionMode)

  let display: KzgBackendDisplay = 'unknown'
  let label = 'KZG backend unknown'
  if (backend === 'webgpu' || rustBackend === 'webgpu-msm') {
    display = 'webgpu-msm'
    label = reductionMode ? `WebGPU MSM (${reductionMode})` : 'WebGPU MSM'
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
    reductionMode,
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
  return {
    ...status,
    file: {
      ...status.file,
      name: status.file.name ? status.file.name.slice(0, 160) : null,
    },
    error: status.error ? status.error.slice(0, 500) : null,
    transport: {
      ...status.transport,
      target: status.transport.target ? status.transport.target.slice(0, 240) : null,
      lastError: status.transport.lastError ? status.transport.lastError.slice(0, 500) : null,
    },
    kzg: {
      ...status.kzg,
      fallbackReason: status.kzg.fallbackReason ? status.kzg.fallbackReason.slice(0, 500) : null,
    },
  }
}
