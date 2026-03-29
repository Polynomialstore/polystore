import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isMissingGatewayAppendStateError,
  recoverGatewayAppendState,
} from './gatewayRecovery'

test('isMissingGatewayAppendStateError matches append-missing-state signatures', () => {
  assert.equal(
    isMissingGatewayAppendStateError(
      'mode2 append failed: failed to read existing MDU #0: file does not exist',
    ),
    true,
  )
  assert.equal(
    isMissingGatewayAppendStateError('gateway upload failed: timeout'),
    false,
  )
})

test('recoverGatewayAppendState succeeds from browser cache without network bootstrap', async () => {
  let bootstrapCalls = 0
  const result = await recoverGatewayAppendState({
    rehydrateFromBrowser: async () => true,
    bootstrapFromNetwork: async () => {
      bootstrapCalls += 1
      return true
    },
  })
  assert.deepEqual(result, { ok: true, source: 'browser' })
  assert.equal(bootstrapCalls, 0)
})

test('recoverGatewayAppendState bootstraps from network when browser cache is incomplete', async () => {
  let rehydrateCalls = 0
  const result = await recoverGatewayAppendState({
    rehydrateFromBrowser: async () => {
      rehydrateCalls += 1
      return rehydrateCalls > 1
    },
    bootstrapFromNetwork: async () => true,
  })
  assert.deepEqual(result, { ok: true, source: 'network' })
  assert.equal(rehydrateCalls, 2)
})

test('recoverGatewayAppendState fails when neither browser nor network bootstrap can rehydrate', async () => {
  const result = await recoverGatewayAppendState({
    rehydrateFromBrowser: async () => false,
    bootstrapFromNetwork: async () => false,
  })
  assert.deepEqual(result, { ok: false, source: 'none' })
})
