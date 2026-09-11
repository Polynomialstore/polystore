import test from 'node:test'
import assert from 'node:assert/strict'

import { providerEndpointFromMultiaddrs, resolveProviderEndpointByAddress } from './providerDiscovery'

test('providerEndpointFromMultiaddrs preserves public provider urls', () => {
  const endpoint = providerEndpointFromMultiaddrs(['/dns4/sp1.polynomialstore.com/tcp/443/https'])

  assert.deepStrictEqual(endpoint, {
    baseUrl: 'https://sp1.polynomialstore.com:443',
    p2pTarget: undefined,
  })
})

test('providerEndpointFromMultiaddrs still captures p2p targets when present', () => {
  const endpoint = providerEndpointFromMultiaddrs([
    '/dns4/sp1.polynomialstore.com/tcp/443/https',
    '/dns4/provider.example/tcp/443/wss/p2p/12D3KooWJtestpeer',
  ])

  assert.deepStrictEqual(endpoint, {
    baseUrl: 'https://sp1.polynomialstore.com:443',
    p2pTarget: {
      multiaddr: '/dns4/provider.example/tcp/443/wss/p2p/12D3KooWJtestpeer',
      peerId: '12D3KooWJtestpeer',
    },
  })
})

test('resolveProviderEndpointByAddress keeps LCD discovery inside the caller deadline', async (t) => {
  const controller = new AbortController()
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = (async (input, init) => {
    assert.equal(String(input), 'https://lcd.example/polystorechain/polystorechain/v1/providers')
    assert.equal(init?.signal, controller.signal)
    return new Response(JSON.stringify({ providers: [{
      address: 'nil1provider',
      endpoints: ['/dns4/provider.example/tcp/443/https'],
    }] }), { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  assert.deepEqual(await resolveProviderEndpointByAddress('https://lcd.example', 'nil1provider', controller.signal), {
    provider: 'nil1provider',
    baseUrl: 'https://provider.example:443',
    p2pTarget: undefined,
  })
})
