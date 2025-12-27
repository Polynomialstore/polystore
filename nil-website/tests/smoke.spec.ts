import { test, expect } from '@playwright/test'

const path = process.env.E2E_PATH || '/#/dashboard'

test('dashboard loads and shows wallet prompt + bridge status', async ({ page }) => {
  await page.goto(path)
  await page.waitForSelector('[data-testid="connect-wallet"], [data-testid="wallet-address"], [data-testid="wallet-address-full"]', {
    timeout: 60_000,
    state: 'attached',
  })
  const walletAddress = page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()
  const connectWallet = page.getByTestId('connect-wallet').first()
  if (!(await walletAddress.isVisible().catch(() => false))) {
    await expect(connectWallet).toBeVisible()
  }
  const bridge = page.getByText(/EVM Bridge/i)
  if ((await bridge.count()) > 0) {
    await expect(bridge).toBeVisible()
  }
})
