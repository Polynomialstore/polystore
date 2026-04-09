/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'

function ethToPolystoreAddress(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('provider dashboard uses provider-daemon status and can unpair a provider', async ({ page }) => {
  const account = privateKeyToAccount(generatePrivateKey())
  const chainId = Number(process.env.CHAIN_ID || 20260211)
  const chainIdHex = `0x${chainId.toString(16)}`
  const polystoreAddress = ethToPolystoreAddress(account.address)
  const providerAddress = 'nil1providerdashboard000000000000000000000000'
  const publicBase = 'https://sp-dashboard.example.com'
  const txHash = '0x0000000000000000000000000000000000000000000000000000000000000abc'
  let unpairTxRequested = false
  let pairingsRemoved = false

  await page.exposeFunction('markProviderUnpairRequested', () => {
    unpairTxRequested = true
    pairingsRemoved = true
  })

  await page.addInitScript(({ address, chainIdHex, txHash }) => {
    const w = window as any
    if (w.ethereum) return
    w.ethereum = {
      isMetaMask: true,
      isPolyStoreE2E: true,
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
          case 'eth_sendTransaction':
            void w.markProviderUnpairRequested?.()
            return txHash
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
  }, { address: account.address, chainIdHex, txHash })

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
    if (method === 'eth_getTransactionReceipt') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: payload?.id ?? 1,
          result: {
            transactionHash: txHash,
            status: '0x1',
            logs: [],
          },
        }),
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

  await page.route('http://127.0.0.1:8080/status', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ persona: 'user-gateway' }) })
  })
  await page.route('http://127.0.0.1:8080/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await page.route('http://localhost:8080/status', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ persona: 'user-gateway' }) })
  })
  await page.route('http://localhost:8080/health', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })

  await page.route('**/cosmos/bank/v1beta1/balances/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ balances: [{ denom: 'aatom', amount: '1000000' }], pagination: { total: '1' } }),
    })
  })

  await page.route(`**/polystorechain/polystorechain/v1/provider-pairings/by-operator/${polystoreAddress}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pairings: pairingsRemoved
          ? []
          : [
              {
                provider: providerAddress,
                operator: polystoreAddress,
                paired_height: '91',
              },
            ],
      }),
    })
  })

  await page.route('**/polystorechain/polystorechain/v1/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [
          {
            address: providerAddress,
            status: 'PROVIDER_STATUS_ACTIVE',
            endpoints: ['/dns4/sp-dashboard.example.com/tcp/443/https'],
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
          key_name: 'provider-main',
          pairing_status: 'paired',
          paired_operator: polystoreAddress,
          registration_status: 'registered',
          public_base: publicBase,
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
      body: 'blocked from browser',
    })
  })

  await page.goto('/#/sp-dashboard', { waitUntil: 'networkidle' })

  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible().catch(() => false))) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  await expect(page.getByRole('heading', { name: providerAddress })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('provider-public-status-card')).toContainText('Provider-daemon status is live')
  await expect(page.getByTestId('provider-browser-health-card')).toContainText('/health failed')

  await page.getByTestId('unpair-provider').click()
  await expect.poll(() => unpairTxRequested, { timeout: 30_000 }).toBe(true)
  await expect(page.getByText('This wallet does not own any provider-daemons yet')).toBeVisible({ timeout: 30_000 })
})
