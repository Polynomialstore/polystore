import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyWalletError } from './walletErrors'

test('classifyWalletError flags rejected wallet requests', () => {
  const out = classifyWalletError({ code: 4001, message: 'User rejected the request.' })
  assert.equal(out.reconnectSuggested, true)
  assert.equal(out.userRejected, true)
  assert.match(out.message, /Connect Wallet/i)
})

test('classifyWalletError flags unauthorized wallet access', () => {
  const out = classifyWalletError({ code: 4100, message: 'Unauthorized' })
  assert.equal(out.reconnectSuggested, true)
  assert.equal(out.userRejected, false)
  assert.match(out.message, /MetaMask/i)
})

test('classifyWalletError falls back to original message for non-wallet failures', () => {
  const out = classifyWalletError(new Error('deal expired at end_block=123'))
  assert.equal(out.reconnectSuggested, false)
  assert.equal(out.userRejected, false)
  assert.match(out.message, /expired/)
})

test('classifyWalletError normalizes MetaMask RPC backoff failures', () => {
  const out = classifyWalletError({
    code: -32002,
    message: 'RPC endpoint returned too many errors, retrying in 0.3 minutes. Consider using a different RPC endpoint.',
  })
  assert.equal(out.reconnectSuggested, false)
  assert.equal(out.userRejected, false)
  assert.match(out.message, /MetaMask could not reach the configured PolyStore RPC reliably/i)
  assert.match(out.message, /RPC URL/i)
})
