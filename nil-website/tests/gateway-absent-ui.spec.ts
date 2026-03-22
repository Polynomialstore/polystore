import { test, expect } from '@playwright/test'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

test.describe('gateway absent', () => {
  test.skip(!hasLocalStack, 'requires local stack (gateway disabled)')

  test('gateway absent: dashboard upload falls back to direct SP', async ({ page }) => {
    test.setTimeout(300_000)
    const fileName = 'gateway-absent.txt'
    const fileBytes = Buffer.from('gateway-absent-upload')

    page.on('pageerror', (err) => {
      console.log(`[pageerror] ${err.message}`)
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log(`[console:${msg.type()}] ${msg.text()}`)
      }
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await page.waitForSelector('#root', { timeout: 60_000 })
    await page.waitForSelector(
      '[data-testid="connect-wallet"], [data-testid="wallet-address"], [data-testid="wallet-address-full"], [data-testid="cosmos-identity"]',
      {
        timeout: 60_000,
        state: 'attached',
      },
    )
    const walletAddress = page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()
    const cosmosIdentity = page.getByTestId('cosmos-identity')
    const connected =
      (await walletAddress.isVisible().catch(() => false)) ||
      (await cosmosIdentity.isVisible().catch(() => false))
    if (!connected) {
      const connectButton = page.getByTestId('connect-wallet').first()
      await connectButton.click({ force: true })
      await page.evaluate(async () => {
        const eth = (window as { ethereum?: { request?: (args: { method: string }) => Promise<unknown> } }).ethereum
        if (!eth?.request) {
          throw new Error('No injected wallet available for E2E')
        }
        await eth.request({ method: 'eth_requestAccounts' })
      })
      await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"], [data-testid="cosmos-identity"]')).toBeVisible({
        timeout: 60_000,
      })
    }

    const fundWalletButton = page.getByRole('button', { name: /^Fund Wallet$/i }).first()
    if (await fundWalletButton.isVisible().catch(() => false)) {
      await fundWalletButton.click()
    } else {
      const faucetButton = page.getByTestId('faucet-request')
      if (await faucetButton.isVisible().catch(() => false)) {
        await faucetButton.click()
      }
    }

    const allocSubmit = page.getByTestId('alloc-submit')
    await expect(allocSubmit).toBeVisible({ timeout: 120_000 })
    await allocSubmit.click()

    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 120_000 })
    const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    // Mode 2 upload uses the FileSharder (WASM sharding + direct SP fallback).
    // The input is hidden; interact with it directly via test id.
    const mode2FileInput = page.getByTestId('mdu-file-input')
    if ((await mode2FileInput.count().catch(() => 0)) === 0) {
      // If we're on the Legacy (Mode 1) panel, switch back to Upload.
      // `tab-content` is gated behind Advanced, so enable it if needed.
      const tabToggle = page.getByTestId('tab-content')
      if ((await tabToggle.count().catch(() => 0)) === 0) {
        const advancedToggle = page.getByTestId('workspace-advanced-toggle')
        if ((await advancedToggle.count().catch(() => 0)) > 0) {
          await advancedToggle.click({ force: true })
          await expect(tabToggle).toBeAttached({ timeout: 10_000 })
        }
      }
      if ((await tabToggle.count().catch(() => 0)) > 0) {
        await tabToggle.click({ force: true })
      }
    }
    await expect(mode2FileInput).toHaveCount(1, { timeout: 180_000 })
    await mode2FileInput.setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: fileBytes,
    })

    const uploadBtn = page.getByTestId('mdu-upload')
    await expect(uploadBtn).toBeVisible({ timeout: 180_000 })
    await expect(uploadBtn).toBeEnabled({ timeout: 180_000 })
    await uploadBtn.click()

    const commitBtn = page.getByTestId('mdu-commit')
    await expect(commitBtn).toBeVisible({ timeout: 180_000 })
    await expect(commitBtn).toBeEnabled({ timeout: 180_000 })
    await commitBtn.click()

    await expect(page.locator('text=/^Tx: 0x/i').first()).toBeVisible({ timeout: 180_000 })
    await expect(page.getByTestId(`deal-manifest-${dealId}`)).toContainText('0x', { timeout: 180_000 })

    const filesTab = page.getByRole('button', { name: /^Files$/i }).first()
    if (await filesTab.isVisible().catch(() => false)) {
      await filesTab.click({ force: true })
    }
    const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${fileName}"]`)
    await expect(fileRow).toBeVisible({ timeout: 120_000 })

    await page.evaluate(() => {
      window.localStorage.setItem('nil_local_gateway_connected', '0')
      window.localStorage.setItem('nil_transport_preference', 'auto')
    })

    const autoDownloadBtn = page.locator(`[data-testid="deal-detail-download"][data-file-path="${fileName}"]`)
    await expect(autoDownloadBtn).toBeEnabled({ timeout: 120_000 })
    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 })
    await autoDownloadBtn.click()
    const download = await downloadPromise
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Uint8Array))
      }
    }
    const downloadedBytes = Buffer.concat(chunks)
    expect(downloadedBytes.equals(fileBytes)).toBe(true)

    const routeLabel = page.getByTestId('transport-route')
    await expect(routeLabel).toBeVisible({ timeout: 120_000 })
    await expect(routeLabel).toHaveText(/Route: direct sp/i, { timeout: 120_000 })
  })
})
