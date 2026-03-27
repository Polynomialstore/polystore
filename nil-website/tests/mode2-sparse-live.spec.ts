import { test, expect, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import { dismissCreateDealDrawer, ensureCreateDealDrawerOpen } from './utils/dashboard'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

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
    const walletVisible = await walletAddress.isVisible().catch(() => false)
    if (walletVisible) return true

    if (await cosmosIdentity.isVisible().catch(() => false)) {
      const raw = ((await cosmosIdentity.textContent().catch(() => '')) || '').trim()
      if (raw && raw !== '—' && !/^not\s+connected$/i.test(raw)) return true
    }
    return false
  }

  if (await isConnected()) return
  if (await connectBtn.isVisible().catch(() => false)) {
    await connectBtn.click({ force: true })
  }

  const browserWalletBtn = page.getByRole('button', { name: /Browser Wallet/i })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await isConnected()) return
    if (await browserWalletBtn.isVisible().catch(() => false)) {
      await browserWalletBtn.click({ force: true })
    }
    await page.waitForTimeout(500)
    if (await connectBtn.isVisible().catch(() => false)) {
      await connectBtn.click({ force: true })
    }
  }

  expect(await isConnected()).toBe(true)
}

async function ensureWalletFunded(page: Page, timeout = 120_000): Promise<void> {
  const stakeBalance = page.getByTestId('cosmos-stake-balance')
  const current = ((await stakeBalance.textContent().catch(() => '')) || '').trim()
  if (current && !/^(?:—|0 stake)$/.test(current)) return

  const faucetButton = page.getByTestId('faucet-request')
  if (await faucetButton.isVisible().catch(() => false)) {
    await faucetButton.click()
  }
  await expect(stakeBalance).not.toHaveText(/^(?:—|0 stake)$/, { timeout })
}

test.describe('mode2 sparse live', () => {
  test.skip(!hasLocalStack, 'requires local stack')

  test('browser fallback upload sends sparse bodies on the live local stack', async ({ page }) => {
    test.setTimeout(300_000)

    const filePath = 'mode2-sparse-live.bin'
    const fileBytes = crypto.randomBytes(192 * 1024)
    const mduUploads: Array<{ bodyLen: number; fullSize: number | null; mduIndex: string }> = []
    const manifestUploads: Array<{ bodyLen: number; fullSize: number | null }> = []
    const shardUploads: Array<{ bodyLen: number; fullSize: number | null; mduIndex: string; slot: string }> = []
    let gatewayUploadAttempts = 0
    let activeUploads = 0
    let peakActiveUploads = 0

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
      await route.abort('failed')
    })
    await page.route('**/gateway/upload-status*', async (route) => {
      gatewayUploadAttempts += 1
      await route.abort('failed')
    })
    await page.route('**/sp/upload_mdu', async (route) => {
      const body = route.request().postDataBuffer() || Buffer.alloc(0)
      const headers = route.request().headers()
      const fullSizeHeader = headers['x-nil-full-size']
      mduUploads.push({
        bodyLen: body.length,
        fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
        mduIndex: headers['x-nil-mdu-index'] || '',
      })
      await recordConcurrentUpload(() => route.fulfill({ status: 200, body: 'ok' }))
    })
    await page.route('**/sp/upload_manifest', async (route) => {
      const body = route.request().postDataBuffer() || Buffer.alloc(0)
      const headers = route.request().headers()
      const fullSizeHeader = headers['x-nil-full-size']
      manifestUploads.push({
        bodyLen: body.length,
        fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
      })
      await recordConcurrentUpload(() => route.fulfill({ status: 200, body: 'ok' }))
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
      await recordConcurrentUpload(() => route.fulfill({ status: 200, body: 'ok' }))
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)
    await expect(page.getByText('Wrong Network')).toHaveCount(0)
    await ensureWalletFunded(page)

    await ensureCreateDealDrawerOpen(page)
    await page.getByTestId('alloc-submit').click()
    const workspaceTitle = page.getByTestId('workspace-deal-title')
    await expect(workspaceTitle).toHaveText(/Deal #\d+/, { timeout: 120_000 })
    await dismissCreateDealDrawer(page)
    const dealTitle = (await workspaceTitle.textContent().catch(() => '')) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    const dealRow = page.getByTestId(`deal-row-${dealId}`)
    await expect(dealRow).toBeVisible({ timeout: 60_000 })
    await dealRow.click()
    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 60_000 })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: filePath,
      mimeType: 'application/octet-stream',
      buffer: fileBytes,
    })

    const commitBtn = page.getByTestId('mdu-commit')
    await expect(page.getByTestId('mdu-upload-state')).toHaveText(/Upload Complete/i, { timeout: 180_000 })

    const underTheHood = page.getByTestId('mdu-under-the-hood')
    await expect(underTheHood).toBeVisible({ timeout: 60_000 })
    const underTheHoodOpen = await underTheHood.evaluate((node) => node.hasAttribute('open')).catch(() => false)
    if (!underTheHoodOpen) {
      await page.getByTestId('mdu-under-the-hood-toggle').click()
    }
    const activityToggle = page.getByTestId('mdu-system-activity-toggle')
    await expect(activityToggle).toBeVisible({ timeout: 60_000 })
    await activityToggle.click()
    const activity = page.getByTestId('mdu-system-activity')
    await expect(activity).toContainText(/falling back to in-browser mode 2 sharding \+ stripe upload/i, {
      timeout: 60_000,
    })

    expect(gatewayUploadAttempts).toBeGreaterThan(0)
    expect(mduUploads.length).toBeGreaterThan(0)
    expect(manifestUploads.length).toBeGreaterThan(0)
    expect(shardUploads.length).toBeGreaterThan(0)

    const sparseMduUploads = mduUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)
    const sparseManifestUploads = manifestUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)
    const sparseShardUploads = shardUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)

    console.log('[mode2 sparse live evidence]', {
      gatewayUploadAttempts,
      mduUploads,
      manifestUploads,
      shardUploads: shardUploads.slice(0, 6),
      peakActiveUploads,
    })

    expect(sparseMduUploads.length).toBeGreaterThan(0)
    expect(sparseManifestUploads.length).toBeGreaterThan(0)
    expect(sparseShardUploads.length).toBeGreaterThan(0)
    expect(peakActiveUploads).toBeGreaterThan(1)
    expect(Math.max(...sparseMduUploads.map((upload) => upload.bodyLen))).toBeLessThan(3 * 1024 * 1024)

    await expect
      .poll(async () => {
        const panelState = await page.getByTestId('mdu-upload-card').getAttribute('data-panel-state').catch(() => null)
        if (panelState === 'success') return true
        const text = ((await commitBtn.textContent().catch(() => '')) || '').trim()
        if (/Committed!/i.test(text)) return true
        const ready = await commitBtn.isEnabled().catch(() => false)
        if (ready) {
          await commitBtn.click()
        }
        return false
      }, { timeout: 180_000 })
      .toBe(true)
  })
})
