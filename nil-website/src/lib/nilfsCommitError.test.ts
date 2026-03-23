import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyNilfsCommitError } from './nilfsCommitError'

test('classifyNilfsCommitError detects stale previous manifest root conflicts', () => {
  const info = classifyNilfsCommitError(new Error('execution reverted: stale previous_manifest_root: expected 0xabc'))

  assert.equal(info.staleBase, true)
  assert.match(info.message, /local NilFS base is stale/i)
})

test('classifyNilfsCommitError detects nested stale manifest errors', () => {
  const info = classifyNilfsCommitError({
    message: 'transaction failed',
    cause: { details: 'stale manifest_root (does not match on-chain deal state)' },
  })

  assert.equal(info.staleBase, true)
  assert.match(info.message, /refresh the deal state/i)
})

test('classifyNilfsCommitError preserves non-stale messages', () => {
  const info = classifyNilfsCommitError(new Error('insufficient funds for gas * price + value'))

  assert.equal(info.staleBase, false)
  assert.equal(info.message, 'insufficient funds for gas * price + value')
})
