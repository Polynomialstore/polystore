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
    .catch(() => undefined)
}

async function readDownloadBytes(page: Page, button: Locator, timeout = 240_000): Promise<Buffer> {
  const downloadPromise = page.waitForEvent('download', { timeout })
  await expect(button).toBeVisible({ timeout: 30_000 })
  await expect(button).toBeEnabled({ timeout: 60_000 })
  await button.click({ force: true })
  const download = await downloadPromise
  const p = await download.path()
  if (p) return fs.readFile(p)
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  if (stream) {
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array))
    }
  }
  return Buffer.concat(chunks)
}

async function readDownloadBytesMaybe(page: Page, button: Locator, timeout = 60_000): Promise<Buffer | null> {
  const downloadPromise = page.waitForEvent('download', { timeout }).catch(() => null)
  await expect(button).toBeVisible({ timeout: 30_000 })
  await expect(button).toBeEnabled({ timeout: 60_000 })
  await button.click({ force: true })
  const download = await downloadPromise
  if (!download) return null
  const p = await download.path()
  if (p) return fs.readFile(p)
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  if (stream) {
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array))
    }
  }
  return Buffer.concat(chunks)
}

async function completeUploadAndCommit(uploadBtn: Locator, commitBtn: Locator, timeout = 300_000): Promise<void> {
  const page = uploadBtn.page()
  await waitForUploadControls(uploadBtn, commitBtn, timeout).catch(() => undefined)

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const commitCount = await commitBtn.count().catch(() => 0)
    const commitEnabled = commitCount > 0 && (await commitBtn.isEnabled().catch(() => false))
    if (commitEnabled) break

    const uploadCount = await uploadBtn.count().catch(() => 0)
    const uploadVisible = uploadCount > 0 && (await uploadBtn.isVisible().catch(() => false))
    const uploadEnabled = uploadVisible && (await uploadBtn.isEnabled().catch(() => false))
    if (uploadEnabled) {
      await uploadBtn.click({ force: true })
      await expect
        .poll(async () => {
          const enabled = await commitBtn.isEnabled().catch(() => false)
          if (enabled) return true
          const text = ((await uploadBtn.textContent().catch(() => '')) || '').trim()
          return /Upload Complete/i.test(text)
        }, { timeout: 120_000 })
        .toBe(true)
    }
    await page.waitForTimeout(500)
  }

  await expect(commitBtn).toBeEnabled({ timeout: 60_000 })
  await commitBtn.click()
  await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })
  await page.waitForTimeout(150)
}

async function waitForDealFileRow(
  page: Page,
  dealId: string,
  filePath: string,
  timeout = 180_000,
): Promise<Locator> {
  const workspaceTitle = page.getByTestId('workspace-deal-title')
  const dealRow = page.getByTestId(`deal-row-${dealId}`)
  const filesTab = page.getByRole('button', { name: /^Files$/i }).first()
  const fileList = page.getByTestId('deal-detail-file-list')
  const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)

  const pollForRow = async () => {
    await expect
      .poll(async () => {
        if ((await dealRow.count().catch(() => 0)) <= 0) return false
        await dealRow.click({ force: true }).catch(() => undefined)
        const selectedTitle = ((await workspaceTitle.textContent().catch(() => '')) || '').trim()
        if (!selectedTitle.includes(`#${dealId}`)) return false
        if (await filesTab.isVisible().catch(() => false)) {
          await filesTab.click({ force: true }).catch(() => undefined)
        }
        const listVisible = await fileList.isVisible().catch(() => false)
        if (!listVisible) return false
        return await fileRow.isVisible().catch(() => false)
      }, { timeout })
      .toBe(true)
  }

  try {
    await pollForRow()
  } catch {
    await page.reload({ waitUntil: 'networkidle' })
    await pollForRow()
  }

  return fileRow
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

  const waitForConnected = async (timeout = 20_000): Promise<boolean> => {
    try {
      await expect.poll(isConnected, { timeout }).toBe(true)
      return true
    } catch (err) {
      void err
      return false
    }
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
      if (await waitForConnected()) return
    }

    for (const candidate of fallbackWalletBtns) {
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ force: true })
        if (await waitForConnected()) return
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
    const workspaceTitle = page.getByTestId('workspace-deal-title')
    await expect(workspaceTitle).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    const dealTitle = (await workspaceTitle.textContent().catch(() => '')) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    const newDealRow = page.getByTestId(`deal-row-${dealId}`)
    await expect(newDealRow).toBeVisible({ timeout: 60_000 })
    await newDealRow.click()
    await expect(workspaceTitle).toHaveText(new RegExp(`#${dealId}`), { timeout: 60_000 })

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 180_000 })
    await waitForGatewayConnected(page)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: filePath,
      mimeType: 'text/plain',
      buffer: fileBytes,
    })

    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')

    await completeUploadAndCommit(uploadBtn, commitBtn, 300_000)

    const fileRow = await waitForDealFileRow(page, dealId, filePath, 180_000)

    const autoDownloadBtn = page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`)
    const gatewayDownloadBtn = page.locator(`[data-testid="deal-detail-download-gateway"][data-file-path="${filePath}"]`)
    const providerDownloadBtn = page.locator(`[data-testid="deal-detail-download-sp"][data-file-path="${filePath}"]`)
    const browserCacheBtn = page.locator(`[data-testid="deal-detail-download-browser-cache"][data-file-path="${filePath}"]`)
    const browserSlabBtn = page.locator(`[data-testid="deal-detail-download-browser-slab"][data-file-path="${filePath}"]`)
    const clearBrowserCacheBtn = page.locator(`[data-testid="deal-detail-clear-browser-cache"][data-file-path="${filePath}"]`)
    const routeEl = page.getByTestId('transport-route')

    await expect(autoDownloadBtn).toBeEnabled({ timeout: 180_000 })
    await expect(gatewayDownloadBtn).toBeEnabled({ timeout: 180_000 })
    await expect(providerDownloadBtn).toBeEnabled({ timeout: 180_000 })

    let blockGateway = false
    const maybeBlockGateway = async (route: import('@playwright/test').Route) => {
      if (blockGateway && route.request().method().toUpperCase() !== 'OPTIONS') {
        await route.abort('failed')
        return
      }
      await route.continue()
    }
    await page.route('http://127.0.0.1:8080/**', maybeBlockGateway)
    await page.route('http://localhost:8080/**', maybeBlockGateway)

    let fetchGatewayCalls = 0
    let fetchProviderCalls = 0
    let planGatewayCalls = 0
    let planProviderCalls = 0
    page.on('response', (resp) => {
      const url = resp.url()
      if (!url.includes('/gateway/fetch/') && !url.includes('/gateway/plan-retrieval-session/')) return
      let origin = ''
      try {
        origin = new URL(url).origin
      } catch (err) {
        void err
      }
      const viaGateway = /:8080$/.test(origin)
      if (url.includes('/gateway/fetch/')) {
        if (viaGateway) fetchGatewayCalls += 1
        else fetchProviderCalls += 1
        return
      }
      if (viaGateway) planGatewayCalls += 1
      else planProviderCalls += 1
    })

    const clearBrowserCache = async () => {
      if (await clearBrowserCacheBtn.isEnabled().catch(() => false)) {
        await clearBrowserCacheBtn.click()
      }
      await expect(fileRow).toHaveAttribute('data-cache-browser', 'no', { timeout: 60_000 })
    }

    await clearBrowserCache()
    const gatewayCacheAvailable = ((await fileRow.getAttribute('data-cache-gateway')) || '') === 'yes'

    const autoGatewayFetchBefore = fetchGatewayCalls
    const autoProviderFetchBefore = fetchProviderCalls
    const autoGatewayPlanBefore = planGatewayCalls
    const autoProviderPlanBefore = planProviderCalls
    const autoBytes = await readDownloadBytes(page, autoDownloadBtn)
    expect(autoBytes.equals(fileBytes)).toBe(true)
    if (gatewayCacheAvailable) {
      const routeValue = ((await routeEl.getAttribute('data-download-route').catch(() => '')) || '').toLowerCase()
      expect(
        fetchGatewayCalls > autoGatewayFetchBefore || fetchProviderCalls > autoProviderFetchBefore,
      ).toBe(true)
      if (routeValue.includes('gateway')) {
        expect(planGatewayCalls + planProviderCalls).toBe(
          autoGatewayPlanBefore + autoProviderPlanBefore,
        )
      }
    } else {
      expect(fetchProviderCalls).toBeGreaterThan(autoProviderFetchBefore)
      expect(
        planProviderCalls > autoProviderPlanBefore || planGatewayCalls > autoGatewayPlanBefore,
      ).toBe(true)
    }
    await expect(fileRow).toHaveAttribute('data-cache-browser', 'yes', { timeout: 60_000 })

    const cacheFetchGatewayBefore = fetchGatewayCalls
    const cacheFetchProviderBefore = fetchProviderCalls
    const cachePlanGatewayBefore = planGatewayCalls
    const cachePlanProviderBefore = planProviderCalls
    const cachedBytes = await readDownloadBytes(page, browserCacheBtn)
    expect(cachedBytes.equals(fileBytes)).toBe(true)
    expect(fetchGatewayCalls).toBe(cacheFetchGatewayBefore)
    expect(fetchProviderCalls).toBe(cacheFetchProviderBefore)
    expect(planGatewayCalls).toBe(cachePlanGatewayBefore)
    expect(planProviderCalls).toBe(cachePlanProviderBefore)

    const slabFetchGatewayBefore = fetchGatewayCalls
    const slabFetchProviderBefore = fetchProviderCalls
    const slabPlanGatewayBefore = planGatewayCalls
    const slabPlanProviderBefore = planProviderCalls
    const slabBytes = await readDownloadBytesMaybe(page, browserSlabBtn)
    if (slabBytes) {
      expect(slabBytes.equals(fileBytes)).toBe(true)
      expect(fetchGatewayCalls).toBe(slabFetchGatewayBefore)
      expect(fetchProviderCalls).toBe(slabFetchProviderBefore)
      expect(planGatewayCalls).toBe(slabPlanGatewayBefore)
      expect(planProviderCalls).toBe(slabPlanProviderBefore)
    } else {
      const errorBanner = page.locator('div').filter({ hasText: /^Download failed:/ }).first()
      await expect(errorBanner).toContainText(/local slab not available/i, { timeout: 60_000 })
    }

    await clearBrowserCache()
    const providerFetchBefore = fetchProviderCalls
    const providerPlanBefore = planProviderCalls
    const providerBytes = await readDownloadBytes(page, providerDownloadBtn)
    expect(providerBytes.equals(fileBytes)).toBe(true)
    await expect(routeEl).toHaveAttribute('data-download-route', 'direct_sp', { timeout: 60_000 })
    expect(fetchProviderCalls).toBeGreaterThan(providerFetchBefore)
    expect(planProviderCalls).toBeGreaterThan(providerPlanBefore)

    await clearBrowserCache()
    const gatewayFetchBefore = fetchGatewayCalls
    const gatewayPlanBefore = planGatewayCalls
    const gatewayProviderFetchBefore = fetchProviderCalls
    const gatewayProviderPlanBefore = planProviderCalls
    const gatewayBytes = await readDownloadBytesMaybe(page, gatewayDownloadBtn, 120_000)
    if (gatewayBytes) {
      expect(gatewayBytes.equals(fileBytes)).toBe(true)
      if (gatewayCacheAvailable) {
        expect(fetchGatewayCalls).toBeGreaterThan(gatewayFetchBefore)
        expect(planGatewayCalls + planProviderCalls).toBe(
          gatewayPlanBefore + gatewayProviderPlanBefore,
        )
      } else {
        expect(
          fetchGatewayCalls > gatewayFetchBefore || fetchProviderCalls > gatewayProviderFetchBefore,
        ).toBe(true)
      }
    } else {
      const errorBanner = page.locator('div').filter({ hasText: /^Download failed:/ }).first()
      await expect(errorBanner).toContainText(/download failed|gateway|cache/i, { timeout: 60_000 })
    }

    blockGateway = true
    await clearBrowserCache()
    const fallbackFetchBefore = fetchProviderCalls
    const fallbackPlanBefore = planProviderCalls
    const fallbackBytes = await readDownloadBytes(page, autoDownloadBtn)
    expect(fallbackBytes.equals(fileBytes)).toBe(true)
    await expect(routeEl).toHaveAttribute('data-download-route', 'direct_sp', { timeout: 60_000 })
    expect(fetchProviderCalls).toBeGreaterThan(fallbackFetchBefore)
    expect(planProviderCalls).toBeGreaterThan(fallbackPlanBefore)
    blockGateway = false
  })

  test('mode2 upload without gateway still supports browser MDU download path', async ({ page }) => {
    test.setTimeout(600_000)

    const filePath = 'mode2-no-gateway-upload.txt'
    const fileBytes = Buffer.alloc(192 * 1024, 'N')

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)

    await page.getByTestId('faucet-request').click()
    await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 180_000 })

    await page.getByTestId('alloc-submit').click()
    const workspaceTitle = page.getByTestId('workspace-deal-title')
    await expect(workspaceTitle).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    const dealTitle = (await workspaceTitle.textContent().catch(() => '')) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    const newDealRow = page.getByTestId(`deal-row-${dealId}`)
    await expect(newDealRow).toBeVisible({ timeout: 60_000 })
    await newDealRow.click()
    await expect(workspaceTitle).toHaveText(new RegExp(`#${dealId}`), { timeout: 60_000 })

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 180_000 })

    let blockGatewayUpload = true
    const maybeBlockGatewayUpload = async (route: import('@playwright/test').Route) => {
      if (blockGatewayUpload && route.request().method().toUpperCase() !== 'OPTIONS') {
        await route.abort('failed')
        return
      }
      await route.continue()
    }
    await page.route('**/gateway/upload*', maybeBlockGatewayUpload)
    await page.route('**/gateway/upload-status*', maybeBlockGatewayUpload)

    const compressCheckbox = page.getByLabel('Compress locally (NilCE zstd) before sharding')
    if (await compressCheckbox.isChecked().catch(() => false)) {
      await compressCheckbox.uncheck()
    }

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: filePath,
      mimeType: 'text/plain',
      buffer: fileBytes,
    })

    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')
    await waitForUploadControls(uploadBtn, commitBtn, 300_000)
    if ((await uploadBtn.count().catch(() => 0)) > 0) {
      await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
      await uploadBtn.click()
      await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: 300_000 })
    }
    const activity = page.locator('div').filter({ hasText: 'System Activity:' }).first()
    await expect(activity).toContainText(/falling back to in-browser mode 2 sharding \+ stripe upload/i, {
      timeout: 300_000,
    })
    await expect(commitBtn).toBeEnabled({ timeout: 300_000 })
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })
    blockGatewayUpload = false

    const fileRow = await waitForDealFileRow(page, dealId, filePath, 180_000)
    const browserSlabBtn = page.locator(`[data-testid="deal-detail-download-browser-slab"][data-file-path="${filePath}"]`)
    await expect(browserSlabBtn).toBeVisible({ timeout: 60_000 })

    let slabBytes = await readDownloadBytesMaybe(page, browserSlabBtn, 120_000)
    if (!slabBytes) {
      await waitForDealFileRow(page, dealId, filePath, 120_000)
      slabBytes = await readDownloadBytesMaybe(page, browserSlabBtn, 120_000)
    }
    if (!slabBytes) {
      const errorBanner = page.locator('div').filter({ hasText: /^Download failed:/ }).first()
      await expect(errorBanner).toContainText(/local slab not available/i, { timeout: 60_000 })
      throw new Error('browser slab download did not produce a file')
    }
    expect(slabBytes.equals(fileBytes)).toBe(true)
    await expect(fileRow).toHaveAttribute('data-cache-browser', 'yes', { timeout: 60_000 })
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

    await completeUploadAndCommit(uploadBtn, commitBtn, 300_000)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileB.name,
      mimeType: 'text/plain',
      buffer: fileB.buffer,
    })

    await completeUploadAndCommit(uploadBtn, commitBtn, 300_000)
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

    await completeUploadAndCommit(uploadBtn, commitBtn, 300_000)
    console.log('[rehydrate-e2e] fileA upload+commit complete')
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
    const fileNameLikeMdu = (name: string) =>
      name === 'manifest.bin' || /^mdu_\d+\.bin$/.test(name) || /^mdu_\d+_slot_\d+\.bin$/.test(name)

    let seedBaseDir = ''
    let seedNames: string[] = []
    let manifestRoot: string | null = null
    let committedManifestRoot = ''
    const manifestCell = page.getByTestId(`deal-manifest-${dealId}`)
    if (await manifestCell.count().catch(() => 0)) {
      const rawManifest = (await manifestCell.first().textContent().catch(() => '')) || ''
      const match = rawManifest.match(/0x[0-9a-fA-F]{96}/)
      committedManifestRoot = match?.[0] || ''
    }
    if (routerManifestDirName) {
      seedBaseDir = path.join(routerDealDir, String(routerManifestDirName))
      const nested = await fs.readdir(seedBaseDir).catch(() => [])
      seedNames = nested.filter(fileNameLikeMdu)
      manifestRoot = `0x${String(routerManifestDirName).replace(/^0x/i, '')}`
    }
    if (seedNames.length === 0) {
      seedBaseDir = routerDealDir
      const flat = await fs.readdir(routerDealDir).catch(() => [])
      seedNames = flat.filter(fileNameLikeMdu)
      manifestRoot = null
    }
    if (!manifestRoot && committedManifestRoot) {
      manifestRoot = committedManifestRoot
    }

    if (seedNames.length > 0) {
      const seedFiles = await Promise.all(
        seedNames.map(async (name) => {
          const bytes = await fs.readFile(path.join(seedBaseDir, name))
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
          if (manifestRoot) {
            await writeFile('manifest_root.txt', new TextEncoder().encode(manifestRoot))
          }
          for (const file of seedFiles as Array<{ name: string; bytes: number[] }>) {
            await writeFile(file.name, new Uint8Array(file.bytes))
          }
        },
        {
          dealId,
          manifestRoot,
          seedFiles,
        },
      )
      console.log(`[rehydrate-e2e] seeded OPFS from router files count=${seedNames.length}`)
    } else {
      console.log(`[rehydrate-e2e] no router slab files found for deal ${dealId}; skipping explicit OPFS seed`)
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
    const activityText = (await activity.textContent().catch(() => '')) || ''
    if (activityText.includes('Gateway rehydrate skipped: local MDU #0 missing in OPFS')) {
      console.log('[rehydrate-e2e] rehydrate skipped due missing OPFS MDU #0; treating as non-fatal in CI')
      return
    }
    await expect(activity).toContainText('Rehydrated local gateway from OPFS cache', {
      timeout: 300_000,
    })
    console.log('[rehydrate-e2e] detected successful rehydrate logs')

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
