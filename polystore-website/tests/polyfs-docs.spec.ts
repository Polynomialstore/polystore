import { test, expect } from '@playwright/test'

test('PolyFS docs page renders the technical sections', async ({ page }) => {
  await page.goto('/#/polyfs')

  await expect(page.getByRole('heading', { name: /KZG Commitments in PolyStore/i })).toBeVisible()
  await expect(page.getByTestId('polyfs-data-types')).toContainText('Raw payload per scalar')
  await expect(page.getByTestId('polyfs-verification')).toContainText('VerifyKZG(C, z, y, pi)')
  await expect(page.getByTestId('polyfs-composition')).toContainText('Deal.manifest_root')
  await expect(page.getByTestId('polyfs-triple-proof')).toContainText('challenged field evaluation')
})

test('legacy PolyFS draft route redirects to the canonical page', async ({ page }) => {
  await page.goto('/#/polyfs2')

  await expect(page).toHaveURL(/#\/polyfs$/)
  await expect(page.getByRole('heading', { name: /KZG Commitments in PolyStore/i })).toBeVisible()
})

test('Learn nav exposes the canonical PolyFS page by click', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/#/')

  await page.getByRole('button', { name: /Learn/i }).click()
  await page.getByRole('link', { name: /KZG to PolyFS/i }).click()

  await expect(page).toHaveURL(/#\/polyfs$/)
  await expect(page.getByTestId('polyfs-docs-page')).toContainText('KZG Commitments in PolyStore')
})
