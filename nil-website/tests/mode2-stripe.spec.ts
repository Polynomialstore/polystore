import { test, expect } from '@playwright/test'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

test.describe('mode2 stripe', () => {
  test.skip(!hasLocalStack, 'requires local stack')

  test('mode2 deal → shard → upload → commit → retrieve', async ({ page }) => {
    test.setTimeout(600_000)

    const filePath = 'mode2-small.txt'
    const fileBytes = Buffer.alloc(64 * 1024, 'M') // <= one blob (128 KiB)

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await page.waitForSelector('[data-testid="connect-wallet"], [data-testid="wallet-address"]', {
      timeout: 60_000,
      state: 'attached',
    })
    const walletAddress = page.getByTestId('wallet-address')
    if (!(await walletAddress.isVisible().catch(() => false))) {
      await page.getByTestId('connect-wallet').first().click()
      await expect(walletAddress).toBeVisible({ timeout: 60_000 })
    }

    await page.getByTestId('faucet-request').click()
    await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 180_000 })

    await page.getByTestId('alloc-redundancy-mode').selectOption('mode2')
    await page.getByTestId('alloc-rs-k').fill('8')
    await page.getByTestId('alloc-rs-m').fill('4')

    await page.getByTestId('alloc-submit').click()
    await expect(page.getByText(/Capacity Allocated/i)).toBeVisible({ timeout: 180_000 })

    await page.getByTestId('tab-mdu').click()
    await page.waitForFunction(() => {
      const select = document.querySelector('[data-testid="mdu-deal-select"]') as HTMLSelectElement | null
      return Boolean(select && select.options.length > 1)
    }, null, { timeout: 180_000 })

    const dealSelect = page.getByTestId('mdu-deal-select')
    const options = dealSelect.locator('option')
    const optionCount = await options.count()
    const lastValue = await options.nth(optionCount - 1).getAttribute('value')
    if (lastValue) {
      await dealSelect.selectOption(lastValue)
    }
    const dealId = await dealSelect.inputValue()
    expect(dealId).not.toBe('')

    await expect(page.getByText('WASM: ready')).toBeVisible({ timeout: 60_000 })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: filePath,
      mimeType: 'text/plain',
      buffer: fileBytes,
    })

    const uploadBtn = page.getByTestId('mdu-upload')
    await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
    await uploadBtn.click()
    await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: 300_000 })

    const commitBtn = page.getByTestId('mdu-commit')
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })

    const dealRow = page.getByTestId(`deal-row-${dealId}`)
    await dealRow.click()

    const downloadBtn = page.locator(`[data-testid="deal-detail-download-sp"][data-file-path="${filePath}"]`)
    await expect(downloadBtn).toBeEnabled({ timeout: 180_000 })

    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 })
    await downloadBtn.click()
    const download = await downloadPromise
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    if (stream) {
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Uint8Array))
      }
    }
    const downloaded = Buffer.concat(chunks)
    expect(downloaded.length).toBe(fileBytes.length)
    expect(downloaded.equals(fileBytes)).toBe(true)
  })
})
