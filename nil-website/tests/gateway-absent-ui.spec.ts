import { test, expect } from '@playwright/test'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

test.describe('gateway absent', () => {
  test.skip(!hasLocalStack, 'requires local stack (gateway disabled)')

  test('gateway absent: dashboard upload falls back to direct SP', async ({ page }) => {
  test.setTimeout(300_000)

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
  await page.waitForSelector('[data-testid="connect-wallet"], [data-testid="wallet-address"], [data-testid="wallet-address-full"]', {
    timeout: 60_000,
    state: 'attached',
  })
  const walletAddress = page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()
  if (!(await walletAddress.isVisible().catch(() => false))) {
    const connectButton = page.getByTestId('connect-wallet').first()
    await connectButton.click({ force: true })
    await page.evaluate(async () => {
      const eth = (window as { ethereum?: { request?: (args: { method: string }) => Promise<unknown> } }).ethereum
      if (!eth?.request) {
        throw new Error('No injected wallet available for E2E')
      }
      await eth.request({ method: 'eth_requestAccounts' })
    })
    await expect(walletAddress).toBeVisible({ timeout: 60_000 })
  }

  await page.getByTestId('faucet-request').click()
  const stakeBalance = page.getByTestId('cosmos-stake-balance')
  await expect(stakeBalance).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 120_000 })

  const placementSelect = page.getByTestId('alloc-placement-profile')
  if (!(await placementSelect.isVisible().catch(() => false))) {
    await page.getByTestId('workspace-advanced-toggle').click()
    await expect(placementSelect).toBeVisible({ timeout: 10_000 })
  }
  await placementSelect.selectOption('auto')
  await page.getByTestId('alloc-submit').click()

  await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 120_000 })
  const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
  const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
  expect(dealId).not.toBe('')

  // Mode 2 upload uses the FileSharder (WASM sharding + direct SP fallback).
  // The input is hidden; interact with it directly via test id.
  const mode2FileInput = page.getByTestId('mdu-file-input')
  if ((await mode2FileInput.count().catch(() => 0)) === 0) {
    const toggle = page.getByTestId('tab-content')
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click()
    }
  }
  await expect(mode2FileInput).toHaveCount(1, { timeout: 120_000 })
  await mode2FileInput.setInputFiles({
    name: 'gateway-absent.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('gateway-absent-upload'),
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

  const routeLabel = page.getByTestId('transport-route')
  await expect(routeLabel).toBeVisible({ timeout: 120_000 })
  await expect(routeLabel).toHaveText(/Route: direct sp/i, { timeout: 120_000 })
  })
})
