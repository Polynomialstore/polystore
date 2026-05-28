export const KZG_BLOB_SIZE = 128 * 1024
export const KZG_COMMITMENT_SIZE = 48
export const KZG_CELLS_PER_BLOB = KZG_BLOB_SIZE / 32
export const POLYSTORE_TRUSTED_SETUP_SHA256 = 'd39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7'

export type KzgCommitBackendKind = 'wasm-blst' | 'webgpu-wasm-fallback'

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
  webgpu?: WebGpuKzgStatus
}

export type KzgCommitBackend = {
  readonly kind: KzgCommitBackendKind
  getStatus(): KzgCommitBackendStatus
  commitBlobs(blobsFlat: Uint8Array): Uint8Array
  commitBlobsProfiled(blobsFlat: Uint8Array): KzgCommitProfiledResult
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
  srs?: WebGpuSrsMetadata
  timings?: WebGpuKzgInitTimings
}

export type CreateKzgCommitBackendOptions = {
  preferWebGpu?: boolean
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

  commitBlobs(blobsFlat: Uint8Array): Uint8Array {
    return this.wasmFallback.commitBlobs(blobsFlat)
  }

  commitBlobsProfiled(blobsFlat: Uint8Array): KzgCommitProfiledResult {
    return this.wasmFallback.commitBlobsProfiled(blobsFlat)
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
  if (!options.preferWebGpu) {
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

    const adapterStart = nowMs(options.now)
    const adapter = await gpu.requestAdapter()
    timings.adapterMs = nowMs(options.now) - adapterStart
    if (!adapter) {
      throw new Error('WebGPU adapter request returned null')
    }

    const deviceStart = nowMs(options.now)
    const device = await adapter.requestDevice()
    timings.deviceMs = nowMs(options.now) - deviceStart

    const usage = options.bufferUsage ?? (globalThis as unknown as { GPUBufferUsage?: WebGpuBufferUsageLike }).GPUBufferUsage
    if (!usage) {
      throw new Error('GPUBufferUsage constants are unavailable')
    }

    const uploadStart = nowMs(options.now)
    const srsBuffer = device.createBuffer({
      label: 'polystore-kzg-g1-srs-compressed',
      size: parsed.g1Compressed.byteLength,
      usage: usage.STORAGE | usage.COPY_DST,
    })
    device.queue.writeBuffer(srsBuffer, 0, parsed.g1Compressed)
    timings.srsUploadMs = nowMs(options.now) - uploadStart
    timings.totalMs = nowMs(options.now) - started

    const backend = new WebGpuKzgLifecycleBackend(
      wasmFallback,
      {
        supported: true,
        available: true,
        deviceLost: false,
        fallbackActive: true,
        reason: 'WebGPU MSM is not implemented in this milestone; commitments use WASM',
        srs: {
          g1Count: parsed.g1Count,
          g2Count: parsed.g2Count,
          g1Bytes: parsed.g1Bytes,
          sha256: setupSha256,
          basis: parsed.basis,
        },
        timings,
      },
      srsBuffer,
    )

    device.lost?.then((info) => {
      backend.markDeviceLost(`WebGPU device lost${info?.reason ? `: ${info.reason}` : ''}${info?.message ? ` (${info.message})` : ''}`)
    }).catch((error) => {
      backend.markDeviceLost(`WebGPU device lost: ${error instanceof Error ? error.message : String(error)}`)
    })

    return backend
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
