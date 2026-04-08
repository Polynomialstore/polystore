/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { encodeAbiParameters, encodeFunctionResult, getAbiItem, getEventSelector, padHex, toHex, type Hex } from 'viem'
import { POLYSTORE_PRECOMPILE_ABI } from '../src/lib/polystorePrecompile'

const path = process.env.E2E_PATH || '/#/dashboard'
const precompile = '0x0000000000000000000000000000000000000900'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('Deal Explorer debug: after provider sync, default download prefers browser OPFS MDU cache', async ({ page }) => {
  test.setTimeout(300_000)

  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 20260211)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)

  const dealId = '1'
  const manifestRoot = '0xae5359579124255db62f04c55f1d1490655ed5479988a528bbca9f5a2245de9286452e5ffd8e76e05763c8241632c517'
  const filePath = 'provider-base.txt'
  const fileBytes = Buffer.from('hello from provider base')

  const sessionId = (`0x${'99'.repeat(32)}` as Hex)
  const txOpen = (`0x${'22'.repeat(32)}` as Hex)
  const txConfirm = (`0x${'33'.repeat(32)}` as Hex)
  const computeResult = encodeFunctionResult({
    abi: POLYSTORE_PRECOMPILE_ABI,
    functionName: 'computeRetrievalSessionIds',
    result: [['nil1provider'], [sessionId]],
  })

  let fetchCalls = 0
  let planCalls = 0
  let gatewayProofCalls = 0
  let spProofCalls = 0

  // LCD deals + balances
  await page.route('**/polystorechain/polystorechain/v1/deals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        deals: [
          {
            id: dealId,
            owner: nilAddress,
            cid: manifestRoot,
            size: String(24 * 1024 * 1024),
            escrow_balance: '1000000',
            end_block: '1000',
            providers: ['nil1provider'],
          },
        ],
      }),
    })
  })

  await page.route(`**/polystorechain/polystorechain/v1/deals/${dealId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        deal: {
          id: dealId,
          owner: nilAddress,
          manifest_root: Buffer.from(manifestRoot.slice(2), 'hex').toString('base64'),
          size: String(24 * 1024 * 1024),
          escrow_balance: '1000000',
          end_block: '1000',
          providers: ['nil1provider'],
        },
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
            address: 'nil1provider',
            endpoints: ['/ip4/127.0.0.1/tcp/8082/http'],
          },
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

  // Slab/files can come from gateway or direct provider transport depending on diagnostics state.
  const slabResponse = {
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
  }
  const filesResponse = {
    files: [{ path: filePath, size_bytes: fileBytes.length, start_offset: 0, flags: 0 }],
  }

  await page.route('**/gateway/slab/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(slabResponse),
    })
  })

  await page.route('**/gateway/list-files/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(filesResponse),
    })
  })

  await page.route('**/sp/retrieval/slab/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(slabResponse),
    })
  })

  await page.route('**/sp/retrieval/list-files/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(filesResponse),
    })
  })

  await page.route('**/sp/retrieval/plan/**', async (route) => {
    planCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        deal_id: Number(dealId),
        owner: nilAddress,
        provider: 'nil1provider',
        manifest_root: manifestRoot,
        file_path: filePath,
        range_start: 0,
        range_len: fileBytes.length,
        start_mdu_index: 2,
        start_blob_index: 0,
        blob_count: 1,
      }),
    })
  })

  await page.route('**/sp/retrieval/fetch/**', async (route) => {
    fetchCalls += 1
    await route.fulfill({
      status: 206,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-PolyStore-Provider',
        'Content-Type': 'application/octet-stream',
        'X-PolyStore-Provider': 'nil1provider',
      },
      body: fileBytes,
    })
  })

  await page.route('**/gateway/session-proof**', async (route) => {
    const url = route.request().url()
    if (url.includes(':8080/')) gatewayProofCalls += 1
    if (url.includes(':8082/')) spProofCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true }),
    })
  })

  // EVM RPC mocks: waitForTransactionReceipt(open/confirm)
  await page.route('**/*', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.fallback()
    const url = req.url()
    if (!/8545/.test(url)) return route.fallback()

    let payload: any = null
    try {
      payload = JSON.parse(req.postData() || 'null')
    } catch {
      payload = null
    }
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
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: '0x2' }),
      })
    }
    if (method === 'eth_call') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: computeResult }),
      })
    }
    if (method === 'eth_getTransactionReceipt') {
      const hash = String(params?.[0] || '').toLowerCase()
      const openedEvent = getAbiItem({ abi: POLYSTORE_PRECOMPILE_ABI, name: 'RetrievalSessionOpened' }) as any
      const openedTopic0 = getEventSelector(openedEvent)
      const dealIdTopic = toHex(BigInt(dealId), { size: 32 })
      const ownerTopic = padHex(account.address, { size: 32 })
      const openedData = encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], ['nil1provider', sessionId])
      if (hash === txOpen.toLowerCase()) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: payload?.id ?? 1,
            result: {
              transactionHash: txOpen,
              status: '0x1',
              logs: [{ address: precompile, topics: [openedTopic0, dealIdTopic, ownerTopic], data: openedData }],
            },
          }),
        })
      }
      if (hash === txConfirm.toLowerCase()) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: payload?.id ?? 1,
            result: { transactionHash: txConfirm, status: '0x1', logs: [] },
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

  // Inject wallet that returns txOpen then txConfirm.
  await page.addInitScript(({ address, chainIdHex, txOpen, txConfirm, computeResult }) => {
    const w = window as any
    if (w.ethereum) return
    let sendCount = 0
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
          case 'eth_call':
            return computeResult
          case 'eth_sendTransaction':
            sendCount += 1
            return sendCount % 2 === 1 ? txOpen : txConfirm
          default:
            return null
        }
      },
    }
    const announceProvider = () => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { uuid: 'test-uuid-debug', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
            provider: w.ethereum,
          },
        }),
      )
    }
    window.addEventListener('eip6963:requestProvider', announceProvider)
    announceProvider()
  }, { address: account.address, chainIdHex, txOpen, txConfirm, computeResult })

  await page.goto(path)

  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible())) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('deal-detail')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('deal-index-sync-panel')).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('deal-index-sync-button').click()

  const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)
  await expect(fileRow).toBeVisible({ timeout: 60_000 })
  await expect(fileRow).toHaveAttribute('data-cache-browser', 'no')

  const downloadButton = page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`)
  const routeLabel = page.getByTestId('transport-route')
  const cacheSourceLabel = page.getByTestId('transport-cache-source')
  await expect(downloadButton).toBeVisible({ timeout: 60_000 })

  // After the browser has synced the committed slab, default Download should prefer
  // the browser-local MDU slab cache instead of re-running retrieval transport.
  const fetchCallsBeforeAuto = fetchCalls
  const planCallsBeforeAuto = planCalls
  const gatewayProofBeforeAuto = gatewayProofCalls
  const download1 = page.waitForEvent('download', { timeout: 60_000 })
  await downloadButton.click()
  const dl1 = await download1
  expect(dl1.suggestedFilename()).toBe(filePath)
  expect(fetchCalls).toBe(fetchCallsBeforeAuto)
  expect(planCalls).toBe(planCallsBeforeAuto)
  expect(gatewayProofCalls).toBe(gatewayProofBeforeAuto)
  expect(spProofCalls).toBe(0)
  await expect(fileRow).toHaveAttribute('data-cache-browser', 'yes')
  await expect(routeLabel).toContainText(/browser mdu cache/i)
  await expect(cacheSourceLabel).toContainText(/browser_mdu_cache/i)

  const fetchCallsAfterFirst = fetchCalls

  // Browser Download again: should stay local-first and avoid network retrieval.
  const download2 = page.waitForEvent('download', { timeout: 60_000 })
  await downloadButton.click()
  const dl2 = await download2
  expect(dl2.suggestedFilename()).toBe(filePath)
  expect(fetchCalls).toBe(fetchCallsAfterFirst)
})
