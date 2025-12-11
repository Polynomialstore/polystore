import { test, expect } from '@playwright/test'

const path = process.env.E2E_PATH || '/#/dashboard'

test('dashboard loads and shows wallet + bridge scaffolding', async ({ page }) => {
  await page.goto(path)

  await expect(page.getByText(/Connect MetaMask/i)).toBeVisible()
  await expect(page.getByText(/My Storage Deals/i)).toBeVisible()

  // Bridge widgets should render when a bridge address is configured (may show empty when unset).
  await expect(page.getByText(/EVM Bridge/i)).toBeVisible()
})
