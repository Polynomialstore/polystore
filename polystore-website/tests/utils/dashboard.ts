import { expect, type Page } from '@playwright/test'

export async function ensureCreateDealDrawerOpen(page: Page): Promise<void> {
  const allocSubmit = page.getByTestId('alloc-submit')
  if (await allocSubmit.isVisible().catch(() => false)) return

  const newDealButton = page.getByRole('button', { name: /\+\s*new deal|new deal/i }).first()
  await expect(newDealButton).toBeVisible({ timeout: 60_000 })
  await newDealButton.click({ force: true })
  await expect(allocSubmit).toBeVisible({ timeout: 60_000 })
}

export async function dismissCreateDealDrawer(page: Page): Promise<void> {
  const drawer = page.getByTestId('create-deal-drawer')
  if ((await drawer.count().catch(() => 0)) === 0) return

  const closeButton = page.getByTestId('create-deal-close')
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click({ force: true })
  } else {
    const overlay = page.getByTestId('create-deal-overlay')
    if (await overlay.isVisible().catch(() => false)) {
      await overlay.click({ force: true })
    }
  }
}
