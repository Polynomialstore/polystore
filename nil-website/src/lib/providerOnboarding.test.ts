import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildProviderAgentPrompt,
  buildProviderBootstrapCommand,
  buildProviderEndpointPlan,
  buildProviderHealthCommands,
  findConfirmedProviderPairing,
  findProviderByAddress,
  pairingBlocksRemaining,
  pairingExpired,
} from './providerOnboarding'

test('buildProviderEndpointPlan creates a tunnel endpoint from a hostname', () => {
  const plan = buildProviderEndpointPlan({
    hostMode: 'home-tunnel',
    endpointMode: 'domain',
    endpointValue: 'https://sp.example.com/path',
    publicPort: 443,
  })

  assert.deepEqual(plan, {
    providerEndpoint: '/dns4/sp.example.com/tcp/443/https',
    publicBase: 'https://sp.example.com',
    publicHealthUrl: 'https://sp.example.com/health',
    normalizedHost: 'sp.example.com',
    publicPort: 443,
  })
})

test('buildProviderEndpointPlan keeps an explicit multiaddr intact', () => {
  const plan = buildProviderEndpointPlan({
    hostMode: 'public-vps',
    endpointMode: 'multiaddr',
    endpointValue: '/ip4/203.0.113.10/tcp/8443/https',
  })

  assert.equal(plan?.providerEndpoint, '/ip4/203.0.113.10/tcp/8443/https')
  assert.equal(plan?.publicBase, 'https://203.0.113.10:8443')
  assert.equal(plan?.publicHealthUrl, 'https://203.0.113.10:8443/health')
})

test('buildProviderBootstrapCommand uses canonical runtime defaults with quoted values', () => {
  const command = buildProviderBootstrapCommand({
    hostMode: 'home-tunnel',
    endpointMode: 'domain',
    endpointValue: 'sp.example.com',
    pairingId: 'pair-123',
    providerKey: 'provider-main',
    authToken: "shh it's secret",
  })

  assert.match(command, /PAIRING_ID='pair-123'/)
  assert.match(command, /PROVIDER_KEY='provider-main'/)
  assert.match(command, /PROVIDER_ENDPOINT='\/dns4\/sp\.example\.com\/tcp\/443\/https'/)
  assert.match(command, /NIL_GATEWAY_SP_AUTH='shh it'\\''s secret'/)
  assert.match(command, /run_devnet_provider\.sh bootstrap/)
})

test('buildProviderHealthCommands includes local and public verification commands', () => {
  const commands = buildProviderHealthCommands('https://sp.example.com')
  assert.match(commands, /print-config/)
  assert.match(commands, /127\.0\.0\.1:8091\/health/)
  assert.match(commands, /https:\/\/sp\.example\.com\/health/)
})

test('buildProviderAgentPrompt includes pairing, endpoint, and health base context', () => {
  const prompt = buildProviderAgentPrompt({
    pairingId: 'pair-123',
    providerEndpoint: '/dns4/sp.example.com/tcp/443/https',
    publicBase: 'https://sp.example.com',
    providerKey: 'provider-main',
  })

  assert.match(prompt, /PAIRING_ID=pair-123/)
  assert.match(prompt, /PROVIDER_KEY=provider-main/)
  assert.match(prompt, /PROVIDER_ENDPOINT=\/dns4\/sp\.example\.com\/tcp\/443\/https/)
  assert.match(prompt, /website-first flow is primary/)
  assert.match(prompt, /provider-daemon/)
  assert.match(prompt, /public https:\/\/sp\.example\.com\/health/)
})

test('pairing helpers resolve confirmed providers and expiry state', () => {
  const confirmed = findConfirmedProviderPairing(
    [
      { provider: 'nil1a', operator: 'nil1op', pairing_id: 'pair-a', paired_height: '1' },
      { provider: 'nil1b', operator: 'nil1op', pairing_id: 'pair-b', paired_height: '2' },
    ],
    'pair-b',
  )

  assert.deepEqual(confirmed, {
    provider: 'nil1b',
    operator: 'nil1op',
    pairing_id: 'pair-b',
    paired_height: '2',
  })
  assert.equal(
    findProviderByAddress([{ address: 'nil1b', endpoints: ['/dns4/sp.example.com/tcp/443/https'] }], 'nil1b')?.address,
    'nil1b',
  )
  assert.equal(pairingBlocksRemaining({ pairing_id: 'pair-b', operator: 'nil1op', expires_at: '25', opened_height: '5' }, 20), 5)
  assert.equal(pairingExpired({ pairing_id: 'pair-b', operator: 'nil1op', expires_at: '25', opened_height: '5' }, 25), true)
})
