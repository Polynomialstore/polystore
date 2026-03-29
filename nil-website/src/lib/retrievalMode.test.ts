import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatCacheSourceLabel,
  isGatewayModePreferred,
  primaryCacheIndicatorLabel,
} from './retrievalMode'

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
