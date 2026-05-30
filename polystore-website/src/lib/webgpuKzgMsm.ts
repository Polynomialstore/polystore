import {
  WEBGPU_GROTH16_MSM_G1_AGG_SHADER,
  WEBGPU_GROTH16_MSM_G1_SUBSUM_SHADER,
} from './webgpuKzgShaders'

type GPUBuffer = {
  destroy: () => void
  getMappedRange: () => ArrayBuffer
  mapAsync: (mode: number) => Promise<void>
  unmap: () => void
}
type GPUBindGroupLayout = object
type GPUComputePipeline = {
  getBindGroupLayout: (index: number) => GPUBindGroupLayout
}
type GPUComputePass = {
  setPipeline: (pipeline: GPUComputePipeline) => void
  setBindGroup: (index: number, bindGroup: object) => void
  dispatchWorkgroups: (x: number, y?: number, z?: number) => void
  end: () => void
}
type GPUCommandEncoder = {
  beginComputePass: (descriptor: object) => GPUComputePass
  copyBufferToBuffer: (source: GPUBuffer, sourceOffset: number, destination: GPUBuffer, destinationOffset: number, size: number) => void
  finish: () => object
}
type GPUDevice = {
  queue: {
    submit: (commandBuffers: object[]) => void
    writeBuffer: (buffer: GPUBuffer, bufferOffset: number, data: Uint8Array | Uint32Array) => void
  }
  lost?: Promise<{ reason?: string; message?: string }>
  createBindGroup: (descriptor: object) => object
  createBindGroupLayout: (descriptor: object) => GPUBindGroupLayout
  createBuffer: (descriptor: object) => GPUBuffer
  createCommandEncoder: (descriptor: object) => GPUCommandEncoder
  createComputePipeline: (descriptor: object) => GPUComputePipeline
  createPipelineLayout: (descriptor: object) => object
  createShaderModule: (descriptor: object) => object
  pushErrorScope?: (filter: 'validation') => void
  popErrorScope?: () => Promise<null | { message?: string }>
}
type WebGpuNavigator = Navigator & {
  gpu?: {
    requestAdapter: () => Promise<null | WebGpuAdapter>
  }
}
type WebGpuAdapter = {
  info?: WebGpuAdapterInfo
  requestAdapterInfo?: () => Promise<WebGpuAdapterInfo>
  requestDevice: () => Promise<GPUDevice>
}
export type WebGpuKzgMsmAdapterInfo = {
  vendor?: string
  architecture?: string
  device?: string
  description?: string
  isFallbackAdapter?: boolean
}

type WebGpuAdapterInfo = WebGpuKzgMsmAdapterInfo

export const WEBGPU_KZG_MSM_BUCKET_WIDTH = 10
export const WEBGPU_KZG_MSM_REDUCTION_MODE: WebGpuKzgMsmReductionMode = 'serial'
export const WEBGPU_KZG_MSM_CALIBRATION_VERSION = 'webgpu-msm-calibration-v2'
export const WEBGPU_KZG_MSM_CALIBRATION_STORAGE_PREFIX = 'polystore:kzg:webgpu-msm-calibration:'
export const WEBGPU_KZG_MSM_POINT_BYTES = 384
export const WEBGPU_KZG_MSM_SIGN_BIT = 0x80000000
export const WEBGPU_KZG_MSM_BLOB_SIZE = 128 * 1024
export const WEBGPU_KZG_MSM_CELLS_PER_BLOB = WEBGPU_KZG_MSM_BLOB_SIZE / 32
const FR_MODULUS = BigInt('0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001')

export type WebGpuKzgMsmWasmInterop = {
  webgpu_g1_srs_lagrange: () => Uint8Array
  webgpu_fold_g1_window_sums: (windowSums: Uint8Array, bucketWidth: number) => Uint8Array
}

export type WebGpuKzgMsmReductionMode = 'serial' | 'parallel16' | 'parallel32' | 'parallel64'

export type WebGpuKzgMsmOptions = {
  bucketWidth?: number
  reductionMode?: WebGpuKzgMsmReductionMode
  allowFallbackAdapter?: boolean
  calibration?: WebGpuKzgMsmAdapterCalibration
}

export type WebGpuKzgMsmCalibrationSource = 'default-adapter-rule' | 'benchmark-matrix'

export type WebGpuKzgMsmCalibrationFixture = {
  blobs: number
  bytes: number
  runs: number
  candidates: number
  metric: 'median-total-ms'
  wasmMs: number | null
}

export type WebGpuKzgMsmAdapterCalibration = {
  version: string
  cacheKey: string
  bucketWidth: number
  reductionMode: WebGpuKzgMsmReductionMode
  minBlobs: number
  minBytes: number
  source: WebGpuKzgMsmCalibrationSource
  reason: string
  score: number | null
  measuredFixture: WebGpuKzgMsmCalibrationFixture | null
  measuredAtMs: number | null
}

export type WebGpuKzgMsmCalibrationCandidate = {
  bucketWidth: number
  reductionMode: WebGpuKzgMsmReductionMode
  label?: string
}

export type WebGpuKzgMsmCalibrationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export type WebGpuKzgMsmCalibrationCommitter = {
  commitBlobs: (blobsFlat: Uint8Array) => Promise<WebGpuKzgMsmResult>
  destroy: () => void
}

export type WebGpuKzgMsmCalibrationOptions = {
  adapterInfo: WebGpuKzgMsmAdapterInfo | null
  createCommitter: (candidate: WebGpuKzgMsmCalibrationCandidate) => Promise<WebGpuKzgMsmCalibrationCommitter>
  oracleCommitBlobs: (blobsFlat: Uint8Array) => Uint8Array | Promise<Uint8Array>
  candidates?: WebGpuKzgMsmCalibrationCandidate[]
  blobCount?: number
  runsPerCandidate?: number
  timeoutMs?: number
  now?: () => number
}

export type WebGpuKzgMsmTimings = {
  scalarPrepMs: number
  bucketBuildMs: number
  uploadMs: number
  dispatchReadbackMs: number
  foldMs: number
  totalMs: number
}

export type WebGpuKzgMsmResult = {
  commitments: Uint8Array
  timings: WebGpuKzgMsmTimings
  blobs: number
  debug?: {
    bucketWidth: number
    reductionMode: WebGpuKzgMsmReductionMode
    bucketCount: number
    baseIndexCount: number
    numWindows: number
    maxBucketSize: number
    meanBucketSize: number
    uploadBytes: number
    readbackBytes: number
    windowSumNonZeroBytes: number
    processedBlobs: number
    commandSubmissions: number
    readbackCount: number
    scratchCapacityBytes: number
    scratchResizeCount: number
  }
}

export type WebGpuKzgMsmDeviceLostInfo = {
  reason: string | null
  message: string | null
}

type BucketData = {
  baseIndices: Uint32Array
  bucketPointers: Uint32Array
  bucketSizes: Uint32Array
  bucketValues: Uint32Array
  windowStarts: Uint32Array
  windowCounts: Uint32Array
  numWindows: number
  maxBucketSize: number
}

type ScratchBufferStats = {
  capacityBytes: number
  resizeCount: number
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
  return Date.now()
}

function gpuBufferUsage(): { STORAGE: number; COPY_DST: number; COPY_SRC: number; MAP_READ: number; UNIFORM: number } {
  const usage = (globalThis as unknown as {
    GPUBufferUsage?: { STORAGE: number; COPY_DST: number; COPY_SRC: number; MAP_READ: number; UNIFORM: number }
  }).GPUBufferUsage
  if (!usage) throw new Error('GPUBufferUsage constants are unavailable')
  return usage
}

function gpuShaderStage(): { COMPUTE: number } {
  const stage = (globalThis as unknown as { GPUShaderStage?: { COMPUTE: number } }).GPUShaderStage
  if (!stage) throw new Error('GPUShaderStage constants are unavailable')
  return stage
}

function gpuMapMode(): { READ: number } {
  const mode = (globalThis as unknown as { GPUMapMode?: { READ: number } }).GPUMapMode
  if (!mode) throw new Error('GPUMapMode constants are unavailable')
  return mode
}

function assertBlobBatch(blobsFlat: Uint8Array): number {
  if (blobsFlat.byteLength % WEBGPU_KZG_MSM_BLOB_SIZE !== 0) {
    throw new Error('WebGPU KZG MSM input length must be a multiple of 128 KiB')
  }
  return blobsFlat.byteLength / WEBGPU_KZG_MSM_BLOB_SIZE
}

function assertBucketWidth(bucketWidth: number): number {
  if (!Number.isInteger(bucketWidth) || bucketWidth < 4 || bucketWidth > 13) {
    throw new Error('WebGPU KZG MSM bucket width must be an integer between 4 and 13')
  }
  return bucketWidth
}

function blobCellToScalar(cell: Uint8Array): bigint {
  let value = 0n
  for (const byte of cell) {
    value = (value << 8n) | BigInt(byte)
  }
  return value % FR_MODULUS
}

function visitSignedWindows(
  scalar: bigint,
  width: number,
  visit: (windowIndex: number, value: number, negative: boolean) => void,
): void {
  const mask = (1n << BigInt(width)) - 1n
  const half = 1n << BigInt(width - 1)
  const full = 1n << BigInt(width)
  let remaining = scalar
  let carry = 0n
  let windowIndex = 0

  while (remaining > 0n || carry > 0n) {
    const raw = (remaining & mask) + carry
    remaining >>= BigInt(width)
    carry = 0n
    if (raw >= half) {
      const value = Number(full - raw)
      if (value !== 0) visit(windowIndex, value, true)
      carry = 1n
    } else {
      const value = Number(raw)
      if (value !== 0) visit(windowIndex, value, false)
    }
    windowIndex += 1
  }
}

export function buildWebGpuKzgMsmBucketData(blob: Uint8Array, bucketWidth = WEBGPU_KZG_MSM_BUCKET_WIDTH): BucketData {
  if (blob.byteLength !== WEBGPU_KZG_MSM_BLOB_SIZE) {
    throw new Error('WebGPU KZG MSM currently commits one 128 KiB blob per dispatch')
  }

  const width = assertBucketWidth(bucketWidth)
  const bucketSlots = 1 << width
  const maxWindows = Math.ceil(256 / width) + 1
  const counts = new Uint32Array(maxWindows * bucketSlots)
  let maxWindow = 0
  let baseIndexCount = 0

  for (let pointIndex = 0; pointIndex < WEBGPU_KZG_MSM_CELLS_PER_BLOB; pointIndex += 1) {
    const scalar = blobCellToScalar(blob.subarray(pointIndex * 32, pointIndex * 32 + 32))
    if (scalar === 0n) continue

    visitSignedWindows(scalar, width, (windowIndex, value) => {
      maxWindow = Math.max(maxWindow, windowIndex)
      counts[windowIndex * bucketSlots + value] += 1
      baseIndexCount += 1
    })
  }

  const numWindows = maxWindow + 1
  let bucketCount = 0
  let maxBucketSize = 0
  for (let windowIndex = 0; windowIndex < numWindows; windowIndex += 1) {
    const windowOffset = windowIndex * bucketSlots
    for (let value = 1; value < bucketSlots; value += 1) {
      const count = counts[windowOffset + value]
      if (count === 0) continue
      bucketCount += 1
      maxBucketSize = Math.max(maxBucketSize, count)
    }
  }

  const baseIndices = new Uint32Array(baseIndexCount)
  const bucketPointers = new Uint32Array(bucketCount)
  const bucketSizes = new Uint32Array(bucketCount)
  const bucketValues = new Uint32Array(bucketCount)
  const windowStarts = new Uint32Array(numWindows)
  const windowCounts = new Uint32Array(numWindows)
  const entryOffsets = new Uint32Array(counts.length)
  const fillCounts = new Uint32Array(counts.length)
  let bucketIndex = 0
  let baseIndexOffset = 0

  for (let windowIndex = 0; windowIndex < numWindows; windowIndex += 1) {
    const windowOffset = windowIndex * bucketSlots
    windowStarts[windowIndex] = bucketIndex
    for (let value = 1; value < bucketSlots; value += 1) {
      const count = counts[windowOffset + value]
      if (count === 0) continue
      const offset = windowOffset + value
      entryOffsets[offset] = baseIndexOffset
      bucketPointers[bucketIndex] = baseIndexOffset
      bucketSizes[bucketIndex] = count
      bucketValues[bucketIndex] = value
      baseIndexOffset += count
      bucketIndex += 1
      windowCounts[windowIndex] += 1
    }
  }

  for (let pointIndex = 0; pointIndex < WEBGPU_KZG_MSM_CELLS_PER_BLOB; pointIndex += 1) {
    const scalar = blobCellToScalar(blob.subarray(pointIndex * 32, pointIndex * 32 + 32))
    if (scalar === 0n) continue

    visitSignedWindows(scalar, width, (windowIndex, value, negative) => {
      const offset = windowIndex * bucketSlots + value
      const writeIndex = entryOffsets[offset] + fillCounts[offset]
      baseIndices[writeIndex] = (pointIndex | (negative ? WEBGPU_KZG_MSM_SIGN_BIT : 0)) >>> 0
      fillCounts[offset] += 1
    })
  }

  return {
    baseIndices,
    bucketPointers,
    bucketSizes,
    bucketValues,
    windowStarts,
    windowCounts,
    numWindows,
    maxBucketSize,
  }
}

function createStorageBuffer(device: GPUDevice, label: string, bytes: Uint8Array | Uint32Array): GPUBuffer {
  const usage = gpuBufferUsage()
  const size = Math.max(4, Math.ceil(bytes.byteLength / 4) * 4)
  const buffer = device.createBuffer({
    label,
    size,
    usage: usage.STORAGE | usage.COPY_DST,
  })
  device.queue.writeBuffer(buffer, 0, bytes)
  return buffer
}

function alignBufferSize(size: number): number {
  return Math.max(4, Math.ceil(size / 4) * 4)
}

function growBufferCapacity(current: number, required: number): number {
  let next = Math.max(4, current)
  while (next < required) next *= 2
  return next
}

class ReusableGpuBuffer {
  private buffer: GPUBuffer | null = null
  private capacity = 0
  private resizes = 0

  constructor(
    private readonly device: GPUDevice,
    private readonly label: string,
    private readonly usage: number,
  ) {}

  get stats(): ScratchBufferStats {
    return { capacityBytes: this.capacity, resizeCount: this.resizes }
  }

  ensure(size: number): GPUBuffer {
    const required = alignBufferSize(size)
    if (this.buffer && this.capacity >= required) return this.buffer
    this.buffer?.destroy()
    this.capacity = growBufferCapacity(this.capacity, required)
    this.resizes += 1
    this.buffer = this.device.createBuffer({
      label: this.label,
      size: this.capacity,
      usage: this.usage,
    })
    return this.buffer
  }

  write(bytes: Uint8Array | Uint32Array): GPUBuffer {
    const buffer = this.ensure(bytes.byteLength)
    this.device.queue.writeBuffer(buffer, 0, bytes)
    return buffer
  }

  destroy(): void {
    this.buffer?.destroy()
    this.buffer = null
    this.capacity = 0
  }
}

class WebGpuKzgMsmScratch {
  readonly baseIndices: ReusableGpuBuffer
  readonly bucketPointers: ReusableGpuBuffer
  readonly bucketSizes: ReusableGpuBuffer
  readonly bucketValues: ReusableGpuBuffer
  readonly windowStarts: ReusableGpuBuffer
  readonly windowCounts: ReusableGpuBuffer
  readonly aggregatedBuckets: ReusableGpuBuffer
  readonly windowSums: ReusableGpuBuffer
  readonly partialWindowSums: ReusableGpuBuffer
  readonly readback: ReusableGpuBuffer
  private readonly buffers: ReusableGpuBuffer[]

  constructor(device: GPUDevice) {
    const usage = gpuBufferUsage()
    this.baseIndices = new ReusableGpuBuffer(device, 'polystore-kzg-msm-base-indices', usage.STORAGE | usage.COPY_DST)
    this.bucketPointers = new ReusableGpuBuffer(
      device,
      'polystore-kzg-msm-bucket-pointers',
      usage.STORAGE | usage.COPY_DST,
    )
    this.bucketSizes = new ReusableGpuBuffer(device, 'polystore-kzg-msm-bucket-sizes', usage.STORAGE | usage.COPY_DST)
    this.bucketValues = new ReusableGpuBuffer(device, 'polystore-kzg-msm-bucket-values', usage.STORAGE | usage.COPY_DST)
    this.windowStarts = new ReusableGpuBuffer(device, 'polystore-kzg-msm-window-starts', usage.STORAGE | usage.COPY_DST)
    this.windowCounts = new ReusableGpuBuffer(device, 'polystore-kzg-msm-window-counts', usage.STORAGE | usage.COPY_DST)
    this.aggregatedBuckets = new ReusableGpuBuffer(
      device,
      'polystore-kzg-msm-aggregated-buckets',
      usage.STORAGE | usage.COPY_SRC,
    )
    this.windowSums = new ReusableGpuBuffer(device, 'polystore-kzg-msm-window-sums', usage.STORAGE | usage.COPY_SRC)
    this.partialWindowSums = new ReusableGpuBuffer(
      device,
      'polystore-kzg-msm-partial-window-sums',
      usage.STORAGE | usage.COPY_SRC,
    )
    this.readback = new ReusableGpuBuffer(device, 'polystore-kzg-msm-readback', usage.COPY_DST | usage.MAP_READ)
    this.buffers = [
      this.baseIndices,
      this.bucketPointers,
      this.bucketSizes,
      this.bucketValues,
      this.windowStarts,
      this.windowCounts,
      this.aggregatedBuckets,
      this.windowSums,
      this.partialWindowSums,
      this.readback,
    ]
  }

  stats(): ScratchBufferStats {
    return this.buffers.reduce(
      (stats, buffer) => {
        const bufferStats = buffer.stats
        stats.capacityBytes += bufferStats.capacityBytes
        stats.resizeCount += bufferStats.resizeCount
        return stats
      },
      { capacityBytes: 0, resizeCount: 0 },
    )
  }

  destroy(): void {
    for (const buffer of this.buffers) buffer.destroy()
  }
}

function assertReductionMode(mode: WebGpuKzgMsmReductionMode): WebGpuKzgMsmReductionMode {
  if (mode === 'serial' || mode === 'parallel16' || mode === 'parallel32' || mode === 'parallel64') return mode
  throw new Error('WebGPU KZG MSM reduction mode must be serial, parallel16, parallel32, or parallel64')
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue) || numberValue < 1) return fallback
  return Math.floor(numberValue)
}

function normalizeCalibrationCandidate(candidate: WebGpuKzgMsmCalibrationCandidate): WebGpuKzgMsmCalibrationCandidate {
  return {
    bucketWidth: assertBucketWidth(candidate.bucketWidth),
    reductionMode: assertReductionMode(candidate.reductionMode),
    label: candidate.label,
  }
}

function uniqueCalibrationCandidates(
  candidates: WebGpuKzgMsmCalibrationCandidate[],
): WebGpuKzgMsmCalibrationCandidate[] {
  const seen = new Set<string>()
  const out: WebGpuKzgMsmCalibrationCandidate[] = []
  for (const candidate of candidates) {
    const normalized = normalizeCalibrationCandidate(candidate)
    const key = `${normalized.bucketWidth}:${normalized.reductionMode}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function median(values: number[]): number {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b)
  if (sorted.length === 0) return Number.POSITIVE_INFINITY
  return sorted[Math.floor((sorted.length - 1) / 2)]
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

export function makeWebGpuKzgMsmCalibrationBlobBatch(blobCount = 4): Uint8Array {
  const blobs = normalizePositiveInteger(blobCount, 4)
  const out = new Uint8Array(WEBGPU_KZG_MSM_BLOB_SIZE * blobs)
  for (let blobIndex = 0; blobIndex < blobs; blobIndex += 1) {
    const seed = 41 + blobIndex * 13
    for (let cellIndex = 0; cellIndex < WEBGPU_KZG_MSM_CELLS_PER_BLOB; cellIndex += 1) {
      const offset = blobIndex * WEBGPU_KZG_MSM_BLOB_SIZE + cellIndex * 32
      out[offset] = 0
      for (let byteIndex = 1; byteIndex < 32; byteIndex += 1) {
        out[offset + byteIndex] = (seed + cellIndex * 17 + byteIndex * 29) & 0xff
      }
    }
  }
  return out
}

async function readAdapterInfo(adapter: WebGpuAdapter): Promise<WebGpuAdapterInfo | null> {
  try {
    if (adapter.info) return adapter.info
    if (typeof adapter.requestAdapterInfo === 'function') return await adapter.requestAdapterInfo()
  } catch {
    return null
  }
  return null
}

export function createWebGpuKzgMsmAdapterCacheKey(
  info: WebGpuAdapterInfo | null,
  version = WEBGPU_KZG_MSM_CALIBRATION_VERSION,
): string {
  const normalize = (value: unknown) => String(value ?? 'unknown').trim().toLowerCase() || 'unknown'
  return [
    version,
    normalize(info?.vendor),
    normalize(info?.architecture),
    normalize(info?.device),
    normalize(info?.description),
    normalize(info?.isFallbackAdapter),
  ].join('|')
}

export function defaultWebGpuKzgMsmAdapterCalibration(
  info: WebGpuAdapterInfo | null,
  version = WEBGPU_KZG_MSM_CALIBRATION_VERSION,
): WebGpuKzgMsmAdapterCalibration {
  const vendor = info?.vendor?.toLowerCase() ?? ''
  const architecture = info?.architecture?.toLowerCase() ?? ''
  const isAppleMetal = vendor.includes('apple') || architecture.includes('metal')
  const reductionMode = isAppleMetal ? 'parallel16' : WEBGPU_KZG_MSM_REDUCTION_MODE
  return {
    version,
    cacheKey: createWebGpuKzgMsmAdapterCacheKey(info, version),
    bucketWidth: WEBGPU_KZG_MSM_BUCKET_WIDTH,
    reductionMode,
    minBlobs: 1,
    minBytes: WEBGPU_KZG_MSM_BLOB_SIZE,
    source: 'default-adapter-rule',
    reason: isAppleMetal
      ? 'Apple/Metal diagnostics favor parallel16 for the final per-window reduction'
      : 'NVIDIA/Vulkan and unknown native adapters default to the stable serial reduction',
    score: null,
    measuredFixture: null,
    measuredAtMs: null,
  }
}

function resolveDefaultCalibrationStorage(): WebGpuKzgMsmCalibrationStorage | null {
  try {
    const storage = (globalThis as unknown as { localStorage?: WebGpuKzgMsmCalibrationStorage }).localStorage
    return storage ?? null
  } catch {
    return null
  }
}

function normalizeWebGpuKzgMsmCalibration(
  info: WebGpuAdapterInfo | null,
  raw: unknown,
  version = WEBGPU_KZG_MSM_CALIBRATION_VERSION,
): WebGpuKzgMsmAdapterCalibration | null {
  const obj = raw as Partial<WebGpuKzgMsmAdapterCalibration> | null | undefined
  const expectedCacheKey = createWebGpuKzgMsmAdapterCacheKey(info, version)
  if (!obj || obj.version !== version || obj.cacheKey !== expectedCacheKey) return null
  if (obj.source !== 'default-adapter-rule' && obj.source !== 'benchmark-matrix') return null

  try {
    const bucketWidth = assertBucketWidth(Number(obj.bucketWidth))
    const reductionMode = assertReductionMode(obj.reductionMode as WebGpuKzgMsmReductionMode)
    const minBlobs = normalizePositiveInteger(obj.minBlobs, 1)
    const measuredFixture = obj.measuredFixture
      ? {
          blobs: normalizePositiveInteger(obj.measuredFixture.blobs, 1),
          bytes: normalizePositiveInteger(obj.measuredFixture.bytes, WEBGPU_KZG_MSM_BLOB_SIZE),
          runs: normalizePositiveInteger(obj.measuredFixture.runs, 1),
          candidates: normalizePositiveInteger(obj.measuredFixture.candidates, 1),
          metric: 'median-total-ms' as const,
          wasmMs: Number.isFinite(Number(obj.measuredFixture.wasmMs)) ? Number(obj.measuredFixture.wasmMs) : null,
        }
      : null
    return {
      version,
      cacheKey: expectedCacheKey,
      bucketWidth,
      reductionMode,
      minBlobs,
      minBytes: normalizePositiveInteger(obj.minBytes, minBlobs * WEBGPU_KZG_MSM_BLOB_SIZE),
      source: obj.source,
      reason: typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason : 'calibration selected',
      score: Number.isFinite(Number(obj.score)) ? Number(obj.score) : null,
      measuredFixture,
      measuredAtMs: Number.isFinite(Number(obj.measuredAtMs)) ? Number(obj.measuredAtMs) : null,
    }
  } catch {
    return null
  }
}

export class WebGpuKzgMsmCalibrationCache {
  private readonly entries = new Map<string, WebGpuKzgMsmAdapterCalibration>()
  private readonly storage: WebGpuKzgMsmCalibrationStorage | null
  private readonly version: string
  private readonly storagePrefix: string

  constructor(options: {
    storage?: WebGpuKzgMsmCalibrationStorage | null
    version?: string
    storagePrefix?: string
  } = {}) {
    this.storage = options.storage === undefined ? resolveDefaultCalibrationStorage() : options.storage
    this.version = options.version ?? WEBGPU_KZG_MSM_CALIBRATION_VERSION
    this.storagePrefix = options.storagePrefix ?? WEBGPU_KZG_MSM_CALIBRATION_STORAGE_PREFIX
  }

  get(info: WebGpuAdapterInfo | null): WebGpuKzgMsmAdapterCalibration | null {
    const cacheKey = createWebGpuKzgMsmAdapterCacheKey(info, this.version)
    const memoryEntry = normalizeWebGpuKzgMsmCalibration(info, this.entries.get(cacheKey), this.version)
    if (memoryEntry) return memoryEntry
    this.entries.delete(cacheKey)

    if (!this.storage) return null
    try {
      const raw = this.storage.getItem(`${this.storagePrefix}${cacheKey}`)
      if (!raw) return null
      const storageEntry = normalizeWebGpuKzgMsmCalibration(info, JSON.parse(raw), this.version)
      if (!storageEntry) {
        this.storage.removeItem(`${this.storagePrefix}${cacheKey}`)
        return null
      }
      this.entries.set(cacheKey, storageEntry)
      return storageEntry
    } catch {
      return null
    }
  }

  set(info: WebGpuAdapterInfo | null, calibration: WebGpuKzgMsmAdapterCalibration): void {
    const normalized = normalizeWebGpuKzgMsmCalibration(
      info,
      {
        ...calibration,
        version: this.version,
        cacheKey: createWebGpuKzgMsmAdapterCacheKey(info, this.version),
      },
      this.version,
    )
    if (!normalized) throw new Error('invalid WebGPU KZG MSM calibration result')
    this.entries.set(normalized.cacheKey, normalized)
    try {
      this.storage?.setItem(`${this.storagePrefix}${normalized.cacheKey}`, JSON.stringify(normalized))
    } catch {
      // Persistent storage is best effort; the in-memory cache remains valid for this session.
    }
  }

  invalidate(info?: WebGpuAdapterInfo | null): void {
    if (typeof info === 'undefined') {
      for (const key of this.entries.keys()) {
        try {
          this.storage?.removeItem(`${this.storagePrefix}${key}`)
        } catch {
          // best effort
        }
      }
      this.entries.clear()
      return
    }
    const cacheKey = createWebGpuKzgMsmAdapterCacheKey(info, this.version)
    this.entries.delete(cacheKey)
    try {
      this.storage?.removeItem(`${this.storagePrefix}${cacheKey}`)
    } catch {
      // best effort
    }
  }
}

export const defaultWebGpuKzgMsmCalibrationCache = new WebGpuKzgMsmCalibrationCache()

export function defaultWebGpuKzgMsmCalibrationCandidates(
  info: WebGpuAdapterInfo | null,
  fallback = defaultWebGpuKzgMsmAdapterCalibration(info),
): WebGpuKzgMsmCalibrationCandidate[] {
  const vendor = info?.vendor?.toLowerCase() ?? ''
  const architecture = info?.architecture?.toLowerCase() ?? ''
  const candidates: WebGpuKzgMsmCalibrationCandidate[] = [
    { bucketWidth: fallback.bucketWidth, reductionMode: fallback.reductionMode, label: 'adapter-default' },
  ]

  if (vendor.includes('apple') || architecture.includes('metal')) {
    candidates.push({ bucketWidth: 10, reductionMode: 'parallel16', label: 'apple-metal-parallel16' })
  } else {
    candidates.push({ bucketWidth: 12, reductionMode: 'parallel16', label: 'ampere-parallel16-bucket12' })
  }

  return uniqueCalibrationCandidates(candidates)
}

export function selectWebGpuKzgMsmAdapterCalibration(
  info: WebGpuAdapterInfo | null,
  cache: WebGpuKzgMsmCalibrationCache | null | undefined = defaultWebGpuKzgMsmCalibrationCache,
): WebGpuKzgMsmAdapterCalibration {
  return cache?.get(info) ?? defaultWebGpuKzgMsmAdapterCalibration(info)
}

export function selectWebGpuKzgMsmReductionMode(info: WebGpuAdapterInfo | null): WebGpuKzgMsmReductionMode {
  return selectWebGpuKzgMsmAdapterCalibration(info).reductionMode
}

export async function calibrateWebGpuKzgMsmAdapter(
  options: WebGpuKzgMsmCalibrationOptions,
): Promise<WebGpuKzgMsmAdapterCalibration> {
  const fallback = defaultWebGpuKzgMsmAdapterCalibration(options.adapterInfo)
  const candidates = uniqueCalibrationCandidates(options.candidates ?? defaultWebGpuKzgMsmCalibrationCandidates(options.adapterInfo, fallback))
  const blobCount = normalizePositiveInteger(options.blobCount, 4)
  const runsPerCandidate = normalizePositiveInteger(options.runsPerCandidate, 1)
  const timeoutMs = normalizePositiveInteger(options.timeoutMs, 12_000)
  const fixture = makeWebGpuKzgMsmCalibrationBlobBatch(blobCount)
  const oracleStart = nowMs()
  const oracleCommitments = await options.oracleCommitBlobs(fixture)
  const wasmMs = nowMs() - oracleStart
  const expectedBytes = blobCount * 48
  if (oracleCommitments.byteLength !== expectedBytes) {
    throw new Error(`WebGPU MSM calibration oracle returned ${oracleCommitments.byteLength} bytes, expected ${expectedBytes}`)
  }

  const scored: Array<{ candidate: WebGpuKzgMsmCalibrationCandidate; score: number }> = []
  const failures: string[] = []
  for (const candidate of candidates) {
    const scores: number[] = []
    let committer: WebGpuKzgMsmCalibrationCommitter | null = null
    try {
      committer = await options.createCommitter(candidate)
      for (let run = 0; run < runsPerCandidate; run += 1) {
        const timed = await withTimeout(committer.commitBlobs(fixture), timeoutMs)
        if (timed.timedOut) {
          failures.push(`${candidate.bucketWidth}/${candidate.reductionMode}: timeout after ${timeoutMs}ms`)
          break
        }
        if (!bytesEqual(oracleCommitments, timed.value.commitments)) {
          failures.push(`${candidate.bucketWidth}/${candidate.reductionMode}: parity mismatch`)
          scores.length = 0
          break
        }
        scores.push(timed.value.timings.totalMs)
      }
    } catch (error) {
      failures.push(
        `${candidate.bucketWidth}/${candidate.reductionMode}: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      committer?.destroy()
    }

    if (scores.length === runsPerCandidate) {
      scored.push({ candidate, score: median(scores) })
    }
  }

  scored.sort((a, b) => a.score - b.score)
  const winner = scored[0]
  if (!winner) {
    throw new Error(
      `WebGPU MSM calibration failed for ${candidates.length} candidate(s)${failures.length ? `: ${failures.join('; ')}` : ''}`,
    )
  }

  return {
    version: fallback.version,
    cacheKey: fallback.cacheKey,
    bucketWidth: winner.candidate.bucketWidth,
    reductionMode: winner.candidate.reductionMode,
    minBlobs: Math.max(1, Math.min(blobCount, fallback.minBlobs || blobCount)),
    minBytes: Math.max(WEBGPU_KZG_MSM_BLOB_SIZE, Math.min(fixture.byteLength, fallback.minBytes || fixture.byteLength)),
    source: 'benchmark-matrix',
    reason: `bounded calibration selected bucket ${winner.candidate.bucketWidth} / ${winner.candidate.reductionMode}`,
    score: winner.score,
    measuredFixture: {
      blobs: blobCount,
      bytes: fixture.byteLength,
      runs: runsPerCandidate,
      candidates: candidates.length,
      metric: 'median-total-ms',
      wasmMs,
    },
    measuredAtMs: options.now ? options.now() : Date.now(),
  }
}

function reductionWorkgroupSize(mode: WebGpuKzgMsmReductionMode): 16 | 32 | 64 {
  if (mode === 'parallel16') return 16
  if (mode === 'parallel32') return 32
  if (mode === 'parallel64') return 64
  throw new Error('serial reduction mode does not have a parallel workgroup size')
}

function buildParallelSubsumShader(workgroupSize: 16 | 32 | 64): string {
  return WEBGPU_GROTH16_MSM_G1_SUBSUM_SHADER
    .replace('const G1_SUBSUM_WG_SIZE: u32 = 64u;', `const G1_SUBSUM_WG_SIZE: u32 = ${workgroupSize}u;`)
    .replace(
      'var<workgroup> subsum_shared_g1: array<PointG1, 64>;',
      `var<workgroup> subsum_shared_g1: array<PointG1, ${workgroupSize}>;`,
    )
    .replace(
      '@compute @workgroup_size(64)\nfn subsum_phase1_g1',
      `@compute @workgroup_size(${workgroupSize})\nfn subsum_phase1_g1`,
    )
    .replace(/ {4}subsum_shared_g1\[tid\] = local_sum;[\s\S]*? {4}}\n}\n\n@group\(0\) @binding\(0\) var<storage, read> partial_sums_ph2_g1:/, `    partial_sums_g1[window_id * G1_SUBSUM_WG_SIZE + tid] = local_sum;
}

@group(0) @binding(0) var<storage, read> partial_sums_ph2_g1:`)
    .replace(/ {4}let window_id = global_id.x;\n {4}win_sums_ph2_g1\[window_id\] = partial_sums_ph2_g1\[window_id\];/, `    let window_id = global_id.x;
    var sum = G1_INFINITY;
    let start = window_id * G1_SUBSUM_WG_SIZE;
    for (var i = 0u; i < G1_SUBSUM_WG_SIZE; i = i + 1u) {
        sum = add_g1_safe(sum, partial_sums_ph2_g1[start + i]);
    }
    win_sums_ph2_g1[window_id] = store_g1(sum);`)
}

async function readIntoScratchBuffer(
  device: GPUDevice,
  readbackScratch: ReusableGpuBuffer,
  source: GPUBuffer,
  size: number,
): Promise<Uint8Array> {
  const readback = readbackScratch.ensure(size)
  const encoder = device.createCommandEncoder({ label: 'polystore-kzg-msm-readback-encoder' })
  encoder.copyBufferToBuffer(source, 0, readback, 0, size)
  device.queue.submit([encoder.finish()])
  await readback.mapAsync(gpuMapMode().READ)
  const mapped = readback.getMappedRange()
  const out = new Uint8Array(mapped.slice(0, size))
  readback.unmap()
  return out
}

export class WebGpuKzgMsmCommitter {
  private readonly srsBuffer: GPUBuffer
  private readonly scratch: WebGpuKzgMsmScratch
  private readonly aggregatePipeline: GPUComputePipeline
  private readonly montgomeryPipeline: GPUComputePipeline
  private readonly weightPipeline: GPUComputePipeline
  private readonly subsumPipeline: GPUComputePipeline
  private readonly parallelSubsumPhase1Pipeline?: GPUComputePipeline
  private readonly parallelSubsumPhase2Pipeline?: GPUComputePipeline
  private readonly aggregateLayout: GPUBindGroupLayout
  private readonly montgomeryLayout: GPUBindGroupLayout
  private readonly weightLayout: GPUBindGroupLayout
  private readonly subsumLayout: GPUBindGroupLayout
  private readonly parallelSubsumPhase1Layout?: GPUBindGroupLayout
  private readonly parallelSubsumPhase2Layout?: GPUBindGroupLayout

  constructor(
    private readonly device: GPUDevice,
    private readonly wasm: WebGpuKzgMsmWasmInterop,
    private readonly options: WebGpuKzgMsmOptions = {},
  ) {
    const reductionMode = assertReductionMode(options.reductionMode ?? WEBGPU_KZG_MSM_REDUCTION_MODE)
    const srs = wasm.webgpu_g1_srs_lagrange()
    if (srs.byteLength < WEBGPU_KZG_MSM_CELLS_PER_BLOB * WEBGPU_KZG_MSM_POINT_BYTES) {
      throw new Error('WebGPU KZG MSM SRS export is smaller than one blob domain')
    }
    this.srsBuffer = createStorageBuffer(device, 'polystore-kzg-msm-g1-srs', srs)
    this.scratch = new WebGpuKzgMsmScratch(device)

    const aggregateModule = device.createShaderModule({
      label: 'polystore-kzg-msm-g1-aggregate',
      code: WEBGPU_GROTH16_MSM_G1_AGG_SHADER,
    })
    const subsumModule = device.createShaderModule({
      label: 'polystore-kzg-msm-g1-subsum',
      code: WEBGPU_GROTH16_MSM_G1_SUBSUM_SHADER,
    })
    const parallelSubsumModule =
      reductionMode === 'serial'
        ? null
        : device.createShaderModule({
            label: `polystore-kzg-msm-g1-${reductionMode}`,
            code: buildParallelSubsumShader(reductionWorkgroupSize(reductionMode)),
          })

    const shaderStage = gpuShaderStage()
    this.montgomeryLayout = device.createBindGroupLayout({
      label: 'polystore-kzg-msm-montgomery-layout',
      entries: [{ binding: 0, visibility: shaderStage.COMPUTE, buffer: { type: 'storage' } }],
    })
    this.aggregateLayout = device.createBindGroupLayout({
      label: 'polystore-kzg-msm-aggregate-layout',
      entries: [0, 1, 2, 3, 4, 5].map((binding) => ({
        binding,
        visibility: shaderStage.COMPUTE,
        buffer: { type: binding === 0 || binding === 4 ? 'storage' : 'read-only-storage' },
      })),
    })
    this.weightLayout = device.createBindGroupLayout({
      label: 'polystore-kzg-msm-weight-layout',
      entries: [
        { binding: 0, visibility: shaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: shaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    })
    this.subsumLayout = device.createBindGroupLayout({
      label: 'polystore-kzg-msm-subsum-layout',
      entries: [
        { binding: 0, visibility: shaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: shaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: shaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: shaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: shaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    })

    this.montgomeryPipeline = device.createComputePipeline({
      label: 'polystore-kzg-msm-to-montgomery',
      layout: 'auto',
      compute: { module: aggregateModule, entryPoint: 'to_montgomery_bases_g1' },
    })
    this.montgomeryLayout = this.montgomeryPipeline.getBindGroupLayout(0)
    this.aggregatePipeline = device.createComputePipeline({
      label: 'polystore-kzg-msm-aggregate',
      layout: 'auto',
      compute: { module: aggregateModule, entryPoint: 'aggregate_buckets_g1' },
    })
    this.aggregateLayout = this.aggregatePipeline.getBindGroupLayout(0)
    this.weightPipeline = device.createComputePipeline({
      label: 'polystore-kzg-msm-weight',
      layout: 'auto',
      compute: { module: aggregateModule, entryPoint: 'weight_buckets_g1' },
    })
    this.weightLayout = this.weightPipeline.getBindGroupLayout(0)
    this.subsumPipeline = device.createComputePipeline({
      label: 'polystore-kzg-msm-subsum',
      layout: 'auto',
      compute: { module: subsumModule, entryPoint: 'subsum_accumulation_g1' },
    })
    this.subsumLayout = this.subsumPipeline.getBindGroupLayout(0)
    if (parallelSubsumModule) {
      this.parallelSubsumPhase1Pipeline = device.createComputePipeline({
        label: `polystore-kzg-msm-${reductionMode}-phase1`,
        layout: 'auto',
        compute: { module: parallelSubsumModule, entryPoint: 'subsum_phase1_g1' },
      })
      this.parallelSubsumPhase1Layout = this.parallelSubsumPhase1Pipeline.getBindGroupLayout(0)
      this.parallelSubsumPhase2Pipeline = device.createComputePipeline({
        label: `polystore-kzg-msm-${reductionMode}-phase2`,
        layout: 'auto',
        compute: { module: parallelSubsumModule, entryPoint: 'subsum_phase2_g1' },
      })
      this.parallelSubsumPhase2Layout = this.parallelSubsumPhase2Pipeline.getBindGroupLayout(0)
    }

    const montgomeryBindGroup = device.createBindGroup({
      label: 'polystore-kzg-msm-srs-montgomery-bg',
      layout: this.montgomeryLayout,
      entries: [{ binding: 0, resource: { buffer: this.srsBuffer } }],
    })
    const encoder = device.createCommandEncoder({ label: 'polystore-kzg-msm-srs-montgomery' })
    const pass = encoder.beginComputePass({ label: 'polystore-kzg-msm-srs-montgomery-pass' })
    pass.setPipeline(this.montgomeryPipeline)
    pass.setBindGroup(0, montgomeryBindGroup)
    pass.dispatchWorkgroups(Math.ceil(WEBGPU_KZG_MSM_CELLS_PER_BLOB / 64))
    pass.end()
    device.queue.submit([encoder.finish()])
  }

  destroy(): void {
    this.srsBuffer.destroy()
    this.scratch.destroy()
  }

  async getDeviceLostInfo(timeoutMs = 0): Promise<WebGpuKzgMsmDeviceLostInfo | null> {
    if (!this.device.lost) return null
    const lost = this.device.lost.then((info) => ({
      reason: info.reason ?? null,
      message: info.message ?? null,
    }))
    if (timeoutMs <= 0) return lost
    return Promise.race([
      lost,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  }

  async commitBlobs(blobsFlat: Uint8Array): Promise<WebGpuKzgMsmResult> {
    const started = nowMs()
    const blobs = assertBlobBatch(blobsFlat)
    const bucketWidth = assertBucketWidth(this.options.bucketWidth ?? WEBGPU_KZG_MSM_BUCKET_WIDTH)
    const reductionMode = assertReductionMode(this.options.reductionMode ?? WEBGPU_KZG_MSM_REDUCTION_MODE)
    const commitments = new Uint8Array(blobs * 48)
    let debug: WebGpuKzgMsmResult['debug']
    const scratchStatsAtStart = this.scratch.stats()
    const debugTotals = {
      bucketCount: 0,
      baseIndexCount: 0,
      maxBucketSize: 0,
      uploadBytes: 0,
      readbackBytes: 0,
      windowSumNonZeroBytes: 0,
      processedBlobs: 0,
      commandSubmissions: 0,
      readbackCount: 0,
    }
    const timings: WebGpuKzgMsmTimings = {
      scalarPrepMs: 0,
      bucketBuildMs: 0,
      uploadMs: 0,
      dispatchReadbackMs: 0,
      foldMs: 0,
      totalMs: 0,
    }

    for (let i = 0; i < blobs; i += 1) {
      const blob = blobsFlat.subarray(i * WEBGPU_KZG_MSM_BLOB_SIZE, (i + 1) * WEBGPU_KZG_MSM_BLOB_SIZE)
      if (blob.every((byte) => byte === 0)) {
        const emptyWindows = new Uint8Array(WEBGPU_KZG_MSM_POINT_BYTES)
        commitments.set(this.wasm.webgpu_fold_g1_window_sums(emptyWindows, bucketWidth), i * 48)
        continue
      }

      const bucketStart = nowMs()
      const bucketData = buildWebGpuKzgMsmBucketData(blob, bucketWidth)
      timings.bucketBuildMs += nowMs() - bucketStart
      debugTotals.bucketCount += bucketData.bucketValues.length
      debugTotals.baseIndexCount += bucketData.baseIndices.length
      debugTotals.maxBucketSize = Math.max(debugTotals.maxBucketSize, bucketData.maxBucketSize)
      debugTotals.processedBlobs += 1

      const uploadStart = nowMs()
      const baseIndices = this.scratch.baseIndices.write(bucketData.baseIndices)
      const bucketPointers = this.scratch.bucketPointers.write(bucketData.bucketPointers)
      const bucketSizes = this.scratch.bucketSizes.write(bucketData.bucketSizes)
      const bucketValues = this.scratch.bucketValues.write(bucketData.bucketValues)
      const windowStarts = this.scratch.windowStarts.write(bucketData.windowStarts)
      const windowCounts = this.scratch.windowCounts.write(bucketData.windowCounts)
      const aggregatedBuckets = this.scratch.aggregatedBuckets.ensure(
        Math.max(1, bucketData.bucketValues.length) * WEBGPU_KZG_MSM_POINT_BYTES,
      )
      const windowSums = this.scratch.windowSums.ensure(Math.max(1, bucketData.numWindows) * WEBGPU_KZG_MSM_POINT_BYTES)
      const partialWindowSums =
        reductionMode === 'serial'
          ? null
          : this.scratch.partialWindowSums.ensure(
              Math.max(1, bucketData.numWindows) * reductionWorkgroupSize(reductionMode) * WEBGPU_KZG_MSM_POINT_BYTES,
            )
      const uploadBytes =
        bucketData.baseIndices.byteLength +
        bucketData.bucketPointers.byteLength +
        bucketData.bucketSizes.byteLength +
        bucketData.bucketValues.byteLength +
        bucketData.windowStarts.byteLength +
        bucketData.windowCounts.byteLength
      debugTotals.uploadBytes += uploadBytes
      timings.uploadMs += nowMs() - uploadStart

      const dispatchStart = nowMs()
      this.device.pushErrorScope?.('validation')
      const aggregateBindGroup = this.device.createBindGroup({
        label: 'polystore-kzg-msm-aggregate-bg',
        layout: this.aggregateLayout,
        entries: [
          { binding: 0, resource: { buffer: this.srsBuffer } },
          { binding: 1, resource: { buffer: baseIndices } },
          { binding: 2, resource: { buffer: bucketPointers } },
          { binding: 3, resource: { buffer: bucketSizes } },
          { binding: 4, resource: { buffer: aggregatedBuckets } },
        ],
      })
      const weightBindGroup = this.device.createBindGroup({
        label: 'polystore-kzg-msm-weight-bg',
        layout: this.weightLayout,
        entries: [
          { binding: 0, resource: { buffer: aggregatedBuckets } },
          { binding: 1, resource: { buffer: bucketValues } },
        ],
      })
      const subsumBindGroup = this.device.createBindGroup({
        label: 'polystore-kzg-msm-subsum-bg',
        layout: this.subsumLayout,
        entries: [
          { binding: 0, resource: { buffer: aggregatedBuckets } },
          { binding: 2, resource: { buffer: windowStarts } },
          { binding: 3, resource: { buffer: windowCounts } },
          { binding: 4, resource: { buffer: windowSums } },
        ],
      })
      const parallelPhase1BindGroup =
        reductionMode === 'serial' || !partialWindowSums || !this.parallelSubsumPhase1Layout
          ? null
          : this.device.createBindGroup({
              label: `polystore-kzg-msm-${reductionMode}-phase1-bg`,
              layout: this.parallelSubsumPhase1Layout,
              entries: [
                { binding: 0, resource: { buffer: aggregatedBuckets } },
                { binding: 1, resource: { buffer: windowStarts } },
                { binding: 2, resource: { buffer: windowCounts } },
                { binding: 3, resource: { buffer: partialWindowSums } },
              ],
            })
      const parallelPhase2BindGroup =
        reductionMode === 'serial' || !partialWindowSums || !this.parallelSubsumPhase2Layout
          ? null
          : this.device.createBindGroup({
              label: `polystore-kzg-msm-${reductionMode}-phase2-bg`,
              layout: this.parallelSubsumPhase2Layout,
              entries: [
                { binding: 0, resource: { buffer: partialWindowSums } },
                { binding: 1, resource: { buffer: windowSums } },
              ],
            })

      const encoder = this.device.createCommandEncoder({ label: 'polystore-kzg-msm-encoder' })
      const pass = encoder.beginComputePass({ label: 'polystore-kzg-msm-pass' })
      pass.setPipeline(this.aggregatePipeline)
      pass.setBindGroup(0, aggregateBindGroup)
      pass.dispatchWorkgroups(Math.max(1, Math.ceil(bucketData.bucketValues.length / 64)))
      pass.setPipeline(this.weightPipeline)
      pass.setBindGroup(0, weightBindGroup)
      pass.dispatchWorkgroups(Math.max(1, Math.ceil(bucketData.bucketValues.length / 64)))
      if (reductionMode === 'serial') {
        pass.setPipeline(this.subsumPipeline)
        pass.setBindGroup(0, subsumBindGroup)
        pass.dispatchWorkgroups(Math.max(1, bucketData.numWindows))
      } else {
        if (
          !this.parallelSubsumPhase1Pipeline ||
          !this.parallelSubsumPhase2Pipeline ||
          !parallelPhase1BindGroup ||
          !parallelPhase2BindGroup
        ) {
          throw new Error(`WebGPU KZG MSM ${reductionMode} pipeline was not initialized`)
        }
        pass.setPipeline(this.parallelSubsumPhase1Pipeline)
        pass.setBindGroup(0, parallelPhase1BindGroup)
        pass.dispatchWorkgroups(Math.max(1, bucketData.numWindows))
        pass.setPipeline(this.parallelSubsumPhase2Pipeline)
        pass.setBindGroup(0, parallelPhase2BindGroup)
        pass.dispatchWorkgroups(Math.max(1, bucketData.numWindows))
      }
      pass.end()
      this.device.queue.submit([encoder.finish()])
      debugTotals.commandSubmissions += 1
      const validationError = await this.device.popErrorScope?.()
      if (validationError) {
        throw new Error(`WebGPU KZG MSM validation failed: ${validationError.message ?? String(validationError)}`)
      }

      const readbackBytes = Math.max(1, bucketData.numWindows) * WEBGPU_KZG_MSM_POINT_BYTES
      const windowSumBytes = await readIntoScratchBuffer(
        this.device,
        this.scratch.readback,
        windowSums,
        readbackBytes,
      )
      const scratchStatsAfter = this.scratch.stats()
      debugTotals.readbackBytes += readbackBytes
      debugTotals.readbackCount += 1
      debugTotals.windowSumNonZeroBytes += windowSumBytes.reduce((count, byte) => count + (byte === 0 ? 0 : 1), 0)
      debug = {
        bucketWidth,
        reductionMode,
        bucketCount: debugTotals.bucketCount,
        baseIndexCount: debugTotals.baseIndexCount,
        numWindows: bucketData.numWindows,
        maxBucketSize: debugTotals.maxBucketSize,
        meanBucketSize: debugTotals.bucketCount ? debugTotals.baseIndexCount / debugTotals.bucketCount : 0,
        uploadBytes: debugTotals.uploadBytes,
        readbackBytes: debugTotals.readbackBytes,
        windowSumNonZeroBytes: debugTotals.windowSumNonZeroBytes,
        processedBlobs: debugTotals.processedBlobs,
        commandSubmissions: debugTotals.commandSubmissions,
        readbackCount: debugTotals.readbackCount,
        scratchCapacityBytes: scratchStatsAfter.capacityBytes,
        scratchResizeCount: scratchStatsAfter.resizeCount - scratchStatsAtStart.resizeCount,
      }
      timings.dispatchReadbackMs += nowMs() - dispatchStart

      const foldStart = nowMs()
      const commitment = this.wasm.webgpu_fold_g1_window_sums(windowSumBytes, bucketWidth)
      timings.foldMs += nowMs() - foldStart
      commitments.set(commitment, i * 48)
    }

    timings.totalMs = nowMs() - started
    return { commitments, timings, blobs, debug }
  }
}

export async function createWebGpuKzgMsmCommitter(
  wasm: WebGpuKzgMsmWasmInterop,
  navigatorLike: WebGpuNavigator = navigator as WebGpuNavigator,
  options: WebGpuKzgMsmOptions = {},
): Promise<WebGpuKzgMsmCommitter> {
  const gpu = navigatorLike.gpu
  if (!gpu) throw new Error('navigator.gpu is unavailable')
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('WebGPU adapter request returned null')
  const adapterInfo = await readAdapterInfo(adapter)
  if (!options.allowFallbackAdapter && adapterInfo?.isFallbackAdapter) {
    throw new Error('WebGPU adapter is a fallback/software adapter')
  }
  const calibration = options.calibration ?? selectWebGpuKzgMsmAdapterCalibration(adapterInfo)
  const resolvedOptions: WebGpuKzgMsmOptions = {
    ...options,
    calibration,
    bucketWidth: options.bucketWidth ?? calibration.bucketWidth,
    reductionMode: options.reductionMode ?? calibration.reductionMode,
  }
  const device = await adapter.requestDevice()
  return new WebGpuKzgMsmCommitter(device, wasm, resolvedOptions)
}
