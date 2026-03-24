/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { encodeFunctionResult, type Hex } from 'viem'

import { NILSTORE_PRECOMPILE_ABI } from '../src/lib/nilstorePrecompile'

const path = process.env.E2E_PATH || '/#/dashboard'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

async function readActiveManifestRoot(page: import('@playwright/test').Page, dealId: string): Promise<string> {
  return page.evaluate(async (targetDealId) => {
    const root = await navigator.storage.getDirectory()
    const dealDir = await root.getDirectoryHandle(`deal-${targetDealId}`, { create: false })
    let storageDir = dealDir
    try {
      const activeHandle = await dealDir.getFileHandle('active_generation.txt', { create: false })
      const activeText = (await (await activeHandle.getFile()).text()).trim()
      if (activeText) {
        const generationsDir = await dealDir.getDirectoryHandle('generations', { create: false })
        storageDir = await generationsDir.getDirectoryHandle(activeText, { create: false })
      }
    } catch {
      // Older layouts may store artifacts directly in the deal root.
    }
    const fh = await storageDir.getFileHandle('manifest_root.txt', { create: false })
    return (await (await fh.getFile()).text()).trim()
  }, dealId)
}

async function clearDealOpfs(page: import('@playwright/test').Page, dealId: string): Promise<void> {
  await page.evaluate(async (targetDealId) => {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(`deal-${targetDealId}`, { recursive: true }).catch(() => undefined)
  }, dealId)
}

async function readActiveSlabMetadata(
  page: import('@playwright/test').Page,
  dealId: string,
): Promise<{ manifest_root: string; file_records: Array<{ path: string; size_bytes: number; start_offset: number }> }> {
  return page.evaluate(async (targetDealId) => {
    const root = await navigator.storage.getDirectory()
    const dealDir = await root.getDirectoryHandle(`deal-${targetDealId}`, { create: false })
    let storageDir = dealDir
    try {
      const activeHandle = await dealDir.getFileHandle('active_generation.txt', { create: false })
      const activeText = (await (await activeHandle.getFile()).text()).trim()
      if (activeText) {
        const generationsDir = await dealDir.getDirectoryHandle('generations', { create: false })
        storageDir = await generationsDir.getDirectoryHandle(activeText, { create: false })
      }
    } catch {
      // Older layouts may store artifacts directly in the deal root.
    }
    const fh = await storageDir.getFileHandle('slab_meta.json', { create: false })
    return JSON.parse(await (await fh.getFile()).text())
  }, dealId)
}

async function waitForActiveSlabMetadata(
  page: import('@playwright/test').Page,
  dealId: string,
): Promise<{ manifest_root: string; file_records: Array<{ path: string; size_bytes: number; start_offset: number }> }> {
  await expect
    .poll(async () => {
      try {
        const meta = await readActiveSlabMetadata(page, dealId)
        return JSON.stringify(meta)
      } catch {
        return null
      }
    }, { timeout: 30_000 })
    .not.toBeNull()

  return await readActiveSlabMetadata(page, dealId)
}

test('Thick Client: fresh browser bootstraps committed slab before Mode 2 append', async ({ page }) => {
  test.setTimeout(300_000)

  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 20260211)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)

  const dealId = '1'
  const fileA = { name: 'bootstrap-a.bin', buffer: crypto.randomBytes(48 * 1024) }
  const fileB = { name: 'bootstrap-b.bin', buffer: crypto.randomBytes(40 * 1024) }

  let dealCid = ''
  let retrievalListCalls = 0
  let retrievalPlanCalls = 0
  let retrievalFetchCalls = 0
  let gatewayProbeAttempts = 0
  let uploadManifestCalls = 0
  const uploadPreviousRoots: string[] = []
  const uploadedShardIndices: number[] = []

  const sessionId = (`0x${'99'.repeat(32)}` as Hex)
  const computeResult = encodeFunctionResult({
    abi: NILSTORE_PRECOMPILE_ABI,
    functionName: 'computeRetrievalSessionIds',
    result: [['nil1providera'], [sessionId]],
  })

  await page.route('**/gateway/upload*', async (route) => {
    await route.fulfill({ status: 599, body: 'gateway disabled in bootstrap append e2e' })
  })
  await page.route('**/gateway/upload-status*', async (route) => {
    await route.fulfill({ status: 599, body: 'gateway disabled in bootstrap append e2e' })
  })

  const failGatewayProbe = async (route: import('@playwright/test').Route) => {
    gatewayProbeAttempts += 1
    await route.fulfill({ status: 503, body: 'gateway unavailable in bootstrap append e2e' })
  }
  await page.route('http://127.0.0.1:8080/status', failGatewayProbe)
  await page.route('http://127.0.0.1:8080/health', failGatewayProbe)
  await page.route('http://localhost:8080/status', failGatewayProbe)
  await page.route('http://localhost:8080/health', failGatewayProbe)

  await page.route('**/sp/upload_mdu', async (route) => {
    uploadPreviousRoots.push(route.request().headers()['x-nil-previous-manifest-root'] || '')
    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'OK' })
  })
  await page.route('**/sp/upload_manifest', async (route) => {
    uploadManifestCalls += 1
    uploadPreviousRoots.push(route.request().headers()['x-nil-previous-manifest-root'] || '')
    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'OK' })
  })
  await page.route('**/sp/upload_shard', async (route) => {
    uploadPreviousRoots.push(route.request().headers()['x-nil-previous-manifest-root'] || '')
    const rawIndex = route.request().headers()['x-nil-mdu-index']
    const parsedIndex = Number(rawIndex)
    if (Number.isInteger(parsedIndex)) uploadedShardIndices.push(parsedIndex)
    await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'OK' })
  })

  await page.route('**/sp/retrieval/list-files/**', async (route) => {
    retrievalListCalls += 1
    const url = new URL(route.request().url())
    const manifestRoot = decodeURIComponent(url.pathname.split('/').pop() || '')
    if (!dealCid || manifestRoot.toLowerCase() !== dealCid.toLowerCase()) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ files: [] }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        files: [
          {
            path: fileA.name,
            size_bytes: fileA.buffer.length,
            start_offset: 0,
            flags: 0,
            cache_present: true,
          },
        ],
      }),
    })
  })

  await page.route('**/sp/retrieval/plan/**', async (route) => {
    retrievalPlanCalls += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        deal_id: Number(dealId),
        owner: nilAddress,
        provider: 'nil1providera',
        manifest_root: dealCid,
        file_path: fileA.name,
        range_start: 0,
        range_len: fileA.buffer.length,
        start_mdu_index: 2,
        start_blob_index: 0,
        blob_count: 1,
      }),
    })
  })

  await page.route('**/sp/retrieval/fetch/**', async (route) => {
    retrievalFetchCalls += 1
    await route.fulfill({
      status: 206,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Nil-Provider',
        'Content-Type': 'application/octet-stream',
        'X-Nil-Provider': 'nil1providera',
      },
      body: fileA.buffer,
    })
  })

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
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: payload?.id ?? 1,
          result: {
            transactionHash: '0x' + '44'.repeat(32),
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
  })

  await page.route('**/nilchain/nilchain/v1/deals**', async (route) => {
    const url = route.request().url()
    if (url.includes('/heat')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ heat: { bytes_served: '0' } }),
      })
      return
    }

    const deal = {
      id: dealId,
      owner: nilAddress,
      cid: dealCid,
      size: '0',
      escrow_balance: '1000000',
      end_block: '1000',
      providers: ['nil1providera', 'nil1providerb', 'nil1providerc'],
    }

    let pathname = url
    try {
      pathname = new URL(url).pathname
    } catch {
      // ignore
    }
    if (/\/nilchain\/nilchain\/v1\/deals\/[0-9]+$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ deal }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ deals: [deal] }),
    })
  })

  await page.route('**/nilchain/nilchain/v1/providers**', async (route) => {
    await route.fulfill({
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
      isNilStoreE2E: true,
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
          case 'eth_sendTransaction': return '0x' + '44'.repeat(32)
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

  await page.goto(path)
  await expect.poll(() => gatewayProbeAttempts, { timeout: 60_000 }).toBeGreaterThan(0)

  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible().catch(() => false))) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }
  await expect(page.getByText('Wrong Network')).toHaveCount(0)

  const dealRow = page.getByTestId(`deal-row-${dealId}`)
  const commitBtn = page.getByTestId('mdu-commit')

  await expect(dealRow).toBeVisible({ timeout: 60_000 })
  await dealRow.click()
  await expect(page.getByTestId('mdu-file-input')).toBeAttached({ timeout: 30_000 })

  await page.getByTestId('mdu-file-input').setInputFiles({
    name: fileA.name,
    mimeType: 'text/plain',
    buffer: fileA.buffer,
  })
  await expect(page.getByTestId('mdu-upload-state')).toHaveText(/Upload Complete/i, { timeout: 60_000 })
  await expect(commitBtn).toBeEnabled({ timeout: 60_000 })
  await commitBtn.click()
  await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 60_000 })
  await expect(page.getByText('Saved MDUs locally (OPFS)')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => uploadManifestCalls, { timeout: 60_000 }).toBeGreaterThan(0)

  dealCid = await readActiveManifestRoot(page, dealId)
  expect(dealCid).toMatch(/^0x[0-9a-f]{96}$/i)

  await clearDealOpfs(page, dealId)
  await page.reload({ waitUntil: 'networkidle' })

  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible().catch(() => false))) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  await expect(page.getByTestId(`deal-row-${dealId}`)).toBeVisible({ timeout: 60_000 })
  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('mdu-file-input')).toBeAttached({ timeout: 30_000 })

  const listCallsBeforeAppend = retrievalListCalls
  const planCallsBeforeAppend = retrievalPlanCalls
  const fetchCallsBeforeAppend = retrievalFetchCalls

  await page.getByTestId('mdu-file-input').setInputFiles({
    name: fileB.name,
    mimeType: 'text/plain',
    buffer: fileB.buffer,
  })

  const activity = page.locator('div').filter({ hasText: 'System Activity' }).first()
  await expect(activity).toContainText('local slab missing/stale; bootstrapping committed slab from provider retrieval', {
    timeout: 60_000,
  })
  await expect(activity).toContainText('Mode 2 append: bootstrapped 1 committed user MDUs from provider retrieval.', {
    timeout: 60_000,
  })
  await expect(page.getByTestId('mdu-upload-state')).toHaveText(/Upload Complete/i, { timeout: 60_000 })
  await expect(commitBtn).toBeEnabled({ timeout: 60_000 })
  await commitBtn.click()
  await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 60_000 })
  await expect(page.getByText('Saved MDUs locally (OPFS)')).toBeVisible({ timeout: 60_000 })

  expect(retrievalListCalls - listCallsBeforeAppend).toBeGreaterThan(0)
  expect(retrievalPlanCalls - planCallsBeforeAppend).toBeGreaterThan(0)
  expect(retrievalFetchCalls - fetchCallsBeforeAppend).toBeGreaterThan(0)

  const slabMeta = await waitForActiveSlabMetadata(page, dealId)
  const filePaths = slabMeta.file_records.map((file) => file.path).sort()
  expect(filePaths).toEqual([fileA.name, fileB.name].sort())
  expect(slabMeta.manifest_root).toMatch(/^0x[0-9a-f]{96}$/i)
  expect(uploadPreviousRoots).toContain(dealCid)
  // The append generation must upload shards for both the carried-forward user
  // MDU and the newly appended user MDU. Otherwise old files disappear once the
  // previous generation is cleaned up.
  expect(uploadedShardIndices.filter((idx) => idx === 2).length).toBeGreaterThan(0)
  expect(uploadedShardIndices.filter((idx) => idx === 3).length).toBeGreaterThan(0)
})
