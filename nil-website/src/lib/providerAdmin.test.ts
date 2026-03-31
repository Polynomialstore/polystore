import test from 'node:test'
import assert from 'node:assert/strict'
/* eslint-disable @typescript-eslint/no-explicit-any */
import { hashTypedData, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  buildProviderAdminRequestEnvelope,
  buildProviderAdminTypedData,
  createProviderAdminExpiry,
  createProviderAdminNonce,
} from './providerAdmin'

const CHAIN_ID = 20260211
const TEST_PRIVKEY =
  '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1' as const
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVKEY)

function asViemTypedData<T extends { domain: { chainId: number } }>(typedData: T) {
  return {
    ...typedData,
    domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) },
  } as any
}

test('provider admin helpers create bounded nonce and expiry values', () => {
  assert.equal(createProviderAdminNonce(1_700_000_000_000, 42), 1_700_000_000_042)
  assert.equal(createProviderAdminExpiry(1_700_000_000, 300), 1_700_000_300)
})

test('buildProviderAdminRequestEnvelope trims payload fields', () => {
  assert.deepEqual(
    buildProviderAdminRequestEnvelope({
      provider: ' nil1provider ',
      action: 'rotate_endpoint',
      endpoint: ' /dns4/sp.example.com/tcp/443/https ',
      nonce: 77,
      expiresAt: 88,
      signature: ' 0xdeadbeef ',
    }),
    {
      provider: 'nil1provider',
      action: 'rotate_endpoint',
      endpoint: '/dns4/sp.example.com/tcp/443/https',
      nonce: 77,
      expires_at: 88,
      signature: '0xdeadbeef',
    },
  )
})

test('buildProviderAdminTypedData signs and recovers the operator wallet', async () => {
  const typedData = buildProviderAdminTypedData({
    provider: 'nil1provider',
    action: 'rotate_endpoint',
    endpoint: '/dns4/sp.example.com/tcp/443/https',
    nonce: 55,
    expiresAt: 1_700_000_300,
    chainId: CHAIN_ID,
  })
  const viemTypedData = asViemTypedData(typedData)
  const digest = hashTypedData(viemTypedData)
  assert.equal(
    digest.toLowerCase(),
    '0x27f461c45cf75ddc1bcf10ae0f99d060e71d8ecd12af28d334d0b36b7dcb6322',
  )

  const signature = await TEST_ACCOUNT.signTypedData(viemTypedData)
  const recovered = await recoverTypedDataAddress({ ...viemTypedData, signature })
  assert.equal(recovered.toLowerCase(), TEST_ACCOUNT.address.toLowerCase())
})
