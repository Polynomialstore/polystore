import assert from 'node:assert/strict'
import test from 'node:test'

import { KZG_BLOB_SIZE, KZG_COMMITMENT_SIZE } from '../kzgCommitBackend'
import {
  concatenateUserMduKzgBatch,
  demuxUserMduKzgCommitments,
  describeUserMduKzgExpansionShape,
  estimateUserMduKzgBatchMemoryBytes,
  planUserMduKzgBatch,
  recommendedUserMduKzgBatchCapForWebGpuAdapter,
  splitUserMduKzgBatch,
  validateHomogeneousUserMduKzgBatch,
} from './userMduKzgBatch'
import type { UserMduUncommittedExpansion } from './userMduBrowserKzg'

function expansion(sequence: number, blobs = 3, options: Partial<UserMduUncommittedExpansion> = {}): UserMduUncommittedExpansion {
  return {
    contract: 'mode2-user-mdu-uncommitted-v1',
    kind: 'payload',
    k: 2,
    m: 1,
    payloadId: `payload:${sequence}`,
    profile: true,
    sequence,
    shardsFlat: new Uint8Array(KZG_BLOB_SIZE * blobs).fill(sequence),
    shardLen: KZG_BLOB_SIZE,
    perf: { rows: blobs / 3, shards_total: 3, shard_len: KZG_BLOB_SIZE },
    ...options,
  }
}

function commitments(blobs: number): Uint8Array {
  const out = new Uint8Array(blobs * KZG_COMMITMENT_SIZE)
  for (let i = 0; i < out.length; i += 1) out[i] = (17 + i * 11) & 0xff
  return out
}

test('batch planner honors max MDU, blob, byte, and memory budgets', () => {
  const candidates = [expansion(0, 3), expansion(1, 3), expansion(2, 3), expansion(3, 3)]

  assert.deepEqual(
    planUserMduKzgBatch(candidates, { maxBatchMdus: 2, maxBatchBlobs: 99, maxBatchBytes: 99 * KZG_BLOB_SIZE }).count,
    2,
  )
  assert.equal(planUserMduKzgBatch(candidates, { maxBatchBlobs: 6 }).reason, 'max_blobs')
  assert.equal(planUserMduKzgBatch(candidates, { maxBatchBytes: 6 * KZG_BLOB_SIZE }).count, 2)
  assert.equal(
    planUserMduKzgBatch(candidates, { maxEstimatedMemoryBytes: estimateUserMduKzgBatchMemoryBytes(6 * KZG_BLOB_SIZE, 6) }).count,
    2,
  )
})

test('batch shape validation rejects incompatible RS shard layouts', () => {
  const a = expansion(0, 3)
  const b = expansion(1, 3)
  const incompatible = expansion(2, 4, { shardLen: KZG_BLOB_SIZE * 2, k: 1, m: 1 })

  assert.equal(describeUserMduKzgExpansionShape(a).blobCount, 3)
  assert.equal(validateHomogeneousUserMduKzgBatch([a, b]).shardCount, 3)
  assert.throws(() => validateHomogeneousUserMduKzgBatch([a, incompatible]), /incompatible user MDU shard shape/)
  assert.equal(planUserMduKzgBatch([a, incompatible]).reason, 'incompatible_shape')
})

test('batch concatenation and commitment demux preserve exact MDU ordering', () => {
  const a = expansion(0, 3)
  const b = expansion(1, 3)
  const flat = concatenateUserMduKzgBatch([a, b])
  assert.equal(flat.byteLength, a.shardsFlat.byteLength + b.shardsFlat.byteLength)
  assert.deepEqual(flat.subarray(0, a.shardsFlat.byteLength), a.shardsFlat)
  assert.deepEqual(flat.subarray(a.shardsFlat.byteLength), b.shardsFlat)

  const witnessFlat = commitments(6)
  const groups = demuxUserMduKzgCommitments(witnessFlat, [a, b])
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0], witnessFlat.slice(0, 3 * KZG_COMMITMENT_SIZE))
  assert.deepEqual(groups[1], witnessFlat.slice(3 * KZG_COMMITMENT_SIZE))
})

test('commitment demux rejects malformed witness lengths', () => {
  assert.throws(
    () => demuxUserMduKzgCommitments(new Uint8Array(1), [expansion(0, 3)]),
    /returned 1 witness bytes, expected 144/,
  )
})

test('fallback splitter halves oversized batches deterministically', () => {
  assert.deepEqual(splitUserMduKzgBatch(1), [1, 0])
  assert.deepEqual(splitUserMduKzgBatch(2), [1, 1])
  assert.deepEqual(splitUserMduKzgBatch(5), [3, 2])
})

test('adapter batch cap keeps Apple Metal below the measured timeout cliff', () => {
  assert.equal(
    recommendedUserMduKzgBatchCapForWebGpuAdapter({ vendor: 'Apple', architecture: 'Metal', isFallbackAdapter: false }, 4),
    3,
  )
  assert.equal(
    recommendedUserMduKzgBatchCapForWebGpuAdapter(null, 4, 'MacIntel'),
    3,
  )
  assert.equal(
    recommendedUserMduKzgBatchCapForWebGpuAdapter({ vendor: 'NVIDIA', architecture: 'Ampere', isFallbackAdapter: false }, 4, 'Linux x86_64'),
    4,
  )
})
