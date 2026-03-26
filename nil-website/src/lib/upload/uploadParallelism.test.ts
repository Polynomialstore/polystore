import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_UPLOAD_PARALLELISM, pickUploadParallelism } from './uploadParallelism'

test('pickUploadParallelism: uses existing defaults when hardware concurrency is unavailable', () => {
  assert.deepEqual(pickUploadParallelism(undefined), DEFAULT_UPLOAD_PARALLELISM)
})

test('pickUploadParallelism: keeps modest concurrency on small machines', () => {
  assert.deepEqual(pickUploadParallelism(4), {
    direct: 3,
    stripedMetadata: 4,
    stripedShards: 4,
  })
})

test('pickUploadParallelism: raises concurrency on high-core machines', () => {
  assert.deepEqual(pickUploadParallelism(12), {
    direct: 6,
    stripedMetadata: 8,
    stripedShards: 8,
  })
})
