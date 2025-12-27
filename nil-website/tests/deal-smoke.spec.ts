/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { getAbiItem, getEventSelector, padHex, toHex, type Hex } from 'viem'
import { NILSTORE_PRECOMPILE_ABI } from '../src/lib/nilstorePrecompile'

const path = process.env.E2E_PATH || '/#/dashboard'
const precompile = '0x0000000000000000000000000000000000000900'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('deal lifecycle smoke (connect → fund → create → upload → commit → explore)', async ({ page }) => {
  test.setTimeout(300_000)

  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 31337)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)

  const txHash = (`0x${'11'.repeat(32)}` as Hex)
  const dealId = '1'
  const manifestRoot = `0x${'aa'.repeat(48)}`
  const filePath = 'e2e.txt'
  const fileBytes = Buffer.alloc(1024 * 1024, 'A')

  console.log(`Using random E2E wallet: ${account.address} -> ${nilAddress}`)

  // Mock LCD balances + deals + providers (CI runs Vite only; no chain/gateway).
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

  await page.route('**/nilchain/nilchain/v1/deals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        deals: [
          {
            id: dealId,
            owner: nilAddress,
            cid: manifestRoot,
            size: String(fileBytes.length),
            escrow_balance: '1000000',
            end_block: '1000',
            providers: ['nil1provider'],
          },
        ],
      }),
    })
  })

  await page.route('**/nilchain/nilchain/v1/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ providers: [] }),
    })
  })

  // Mock faucet + LCD tx polling used by useFaucet.
  await page.route('**/faucet', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tx_hash: txHash }),
    })
  })

  await page.route('**/cosmos/tx/v1beta1/txs/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tx_response: { code: 0 } }),
    })
  })

  // Mock gateway endpoints used by Commit Content and DealDetail.
  await page.route('**/gateway/upload**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        cid: manifestRoot,
        size_bytes: fileBytes.length,
        file_size_bytes: fileBytes.length,
        allocated_length: 8 * 1024 * 1024,
        filename: filePath,
      }),
    })
  })

  await page.route('**/gateway/slab/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        manifest_root: manifestRoot,
        mdu_size_bytes: 8 * 1024 * 1024,
        blob_size_bytes: 128 * 1024,
        total_mdus: 3,
        witness_mdus: 1,
        user_mdus: 1,
        file_records: 1,
        file_count: 1,
        total_size_bytes: fileBytes.length,
        segments: [
          { kind: 'mdu0', start_index: 0, count: 1, size_bytes: 8 * 1024 * 1024 },
          { kind: 'witness', start_index: 1, count: 1, size_bytes: 8 * 1024 * 1024 },
          { kind: 'user', start_index: 2, count: 1, size_bytes: 8 * 1024 * 1024 },
        ],
      }),
    })
  })

  await page.route('**/gateway/list-files/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        files: [{ path: filePath, size_bytes: fileBytes.length, start_offset: 0, flags: 0 }],
      }),
    })
  })

  // Mock EVM RPC receipts for createDeal/updateDealContent (waitForTransactionReceipt).
  const dealCreatedEvent = getAbiItem({ abi: NILSTORE_PRECOMPILE_ABI, name: 'DealCreated' }) as any
  const dealCreatedTopic0 = getEventSelector(dealCreatedEvent)
  const dealIdTopic = toHex(1n, { size: 32 })
  const ownerTopic = padHex(account.address, { size: 32 })

  await page.route('**://localhost:8545', async (route) => {
    const payload = JSON.parse(route.request().postData() || '{}') as any
    const method = payload?.method
    const params = payload?.params || []

    if (method === 'eth_chainId') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: chainIdHex }),
      })
    }

    if (method === 'eth_getTransactionReceipt') {
      const hash = String(params?.[0] || '')
      if (hash.toLowerCase() === txHash.toLowerCase()) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: payload?.id ?? 1,
            result: {
              transactionHash: txHash,
              status: '0x1',
              logs: [{ address: precompile, topics: [dealCreatedTopic0, dealIdTopic, ownerTopic], data: '0x' }],
            },
          }),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }),
      })
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }),
    })
  })

  // Inject Wallet (MetaMask mock).
  await page.addInitScript(
    ({ address, chainIdHex }) => {
      const w = window as any
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
            case 'eth_requestAccounts':
              return [address]
            case 'eth_accounts':
              return [address]
            case 'eth_chainId':
              return chainIdHex
            case 'net_version':
              return String(parseInt(chainIdHex, 16))
            case 'eth_sendTransaction':
              return '0x' + '11'.repeat(32)
            default:
              return null
          }
        },
      }

      const announceProvider = () => {
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: {
              info: { uuid: 'test-uuid-smoke', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
              provider: w.ethereum,
            },
          }),
        )
      }
      window.addEventListener('eip6963:requestProvider', announceProvider)
      announceProvider()
    },
    { address: account.address, chainIdHex },
  )

  await page.goto(path)

  console.log('Connecting wallet...')
  if (await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible()) {
    console.log('Wallet already connected (auto-connect).')
  } else {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  await expect(page.getByTestId('cosmos-identity')).toContainText('nil1')

  await page.getByTestId('faucet-request').click()
  await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText('—', { timeout: 90_000 })

  const redundancySelect = page.getByTestId('alloc-redundancy-mode')
  if (!(await redundancySelect.isVisible().catch(() => false))) {
    await page.getByTestId('workspace-advanced-toggle').click()
    await expect(redundancySelect).toBeVisible({ timeout: 10_000 })
  }
  await redundancySelect.selectOption('mode1')
  await page.getByTestId('alloc-submit').click()
  await page.getByTestId('tab-content').click()

  const dealSelect = page.getByTestId('workspace-deal-select')
  await expect(dealSelect.locator(`option[value="${dealId}"]`)).toHaveCount(1, { timeout: 60_000 })
  await dealSelect.selectOption(dealId)
  await expect(dealSelect).toHaveValue(dealId)

  await page.getByTestId('content-file-input').setInputFiles({
    name: filePath,
    mimeType: 'text/plain',
    buffer: fileBytes,
  })

  const stagedManifestRoot = page.getByTestId('staged-manifest-root')
  await expect(stagedManifestRoot).toHaveText(/^0x[0-9a-f]{96}$/i, { timeout: 180_000 })
  expect((await stagedManifestRoot.textContent())?.trim() || '').toBe(manifestRoot)

  const dealManifestCell = page.getByTestId(`deal-manifest-${dealId}`)
  await expect(dealManifestCell).toHaveAttribute('title', manifestRoot, { timeout: 120_000 })

  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('deal-detail')).toBeVisible()

  const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)
  await expect(fileRow).toBeVisible({ timeout: 120_000 })
})
