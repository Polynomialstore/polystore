import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatCacheSourceLabel,
  isGatewayModePreferred,
  LOCAL_GATEWAY_CONNECTED_BASE_KEY,
  LOCAL_GATEWAY_CONNECTED_KEY,
  persistLocalGatewayConnection,
  persistLocalGatewayLiveness,
  primaryCacheIndicatorLabel,
  readLocalGatewayConnectedBase,
  readLocalGatewayConnectedHint,
} from './retrievalMode'

test('connected gateway persistence binds the attestation to its trusted probed base', () => {
  const values = new Map<string, string>()
  let observeLivenessPublication = false
  let baseAtLivenessPublication: string | undefined
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
      if (observeLivenessPublication && key === LOCAL_GATEWAY_CONNECTED_KEY && value === '1') {
        baseAtLivenessPublication = readLocalGatewayConnectedBase()
      }
    },
    removeItem: (key: string) => { values.delete(key) },
  } } })
  try {
    persistLocalGatewayConnection('http://127.0.0.1:8080/')
    assert.equal(readLocalGatewayConnectedBase(), 'http://127.0.0.1:8080')
    values.set(LOCAL_GATEWAY_CONNECTED_BASE_KEY, 'http://127.0.0.1:18081')
    assert.equal(readLocalGatewayConnectedBase(), undefined)
    persistLocalGatewayConnection()
    assert.equal(values.get(LOCAL_GATEWAY_CONNECTED_KEY), '0')
    assert.equal(values.has(LOCAL_GATEWAY_CONNECTED_BASE_KEY), false)
    persistLocalGatewayConnection('http://127.0.0.1:8080')
    observeLivenessPublication = true
    persistLocalGatewayLiveness()
    assert.equal(baseAtLivenessPublication, undefined)
    assert.equal(readLocalGatewayConnectedHint(), true)
    assert.equal(readLocalGatewayConnectedBase(), undefined)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else delete (globalThis as { window?: unknown }).window
  }
})

test('isGatewayModePreferred requires trusted local gateway and connected auto mode', () => {
  assert.equal(
    isGatewayModePreferred({
      preference: 'auto',
      gatewayBase: 'http://127.0.0.1:8080',
      localGatewayConnected: true,
    }),
    true,
  )
  assert.equal(
    isGatewayModePreferred({
      preference: 'auto',
      gatewayBase: 'http://127.0.0.1:8080',
      localGatewayConnected: false,
    }),
    false,
  )
  assert.equal(
    isGatewayModePreferred({
      preference: 'auto',
      gatewayBase: 'http://127.0.0.1:8090',
      localGatewayConnected: true,
    }),
    false,
  )
})

test('isGatewayModePreferred treats gateway_only as gateway mode', () => {
  assert.equal(
    isGatewayModePreferred({
      preference: 'gateway_only',
      gatewayBase: 'http://localhost:8080',
      localGatewayConnected: false,
    }),
    true,
  )
})

test('formatCacheSourceLabel maps known sources to explicit labels', () => {
  assert.equal(formatCacheSourceLabel('gateway_mdu_cache'), 'gateway mdu cache')
  assert.equal(formatCacheSourceLabel('browser_cached_file'), 'browser file cache')
  assert.equal(formatCacheSourceLabel('network_fetch_p2p'), 'libp2p network fetch')
  assert.equal(formatCacheSourceLabel('custom_source'), 'custom source')
})

test('primaryCacheIndicatorLabel avoids browser primary in gateway mode', () => {
  assert.equal(
    primaryCacheIndicatorLabel({
      gatewayModePreferred: true,
      browserAvailable: true,
      gatewayCached: true,
    }),
    'Gateway',
  )
  assert.equal(
    primaryCacheIndicatorLabel({
      gatewayModePreferred: true,
      browserAvailable: true,
      gatewayCached: false,
    }),
    'Browser fallback',
  )
  assert.equal(
    primaryCacheIndicatorLabel({
      gatewayModePreferred: false,
      browserAvailable: true,
      gatewayCached: true,
    }),
    'Browser',
  )
})
