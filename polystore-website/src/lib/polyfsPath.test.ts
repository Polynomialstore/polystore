import test from 'node:test'
import assert from 'node:assert/strict'

import { POLYFS_RECORD_PATH_MAX_BYTES, sanitizePolyfsRecordPath } from './polyfsPath'

test('sanitizePolyfsRecordPath: takes basename and truncates to max bytes', () => {
  const input = `a/b/${'x'.repeat(400)}.txt`
  const out = sanitizePolyfsRecordPath(input)
  const bytes = new TextEncoder().encode(out)
  assert.equal(out.includes('/'), false)
  assert.ok(bytes.length <= POLYFS_RECORD_PATH_MAX_BYTES)
  assert.equal(out, 'x'.repeat(POLYFS_RECORD_PATH_MAX_BYTES))
})

test('sanitizePolyfsRecordPath: returns fallback for empty/whitespace', () => {
  assert.equal(sanitizePolyfsRecordPath(''), 'file')
  assert.equal(sanitizePolyfsRecordPath('   '), 'file')
})

test('sanitizePolyfsRecordPath: truncates multibyte names by UTF-8 byte length', () => {
  const input = `Desktop/${'📸'.repeat(20)}.png`
  const out = sanitizePolyfsRecordPath(input)
  const bytes = new TextEncoder().encode(out)
  assert.equal(out.includes('/'), false)
  assert.ok(bytes.length <= POLYFS_RECORD_PATH_MAX_BYTES)
  assert.ok(out.length > 0)
})
