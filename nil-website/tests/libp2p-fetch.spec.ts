import { test, expect } from '@playwright/test'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

test.describe('libp2p fetch', () => {
  test.skip(!hasLocalStack, 'requires local stack with libp2p enabled')

  test('download uses libp2p transport', async ({ page }) => {
    test.setTimeout(600_000)

    const filePath = 'libp2p.txt'
    const fileBytes = Buffer.alloc(64 * 1024, 'L')

    page.on('pageerror', (err) => {
      console.error('[pageerror]', err.message)
    })
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.error('[console:error]', msg.text())
      }
    })

    await page.addInitScript(() => {
      window.localStorage.setItem('nil_transport_preference', 'prefer_p2p')
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    const waitForWalletControls = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.waitForSelector('body', { state: 'attached' })
        const hasConnect = await page.getByTestId('connect-wallet').count().catch(() => 0)
        const hasAddress = await page.getByTestId('wallet-address').count().catch(() => 0)
        if (hasConnect > 0 || hasAddress > 0) return
        await page.waitForTimeout(1000)
        await page.reload({ waitUntil: 'networkidle' })
      }
      throw new Error('wallet controls not found')
    }

    await waitForWalletControls()
    const walletAddress = page.getByTestId('wallet-address')
    if (!(await walletAddress.isVisible().catch(() => false))) {
      await page.getByTestId('connect-wallet').first().click()
      await expect(walletAddress).toBeVisible({ timeout: 60_000 })
    }

    const routingSummary = page.locator('summary', { hasText: 'Network & routing' }).first()
    if ((await routingSummary.count()) > 0) {
      await routingSummary.click()
    }
    const transportSelect = page.getByLabel('Preference')
    await expect(transportSelect).toBeVisible({ timeout: 60_000 })
    await expect(transportSelect.locator('option[value="prefer_p2p"]')).toHaveCount(1)
    await transportSelect.selectOption('prefer_p2p')

    await page.getByTestId('faucet-request').click()
    await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 180_000 })

    const redundancySelect = page.getByTestId('alloc-redundancy-mode')
    if (!(await redundancySelect.isVisible().catch(() => false))) {
      await page.getByTestId('workspace-advanced-toggle').click()
      await expect(redundancySelect).toBeVisible({ timeout: 10_000 })
    }
    await redundancySelect.selectOption('mode1')
    await page.getByTestId('alloc-submit').click()
    await expect(page.getByText(/Capacity Allocated/i)).toBeVisible({ timeout: 180_000 })

    await page.getByTestId('tab-content').click()
    const dealSelect = page.getByTestId('workspace-deal-select')
    await expect(dealSelect).toHaveValue(/\d+/, { timeout: 180_000 })
    const dealId = await dealSelect.inputValue()
    expect(dealId).not.toBe('')

    const fileInput = page.getByTestId('content-file-input')
    await expect(fileInput).toBeEnabled({ timeout: 120_000 })
    await fileInput.setInputFiles({
      name: filePath,
      mimeType: 'text/plain',
      buffer: fileBytes,
    })

    await expect(page.getByTestId('staged-manifest-root')).toContainText('0x', { timeout: 180_000 })
    await expect(page.getByText(/Commit Tx/i)).toBeVisible({ timeout: 180_000 })

    const dealRow = page.getByTestId(`deal-row-${dealId}`)
    await expect(dealRow).toBeVisible({ timeout: 180_000 })
    await dealRow.click()

    const downloadBtn = page.locator(`[data-testid="deal-detail-download-sp"][data-file-path="${filePath}"]`)
    await expect(downloadBtn).toBeEnabled({ timeout: 180_000 })

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 })
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

    const routeLabel = page.getByTestId('transport-route')
    await expect(routeLabel).toBeVisible({ timeout: 60_000 })
    await expect(routeLabel).toHaveText(/Route: libp2p/i)
    await expect(page.getByText(/Receipt failed/i)).toHaveCount(0)
  })
})
