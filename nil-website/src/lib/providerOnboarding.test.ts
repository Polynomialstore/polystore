import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8').trim()
}

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

test('buildProviderEndpointPlan creates a direct http endpoint from an ipv4 host', () => {
  const plan = buildProviderEndpointPlan({
    hostMode: 'public-vps',
    endpointMode: 'ipv4',
    endpointValue: '203.0.113.10',
    publicPort: 8091,
  })

  assert.deepEqual(plan, {
    providerEndpoint: '/ip4/203.0.113.10/tcp/8091/http',
    publicBase: 'http://203.0.113.10:8091',
    publicHealthUrl: 'http://203.0.113.10:8091/health',
    normalizedHost: '203.0.113.10',
    publicPort: 8091,
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

test('buildProviderBootstrapCommand stages init before bootstrap and omits pairing when absent', () => {
  const command = buildProviderBootstrapCommand({
    hostMode: 'public-vps',
    endpointMode: 'ipv4',
    endpointValue: '203.0.113.10',
    pairingId: '',
    providerKey: 'provider-main',
    authToken: "shh it's secret",
  })

  assert.match(command, /run_devnet_provider\.sh init/)
  assert.match(command, /fund the printed nil1 address with aatom/)
  assert.doesNotMatch(command, /PAIRING_ID=/)
  assert.match(command, /PROVIDER_KEY='provider-main'/)
  assert.match(command, /PROVIDER_ENDPOINT='\/ip4\/203\.0\.113\.10\/tcp\/8091\/http'/)
  assert.match(command, /NIL_GATEWAY_SP_AUTH='shh it'\\''s secret'/)
  assert.match(command, /run_devnet_provider\.sh bootstrap/)
})

test('buildProviderBootstrapCommand includes pairing when supplied', () => {
  const command = buildProviderBootstrapCommand({
    hostMode: 'home-tunnel',
    endpointMode: 'domain',
    endpointValue: 'sp.example.com',
    pairingId: 'pair-123',
    providerKey: 'provider-main',
  })

  assert.match(command, /PAIRING_ID='pair-123'/)
})

test('buildProviderHealthCommands includes doctor, verify, config, and health probes', () => {
  const commands = buildProviderHealthCommands('https://sp.example.com')
  assert.match(commands, /doctor/)
  assert.match(commands, /verify/)
  assert.match(commands, /print-config/)
  assert.match(commands, /127\.0\.0\.1:8091\/health/)
  assert.match(commands, /https:\/\/sp\.example\.com\/health/)
})

test('buildProviderAgentPrompt matches the canonical repo prompt by default', () => {
  const prompt = buildProviderAgentPrompt().trim()
  const canonical = readRepoFile('docs/onboarding-prompts/provider.md')

  assert.equal(prompt, canonical)
})

test('buildProviderAgentPrompt includes runtime values and provider_daemon_status', () => {
  const prompt = buildProviderAgentPrompt({
    pairingId: 'pair-123',
    providerEndpoint: '/dns4/sp.example.com/tcp/443/https',
    publicBase: 'https://sp.example.com',
    providerKey: 'provider-main',
  })

  assert.match(prompt, /PAIRING_ID=pair-123/)
  assert.match(prompt, /PROVIDER_KEY=provider-main/)
  assert.match(prompt, /PROVIDER_ENDPOINT=\/dns4\/sp\.example\.com\/tcp\/443\/https/)
  assert.match(prompt, /public health base `https:\/\/sp\.example\.com`/)
  assert.match(prompt, /provider_daemon_status/)
  assert.match(prompt, /update-aware on the current testnet build/)
})

test('provider onboarding docs reflect update-aware endpoints and the web-first flow', () => {
  const quickstart = readRepoFile('docs/ALPHA_PROVIDER_QUICKSTART.md')
  const remote = readRepoFile('docs/REMOTE_SP_JOIN_QUICKSTART.md')
  const endpoints = readRepoFile('docs/networking/PROVIDER_ENDPOINTS.md')

  assert.match(quickstart, /Treat `NIL_GATEWAY_SP_AUTH` as a secret/)
  assert.match(remote, /`bootstrap` can run without `PAIRING_ID`/)
  assert.match(endpoints, /update-provider-endpoints/)
  assert.doesNotMatch(endpoints, /Endpoint lists are \*\*not\*\* mutable/)
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
