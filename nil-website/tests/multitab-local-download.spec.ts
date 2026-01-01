/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { type Hex } from 'viem'

const path = process.env.E2E_PATH || '/#/dashboard'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

async function streamToBuffer(stream: NodeJS.ReadableStream | null): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of stream as any) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

test('Thick Client: committed slab is visible and downloadable across tabs (no gateway slab)', async ({ page, context }) => {
  test.setTimeout(300_000)

  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 31337)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)
  const txCommit = (`0x${'44'.repeat(32)}` as Hex)

  const dealId = '1'
  const filePath = 'multitab.txt'
  const fileBytes = Buffer.from('hello from multitab')

  let committedRoot = ''
  let gatewayPlanCalls = 0
  let manifestUploadCalls = 0

  // Intercept SP Upload and capture manifest root.
  await page.route('**/sp/upload_mdu', async (route) => {
    const headers = route.request().headers()
    const manifestRoot = headers['x-nil-manifest-root']
    if (typeof manifestRoot === 'string' && manifestRoot.startsWith('0x')) {
      committedRoot = manifestRoot
    }
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'OK' })
  })

  await page.route('**/sp/upload_manifest', async (route) => {
    manifestUploadCalls += 1
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'OK' })
  })

  // Mock EVM RPC for wagmi + direct commit.
  await page.route('**://localhost:8545/**', async (route) => {
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
    if (method === 'eth_blockNumber') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: '0x1' }),
      })
    }
    if (method === 'eth_sendTransaction') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: txCommit }),
      })
    }
    if (method === 'eth_getTransactionReceipt') {
      const hash = String(params?.[0] || '')
      if (hash.toLowerCase() === txCommit.toLowerCase()) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: payload?.id ?? 1,
            result: {
              transactionHash: txCommit,
              status: '0x1',
              logs: [],
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

  // Mock LCD deals (page 1: empty container).
  await page.route('**/nilchain/nilchain/v1/deals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        deals: [
          {
            id: dealId,
            owner: nilAddress,
            cid: '',
            size: '0',
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
      body: JSON.stringify({
        providers: [
          {
            address: 'nil1provider',
            endpoints: ['/ip4/127.0.0.1/tcp/8082/http'],
          },
        ],
      }),
    })
  })

  // Mock balances for the Dashboard header.
  await page.route('**/cosmos/bank/v1beta1/balances/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ balances: [{ denom: 'stake', amount: '1000' }], pagination: { total: '1' } }),
    })
  })

  // Inject wallet provider.
  await page.addInitScript(({ address, chainIdHex }) => {
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
            return '0x' + '44'.repeat(32)
          default:
            return null
        }
      },
    }
    const announceProvider = () => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { uuid: 'test-uuid', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
            provider: w.ethereum,
          },
        }),
      )
    }
    window.addEventListener('eip6963:requestProvider', announceProvider)
    announceProvider()
  }, { address: account.address, chainIdHex })

  await page.goto(path)

  // Connect wallet if needed.
  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible())) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  // Local MDU flow: shard -> upload -> commit.
  const dealRow = page.getByTestId(`deal-row-${dealId}`)
  await expect(dealRow).toBeVisible({ timeout: 60_000 })
  await dealRow.click()
  await expect(page.getByTestId('mdu-file-input')).toBeAttached({ timeout: 30_000 })

  await page.getByTestId('mdu-file-input').setInputFiles({
    name: filePath,
    mimeType: 'text/plain',
    buffer: fileBytes,
  })
  await expect(page.getByText('Client-side expansion complete')).toBeVisible({ timeout: 60_000 })

  const uploadBtn = page.getByRole('button', { name: /Upload \d+ MDUs to SP/ })
  await expect(uploadBtn).toBeEnabled()
  await uploadBtn.click()
  await expect(page.getByRole('button', { name: 'Upload Complete' })).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => manifestUploadCalls, { timeout: 30_000 }).toBeGreaterThan(0)

  const commitBtn = page.getByRole('button', { name: 'Commit to Chain' })
  await commitBtn.click()
  await expect(page.getByRole('button', { name: 'Committed!' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Saved MDUs locally (OPFS)')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => committedRoot, { timeout: 30_000 }).toMatch(/^0x[0-9a-f]{96}$/i)

  // Second tab: chain reports committed CID, but gateway slab endpoints fail.
  const page2 = await context.newPage()

  await page2.route('**/gateway/plan-retrieval-session/**', async (route) => {
    gatewayPlanCalls += 1
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'slab not found on disk' }),
    })
  })
  await page2.route('**/gateway/fetch/**', async (route) => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'slab not found on disk' }),
    })
  })
  await page2.route('**/gateway/list-files/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ files: [] }),
    })
  })

  // LCD deals: now shows CID on-chain.
  await page2.route('**/nilchain/nilchain/v1/deals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        deals: [
          {
            id: dealId,
            owner: nilAddress,
            cid: committedRoot,
            size: String(24 * 1024 * 1024),
            escrow_balance: '1000000',
            end_block: '1000',
            providers: ['nil1provider'],
          },
        ],
      }),
    })
  })

  await page2.route('**/nilchain/nilchain/v1/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [
          {
            address: 'nil1provider',
            endpoints: ['/ip4/127.0.0.1/tcp/8082/http'],
          },
        ],
      }),
    })
  })
  await page2.route('**/cosmos/bank/v1beta1/balances/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ balances: [{ denom: 'stake', amount: '1000' }], pagination: { total: '1' } }),
    })
  })
  await page2.route('**://localhost:8545/**', async (route) => {
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
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: '0x2' }),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }),
    })
  })
  await page2.addInitScript(({ address, chainIdHex }) => {
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
          default:
            return null
        }
      },
    }
    const announceProvider = () => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { uuid: 'test-uuid-2', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
            provider: w.ethereum,
          },
        }),
      )
    }
    window.addEventListener('eip6963:requestProvider', announceProvider)
    announceProvider()
  }, { address: account.address, chainIdHex })

  await page2.goto(path)
  if (!(await page2.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible())) {
    await page2.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page2.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  await page2.getByTestId(`deal-row-${dealId}`).click()
  await expect(page2.getByTestId('deal-detail')).toBeVisible({ timeout: 60_000 })
  const fileRow = page2.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)
  await expect(fileRow).toBeVisible({ timeout: 60_000 })

  const downloadButton = page2.locator(`[data-testid="deal-detail-download-browser-slab"][data-file-path="${filePath}"]`)
  await expect(downloadButton).toBeVisible({ timeout: 60_000 })
  await downloadButton.scrollIntoViewIfNeeded()
  await page2.waitForTimeout(200)
  const downloadPromise = page2.waitForEvent('download', { timeout: 60_000 })
  await downloadButton.click({ force: true })
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const downloadedBytes = await streamToBuffer(stream)
  expect(downloadedBytes).toEqual(fileBytes)

  expect(gatewayPlanCalls).toBe(0)
})
