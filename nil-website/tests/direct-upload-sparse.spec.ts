/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'

const path = process.env.E2E_PATH || '/#/dashboard'
const uploadSizeBytes = Number(process.env.SPARSE_FILE_SIZE_BYTES || 192 * 1024)
const largeUploadTimeoutMs = uploadSizeBytes > 32 * 1024 * 1024 ? 900_000 : 30_000
const capturePreparePerf = process.env.CAPTURE_PREPARE_PERF === '1'
const stopAfterPreparePerf = process.env.STOP_AFTER_PREPARE_PERF === '1'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('Thick Client: no-gateway Mode 2 browser upload sends sparse MDU, manifest, and shard bodies', async ({ page }, testInfo) => {
  test.setTimeout(uploadSizeBytes > 50 * 1024 * 1024 ? 900_000 : 300_000)

  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 20260211)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)

  const mduUploads: Array<{ bodyLen: number; fullSize: number | null; mduIndex: string }> = []
  const manifestUploads: Array<{ bodyLen: number; fullSize: number | null }> = []
  const shardUploads: Array<{ bodyLen: number; fullSize: number | null; mduIndex: string; slot: string }> = []
  let gatewayUploadAttempts = 0
  let gatewayProbeAttempts = 0
  let activeUploads = 0
  let peakActiveUploads = 0
  const perf = {
    user: [] as unknown[],
    witness: [] as unknown[],
    meta: null as unknown,
    manifest: null as unknown,
    totals: null as unknown,
    profile: null as unknown,
  }

  page.on('console', async (msg) => {
    const text = msg.text()
    if (!capturePreparePerf || !text.includes('[perf]')) return
    const values: unknown[] = []
    for (const arg of msg.args()) {
      try {
        values.push(await arg.jsonValue())
      } catch {
        values.push(String(arg))
      }
    }
    const payload = values[1] ?? null
    if (text.includes('[perf] user mdu')) perf.user.push(payload)
    else if (text.includes('[perf] witness mdu')) perf.witness.push(payload)
    else if (text.includes('[perf] meta mdu0')) perf.meta = payload
    else if (text.includes('[perf] manifest aggregation')) perf.manifest = payload
    else if (text.includes('[perf] sharding totals')) perf.totals = payload
    else if (text.includes('[perf] prepare profile')) perf.profile = payload
  })

  async function recordConcurrentUpload<T>(fn: () => Promise<T>): Promise<T> {
    activeUploads += 1
    peakActiveUploads = Math.max(peakActiveUploads, activeUploads)
    await page.waitForTimeout(75)
    try {
      return await fn()
    } finally {
      activeUploads -= 1
    }
  }

  await page.route('**/gateway/upload*', async (route) => {
    gatewayUploadAttempts += 1
    await route.fulfill({ status: 599, body: 'gateway disabled in sparse e2e' })
  })

  await page.route('**/gateway/upload-status*', async (route) => {
    gatewayUploadAttempts += 1
    await route.fulfill({ status: 599, body: 'gateway disabled in sparse e2e' })
  })

  const failGatewayProbe = async (route: import('@playwright/test').Route) => {
    gatewayProbeAttempts += 1
    await route.fulfill({ status: 503, body: 'gateway unavailable in sparse e2e' })
  }

  await page.route('http://127.0.0.1:8080/status', failGatewayProbe)
  await page.route('http://127.0.0.1:8080/health', failGatewayProbe)
  await page.route('http://localhost:8080/status', failGatewayProbe)
  await page.route('http://localhost:8080/health', failGatewayProbe)

  await page.route('**/sp/upload_mdu', async (route) => {
    const headers = route.request().headers()
    const body = route.request().postDataBuffer() || Buffer.alloc(0)
    const fullSizeHeader = headers['x-nil-full-size']
    mduUploads.push({
      bodyLen: body.length,
      fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
      mduIndex: headers['x-nil-mdu-index'] || '',
    })
    return recordConcurrentUpload(() => route.fulfill({ status: 200, body: 'OK' }))
  })

  await page.route('**/sp/upload_manifest', async (route) => {
    const headers = route.request().headers()
    const body = route.request().postDataBuffer() || Buffer.alloc(0)
    const fullSizeHeader = headers['x-nil-full-size']
    manifestUploads.push({
      bodyLen: body.length,
      fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
    })
    return recordConcurrentUpload(() => route.fulfill({ status: 200, body: 'OK' }))
  })

  await page.route('**/sp/upload_shard', async (route) => {
    const headers = route.request().headers()
    const body = route.request().postDataBuffer() || Buffer.alloc(0)
    const fullSizeHeader = headers['x-nil-full-size']
    shardUploads.push({
      bodyLen: body.length,
      fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
      mduIndex: headers['x-nil-mdu-index'] || '',
      slot: headers['x-nil-slot'] || '',
    })
    return recordConcurrentUpload(() => route.fulfill({ status: 200, body: 'OK' }))
  })

  await page.route('**://localhost:8545/**', async (route) => {
    const req = route.request()
    const payload = JSON.parse(req.postData() || '{}') as any
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
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: '0x1' }),
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
      return route.fulfill({
        status: 200,
        body: JSON.stringify({ heat: { bytes_served: '0' } }),
      })
    }

    const deal = {
      id: '1',
      owner: nilAddress,
      cid: '',
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
      return route.fulfill({
        status: 200,
        body: JSON.stringify({ deal }),
      })
    }

    return route.fulfill({
      status: 200,
      body: JSON.stringify({ deals: [deal] }),
    })
  })

  await page.route('**/nilchain/nilchain/v1/providers**', async (route) => {
    return route.fulfill({
      status: 200,
      body: JSON.stringify({
        providers: [
          { address: 'nil1providera', endpoints: ['/ip4/127.0.0.1/tcp/8091/http'] },
          { address: 'nil1providerb', endpoints: ['/ip4/127.0.0.1/tcp/8092/http'] },
          { address: 'nil1providerc', endpoints: ['/ip4/127.0.0.1/tcp/8093/http'] },
        ],
      }),
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

  await page.route('**/cosmos/bank/v1beta1/balances/*', async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ balances: [{ denom: 'stake', amount: '1000' }], pagination: { total: '1' } }),
    })
  })

  await page.goto(path)
  await expect.poll(() => gatewayProbeAttempts, { timeout: 60_000 }).toBeGreaterThan(0)

  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible().catch(() => false))) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }
  await expect(page.getByText('Wrong Network')).toHaveCount(0)

  const dealRow = page.getByTestId('deal-row-1')
  await expect(dealRow).toBeVisible({ timeout: 60_000 })
  await dealRow.click()
  await expect(page.getByTestId('mdu-file-input')).toBeAttached({
    timeout: uploadSizeBytes > 50 * 1024 * 1024 ? 120_000 : 30_000,
  })

  if (uploadSizeBytes > 50 * 1024 * 1024) {
    const uploadPath = testInfo.outputPath('direct-sparse.bin')
    await fs.writeFile(uploadPath, crypto.randomBytes(uploadSizeBytes))
    await page.getByTestId('mdu-file-input').setInputFiles(uploadPath)
  } else {
    await page.getByTestId('mdu-file-input').setInputFiles({
      name: 'direct-sparse.txt',
      mimeType: 'application/octet-stream',
      buffer: crypto.randomBytes(uploadSizeBytes),
    })
  }

  if (stopAfterPreparePerf) {
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            return (window as Window & { __nilPreparePerf?: unknown }).__nilPreparePerf ?? null
          }),
        {
          timeout: uploadSizeBytes > 50 * 1024 * 1024 ? 900_000 : 120_000,
        },
      )
      .not.toBeNull()

    const prepareProfile = await page.evaluate(() => {
      return (window as Window & { __nilPreparePerf?: unknown }).__nilPreparePerf ?? null
    })
    console.log('[direct sparse prepare profile]', prepareProfile)
    console.log('[direct sparse prepare profile json]', JSON.stringify(prepareProfile))
    return
  }

  await expect(page.getByTestId('mdu-upload-card')).not.toHaveAttribute('data-panel-state', 'idle', { timeout: 60_000 })
  await expect(page.getByTestId('mdu-upload-state')).toHaveText(/Upload Complete/i, {
    timeout: largeUploadTimeoutMs,
  })

  expect(mduUploads.length).toBeGreaterThan(0)
  expect(manifestUploads.length).toBeGreaterThan(0)
  expect(shardUploads.length).toBeGreaterThan(0)
  expect(gatewayUploadAttempts).toBe(0)
  expect(gatewayProbeAttempts).toBeGreaterThan(0)

  const sparseMduUploads = mduUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)
  const sparseManifestUploads = manifestUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)
  const sparseShardUploads = shardUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)

  console.log('[direct sparse upload evidence]', {
    uploadSizeBytes,
    gatewayProbeAttempts,
    mduUploads,
    manifestUploads,
    shardUploads,
    peakActiveUploads,
    perf,
  })

  expect(sparseMduUploads.length).toBeGreaterThan(0)
  expect(sparseManifestUploads.length).toBeGreaterThan(0)
  expect(sparseShardUploads.length).toBeGreaterThan(0)
  expect(peakActiveUploads).toBeGreaterThan(1)
  expect(
    Math.max(...sparseMduUploads.map((upload) => upload.bodyLen / Math.max(1, upload.fullSize || 1))),
  ).toBeLessThan(0.35)
  if (capturePreparePerf) {
    expect(perf.profile).toBeTruthy()
    expect((perf.profile as { phases?: { workerCommitMs?: number; workerExpandMs?: number } }).phases?.workerCommitMs ?? 0).toBeGreaterThanOrEqual(0)
    expect((perf.profile as { phases?: { workerExpandMs?: number } }).phases?.workerExpandMs ?? 0).toBeGreaterThanOrEqual(0)
  }
})
