/* eslint-disable @typescript-eslint/no-explicit-any */import test from 'node:test'
import assert from 'node:assert/strict'
import { hashTypedData, recoverTypedDataAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { buildCreateDealTypedData, buildUpdateContentTypedData } from './eip712'

const CHAIN_ID = 31337
const TEST_PRIVKEY =
  '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1' as const
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVKEY)

// viem's typed-data helpers require domain.chainId as bigint.
function asViemTypedData<T extends { domain: { chainId: number } }>(typedData: T) {
  return {
    ...typedData,
    domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) },
  } as any
}

test('CreateDeal typed data hashes to chain digest', async () => {
  const intent = {
    creator_evm: TEST_ACCOUNT.address,
    duration_seconds: 100,
    service_hint: 'General',
    initial_escrow: '1000000',
    max_monthly_spend: '5000000',
    nonce: 1,
  }

  const typedData = buildCreateDealTypedData(intent, CHAIN_ID)
  const viemTypedData = asViemTypedData(typedData)
  const digest = hashTypedData(viemTypedData)
  assert.equal(
    digest.toLowerCase(),
    '0xc46ef9356a5d95b6981397f903a405d491df36a967183566f2903c500cc7bb60',
  )

  const signature = await TEST_ACCOUNT.signTypedData(viemTypedData)
  const recovered = await recoverTypedDataAddress({ ...viemTypedData, signature })
  assert.equal(recovered.toLowerCase(), TEST_ACCOUNT.address.toLowerCase())
})

test('UpdateContent typed data hashes to chain digest', async () => {
  const intent = {
    creator_evm: TEST_ACCOUNT.address,
    deal_id: 0,
    previous_manifest_root: '',
    cid: '0xdeadbeef',
    size_bytes: 1234,
    total_mdus: 3,
    witness_mdus: 1,
    nonce: 2,
  }

  const typedData = buildUpdateContentTypedData(intent, CHAIN_ID)
  const viemTypedData = asViemTypedData(typedData)
  const digest = hashTypedData(viemTypedData)
  assert.equal(
    digest.toLowerCase(),
    '0x6b9a79182267803871963121df6e6e6c2f921a144b20fc05fe9f0637d9aed60e',
  )

  const signature = await TEST_ACCOUNT.signTypedData(viemTypedData)
  const recovered = await recoverTypedDataAddress({ ...viemTypedData, signature })
  assert.equal(recovered.toLowerCase(), TEST_ACCOUNT.address.toLowerCase())
})
