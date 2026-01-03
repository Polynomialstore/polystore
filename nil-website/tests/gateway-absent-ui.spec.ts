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

  const redundancySelect = page.getByTestId('alloc-redundancy-mode')
  if (!(await redundancySelect.isVisible().catch(() => false))) {
    await page.getByTestId('workspace-advanced-toggle').click()
    await expect(redundancySelect).toBeVisible({ timeout: 10_000 })
  }
  await redundancySelect.selectOption('mode1')
  await page.getByTestId('alloc-submit').click()

  await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 120_000 })

  const fileInput = page.getByTestId('content-file-input')
  if (!(await fileInput.isVisible().catch(() => false))) {
    const mode1Toggle = page.getByTestId('tab-content')
    if (await mode1Toggle.isVisible().catch(() => false)) {
      await mode1Toggle.click()
    }
  }
  await expect(fileInput).toBeVisible({ timeout: 120_000 })
  await expect(fileInput).toBeEnabled({ timeout: 120_000 })
  await fileInput.setInputFiles({
    name: 'gateway-absent.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('gateway-absent-upload'),
  })

  await expect(page.getByTestId('staged-manifest-root')).toContainText('0x', { timeout: 120_000 })

  await expect(page.getByText(/Route: direct sp/i)).toBeVisible({ timeout: 120_000 })
  })
})
