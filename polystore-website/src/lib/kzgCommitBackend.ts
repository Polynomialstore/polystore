import {
  createWebGpuKzgMsmCommitter,
  type WebGpuKzgMsmCommitter,
  type WebGpuKzgMsmReductionMode,
  type WebGpuKzgMsmResult,
} from './webgpuKzgMsm'

export const KZG_BLOB_SIZE = 128 * 1024
export const KZG_COMMITMENT_SIZE = 48
export const KZG_CELLS_PER_BLOB = KZG_BLOB_SIZE / 32
export const POLYSTORE_TRUSTED_SETUP_SHA256 = 'd39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7'
const DEFAULT_WEBGPU_PROBE_TIMEOUT_MS = 1500
const DEFAULT_WEBGPU_COMMIT_TIMEOUT_MS = 3000
const DEFAULT_WEBGPU_MIN_BLOBS = 1

export type KzgCommitBackendKind = 'wasm-blst' | 'webgpu-scheduler' | 'webgpu-wasm-fallback'
export type KzgCommitBackendChoice = 'wasm-blst' | 'webgpu'
export type WebGpuKzgMode = 'auto' | 'force' | 'off'

export type PolyStoreCommitApi = {
  commit_blobs(blobBytes: Uint8Array): Uint8Array | ArrayBufferLike
  commit_blobs_profiled(blobBytes: Uint8Array): unknown
}

export type KzgCommitPerf = {
  decodeMs: number
  transformMs: number
  msmScalarPrepMs: number
  msmBucketFillMs: number
  msmReduceMs: number
  msmDoubleMs: number
  msmMs: number
  compressMs: number
  totalMs: number
  blobs: number
}

export type KzgCommitProfiledResult = {
  witnessFlat: Uint8Array
  perf: KzgCommitPerf
}

export type KzgCommitBackendStatus = {
  kind: KzgCommitBackendKind
  initialized: boolean
  label: string
  fallbackReason?: string
  selectedBackend?: KzgCommitBackendChoice
  webgpu?: WebGpuKzgStatus
}

export type KzgCommitBackend = {
  readonly kind: KzgCommitBackendKind
  getStatus(): KzgCommitBackendStatus
  commitBlobs(blobsFlat: Uint8Array): Uint8Array | Promise<Uint8Array>
  commitBlobsProfiled(blobsFlat: Uint8Array): KzgCommitProfiledResult | Promise<KzgCommitProfiledResult>
}

type GpuBufferLike = {
  destroy?: () => void
}

type GpuQueueLike = {
  writeBuffer: (buffer: GpuBufferLike, bufferOffset: number, data: Uint8Array) => void
}

type GpuDeviceLike = {
  label?: string
  queue: GpuQueueLike
  lost?: Promise<{ reason?: string; message?: string }>
  createBuffer: (descriptor: {
    label?: string
    size: number
    usage: number
  }) => GpuBufferLike
}

type GpuAdapterLike = {
  info?: WebGpuKzgAdapterInfo
  requestAdapterInfo?: () => Promise<WebGpuKzgAdapterInfo>
  requestDevice: () => Promise<GpuDeviceLike>
}

type GpuLike = {
  requestAdapter: () => Promise<GpuAdapterLike | null>
}

type WebGpuNavigator = Navigator & {
  gpu?: GpuLike
}

type WebGpuBufferUsageLike = {
  STORAGE: number
  COPY_DST: number
}

export type WebGpuKzgInitTimings = {
  setupParseMs: number
  setupHashMs: number
  adapterMs: number
  deviceMs: number
  srsUploadMs: number
  totalMs: number
}

export type WebGpuSrsMetadata = {
  g1Count: number
  g2Count: number
  g1Bytes: number
  sha256: string
  basis: 'lagrange-or-monomial-g1-compressed'
}

export type WebGpuKzgStatus = {
  supported: boolean
  available: boolean
  deviceLost: boolean
  fallbackActive: boolean
  reason?: string
  adapter?: WebGpuKzgAdapterInfo | null
  selectedBackend?: KzgCommitBackendChoice
  reductionMode?: WebGpuKzgMsmReductionMode
  scheduler?: WebGpuKzgSchedulerStatus
  srs?: WebGpuSrsMetadata
  timings?: WebGpuKzgInitTimings
}

export type WebGpuKzgAdapterInfo = {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
  isFallbackAdapter?: boolean
}

export type WebGpuKzgSchedulerStatus = {
  mode: WebGpuKzgMode
  probeStatus: 'not-run' | 'running' | 'passed' | 'failed' | 'timeout' | 'disabled'
  probeTimeoutMs: number
  commitTimeoutMs: number
  minBlobs: number
  circuitOpen: boolean
  circuitReason?: string
  lastProbeMs?: number
  lastWebGpuMs?: number
  lastWasmMs?: number
  lastFallbackReason?: string
}

export type CreateKzgCommitBackendOptions = {
  preferWebGpu?: boolean
  webGpuMode?: WebGpuKzgMode
  webGpuProbeTimeoutMs?: number
  webGpuCommitTimeoutMs?: number
  webGpuMinBlobs?: number
  allowFallbackAdapter?: boolean
  webGpuCommitterFactory?: () => Promise<WebGpuKzgMsmCommitter>
  navigatorLike?: WebGpuNavigator
  bufferUsage?: WebGpuBufferUsageLike
  now?: () => number
}

export function toUint8Array(value: Uint8Array | ArrayBufferLike): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function assertBlobBatch(blobsFlat: Uint8Array): number {
  if (!(blobsFlat instanceof Uint8Array)) {
    throw new Error('blobsFlat must be a Uint8Array')
  }
  if (blobsFlat.byteLength % KZG_BLOB_SIZE !== 0) {
    throw new Error('blobsFlat length must be a multiple of 128 KiB')
  }
  return blobsFlat.byteLength / KZG_BLOB_SIZE
}

function numberField(value: unknown): number {
  return Number(value ?? 0)
}

function nowMs(now: (() => number) | undefined): number {
  if (now) return now()
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
  return Date.now()
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function makeProbeBlob(): Uint8Array {
  const blob = new Uint8Array(KZG_BLOB_SIZE)
  for (let i = 0; i < KZG_CELLS_PER_BLOB; i += 1) {
    const offset = i * 32
    blob[offset] = 0
    for (let j = 1; j < 32; j += 1) {
      blob[offset + j] = (41 + i * 17 + j * 29) & 0xff
    }
  }
  return blob
}

function profileFromWebGpuResult(result: WebGpuKzgMsmResult): KzgCommitPerf {
  return {
    decodeMs: 0,
    transformMs: 0,
    msmScalarPrepMs: result.timings.scalarPrepMs,
    msmBucketFillMs: result.timings.bucketBuildMs,
    msmReduceMs: result.timings.dispatchReadbackMs,
    msmDoubleMs: 0,
    msmMs: result.timings.dispatchReadbackMs,
    compressMs: result.timings.foldMs,
    totalMs: result.timings.totalMs,
    blobs: result.blobs,
  }
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback
  return Math.floor(value)
}

function normalizeMinBlobs(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) return DEFAULT_WEBGPU_MIN_BLOBS
  return Math.floor(value)
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms)
  })
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  return Promise.race([
    promise.then((value) => ({ timedOut: false as const, value })),
    delay(timeoutMs, { timedOut: true as const }),
  ])
}

async function readAdapterInfo(adapter: GpuAdapterLike): Promise<WebGpuKzgAdapterInfo | null> {
  try {
    if (adapter.info) return adapter.info
    if (typeof adapter.requestAdapterInfo === 'function') return await adapter.requestAdapterInfo()
  } catch {
    return null
  }
  return null
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new Error('crypto.subtle is required to validate trusted setup bytes')
  }
  const digestInput = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return bytesToHex(new Uint8Array(await subtle.digest('SHA-256', digestInput)))
}

function hexLineToBytes(line: string, expectedBytes: number, label: string): Uint8Array {
  const trimmed = line.trim()
  if (trimmed.length !== expectedBytes * 2 || !/^[0-9a-fA-F]+$/.test(trimmed)) {
    throw new Error(`Trusted setup ${label} line must be ${expectedBytes} bytes of hex`)
  }
  const out = new Uint8Array(expectedBytes)
  for (let i = 0; i < expectedBytes; i += 1) {
    out[i] = Number.parseInt(trimmed.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function parseTrustedSetupG1Srs(
  trustedSetupBytes: Uint8Array,
): Omit<WebGpuSrsMetadata, 'sha256'> & { g1Compressed: Uint8Array; g2StartLine: number } {
  const text = new TextDecoder().decode(trustedSetupBytes)
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length < 2) {
    throw new Error('Trusted setup is missing G1/G2 counts')
  }

  const g1Count = Number(lines[0])
  const g2Count = Number(lines[1])
  if (!Number.isInteger(g1Count) || g1Count < KZG_CELLS_PER_BLOB) {
    throw new Error(`Trusted setup G1 count ${lines[0]} is below required blob domain ${KZG_CELLS_PER_BLOB}`)
  }
  if (!Number.isInteger(g2Count) || g2Count < 2) {
    throw new Error('Trusted setup G2 count must be at least 2')
  }
  if (lines.length < 2 + g1Count + g2Count) {
    throw new Error('Trusted setup ended before declared G1/G2 points')
  }

  const g1Compressed = new Uint8Array(g1Count * KZG_COMMITMENT_SIZE)
  for (let i = 0; i < g1Count; i += 1) {
    g1Compressed.set(hexLineToBytes(lines[2 + i], KZG_COMMITMENT_SIZE, `G1[${i}]`), i * KZG_COMMITMENT_SIZE)
  }

  for (let i = 0; i < g2Count; i += 1) {
    hexLineToBytes(lines[2 + g1Count + i], 96, `G2[${i}]`)
  }

  return {
    g1Count,
    g2Count,
    g1Bytes: g1Compressed.byteLength,
    basis: 'lagrange-or-monomial-g1-compressed',
    g1Compressed,
    g2StartLine: 2 + g1Count,
  }
}

export function parseKzgCommitProfiledResult(raw: unknown, expectedBlobs: number): KzgCommitProfiledResult {
  const obj = raw as {
    witness_flat?: Uint8Array | ArrayBufferLike
    perf?: {
      decode_ms?: unknown
      transform_ms?: unknown
      msm_scalar_prep_ms?: unknown
      msm_bucket_fill_ms?: unknown
      msm_reduce_ms?: unknown
      msm_double_ms?: unknown
      msm_ms?: unknown
      compress_ms?: unknown
      total_ms?: unknown
      blobs?: unknown
    }
  }

  if (!obj?.witness_flat) {
    throw new Error('commit_blobs_profiled returned no witness bytes')
  }

  const witnessFlat = toUint8Array(obj.witness_flat)
  const expectedWitnessBytes = expectedBlobs * KZG_COMMITMENT_SIZE
  if (witnessFlat.byteLength !== expectedWitnessBytes) {
    throw new Error(
      `commit_blobs_profiled returned ${witnessFlat.byteLength} witness bytes, expected ${expectedWitnessBytes}`,
    )
  }

  const perf = obj.perf
  return {
    witnessFlat,
    perf: {
      decodeMs: numberField(perf?.decode_ms),
      transformMs: numberField(perf?.transform_ms),
      msmScalarPrepMs: numberField(perf?.msm_scalar_prep_ms),
      msmBucketFillMs: numberField(perf?.msm_bucket_fill_ms),
      msmReduceMs: numberField(perf?.msm_reduce_ms),
      msmDoubleMs: numberField(perf?.msm_double_ms),
      msmMs: numberField(perf?.msm_ms),
      compressMs: numberField(perf?.compress_ms),
      totalMs: numberField(perf?.total_ms),
      blobs: Number(perf?.blobs ?? expectedBlobs),
    },
  }
}

export class WasmBlstKzgCommitBackend implements KzgCommitBackend {
  readonly kind = 'wasm-blst' as const

  constructor(private readonly wasm: PolyStoreCommitApi) {}

  getStatus(): KzgCommitBackendStatus {
    return {
      kind: this.kind,
      initialized: Boolean(this.wasm),
      label: 'WASM blst',
    }
  }

  commitBlobs(blobsFlat: Uint8Array): Uint8Array {
    const expectedBlobs = assertBlobBatch(blobsFlat)
    const commitments = toUint8Array(this.wasm.commit_blobs(blobsFlat))
    const expectedBytes = expectedBlobs * KZG_COMMITMENT_SIZE
    if (commitments.byteLength !== expectedBytes) {
      throw new Error(`commit_blobs returned ${commitments.byteLength} bytes, expected ${expectedBytes}`)
    }
    return commitments
  }

  commitBlobsProfiled(blobsFlat: Uint8Array): KzgCommitProfiledResult {
    const expectedBlobs = assertBlobBatch(blobsFlat)
    return parseKzgCommitProfiledResult(this.wasm.commit_blobs_profiled(blobsFlat), expectedBlobs)
  }
}

export class WebGpuKzgLifecycleBackend implements KzgCommitBackend {
  readonly kind = 'webgpu-wasm-fallback' as const
  private srsBuffer: GpuBufferLike | null
  private status: WebGpuKzgStatus

  constructor(
    private readonly wasmFallback: KzgCommitBackend,
    initialStatus: WebGpuKzgStatus,
    srsBuffer: GpuBufferLike | null,
  ) {
    this.status = initialStatus
    this.srsBuffer = srsBuffer
  }

  getStatus(): KzgCommitBackendStatus {
    const reason = this.status.reason || 'WebGPU MSM is not implemented in this milestone; commitments use WASM'
    return {
      kind: this.kind,
      initialized: this.wasmFallback.getStatus().initialized,
      label: this.status.available ? 'WebGPU SRS resident, WASM commit fallback' : 'WASM blst fallback',
      fallbackReason: reason,
      webgpu: { ...this.status, reason },
    }
  }

  markDeviceLost(reason: string): void {
    this.srsBuffer?.destroy?.()
    this.srsBuffer = null
    this.status = {
      ...this.status,
      available: false,
      deviceLost: true,
      fallbackActive: true,
      reason,
    }
  }

  commitBlobs(blobsFlat: Uint8Array): Uint8Array | Promise<Uint8Array> {
    return this.wasmFallback.commitBlobs(blobsFlat)
  }

  commitBlobsProfiled(blobsFlat: Uint8Array): KzgCommitProfiledResult | Promise<KzgCommitProfiledResult> {
    return this.wasmFallback.commitBlobsProfiled(blobsFlat)
  }
}

export class ScheduledWebGpuKzgCommitBackend implements KzgCommitBackend {
  readonly kind = 'webgpu-scheduler' as const
  private status: WebGpuKzgStatus
  private committer: WebGpuKzgMsmCommitter | null = null
  private probePromise: Promise<boolean> | null = null
  private readonly mode: WebGpuKzgMode
  private readonly probeTimeoutMs: number
  private readonly commitTimeoutMs: number
  private readonly minBlobs: number

  constructor(
    private readonly wasmFallback: KzgCommitBackend,
    private readonly wasmInterop: PolyStoreCommitApi,
    private readonly navigatorLike: WebGpuNavigator | undefined,
    initialStatus: WebGpuKzgStatus,
    private readonly options: CreateKzgCommitBackendOptions,
  ) {
    this.mode = options.webGpuMode ?? (options.preferWebGpu ? 'auto' : 'off')
    this.probeTimeoutMs = normalizeTimeout(options.webGpuProbeTimeoutMs, DEFAULT_WEBGPU_PROBE_TIMEOUT_MS)
    this.commitTimeoutMs = normalizeTimeout(options.webGpuCommitTimeoutMs, DEFAULT_WEBGPU_COMMIT_TIMEOUT_MS)
    this.minBlobs = normalizeMinBlobs(options.webGpuMinBlobs)
    this.status = {
      ...initialStatus,
      fallbackActive: true,
      selectedBackend: 'wasm-blst',
      scheduler: {
        mode: this.mode,
        probeStatus: this.mode === 'off' ? 'disabled' : 'not-run',
        probeTimeoutMs: this.probeTimeoutMs,
        commitTimeoutMs: this.commitTimeoutMs,
        minBlobs: this.minBlobs,
        circuitOpen: false,
      },
    }
  }

  getStatus(): KzgCommitBackendStatus {
    return {
      kind: this.kind,
      initialized: this.wasmFallback.getStatus().initialized,
      label: this.status.selectedBackend === 'webgpu' ? 'WebGPU KZG MSM' : 'WASM blst fallback',
      fallbackReason: this.status.scheduler?.lastFallbackReason ?? this.status.reason,
      selectedBackend: this.status.selectedBackend,
      webgpu: { ...this.status, scheduler: this.status.scheduler ? { ...this.status.scheduler } : undefined },
    }
  }

  private updateScheduler(update: Partial<WebGpuKzgSchedulerStatus>): void {
    const scheduler = this.status.scheduler ?? {
      mode: this.mode,
      probeStatus: 'not-run' as const,
      probeTimeoutMs: this.probeTimeoutMs,
      commitTimeoutMs: this.commitTimeoutMs,
      minBlobs: this.minBlobs,
      circuitOpen: false,
    }
    this.status = {
      ...this.status,
      scheduler: { ...scheduler, ...update },
    }
  }

  private fallBack(reason: string): void {
    this.status = {
      ...this.status,
      available: Boolean(this.committer),
      fallbackActive: true,
      selectedBackend: 'wasm-blst',
      reason,
    }
    this.updateScheduler({ lastFallbackReason: reason })
  }

  private openCircuit(reason: string): void {
    this.committer?.destroy()
    this.committer = null
    this.status = {
      ...this.status,
      available: false,
      fallbackActive: true,
      selectedBackend: 'wasm-blst',
      reason,
    }
    this.updateScheduler({
      circuitOpen: true,
      circuitReason: reason,
      lastFallbackReason: reason,
    })
  }

  private async initCommitter(): Promise<WebGpuKzgMsmCommitter> {
    if (this.committer) return this.committer
    const committer = this.options.webGpuCommitterFactory
      ? await this.options.webGpuCommitterFactory()
      : await createWebGpuKzgMsmCommitter(
          this.wasmInterop as unknown as Parameters<typeof createWebGpuKzgMsmCommitter>[0],
          this.navigatorLike as unknown as Parameters<typeof createWebGpuKzgMsmCommitter>[1],
          { allowFallbackAdapter: this.options.allowFallbackAdapter ?? false },
        )
    this.committer = committer
    this.status = {
      ...this.status,
      supported: true,
      available: true,
      deviceLost: false,
    }
    committer.getDeviceLostInfo().then((info) => {
      if (info) {
        this.openCircuit(`WebGPU device lost${info.reason ? `: ${info.reason}` : ''}${info.message ? ` (${info.message})` : ''}`)
      }
    }).catch((error) => {
      this.openCircuit(`WebGPU device lost: ${error instanceof Error ? error.message : String(error)}`)
    })
    return committer
  }

  private async probe(): Promise<boolean> {
    if (this.mode === 'off') {
      this.fallBack('WebGPU KZG scheduler disabled')
      return false
    }
    if (this.status.scheduler?.circuitOpen) return false
    if (this.status.scheduler?.probeStatus === 'passed') return true
    if (this.probePromise) return this.probePromise

    this.updateScheduler({ probeStatus: 'running' })
    this.probePromise = this.runProbe().finally(() => {
      this.probePromise = null
    })
    return this.probePromise
  }

  private async runProbe(): Promise<boolean> {
    const probeStarted = nowMs(this.options.now)
    const probeBlob = makeProbeBlob()
    try {
      const wasmStarted = nowMs(this.options.now)
      const wasmCommitments = await this.wasmFallback.commitBlobs(probeBlob)
      const wasmMs = nowMs(this.options.now) - wasmStarted
      const committer = await this.initCommitter()
      const gpuPromise = committer.commitBlobs(probeBlob)
      const timed = await withTimeout(gpuPromise, this.probeTimeoutMs)
      if (timed.timedOut) {
        gpuPromise.catch(() => undefined).finally(() => this.committer?.destroy())
        this.openCircuit(`WebGPU probe exceeded ${this.probeTimeoutMs}ms`)
        this.updateScheduler({ probeStatus: 'timeout', lastProbeMs: nowMs(this.options.now) - probeStarted, lastWasmMs: wasmMs })
        return false
      }

      const gpu = timed.value
      const gpuMs = gpu.timings.totalMs
      const parity = bytesToHex(wasmCommitments) === bytesToHex(gpu.commitments)
      this.updateScheduler({
        lastProbeMs: nowMs(this.options.now) - probeStarted,
        lastWebGpuMs: gpuMs,
        lastWasmMs: wasmMs,
      })
      if (!parity) {
        this.openCircuit('WebGPU probe commitment parity failed')
        this.updateScheduler({ probeStatus: 'failed' })
        return false
      }
      if (this.mode === 'auto' && gpuMs > wasmMs) {
        this.fallBack(`WebGPU probe slower than WASM (${gpuMs.toFixed(2)}ms > ${wasmMs.toFixed(2)}ms)`)
        this.updateScheduler({ probeStatus: 'failed' })
        return false
      }
      this.status = {
        ...this.status,
        available: true,
        fallbackActive: false,
        selectedBackend: 'webgpu',
        reductionMode: gpu.debug?.reductionMode,
        reason: undefined,
      }
      this.updateScheduler({ probeStatus: 'passed', lastFallbackReason: undefined })
      return true
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.openCircuit(reason)
      this.updateScheduler({ probeStatus: 'failed', lastProbeMs: nowMs(this.options.now) - probeStarted })
      return false
    }
  }

  async commitBlobs(blobsFlat: Uint8Array): Promise<Uint8Array> {
    const blobs = assertBlobBatch(blobsFlat)
    if (blobs < this.minBlobs) {
      this.fallBack(`batch below WebGPU threshold: ${blobs} < ${this.minBlobs}`)
      return this.wasmFallback.commitBlobs(blobsFlat)
    }
    if (!(await this.probe()) || !this.committer) {
      return this.wasmFallback.commitBlobs(blobsFlat)
    }

    const gpuPromise = this.committer.commitBlobs(blobsFlat)
    const timed = await withTimeout(gpuPromise, this.commitTimeoutMs)
    if (timed.timedOut) {
      gpuPromise.catch(() => undefined).finally(() => this.committer?.destroy())
      this.openCircuit(`WebGPU commit exceeded ${this.commitTimeoutMs}ms`)
      return this.wasmFallback.commitBlobs(blobsFlat)
    }

    this.status = {
      ...this.status,
      fallbackActive: false,
      selectedBackend: 'webgpu',
      reductionMode: timed.value.debug?.reductionMode ?? this.status.reductionMode,
    }
    this.updateScheduler({ lastWebGpuMs: timed.value.timings.totalMs, lastFallbackReason: undefined })
    return timed.value.commitments
  }

  async commitBlobsProfiled(blobsFlat: Uint8Array): Promise<KzgCommitProfiledResult> {
    const blobs = assertBlobBatch(blobsFlat)
    if (blobs < this.minBlobs) {
      this.fallBack(`batch below WebGPU threshold: ${blobs} < ${this.minBlobs}`)
      return this.wasmFallback.commitBlobsProfiled(blobsFlat)
    }
    if (!(await this.probe()) || !this.committer) {
      return this.wasmFallback.commitBlobsProfiled(blobsFlat)
    }

    const gpuPromise = this.committer.commitBlobs(blobsFlat)
    const timed = await withTimeout(gpuPromise, this.commitTimeoutMs)
    if (timed.timedOut) {
      gpuPromise.catch(() => undefined).finally(() => this.committer?.destroy())
      this.openCircuit(`WebGPU commit exceeded ${this.commitTimeoutMs}ms`)
      return this.wasmFallback.commitBlobsProfiled(blobsFlat)
    }

    this.status = {
      ...this.status,
      fallbackActive: false,
      selectedBackend: 'webgpu',
      reductionMode: timed.value.debug?.reductionMode ?? this.status.reductionMode,
    }
    this.updateScheduler({ lastWebGpuMs: timed.value.timings.totalMs, lastFallbackReason: undefined })
    return {
      witnessFlat: timed.value.commitments,
      perf: profileFromWebGpuResult(timed.value),
    }
  }
}

export function createWasmBlstKzgCommitBackend(wasm: PolyStoreCommitApi | null | undefined): KzgCommitBackend {
  if (!wasm) {
    throw new Error('PolyStoreWasm not initialized')
  }
  return new WasmBlstKzgCommitBackend(wasm)
}

export async function createBrowserKzgCommitBackend(
  wasm: PolyStoreCommitApi | null | undefined,
  trustedSetupBytes: Uint8Array,
  options: CreateKzgCommitBackendOptions = {},
): Promise<KzgCommitBackend> {
  const wasmFallback = createWasmBlstKzgCommitBackend(wasm)
  const mode = options.webGpuMode ?? (options.preferWebGpu ? 'auto' : 'off')
  if (!options.preferWebGpu || mode === 'off') {
    return wasmFallback
  }

  const started = nowMs(options.now)
  const timings: WebGpuKzgInitTimings = {
    setupParseMs: 0,
    setupHashMs: 0,
    adapterMs: 0,
    deviceMs: 0,
    srsUploadMs: 0,
    totalMs: 0,
  }

  try {
    const gpu = options.navigatorLike?.gpu ?? (globalThis.navigator as WebGpuNavigator | undefined)?.gpu
    if (!gpu) {
      throw new Error('navigator.gpu is unavailable')
    }

    const parseStart = nowMs(options.now)
    const parsed = parseTrustedSetupG1Srs(trustedSetupBytes)
    timings.setupParseMs = nowMs(options.now) - parseStart

    const hashStart = nowMs(options.now)
    const setupSha256 = await sha256Hex(trustedSetupBytes)
    timings.setupHashMs = nowMs(options.now) - hashStart
    if (setupSha256 !== POLYSTORE_TRUSTED_SETUP_SHA256) {
      throw new Error(`Trusted setup SHA-256 mismatch: ${setupSha256}`)
    }

    timings.totalMs = nowMs(options.now) - started

    const adapterStart = nowMs(options.now)
    const adapter = await gpu.requestAdapter()
    timings.adapterMs = nowMs(options.now) - adapterStart
    if (!adapter) {
      throw new Error('WebGPU adapter request returned null')
    }
    const adapterInfo = await readAdapterInfo(adapter)
    if (!options.allowFallbackAdapter && adapterInfo?.isFallbackAdapter) {
      throw new Error('WebGPU adapter is a fallback/software adapter')
    }

    return new ScheduledWebGpuKzgCommitBackend(
      wasmFallback,
      wasm as PolyStoreCommitApi,
      options.navigatorLike,
      {
        supported: true,
        available: false,
        deviceLost: false,
        fallbackActive: true,
        reason: 'WebGPU scheduler has not completed its bounded probe',
        adapter: adapterInfo,
        srs: {
          g1Count: parsed.g1Count,
          g2Count: parsed.g2Count,
          g1Bytes: parsed.g1Bytes,
          sha256: setupSha256,
          basis: parsed.basis,
        },
        timings,
      },
      options,
    )
  } catch (error) {
    timings.totalMs = nowMs(options.now) - started
    return new WebGpuKzgLifecycleBackend(
      wasmFallback,
      {
        supported: Boolean(options.navigatorLike?.gpu ?? (globalThis.navigator as WebGpuNavigator | undefined)?.gpu),
        available: false,
        deviceLost: false,
        fallbackActive: true,
        reason: error instanceof Error ? error.message : String(error),
        timings,
      },
      null,
    )
  }
}
