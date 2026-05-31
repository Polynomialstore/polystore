import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDuration } from './duration'

test('formatDuration keeps sub-second timings in milliseconds', () => {
  assert.equal(formatDuration(0), '0ms')
  assert.equal(formatDuration(999.4), '999ms')
})

test('formatDuration uses compact seconds below one minute', () => {
  assert.equal(formatDuration(1_000), '1s')
  assert.equal(formatDuration(12_345), '12s')
  assert.equal(formatDuration(59_400), '59s')
  assert.equal(formatDuration(59_600), '1m')
})

test('formatDuration normalizes long waits to minutes and seconds', () => {
  assert.equal(formatDuration(61_000), '1m 1s')
  assert.equal(formatDuration(140_000), '2m 20s')
  assert.equal(formatDuration(150_000), '2m 30s')
  assert.equal(formatDuration(200_000), '3m 20s')
  assert.equal(formatDuration(120_000), '2m')
})

test('formatDuration uses hours for very long waits', () => {
  assert.equal(formatDuration(3_600_000), '1h')
  assert.equal(formatDuration(3_725_000), '1h 2m 5s')
})

test('formatDuration rejects invalid durations', () => {
  assert.equal(formatDuration(Number.NaN), '—')
  assert.equal(formatDuration(-1), '—')
})
