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

async function streamToBuffer(stream: NodeJS.ReadableStream | null): Promise<Buffer> {
  if (!stream) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of stream as any) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test('Deal Explorer: SP download uses SP base when gateway slab missing', async ({ page }) => {
  test.setTimeout(180_000)

  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 31337)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)

  const dealId = '1'
  const manifestRoot = `0x${'aa'.repeat(48)}`
  const filePath = 'provider-base.txt'
  const fileBytes = Buffer.from('hello from provider base')

  const sessionId = (`0x${'99'.repeat(32)}` as Hex)
  const txOpen = (`0x${'22'.repeat(32)}` as Hex)
  const txConfirm = (`0x${'33'.repeat(32)}` as Hex)
  const computeResult = encodeFunctionResult({
    abi: NILSTORE_PRECOMPILE_ABI,
    functionName: 'computeRetrievalSessions',
    result: [{ provider: 'nil1provider', sessionId }],
  })

  let gatewayPlanCalls = 0
  let spPlanCalls = 0
  let gatewayProofCalls = 0
  let spProofCalls = 0

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

  // File list: shown even if gateway slab is missing.
  await page.route('**/gateway/list-files/**', async (route) => {
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

  // Plan-retrieval-session must go to the SP base (8082), not the gateway base (8080).
  await page.route('**/gateway/plan-retrieval-session/**', async (route) => {
    const url = route.request().url()
    if (url.includes(':8080/')) {
      gatewayPlanCalls += 1
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'slab not found on disk' }),
      })
    }
    if (url.includes(':8082/')) {
      spPlanCalls += 1
      return route.fulfill({
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
    }
    return route.fulfill({ status: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'unexpected plan url' })
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

  await page.goto(path)

  if (!(await page.getByTestId('wallet-address').isVisible())) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.getByTestId('wallet-address')).toBeVisible()
  }

  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('deal-detail')).toBeVisible({ timeout: 60_000 })

  // Trigger SP download (wallet interactive).
  const downloadButton = page.locator(`[data-testid="deal-detail-download-sp"][data-file-path="${filePath}"]`)
  await expect(downloadButton).toBeVisible({ timeout: 60_000 })
  const download = page.waitForEvent('download', { timeout: 60_000 })
  await downloadButton.click()
  const dl = await download
  expect(await streamToBuffer(await dl.createReadStream())).toEqual(fileBytes)

  expect(spPlanCalls).toBeGreaterThan(0)
  expect(gatewayPlanCalls).toBe(0)
  expect(gatewayProofCalls).toBeGreaterThan(0)
  expect(spProofCalls).toBe(0)
})
