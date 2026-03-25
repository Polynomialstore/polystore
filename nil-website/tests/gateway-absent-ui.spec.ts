import { test, expect } from '@playwright/test'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

async function completeUploadAndCommit(page: Parameters<typeof test>[0]['page'], timeout = 300_000): Promise<void> {
  const uploadBtn = page.getByTestId('mdu-upload')
  const commitBtn = page.getByTestId('mdu-commit')
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const panelState = await page.getByTestId('mdu-upload-card').getAttribute('data-panel-state').catch(() => null)
    if (panelState === 'success') return

    const commitText = ((await commitBtn.textContent().catch(() => '')) || '').trim()
    if (/Committed!/i.test(commitText)) return

    const commitReady = (await commitBtn.count().catch(() => 0)) > 0 && (await commitBtn.isEnabled().catch(() => false))
    if (commitReady) {
      await commitBtn.click()
      await expect
        .poll(async () => {
          const state = await page.getByTestId('mdu-upload-card').getAttribute('data-panel-state').catch(() => null)
          if (state === 'success') return true
          const text = ((await commitBtn.textContent().catch(() => '')) || '').trim()
          return /Committed!/i.test(text)
        }, { timeout: 180_000 })
        .toBe(true)
      return
    }

    const uploadReady = (await uploadBtn.count().catch(() => 0)) > 0 && (await uploadBtn.isVisible().catch(() => false)) && (await uploadBtn.isEnabled().catch(() => false))
    if (uploadReady) {
      await uploadBtn.click({ force: true })
      await expect
        .poll(async () => {
          if (await commitBtn.isEnabled().catch(() => false)) return true
          const text = ((await uploadBtn.textContent().catch(() => '')) || '').trim()
          return /Upload Complete/i.test(text)
        }, { timeout: 120_000 })
        .toBe(true)
    }

    await page.waitForTimeout(500)
  }

  await expect
    .poll(async () => {
      const state = await page.getByTestId('mdu-upload-card').getAttribute('data-panel-state').catch(() => null)
      if (state === 'success') return true
      const text = ((await commitBtn.textContent().catch(() => '')) || '').trim()
      return /Committed!/i.test(text)
    }, { timeout: 180_000 })
    .toBe(true)
}

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
    const compressToggle = page.locator('label').filter({ hasText: 'Compress before upload' })
    const compressCheckbox = compressToggle.locator('input[type="checkbox"]')
    if (await compressCheckbox.isChecked().catch(() => false)) {
      await compressToggle.click({ force: true })
    }
    await mode2FileInput.setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: fileBytes,
    })

    await expect(page.getByTestId('mdu-upload-card')).toHaveAttribute('data-panel-state', 'running', { timeout: 60_000 })
    await expect(page.getByRole('button', { name: /Retry Upload/i })).toHaveCount(0)
    await expect(page.getByTestId('mdu-under-the-hood')).toBeVisible({ timeout: 60_000 })

    await completeUploadAndCommit(page, 180_000)

    await expect(page.getByTestId('mdu-upload-card')).toHaveAttribute('data-panel-state', 'success', { timeout: 180_000 })
    await expect(page.locator('text=/^Tx: 0x/i').first()).toBeVisible({ timeout: 180_000 })
    await expect(page.getByTestId(`deal-manifest-${dealId}`)).toContainText('0x', { timeout: 180_000 })
    await expect(page.getByTestId('mdu-upload-card').getByText(/^Upload file$/i)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('Upload another file')).toHaveCount(0)
    await expect(page.getByTestId('deal-index-sync-panel')).toHaveCount(0)
    await expect(page.getByTestId('deal-detail-file-row')).toHaveCount(1, { timeout: 60_000 })
    await expect(page.getByTestId('deal-detail-file-row').first()).toContainText(fileName, { timeout: 60_000 })
  })
})
