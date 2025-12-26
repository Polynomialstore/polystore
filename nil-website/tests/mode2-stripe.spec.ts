import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

function cachedFileNameForPath(filePath: string): string {
  const normalized = String(filePath ?? '')
  const digest = crypto.createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex')
  return `filecache_${digest}.bin`
}

test.describe('mode2 stripe', () => {
  test.skip(!hasLocalStack, 'requires local stack')

  test('mode2 deal → shard → upload → commit → retrieve', async ({ page }) => {
    test.setTimeout(600_000)

    const filePath = 'mode2-small.txt'
    const fileBytes = Buffer.alloc(256 * 1024, 'M') // spans multiple blobs (128 KiB each)

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await page.waitForSelector('[data-testid="connect-wallet"], [data-testid="wallet-address"], [data-testid="cosmos-identity"]', {
      timeout: 60_000,
      state: 'attached',
    })
    const walletAddress = page.getByTestId('wallet-address')
    const cosmosIdentity = page.getByTestId('cosmos-identity')
    if (!(await walletAddress.isVisible().catch(() => false)) && !(await cosmosIdentity.isVisible().catch(() => false))) {
      const connectBtn = page.getByTestId('connect-wallet').first()
      if (await connectBtn.isVisible().catch(() => false)) {
        await connectBtn.click()
      }
      await expect(page.locator('[data-testid="wallet-address"], [data-testid="cosmos-identity"]')).toBeVisible({ timeout: 60_000 })
    }

    await page.getByTestId('faucet-request').click()
    await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 180_000 })

    await page.getByTestId('alloc-submit').click()
    await expect(page.getByText(/Capacity Allocated/i)).toBeVisible({ timeout: 180_000 })

    await page.getByTestId('tab-mdu').click()
    await expect(page.getByTestId('workspace-deal-select')).toHaveValue(/\d+/, { timeout: 180_000 })
    const dealId = await page.getByTestId('workspace-deal-select').inputValue()
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

    const expectedChunks = Math.ceil(fileBytes.length / (128 * 1024))
    let planCalls = 0
    let fetchCalls = 0
    page.on('response', (resp) => {
      const url = resp.url()
      if (url.includes('/gateway/plan-retrieval-session/')) planCalls += 1
      if (url.includes('/gateway/fetch/')) fetchCalls += 1
    })

    const cacheName = cachedFileNameForPath(filePath)
    await page.evaluate(
      async ({ dealId, cacheName }) => {
        try {
          const root = await navigator.storage.getDirectory()
          const dealDir = await root.getDirectoryHandle(`deal-${dealId}`, { create: false })
          await dealDir.removeEntry(cacheName, { recursive: false })
        } catch (err) {
          void err
        }
      },
      { dealId, cacheName },
    )

    await downloadBtn.click()

    await expect(page.getByText(/Receipt submitted on-chain|Receipt failed/i)).toBeVisible({ timeout: 360_000 })
    await expect(page.getByText('Receipt submitted on-chain')).toBeVisible({ timeout: 1_000 })
    await expect(page.getByText(/Receipt failed/i)).toHaveCount(0)
    await expect(page.getByText(/Download failed/i)).toHaveCount(0)

    await expect.poll(() => planCalls, { timeout: 60_000 }).toBeGreaterThanOrEqual(expectedChunks)
    await expect.poll(() => fetchCalls, { timeout: 60_000 }).toBeGreaterThanOrEqual(expectedChunks)

    const cachedBytes = await page.evaluate(
      async ({ dealId, cacheName }) => {
        const root = await navigator.storage.getDirectory()
        const dealDir = await root.getDirectoryHandle(`deal-${dealId}`, { create: false })
        const fh = await dealDir.getFileHandle(cacheName, { create: false })
        const file = await fh.getFile()
        const buf = await file.arrayBuffer()
        return Array.from(new Uint8Array(buf))
      },
      { dealId, cacheName },
    )

    const downloaded = Buffer.from(cachedBytes)
    expect(downloaded.length).toBe(fileBytes.length)
    expect(downloaded.equals(fileBytes)).toBe(true)
  })

  test('mode2 append keeps prior files', async ({ page }) => {
    test.slow()
    test.setTimeout(600_000)

    const fileA = { name: 'mode2-a.txt', buffer: Buffer.alloc(32 * 1024, 'A') }
    const fileB = { name: 'mode2-b.txt', buffer: Buffer.alloc(32 * 1024, 'B') }

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await page.waitForSelector('[data-testid="connect-wallet"], [data-testid="wallet-address"], [data-testid="cosmos-identity"]', {
      timeout: 60_000,
      state: 'attached',
    })
    const walletAddress = page.getByTestId('wallet-address')
    const cosmosIdentity = page.getByTestId('cosmos-identity')
    if (!(await walletAddress.isVisible().catch(() => false)) && !(await cosmosIdentity.isVisible().catch(() => false))) {
      const connectBtn = page.getByTestId('connect-wallet').first()
      if (await connectBtn.isVisible().catch(() => false)) {
        await connectBtn.click()
      }
      await expect(page.locator('[data-testid="wallet-address"], [data-testid="cosmos-identity"]')).toBeVisible({ timeout: 60_000 })
    }

    await page.getByTestId('faucet-request').click()
    await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText(/^(?:—|0 stake)$/, { timeout: 180_000 })

    await page.getByTestId('alloc-submit').click()
    await expect(page.getByText(/Capacity Allocated/i)).toBeVisible({ timeout: 180_000 })

    await page.getByTestId('tab-mdu').click()
    await expect(page.getByTestId('workspace-deal-select')).toHaveValue(/\d+/, { timeout: 180_000 })
    const dealId = await page.getByTestId('workspace-deal-select').inputValue()
    expect(dealId).not.toBe('')

    await expect(page.getByText('WASM: ready')).toBeVisible({ timeout: 60_000 })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileA.name,
      mimeType: 'text/plain',
      buffer: fileA.buffer,
    })
    const uploadBtn = page.getByTestId('mdu-upload')
    await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
    await uploadBtn.click()
    await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: 300_000 })
    const commitBtn = page.getByTestId('mdu-commit')
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileB.name,
      mimeType: 'text/plain',
      buffer: fileB.buffer,
    })
    await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
    await uploadBtn.click()
    await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: 300_000 })
    await expect(commitBtn).toBeEnabled({ timeout: 15_000 })
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })

    const dealRow = page.getByTestId(`deal-row-${dealId}`)
    await dealRow.click()
    await expect(page.locator(`[data-testid="deal-detail-download-sp"][data-file-path="${fileA.name}"]`)).toBeVisible({
      timeout: 60_000,
    })
    await expect(page.locator(`[data-testid="deal-detail-download-sp"][data-file-path="${fileB.name}"]`)).toBeVisible({
      timeout: 60_000,
    })
  })
})
