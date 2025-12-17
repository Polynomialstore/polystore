/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { encodeAbiParameters, getAbiItem, getEventSelector, padHex, toHex, type Hex } from 'viem'
import { NILSTORE_PRECOMPILE_ABI } from '../src/lib/nilstorePrecompile'

const path = process.env.E2E_PATH || '/#/dashboard'
const precompile = '0x0000000000000000000000000000000000000900'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

async function streamToBuffer(stream: NodeJS.ReadableStream | null): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of stream as any) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test('Deal Explorer debug: browser cache + SP retrieval + gateway raw fetch', async ({ page }) => {
  test.setTimeout(300_000)

  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 31337)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)

  const dealId = '1'
  const manifestRoot = `0x${'aa'.repeat(48)}`
  const filePath = 'debug.txt'
  const fileBytes = Buffer.from('hello debug cache')

  const sessionId = (`0x${'99'.repeat(32)}` as Hex)
  const txOpen = (`0x${'22'.repeat(32)}` as Hex)
  const txConfirm = (`0x${'33'.repeat(32)}` as Hex)

  let planCalls = 0
  let gatewayRawCalls = 0

  // LCD deals + balances
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
            size: String(24 * 1024 * 1024),
            escrow_balance: '1000000',
            end_block: '1000',
            providers: ['nil1provider'],
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

  // Gateway slab/files
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

  await page.route('**/gateway/plan-retrieval-session/**', async (route) => {
    planCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
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

  await page.route('**/gateway/fetch/**', async (route) => {
    await route.fulfill({
      status: 206,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Nil-Provider',
        'Content-Type': 'application/octet-stream',
        'X-Nil-Provider': 'nil1provider',
      },
      body: fileBytes,
    })
  })

  await page.route('**/gateway/session-proof**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })

  // Debug raw fetch path (gateway "cache" shortcut in debug mode)
  await page.route('**/gateway/debug/raw-fetch/**', async (route) => {
    gatewayRawCalls += 1
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
      body: fileBytes,
    })
  })

  // EVM RPC mocks: waitForTransactionReceipt(open/confirm)
  const openedEvent = getAbiItem({ abi: NILSTORE_PRECOMPILE_ABI, name: 'RetrievalSessionOpened' }) as any
  const openedTopic0 = getEventSelector(openedEvent)
  const dealIdTopic = toHex(BigInt(dealId), { size: 32 })
  const ownerTopic = padHex(account.address, { size: 32 })
  const openedData = encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], ['nil1provider', sessionId])

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
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: '0x2' }),
      })
    }
    if (method === 'eth_getTransactionReceipt') {
      const hash = String(params?.[0] || '').toLowerCase()
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
  await page.addInitScript(({ address, chainIdHex, txOpen, txConfirm }) => {
    const w = window as any
    if (w.ethereum) return
    let sendCount = 0
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
  }, { address: account.address, chainIdHex, txOpen, txConfirm })

  await page.goto(path)

  if (!(await page.getByTestId('wallet-address').isVisible())) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.getByTestId('wallet-address')).toBeVisible()
  }

  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('deal-detail')).toBeVisible({ timeout: 60_000 })

  const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)
  await expect(fileRow).toBeVisible({ timeout: 60_000 })
  await expect(fileRow).toContainText('File cache: no')

  // Browser Download: should fall back to SP retrieval (plan session) and then cache the bytes.
  const download1 = page.waitForEvent('download', { timeout: 60_000 })
  await page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`).click()
  const dl1 = await download1
  expect(await streamToBuffer(await dl1.createReadStream())).toEqual(fileBytes)
  expect(planCalls).toBeGreaterThan(0)
  await expect(fileRow).toContainText('File cache: yes')

  const planCallsAfterFirst = planCalls

  // Browser Download again: should use cached bytes (no extra plan calls).
  const download2 = page.waitForEvent('download', { timeout: 60_000 })
  await page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`).click()
  const dl2 = await download2
  expect(await streamToBuffer(await dl2.createReadStream())).toEqual(fileBytes)
  expect(planCalls).toBe(planCallsAfterFirst)

  // Clear cache and force another SP retrieval.
  await page.locator(`[data-testid="deal-detail-clear-browser-cache"][data-file-path="${filePath}"]`).click()
  await expect(fileRow).toContainText('File cache: no')

  const download3 = page.waitForEvent('download', { timeout: 60_000 })
  await page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`).click()
  const dl3 = await download3
  expect(await streamToBuffer(await dl3.createReadStream())).toEqual(fileBytes)
  expect(planCalls).toBeGreaterThan(planCallsAfterFirst)

  // Gateway raw fetch path should not require a plan call.
  const planCallsBeforeGateway = planCalls
  const download4 = page.waitForEvent('download', { timeout: 60_000 })
  await page.locator(`[data-testid="deal-detail-download-gateway"][data-file-path="${filePath}"]`).click()
  const dl4 = await download4
  expect(await streamToBuffer(await dl4.createReadStream())).toEqual(fileBytes)
  expect(gatewayRawCalls).toBe(1)
  expect(planCalls).toBe(planCallsBeforeGateway)
})
