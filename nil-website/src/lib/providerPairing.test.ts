/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchPendingProviderPairing,
  fetchProviderPairing,
  fetchProvidersByOperator,
  fetchProvidersByWallet,
  operatorAddressFromWalletAddress,
} from './providerPairing'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('operatorAddressFromWalletAddress converts wallet address into nil bech32', () => {
  assert.equal(
    operatorAddressFromWalletAddress('0x0000000000000000000000000000000000000001'),
    'nil1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3x4xu4',
  )
  assert.equal(operatorAddressFromWalletAddress(''), null)
})

test('fetchProviderPairing loads a provider pairing from LCD', async () => {
  const seen: string[] = []
  const fetchFn = async (input: unknown) => {
    const url = String(input)
    seen.push(url)
    return jsonResponse(200, {
      pairing: {
        provider: 'nil1provider',
        operator: 'nil1operator',
        pairing_id: 'pair-123',
        paired_height: '42',
      },
    })
  }

  const pairing = await fetchProviderPairing('nil1provider', {
    lcdBase: 'http://lcd.test',
    fetchFn: fetchFn as any,
  })

  assert.deepEqual(seen, ['http://lcd.test/nilchain/nilchain/v1/provider-pairings/nil1provider'])
  assert.deepEqual(pairing, {
    provider: 'nil1provider',
    operator: 'nil1operator',
    pairing_id: 'pair-123',
    paired_height: '42',
  })
})

test('fetchProvidersByWallet resolves the operator address and lists paired providers', async () => {
  const seen: string[] = []
  const fetchFn = async (input: unknown) => {
    const url = String(input)
    seen.push(url)
    return jsonResponse(200, {
      pairings: [
        {
          provider: 'nil1providera',
          operator: 'nil1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3x4xu4',
          pairing_id: 'pair-a',
          paired_height: '10',
        },
        {
          provider: 'nil1providerb',
          operator: 'nil1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3x4xu4',
          pairing_id: 'pair-b',
          paired_height: 11,
        },
      ],
    })
  }

  const pairings = await fetchProvidersByWallet('0x0000000000000000000000000000000000000001', {
    lcdBase: 'http://lcd.test',
    fetchFn: fetchFn as any,
  })

  assert.deepEqual(seen, [
    'http://lcd.test/nilchain/nilchain/v1/provider-pairings/by-operator/nil1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqp3x4xu4',
  ])
  assert.equal(pairings.length, 2)
  assert.equal(pairings[1]?.paired_height, '11')
})

test('fetchProvidersByOperator returns an empty list for blank operator input', async () => {
  let called = false
  const pairings = await fetchProvidersByOperator('   ', {
    lcdBase: 'http://lcd.test',
    fetchFn: (async () => {
      called = true
      return jsonResponse(200, { pairings: [] })
    }) as any,
  })
  assert.deepEqual(pairings, [])
  assert.equal(called, false)
})

test('fetchPendingProviderPairing returns null when pairing is missing', async () => {
  const fetchFn = async () => jsonResponse(404, { message: 'not found' })

  const pairing = await fetchPendingProviderPairing('pair-missing', {
    lcdBase: 'http://lcd.test',
    fetchFn: fetchFn as any,
  })

  assert.equal(pairing, null)
})
