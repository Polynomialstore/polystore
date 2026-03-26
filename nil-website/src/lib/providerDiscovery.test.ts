import test from 'node:test'
import assert from 'node:assert/strict'

import { providerEndpointFromMultiaddrs } from './providerDiscovery'

test('providerEndpointFromMultiaddrs preserves public provider urls', () => {
  const endpoint = providerEndpointFromMultiaddrs(['/dns4/sp1.nilstore.org/tcp/443/https'])

  assert.deepStrictEqual(endpoint, {
    baseUrl: 'https://sp1.nilstore.org:443',
    p2pTarget: undefined,
  })
})

test('providerEndpointFromMultiaddrs still captures p2p targets when present', () => {
  const endpoint = providerEndpointFromMultiaddrs([
    '/dns4/sp1.nilstore.org/tcp/443/https',
    '/dns4/provider.example/tcp/443/wss/p2p/12D3KooWJtestpeer',
  ])

  assert.deepStrictEqual(endpoint, {
    baseUrl: 'https://sp1.nilstore.org:443',
    p2pTarget: {
      multiaddr: '/dns4/provider.example/tcp/443/wss/p2p/12D3KooWJtestpeer',
      peerId: '12D3KooWJtestpeer',
    },
  })
})
