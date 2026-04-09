/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { encodeAbiParameters, encodeFunctionResult, getAbiItem, getEventSelector, padHex, toHex, type Hex } from 'viem'
import { POLYSTORE_PRECOMPILE_ABI } from '../src/lib/polystorePrecompile'

const routePath = process.env.E2E_PATH || '/#/dashboard'
const precompile = '0x0000000000000000000000000000000000000900'
const MDU_SIZE_BYTES = 8 * 1024 * 1024
const BLOB_SIZE_BYTES = 128 * 1024
const FILE_TABLE_START = 16 * BLOB_SIZE_BYTES
const FILE_TABLE_HEADER_SIZE = 128
const FILE_RECORD_SIZE = 256
const FILE_RECORD_PATH_BYTES = FILE_RECORD_SIZE - 24

function ethToPolystoreAddress(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

function buildMdu0WithSingleFile(filePath: string, sizeBytes: number, startOffset: number): Buffer {
  const mdu0 = Buffer.alloc(MDU_SIZE_BYTES)
  Buffer.alloc(32, 0x11).copy(mdu0, 0)
  Buffer.alloc(32, 0x22).copy(mdu0, 32)
  mdu0.write('NILF', FILE_TABLE_START, 'utf8')
  mdu0.writeUInt16LE(FILE_RECORD_SIZE, FILE_TABLE_START + 6)
  mdu0.writeUInt32LE(1, FILE_TABLE_START + 8)
  const recordOffset = FILE_TABLE_START + FILE_TABLE_HEADER_SIZE
  mdu0.writeBigUInt64LE(BigInt(startOffset), recordOffset)
  mdu0.writeBigUInt64LE(BigInt(sizeBytes), recordOffset + 8)
  Buffer.from(filePath, 'utf8').copy(mdu0, recordOffset + 24, 0, FILE_RECORD_PATH_BYTES)
  return mdu0
}

test('Deal Explorer: missing local index requires provider sync before file view', async ({ page }) => {
  test.setTimeout(180_000)

  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 20260211)
  const chainIdHex = `0x${chainId.toString(16)}`
  const polystoreAddress = ethToPolystoreAddress(account.address)

  const dealId = '1'
  const filePath = 'provider-base.txt'
  const fileBytes = Buffer.alloc(200_000, 0x61)
  const manifestRoot = '0x8ff695aac0697529a79325404267ef279f79dd7c4029de5062f70a5dc0abf335aa09c0fc39d5aec8c384a8a4e635eb63'
  const staleManifestRoot = '0xacf62573f14c61cb28377b2ef465aeadbff23a96e6c5c4d06a938116487254df46078869c5312e694939ab59a59d607f'
  const manifestRootBase64 = Buffer.from(manifestRoot.slice(2), 'hex').toString('base64')
  const mdu0Bytes = buildMdu0WithSingleFile(filePath, fileBytes.length, 0)
  const witnessMduBytes = Buffer.alloc(MDU_SIZE_BYTES)

  const sessionIds = [(`0x${'99'.repeat(32)}` as Hex), (`0x${'88'.repeat(32)}` as Hex)]
  const txOpen = (`0x${'22'.repeat(32)}` as Hex)
  const txConfirm = (`0x${'33'.repeat(32)}` as Hex)
  let mduFetchCalls = 0
  let badManifestRequests = 0
  let sessionlessMduRequests = 0
  let missingWindowParamRequests = 0
  const removedFreeEndpointUrls: string[] = []
  let computeSessionCallCount = 0

  await page.route('**/polystorechain/polystorechain/v1/deals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        deals: [
          {
            id: dealId,
            owner: polystoreAddress,
            cid: staleManifestRoot,
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
          owner: polystoreAddress,
          manifest_root: manifestRootBase64,
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

  // Simulate the gateway being reachable but not having the slab on disk.
  await page.route('**/gateway/slab/**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'slab not found on disk' }),
    })
  })
  await page.route('**/sp/retrieval/slab/**', async (route) => {
    removedFreeEndpointUrls.push(route.request().url())
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'removed free retrieval endpoint' }),
    })
  })
  await page.route('**/gateway/manifest-info/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        manifest_root: manifestRoot,
        manifest_blob_hex: `0x${'00'.repeat(48)}`,
        total_mdus: 3,
        witness_mdus: 1,
        user_mdus: 1,
        roots: [],
      }),
    })
  })
  await page.route('**/sp/retrieval/manifest-info/**', async (route) => {
    removedFreeEndpointUrls.push(route.request().url())
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'removed free retrieval endpoint' }),
    })
  })

  await page.route('**/sp/retrieval/plan/**', async (route) => {
    removedFreeEndpointUrls.push(route.request().url())
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'removed free retrieval endpoint' }),
    })
  })

  await page.route('**/sp/retrieval/mdu/**', async (route) => {
    if (route.request().url().includes(staleManifestRoot)) {
      badManifestRequests += 1
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'invalid manifest_root' }),
      })
      return
    }
    const url = new URL(route.request().url())
    const parts = url.pathname.split('/')
    const index = Number(parts[parts.length - 1] || -1)
    const startBlobIndex = url.searchParams.get('start_blob_index')
    const blobCount = url.searchParams.get('blob_count')
    const sessionId = route.request().headers()['x-polystore-session-id']
    if (!sessionId) {
      sessionlessMduRequests += 1
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'missing X-PolyStore-Session-Id' }),
      })
      return
    }
    if (startBlobIndex !== '0' || blobCount !== '64') {
      missingWindowParamRequests += 1
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'retrieval session does not match request', hint: 'start_blob_index mismatch' }),
      })
      return
    }
    mduFetchCalls += 1
    if (index === 0) {
      expect(sessionId).toBe(sessionIds[0])
      await route.fulfill({
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/octet-stream',
          'X-PolyStore-Mdu-Index': '0',
        },
        body: mdu0Bytes,
      })
      return
    }
    if (index === 1) {
      expect(sessionId).toBe(sessionIds[1])
      await route.fulfill({
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/octet-stream',
          'X-PolyStore-Mdu-Index': '1',
        },
        body: witnessMduBytes,
      })
      return
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'mdu not found' }),
    })
  })

  await page.route('**/sp/retrieval/open-session/**', async (route) => {
    removedFreeEndpointUrls.push(route.request().url())
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'removed free retrieval endpoint' }),
    })
  })

  await page.route('**/sp/retrieval/fetch/**', async (route) => {
    removedFreeEndpointUrls.push(route.request().url())
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'removed free retrieval endpoint' }),
    })
  })

  await page.route('**/gateway/session-proof**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true }),
    })
  })

  // EVM RPC mocks (same approach as other specs).
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
      computeSessionCallCount += 1
      const computeResult = encodeFunctionResult({
        abi: POLYSTORE_PRECOMPILE_ABI,
        functionName: 'computeRetrievalSessionIds',
        result: [['nil1provider'], [sessionIds[Math.min(computeSessionCallCount - 1, sessionIds.length - 1)]]],
      })
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: computeResult }),
      })
    }

    if (method === 'eth_getTransactionReceipt') {
      const [hash] = payload?.params ?? []

      const openedTopic0 = getEventSelector(getAbiItem({ abi: POLYSTORE_PRECOMPILE_ABI, name: 'RetrievalSessionOpened' }))
      const dealIdTopic = padHex(toHex(BigInt(dealId)), { size: 32 })
      const ownerTopic = padHex(account.address as Hex, { size: 32 })
      const event = getAbiItem({ abi: POLYSTORE_PRECOMPILE_ABI, name: 'RetrievalSessionOpened' }) as any
      const openedData = encodeAbiParameters(
        event.inputs.filter((i: any) => !i.indexed),
            ['nil1provider', sessionIds[0]],
      )

      if (String(hash || '').toLowerCase() === txOpen.toLowerCase()) {
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
      if (String(hash || '').toLowerCase() === txConfirm.toLowerCase()) {
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
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }) })
    }

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }),
    })
  })

  await page.addInitScript(({ address, chainIdHex, txOpen, txConfirm, sessionIds }) => {
    const w = window as any
    if (w.ethereum) return
    let sendCount = 0
    let computeCount = 0
    w.ethereum = {
      isMetaMask: true,
      selectedAddress: address,
      on: () => {},
      removeListener: () => {},
      async request(args: any) {
        const method = args?.method
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [address]
          case 'eth_chainId':
            return chainIdHex
          case 'net_version':
            return String(parseInt(chainIdHex, 16))
          case 'eth_call':
            computeCount += 1
            return encodeFunctionResult({
              abi: POLYSTORE_PRECOMPILE_ABI,
              functionName: 'computeRetrievalSessionIds',
              result: [['nil1provider'], [sessionIds[Math.min(computeCount - 1, sessionIds.length - 1)]]],
            })
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
            info: { uuid: 'test-uuid-provider-base', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
            provider: w.ethereum,
          },
        }),
      )
    }
    window.addEventListener('eip6963:requestProvider', announceProvider)
    announceProvider()
  }, { address: account.address, chainIdHex, txOpen, txConfirm, sessionIds })

  await page.goto(routePath)

  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible())) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('deal-detail')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('deal-index-sync-panel')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('deal-index-sync-panel')).toContainText('Deal Index Required')
  await expect(page.getByTestId('deal-detail-file-list')).toHaveCount(0)

  await page.getByTestId('deal-index-sync-button').click()
  await expect(page.getByTestId('deal-index-sync-panel')).toHaveAttribute('data-sync-status', 'syncing')
  const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)
  await expect(fileRow).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('deal-index-sync-panel')).toHaveCount(0)

  expect(mduFetchCalls).toBeGreaterThan(0)
  expect(sessionlessMduRequests).toBe(0)
  expect(missingWindowParamRequests).toBe(0)
  expect(removedFreeEndpointUrls).toEqual([])
  expect(badManifestRequests).toBe(0)
  await expect(page.getByTestId('deal-detail-file-list')).toContainText(filePath)

  const routeLabel = page.getByTestId('transport-route')
  const cacheSourceLabel = page.getByTestId('transport-cache-source')
  const downloadButton = page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`)
  const mduFetchCallsBeforeDownload = mduFetchCalls
  const removedRoutesBeforeDownload = removedFreeEndpointUrls.length
  const download = page.waitForEvent('download', { timeout: 60_000 })
  await downloadButton.click()
  const saved = await download
  expect(saved.suggestedFilename()).toBe(filePath)
  expect(mduFetchCalls).toBe(mduFetchCallsBeforeDownload)
  expect(removedFreeEndpointUrls.length).toBe(removedRoutesBeforeDownload)
  await expect(fileRow).toHaveAttribute('data-cache-browser', 'yes')
  await expect(routeLabel).toContainText(/browser mdu cache/i)
  await expect(cacheSourceLabel).toContainText(/browser_mdu_cache/i)
})
