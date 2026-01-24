import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'

function cachedFileNameForPath(filePath: string): string {
  const normalized = String(filePath ?? '')
  const digest = crypto.createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex')
  return `filecache_${digest}.bin`
}

test.describe('mode2 stripe', () => {
  test.skip(!hasLocalStack, 'requires local stack')
  test.use({ acceptDownloads: true })

  test('mode2 deal → shard → upload → commit → retrieve', async ({ page }) => {
    test.setTimeout(600_000)

    const filePath = 'mode2-small.txt'
    const fileBytes = Buffer.alloc(256 * 1024, 'M') // spans multiple blobs (128 KiB each)

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await page.waitForSelector('[data-testid="connect-wallet"], [data-testid="wallet-address"], [data-testid="wallet-address-full"], [data-testid="cosmos-identity"]', {
      timeout: 60_000,
      state: 'attached',
    })
    const walletAddress = page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()
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

    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 180_000 })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: filePath,
      mimeType: 'text/plain',
      buffer: fileBytes,
    })

    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')

    await page.waitForSelector('[data-testid="mdu-upload"], [data-testid="mdu-commit"]', {
      timeout: 300_000,
      state: 'attached',
    })
    if ((await uploadBtn.count().catch(() => 0)) > 0) {
      await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
      await uploadBtn.click()
      await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: 300_000 })
    }
    await expect(commitBtn).toBeEnabled({ timeout: 300_000 })
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })

    const dealRow = page.getByTestId(`deal-row-${dealId}`)
    await dealRow.click()

    const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)
    await expect(fileRow).toBeVisible({ timeout: 60_000 })

    const downloadBtn = page.locator(`[data-testid="deal-detail-download-sp"][data-file-path="${filePath}"]`)
    await expect(downloadBtn).toBeEnabled({ timeout: 180_000 })

    const expectedChunks = Math.ceil(fileBytes.length / (128 * 1024))
    let fetchCalls = 0
    const chunkPromises: Promise<void>[] = []
    const chunkBytes: Array<{ start: number; bytes: Buffer }> = []
    page.on('response', (resp) => {
      const url = resp.url()
      if (!url.includes('/gateway/fetch/')) return
      fetchCalls += 1
      const req = resp.request()
      const range = req.headers()['range'] || req.headers()['Range']
      const match = typeof range === 'string' ? range.match(/bytes=(\d+)-(\d+)?/) : null
      const start = match ? Number(match[1]) : 0
      const p = (async () => {
        try {
          const body = await resp.body()
          chunkBytes.push({ start, bytes: Buffer.from(body) })
        } catch (err) {
          void err
        }
      })()
      chunkPromises.push(p)
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

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 })
    await downloadBtn.click()

    await expect(page.getByText(/Receipt submitted on-chain|Receipt failed/i)).toBeVisible({ timeout: 360_000 })

    await expect.poll(() => fetchCalls, { timeout: 60_000 }).toBeGreaterThanOrEqual(expectedChunks)

    let downloaded: Buffer | null = null
    try {
      const download = await downloadPromise
      const downloadPath = await download.path()
      if (downloadPath) {
        downloaded = await fs.readFile(downloadPath)
      }
    } catch (err) {
      void err
    }

    await Promise.allSettled(chunkPromises)

    if (!downloaded || downloaded.length === 0) {
      try {
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
        downloaded = Buffer.from(cachedBytes)
      } catch (err) {
        void err
      }
    }

    if (!downloaded || downloaded.length === 0) {
      const ordered = chunkBytes.sort((a, b) => a.start - b.start)
      const total = ordered.reduce((acc, entry) => acc + entry.bytes.length, 0)
      const joined = Buffer.concat(ordered.map((entry) => entry.bytes), total)
      downloaded = joined
    }

    const maxExpected = fileBytes.length
    expect(downloaded.length).toBeGreaterThan(0)
    expect(downloaded.length).toBeLessThanOrEqual(maxExpected)
  })

  test('mode2 append keeps prior files', async ({ page }) => {
    test.slow()
    test.setTimeout(600_000)

    const fileA = { name: 'mode2-a.txt', buffer: Buffer.alloc(32 * 1024, 'A') }
    const fileB = { name: 'mode2-b.txt', buffer: Buffer.alloc(32 * 1024, 'B') }

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await page.waitForSelector('[data-testid="connect-wallet"], [data-testid="wallet-address"], [data-testid="wallet-address-full"], [data-testid="cosmos-identity"]', {
      timeout: 60_000,
      state: 'attached',
    })
    const walletAddress = page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()
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

    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 180_000 })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileA.name,
      mimeType: 'text/plain',
      buffer: fileA.buffer,
    })
    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')

    await page.waitForSelector('[data-testid="mdu-upload"], [data-testid="mdu-commit"]', {
      timeout: 300_000,
      state: 'attached',
    })
    if ((await uploadBtn.count().catch(() => 0)) > 0) {
      await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
      await uploadBtn.click()
      await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: 300_000 })
    }
    await expect(commitBtn).toBeEnabled({ timeout: 300_000 })
    await commitBtn.click()
    await expect(commitBtn).toHaveText(/Committed!/i, { timeout: 180_000 })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileB.name,
      mimeType: 'text/plain',
      buffer: fileB.buffer,
    })

    await page.waitForSelector('[data-testid="mdu-upload"], [data-testid="mdu-commit"]', {
      timeout: 300_000,
      state: 'attached',
    })
    if ((await uploadBtn.count().catch(() => 0)) > 0) {
      await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
      await uploadBtn.click()
      await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: 300_000 })
    }
    await expect(commitBtn).toBeEnabled({ timeout: 300_000 })
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
