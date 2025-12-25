import { test, expect } from '@playwright/test'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

test.describe('gateway flow', () => {
  test.skip(!hasLocalStack, 'requires local stack')

  test('gateway upload → commit → download (mode1)', async ({ page }) => {
    test.setTimeout(600_000)

    const filePath = 'gateway-flow.bin'
    const fileBytes = Buffer.alloc(256 * 1024, 0x5a) // 2 blobs
    const expectedChunks = Math.ceil(fileBytes.length / (128 * 1024))

    await page.setViewportSize({ width: 1280, height: 720 })
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await page.goto(dashboardPath, { waitUntil: 'networkidle' })
        break
      } catch (err) {
        if (attempt === 4) throw err
        await page.waitForTimeout(1000)
      }
    }

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

    await page.getByTestId('alloc-redundancy-mode').selectOption('mode1')
    await page.getByTestId('alloc-submit').click()
    await expect(page.getByText(/Capacity Allocated/i)).toBeVisible({ timeout: 180_000 })

    await page.getByTestId('tab-content').click()
    await page.waitForFunction(() => {
      const select = document.querySelector('[data-testid="content-deal-select"]') as HTMLSelectElement | null
      return Boolean(select && select.options.length > 1)
    }, null, { timeout: 180_000 })

    const dealSelect = page.getByTestId('content-deal-select')
    const options = dealSelect.locator('option')
    const optionCount = await options.count()
    const lastValue = await options.nth(optionCount - 1).getAttribute('value')
    if (lastValue) {
      await dealSelect.selectOption(lastValue)
    }
    const dealId = await dealSelect.inputValue()
    expect(dealId).not.toBe('')

    const fileInput = page.getByTestId('content-file-input')
    await expect(fileInput).toBeEnabled({ timeout: 120_000 })
    await fileInput.setInputFiles({
      name: filePath,
      mimeType: 'application/octet-stream',
      buffer: fileBytes,
    })

    await expect(page.getByTestId('staged-manifest-root')).toContainText('0x', { timeout: 180_000 })

    const commitBtn = page.getByTestId('content-commit')
    await commitBtn.click()
    await expect(page.getByText(/Commit Tx/i)).toBeVisible({ timeout: 180_000 })

    let planCalls = 0
    let fetchCalls = 0
    page.on('response', (resp) => {
      const url = resp.url()
      if (url.includes('/gateway/plan-retrieval-session/')) planCalls += 1
      if (url.includes('/gateway/fetch/')) fetchCalls += 1
    })

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 })
    const downloadBtn = page.locator(`[data-testid="content-download"][data-file-path="${filePath}"]`)
    await expect(downloadBtn).toBeEnabled({ timeout: 60_000 })
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

    await expect(page.getByText(/Receipt submitted on-chain/)).toBeVisible({ timeout: 180_000 })
    await expect.poll(() => planCalls, { timeout: 60_000 }).toBeGreaterThanOrEqual(expectedChunks)
    await expect.poll(() => fetchCalls, { timeout: 60_000 }).toBeGreaterThanOrEqual(expectedChunks)
  })
})
