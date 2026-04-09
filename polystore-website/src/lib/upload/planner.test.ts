import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PLANNER_BLOBS_PER_MDU,
  buildUploadPlan,
  buildUploadShardItems,
  computeLeafCount,
  nonTrivialBlobsForPayload,
  weightedWorkForMdu,
} from './planner'

const RAW_MDU_CAPACITY = 8 * 1024 * 1024

test('buildUploadPlan: append planning uses existing user MDU count for start offset', () => {
  const plan = buildUploadPlan({
    fileBytes: RAW_MDU_CAPACITY + 1024,
    rawMduCapacity: RAW_MDU_CAPACITY,
    useMode2: true,
    rsK: 8,
    rsM: 4,
    existingUserMdus: 3,
    existingMaxEnd: RAW_MDU_CAPACITY + 4096,
  })

  assert.equal(plan.appendStartOffset, 3 * RAW_MDU_CAPACITY)
  assert.equal(plan.newUserMdus, 2)
  assert.equal(plan.totalUserMdus, 5)
  assert.equal(plan.totalFileBytes, 4 * RAW_MDU_CAPACITY + 1024)
  assert.deepEqual(plan.userPayloads, [
    RAW_MDU_CAPACITY,
    4096,
    0,
    RAW_MDU_CAPACITY,
    1024,
  ])
})

test('buildUploadPlan: computes witness count and total mdus for a large striped upload', () => {
  const totalUsers = 2000
  const plan = buildUploadPlan({
    fileBytes: totalUsers * RAW_MDU_CAPACITY,
    rawMduCapacity: RAW_MDU_CAPACITY,
    useMode2: true,
    rsK: 8,
    rsM: 4,
  })

  assert.equal(plan.leafCount, 96)
  assert.equal(plan.witnessBytesPerMdu, 96 * 48)
  assert.equal(plan.totalUserMdus, totalUsers)
  assert.equal(plan.witnessMduCount, 2)
  assert.equal(plan.totalMdus, 1 + 2 + totalUsers)
  assert.deepEqual(plan.witnessPayloads, [RAW_MDU_CAPACITY, 827392])
})

test('buildUploadPlan: zero-byte uploads still budget metadata and witness work', () => {
  const plan = buildUploadPlan({
    fileBytes: 0,
    rawMduCapacity: RAW_MDU_CAPACITY,
    useMode2: true,
    rsK: 8,
    rsM: 4,
  })

  assert.equal(plan.newUserMdus, 0)
  assert.equal(plan.totalUserMdus, 0)
  assert.equal(plan.witnessMduCount, 1)
  assert.deepEqual(plan.witnessPayloads, [0])
  assert.deepEqual(plan.userPayloads, [])
  assert.equal(plan.workTotal, weightedWorkForMdu(1) + weightedWorkForMdu(0))
  assert.equal(plan.blobsTotal, (1 + plan.witnessMduCount) * plan.blobsPerMdu)
})

test('nonTrivialBlobsForPayload: saturates at a full MDU worth of blobs', () => {
  assert.equal(nonTrivialBlobsForPayload(RAW_MDU_CAPACITY), PLANNER_BLOBS_PER_MDU)
})

test('weightedWorkForMdu: treats trailing trivial blobs as discounted work', () => {
  assert.equal(weightedWorkForMdu(0), 6.4)
  assert.equal(weightedWorkForMdu(1), 7.300000000000001)
  assert.equal(weightedWorkForMdu(PLANNER_BLOBS_PER_MDU), PLANNER_BLOBS_PER_MDU)
})

test('computeLeafCount: mode1 stays at 64 blobs and mode2 derives leaf count from RS params', () => {
  assert.equal(computeLeafCount(false), 64)
  assert.equal(computeLeafCount(true, 8, 4), 96)
  assert.throws(() => computeLeafCount(true, 7, 4), /rsK must divide 64/)
})

test('buildUploadShardItems: orders meta, witness, then user mdus', () => {
  assert.deepEqual(buildUploadShardItems(2, 1), [
    { id: 0, commitments: ['MDU #0'], status: 'pending' },
    { id: 1, commitments: ['Witness'], status: 'pending' },
    { id: 2, commitments: ['User Data'], status: 'pending' },
    { id: 3, commitments: ['User Data'], status: 'pending' },
  ])
})
