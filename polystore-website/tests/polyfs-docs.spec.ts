import { test, expect } from '@playwright/test'

test('PolyFS docs page renders the technical sections', async ({ page }) => {
  await page.goto('/#/polyfs')

  await expect(page.getByRole('heading', { name: /Polynomial Filesystem technical details/i })).toBeVisible()
  await expect(page.getByTestId('polyfs-mdu0-layout')).toContainText('The Super-Manifest is the filesystem index')
  await expect(page.getByTestId('polyfs-stripereplica')).toContainText('Witness MDUs make striped storage verifiable')
  await expect(page.getByTestId('polyfs-generation-cas')).toContainText('Mutable files commit as generation swaps')
})
