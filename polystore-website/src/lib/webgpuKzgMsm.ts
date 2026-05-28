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
    requestAdapter: () => Promise<null | { requestDevice: () => Promise<GPUDevice> }>
  }
}

export const WEBGPU_KZG_MSM_BUCKET_WIDTH = 13
export const WEBGPU_KZG_MSM_POINT_BYTES = 384
export const WEBGPU_KZG_MSM_SIGN_BIT = 0x80000000
export const WEBGPU_KZG_MSM_BLOB_SIZE = 128 * 1024
export const WEBGPU_KZG_MSM_CELLS_PER_BLOB = WEBGPU_KZG_MSM_BLOB_SIZE / 32
const FR_MODULUS = BigInt('0x73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001')

export type WebGpuKzgMsmWasmInterop = {
  webgpu_g1_srs_lagrange: () => Uint8Array
  webgpu_fold_g1_window_sums: (windowSums: Uint8Array, bucketWidth: number) => Uint8Array
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
    bucketCount: number
    baseIndexCount: number
    numWindows: number
    windowSumNonZeroBytes: number
  }
}

type BucketData = {
  baseIndices: Uint32Array
  bucketPointers: Uint32Array
  bucketSizes: Uint32Array
  bucketValues: Uint32Array
  windowStarts: Uint32Array
  windowCounts: Uint32Array
  numWindows: number
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

function blobCellToScalar(cell: Uint8Array): bigint {
  let value = 0n
  for (const byte of cell) {
    value = (value << 8n) | BigInt(byte)
  }
  return value % FR_MODULUS
}

function scalarToSignedWindows(scalar: bigint, width: number): Array<{ value: number; negative: boolean }> {
  const mask = (1n << BigInt(width)) - 1n
  const half = 1n << BigInt(width - 1)
  const full = 1n << BigInt(width)
  let remaining = scalar
  let carry = 0n
  const windows: Array<{ value: number; negative: boolean }> = []

  while (remaining > 0n || carry > 0n) {
    const raw = (remaining & mask) + carry
    remaining >>= BigInt(width)
    carry = 0n
    if (raw >= half) {
      windows.push({ value: Number(full - raw), negative: true })
      carry = 1n
    } else {
      windows.push({ value: Number(raw), negative: false })
    }
  }

  return windows
}

export function buildWebGpuKzgMsmBucketData(blob: Uint8Array, bucketWidth = WEBGPU_KZG_MSM_BUCKET_WIDTH): BucketData {
  if (blob.byteLength !== WEBGPU_KZG_MSM_BLOB_SIZE) {
    throw new Error('WebGPU KZG MSM currently commits one 128 KiB blob per dispatch')
  }

  const perWindow = new Map<number, Map<number, number[]>>()
  let maxWindow = 0

  for (let pointIndex = 0; pointIndex < WEBGPU_KZG_MSM_CELLS_PER_BLOB; pointIndex += 1) {
    const scalar = blobCellToScalar(blob.subarray(pointIndex * 32, pointIndex * 32 + 32))
    if (scalar === 0n) continue

    const windows = scalarToSignedWindows(scalar, bucketWidth)
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
      const { value, negative } = windows[windowIndex]
      if (value === 0) continue
      maxWindow = Math.max(maxWindow, windowIndex)
      let buckets = perWindow.get(windowIndex)
      if (!buckets) {
        buckets = new Map()
        perWindow.set(windowIndex, buckets)
      }
      const encoded = pointIndex | (negative ? WEBGPU_KZG_MSM_SIGN_BIT : 0)
      const entries = buckets.get(value)
      if (entries) entries.push(encoded >>> 0)
      else buckets.set(value, [encoded >>> 0])
    }
  }

  const numWindows = maxWindow + 1
  const baseIndices: number[] = []
  const bucketPointers: number[] = []
  const bucketSizes: number[] = []
  const bucketValues: number[] = []
  const windowStarts = new Uint32Array(numWindows)
  const windowCounts = new Uint32Array(numWindows)

  for (let windowIndex = 0; windowIndex < numWindows; windowIndex += 1) {
    const buckets = perWindow.get(windowIndex)
    windowStarts[windowIndex] = bucketValues.length
    if (!buckets) continue

    const values = [...buckets.keys()].sort((a, b) => a - b)
    windowCounts[windowIndex] = values.length
    for (const value of values) {
      const entries = buckets.get(value) ?? []
      bucketPointers.push(baseIndices.length)
      bucketSizes.push(entries.length)
      bucketValues.push(value)
      baseIndices.push(...entries)
    }
  }

  return {
    baseIndices: new Uint32Array(baseIndices),
    bucketPointers: new Uint32Array(bucketPointers),
    bucketSizes: new Uint32Array(bucketSizes),
    bucketValues: new Uint32Array(bucketValues),
    windowStarts,
    windowCounts,
    numWindows,
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

function createEmptyStorageBuffer(device: GPUDevice, label: string, size: number): GPUBuffer {
  const usage = gpuBufferUsage()
  return device.createBuffer({
    label,
    size: Math.max(4, size),
    usage: usage.STORAGE | usage.COPY_SRC,
  })
}

async function readBuffer(device: GPUDevice, source: GPUBuffer, size: number): Promise<Uint8Array> {
  const usage = gpuBufferUsage()
  const readback = device.createBuffer({
    label: 'polystore-kzg-msm-readback',
    size,
    usage: usage.COPY_DST | usage.MAP_READ,
  })
  const encoder = device.createCommandEncoder({ label: 'polystore-kzg-msm-readback-encoder' })
  encoder.copyBufferToBuffer(source, 0, readback, 0, size)
  device.queue.submit([encoder.finish()])
  await readback.mapAsync(gpuMapMode().READ)
  const mapped = readback.getMappedRange()
  const out = new Uint8Array(mapped.slice(0))
  readback.unmap()
  readback.destroy()
  return out
}

export class WebGpuKzgMsmCommitter {
  private readonly srsBuffer: GPUBuffer
  private readonly aggregatePipeline: GPUComputePipeline
  private readonly montgomeryPipeline: GPUComputePipeline
  private readonly weightPipeline: GPUComputePipeline
  private readonly subsumPipeline: GPUComputePipeline
  private readonly aggregateLayout: GPUBindGroupLayout
  private readonly montgomeryLayout: GPUBindGroupLayout
  private readonly weightLayout: GPUBindGroupLayout
  private readonly subsumLayout: GPUBindGroupLayout

  constructor(
    private readonly device: GPUDevice,
    private readonly wasm: WebGpuKzgMsmWasmInterop,
  ) {
    const srs = wasm.webgpu_g1_srs_lagrange()
    if (srs.byteLength < WEBGPU_KZG_MSM_CELLS_PER_BLOB * WEBGPU_KZG_MSM_POINT_BYTES) {
      throw new Error('WebGPU KZG MSM SRS export is smaller than one blob domain')
    }
    this.srsBuffer = createStorageBuffer(device, 'polystore-kzg-msm-g1-srs', srs)

    const aggregateModule = device.createShaderModule({
      label: 'polystore-kzg-msm-g1-aggregate',
      code: WEBGPU_GROTH16_MSM_G1_AGG_SHADER,
    })
    const subsumModule = device.createShaderModule({
      label: 'polystore-kzg-msm-g1-subsum',
      code: WEBGPU_GROTH16_MSM_G1_SUBSUM_SHADER,
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
  }

  async commitBlobs(blobsFlat: Uint8Array): Promise<WebGpuKzgMsmResult> {
    const started = nowMs()
    const blobs = assertBlobBatch(blobsFlat)
    const commitments = new Uint8Array(blobs * 48)
    let debug: WebGpuKzgMsmResult['debug']
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
        commitments.set(this.wasm.webgpu_fold_g1_window_sums(emptyWindows, WEBGPU_KZG_MSM_BUCKET_WIDTH), i * 48)
        continue
      }

      const bucketStart = nowMs()
      const bucketData = buildWebGpuKzgMsmBucketData(blob)
      timings.bucketBuildMs += nowMs() - bucketStart

      const uploadStart = nowMs()
      const baseIndices = createStorageBuffer(this.device, 'polystore-kzg-msm-base-indices', bucketData.baseIndices)
      const bucketPointers = createStorageBuffer(this.device, 'polystore-kzg-msm-bucket-pointers', bucketData.bucketPointers)
      const bucketSizes = createStorageBuffer(this.device, 'polystore-kzg-msm-bucket-sizes', bucketData.bucketSizes)
      const bucketValues = createStorageBuffer(this.device, 'polystore-kzg-msm-bucket-values', bucketData.bucketValues)
      const windowStarts = createStorageBuffer(this.device, 'polystore-kzg-msm-window-starts', bucketData.windowStarts)
      const windowCounts = createStorageBuffer(this.device, 'polystore-kzg-msm-window-counts', bucketData.windowCounts)
      const aggregatedBuckets = createEmptyStorageBuffer(
        this.device,
        'polystore-kzg-msm-aggregated-buckets',
        Math.max(1, bucketData.bucketValues.length) * WEBGPU_KZG_MSM_POINT_BYTES,
      )
      const windowSums = createEmptyStorageBuffer(
        this.device,
        'polystore-kzg-msm-window-sums',
        Math.max(1, bucketData.numWindows) * WEBGPU_KZG_MSM_POINT_BYTES,
      )
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

      const encoder = this.device.createCommandEncoder({ label: 'polystore-kzg-msm-encoder' })
      const pass = encoder.beginComputePass({ label: 'polystore-kzg-msm-pass' })
      pass.setPipeline(this.aggregatePipeline)
      pass.setBindGroup(0, aggregateBindGroup)
      pass.dispatchWorkgroups(Math.max(1, Math.ceil(bucketData.bucketValues.length / 64)))
      pass.setPipeline(this.weightPipeline)
      pass.setBindGroup(0, weightBindGroup)
      pass.dispatchWorkgroups(Math.max(1, Math.ceil(bucketData.bucketValues.length / 64)))
      pass.setPipeline(this.subsumPipeline)
      pass.setBindGroup(0, subsumBindGroup)
      pass.dispatchWorkgroups(Math.max(1, bucketData.numWindows))
      pass.end()
      this.device.queue.submit([encoder.finish()])
      const validationError = await this.device.popErrorScope?.()
      if (validationError) {
        throw new Error(`WebGPU KZG MSM validation failed: ${validationError.message ?? String(validationError)}`)
      }

      const windowSumBytes = await readBuffer(
        this.device,
        windowSums,
        Math.max(1, bucketData.numWindows) * WEBGPU_KZG_MSM_POINT_BYTES,
      )
      debug ??= {
        bucketCount: bucketData.bucketValues.length,
        baseIndexCount: bucketData.baseIndices.length,
        numWindows: bucketData.numWindows,
        windowSumNonZeroBytes: windowSumBytes.reduce((count, byte) => count + (byte === 0 ? 0 : 1), 0),
      }
      timings.dispatchReadbackMs += nowMs() - dispatchStart

      const foldStart = nowMs()
      const commitment = this.wasm.webgpu_fold_g1_window_sums(windowSumBytes, WEBGPU_KZG_MSM_BUCKET_WIDTH)
      timings.foldMs += nowMs() - foldStart
      commitments.set(commitment, i * 48)

      for (const buffer of [
        baseIndices,
        bucketPointers,
        bucketSizes,
        bucketValues,
        windowStarts,
        windowCounts,
        aggregatedBuckets,
        windowSums,
      ]) {
        buffer.destroy()
      }
    }

    timings.totalMs = nowMs() - started
    return { commitments, timings, blobs, debug }
  }
}

export async function createWebGpuKzgMsmCommitter(
  wasm: WebGpuKzgMsmWasmInterop,
  navigatorLike: WebGpuNavigator = navigator as WebGpuNavigator,
): Promise<WebGpuKzgMsmCommitter> {
  const gpu = navigatorLike.gpu
  if (!gpu) throw new Error('navigator.gpu is unavailable')
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('WebGPU adapter request returned null')
  const device = await adapter.requestDevice()
  return new WebGpuKzgMsmCommitter(device, wasm)
}
