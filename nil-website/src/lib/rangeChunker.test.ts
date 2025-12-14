import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planNilfsFileRangeChunks, rawMduCapacityFromMduSize, rawOffsetToEncodedBlobIndex } from './rangeChunker'

test('planNilfsFileRangeChunks splits across blob/MDU boundaries', () => {
  const mduSizeBytes = 8 * 1024 * 1024
  const blobSizeBytes = 128 * 1024
  const rawCap = rawMduCapacityFromMduSize(mduSizeBytes)
  assert.equal(rawCap > 0, true)

  const fileStartOffset = 12345
  const fileSizeBytes = 1024 * 1024
  const rangeStart = 0
  const rangeLen = 400_000

  const chunks = planNilfsFileRangeChunks({
    fileStartOffset,
    fileSizeBytes,
    rangeStart,
    rangeLen,
    mduSizeBytes,
    blobSizeBytes,
  })

  assert.equal(chunks.length > 1, true)
  const total = chunks.reduce((acc, c) => acc + c.rangeLen, 0)
  assert.equal(total, rangeLen)
  for (const c of chunks) {
    assert.equal(c.rangeLen > 0, true)
    assert.equal(c.rangeLen <= blobSizeBytes, true)
    assert.equal(c.rangeStart >= rangeStart, true)
    assert.equal(c.rangeStart + c.rangeLen <= rangeStart + rangeLen, true)

    const absStart = fileStartOffset + c.rangeStart
    const absEnd = absStart + c.rangeLen - 1
    assert.equal(Math.floor(absStart / rawCap), Math.floor(absEnd / rawCap))

    const startInMdu = absStart % rawCap
    const endInMdu = absEnd % rawCap
    const startBlob = rawOffsetToEncodedBlobIndex(startInMdu, blobSizeBytes)
    const endBlob = rawOffsetToEncodedBlobIndex(endInMdu, blobSizeBytes)
    assert.equal(startBlob, endBlob)
  }
})

