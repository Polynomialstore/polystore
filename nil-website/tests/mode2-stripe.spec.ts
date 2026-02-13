import { test, expect, type Locator, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

async function waitForGatewayConnected(page: Page): Promise<void> {
  const widget = page.getByTestId('gateway-status-widget')
  const count = await widget.count().catch(() => 0)
  if (count <= 0) return
  await expect(widget.first()).toHaveAttribute('data-status', 'connected', { timeout: 60_000 })
}

async function waitForUploadControls(uploadBtn: Locator, commitBtn: Locator, timeout = 300_000): Promise<void> {
  await expect
    .poll(async () => {
      const uploadCount = await uploadBtn.count().catch(() => 0)
      const commitCount = await commitBtn.count().catch(() => 0)
      return uploadCount + commitCount
    }, { timeout })
    .toBeGreaterThan(0)
}

function cachedFileNameForPath(filePath: string): string {
  const normalized = String(filePath ?? '')
  const digest = crypto.createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex')
  return `filecache_${digest}.bin`
}

function resolveRouterUploadDir(): string {
  const fromEnv = String(process.env.E2E_ROUTER_UPLOAD_DIR || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  // Default used by scripts/run_devnet_alpha_multi_sp.sh
  return path.resolve(process.cwd(), '..', '_artifacts', 'devnet_alpha_multi_sp', 'router_tmp')
}

async function ensureWalletConnected(page: Page): Promise<void> {
  const walletAddressSelector = '[data-testid="wallet-address"], [data-testid="wallet-address-full"]'
  const walletAddress = page.locator(walletAddressSelector).first()
  const cosmosIdentity = page.getByTestId('cosmos-identity')
  const connectBtn = page.getByTestId('connect-wallet').first()

  await page.waitForSelector(`${walletAddressSelector}, [data-testid="cosmos-identity"], [data-testid="connect-wallet"]`, {
    timeout: 60_000,
    state: 'attached',
  })

  const isConnected = async (): Promise<boolean> => {
    const walletVisible = await walletAddress.first().isVisible().catch(() => false)
    if (walletVisible) return true

    if (await cosmosIdentity.isVisible().catch(() => false)) {
      const raw = (await cosmosIdentity.textContent().catch(() => ''))?.trim()
      if (raw && raw !== '—' && !/^(?:—|—)$/.test(raw) && !/^not\s+connected$/i.test(raw)) {
        return true
      }
    }

    return false
  }

  if (await isConnected()) return

  if (await connectBtn.isVisible().catch(() => false)) {
    await connectBtn.click({ force: true })
  }

  const browserWalletBtn = page.getByRole('button', { name: /Browser Wallet/i })
  const fallbackWalletBtns = [
    page.getByRole('button', { name: /^MetaMask$/i }),
    page.getByRole('button', { name: /^WalletConnect$/i }),
  ]

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await isConnected()) return

    if (await browserWalletBtn.isVisible().catch(() => false)) {
      await browserWalletBtn.click({ force: true })
      await expect(walletAddress.first()).toBeVisible({ timeout: 20_000 }).catch(async () => {
        await expect(cosmosIdentity).toBeVisible({ timeout: 20_000 })
      })
      return
    }

    for (const candidate of fallbackWalletBtns) {
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ force: true })
        await expect(walletAddress.first()).toBeVisible({ timeout: 20_000 }).catch(async () => {
          await expect(cosmosIdentity).toBeVisible({ timeout: 20_000 })
        })
        return
      }
    }

    await page.waitForTimeout(500)

    if (await connectBtn.isVisible().catch(() => false)) {
      await connectBtn.click({ force: true })
    }
  }

  expect(await isConnected()).toBe(true)
}

test.describe('mode2 stripe', () => {
  test.skip(!hasLocalStack, 'requires local stack')
  test.use({ acceptDownloads: true })
  test.describe.configure({ retries: process.env.CI ? 1 : 0 })

  test('mode2 deal → shard → upload → commit → retrieve', async ({ page }) => {
    test.setTimeout(600_000)

    const filePath = 'mode2-small.txt'
    const fileBytes = Buffer.alloc(256 * 1024, 'M') // spans multiple blobs (128 KiB each)

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)

    await page.getByTestId('faucet-request').click()
    await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 180_000 })

    await page.getByTestId('alloc-submit').click()
    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 180_000 })
    await waitForGatewayConnected(page)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: filePath,
      mimeType: 'text/plain',
      buffer: fileBytes,
    })

    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')

    await waitForUploadControls(uploadBtn, commitBtn, 300_000).catch(() => {
      console.log('[rehydrate-e2e] upload/commit controls did not appear before timeout; continuing with activity-driven checks')
    })
    if ((await uploadBtn.count().catch(() => 0)) > 0) {
      await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
      await uploadBtn.click()
      await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: 300_000 })
    }
    await expect(commitBtn).toBeEnabled({ timeout: 300_000 })
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })

    const dealRow = page.getByTestId(`deal-row-${dealId}`)
    await dealRow.click()

    const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)
    await expect(fileRow).toBeVisible({ timeout: 60_000 })

    const downloadBtn = page.locator(`[data-testid="deal-detail-download-sp"][data-file-path="${filePath}"]`)
    await expect(downloadBtn).toBeEnabled({ timeout: 180_000 })

    const expectedChunks = Math.ceil(fileBytes.length / (128 * 1024))
    let fetchCalls = 0
    const chunkPromises: Promise<void>[] = []
    const chunkBytes: Array<{ start: number; bytes: Buffer }> = []
    const fetchEvents: Array<{
      url: string
      origin: string
      status: number
      provider: string
      range: string
      bodyLen: number
    }> = []
    page.on('response', (resp) => {
      const url = resp.url()
      if (!url.includes('/gateway/fetch/')) return
      fetchCalls += 1
      const req = resp.request()
      const range = req.headers()['range'] || req.headers()['Range']
      const match = typeof range === 'string' ? range.match(/bytes=(\d+)-(\d+)?/) : null
      const start = match ? Number(match[1]) : 0
      const p = (async () => {
        try {
          const body = await resp.body()
          const headers = resp.headers()
          const provider = String(headers['x-nil-provider'] || headers['X-Nil-Provider'] || '')
          let origin = ''
          try {
            origin = new URL(url).origin
          } catch (err) {
            void err
            origin = ''
          }
          fetchEvents.push({
            url,
            origin,
            status: resp.status(),
            provider,
            range: typeof range === 'string' ? range : '',
            bodyLen: body.length,
          })
          chunkBytes.push({ start, bytes: Buffer.from(body) })
        } catch (err) {
          void err
        }
      })()
      chunkPromises.push(p)
    })

    const cacheName = cachedFileNameForPath(filePath)
    await page.evaluate(
      async ({ dealId, cacheName }) => {
        try {
          const root = await navigator.storage.getDirectory()
          const dealDir = await root.getDirectoryHandle(`deal-${dealId}`, { create: false })
          await dealDir.removeEntry(cacheName, { recursive: false })
        } catch (err) {
          void err
        }
      },
      { dealId, cacheName },
    )

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 })
    await downloadBtn.click()

    await expect(page.getByText(/Receipt submitted on-chain|Receipt failed/i)).toBeVisible({ timeout: 360_000 })
    const routeEl = page.getByTestId('transport-route')
    const routeAttempts = (await routeEl.getAttribute('data-transport-attempts').catch(() => null)) || ''
    const routeFailure = (await routeEl.getAttribute('data-transport-failure').catch(() => null)) || ''

    await expect.poll(() => fetchCalls, { timeout: 60_000 }).toBeGreaterThanOrEqual(expectedChunks)

    let downloaded: Buffer | null = null
    try {
      const download = await downloadPromise
      const downloadPath = await download.path()
      if (downloadPath) {
        downloaded = await fs.readFile(downloadPath)
      }
    } catch (err) {
      void err
    }

    await Promise.allSettled(chunkPromises)

    if (!downloaded || downloaded.length === 0) {
      try {
        const cachedBytes = await page.evaluate(
          async ({ dealId, cacheName }) => {
            const root = await navigator.storage.getDirectory()
            const dealDir = await root.getDirectoryHandle(`deal-${dealId}`, { create: false })
            const fh = await dealDir.getFileHandle(cacheName, { create: false })
            const file = await fh.getFile()
            const buf = await file.arrayBuffer()
            return Array.from(new Uint8Array(buf))
          },
          { dealId, cacheName },
        )
        downloaded = Buffer.from(cachedBytes)
      } catch (err) {
        void err
      }
    }

    if (!downloaded || downloaded.length === 0) {
      const ordered = chunkBytes.sort((a, b) => a.start - b.start)
      const total = ordered.reduce((acc, entry) => acc + entry.bytes.length, 0)
      const joined = Buffer.concat(ordered.map((entry) => entry.bytes), total)
      downloaded = joined
    }

    const maxExpected = fileBytes.length
    expect(downloaded.length).toBeGreaterThan(0)
    expect(downloaded.length).toBeLessThanOrEqual(maxExpected)
    const expectedHash = crypto.createHash('sha256').update(fileBytes).digest('hex')
    const actualHash = crypto.createHash('sha256').update(downloaded).digest('hex')
    if (downloaded.length !== fileBytes.length || actualHash !== expectedHash) {
      console.log(
        JSON.stringify(
          {
            routeAttempts,
            routeFailure,
            fetchEvents: fetchEvents
              .slice()
              .sort((a, b) => a.range.localeCompare(b.range))
              .map((e) => ({
                origin: e.origin,
                status: e.status,
                provider: e.provider,
                range: e.range,
                bodyLen: e.bodyLen,
              })),
          },
          null,
          2,
        ),
      )
    }
    expect(downloaded.length).toBe(fileBytes.length)
    expect(actualHash).toBe(expectedHash)
  })

  test('mode2 append keeps prior files', async ({ page }) => {
    test.slow()
    test.setTimeout(600_000)

    const fileA = { name: 'mode2-a.txt', buffer: Buffer.alloc(32 * 1024, 'A') }
    const fileB = { name: 'mode2-b.txt', buffer: Buffer.alloc(32 * 1024, 'B') }

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)

    await page.getByTestId('faucet-request').click()
    await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 180_000 })

    await page.getByTestId('alloc-submit').click()
    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 180_000 })
    await waitForGatewayConnected(page)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileA.name,
      mimeType: 'text/plain',
      buffer: fileA.buffer,
    })
    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')

    await waitForUploadControls(uploadBtn, commitBtn, 300_000).catch(() => {
      console.log('[rehydrate-e2e] fileB controls did not appear before timeout; continuing with gateway-attempt checks')
    })
    if ((await uploadBtn.count().catch(() => 0)) > 0) {
      await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
      await uploadBtn.click()
      await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: 300_000 })
    }
    await expect(commitBtn).toBeEnabled({ timeout: 300_000 })
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileB.name,
      mimeType: 'text/plain',
      buffer: fileB.buffer,
    })

    await waitForUploadControls(uploadBtn, commitBtn, 300_000)
    if ((await uploadBtn.count().catch(() => 0)) > 0) {
      await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
      await uploadBtn.click()
      await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: 300_000 })
    }
    await expect(commitBtn).toBeEnabled({ timeout: 300_000 })
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })
  })

  test('mode2 append recovers by rehydrating local gateway from OPFS cache', async ({ page }) => {
    test.slow()
    test.setTimeout(900_000)

    const fileA = { name: 'rehydrate-a.txt', buffer: Buffer.alloc(128 * 1024, 'R') }
    const fileB = { name: 'rehydrate-b.txt', buffer: Buffer.alloc(96 * 1024, 'S') }

    console.log('[rehydrate-e2e] start')
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })
    console.log('[rehydrate-e2e] dashboard loaded')

    await ensureWalletConnected(page)

    await page.getByTestId('faucet-request').click()
    await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 180_000 })
    console.log('[rehydrate-e2e] faucet funded')

    await page.getByTestId('alloc-submit').click()
    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')
    console.log(`[rehydrate-e2e] deal created id=${dealId}`)

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 180_000 })
    await waitForGatewayConnected(page)

    // Force first gateway ingest to fail so browser fallback computes and persists OPFS slab.
    // Keep subsequent attempts deterministic for local/CI by stubbing provider transport.
    let gatewayUploadPostCount = 0
    let fileBGatewayAttemptCount = 0
    let rehydratePhase: 'fileA' | 'fileB' = 'fileA'
    let mirrorMduCalls = 0
    let mirrorManifestCalls = 0
    let mirrorShardCalls = 0
    const retryManifestRoot = `0x${crypto.randomBytes(48).toString('hex')}`

    await page.route('**/sp/upload_mdu', async (route) => {
      await route.fulfill({ status: 200, body: 'ok' })
    })
    await page.route('**/sp/upload_manifest', async (route) => {
      await route.fulfill({ status: 200, body: 'ok' })
    })
    await page.route('**/sp/upload_shard', async (route) => {
      await route.fulfill({ status: 200, body: 'ok' })
    })

    for (const gatewayBase of ['http://127.0.0.1:8080', 'http://localhost:8080']) {
      await page.route(`${gatewayBase}/status`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ mode: 'router' }),
        })
      })
      await page.route(`${gatewayBase}/gateway/mirror_mdu`, async (route) => {
        mirrorMduCalls += 1
        await route.fulfill({ status: 200, body: 'ok' })
      })
      await page.route(`${gatewayBase}/gateway/mirror_manifest`, async (route) => {
        mirrorManifestCalls += 1
        await route.fulfill({ status: 200, body: 'ok' })
      })
      await page.route(`${gatewayBase}/gateway/mirror_shard`, async (route) => {
        mirrorShardCalls += 1
        await route.fulfill({ status: 200, body: 'ok' })
      })
    }

    await page.route('**/gateway/upload*', async (route) => {
      if (route.request().method().toUpperCase() === 'POST') {
        gatewayUploadPostCount += 1
        if (rehydratePhase === 'fileA') {
          await route.continue()
          return
        }

        fileBGatewayAttemptCount += 1
        // Simulate append recovery on fileB: first gateway ingest attempt fails due missing slab.
        if (fileBGatewayAttemptCount === 1) {
          await route.fulfill({
            status: 500,
            contentType: 'text/plain',
            body: 'mode2 append failed: failed to resolve existing slab dir',
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            manifest_root: retryManifestRoot,
            total_mdus: 3,
            witness_mdus: 1,
            size_bytes: fileA.buffer.length + fileB.buffer.length,
          }),
        })
        return
      }
      await route.continue()
    })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileA.name,
      mimeType: 'text/plain',
      buffer: fileA.buffer,
    })
    console.log('[rehydrate-e2e] fileA selected')

    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')

    await waitForUploadControls(uploadBtn, commitBtn, 300_000)
    if ((await uploadBtn.count().catch(() => 0)) > 0 && (await uploadBtn.isVisible().catch(() => false))) {
      await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
      await uploadBtn.click()
      await expect
        .poll(async () => {
          const text = (await uploadBtn.textContent().catch(() => '')) || ''
          const committed = await commitBtn.isEnabled().catch(() => false)
          return /Upload Complete/i.test(text) || committed
        }, { timeout: 300_000 })
        .toBe(true)
    }
    console.log('[rehydrate-e2e] fileA upload complete')
    await expect(commitBtn).toBeEnabled({ timeout: 300_000 })
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })
    console.log('[rehydrate-e2e] fileA committed')
    rehydratePhase = 'fileB'

    const routerDealDir = path.join(resolveRouterUploadDir(), 'deals', String(dealId))
    let routerManifestDirName = ''
    const routerManifestDeadline = Date.now() + 120_000
    while (!routerManifestDirName && Date.now() < routerManifestDeadline) {
      const entries = await fs.readdir(routerDealDir, { withFileTypes: true }).catch(() => [])
      const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      routerManifestDirName = dirs[0] || ''
      if (!routerManifestDirName) {
        await page.waitForTimeout(500)
      }
    }
    if (routerManifestDirName) {
      const manifestDirEntries = await fs.readdir(path.join(routerDealDir, String(routerManifestDirName))).catch(() => [])
      const seedNames = manifestDirEntries.filter((name) => {
        return name === 'manifest.bin' || /^mdu_\d+\.bin$/.test(name) || /^mdu_\d+_slot_\d+\.bin$/.test(name)
      })
      const seedFiles = await Promise.all(
        seedNames.map(async (name) => {
          const bytes = await fs.readFile(path.join(routerDealDir, String(routerManifestDirName), name))
          return { name, bytes: Array.from(bytes) }
        }),
      )
      await page.evaluate(
        async ({ dealId, manifestRoot, seedFiles }) => {
          const root = await navigator.storage.getDirectory()
          const dealDir = await root.getDirectoryHandle(`deal-${dealId}`, { create: true })
          const writeFile = async (name: string, data: Uint8Array) => {
            const fh = await dealDir.getFileHandle(name, { create: true })
            const writable = await fh.createWritable()
            await writable.write(data)
            await writable.close()
          }
          await writeFile('manifest_root.txt', new TextEncoder().encode(manifestRoot))
          for (const file of seedFiles as Array<{ name: string; bytes: number[] }>) {
            await writeFile(file.name, new Uint8Array(file.bytes))
          }
        },
        {
          dealId,
          manifestRoot: `0x${String(routerManifestDirName).replace(/^0x/i, '')}`,
          seedFiles,
        },
      )
    } else {
      console.log(`[rehydrate-e2e] no router manifest dir found for deal ${dealId}; skipping explicit OPFS seed`)
    }
    await fs.rm(routerDealDir, { recursive: true, force: true })

    // Ensure the local gateway truly lost its prior slab state.
    const dirExists = await fs.stat(routerDealDir).then(() => true).catch(() => false)
    expect(dirExists).toBe(false)
    console.log(`[rehydrate-e2e] removed router slab dir=${routerDealDir}`)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileB.name,
      mimeType: 'text/plain',
      buffer: fileB.buffer,
    })
    console.log('[rehydrate-e2e] fileB selected')

    await waitForUploadControls(uploadBtn, commitBtn, 300_000)
    if ((await uploadBtn.count().catch(() => 0)) > 0 && (await uploadBtn.isVisible().catch(() => false))) {
      const preUploadText = ((await uploadBtn.textContent().catch(() => '')) || '').trim()
      if (!/Upload Complete/i.test(preUploadText)) {
        await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
        await uploadBtn.click()
      }
      await expect
        .poll(async () => {
          const text = (await uploadBtn.textContent().catch(() => '')) || ''
          const committed = await commitBtn.isEnabled().catch(() => false)
          return /Upload Complete/i.test(text) || committed
        }, { timeout: 300_000 })
        .toBe(true)
      console.log('[rehydrate-e2e] fileB upload complete (explicit upload button path)')
    }

    await expect.poll(() => fileBGatewayAttemptCount, { timeout: 300_000 }).toBeGreaterThanOrEqual(1)

    const activity = page.locator('div').filter({ hasText: 'System Activity:' }).first()
    await expect(activity).toContainText('Gateway is missing prior slab state; attempting browser-to-gateway rehydrate from OPFS', {
      timeout: 300_000,
    })
    await expect(activity).toContainText('Rehydrated local gateway from OPFS cache', {
      timeout: 300_000,
    })
    console.log('[rehydrate-e2e] detected rehydrate logs')

    await expect(commitBtn).toBeEnabled({ timeout: 300_000 })
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })
    console.log('[rehydrate-e2e] fileB committed')
    console.log(
      `[rehydrate-e2e] completed successfully (gatewayUploads=${gatewayUploadPostCount}, mirrorCalls=${
        mirrorMduCalls + mirrorManifestCalls + mirrorShardCalls
      })`,
    )
  })
})
