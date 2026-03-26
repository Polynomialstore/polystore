import test from 'node:test'
import assert from 'node:assert/strict'

import {
  computeSparsePayloadPlan,
  expandSparseBytes,
  makeSparseArtifact,
} from './sparseArtifacts'

test('computeSparsePayloadPlan: empty payload stays empty', () => {
  assert.deepStrictEqual(computeSparsePayloadPlan(new Uint8Array(0)), {
    fullSize: 0,
    sendSize: 0,
    sparse: false,
  })
})

test('computeSparsePayloadPlan: non-zero payload keeps full length', () => {
  assert.deepStrictEqual(computeSparsePayloadPlan(new Uint8Array([1, 2, 3])), {
    fullSize: 3,
    sendSize: 3,
    sparse: false,
  })
})

test('computeSparsePayloadPlan: exact-size dense payload fast path keeps full length', () => {
  assert.deepStrictEqual(computeSparsePayloadPlan(new Uint8Array([0, 0, 3])), {
    fullSize: 3,
    sendSize: 3,
    sparse: false,
  })
})

test('computeSparsePayloadPlan: trailing zeros become implicit', () => {
  assert.deepStrictEqual(computeSparsePayloadPlan(new Uint8Array([9, 8, 0, 0, 0])), {
    fullSize: 5,
    sendSize: 2,
    sparse: true,
  })
})

test('computeSparsePayloadPlan: all-zero non-empty payload preserves one-byte body', () => {
  assert.deepStrictEqual(computeSparsePayloadPlan(new Uint8Array([0, 0, 0, 0])), {
    fullSize: 4,
    sendSize: 1,
    sparse: true,
  })
})

test('computeSparsePayloadPlan: already-truncated payload respects declared full size', () => {
  assert.deepStrictEqual(computeSparsePayloadPlan(new Uint8Array([1, 2]), 8), {
    fullSize: 8,
    sendSize: 2,
    sparse: true,
  })
})

test('makeSparseArtifact: trims payload and preserves artifact identity', () => {
  const artifact = makeSparseArtifact({
    kind: 'shard',
    index: 12,
    slot: 3,
    bytes: new Uint8Array([7, 7, 0, 0]),
  })

  assert.strictEqual(artifact.kind, 'shard')
  assert.strictEqual(artifact.index, 12)
  assert.strictEqual(artifact.slot, 3)
  assert.strictEqual(artifact.fullSize, 4)
  assert.deepStrictEqual(artifact.bytes, new Uint8Array([7, 7]))
})

test('makeSparseArtifact: reuses exact full payload without copying', () => {
  const bytes = new Uint8Array([7, 8, 9])
  const artifact = makeSparseArtifact({
    kind: 'manifest',
    bytes,
  })

  assert.strictEqual(artifact.bytes, bytes)
})

test('makeSparseArtifact: canonicalizes all-zero sparse payloads to one zero byte', () => {
  const artifact = makeSparseArtifact({
    kind: 'manifest',
    bytes: new Uint8Array(0),
    fullSize: 128 * 1024,
  })

  assert.strictEqual(artifact.fullSize, 128 * 1024)
  assert.deepStrictEqual(artifact.bytes, new Uint8Array([0]))
})

test('makeSparseArtifact: validates bounded-size inputs', () => {
  assert.throws(
    () =>
      makeSparseArtifact({
        kind: 'mdu',
        index: 0,
        bytes: new Uint8Array([1, 2, 3]),
        fullSize: 2,
      }),
    /artifact bytes exceed fullSize/,
  )
})

test('makeSparseArtifact: validates shard identity fields', () => {
  assert.throws(
    () =>
      makeSparseArtifact({
        kind: 'shard',
        bytes: new Uint8Array([1]),
        index: 0,
      }),
    /integer slot/,
  )
})

test('expandSparseBytes: restores implicit zero tail', () => {
  const expanded = expandSparseBytes(new Uint8Array([5, 4]), 5)
  assert.deepStrictEqual(expanded, new Uint8Array([5, 4, 0, 0, 0]))
})
