import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveActiveEvmAddress } from './walletAddress'

const A = '0xf00dce36817586672b47480fb48c94177a97278b'
const B = '0x1234567890123456789012345678901234567890'

test('resolveActiveEvmAddress prefers connected wallet when creator omitted', () => {
  const out = resolveActiveEvmAddress({ connectedAddress: A })
  assert.equal(out.toLowerCase(), A.toLowerCase())
})

test('resolveActiveEvmAddress accepts matching creator and connected wallet', () => {
  const out = resolveActiveEvmAddress({ connectedAddress: A, creator: A.toUpperCase() })
  assert.equal(out.toLowerCase(), A.toLowerCase())
})

test('resolveActiveEvmAddress rejects stale creator when connected wallet changed', () => {
  assert.throws(
    () => resolveActiveEvmAddress({ connectedAddress: A, creator: B }),
    /Connected wallet changed/,
  )
})

test('resolveActiveEvmAddress rejects invalid address', () => {
  assert.throws(
    () => resolveActiveEvmAddress({ connectedAddress: '', creator: 'nil1abc' }),
    /EVM address required/,
  )
})

