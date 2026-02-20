import test from 'node:test'
import assert from 'node:assert/strict'

import { allowNonGatewayBackends, isTrustedLocalGatewayBase, resolveTransportPreference } from './mode'

test('resolveTransportPreference maps auto+connected to prefer_gateway', () => {
  const resolved = resolveTransportPreference({
    candidate: 'auto',
    gatewayDisabled: false,
    p2pEnabled: true,
    localGatewayConnected: true,
  })
  assert.equal(resolved, 'prefer_gateway')
})

test('resolveTransportPreference falls back to direct_sp when gateway is not connected', () => {
  const resolved = resolveTransportPreference({
    candidate: 'auto',
    gatewayDisabled: false,
    p2pEnabled: true,
    localGatewayConnected: false,
  })
  assert.equal(resolved, 'prefer_direct_sp')
})

test('resolveTransportPreference downgrades prefer_gateway when gateway is not connected', () => {
  const resolved = resolveTransportPreference({
    candidate: 'prefer_gateway',
    gatewayDisabled: false,
    p2pEnabled: true,
    localGatewayConnected: false,
  })
  assert.equal(resolved, 'prefer_direct_sp')
})

test('resolveTransportPreference forces direct_sp when gateway is disabled', () => {
  const resolved = resolveTransportPreference({
    candidate: 'prefer_gateway',
    gatewayDisabled: true,
    p2pEnabled: false,
    localGatewayConnected: true,
  })
  assert.equal(resolved, 'prefer_direct_sp')
})

test('resolveTransportPreference keeps prefer_p2p only when enabled', () => {
  const keep = resolveTransportPreference({
    candidate: 'prefer_p2p',
    gatewayDisabled: false,
    p2pEnabled: true,
    localGatewayConnected: false,
  })
  assert.equal(keep, 'prefer_p2p')

  const downgrade = resolveTransportPreference({
    candidate: 'prefer_p2p',
    gatewayDisabled: false,
    p2pEnabled: false,
    localGatewayConnected: false,
  })
  assert.equal(downgrade, 'prefer_direct_sp')
})

test('allowNonGatewayBackends keeps fallback candidates for all preferences', () => {
  assert.equal(allowNonGatewayBackends('prefer_gateway'), true)
  assert.equal(allowNonGatewayBackends('auto'), true)
  assert.equal(allowNonGatewayBackends('prefer_direct_sp'), true)
  assert.equal(allowNonGatewayBackends('prefer_p2p'), true)
})

test('isTrustedLocalGatewayBase only allows loopback :8080', () => {
  assert.equal(isTrustedLocalGatewayBase('http://localhost:8080'), true)
  assert.equal(isTrustedLocalGatewayBase('http://127.0.0.1:8080'), true)
  assert.equal(isTrustedLocalGatewayBase('https://localhost:8080'), true)

  assert.equal(isTrustedLocalGatewayBase('http://localhost:8081'), false)
  assert.equal(isTrustedLocalGatewayBase('http://127.0.0.1:8091'), false)
  assert.equal(isTrustedLocalGatewayBase('http://nilstore.org:8080'), false)
  assert.equal(isTrustedLocalGatewayBase('not-a-url'), false)
})
