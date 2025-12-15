import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeDealId } from './dealId'

test('normalizeDealId trims and validates', () => {
  assert.equal(normalizeDealId('1'), '1')
  assert.equal(normalizeDealId('  42 \n'), '42')
  assert.throws(() => normalizeDealId(''), /positive integer/i)
  assert.throws(() => normalizeDealId('0'), /positive integer/i)
  assert.throws(() => normalizeDealId('abc'), /positive integer/i)
  assert.throws(() => normalizeDealId('1.2'), /positive integer/i)
})

