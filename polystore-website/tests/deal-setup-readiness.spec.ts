/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('upload stays blocked until a newly selected deal resolves through detail lookup and provider routing', async ({ page }) => {
  const account = privateKeyToAccount(generatePrivateKey())
  const chainId = Number(process.env.CHAIN_ID || 20260211)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)
  const dealId = '32'
  let gatewayProbeAttempts = 0
  let detailAttempts = 0

  const gatewayStatusPayload = {
    persona: 'user-gateway',
    allowed_route_families: ['gateway'],
    git_sha: 'test',
    version: 'test',
  }

  const fulfillGatewayProbe = async (route: import('@playwright/test').Route) => {
    gatewayProbeAttempts += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(gatewayStatusPayload),
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

    if (method === 'eth_blockNumber') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: '0x1' }),
      })
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }),
    })
  })

  await page.route('**/polystorechain/polystorechain/v1/deals**', async (route) => {
    const url = route.request().url()

    if (url.includes('/heat')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ heat: { bytes_served: '0' } }),
      })
    }

    const deal = {
      id: dealId,
      owner: nilAddress,
      cid: '',
      size: '0',
      escrow_balance: '1000000',
      end_block: '1000',
      providers: ['nil1providera', 'nil1providerb', 'nil1providerc'],
      service_hint: 'General;mode2=2+1',
    }

    let pathname = url
    try {
      pathname = new URL(url).pathname
    } catch {
      // ignore
    }

    if (/\/polystorechain\/polystorechain\/v1\/deals\/32$/.test(pathname)) {
      detailAttempts += 1
      if (detailAttempts < 4) {
        return route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ code: 5, message: 'deal not found' }),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deal }),
      })
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ deals: [deal] }),
    })
  })

  await page.route('**/polystorechain/polystorechain/v1/providers**', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [
          { address: 'nil1providera', endpoints: ['/ip4/127.0.0.1/tcp/8091/http'] },
          { address: 'nil1providerb', endpoints: ['/ip4/127.0.0.1/tcp/8092/http'] },
          { address: 'nil1providerc', endpoints: ['/ip4/127.0.0.1/tcp/8093/http'] },
        ],
      }),
    })
  })

  await page.route('**/cosmos/bank/v1beta1/balances/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ balances: [{ denom: 'stake', amount: '1000' }], pagination: { total: '1' } }),
    })
  })

  await page.addInitScript(({ address, chainIdHex }) => {
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
  }, { address: account.address, chainIdHex })

  await page.goto(dashboardPath)
  await expect.poll(() => gatewayProbeAttempts, { timeout: 30_000 }).toBeGreaterThan(0)

  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible().catch(() => false))) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  const dealRow = page.getByTestId(`deal-row-${dealId}`)
  await expect(dealRow).toBeVisible({ timeout: 60_000 })
  await dealRow.click()

  await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #32/, { timeout: 30_000 })
  await expect(page.getByTestId('mdu-deal-setup-panel')).toHaveAttribute('data-setup-state', 'loading', { timeout: 30_000 })
  await expect(page.getByTestId('mdu-deal-setup-panel')).toContainText('Finalizing deal allocation', { timeout: 30_000 })
  await expect(page.getByTestId('mdu-file-input')).toHaveCount(0)
  expect(detailAttempts).toBeGreaterThanOrEqual(1)

  await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 30_000 })
  await expect(page.getByTestId('mdu-deal-setup-panel')).toHaveCount(0)
})
