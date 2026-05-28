import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WEBGPU_KZG_MSM_BLOB_SIZE,
  WEBGPU_KZG_MSM_SIGN_BIT,
  buildWebGpuKzgMsmBucketData,
  createWebGpuKzgMsmAdapterCacheKey,
  defaultWebGpuKzgMsmAdapterCalibration,
  selectWebGpuKzgMsmReductionMode,
  WebGpuKzgMsmCalibrationCache,
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
  const cache = new WebGpuKzgMsmCalibrationCache()
  const nvidia = { vendor: 'nvidia', architecture: 'ampere', device: 'rtx-3060-ti', isFallbackAdapter: false }
  const apple = { vendor: 'apple', architecture: 'metal-3', device: 'm3', isFallbackAdapter: false }
  const calibration = {
    ...defaultWebGpuKzgMsmAdapterCalibration(nvidia),
    source: 'benchmark-matrix' as const,
    reason: 'test calibration',
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
