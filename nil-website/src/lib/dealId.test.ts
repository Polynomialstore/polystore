import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeDealId } from './dealId'

test('normalizeDealId trims and validates', () => {
  assert.equal(normalizeDealId('1'), '1')
  assert.equal(normalizeDealId('0'), '0')
  assert.equal(normalizeDealId('  42 '), '42')
  
  assert.throws(() => normalizeDealId(''), /non-negative integer/i)
  assert.throws(() => normalizeDealId('abc'), /non-negative integer/i)
  assert.throws(() => normalizeDealId('1.2'), /non-negative integer/i)
})