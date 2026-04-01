/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('provider onboarding resumes auth token after refresh and prefers provider-daemon status over browser health', async ({ page }) => {
  const account = privateKeyToAccount(generatePrivateKey())
  const chainId = Number(process.env.CHAIN_ID || 20260211)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)
  const providerAddress = 'nil1provideronboarding0000000000000000000000000'
  const publicBase = 'https://sp.example.com'
  let gatewayProbeCalls = 0

  const providerDraft = {
    hostMode: 'home-tunnel',
    endpointMode: 'domain',
    endpointValue: 'sp.example.com',
    publicPort: '443',
    providerKey: 'provider-main',
    providerRepoReady: true,
    providerKeyInitialized: true,
    providerAddress,
    linkTxHash: '0xlinktx',
  }

  await page.addInitScript(({ address, chainIdHex, draft }) => {
    const w = window as any
    window.localStorage.setItem('nilstore.provider-onboarding.v2', JSON.stringify(draft))
    window.sessionStorage.setItem('nilstore.provider-onboarding.auth.v1', 'shared-provider-secret')

    if (w.ethereum) return
    w.ethereum = {
      isMetaMask: true,
      isNilStoreE2E: true,
      selectedAddress: address,
      on: () => {},
      removeListener: () => {},
      async request(args: any) {
        const method = args?.method
        switch (method) {
          case 'eth_requestAccounts': return [address]
          case 'eth_accounts': return [address]
          case 'eth_chainId': return chainIdHex
          case 'net_version': return String(parseInt(chainIdHex, 16))
          default: return null
        }
      },
    }

    const announceProvider = () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: { uuid: 'test-uuid', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
          provider: w.ethereum,
        },
      }))
    }
    window.addEventListener('eip6963:requestProvider', announceProvider)
    announceProvider()
  }, { address: account.address, chainIdHex, draft: providerDraft })

  const fulfillGatewayProbe = async (route: import('@playwright/test').Route) => {
    gatewayProbeCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        persona: 'user-gateway',
        allowed_route_families: ['gateway'],
      }),
    })
  }

  await page.route('http://127.0.0.1:8080/status', fulfillGatewayProbe)
  await page.route('http://127.0.0.1:8080/health', fulfillGatewayProbe)
  await page.route('http://localhost:8080/status', fulfillGatewayProbe)
  await page.route('http://localhost:8080/health', fulfillGatewayProbe)

  await page.route('**://localhost:8545/**', async (route) => {
    const payload = JSON.parse(route.request().postData() || '{}') as any
    const method = payload?.method
    if (method === 'eth_chainId') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: chainIdHex }),
      })
    }
    if (method === 'eth_getBalance') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: '0xde0b6b3a7640000' }),
      })
    }
    if (method === 'eth_blockNumber') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: '0x64' }),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }),
    })
  })

  await page.route('**/cosmos/bank/v1beta1/balances/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ balances: [{ denom: 'aatom', amount: '1000000' }], pagination: { total: '1' } }),
    })
  })

  await page.route('**/cosmos/base/tendermint/v1beta1/blocks/latest', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ block: { header: { height: '100', chain_id: `nil-${chainId}` } } }),
    })
  })

  await page.route(`**/nilchain/nilchain/v1/provider-pairings/pending-by-operator/${nilAddress}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        links: [
          {
            provider: providerAddress,
            operator: nilAddress,
            requested_height: '95',
          },
        ],
      }),
    })
  })

  await page.route(`**/nilchain/nilchain/v1/provider-pairings/by-operator/${nilAddress}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pairings: [
          { provider: providerAddress, operator: nilAddress, paired_height: '90' },
        ],
      }),
    })
  })

  await page.route('**/nilchain/nilchain/v1/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [
          {
            address: providerAddress,
            status: 'PROVIDER_STATUS_ACTIVE',
            endpoints: ['/dns4/sp.example.com/tcp/443/https'],
          },
        ],
      }),
    })
  })

  await page.route(`${publicBase}/status`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        persona: 'provider-daemon',
        allowed_route_families: ['sp', 'sp/retrieval'],
        provider: {
          address: providerAddress,
          pairing_status: 'paired',
          paired_operator: nilAddress,
          registration_status: 'registered',
          public_base: publicBase,
          public_health_url: `${publicBase}/health`,
          public_health_ok: true,
          local_base: 'http://127.0.0.1:8091',
          local_health_ok: true,
        },
        issues: [],
      }),
    })
  })

  await page.route(`${publicBase}/health`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'text/plain',
      body: 'browser path blocked',
    })
  })

  await page.goto('/#/sp-onboarding', { waitUntil: 'networkidle' })
  await expect.poll(() => gatewayProbeCalls, { timeout: 30_000 }).toBeGreaterThan(0)

  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible().catch(() => false))) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  await expect(page.getByTestId('provider-auth-token')).toHaveValue('shared-provider-secret')
  const hostCommands = await page.getByTestId('provider-host-commands').textContent()
  expect(hostCommands).toContain(`OPERATOR_ADDRESS='${nilAddress}'`)
  expect(hostCommands).toContain("./scripts/run_devnet_provider.sh bootstrap")
  expect(hostCommands).not.toMatch(/BOOTSTRAP_ALLOW_PARTIAL=1\s*\\/i)
  await expect(page.getByTestId('provider-daemon-status-card')).toContainText('reachable from the provider-daemon host')
  await expect(page.getByTestId('provider-browser-health-card')).toContainText('/health failed')

  await page.reload({ waitUntil: 'networkidle' })
  await expect(page.getByTestId('provider-auth-token')).toHaveValue('shared-provider-secret')
  await expect(page.getByTestId('provider-host-commands')).toContainText("NIL_GATEWAY_SP_AUTH='shared-provider-secret'")
  await expect(page.getByText(/Healthy \(daemon\)/)).toBeVisible()
})
