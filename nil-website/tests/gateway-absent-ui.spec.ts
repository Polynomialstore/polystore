import { test, expect } from '@playwright/test'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'

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
  await page.waitForSelector('[data-testid="connect-wallet"], [data-testid="wallet-address"]', {
    timeout: 60_000,
    state: 'attached',
  })
  const walletAddress = page.getByTestId('wallet-address')
  if (!(await walletAddress.isVisible().catch(() => false))) {
    const connectButton = page.getByTestId('connect-wallet').first()
    await connectButton.click()
    await expect(walletAddress).toBeVisible({ timeout: 60_000 })
  }

  await page.getByTestId('faucet-request').click()
  const stakeBalance = page.getByTestId('cosmos-stake-balance')
  await expect(stakeBalance).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 120_000 })

  await page.getByTestId('alloc-submit').click()
  await expect(page.getByText(/Capacity Allocated/i)).toBeVisible({ timeout: 120_000 })

  await page.getByTestId('tab-content').click()
  await page.waitForFunction(() => {
    const select = document.querySelector('[data-testid="content-deal-select"]') as HTMLSelectElement | null
    return Boolean(select && select.options.length > 1)
  }, null, { timeout: 120_000 })

  const dealSelect = page.getByTestId('content-deal-select')
  const currentDeal = await dealSelect.inputValue()
  if (!currentDeal) {
    const optionValue = await dealSelect.locator('option').nth(1).getAttribute('value')
    if (optionValue) {
      await dealSelect.selectOption(optionValue)
    }
  }

  const fileInput = page.getByTestId('content-file-input')
  await expect(fileInput).toBeEnabled({ timeout: 120_000 })
  await fileInput.setInputFiles({
    name: 'gateway-absent.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('gateway-absent-upload'),
  })

  await expect(page.getByTestId('staged-manifest-root')).toContainText('0x', { timeout: 120_000 })
  await expect(page.getByText(/Route: direct sp/i)).toBeVisible({ timeout: 120_000 })
})
