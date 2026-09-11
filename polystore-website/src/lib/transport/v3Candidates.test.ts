import assert from 'node:assert/strict'
import test from 'node:test'
import { executeWithFallback } from './router'
import { v3RetrievalCandidates } from './v3Candidates'

test('v3 candidates keep gateway_only on the trusted gateway', async () => {
  const calls: string[] = []
  const candidates = v3RetrievalCandidates('gateway_only', 'http://127.0.0.1:8080/', ['https://provider.test'],
    async (base) => { calls.push(base); return base })
  const result = await executeWithFallback('fetch', candidates, { preference: 'gateway_only' })
  assert.equal(result.backend, 'gateway')
  assert.deepEqual(calls, ['http://127.0.0.1:8080'])
})

test('v3 candidates fall back from gateway failure to the provider', async () => {
  const calls: string[] = []
  const candidates = v3RetrievalCandidates('prefer_gateway', 'http://127.0.0.1:8080', ['https://provider.test'],
    async (base) => { calls.push(base); if (base.includes('127.0.0.1')) throw new TypeError('Failed to fetch'); return base })
  const result = await executeWithFallback('fetch', candidates, { preference: 'prefer_gateway' })
  assert.equal(result.backend, 'direct_sp')
  assert.deepEqual(calls, ['http://127.0.0.1:8080', 'https://provider.test'])
})
