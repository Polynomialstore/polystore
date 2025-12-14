import { test, expect } from '@playwright/test'

const path = process.env.E2E_PATH || '/#/dashboard'
const gatewayBase = process.env.E2E_GATEWAY_BASE || 'http://localhost:8080'

test('deal lifecycle smoke (connect → fund → create → upload → commit → explore → fetch)', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000)

  await page.goto(path)

  await page.getByTestId('connect-wallet').click()
  await expect(page.getByTestId('wallet-address')).toBeVisible()
  await expect(page.getByTestId('cosmos-identity')).toContainText('nil1')
  const owner = (await page.getByTestId('cosmos-identity').textContent())?.trim() || ''
  expect(owner).toMatch(/^nil1/i)

  await page.getByTestId('faucet-request').click()
  await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText('—', { timeout: 90_000 })

  await page.getByTestId('alloc-submit').click()
  await page.getByTestId('tab-content').click()

  const dealSelect = page.getByTestId('content-deal-select')
  await expect(dealSelect).not.toHaveValue('', { timeout: 60_000 })
  const dealId = await dealSelect.inputValue()

  const filePath = 'e2e.txt'
  const fileBytes = Buffer.alloc(1024 * 1024, 'A')

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

  // Directly hit the gateway to measure /gateway/fetch performance.
  // Hard timeout: 20s; target proof generation < 1s.
  const fetchUrl = `${gatewayBase}/gateway/fetch/${encodeURIComponent(manifestRoot)}?deal_id=${encodeURIComponent(
    dealId,
  )}&owner=${encodeURIComponent(owner)}&file_path=${encodeURIComponent(filePath)}`
  const perfStart = Date.now()
  const perfResp = await request.get(fetchUrl, { timeout: 20_000 })
  const perfElapsedMs = Date.now() - perfStart
  expect(perfResp.status()).toBe(200)
  expect(perfElapsedMs).toBeLessThan(20_000)
  const proofMsRaw = perfResp.headers()['x-nil-gateway-proof-ms']
  expect(proofMsRaw).toBeTruthy()
  const proofMs = Number(proofMsRaw)
  expect(Number.isFinite(proofMs)).toBeTruthy()
  expect(proofMs).toBeLessThan(1_000)
  const perfBody = await perfResp.body()
  expect(Buffer.from(perfBody)).toEqual(fileBytes)

  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('deal-detail')).toBeVisible()

  const fileRow = page.locator('[data-testid="deal-detail-file-row"][data-file-path="e2e.txt"]')
  await expect(fileRow).toBeVisible({ timeout: 120_000 })

  // Trigger download via UI to exercise client-side signing
  const downloadPromise = page.waitForEvent('download', { timeout: 240_000 })
  await page.locator('[data-testid="deal-detail-download"][data-file-path="e2e.txt"]').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(filePath)

  const stream = await download.createReadStream()
  const downloadedBytes = await streamToBuffer(stream)
  expect(downloadedBytes).toEqual(fileBytes)

  // Verify Retrieval Count increment (Proof submission success)
  await page.getByTestId('deal-detail-close').click()
  // Retrievals column is the 5th column (index 4)
  const retrievalsCell = page.getByTestId(`deal-row-${dealId}`).locator('td').nth(4)
  await expect(retrievalsCell).toHaveText('1', { timeout: 60_000 })
})

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
