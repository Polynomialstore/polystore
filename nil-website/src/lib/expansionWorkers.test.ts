import test from 'node:test'
import assert from 'node:assert/strict'

import { pickExpansionWorkerCount } from './expansionWorkers'

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
