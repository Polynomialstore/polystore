import assert from 'node:assert'
import { test } from 'node:test'

import { parseStakeBalancePayload, resolveFundingStatus } from './sessionFunding'

test('a confirmed funded balance remains funded through an LCD outage', () => {
  assert.equal(resolveFundingStatus({ lcdLoaded: true, lcdAmount: '42', lcdUnavailable: true }), 'funded')
})

test('an LCD error without a confirmed balance is unavailable rather than zero', () => {
  assert.equal(resolveFundingStatus({ lcdLoaded: false, lcdAmount: null, lcdUnavailable: true }), 'unavailable')
})

test('a failed refresh does not reuse a last-known zero as a confirmed zero', () => {
  assert.equal(resolveFundingStatus({ lcdLoaded: true, lcdAmount: '0', lcdUnavailable: true }), 'unavailable')
})

test('only a successful zero LCD response confirms an unfunded wallet', () => {
  assert.equal(resolveFundingStatus({ lcdLoaded: true, lcdAmount: '0', lcdUnavailable: false }), 'unfunded')
})

test('a positive EVM balance can establish funding while LCD is pending', () => {
  assert.equal(resolveFundingStatus({ lcdLoaded: false, lcdAmount: null, lcdUnavailable: false, evmAmount: 1n }), 'funded')
})

test('an unconfirmed zero EVM balance does not replace the pending LCD result', () => {
  assert.equal(resolveFundingStatus({ lcdLoaded: false, lcdAmount: null, lcdUnavailable: false, evmAmount: 0n }), 'checking')
})

test('only a valid LCD balance payload can confirm zero', () => {
  assert.equal(parseStakeBalancePayload({ balances: [] }), '0')
  assert.equal(parseStakeBalancePayload({ balances: [{ denom: 'stake', amount: '42' }] }), '42')
  assert.throws(() => parseStakeBalancePayload({ code: 530, message: 'maintenance' }), /invalid balance response/)
  assert.throws(() => parseStakeBalancePayload({ balances: [{ denom: 'stake', amount: null }] }), /invalid balance amount/)
})
