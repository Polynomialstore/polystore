import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WEBGPU_KZG_MSM_BLOB_SIZE,
  WEBGPU_KZG_MSM_CALIBRATION_VERSION,
  WEBGPU_KZG_MSM_SIGN_BIT,
  calibrateWebGpuKzgMsmAdapter,
  buildWebGpuKzgMsmBucketData,
  createWebGpuKzgMsmAdapterCacheKey,
  defaultWebGpuKzgMsmAdapterCalibration,
  makeWebGpuKzgMsmCalibrationBlobBatch,
  selectWebGpuKzgMsmAdapterCalibration,
  selectWebGpuKzgMsmReductionMode,
  WebGpuKzgMsmCalibrationCache,
  type WebGpuKzgMsmCalibrationCandidate,
  type WebGpuKzgMsmOptions,
} from './webgpuKzgMsm'

function blobWithCell(index: number, value: bigint): Uint8Array {
  const blob = new Uint8Array(WEBGPU_KZG_MSM_BLOB_SIZE)
  let remaining = value
  for (let i = 31; i >= 0; i -= 1) {
    blob[index * 32 + i] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return blob
}

function commitmentsFor(blobs: Uint8Array, seed = 1): Uint8Array {
  const out = new Uint8Array((blobs.byteLength / WEBGPU_KZG_MSM_BLOB_SIZE) * 48)
  for (let i = 0; i < out.length; i += 1) out[i] = (seed + i) & 0xff
  return out
}

function fakeCommitter(options: {
  totalMs: number
  seed?: number
  candidate: WebGpuKzgMsmCalibrationCandidate
}) {
  return {
    destroyed: false,
    destroy() {
      this.destroyed = true
    },
    getDeviceLostInfo: async () => null,
    commitBlobs: async (input: Uint8Array) => ({
      commitments: commitmentsFor(input, options.seed ?? 1),
      timings: {
        scalarPrepMs: 0,
        bucketBuildMs: 0,
        uploadMs: 0,
        dispatchReadbackMs: options.totalMs,
        foldMs: 0,
        totalMs: options.totalMs,
      },
      blobs: input.byteLength / WEBGPU_KZG_MSM_BLOB_SIZE,
      debug: {
        bucketWidth: options.candidate.bucketWidth,
        reductionMode: options.candidate.reductionMode,
        bucketCount: 1,
        baseIndexCount: 1,
        numWindows: 1,
        maxBucketSize: 1,
        meanBucketSize: 1,
        uploadBytes: 4,
        readbackBytes: 384,
        windowSumNonZeroBytes: 1,
        processedBlobs: input.byteLength / WEBGPU_KZG_MSM_BLOB_SIZE,
        commandSubmissions: 1,
        readbackCount: 1,
        scratchCapacityBytes: 4096,
        scratchResizeCount: 0,
      },
    }),
  }
}

test('WebGPU KZG MSM bucket data skips zero scalars', () => {
  const buckets = buildWebGpuKzgMsmBucketData(new Uint8Array(WEBGPU_KZG_MSM_BLOB_SIZE))

  assert.equal(buckets.baseIndices.length, 0)
  assert.equal(buckets.bucketValues.length, 0)
  assert.equal(buckets.numWindows, 1)
})

test('WebGPU KZG MSM bucket data maps one canonical scalar to one positive bucket', () => {
  const buckets = buildWebGpuKzgMsmBucketData(blobWithCell(7, 5n))

  assert.deepEqual([...buckets.baseIndices], [7])
  assert.deepEqual([...buckets.bucketPointers], [0])
  assert.deepEqual([...buckets.bucketSizes], [1])
  assert.deepEqual([...buckets.bucketValues], [5])
  assert.deepEqual([...buckets.windowStarts], [0])
  assert.deepEqual([...buckets.windowCounts], [1])
})

test('WebGPU KZG MSM bucket data uses signed windows for high window values', () => {
  const buckets = buildWebGpuKzgMsmBucketData(blobWithCell(9, 4097n), 13)

  assert.equal(buckets.baseIndices[0], (9 | WEBGPU_KZG_MSM_SIGN_BIT) >>> 0)
  assert.equal(buckets.bucketValues[0], 4095)
  assert.equal(buckets.baseIndices[1], 9)
  assert.equal(buckets.bucketValues[1], 1)
  assert.equal(buckets.numWindows, 2)
})

test('WebGPU KZG MSM bucket data keeps buckets sorted and grouped with typed arrays', () => {
  const blob = new Uint8Array(WEBGPU_KZG_MSM_BLOB_SIZE)
  blob.set(blobWithCell(1, 3n).subarray(32, 64), 32)
  blob.set(blobWithCell(2, 1n).subarray(64, 96), 64)
  blob.set(blobWithCell(4, 3n).subarray(128, 160), 128)

  const buckets = buildWebGpuKzgMsmBucketData(blob)

  assert.deepEqual([...buckets.bucketValues], [1, 3])
  assert.deepEqual([...buckets.bucketPointers], [0, 1])
  assert.deepEqual([...buckets.bucketSizes], [1, 2])
  assert.deepEqual([...buckets.baseIndices], [2, 1, 4])
  assert.equal(buckets.maxBucketSize, 2)
})

test('WebGPU KZG MSM adapter defaults preserve measured Apple and NVIDIA modes', () => {
  const apple = { vendor: 'apple', architecture: 'metal-3', isFallbackAdapter: false }
  const nvidia = { vendor: 'nvidia', architecture: 'ampere', isFallbackAdapter: false }

  assert.equal(selectWebGpuKzgMsmReductionMode(apple), 'parallel16')
  assert.equal(defaultWebGpuKzgMsmAdapterCalibration(apple).bucketWidth, 10)
  assert.equal(selectWebGpuKzgMsmReductionMode(nvidia), 'serial')
  assert.equal(defaultWebGpuKzgMsmAdapterCalibration(nvidia).minBlobs, 1)
})

test('WebGPU KZG MSM calibration cache keys and invalidation are adapter scoped', () => {
  const cache = new WebGpuKzgMsmCalibrationCache({ storage: null })
  const nvidia = { vendor: 'nvidia', architecture: 'ampere', device: 'rtx-3060-ti', isFallbackAdapter: false }
  const apple = { vendor: 'apple', architecture: 'metal-3', device: 'm3', isFallbackAdapter: false }
  const calibration = {
    ...defaultWebGpuKzgMsmAdapterCalibration(nvidia),
    source: 'benchmark-matrix' as const,
    reason: 'test calibration',
    score: 4.2,
    measuredFixture: { blobs: 4, bytes: 4 * WEBGPU_KZG_MSM_BLOB_SIZE, runs: 1, candidates: 2, metric: 'median-total-ms' as const, wasmMs: 12 },
    measuredAtMs: 123,
  }

  cache.set(nvidia, calibration)

  assert.equal(createWebGpuKzgMsmAdapterCacheKey(nvidia), calibration.cacheKey)
  assert.deepEqual(cache.get(nvidia), calibration)
  assert.equal(cache.get(apple), null)

  cache.invalidate(nvidia)
  assert.equal(cache.get(nvidia), null)

  cache.set(nvidia, calibration)
  cache.invalidate()
  assert.equal(cache.get(nvidia), null)
})

test('WebGPU KZG MSM calibration cache rejects stale schema versions', () => {
  const storage = new Map<string, string>()
  const cache = new WebGpuKzgMsmCalibrationCache({
    storage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
  })
  const nvidia = { vendor: 'nvidia', architecture: 'ampere', device: 'rtx-3060-ti', isFallbackAdapter: false }
  const stale = {
    ...defaultWebGpuKzgMsmAdapterCalibration(nvidia, 'old-version'),
    source: 'benchmark-matrix' as const,
  }
  storage.set(`polystore:kzg:webgpu-msm-calibration:${createWebGpuKzgMsmAdapterCacheKey(nvidia)}`, JSON.stringify(stale))

  assert.equal(cache.get(nvidia), null)
})

test('WebGPU KZG MSM selects cached calibration over adapter defaults', () => {
  const nvidia = { vendor: 'nvidia', architecture: 'ampere', device: 'rtx-3060-ti', isFallbackAdapter: false }
  const cache = new WebGpuKzgMsmCalibrationCache({ storage: null })
  cache.set(nvidia, {
    ...defaultWebGpuKzgMsmAdapterCalibration(nvidia),
    bucketWidth: 12,
    reductionMode: 'parallel16',
    source: 'benchmark-matrix',
    reason: 'local bench winner',
    score: 4.58,
    measuredFixture: { blobs: 96, bytes: 96 * WEBGPU_KZG_MSM_BLOB_SIZE, runs: 1, candidates: 2, metric: 'median-total-ms', wasmMs: 28.3 },
    measuredAtMs: 456,
  })

  const selected = selectWebGpuKzgMsmAdapterCalibration(nvidia, cache)
  assert.equal(selected.bucketWidth, 12)
  assert.equal(selected.reductionMode, 'parallel16')
  assert.equal(selected.source, 'benchmark-matrix')
  assert.equal(selectWebGpuKzgMsmAdapterCalibration(nvidia, null).bucketWidth, 10)
})

test('WebGPU KZG MSM bounded calibration chooses fastest parity-valid candidate', async () => {
  const nvidia = { vendor: 'nvidia', architecture: 'ampere', device: 'rtx-3060-ti', isFallbackAdapter: false }
  const candidates: WebGpuKzgMsmCalibrationCandidate[] = [
    { bucketWidth: 10, reductionMode: 'serial' },
    { bucketWidth: 12, reductionMode: 'parallel16' },
  ]
  const seen: WebGpuKzgMsmOptions[] = []
  const calibration = await calibrateWebGpuKzgMsmAdapter({
    adapterInfo: nvidia,
    candidates,
    blobCount: 2,
    timeoutMs: 1000,
    oracleCommitBlobs: (input) => commitmentsFor(input),
    createCommitter: async (candidate) => {
      seen.push({ bucketWidth: candidate.bucketWidth, reductionMode: candidate.reductionMode })
      return fakeCommitter({ candidate, totalMs: candidate.bucketWidth === 12 ? 5 : 20 })
    },
    now: () => 999,
  })

  assert.equal(calibration.version, WEBGPU_KZG_MSM_CALIBRATION_VERSION)
  assert.equal(calibration.bucketWidth, 12)
  assert.equal(calibration.reductionMode, 'parallel16')
  assert.equal(calibration.source, 'benchmark-matrix')
  assert.equal(calibration.score, 5)
  assert.equal(calibration.measuredFixture?.blobs, 2)
  assert.equal(seen.length, 2)
})

test('WebGPU KZG MSM bounded calibration fails closed when all candidates fail parity', async () => {
  const fixture = makeWebGpuKzgMsmCalibrationBlobBatch(1)
  await assert.rejects(
    calibrateWebGpuKzgMsmAdapter({
      adapterInfo: { vendor: 'nvidia', architecture: 'ampere', isFallbackAdapter: false },
      candidates: [{ bucketWidth: 12, reductionMode: 'parallel16' }],
      blobCount: 1,
      oracleCommitBlobs: () => commitmentsFor(fixture, 1),
      createCommitter: async (candidate) => fakeCommitter({ candidate, totalMs: 5, seed: 99 }),
    }),
    /parity mismatch/,
  )
})
