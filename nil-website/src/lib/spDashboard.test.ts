import test from 'node:test'
import assert from 'node:assert/strict'

import { extractProviderHttpBases, isLikelyLocalHttpBase, isLocalDemoProvider, normalizeHttpBase } from './spDashboard'

test('normalizeHttpBase returns normalized http URL for raw http endpoint', () => {
  assert.equal(normalizeHttpBase('http://localhost:8091/'), 'http://localhost:8091')
  assert.equal(normalizeHttpBase('https://example.com/api/'), 'https://example.com/api')
})

test('normalizeHttpBase derives URL from http multiaddr', () => {
  assert.equal(normalizeHttpBase('/ip4/127.0.0.1/tcp/8091/http'), 'http://127.0.0.1:8091')
})

test('extractProviderHttpBases dedupes and preserves order', () => {
  const bases = extractProviderHttpBases(['http://localhost:1/', 'http://localhost:1', '/ip4/127.0.0.1/tcp/2/http'])
  assert.deepEqual(bases, ['http://localhost:1', 'http://127.0.0.1:2'])
})

test('isLikelyLocalHttpBase detects localhost and 127.0.0.1', () => {
  assert.equal(isLikelyLocalHttpBase('http://localhost:8091'), true)
  assert.equal(isLikelyLocalHttpBase('http://127.0.0.1:8091'), true)
  assert.equal(isLikelyLocalHttpBase('https://sp.nilstore.org'), false)
})

test('isLocalDemoProvider returns true when provider endpoint is local', () => {
  assert.equal(
    isLocalDemoProvider({ address: 'nil1x', endpoints: ['/ip4/127.0.0.1/tcp/8091/http'] }),
    true,
  )
  assert.equal(
    isLocalDemoProvider({ address: 'nil1x', endpoints: ['https://sp.nilstore.org'] }),
    false,
  )
})

