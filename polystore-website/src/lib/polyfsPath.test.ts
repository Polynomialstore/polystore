import test from 'node:test'
import assert from 'node:assert/strict'
import { POLYFS_RECORD_PATH_MAX_BYTES, sanitizePolyfsRecordPath } from './polyfsPath'

test('retained path API rejects truncation and fallback while preserving relative UTF-8 names', () => {
  assert.equal(sanitizePolyfsRecordPath('Desktop/📸.png'), 'Desktop/📸.png')
  assert.equal(sanitizePolyfsRecordPath('x'.repeat(POLYFS_RECORD_PATH_MAX_BYTES)), 'x'.repeat(POLYFS_RECORD_PATH_MAX_BYTES))
  for (const value of ['', '   ', 'x'.repeat(233), 'a\\b', 'a\0b']) assert.throws(() => sanitizePolyfsRecordPath(value))
})
