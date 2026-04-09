import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeLcdParamsResponse } from '../domain/lcd'

test('normalizeLcdParamsResponse parses retrieval params', () => {
  const payload = {
    params: {
      base_retrieval_fee: { amount: '10', denom: 'stake' },
      retrieval_price_per_blob: { amount: '2', denom: 'stake' },
      retrieval_burn_bps: '500',
    },
  }

  assert.deepEqual(normalizeLcdParamsResponse(payload), {
    base_retrieval_fee: { amount: '10', denom: 'stake' },
    retrieval_price_per_blob: { amount: '2', denom: 'stake' },
    retrieval_burn_bps: '500',
  })
})

test('normalizeLcdParamsResponse returns null for invalid payload', () => {
  assert.equal(normalizeLcdParamsResponse(null), null)
  assert.equal(normalizeLcdParamsResponse({}), null)
  assert.equal(normalizeLcdParamsResponse({ params: null }), null)
})
