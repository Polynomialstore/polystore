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
  if (!(await drawer.isVisible().catch(() => false))) return

  const closeButton = page.getByTestId('create-deal-close')
  if (await closeButton.isVisible().catch(() => false)) {
    await expect(closeButton).toBeEnabled({ timeout: 180_000 })
  }
  if (await closeButton.isVisible().catch(() => false)) {
    await closeButton.click({ force: true })
    if (await drawer.isVisible().catch(() => false)) {
      await closeButton.evaluate((element) => {
        (element as HTMLButtonElement).click()
      }).catch(() => undefined)
    }
  } else {
    const overlay = page.getByTestId('create-deal-overlay')
    if (await overlay.isVisible().catch(() => false)) {
      await overlay.click({ force: true })
    }
  }

  if (await drawer.isVisible().catch(() => false)) {
    const toggleButton = page.getByRole('button', { name: /\+\s*new deal|new deal/i }).first()
    if (await toggleButton.isVisible().catch(() => false)) {
      await toggleButton.click({ force: true }).catch(() => undefined)
    }
  }

  await expect(drawer).toBeHidden({ timeout: 15_000 })
}
