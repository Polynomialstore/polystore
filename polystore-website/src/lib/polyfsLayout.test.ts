import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLOBS_PER_MDU,
  BLOB_SIZE_BYTES,
  MDU_SIZE_BYTES,
  POLYFS_FILE_RECORD_CAPACITY,
  POLYFS_ROOT_TABLE_CAPACITY,
  RAW_MDU_CAPACITY_BYTES,
  computePolyfsResolvedRange,
  computeStripeProfile,
  computeUserMduCount,
  computeWitnessLayout,
  leafIndexForSlotRow,
  packLengthAndFlags,
  rawOffsetToEncodedPosition,
  slotRowForLeafIndex,
  unpackLengthAndFlags,
} from '../domain/polyfsLayout'

test('PolyFS constants describe the current MDU #0 layout', () => {
  assert.equal(BLOB_SIZE_BYTES, 128 * 1024)
  assert.equal(BLOBS_PER_MDU, 64)
  assert.equal(MDU_SIZE_BYTES, 8 * 1024 * 1024)
  assert.equal(RAW_MDU_CAPACITY_BYTES, 8_126_464)
  assert.equal(POLYFS_ROOT_TABLE_CAPACITY, 65_536)
  assert.equal(POLYFS_FILE_RECORD_CAPACITY, 24_575)
})

test('computePolyfsResolvedRange maps raw file offsets to slab MDUs and encoded blobs', () => {
  const range = computePolyfsResolvedRange({
    witnessMdus: 2,
    startOffsetBytes: RAW_MDU_CAPACITY_BYTES - 12,
    sizeBytes: 48,
  })

  assert.ok(range)
  assert.equal(range.metaMdus, 3)
  assert.equal(range.userMduStart, 0)
  assert.equal(range.userMduEnd, 1)
  assert.equal(range.slabMduStart, 3)
  assert.equal(range.slabMduEnd, 4)
  assert.equal(range.encodedBlobStart, 63)
  assert.equal(range.encodedBlobEnd, 0)
  assert.equal(range.globalBlobStart, 3n * 64n + 63n)
  assert.equal(range.globalBlobEnd, 4n * 64n)
})

test('rawOffsetToEncodedPosition accounts for 31-byte payload scalars', () => {
  assert.deepEqual(rawOffsetToEncodedPosition(0), {
    scalarIndex: 0,
    payloadOffset: 0,
    encodedByteOffset: 1,
    encodedBlobIndex: 0,
  })

  const pos = rawOffsetToEncodedPosition(31)
  assert.equal(pos.scalarIndex, 1)
  assert.equal(pos.payloadOffset, 0)
  assert.equal(pos.encodedByteOffset, 33)
  assert.equal(pos.encodedBlobIndex, 0)

  const last = rawOffsetToEncodedPosition(RAW_MDU_CAPACITY_BYTES - 1)
  assert.equal(last.encodedBlobIndex, 63)
})

test('StripeReplica slot-major leaf ordering round-trips', () => {
  const profile = computeStripeProfile(8, 4)
  assert.deepEqual(profile, { k: 8, m: 4, n: 12, rows: 8, leafCount: 96 })

  const leaf = leafIndexForSlotRow(profile, 7, 3)
  assert.equal(leaf, 59)
  assert.deepEqual(slotRowForLeafIndex(profile, leaf), { slot: 7, row: 3 })
})

test('computeWitnessLayout budgets one 48-byte commitment per leaf', () => {
  const layout = computeWitnessLayout({ totalUserMdus: 4096, k: 8, m: 4 })
  assert.equal(layout.profile.leafCount, 96)
  assert.equal(layout.witnessBytesPerUserMdu, 96 * 48)
  assert.equal(layout.totalWitnessBytes, 4096 * 96 * 48)
  assert.equal(layout.witnessMduCount, 3)
})

test('computeUserMduCount uses raw PolyFS payload capacity', () => {
  assert.equal(computeUserMduCount(0), 0)
  assert.equal(computeUserMduCount(RAW_MDU_CAPACITY_BYTES), 1)
  assert.equal(computeUserMduCount(RAW_MDU_CAPACITY_BYTES + 1), 2)
})

test('packLengthAndFlags matches the Rust layout convention', () => {
  const packed = packLengthAndFlags(100, 0x81)
  assert.equal(packed, 0x8100_0000_0000_0064n)
  assert.deepEqual(unpackLengthAndFlags(packed), { length: 100, flags: 0x81 })
})
