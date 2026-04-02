import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import {
  buildProviderAgentPrompt,
  buildProviderBootstrapCommand,
  buildCloudflareTunnelBootstrapCommand,
  buildProviderEndpointPlan,
  buildProviderHealthCommands,
  buildProviderPairCommand,
  buildProviderLinkCommand,
  evaluateProviderRunbookReadiness,
  findConfirmedProviderPairing,
  findMostRecentPendingProviderLink,
  findProviderByAddress,
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

test('buildProviderEndpointPlan rejects invalid endpoint inputs', () => {
  assert.equal(
    buildProviderEndpointPlan({
      hostMode: 'home-tunnel',
      endpointMode: 'domain',
      endpointValue: 'not-a-public-host',
      publicPort: 443,
    }),
    null,
  )

  assert.equal(
    buildProviderEndpointPlan({
      hostMode: 'public-vps',
      endpointMode: 'ipv4',
      endpointValue: '999.0.113.10',
      publicPort: 8091,
    }),
    null,
  )

  assert.equal(
    buildProviderEndpointPlan({
      hostMode: 'public-vps',
      endpointMode: 'multiaddr',
      endpointValue: 'abc',
    }),
    null,
  )
})

test('buildProviderBootstrapCommand emits a focused bootstrap command and opts into partial mode when operator data is absent', () => {
  const command = buildProviderBootstrapCommand({
    hostMode: 'public-vps',
    endpointMode: 'ipv4',
    endpointValue: '203.0.113.10',
    operatorAddress: '',
    providerKey: 'provider-main',
    authToken: "shh it's secret",
  })

  assert.match(command, /Run this from the nil-store checkout on the provider host after pairing is approved\./)
  assert.match(command, /starts \(or restarts\) the provider-daemon/i)
  assert.match(command, /BOOTSTRAP_ALLOW_PARTIAL=1/)
  assert.doesNotMatch(command, /OPERATOR_ADDRESS=/)
  assert.match(command, /PROVIDER_KEY='provider-main'/)
  assert.match(command, /PROVIDER_ENDPOINT='\/ip4\/203\.0\.113\.10\/tcp\/8091\/http'/)
  assert.match(command, /NIL_GATEWAY_SP_AUTH='shh it'\\''s secret'/)
  assert.match(command, /run_devnet_provider\.sh bootstrap/)
  assert.doesNotMatch(command, /git clone/)
  assert.doesNotMatch(command, /run_devnet_provider\.sh init/)
  const continuationLines = command
    .split('\n')
    .filter((line) => /(BOOTSTRAP_ALLOW_PARTIAL|PROVIDER_KEY|PROVIDER_ENDPOINT|NIL_GATEWAY_SP_AUTH)=/.test(line))
  for (const line of continuationLines) {
    assert.match(line, / \\$/)
    assert.doesNotMatch(line, / \\\\$/)
  }
})

test('buildProviderBootstrapCommand uses an explicit provider endpoint fallback when draft input is invalid', () => {
  const command = buildProviderBootstrapCommand({
    hostMode: 'public-vps',
    endpointMode: 'domain',
    endpointValue: 'not-a-public-host',
    operatorAddress: 'nil1operator123',
    providerKey: 'provider-main',
    providerEndpoint: '/dns4/testasdf.nil-store.com/tcp/443/https',
  })

  assert.match(command, /OPERATOR_ADDRESS='nil1operator123'/)
  assert.match(command, /PROVIDER_ENDPOINT='\/dns4\/testasdf\.nil-store\.com\/tcp\/443\/https'/)
  assert.doesNotMatch(command, /BOOTSTRAP_ALLOW_PARTIAL=1/)
})

test('buildCloudflareTunnelBootstrapCommand emits an easy bootstrap flow for tunnel hosts', () => {
  const command = buildCloudflareTunnelBootstrapCommand({
    hostMode: 'home-tunnel',
    endpointMode: 'domain',
    endpointValue: 'https://sp.example.com/path',
    tunnelName: 'nilstore-sp1',
  })

  assert.match(command, /CF_TUNNEL_NAME='nilstore-sp1'/)
  assert.match(command, /CF_TUNNEL_HOSTNAME='sp\.example\.com'/)
  assert.match(command, /CF_TUNNEL_SERVICE_URL='http:\/\/127\.0\.0\.1:8091'/)
  assert.match(command, /cloudflared tunnel login/)
  assert.match(command, /cloudflared tunnel create "\$CF_TUNNEL_NAME"/)
  assert.match(command, /cloudflared tunnel route dns "\$CF_TUNNEL_NAME" "\$CF_TUNNEL_HOSTNAME"/)
  assert.match(command, /cloudflared --config "\$HOME\/\.cloudflared\/config\.yml" tunnel run "\$CF_TUNNEL_NAME"/)
})

test('evaluateProviderRunbookReadiness requires endpoint and operator for website-managed onboarding', () => {
  const endpointPlan = buildProviderEndpointPlan({
    hostMode: 'public-vps',
    endpointMode: 'ipv4',
    endpointValue: '203.0.113.10',
    publicPort: 8091,
  })

  assert.deepEqual(evaluateProviderRunbookReadiness({ endpointPlan, operatorAddress: '', authToken: '' }), {
    ready: false,
    missing: ['operator'],
  })
  assert.deepEqual(evaluateProviderRunbookReadiness({ endpointPlan: null, operatorAddress: 'nil1op', authToken: 'secret' }), {
    ready: false,
    missing: ['endpoint'],
  })
  assert.deepEqual(evaluateProviderRunbookReadiness({ endpointPlan, operatorAddress: 'nil1op', authToken: '' }), {
    ready: true,
    missing: [],
  })
  assert.deepEqual(
    evaluateProviderRunbookReadiness({
      endpointPlan: null,
      providerEndpoint: '/dns4/testasdf.nil-store.com/tcp/443/https',
      operatorAddress: 'nil1op',
      authToken: '',
    }),
    {
      ready: true,
      missing: [],
    },
  )
})

test('buildProviderBootstrapCommand includes operator address when supplied', () => {
  const command = buildProviderBootstrapCommand({
    hostMode: 'home-tunnel',
    endpointMode: 'domain',
    endpointValue: 'sp.example.com',
    operatorAddress: 'nil1operator123',
    providerKey: 'provider-main',
  })

  assert.match(command, /OPERATOR_ADDRESS='nil1operator123'/)
})

test('buildProviderPairCommand emits a single provider-host pairing command', () => {
  const command = buildProviderPairCommand('provider-main', 'nil1operator123')

  assert.match(command, /create the key if needed and open the link request/i)
  assert.match(command, /OPERATOR_ADDRESS='nil1operator123'/)
  assert.match(command, /PROVIDER_KEY='provider-main'/)
  assert.match(command, /run_devnet_provider\.sh pair/)
  assert.doesNotMatch(command, /run_devnet_provider\.sh init/)
  assert.doesNotMatch(command, /run_devnet_provider\.sh link/)
})

test('buildProviderLinkCommand emits a standalone provider-link command', () => {
  const command = buildProviderLinkCommand('provider-main', 'nil1operator123')

  assert.match(command, /OPERATOR_ADDRESS='nil1operator123'/)
  assert.match(command, /PROVIDER_KEY='provider-main'/)
  assert.match(command, /OPERATOR_ADDRESS='nil1operator123' \\$/m)
  assert.match(command, /PROVIDER_KEY='provider-main' \\$/m)
  assert.doesNotMatch(command, /OPERATOR_ADDRESS='nil1operator123' \\\\$/m)
  assert.doesNotMatch(command, /PROVIDER_KEY='provider-main' \\\\$/m)
  assert.match(command, /run_devnet_provider\.sh link/)
})

test('buildProviderHealthCommands includes doctor, verify, config, and health probes', () => {
  const commands = buildProviderHealthCommands('https://sp.example.com', 'provider-main')
  assert.match(commands, /PROVIDER_KEY='provider-main' \.\/scripts\/run_devnet_provider\.sh doctor/)
  assert.match(commands, /PROVIDER_KEY='provider-main' \.\/scripts\/run_devnet_provider\.sh verify/)
  assert.match(commands, /PROVIDER_KEY='provider-main' \.\/scripts\/run_devnet_provider\.sh print-config/)
  assert.match(commands, /doctor/)
  assert.match(commands, /verify/)
  assert.match(commands, /print-config/)
  assert.match(commands, /127\.0\.0\.1:8091\/health/)
  assert.match(commands, /https:\/\/sp\.example\.com\/health/)

  const defaultKeyCommands = buildProviderHealthCommands('https://sp.example.com')
  assert.match(defaultKeyCommands, /PROVIDER_KEY='provider1' \.\/scripts\/run_devnet_provider\.sh doctor/)
})

test('buildProviderAgentPrompt matches the canonical repo prompt by default', () => {
  const prompt = buildProviderAgentPrompt().trim()
  const canonical = readRepoFile('docs/onboarding-prompts/provider.md')

  assert.equal(prompt, canonical)
})

test('buildProviderAgentPrompt includes runtime values and script-aligned status fields', () => {
  const prompt = buildProviderAgentPrompt({
    operatorAddress: 'nil1op123',
    providerEndpoint: '/dns4/sp.example.com/tcp/443/https',
    publicBase: 'https://sp.example.com',
    providerKey: 'provider-main',
  })

  assert.match(prompt, /OPERATOR_ADDRESS=nil1op123/)
  assert.match(prompt, /PROVIDER_KEY=provider-main/)
  assert.match(prompt, /PROVIDER_ENDPOINT=\/dns4\/sp\.example\.com\/tcp\/443\/https/)
  assert.match(prompt, /public health base `https:\/\/sp\.example\.com`/)
  assert.match(prompt, /run_devnet_provider\.sh pair/)
  assert.match(prompt, /run_devnet_provider\.sh link/)
  assert.match(prompt, /bootstrap` now fails fast unless all three are present/)
  assert.match(prompt, /provider_process_running/)
  assert.match(prompt, /pending_link_open/)
  assert.match(prompt, /update-aware on the current testnet build/)
})

test('provider onboarding docs reflect update-aware endpoints and the web-first flow', () => {
  const quickstart = readRepoFile('docs/ALPHA_PROVIDER_QUICKSTART.md')
  const remote = readRepoFile('docs/REMOTE_SP_JOIN_QUICKSTART.md')
  const endpoints = readRepoFile('docs/networking/PROVIDER_ENDPOINTS.md')
  const collaboratorPacket = readRepoFile('docs/TRUSTED_DEVNET_COLLABORATOR_PACKET.md')
  const nilstorePacket = readRepoFile('docs/TRUSTED_DEVNET_COLLABORATOR_PACKET_NILSTORE_ORG.md')

  assert.match(quickstart, /Treat `NIL_GATEWAY_SP_AUTH` as a secret/)
  assert.match(quickstart, /https:\/\/nilstore\.org\/#\/sp-onboarding/)
  assert.match(remote, /BOOTSTRAP_ALLOW_PARTIAL=1/)
  assert.match(remote, /https:\/\/nilstore\.org\/#\/sp-onboarding/)
  assert.match(remote, /https:\/\/nilstore\.org\/#\/sp-dashboard/)
  assert.match(remote, /run_devnet_provider\.sh pair/)
  assert.match(remote, /run_devnet_provider\.sh link/)
  assert.match(endpoints, /update-provider-endpoints/)
  assert.doesNotMatch(endpoints, /Endpoint lists are \*\*not\*\* mutable/)
  assert.match(collaboratorPacket, /website-first bootstrap/)
  assert.match(collaboratorPacket, /run_devnet_provider\.sh pair/)
  assert.match(collaboratorPacket, /run_devnet_provider\.sh bootstrap/)
  assert.doesNotMatch(collaboratorPacket, /run_devnet_provider\.sh register/)
  assert.doesNotMatch(collaboratorPacket, /run_devnet_provider\.sh start/)
  assert.match(nilstorePacket, /website-first bootstrap/)
  assert.match(nilstorePacket, /run_devnet_provider\.sh pair/)
  assert.match(nilstorePacket, /run_devnet_provider\.sh bootstrap/)
})

test('run_devnet_provider.sh help prints usage without requiring PROVIDER_KEY', () => {
  const output = execFileSync('./scripts/run_devnet_provider.sh', ['help'], {
    cwd: new URL('../../../', import.meta.url),
    encoding: 'utf8',
  })

  assert.match(output, /Usage: \.\/scripts\/run_devnet_provider\.sh/)
  assert.match(output, /pair/)
  assert.match(output, /link/)
  assert.match(output, /bootstrap/)
})

test('provider prompt summary keys are backed by run_devnet_provider print-config fields', () => {
  const script = readRepoFile('scripts/run_devnet_provider.sh')
  const requiredKeys = [
    'provider_address',
    'configured_operator',
    'pairing_status',
    'registered_endpoints',
    'local_health_url',
    'public_health_url',
    'local_health_ok',
    'public_health_ok',
    'lcd_visible',
    'provider_process_running',
    'provider_registered',
    'provider_paired',
    'pending_link_open',
    'sp_auth_present',
  ]

  for (const key of requiredKeys) {
    assert.match(script, new RegExp(`"${key}"\\s*:`))
  }
})

test('provider link helpers resolve confirmed providers and pending links', () => {
  const confirmed = findConfirmedProviderPairing(
    [
      { provider: 'nil1a', operator: 'nil1op', paired_height: '1' },
      { provider: 'nil1b', operator: 'nil1op', paired_height: '2' },
    ],
    'nil1op',
  )

  assert.deepEqual(confirmed, {
    provider: 'nil1b',
    operator: 'nil1op',
    paired_height: '2',
  })

  const pending = findMostRecentPendingProviderLink(
    [
      { provider: 'nil1a', operator: 'nil1op', requested_height: '10' },
      { provider: 'nil1b', operator: 'nil1op', requested_height: '25' },
    ],
    'nil1op',
  )

  assert.deepEqual(pending, {
    provider: 'nil1b',
    operator: 'nil1op',
    requested_height: '25',
  })

  assert.equal(
    findProviderByAddress([{ address: 'nil1b', endpoints: ['/dns4/sp.example.com/tcp/443/https'] }], 'nil1b')?.address,
    'nil1b',
  )
})
