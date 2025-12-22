import test from 'node:test'
import assert from 'node:assert/strict'

import { NILFS_RECORD_PATH_MAX_BYTES, sanitizeNilfsRecordPath } from './nilfsPath'

test('sanitizeNilfsRecordPath: takes basename and truncates to 40 bytes', () => {
  const input = `a/b/${'x'.repeat(200)}.txt`
  const out = sanitizeNilfsRecordPath(input)
  assert.equal(out.includes('/'), false)
  assert.ok(out.length <= NILFS_RECORD_PATH_MAX_BYTES)
  assert.equal(out, 'x'.repeat(40))
})

test('sanitizeNilfsRecordPath: returns fallback for empty/whitespace', () => {
  assert.equal(sanitizeNilfsRecordPath(''), 'file')
  assert.equal(sanitizeNilfsRecordPath('   '), 'file')
})
