import { test, expect } from '@playwright/test'
import { dismissCreateDealDrawer, ensureCreateDealDrawerOpen } from './utils/dashboard'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

test.describe('libp2p fetch (relay)', () => {
  test.skip(!hasLocalStack, 'requires local stack with libp2p relay enabled')

  test('download uses libp2p relay transport', async ({ page }) => {
    test.setTimeout(600_000)

    const filePath = 'libp2p-relay.txt'
    const fileBytes = Buffer.alloc(64 * 1024, 'R')

    page.on('pageerror', (err) => {
      console.error('[pageerror]', err.message)
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.error('[console:error]', msg.text())
      }
    })

    await page.addInitScript(() => {
      window.localStorage.setItem('polystore_transport_preference', 'prefer_p2p')
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    const waitForWalletControls = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.waitForSelector('body', { state: 'attached' })
        const hasConnect = await page.getByTestId('connect-wallet').count().catch(() => 0)
        const hasAddress = await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').count()
        const hasPolystoreIdentity = await page.getByTestId('polystore-identity').count().catch(() => 0)
        if (hasConnect > 0 || hasAddress > 0 || hasPolystoreIdentity > 0) return
        await page.waitForTimeout(1000)
        await page.reload({ waitUntil: 'networkidle' })
      }
      throw new Error('wallet controls not found')
    }

    await waitForWalletControls()
    const walletAddress = page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()
    const polystoreIdentity = page.getByTestId('polystore-identity')
    const connected =
      (await walletAddress.isVisible().catch(() => false)) ||
      (await polystoreIdentity.isVisible().catch(() => false))
    if (!connected) {
      await page.getByTestId('connect-wallet').first().click()
      await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"], [data-testid="polystore-identity"]')).toBeVisible({
        timeout: 60_000,
      })
    }

    await ensureCreateDealDrawerOpen(page)
    const advancedToggle = page.getByTestId('workspace-advanced-toggle')
    await expect(advancedToggle).toBeVisible({ timeout: 60_000 })

    const transportSelect = page.getByLabel('Preference')
    if (!(await transportSelect.isVisible().catch(() => false))) {
      await advancedToggle.click()
    }
    await expect(transportSelect).toBeVisible({ timeout: 60_000 })
    await expect(transportSelect.locator('option[value="prefer_p2p"]')).toHaveCount(1)
    await transportSelect.selectOption('prefer_p2p')

    await page.getByTestId('faucet-request').click()
    await expect(page.getByTestId('polystore-stake-balance')).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 180_000 })

    const placementSelect = page.getByTestId('alloc-placement-profile')
    if (!(await placementSelect.isVisible().catch(() => false))) {
      await page.getByTestId('workspace-advanced-toggle').click()
      await expect(placementSelect).toBeVisible({ timeout: 10_000 })
    }
    await placementSelect.selectOption('auto')
    await page.getByTestId('alloc-submit').click()
    await expect(page.getByText(/Capacity Allocated/i)).toBeVisible({ timeout: 180_000 })
    await dismissCreateDealDrawer(page)

    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    // Mode 2 upload uses the FileSharder (gateway fast path, otherwise in-browser sharding).
    // The Mode 2 file input isn't present until the FileSharder finishes loading deal params,
    // so never use "input missing" as a proxy for "wrong tab" (can flake on slow CI).
    const tabToggle = page.getByTestId('tab-content')
    if (await tabToggle.isVisible().catch(() => false)) {
      const label = ((await tabToggle.textContent()) || '').toLowerCase()
      if (label.includes('back to upload')) {
        await tabToggle.click()
      }
    }
    const mode2FileInput = page.getByTestId('mdu-file-input')
    await expect(mode2FileInput).toHaveCount(1, { timeout: 120_000 })
    await mode2FileInput.setInputFiles({
      name: filePath,
      mimeType: 'text/plain',
      buffer: fileBytes,
    })

    // If the gateway Mode 2 path is unavailable, the UI will fall back to in-browser
    // sharding which requires an explicit upload step.
    const uploadBtn = page.getByTestId('mdu-upload')
    if (await uploadBtn.isVisible().catch(() => false)) {
      await expect(uploadBtn).toBeEnabled({ timeout: 180_000 })
      await uploadBtn.click()
    }

    const commitBtn = page.getByTestId('mdu-commit')
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

    await expect(page.locator('text=/^Tx: 0x/i').first()).toBeVisible({ timeout: 180_000 })
    await expect(page.getByTestId(`deal-manifest-${dealId}`)).toContainText('0x', { timeout: 180_000 })

    const dealRow = page.getByTestId(`deal-row-${dealId}`)
    await expect(dealRow).toBeVisible({ timeout: 180_000 })
    await dealRow.click()

    const downloadBtn = page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`)
    await expect(downloadBtn).toBeEnabled({ timeout: 180_000 })
    const actionsMenu = page.locator(`[data-testid="deal-detail-actions-menu"][data-file-path="${filePath}"]`)
    await expect(actionsMenu).toBeVisible({ timeout: 60_000 })
    await actionsMenu.click({ force: true })
    const clearBrowserCacheBtn = page.locator(
      `[data-testid="deal-detail-clear-browser-cache"][data-file-path="${filePath}"]`,
    )
    if (await clearBrowserCacheBtn.isEnabled().catch(() => false)) {
      await clearBrowserCacheBtn.click()
    }

    const blockGatewayCacheFetch = async (route: import('@playwright/test').Route) => {
      if (route.request().method().toUpperCase() === 'OPTIONS') {
        await route.continue()
        return
      }
      await route.abort('failed')
    }
    await page.route('http://127.0.0.1:8080/gateway/fetch/**', blockGatewayCacheFetch)
    await page.route('http://localhost:8080/gateway/fetch/**', blockGatewayCacheFetch)

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 })
    await downloadBtn.click()
    const download = await downloadPromise
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Uint8Array))
      }
    }
    const downloaded = Buffer.concat(chunks)
    expect(downloaded.length).toBe(fileBytes.length)
    expect(downloaded.equals(fileBytes)).toBe(true)

    const routeLabel = page.getByTestId('transport-route')
    await expect(routeLabel).toBeVisible({ timeout: 60_000 })
    await expect(routeLabel).toContainText(/Route:/i)

    const attempts = (await routeLabel.getAttribute('data-transport-attempts')) || ''
    expect(attempts).toContain('p2p-circuit')
    const routeText = ((await routeLabel.textContent()) || '').toLowerCase()
    expect(routeText.includes('libp2p') || routeText.includes('direct sp')).toBe(true)

    await expect(page.getByText(/Receipt failed/i)).toHaveCount(0)
  })
})
