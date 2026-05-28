import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EXPANSION_WORKER_AUTOTUNE_VERSION,
  buildExpansionWorkerAutotuneCandidates,
  isUsableExpansionWorkerAutotuneCache,
  pickExpansionWorkerCount,
  selectExpansionWorkerCountFromSamples,
} from './expansionWorkers'

test('pickExpansionWorkerCount falls back safely for undefined and NaN hardware concurrency', () => {
  assert.equal(pickExpansionWorkerCount(undefined), 3)
  assert.equal(pickExpansionWorkerCount(Number.NaN), 3)
})

test('pickExpansionWorkerCount clamps zero or one hardware concurrency to one worker', () => {
  assert.equal(pickExpansionWorkerCount(0), 1)
  assert.equal(pickExpansionWorkerCount(1), 1)
})

test('pickExpansionWorkerCount scales by hardware concurrency thresholds', () => {
  assert.equal(pickExpansionWorkerCount(2), 1)
  assert.equal(pickExpansionWorkerCount(3), 2)
  assert.equal(pickExpansionWorkerCount(4), 3)
  assert.equal(pickExpansionWorkerCount(6), 4)
  assert.equal(pickExpansionWorkerCount(8), 5)
  assert.equal(pickExpansionWorkerCount(12), 6)
})

test('pickExpansionWorkerCount honors small total job caps', () => {
  assert.equal(pickExpansionWorkerCount(12, 1), 1)
  assert.equal(pickExpansionWorkerCount(12, 2), 2)
  assert.equal(pickExpansionWorkerCount(12, 3), 3)
  assert.equal(pickExpansionWorkerCount(12, 4), 4)
  assert.equal(pickExpansionWorkerCount(12, 5), 5)
})

test('pickExpansionWorkerCount floors fractional inputs and clamps invalid job caps', () => {
  assert.equal(pickExpansionWorkerCount(5.9, 2.9), 2)
  assert.equal(pickExpansionWorkerCount(12, 0), 1)
  assert.equal(pickExpansionWorkerCount(12, Number.NaN), 6)
})

test('buildExpansionWorkerAutotuneCandidates probes near the static worker count', () => {
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(12, 32), [5, 6, 7, 8])
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(8, 12), [4, 5, 6, 7])
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(4, 16), [2, 3, 4])
})

test('buildExpansionWorkerAutotuneCandidates skips tiny jobs and single-worker machines', () => {
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(12, 1), [1])
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(12, 3), [3])
  assert.deepEqual(buildExpansionWorkerAutotuneCandidates(2, 16), [1])
})

test('selectExpansionWorkerCountFromSamples picks the fastest allowed sample', () => {
  assert.equal(
    selectExpansionWorkerCountFromSamples(
      [
        { workerCount: 5, wallMs: 1200 },
        { workerCount: 6, wallMs: 980 },
        { workerCount: 7, wallMs: 760 },
        { workerCount: 9, wallMs: 100 },
      ],
      12,
      32,
    ),
    7,
  )
})

test('selectExpansionWorkerCountFromSamples falls back to static count when samples are invalid', () => {
  assert.equal(
    selectExpansionWorkerCountFromSamples(
      [
        { workerCount: 9, wallMs: 100 },
        { workerCount: 6, wallMs: Number.NaN },
      ],
      12,
      32,
    ),
    6,
  )
})

test('isUsableExpansionWorkerAutotuneCache validates version, hardware, and candidate bounds', () => {
  const cache = {
    version: EXPANSION_WORKER_AUTOTUNE_VERSION,
    hardwareConcurrency: 12,
    selectedWorkerCount: 7,
    measuredAtMs: 1000,
    scoreMs: 760,
  }

  assert.equal(isUsableExpansionWorkerAutotuneCache(cache, 12, 32), true)
  assert.equal(isUsableExpansionWorkerAutotuneCache({ ...cache, version: 0 }, 12, 32), false)
  assert.equal(isUsableExpansionWorkerAutotuneCache({ ...cache, hardwareConcurrency: 8 }, 12, 32), false)
  assert.equal(isUsableExpansionWorkerAutotuneCache({ ...cache, selectedWorkerCount: 9 }, 12, 32), false)
  assert.equal(isUsableExpansionWorkerAutotuneCache({ ...cache, selectedWorkerCount: 7.5 }, 12, 32), false)
  assert.equal(isUsableExpansionWorkerAutotuneCache({ ...cache, measuredAtMs: 0 }, 12, 32), false)
  assert.equal(isUsableExpansionWorkerAutotuneCache({ ...cache, scoreMs: Number.NaN }, 12, 32), false)
})
