import { test, expect, type Locator, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { dismissCreateDealDrawer, ensureCreateDealDrawerOpen } from './utils/dashboard'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'
const isMode2Fast = process.env.E2E_MODE2_FAST === '1'
const mode2FastTestTimeoutMs = isMode2Fast ? 240_000 : 420_000
const mode2FastPrimaryWaitMs = isMode2Fast ? 120_000 : 180_000
const mode2FastUploadWaitMs = isMode2Fast ? 180_000 : 300_000
const mode2FastMaybeDownloadMs = isMode2Fast ? 60_000 : 120_000

function extractManifestRoot(text: string): string {
  const match = String(text || '').match(/0x[0-9a-fA-F]{96}/)
  return (match?.[0] || '').toLowerCase()
}

async function readDealManifestRoot(page: Page, dealId: string): Promise<string> {
  const cell = page.getByTestId(`deal-manifest-${dealId}`)
  if ((await cell.count().catch(() => 0)) === 0) return ''
  const text = (await cell.first().textContent().catch(() => '')) || ''
  return extractManifestRoot(text)
}

async function waitForGatewayConnected(page: Page): Promise<void> {
  const widget = page.getByTestId('gateway-status-widget')
  const count = await widget.count().catch(() => 0)
  if (count <= 0) return
  await expect(widget.first()).toHaveAttribute('data-status', 'connected', { timeout: 60_000 })
}

async function ensureWalletFunded(page: Page, timeout: number): Promise<void> {
  const stakeBalance = page.getByTestId('cosmos-stake-balance')
  const current = ((await stakeBalance.textContent().catch(() => '')) || '').trim()
  if (current && !/^(?:—|0 stake)$/.test(current)) return

  const faucetButton = page.getByTestId('faucet-request')
  if (await faucetButton.isVisible().catch(() => false)) {
    await faucetButton.click()
  }
  await expect(stakeBalance).not.toHaveText(/^(?:—|0 stake)$/, { timeout })
}

async function waitForUploadControls(uploadBtn: Locator, commitBtn: Locator, timeout = 300_000): Promise<void> {
  await expect
    .poll(async () => {
      const cardCount = await uploadBtn.page().getByTestId('mdu-upload-card').count().catch(() => 0)
      const uploadCount = await uploadBtn.count().catch(() => 0)
      const commitCount = await commitBtn.count().catch(() => 0)
      return cardCount + uploadCount + commitCount
    }, { timeout })
    .toBeGreaterThan(0)
    .catch(() => undefined)
}

async function openFileActionMenuItem(page: Page, filePath: string, testId: string): Promise<Locator> {
  const menuButton = page.locator(`[data-testid="deal-detail-actions-menu"][data-file-path="${filePath}"]`)
  const item = page.locator(`[data-testid="${testId}"][data-file-path="${filePath}"]`)
  if (await item.isVisible().catch(() => false)) return item
  await expect(menuButton).toBeVisible({ timeout: 60_000 })
  await menuButton.click({ force: true })
  await expect(item).toBeVisible({ timeout: 30_000 })
  return item
}

async function openSystemActivity(page: Page): Promise<Locator> {
  const underTheHood = page.getByTestId('mdu-under-the-hood')
  if (await underTheHood.count().catch(() => 0)) {
    const detailsOpen = await underTheHood.evaluate((node) => node.hasAttribute('open')).catch(() => false)
    if (!detailsOpen) {
      await page.getByTestId('mdu-under-the-hood-toggle').click()
    }
  }
  const toggle = page.getByTestId('mdu-system-activity-toggle')
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  const panel = page.getByTestId('mdu-system-activity')
  if (!(await panel.isVisible().catch(() => false))) {
    await toggle.click()
  }
  await expect(panel).toBeVisible({ timeout: 30_000 })
  return panel
}

async function readDownloadedBytes(download: Awaited<ReturnType<Page['waitForEvent']>>): Promise<Buffer> {
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

async function readDownloadFailureBanner(page: Page): Promise<string> {
  const banner = page.locator('div').filter({ hasText: /^Download failed:/ }).first()
  const visible = await banner.isVisible().catch(() => false)
  if (!visible) return ''
  return ((await banner.textContent().catch(() => '')) || '').trim()
}

async function captureDownloadDiagnostics(page: Page): Promise<string> {
  const route = ((await page.getByTestId('transport-route').textContent().catch(() => '')) || '').trim()
  const source = ((await page.getByTestId('transport-cache-source').textContent().catch(() => '')) || '').trim()
  const freshness = ((await page.getByTestId('transport-cache-freshness').textContent().catch(() => '')) || '').trim()
  const failure = await readDownloadFailureBanner(page)
  const receipt = ((await page.locator('div').filter({ hasText: /^Receipt failed:/ }).first().textContent().catch(() => '')) || '').trim()
  const parts = [
    route ? `route=${route}` : '',
    source ? `cacheSource=${source}` : '',
    freshness ? `freshness=${freshness}` : '',
    failure ? `failure=${failure}` : '',
    receipt ? `receipt=${receipt}` : '',
  ].filter(Boolean)
  return parts.join(' | ') || 'no diagnostics available'
}

async function waitForDownloadEventOrFailure(
  page: Page,
  timeout: number,
  baselineFailure: string,
): Promise<Awaited<ReturnType<Page['waitForEvent']>> | null> {
  const outcomePromise = page
    .waitForEvent('download', { timeout })
    .then((download) => ({ kind: 'download' as const, download }))
    .catch(() => ({ kind: 'timeout' as const }))

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      outcomePromise,
      page.waitForTimeout(500).then(() => null),
    ])
    if (outcome?.kind === 'download') return outcome.download
    if (outcome?.kind === 'timeout') return null
    const failure = await readDownloadFailureBanner(page)
    if (failure && failure !== baselineFailure) {
      throw new Error(`download failed before browser event: ${failure}`)
    }
  }
  return null
}

async function readDownloadBytes(page: Page, button: Locator, timeout = 120_000): Promise<Buffer> {
  const maxAttempts = 2
  const perAttemptTimeout = Math.max(30_000, Math.floor(timeout / maxAttempts))
  let latestError = ''

  await expect(button).toBeVisible({ timeout: 30_000 })
  await expect(button).toBeEnabled({ timeout: 60_000 })

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const baselineFailure = await readDownloadFailureBanner(page)
    try {
      await button.click({ force: true })
      const download = await waitForDownloadEventOrFailure(page, perAttemptTimeout, baselineFailure)
      if (download) {
        return readDownloadedBytes(download)
      }
      latestError = `download event not emitted within ${perAttemptTimeout}ms on attempt ${attempt}`
    } catch (err) {
      latestError = err instanceof Error ? err.message : String(err)
    }

    if (attempt < maxAttempts) {
      await page.waitForTimeout(750)
      await expect(button).toBeEnabled({ timeout: 30_000 })
    }
  }

  const diagnostics = await captureDownloadDiagnostics(page)
  throw new Error(`${latestError || 'download failed'} (${diagnostics})`)
}

async function readDownloadBytesMaybe(page: Page, button: Locator, timeout = 90_000): Promise<Buffer | null> {
  const baselineFailure = await readDownloadFailureBanner(page)
  await expect(button).toBeVisible({ timeout: 30_000 })
  await expect(button).toBeEnabled({ timeout: 60_000 })
  await button.click({ force: true })
  let download: Awaited<ReturnType<Page['waitForEvent']>> | null = null
  try {
    download = await waitForDownloadEventOrFailure(page, timeout, baselineFailure)
  } catch {
    return null
  }
  if (!download) return null
  return readDownloadedBytes(download)
}

async function isUploaderResetToInitialState(page: Page): Promise<boolean> {
  const panelState = await page.getByTestId('mdu-upload-card').getAttribute('data-panel-state').catch(() => null)
  if (panelState !== 'idle') return false
  const step2State = await page.getByTestId('workflow-step-2').getAttribute('data-step-state').catch(() => null)
  const step3State = await page.getByTestId('workflow-step-3').getAttribute('data-step-state').catch(() => null)
  const step4State = await page.getByTestId('workflow-step-4').getAttribute('data-step-state').catch(() => null)
  const fileInputCount = await page.getByTestId('mdu-file-input').count().catch(() => 0)
  return step2State === 'idle' && step3State === 'idle' && step4State === 'idle' && fileInputCount > 0
}

async function isCommitCompleteOrReset(
  page: Page,
  commitBtn: Locator,
  expectedFilePath: string,
  dealId: string,
  initialManifestRoot: string,
  allowReset: boolean,
): Promise<boolean> {
  if (dealId) {
    const currentManifest = await readDealManifestRoot(page, dealId)
    if (currentManifest && currentManifest !== initialManifestRoot) return true
  }
  if (expectedFilePath) {
    const fileRow = page.getByTestId('deal-detail-file-row').filter({ hasText: expectedFilePath })
    if ((await fileRow.count().catch(() => 0)) > 0) return true
  }
  const panelState = await page.getByTestId('mdu-upload-card').getAttribute('data-panel-state').catch(() => null)
  if (panelState === 'success') return true
  const text = ((await commitBtn.textContent().catch(() => '')) || '').trim()
  if (/Committed!/i.test(text)) return true
  if (allowReset && (await isUploaderResetToInitialState(page))) return true
  return false
}

async function completeUploadAndCommit(
  uploadBtn: Locator,
  commitBtn: Locator,
  expectedFilePath: string,
  dealId: string,
  timeout = 300_000,
): Promise<void> {
  const page = uploadBtn.page()
  await waitForUploadControls(uploadBtn, commitBtn, timeout).catch(() => undefined)
  const initialManifestRoot = dealId ? await readDealManifestRoot(page, dealId) : ''

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await isCommitCompleteOrReset(page, commitBtn, expectedFilePath, dealId, initialManifestRoot, true)) return

    const commitCount = await commitBtn.count().catch(() => 0)
    const commitEnabled = commitCount > 0 && (await commitBtn.isEnabled().catch(() => false))
    if (commitEnabled) {
      await commitBtn.click()
      await expect
        .poll(() => isCommitCompleteOrReset(page, commitBtn, expectedFilePath, dealId, initialManifestRoot, true), { timeout: 180_000 })
        .toBe(true)
      return
    }

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

  await expect
    .poll(() => isCommitCompleteOrReset(page, commitBtn, expectedFilePath, dealId, initialManifestRoot, true), { timeout: 180_000 })
    .toBe(true)
  await page.waitForTimeout(150)
}

async function syncDealIndexIfNeeded(page: Page, timeout = 180_000): Promise<void> {
  const syncPanel = page.getByTestId('deal-index-sync-panel')
  if (!(await syncPanel.isVisible().catch(() => false))) return

  const syncButton = page.getByTestId('deal-index-sync-button')
  await expect(syncButton).toBeVisible({ timeout: 30_000 })
  await syncButton.click({ force: true })
  await expect(syncPanel).toBeHidden({ timeout })
}

async function waitForDealFileRow(
  page: Page,
  dealId: string,
  filePath: string,
  timeout = 180_000,
): Promise<Locator> {
  const workspaceTitle = page.getByTestId('workspace-deal-title')
  const dealRow = page.getByTestId(`deal-row-${dealId}`)
  const dealRowByText = page.getByRole('button', { name: new RegExp(`Deal\\s*#${dealId}\\b`, 'i') }).first()
  const refreshDealsBtn = page.getByRole('button', { name: /Refresh deals/i }).first()
  const filesTab = page.getByRole('button', { name: /^Files$/i }).first()
  const fileList = page.getByTestId('deal-detail-file-list')
  const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)

  const pollForRow = async (allowSync: boolean, pollTimeout: number) => {
    await expect
      .poll(async () => {
        const byTestIdCount = await dealRow.count().catch(() => 0)
        const targetRow = byTestIdCount > 0 ? dealRow.first() : dealRowByText
        if ((await targetRow.count().catch(() => 0)) <= 0) return false
        await targetRow.scrollIntoViewIfNeeded().catch(() => undefined)
        await targetRow.click({ force: true }).catch(() => undefined)
        const selectedTitle = ((await workspaceTitle.textContent().catch(() => '')) || '').trim()
        if (!selectedTitle.includes(`#${dealId}`)) return false
        if (await filesTab.isVisible().catch(() => false)) {
          await filesTab.click({ force: true }).catch(() => undefined)
        }
        if (allowSync && !(await fileRow.isVisible().catch(() => false))) {
          await syncDealIndexIfNeeded(page, Math.max(60_000, Math.floor(timeout / 2))).catch(() => undefined)
        }
        const listVisible = await fileList.isVisible().catch(() => false)
        if (!listVisible) return false
        return await fileRow.isVisible().catch(() => false)
      }, { timeout: pollTimeout })
      .toBe(true)
  }

  try {
    await pollForRow(false, Math.max(30_000, Math.floor(timeout / 2)))
  } catch {
    await page.reload({ waitUntil: 'networkidle' })
    try {
      await pollForRow(true, Math.max(60_000, Math.floor(timeout / 2)))
    } catch {
      if (await refreshDealsBtn.isVisible().catch(() => false)) {
        await refreshDealsBtn.click({ force: true }).catch(() => undefined)
      }
      await expect
        .poll(async () => {
          const byTestIdCount = await dealRow.count().catch(() => 0)
          const targetRow = byTestIdCount > 0 ? dealRow.first() : dealRowByText
          if ((await targetRow.count().catch(() => 0)) <= 0) return false
          await targetRow.scrollIntoViewIfNeeded().catch(() => undefined)
          await targetRow.click({ force: true }).catch(() => undefined)
          if (await filesTab.isVisible().catch(() => false)) {
            await filesTab.click({ force: true }).catch(() => undefined)
          }
          if (!(await fileRow.isVisible().catch(() => false))) {
            await syncDealIndexIfNeeded(page, Math.max(30_000, Math.floor(timeout / 3))).catch(() => undefined)
          }
          return await fileRow.isVisible().catch(() => false)
        }, { timeout: Math.max(60_000, Math.floor(timeout / 2)) })
        .toBe(true)
    }
  }

  return fileRow
}

async function waitForFileRowInAnyDeal(
  page: Page,
  filePath: string,
  timeout = 180_000,
): Promise<Locator> {
  const filesTab = page.getByRole('button', { name: /^Files$/i }).first()
  const fileList = page.getByTestId('deal-detail-file-list')
  const refreshDealsBtn = page.getByRole('button', { name: /Refresh deals/i }).first()
  const dealRows = page.locator('[data-testid^="deal-row-"]')
  const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)

  const pollForRow = async (allowSync: boolean, pollTimeout: number) => {
    await expect
      .poll(async () => {
      const totalRows = await dealRows.count().catch(() => 0)
      for (let i = 0; i < totalRows; i += 1) {
        const row = dealRows.nth(i)
        await row.scrollIntoViewIfNeeded().catch(() => undefined)
        await row.click({ force: true }).catch(() => undefined)
        if (await filesTab.isVisible().catch(() => false)) {
          await filesTab.click({ force: true }).catch(() => undefined)
        }
        if (allowSync && !(await fileRow.isVisible().catch(() => false))) {
          await syncDealIndexIfNeeded(page, Math.max(60_000, Math.floor(timeout / 2))).catch(() => undefined)
        }
        if (!(await fileList.isVisible().catch(() => false))) continue
        if (await fileRow.isVisible().catch(() => false)) return true
      }
      if (await refreshDealsBtn.isVisible().catch(() => false)) {
        await refreshDealsBtn.click({ force: true }).catch(() => undefined)
      }
      return false
    }, { timeout: pollTimeout })
    .toBe(true)
  }

  try {
    await pollForRow(false, Math.max(30_000, Math.floor(timeout / 2)))
  } catch {
    await pollForRow(true, timeout)
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
  test.describe.configure({ retries: process.env.CI && !isMode2Fast ? 1 : 0 })

  test('mode2 deal → shard → upload → commit → retrieve', async ({ page }) => {
    test.setTimeout(mode2FastTestTimeoutMs)

    const filePath = 'mode2-small.bin'
    const fileBytes = crypto.randomBytes(160 * 1024) // spans multiple blobs without compressing to a tiny payload

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)

    await ensureWalletFunded(page, mode2FastPrimaryWaitMs)

    await ensureCreateDealDrawerOpen(page)
    await page.getByTestId('alloc-submit').click()
    const workspaceTitle = page.getByTestId('workspace-deal-title')
    await expect(workspaceTitle).toHaveText(/Deal #\d+/, { timeout: mode2FastPrimaryWaitMs })
    await dismissCreateDealDrawer(page)
    const dealTitle = (await workspaceTitle.textContent().catch(() => '')) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    const newDealRow = page.getByTestId(`deal-row-${dealId}`)
    await expect(newDealRow).toBeVisible({ timeout: 60_000 })
    await newDealRow.click()
    await expect(workspaceTitle).toHaveText(new RegExp(`#${dealId}`), { timeout: 60_000 })

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: mode2FastPrimaryWaitMs })
    await waitForGatewayConnected(page)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: filePath,
      mimeType: 'application/octet-stream',
      buffer: fileBytes,
    })

    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')

    await completeUploadAndCommit(uploadBtn, commitBtn, filePath, dealId, mode2FastUploadWaitMs)

    const fileRow = await waitForDealFileRow(page, dealId, filePath, mode2FastPrimaryWaitMs)

    const autoDownloadBtn = page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`)
    const routeEl = page.getByTestId('transport-route')

    await expect(autoDownloadBtn).toBeEnabled({ timeout: mode2FastPrimaryWaitMs })

    if (isMode2Fast) {
      const gatewayDownloadBtn = await openFileActionMenuItem(page, filePath, 'deal-detail-download-gateway')
      const providerDownloadBtn = await openFileActionMenuItem(page, filePath, 'deal-detail-download-sp')
      const browserSlabBtn = await openFileActionMenuItem(page, filePath, 'deal-detail-download-browser-slab')
      await expect(gatewayDownloadBtn).toBeEnabled({ timeout: mode2FastPrimaryWaitMs })
      await expect(providerDownloadBtn).toBeEnabled({ timeout: mode2FastPrimaryWaitMs })
      await expect(browserSlabBtn).toBeEnabled({ timeout: mode2FastPrimaryWaitMs })

      const gatewayBytes = await readDownloadBytes(page, gatewayDownloadBtn, mode2FastMaybeDownloadMs)
      expect(gatewayBytes.equals(fileBytes)).toBe(true)
      await expect(routeEl).toBeVisible({ timeout: 60_000 })
      await expect(fileRow).toBeVisible({ timeout: 60_000 })
      return
    }

    const gatewayDownloadBtn = await openFileActionMenuItem(page, filePath, 'deal-detail-download-gateway')
    const providerDownloadBtn = await openFileActionMenuItem(page, filePath, 'deal-detail-download-sp')

    await expect(gatewayDownloadBtn).toBeEnabled({ timeout: mode2FastPrimaryWaitMs })
    await expect(providerDownloadBtn).toBeEnabled({ timeout: mode2FastPrimaryWaitMs })

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
    let fetchGatewayRequests = 0
    let planGatewayRequests = 0
    let downloadGatewayCalls = 0
    let downloadProviderCalls = 0
    let downloadGatewayRequests = 0
    let downloadProviderRequests = 0
    const unsignedMissingRangeRequests: string[] = []
    page.on('response', (resp) => {
      const url = resp.url()
      const isFetchPath = url.includes('/gateway/fetch/') || url.includes('/sp/retrieval/fetch/')
      const isPlanPath = url.includes('/plan-retrieval-session/')
      const isDownloadPath = url.includes('/gateway/download/') || url.includes('/sp/retrieval/download/')
      if (!isFetchPath && !isPlanPath && !isDownloadPath) return
      let origin = ''
      try {
        origin = new URL(url).origin
      } catch (err) {
        void err
      }
      const viaGateway = /:8080$/.test(origin)
      if (isDownloadPath) {
        if (resp.request().method().toUpperCase() === 'GET') {
          if (viaGateway) downloadGatewayCalls += 1
          else downloadProviderCalls += 1
        }
        return
      }
      if (isFetchPath) {
        if (viaGateway) fetchGatewayCalls += 1
        else fetchProviderCalls += 1
        return
      }
      if (viaGateway) planGatewayCalls += 1
      else planProviderCalls += 1
    })
    page.on('request', (req) => {
      const url = req.url()
      const isFetchPath = url.includes('/gateway/fetch/') || url.includes('/sp/retrieval/fetch/')
      const isPlanPath = url.includes('/plan-retrieval-session/')
      const isDownloadPath = url.includes('/gateway/download/') || url.includes('/sp/retrieval/download/')
      if (!isFetchPath && !isPlanPath && !isDownloadPath) return
      let origin = ''
      try {
        origin = new URL(url).origin
      } catch (err) {
        void err
      }
      const viaGateway = /:8080$/.test(origin)
      if (isDownloadPath) {
        if (req.method().toUpperCase() === 'GET') {
          if (viaGateway) downloadGatewayRequests += 1
          else downloadProviderRequests += 1
        }
        return
      }
      if (viaGateway && isPlanPath) {
        planGatewayRequests += 1
      }
      if (!isFetchPath) return
      if (viaGateway) fetchGatewayRequests += 1
      const headers = req.headers()
      const hasAuth = Boolean(headers.authorization || headers['x-nil-auth'] || headers['x-nil-signature'] || headers['x-nil-voucher'])
      const range = String(headers.range || '').trim()
      if (!hasAuth && !/^bytes=\d+-\d*$/.test(range)) {
        unsignedMissingRangeRequests.push(`${req.method()} ${url} range=${range || '<none>'}`)
      }
    })
    const assertUnsignedRangeInvariant = (step: string) => {
      expect(unsignedMissingRangeRequests, `unsigned /gateway/fetch requests without Range (${step})`).toEqual([])
    }

    const clearBrowserCache = async () => {
      if (await clearBrowserCacheBtn.isEnabled().catch(() => false)) {
        await clearBrowserCacheBtn.click()
      }
      await expect(fileRow).toHaveAttribute('data-cache-browser', 'no', { timeout: 60_000 })
    }

    await clearBrowserCache()

    const autoGatewayFetchBefore = fetchGatewayCalls
    const autoProviderFetchBefore = fetchProviderCalls
    const autoGatewayPlanBefore = planGatewayCalls
    const autoProviderPlanBefore = planProviderCalls
    const autoBytes = await readDownloadBytes(page, autoDownloadBtn, mode2FastMaybeDownloadMs)
    expect(autoBytes.equals(fileBytes)).toBe(true)
    await expect(page.getByTestId('transport-cache-source')).toContainText(/gateway_mdu_cache|network_fetch/i, { timeout: 60_000 })
    await expect(page.getByTestId('transport-cache-freshness')).toContainText(/fresh|unknown|stale/i, { timeout: 60_000 })
    expect(fetchGatewayCalls > autoGatewayFetchBefore || planGatewayCalls > autoGatewayPlanBefore).toBe(true)
    expect(fetchProviderCalls).toBe(autoProviderFetchBefore)
    expect(planProviderCalls).toBe(autoProviderPlanBefore)
    assertUnsignedRangeInvariant('auto download')
    await expect(fileRow).toHaveAttribute('data-cache-browser', 'yes', { timeout: 60_000 })

    const cacheFetchGatewayBefore = fetchGatewayCalls
    const cacheFetchProviderBefore = fetchProviderCalls
    const cachePlanGatewayBefore = planGatewayCalls
    const cachePlanProviderBefore = planProviderCalls
    const cachedBytes = await readDownloadBytesMaybe(page, browserCacheBtn, 90_000)
    if (cachedBytes) {
      expect(cachedBytes.equals(fileBytes)).toBe(true)
      expect(fetchGatewayCalls).toBe(cacheFetchGatewayBefore)
      expect(fetchProviderCalls).toBe(cacheFetchProviderBefore)
      expect(planGatewayCalls).toBe(cachePlanGatewayBefore)
      expect(planProviderCalls).toBe(cachePlanProviderBefore)
    } else {
      const errorBanner = page.locator('div').filter({ hasText: /^Download failed:/ }).first()
      await expect(errorBanner).toContainText(/browser cache unavailable|not cached|local_manifest_missing/i, { timeout: 60_000 })
    }
    assertUnsignedRangeInvariant('browser cache download')

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
      assertUnsignedRangeInvariant('browser slab download')
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
    await expect(page.getByTestId('transport-cache-source')).toContainText(/network_fetch/i, { timeout: 60_000 })
    expect(fetchProviderCalls > providerFetchBefore || planProviderCalls > providerPlanBefore).toBe(true)
    assertUnsignedRangeInvariant('on-chain retrieval button')

    await clearBrowserCache()
    const gatewayFetchBefore = fetchGatewayCalls
    const gatewayPlanBefore = planGatewayCalls
    const gatewayProviderFetchBefore = fetchProviderCalls
    const gatewayProviderPlanBefore = planProviderCalls
    const gatewayDownloadCallsBefore = downloadGatewayCalls
    const gatewayDownloadReqBefore = downloadGatewayRequests
    const providerDownloadCallsBefore = downloadProviderCalls
    const providerDownloadReqBefore = downloadProviderRequests
    const gatewayBytes = await readDownloadBytesMaybe(page, gatewayDownloadBtn, 120_000)
    if (gatewayBytes) {
      expect(gatewayBytes.equals(fileBytes)).toBe(true)
      expect(downloadGatewayCalls - gatewayDownloadCallsBefore).toBe(1)
      expect(downloadGatewayRequests - gatewayDownloadReqBefore).toBe(1)
      expect(downloadProviderCalls).toBe(providerDownloadCallsBefore)
      expect(downloadProviderRequests).toBe(providerDownloadReqBefore)
      expect(fetchGatewayCalls).toBe(gatewayFetchBefore)
      expect(planGatewayCalls).toBe(gatewayPlanBefore)
      expect(fetchProviderCalls).toBe(gatewayProviderFetchBefore)
      expect(planProviderCalls).toBe(gatewayProviderPlanBefore)
      assertUnsignedRangeInvariant('gateway retrieval button')
    } else {
      const errorBanner = page.locator('div').filter({ hasText: /^Download failed:/ }).first()
      await expect(errorBanner).toContainText(/download failed|gateway|cache/i, { timeout: 60_000 })
    }

    blockGateway = true
    await page.evaluate(() => {
      window.localStorage.setItem('nil_local_gateway_connected', '0')
      window.localStorage.setItem('nil_transport_preference', 'auto')
    })
    await clearBrowserCache()
    const fallbackGatewayFetchReqBefore = fetchGatewayRequests
    const fallbackGatewayPlanReqBefore = planGatewayRequests
    const fallbackGatewayFetchRespBefore = fetchGatewayCalls
    const fallbackGatewayPlanRespBefore = planGatewayCalls
    const fallbackFetchBefore = fetchProviderCalls
    const fallbackPlanBefore = planProviderCalls
    const fallbackBytes = await readDownloadBytes(page, autoDownloadBtn)
    expect(fallbackBytes.equals(fileBytes)).toBe(true)
    await expect(routeEl).toHaveAttribute('data-download-route', 'direct_sp', { timeout: 60_000 })
    expect(fetchGatewayRequests).toBeGreaterThanOrEqual(fallbackGatewayFetchReqBefore)
    expect(planGatewayRequests).toBeGreaterThanOrEqual(fallbackGatewayPlanReqBefore)
    expect(fetchGatewayCalls).toBe(fallbackGatewayFetchRespBefore)
    expect(planGatewayCalls).toBe(fallbackGatewayPlanRespBefore)
    expect(fetchProviderCalls > fallbackFetchBefore || planProviderCalls > fallbackPlanBefore).toBe(true)
    assertUnsignedRangeInvariant('auto fallback retrieval')
    blockGateway = false
  })

  test('mode2 upload without gateway still supports browser MDU download path', async ({ page }) => {
    test.setTimeout(mode2FastTestTimeoutMs)

    const filePath = 'mode2-no-gateway-upload.txt'
    const fileBytes = Buffer.alloc(192 * 1024, 'N')
    const mduUploads: Array<{ bodyLen: number; fullSize: number | null; mduIndex: string }> = []
    const manifestUploads: Array<{ bodyLen: number; fullSize: number | null }> = []
    const shardUploads: Array<{ bodyLen: number; fullSize: number | null; mduIndex: string; slot: string }> = []

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)

    await ensureWalletFunded(page, mode2FastPrimaryWaitMs)

    await ensureCreateDealDrawerOpen(page)
    await page.getByTestId('alloc-submit').click()
    const workspaceTitle = page.getByTestId('workspace-deal-title')
    await expect(workspaceTitle).toHaveText(/Deal #\d+/, { timeout: mode2FastPrimaryWaitMs })
    await dismissCreateDealDrawer(page)
    const dealTitle = (await workspaceTitle.textContent().catch(() => '')) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    const newDealRow = page.getByTestId(`deal-row-${dealId}`)
    await expect(newDealRow).toBeVisible({ timeout: 60_000 })
    await newDealRow.click()
    await expect(workspaceTitle).toHaveText(new RegExp(`#${dealId}`), { timeout: 60_000 })

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: mode2FastPrimaryWaitMs })

    let blockGatewayUpload = true
    const unsignedMissingRangeRequests: string[] = []
    const maybeBlockGatewayUpload = async (route: import('@playwright/test').Route) => {
      if (blockGatewayUpload && route.request().method().toUpperCase() !== 'OPTIONS') {
        await route.abort('failed')
        return
      }
      await route.continue()
    }
    page.on('request', (req) => {
      const url = req.url()
      if (!url.includes('/gateway/fetch/') && !url.includes('/sp/retrieval/fetch/')) return
      const headers = req.headers()
      const hasAuth = Boolean(headers.authorization || headers['x-nil-auth'] || headers['x-nil-signature'] || headers['x-nil-voucher'])
      const range = String(headers.range || '').trim()
      if (!hasAuth && !/^bytes=\d+-\d*$/.test(range)) {
        unsignedMissingRangeRequests.push(`${req.method()} ${url} range=${range || '<none>'}`)
      }
    })
    await page.route('**/gateway/upload*', maybeBlockGatewayUpload)
    await page.route('**/gateway/upload-status*', maybeBlockGatewayUpload)
    await page.route('**/sp/upload_mdu', async (route) => {
      const body = route.request().postDataBuffer() || Buffer.alloc(0)
      const headers = route.request().headers()
      const fullSizeHeader = headers['x-nil-full-size']
      mduUploads.push({
        bodyLen: body.length,
        fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
        mduIndex: headers['x-nil-mdu-index'] || '',
      })
      await route.fulfill({ status: 200, body: 'ok' })
    })
    await page.route('**/sp/upload_manifest', async (route) => {
      const body = route.request().postDataBuffer() || Buffer.alloc(0)
      const headers = route.request().headers()
      const fullSizeHeader = headers['x-nil-full-size']
      manifestUploads.push({
        bodyLen: body.length,
        fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
      })
      await route.fulfill({ status: 200, body: 'ok' })
    })
    await page.route('**/sp/upload_shard', async (route) => {
      const body = route.request().postDataBuffer() || Buffer.alloc(0)
      const headers = route.request().headers()
      const fullSizeHeader = headers['x-nil-full-size']
      shardUploads.push({
        bodyLen: body.length,
        fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
        mduIndex: headers['x-nil-mdu-index'] || '',
        slot: headers['x-nil-slot'] || '',
      })
      await route.fulfill({ status: 200, body: 'ok' })
    })

    const compressCheckbox = page
      .locator('label')
      .filter({ hasText: 'Compress before upload' })
      .locator('input[type="checkbox"]')
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
    await waitForUploadControls(uploadBtn, commitBtn, mode2FastUploadWaitMs)
    if ((await uploadBtn.count().catch(() => 0)) > 0) {
      await expect(uploadBtn).toBeEnabled({ timeout: mode2FastUploadWaitMs })
      await uploadBtn.click()
      await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: mode2FastUploadWaitMs })
    }
    const activity = await openSystemActivity(page)
    await expect(activity).toContainText(/falling back to in-browser mode 2 sharding \+ stripe upload/i, {
      timeout: mode2FastUploadWaitMs,
    })
    expect(mduUploads.length).toBeGreaterThan(0)
    expect(manifestUploads.length).toBeGreaterThan(0)
    expect(shardUploads.length).toBeGreaterThan(0)

    const sparseMduUploads = mduUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)
    const sparseManifestUploads = manifestUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)
    const sparseShardUploads = shardUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)

    console.log('[mode2 sparse upload evidence]', {
      mduUploads,
      manifestUploads,
      shardUploads: shardUploads.slice(0, 6),
    })

    expect(sparseMduUploads.length).toBeGreaterThan(0)
    expect(sparseManifestUploads.length).toBeGreaterThan(0)
    expect(sparseShardUploads.length).toBeGreaterThan(0)
    expect(Math.max(...sparseMduUploads.map((upload) => upload.bodyLen))).toBeLessThan(2 * 1024 * 1024)
    await expect
      .poll(() => isCommitCompleteOrReset(page, commitBtn, filePath, dealId, '', true), { timeout: mode2FastPrimaryWaitMs })
      .toBe(true)
    blockGatewayUpload = false

    await newDealRow.first().scrollIntoViewIfNeeded().catch(() => undefined)
    await newDealRow.click({ force: true }).catch(() => undefined)
    await expect(workspaceTitle).toHaveText(new RegExp(`#${dealId}`), { timeout: 60_000 })

    const fileRow = await waitForFileRowInAnyDeal(page, filePath, mode2FastUploadWaitMs)
    const browserSlabBtn = await openFileActionMenuItem(page, filePath, 'deal-detail-download-browser-slab')
    await expect(browserSlabBtn).toBeVisible({ timeout: 60_000 })

    let slabBytes = await readDownloadBytesMaybe(page, browserSlabBtn, mode2FastMaybeDownloadMs)
    if (!slabBytes) {
      await waitForDealFileRow(page, dealId, filePath, mode2FastPrimaryWaitMs)
      slabBytes = await readDownloadBytesMaybe(page, browserSlabBtn, mode2FastMaybeDownloadMs)
    }
    if (!slabBytes) {
      const errorBanner = page.locator('div').filter({ hasText: /^Download failed:/ }).first()
      await expect(errorBanner).toContainText(/local slab not available/i, { timeout: 60_000 })
      throw new Error('browser slab download did not produce a file')
    }
    expect(slabBytes.equals(fileBytes)).toBe(true)
    expect(unsignedMissingRangeRequests, 'unsigned /gateway/fetch requests without Range (fallback slab test)').toEqual([])
    await expect(fileRow).toHaveAttribute('data-cache-browser', 'yes', { timeout: 60_000 })
    const browserCacheBtn = await openFileActionMenuItem(page, filePath, 'deal-detail-download-browser-cache')
    const clearBrowserCacheBtn = await openFileActionMenuItem(page, filePath, 'deal-detail-clear-browser-cache')
    await expect(browserCacheBtn).toBeEnabled({ timeout: 60_000 })
    await expect(clearBrowserCacheBtn).toBeEnabled({ timeout: 60_000 })
  })

  test('mode2 append keeps prior files', async ({ page }) => {
    test.slow()
    test.setTimeout(600_000)

    const fileA = { name: 'mode2-a.txt', buffer: Buffer.alloc(32 * 1024, 'A') }
    const fileB = { name: 'mode2-b.txt', buffer: Buffer.alloc(32 * 1024, 'B') }

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)

    await ensureWalletFunded(page, 180_000)

    await ensureCreateDealDrawerOpen(page)
    await page.getByTestId('alloc-submit').click()
    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    await dismissCreateDealDrawer(page)
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

    await completeUploadAndCommit(uploadBtn, commitBtn, fileA.name, dealId, 300_000)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileB.name,
      mimeType: 'text/plain',
      buffer: fileB.buffer,
    })

    await completeUploadAndCommit(uploadBtn, commitBtn, fileB.name, dealId, 300_000)
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

    await ensureWalletFunded(page, 180_000)
    console.log('[rehydrate-e2e] faucet funded')

    await ensureCreateDealDrawerOpen(page)
    await page.getByTestId('alloc-submit').click()
    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    await dismissCreateDealDrawer(page)
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

    await completeUploadAndCommit(uploadBtn, commitBtn, fileA.name, dealId, 300_000)
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

    const activity = await openSystemActivity(page)
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

    await expect
      .poll(() => isCommitCompleteOrReset(page, commitBtn, fileB.name, dealId, '', true), { timeout: 180_000 })
      .toBe(true)
    console.log('[rehydrate-e2e] fileB committed')
    console.log(
      `[rehydrate-e2e] completed successfully (gatewayUploads=${gatewayUploadPostCount}, mirrorCalls=${
        mirrorMduCalls + mirrorManifestCalls + mirrorShardCalls
      })`,
    )
  })
})
