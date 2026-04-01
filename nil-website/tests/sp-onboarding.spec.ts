/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect, type Page, type Route } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

type SpOnboardingFixtureOptions = {
  authToken?: string
  draft?: Partial<{
    hostMode: 'home-tunnel' | 'public-vps'
    endpointMode: 'domain' | 'ipv4' | 'multiaddr'
    endpointValue: string
    publicPort: string
    providerKey: string
    providerRepoReady: boolean
    providerKeyInitialized: boolean
    providerAddress: string
    linkTxHash: string
  }>
  pendingLinks?: Array<{ provider: string; operator: string; requested_height: string }>
  pairings?: Array<{ provider: string; operator: string; paired_height: string }>
  providers?: Array<{ address: string; status: string; endpoints: string[] }>
  publicBase?: string | null
  publicHealthOk?: boolean
  browserHealthStatus?: number
  balanceHex?: string
}

async function connectWalletIfNeeded(page: Page) {
  const walletLocator = page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()
  if (await walletLocator.isVisible().catch(() => false)) return
  await page.getByTestId('connect-wallet').first().click({ force: true })
  await expect(walletLocator).toBeVisible()
}

async function setupGatewayProbeRoutes(page: Page) {
  const fulfillGatewayProbe = async (route: Route) => {
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
}

async function setupSpOnboardingFixture(page: Page, options: SpOnboardingFixtureOptions = {}) {
  const account = privateKeyToAccount(generatePrivateKey())
  const chainId = Number(process.env.CHAIN_ID || 20260211)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)
  const providerAddress = options.draft?.providerAddress || 'nil1provideronboarding0000000000000000000000000'
  const defaultPublicBase = options.draft?.endpointMode === 'ipv4'
    ? `http://${options.draft.endpointValue || '203.0.113.10'}:${options.draft.publicPort || '8091'}`
    : 'https://sp.example.com'
  const publicBase = options.publicBase === undefined ? defaultPublicBase : options.publicBase

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
    ...options.draft,
  }

  const pendingLinks = options.pendingLinks ?? [
    {
      provider: providerAddress,
      operator: nilAddress,
      requested_height: '95',
    },
  ]
  const pairings = options.pairings ?? [
    {
      provider: providerAddress,
      operator: nilAddress,
      paired_height: '90',
    },
  ]
  const providers = options.providers ?? (
    publicBase
      ? [
          {
            address: providerAddress,
            status: 'PROVIDER_STATUS_ACTIVE',
            endpoints: [providerDraft.endpointMode === 'ipv4'
              ? `/ip4/${providerDraft.endpointValue || '203.0.113.10'}/tcp/${providerDraft.publicPort || '8091'}/http`
              : '/dns4/sp.example.com/tcp/443/https'],
          },
        ]
      : []
  )

  await page.addInitScript(({ address, chainIdHex, draft, authToken }) => {
    const w = window as any
    window.localStorage.setItem('nilstore.provider-onboarding.v2', JSON.stringify(draft))
    if (authToken) {
      window.sessionStorage.setItem('nilstore.provider-onboarding.auth.v1', authToken)
    } else {
      window.sessionStorage.removeItem('nilstore.provider-onboarding.auth.v1')
    }

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
  }, { address: account.address, chainIdHex, draft: providerDraft, authToken: options.authToken || '' })

  await setupGatewayProbeRoutes(page)

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
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: options.balanceHex || '0xde0b6b3a7640000' }),
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
      body: JSON.stringify({ links: pendingLinks }),
    })
  })

  await page.route(`**/nilchain/nilchain/v1/provider-pairings/by-operator/${nilAddress}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pairings }),
    })
  })

  await page.route('**/nilchain/nilchain/v1/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers }),
    })
  })

  if (publicBase) {
    await page.route(`${publicBase}/status`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          persona: 'provider-daemon',
          allowed_route_families: ['sp', 'sp/retrieval'],
          provider: {
            address: providerAddress,
            pairing_status: pairings.length ? 'paired' : pendingLinks.length ? 'pending' : 'unpaired',
            paired_operator: nilAddress,
            registration_status: providers.length ? 'registered' : 'pending',
            public_base: publicBase,
            public_health_url: `${publicBase}/health`,
            public_health_ok: options.publicHealthOk ?? true,
            local_base: 'http://127.0.0.1:8091',
            local_health_ok: true,
          },
          issues: [],
        }),
      })
    })

    await page.route(`${publicBase}/health`, async (route) => {
      await route.fulfill({
        status: options.browserHealthStatus ?? 503,
        contentType: options.browserHealthStatus === 200 ? 'application/json' : 'text/plain',
        body: options.browserHealthStatus === 200 ? JSON.stringify({ ok: true }) : 'browser path blocked',
      })
    })
  }

  await page.goto('/#/sp-onboarding', { waitUntil: 'networkidle' })
  await connectWalletIfNeeded(page)

  return { account, nilAddress, providerAddress, publicBase, providerDraft }
}

test('provider onboarding renders the revised five-step happy path and preserves auth across refresh', async ({ page }) => {
  const { nilAddress } = await setupSpOnboardingFixture(page, {
    authToken: 'shared-provider-secret',
  })

  await expect(page.getByRole('button', { name: /Connect Operator Wallet/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /Prepare Provider Host/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /Pair Provider Identity/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /Configure Public Access/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /Bootstrap And Verify/i })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Step 5\. Bootstrap And Verify/i })).toBeVisible()

  await expect(page.getByTestId('provider-auth-token')).toHaveValue('shared-provider-secret')
  const hostCommands = await page.getByTestId('provider-host-commands').textContent()
  expect(hostCommands).toContain(`OPERATOR_ADDRESS='${nilAddress}'`)
  expect(hostCommands).toContain("./scripts/run_devnet_provider.sh bootstrap")
  expect(hostCommands).toContain("NIL_GATEWAY_SP_AUTH='shared-provider-secret'")
  expect(hostCommands).not.toMatch(/BOOTSTRAP_ALLOW_PARTIAL=1\s*\\/i)
  expect(hostCommands).not.toMatch(/run_devnet_provider\.sh init/i)

  await expect(page.getByTestId('provider-daemon-status-card')).toContainText('reachable from the provider-daemon host')
  await expect(page.getByTestId('provider-browser-health-card')).toContainText('/health failed')

  await page.reload({ waitUntil: 'networkidle' })
  await connectWalletIfNeeded(page)
  await expect(page.getByTestId('provider-auth-token')).toHaveValue('shared-provider-secret')
  await expect(page.getByTestId('provider-host-commands')).toContainText("NIL_GATEWAY_SP_AUTH='shared-provider-secret'")
  await expect(page.getByText(/Healthy \(daemon\)/)).toBeVisible()
})

test('provider onboarding blocks bootstrap until the shared auth token is supplied', async ({ page }) => {
  await setupSpOnboardingFixture(page, {
    authToken: '',
  })

  await expect(page.getByRole('heading', { name: /Step 4\. Configure Public Access/i })).toBeVisible()
  await expect(page.getByText(/ask the hub operator for NIL_GATEWAY_SP_AUTH/i)).toBeVisible()
  await expect(page.getByText(/Add the shared provider auth token from the hub operator before copying provider host commands\./)).toBeVisible()
  await expect(page.getByTestId('provider-host-commands')).toHaveCount(0)

  await page.getByTestId('provider-auth-token').fill('fresh-shared-secret')
  await expect(page.getByTestId('provider-host-commands')).toContainText("NIL_GATEWAY_SP_AUTH='fresh-shared-secret'")
})

test('provider onboarding blocks bootstrap until a public endpoint is described', async ({ page }) => {
  await setupSpOnboardingFixture(page, {
    authToken: 'shared-provider-secret',
    draft: {
      endpointValue: '',
    },
    providers: [],
    publicBase: null,
  })

  await expect(page.getByRole('heading', { name: /Step 4\. Configure Public Access/i })).toBeVisible()
  await expect(page.locator('#step-public-access').getByText(/Describe the public endpoint so the website can derive the provider endpoint and health URL\./).first()).toBeVisible()
  await expect(page.getByTestId('provider-host-commands')).toHaveCount(0)

  await page.getByLabel('Public hostname').fill('sp.example.com')
  await expect(page.locator('#step-public-access').getByText('/dns4/sp.example.com/tcp/443/https').first()).toBeVisible()
  await expect(page.getByTestId('provider-host-commands')).toContainText("PROVIDER_ENDPOINT='/dns4/sp.example.com/tcp/443/https'")
})

test('provider onboarding derives the public-vps bootstrap command for direct IPv4 providers', async ({ page }) => {
  const publicBase = 'http://203.0.113.10:8091'

  await setupSpOnboardingFixture(page, {
    authToken: 'shared-provider-secret',
    publicBase,
    draft: {
      hostMode: 'public-vps',
      endpointMode: 'ipv4',
      endpointValue: '203.0.113.10',
      publicPort: '8091',
    },
    providers: [
      {
        address: 'nil1provideronboarding0000000000000000000000000',
        status: 'PROVIDER_STATUS_ACTIVE',
        endpoints: ['/ip4/203.0.113.10/tcp/8091/http'],
      },
    ],
  })

  await expect(page.getByText('Public VPS')).toBeVisible()
  await expect(page.getByTestId('provider-host-commands')).toContainText("PROVIDER_ENDPOINT='/ip4/203.0.113.10/tcp/8091/http'")
  await expect(page.getByTestId('provider-daemon-status-card')).toContainText(`${publicBase}/health`)
})
