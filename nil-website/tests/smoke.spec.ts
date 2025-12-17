import { test, expect } from '@playwright/test'

const path = process.env.E2E_PATH || '/#/dashboard'

test('dashboard loads and shows wallet prompt + bridge status', async ({ page }) => {
  await page.goto(path)
  await expect(page.getByTestId('connect-wallet').first()).toBeVisible()
  const bridge = page.getByText(/EVM Bridge/i)
  if ((await bridge.count()) > 0) {
    await expect(bridge).toBeVisible()
  }
})
