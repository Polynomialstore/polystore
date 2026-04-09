import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOperatorProviderRecords,
  buildProviderRegisterCommand,
  findOperatorProviderRecord,
} from './providerConsole'

test('buildOperatorProviderRecords merges pairings with provider registry data and sorts newest first', () => {
  const records = buildOperatorProviderRecords(
    [
      { provider: 'nil1older', operator: 'nil1op', paired_height: '10' },
      { provider: 'nil1newer', operator: 'nil1op', paired_height: '25' },
    ],
    [
      { address: 'nil1newer', status: 'active', endpoints: ['/dns4/sp.example.com/tcp/443/https'] },
    ],
  )

  assert.equal(records[0]?.provider, 'nil1newer')
  assert.equal(records[0]?.registered, true)
  assert.equal(records[0]?.primaryBase, 'https://sp.example.com:443')
  assert.equal(records[1]?.provider, 'nil1older')
  assert.equal(records[1]?.registered, false)
})

test('findOperatorProviderRecord resolves a selected provider address', () => {
  const record = findOperatorProviderRecord(
    buildOperatorProviderRecords(
      [{ provider: 'nil1provider', operator: 'nil1op', paired_height: '7' }],
      [{ address: 'nil1provider', endpoints: ['/dns4/sp.example.com/tcp/443/https'] }],
    ),
    'nil1provider',
  )

  assert.equal(record?.provider, 'nil1provider')
  assert.equal(record?.primaryBase, 'https://sp.example.com:443')
})

test('buildProviderRegisterCommand emits an update-aware register command template', () => {
  const command = buildProviderRegisterCommand({
    providerKey: 'provider-main',
    providerEndpoint: '/dns4/new.example.com/tcp/443/https',
  })

  assert.match(command, /PROVIDER_KEY='provider-main'/)
  assert.match(command, /PROVIDER_ENDPOINT='\/dns4\/new\.example\.com\/tcp\/443\/https'/)
  assert.match(command, /run_devnet_provider\.sh register/)
})
