/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { encodeAbiParameters, encodeFunctionResult, getAbiItem, getEventSelector, padHex, toHex, type Hex } from 'viem'
import { NILSTORE_PRECOMPILE_ABI } from '../src/lib/nilstorePrecompile'

const path = process.env.E2E_PATH || '/#/dashboard'
const precompile = '0x0000000000000000000000000000000000000900'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('Deal Explorer: stale browser cache does not bypass required provider sync', async ({ page }) => {
  test.setTimeout(180_000)

  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 20260211)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)

  const dealId = '1'
  const manifestRoot = `0x${'bb'.repeat(48)}`
  const staleManifestRoot = `0x${'cc'.repeat(48)}`
  const filePath = 'browser-network.txt'
  const fileBytes = Buffer.from('hello browser network')
  const staleCachedBytes = Buffer.from('stale browser cache bytes')

  const sessionId = (`0x${'99'.repeat(32)}` as Hex)
  const txOpen = (`0x${'22'.repeat(32)}` as Hex)
  const txConfirm = (`0x${'33'.repeat(32)}` as Hex)
  const computeResult = encodeFunctionResult({
    abi: NILSTORE_PRECOMPILE_ABI,
    functionName: 'computeRetrievalSessionIds',
    result: [['nil1provider'], [sessionId]],
  })

  let fetchCalls = 0
  let listFilesCalls = 0

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

  await page.route('**/nilchain/nilchain/v1/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
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

  await page.route('**/nilchain/nilchain/v1/proofs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ proof: [] }),
    })
  })

  await page.route('**/health', async (route) => {
    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'OK' })
  })
  await page.route('**/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        persona: 'user-gateway',
        mode: 'standalone',
        capabilities: { upload: true, fetch: true, list_files: true, slab: true, retrieval_plan: true, mode2_rs: true },
        deps: { lcd_reachable: true, sp_reachable: true },
        extra: { artifact_spec: 'mode2-artifacts-v1', rs_default: '2+1' },
      }),
    })
  })

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

  await page.route('**/gateway/slab/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(slabResponse),
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

  await page.route('**/gateway/list-files/**', async (route) => {
    listFilesCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        files: [{ path: filePath, size_bytes: fileBytes.length, start_offset: 0, flags: 0 }],
      }),
    })
  })
  await page.route('**/sp/retrieval/list-files/**', async (route) => {
    listFilesCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        files: [{ path: filePath, size_bytes: fileBytes.length, start_offset: 0, flags: 0 }],
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
  await page.route('**/gateway/mdu-kzg/**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'not implemented in test' }),
    })
  })

  await page.route('**/gateway/plan-retrieval-session/**', async (route) => {
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
  await page.route('**/sp/retrieval/plan/**', async (route) => {
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

  await page.route('**/gateway/fetch/**', async (route) => {
    fetchCalls += 1
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
  await page.route('**/sp/retrieval/fetch/**', async (route) => {
    fetchCalls += 1
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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true }),
    })
  })

  await page.route('**/*', async (route) => {
    const req = route.request()
    if (req.method() !== 'POST') return route.fallback()
    const url = req.url()
    if (!/8545/.test(url)) return route.fallback()

    const payload = JSON.parse(req.postData() || '{}') as any
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
      const [hash] = params ?? []

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
            info: { uuid: 'test-uuid-browser-network', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
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

  // Seed OPFS with a stale manifest root and stale browser file cache. The default Download
  // path must ignore this stale local cache and fetch the current bytes from the network.
  await page.evaluate(async ({ dealId, manifestRoot, filePath, cachedBytes }) => {
    async function sha256Hex(text: string): Promise<string> {
      const encoded = new TextEncoder().encode(text)
      const digest = await crypto.subtle.digest('SHA-256', encoded)
      return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
    }

    const root = await navigator.storage.getDirectory()
    const dealDir = await root.getDirectoryHandle(`deal-${dealId}`, { create: true })
    const writeFile = async (name: string, bytes: Uint8Array | string) => {
      const h = await dealDir.getFileHandle(name, { create: true })
      const w = await (h as any).createWritable()
      await w.write(bytes as any)
      await w.close()
    }
    await writeFile('manifest_root.txt', manifestRoot)
    const cacheName = `filecache_${await sha256Hex(filePath)}.bin`
    await writeFile(cacheName, new Uint8Array(cachedBytes as number[]))
  }, { dealId, manifestRoot: staleManifestRoot, filePath, cachedBytes: [...staleCachedBytes] })

  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('deal-detail')).toBeVisible({ timeout: 60_000 })

  await expect(page.getByTestId('deal-index-sync-panel')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('deal-index-sync-panel')).toContainText('Deal Index Required')
  await expect(page.getByTestId('deal-index-sync-panel')).toContainText(/stale|missing/i)
  await expect(page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`)).toHaveCount(0)
  expect(listFilesCalls).toBe(0)
  expect(fetchCalls).toBe(0)
})
