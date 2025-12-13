import { test, expect } from '@playwright/test'

const path = process.env.E2E_PATH || '/#/dashboard'
const gatewayBase = process.env.E2E_GATEWAY_BASE || 'http://localhost:8080'

test('deal lifecycle smoke (connect → fund → create → upload → commit → explore → fetch)', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)

  await page.goto(path)

  await page.getByTestId('connect-wallet').click()
  await expect(page.getByTestId('wallet-address')).toBeVisible()
  await expect(page.getByTestId('cosmos-identity')).toContainText('nil1')

  await page.getByTestId('faucet-request').click()
  await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText('—', { timeout: 90_000 })

  await page.getByTestId('alloc-submit').click()

  const dealSelect = page.getByTestId('content-deal-select')
  await expect(dealSelect).not.toHaveValue('', { timeout: 60_000 })
  const dealId = await dealSelect.inputValue()

  const filePath = 'e2e.txt'
  const fileBytes = Buffer.alloc(256 * 1024, 'A')

  await page.getByTestId('content-file-input').setInputFiles({
    name: filePath,
    mimeType: 'text/plain',
    buffer: fileBytes,
  })

  const stagedManifestRoot = page.getByTestId('staged-manifest-root')
  await expect(stagedManifestRoot).toHaveText(/^0x[0-9a-f]{96}$/i, { timeout: 180_000 })
  const manifestRoot = (await stagedManifestRoot.textContent())?.trim() || ''
  expect(manifestRoot).toMatch(/^0x[0-9a-f]{96}$/i)

  const stagedSizeText = (await page.getByTestId('staged-total-size').textContent())?.trim() || ''
  expect(Number(stagedSizeText)).toBeGreaterThan(0)

  const dealManifestCell = page.getByTestId(`deal-manifest-${dealId}`)
  await expect(dealManifestCell).toHaveAttribute('title', manifestRoot, { timeout: 120_000 })

  const dealSizeCell = page.getByTestId(`deal-size-${dealId}`)
  await expect(dealSizeCell).not.toHaveText('—', { timeout: 120_000 })

  const dealSizeMb = Number.parseFloat((await dealSizeCell.textContent()) || '0')
  expect(dealSizeMb).toBeGreaterThan(0)

  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('deal-detail')).toBeVisible()

  const fileRow = page.locator('[data-testid="deal-detail-file-row"][data-file-path="e2e.txt"]')
  await expect(fileRow).toBeVisible({ timeout: 120_000 })

  const owner = (await page.getByTestId('cosmos-identity').textContent())?.trim() || ''
  const fetchUrl = `${gatewayBase}/gateway/fetch/${encodeURIComponent(
    manifestRoot,
  )}?deal_id=${encodeURIComponent(dealId)}&owner=${encodeURIComponent(owner)}&file_path=${encodeURIComponent(filePath)}`

  const res = await request.get(fetchUrl, { timeout: 120_000 })
  expect(res.ok()).toBeTruthy()
  expect(await res.body()).toEqual(fileBytes)
})

