/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { encodeAbiParameters, encodeFunctionResult, getAbiItem, getEventSelector, padHex, toHex, type Hex } from 'viem'
import { NILSTORE_PRECOMPILE_ABI } from '../src/lib/nilstorePrecompile'

const routePath = process.env.E2E_PATH || '/#/dashboard'
const precompile = '0x0000000000000000000000000000000000000900'
const MDU_SIZE_BYTES = 8 * 1024 * 1024
const BLOB_SIZE_BYTES = 128 * 1024
const FILE_TABLE_START = 16 * BLOB_SIZE_BYTES
const FILE_TABLE_HEADER_SIZE = 128

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

function buildMdu0WithSingleFile(filePath: string, sizeBytes: number, startOffset: number): Buffer {
  const mdu0 = Buffer.alloc(MDU_SIZE_BYTES)
  mdu0.write('NILF', FILE_TABLE_START, 'utf8')
  mdu0.writeUInt32LE(1, FILE_TABLE_START + 8)
  const recordOffset = FILE_TABLE_START + FILE_TABLE_HEADER_SIZE
  mdu0.writeBigUInt64LE(BigInt(startOffset), recordOffset)
  mdu0.writeBigUInt64LE(BigInt(sizeBytes), recordOffset + 8)
  Buffer.from(filePath, 'utf8').copy(mdu0, recordOffset + 24, 0, 40)
  return mdu0
}

test('Deal Explorer: missing local index requires provider sync before file view', async ({ page }) => {
  test.setTimeout(180_000)

  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 20260211)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)

  const dealId = '1'
  const filePath = 'provider-base.txt'
  const fileBytes = Buffer.alloc(200_000, 0x61)
  const manifestRoot = '0xae5359579124255db62f04c55f1d1490655ed5479988a528bbca9f5a2245de9286452e5ffd8e76e05763c8241632c517'
  const staleManifestRoot = '0xacf62573f14c61cb28377b2ef465aeadbff23a96e6c5c4d06a938116487254df46078869c5312e694939ab59a59d607f'
  const manifestRootBase64 = Buffer.from(manifestRoot.slice(2), 'hex').toString('base64')
  const mdu0Bytes = buildMdu0WithSingleFile(filePath, fileBytes.length, 0)
  const witnessMduBytes = Buffer.alloc(MDU_SIZE_BYTES)

  const sessionId = (`0x${'99'.repeat(32)}` as Hex)
  const txOpen = (`0x${'22'.repeat(32)}` as Hex)
  const txConfirm = (`0x${'33'.repeat(32)}` as Hex)
  const computeResult = encodeFunctionResult({
    abi: NILSTORE_PRECOMPILE_ABI,
    functionName: 'computeRetrievalSessionIds',
    result: [['nil1provider'], [sessionId]],
  })

  let spFetchCalls = 0
  let openSessionCalls = 0
  let planCalls = 0
  let mduFetchCalls = 0
  let listFilesCalls = 0
  let badManifestRequests = 0

  await page.route('**/nilchain/nilchain/v1/deals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        deals: [
          {
            id: dealId,
            owner: nilAddress,
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

  await page.route(`**/nilchain/nilchain/v1/deals/${dealId}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        deal: {
          id: dealId,
          owner: nilAddress,
          manifest_root: manifestRootBase64,
          size: String(24 * 1024 * 1024),
          escrow_balance: '1000000',
          end_block: '1000',
          providers: ['nil1provider'],
        },
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

  await page.route('**/cosmos/bank/v1beta1/balances/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ balances: [{ denom: 'stake', amount: '1000' }], pagination: { total: '1' } }),
    })
  })

  await page.route('**/sp/retrieval/list-files/**', async (route) => {
    listFilesCalls += 1
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        files: [{ path: filePath, size_bytes: fileBytes.length, start_offset: 0, flags: 0 }],
      }),
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
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

  await page.route('**/sp/retrieval/plan/**', async (route) => {
    planCalls += 1
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
    mduFetchCalls += 1
    if (index === 0) {
      await route.fulfill({
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/octet-stream',
          'X-Nil-Mdu-Index': '0',
        },
        body: mdu0Bytes,
      })
      return
    }
    if (index === 1) {
      await route.fulfill({
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/octet-stream',
          'X-Nil-Mdu-Index': '1',
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
    openSessionCalls += 1
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'open-session should not be used for deal index sync' }),
    })
  })

  await page.route('**/sp/retrieval/fetch/**', async (route) => {
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
    spFetchCalls += 1
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ error: 'range too large', hint: 'range must be <= 131072' }),
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
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: computeResult }),
      })
    }

    if (method === 'eth_getTransactionReceipt') {
      const [hash] = payload?.params ?? []

      const openedTopic0 = getEventSelector(getAbiItem({ abi: NILSTORE_PRECOMPILE_ABI, name: 'RetrievalSessionOpened' }))
      const dealIdTopic = padHex(toHex(BigInt(dealId)), { size: 32 })
      const ownerTopic = padHex(account.address as Hex, { size: 32 })
      const event = getAbiItem({ abi: NILSTORE_PRECOMPILE_ABI, name: 'RetrievalSessionOpened' }) as any
      const openedData = encodeAbiParameters(
        event.inputs.filter((i: any) => !i.indexed),
        ['nil1provider', sessionId],
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

  await page.addInitScript(({ address, chainIdHex, txOpen, txConfirm, computeResult }) => {
    const w = window as any
    if (w.ethereum) return
    let sendCount = 0
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
            info: { uuid: 'test-uuid-provider-base', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
            provider: w.ethereum,
          },
        }),
      )
    }
    window.addEventListener('eip6963:requestProvider', announceProvider)
    announceProvider()
  }, { address: account.address, chainIdHex, txOpen, txConfirm, computeResult })

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
  await expect(page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('deal-index-sync-panel')).toHaveCount(0)

  expect(mduFetchCalls).toBeGreaterThan(0)
  expect(listFilesCalls).toBe(0)
  expect(spFetchCalls).toBe(0)
  expect(openSessionCalls).toBe(0)
  expect(planCalls).toBe(0)
  expect(badManifestRequests).toBe(0)
  await expect(page.getByTestId('deal-detail-file-list')).toContainText(filePath)
})
