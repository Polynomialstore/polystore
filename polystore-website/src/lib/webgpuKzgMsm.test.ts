import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WEBGPU_KZG_MSM_BLOB_SIZE,
  WEBGPU_KZG_MSM_SIGN_BIT,
  buildWebGpuKzgMsmBucketData,
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
  const buckets = buildWebGpuKzgMsmBucketData(blobWithCell(9, 4097n))

  assert.equal(buckets.baseIndices[0], (9 | WEBGPU_KZG_MSM_SIGN_BIT) >>> 0)
  assert.equal(buckets.bucketValues[0], 4095)
  assert.equal(buckets.baseIndices[1], 9)
  assert.equal(buckets.bucketValues[1], 1)
  assert.equal(buckets.numWindows, 2)
})
