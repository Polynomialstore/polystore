import test from 'node:test'
import assert from 'node:assert/strict'

import { multiaddrToHttpUrl, multiaddrToP2pTarget } from './multiaddr'

test('multiaddrToHttpUrl parses http multiaddr', () => {
  const url = multiaddrToHttpUrl('/ip4/127.0.0.1/tcp/8082/http')
  assert.equal(url, 'http://127.0.0.1:8082')
})

test('multiaddrToP2pTarget parses ws multiaddr', () => {
  const target = multiaddrToP2pTarget('/ip4/127.0.0.1/tcp/9090/ws/p2p/12D3KooWExample')
  assert.ok(target)
  assert.equal(target?.peerId, '12D3KooWExample')
})

test('multiaddrToP2pTarget rejects missing p2p segment', () => {
  const target = multiaddrToP2pTarget('/ip4/127.0.0.1/tcp/9090/ws')
  assert.equal(target, null)
})

test('multiaddrToP2pTarget rejects non-ws transports', () => {
  const target = multiaddrToP2pTarget('/ip4/127.0.0.1/tcp/9090/p2p/12D3KooWExample')
  assert.equal(target, null)
})
