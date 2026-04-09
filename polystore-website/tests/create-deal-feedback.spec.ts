/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import type { Hex } from 'viem'

import { ensureCreateDealDrawerOpen } from './utils/dashboard'

const path = process.env.E2E_PATH || '/#/dashboard'
const genesisHash = `0x${'11'.repeat(32)}`

async function installBaseMocks(page: Parameters<typeof test>[0]['page']) {
  await page.route('**/cosmos/bank/v1beta1/balances/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        balances: [{ denom: 'stake', amount: '1000' }],
        pagination: { total: '1' },
      }),
    })
  })

  await page.route('**/polystorechain/polystorechain/v1/deals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ deals: [] }),
    })
  })

  await page.route('**/polystorechain/polystorechain/v1/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [
          { address: 'nil1provider1', endpoints: ['https://sp1.polynomialstore.com'], status: 'active' },
          { address: 'nil1provider2', endpoints: ['https://sp2.polynomialstore.com'], status: 'active' },
          { address: 'nil1provider3', endpoints: ['https://sp3.polynomialstore.com'], status: 'active' },
        ],
      }),
    })
  })

}

async function installWallet(
  page: Parameters<typeof test>[0]['page'],
  options: {
    address: string
    chainIdHex: string
    txHash?: Hex
    rpcErrorMessage?: string
    rpcErrorCode?: number
  },
) {
  await page.addInitScript(
    ({ address, chainIdHex, txHash, rpcErrorMessage, rpcErrorCode }) => {
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
            case 'eth_requestAccounts':
              return [address]
            case 'eth_accounts':
              return [address]
            case 'eth_chainId':
              return chainIdHex
            case 'net_version':
              return String(parseInt(chainIdHex, 16))
            case 'wallet_requestPermissions':
            case 'wallet_getPermissions':
              return [{ parentCapability: 'eth_accounts' }]
            case 'wallet_switchEthereumChain':
            case 'wallet_addEthereumChain':
              return null
            case 'eth_getBlockByNumber':
              return { hash: genesisHash }
            case 'eth_sendTransaction':
              if (rpcErrorMessage) {
                const error = new Error(rpcErrorMessage)
                ;(error as any).code = rpcErrorCode ?? -32002
                throw error
              }
              return txHash ?? null
            default:
              return null
          }
        },
      }

      const announceProvider = () => {
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: {
              info: { uuid: 'test-uuid-create-feedback', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
              provider: w.ethereum,
            },
          }),
        )
      }
      window.addEventListener('eip6963:requestProvider', announceProvider)
      announceProvider()
    },
    options,
  )
}

test('create deal drawer stays open and shows actionable RPC errors', async ({ page }) => {
  const account = privateKeyToAccount(generatePrivateKey())
  const chainId = Number(process.env.CHAIN_ID || 31337)
  const chainIdHex = `0x${chainId.toString(16)}`

  await installBaseMocks(page)

  await page.route(/^http:\/\/(?:localhost|127\.0\.0\.1):8545\/?$/, async (route) => {
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
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: '0x64' }),
      })
    }

    if (method === 'eth_getBlockByNumber') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: { hash: genesisHash } }),
      })
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }),
    })
  })

  await installWallet(page, {
    address: account.address,
    chainIdHex,
    rpcErrorMessage: 'RPC endpoint returned too many errors, retrying in 0.3 minutes. Consider using a different RPC endpoint.',
    rpcErrorCode: -32002,
  })

  await page.goto(path)

  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible().catch(() => false))) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  await expect(page.getByTestId('polystore-identity')).toContainText('nil1')
  await page.waitForTimeout(1000)
  await ensureCreateDealDrawerOpen(page)
  await page.getByTestId('alloc-submit').click()

  const feedback = page.getByTestId('create-deal-feedback')
  await expect(page.getByTestId('create-deal-drawer')).toBeVisible()
  await expect(feedback).toBeVisible()
  await expect(feedback).toContainText('MetaMask could not reach the configured PolyStore RPC reliably')
  await expect(feedback).toContainText('RPC URL')
})
