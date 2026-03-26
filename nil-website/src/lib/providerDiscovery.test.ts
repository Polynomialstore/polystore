import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearLocalProviderBaseProbeCache,
  localProviderBaseFor,
  preferLocalProviderBase,
} from './providerDiscovery'

test('localProviderBaseFor maps known public provider hosts to loopback daemons', () => {
  assert.equal(localProviderBaseFor('https://sp1.nilstore.org'), 'http://127.0.0.1:8091')
  assert.equal(localProviderBaseFor('https://sp2.nilstore.org:443/'), 'http://127.0.0.1:8092')
  assert.equal(localProviderBaseFor('https://sp3.nilstore.org'), 'http://127.0.0.1:8093')
  assert.equal(localProviderBaseFor('https://provider.example.com'), '')
})

test('preferLocalProviderBase falls back to public base when local daemon probe fails', async () => {
  clearLocalProviderBaseProbeCache()
  const publicBase = 'https://sp1.nilstore.org'
  const fetchCalls: string[] = []
  const fetchFn = (async (input: URL | RequestInfo) => {
    fetchCalls.push(String(input))
    throw new Error('connection refused')
  }) as typeof fetch

  const result = await preferLocalProviderBase(publicBase, fetchFn)

  assert.equal(result, publicBase)
  assert.deepStrictEqual(fetchCalls, ['http://127.0.0.1:8091/status'])
})

test('preferLocalProviderBase prefers loopback daemon after a healthy provider-daemon probe', async () => {
  clearLocalProviderBaseProbeCache()
  const publicBase = 'https://sp2.nilstore.org'
  const fetchCalls: string[] = []
  const fetchFn = (async (input: URL | RequestInfo) => {
    fetchCalls.push(String(input))
    return new Response(
      JSON.stringify({
        persona: 'provider-daemon',
        allowed_route_families: ['sp', 'sp/retrieval'],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  const first = await preferLocalProviderBase(publicBase, fetchFn)
  const second = await preferLocalProviderBase(publicBase, fetchFn)

  assert.equal(first, 'http://127.0.0.1:8092')
  assert.equal(second, 'http://127.0.0.1:8092')
  assert.deepStrictEqual(fetchCalls, ['http://127.0.0.1:8092/status'])
})
