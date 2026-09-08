import { test, expect, type Download, type Locator, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { parsePinnedGeneration } from '../src/lib/retrieval'
import { dismissCreateDealDrawer, ensureCreateDealDrawerOpen } from './utils/dashboard'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'
const isMode2Fast = process.env.E2E_MODE2_FAST === '1'
const mode2FastTestTimeoutMs = isMode2Fast ? 240_000 : 420_000
const mode2FastPrimaryWaitMs = isMode2Fast ? 120_000 : 180_000
const mode2FastUploadWaitMs = isMode2Fast ? 180_000 : 300_000
const mode2FastMaybeDownloadMs = isMode2Fast ? 60_000 : 120_000
const configuredGatewayBase = process.env.E2E_GATEWAY_BASE || process.env.VITE_GATEWAY_BASE || 'http://127.0.0.1:8080'
const gatewayOrigins = deriveGatewayOrigins(configuredGatewayBase)

function deriveGatewayOrigins(base: string): string[] {
  const origins = new Set<string>()
  try {
    const parsed = new URL(base)
    origins.add(parsed.origin)
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]') {
      const port = parsed.port ? `:${parsed.port}` : ''
      origins.add(`${parsed.protocol}//127.0.0.1${port}`)
      origins.add(`${parsed.protocol}//localhost${port}`)
    }
  } catch {
    origins.add('http://127.0.0.1:8080')
    origins.add('http://localhost:8080')
  }
  return Array.from(origins)
}

function isGatewayOrigin(origin: string): boolean {
  return gatewayOrigins.includes(origin)
}

function extractManifestRoot(text: string): string {
  const match = String(text || '').match(/0x(?:[0-9a-fA-F]{96}|[0-9a-fA-F]{64})/)
  return (match?.[0] || '').toLowerCase()
}

async function readDealManifestRoot(page: Page, dealId: string): Promise<string> {
  const cell = page.getByTestId(`deal-manifest-${dealId}`)
  if ((await cell.count().catch(() => 0)) === 0) return ''
  const text = (await cell.first().allTextContents().then((texts) => texts[0] || '').catch(() => '')) || ''
  return extractManifestRoot(text)
}

async function waitForGatewayConnected(page: Page): Promise<void> {
  const widget = page.getByTestId('gateway-status-widget')
  const count = await widget.count().catch(() => 0)
  if (count <= 0) return
  await expect(widget.first()).toHaveAttribute('data-status', 'connected', { timeout: 60_000 })
}

async function ensureWalletFunded(page: Page, timeout: number): Promise<void> {
  const stakeBalance = page.getByTestId('polystore-stake-balance')
  const current = ((await stakeBalance.textContent().catch(() => '')) || '').trim()
  if (current && !/^(?:—|0 stake)$/.test(current)) return

  const faucetButton = page.getByTestId('faucet-request')
  if (await faucetButton.isVisible().catch(() => false)) {
    await faucetButton.click()
  }
  await expect(stakeBalance).not.toHaveText(/^(?:—|0 stake)$/, { timeout })
}

async function waitForUploadControls(uploadBtn: Locator, commitBtn: Locator, timeout = 300_000): Promise<void> {
  await expect
    .poll(async () => {
      const cardCount = await uploadBtn.page().getByTestId('mdu-upload-card').count().catch(() => 0)
      const uploadCount = await uploadBtn.count().catch(() => 0)
      const commitCount = await commitBtn.count().catch(() => 0)
      return cardCount + uploadCount + commitCount
    }, { timeout })
    .toBeGreaterThan(0)
    .catch(() => undefined)
}

async function openFileActionMenuItem(page: Page, filePath: string, testId: string): Promise<Locator> {
  const menuButton = page.locator(`[data-testid="deal-detail-actions-menu"][data-file-path="${filePath}"]`)
  const item = page.locator(`[data-testid="${testId}"][data-file-path="${filePath}"]`)
  if (await item.isVisible().catch(() => false)) return item
  await expect(menuButton).toBeVisible({ timeout: 60_000 })
  await menuButton.scrollIntoViewIfNeeded().catch(() => undefined)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt === 0) {
      await menuButton.click({ force: true })
    } else {
      await menuButton.evaluate((button) => {
        if (button instanceof HTMLElement) button.click()
      })
    }
    if (await item.isVisible().catch(() => false)) return item
    await page.waitForTimeout(250)
  }
  await expect(item).toBeVisible({ timeout: 30_000 })
  return item
}

async function readDownloadedBytes(download: Download): Promise<Buffer> {
  const p = await download.path()
  if (p) return fs.readFile(p)
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  if (stream) {
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk as Uint8Array))
    }
  }
  return Buffer.concat(chunks)
}

async function readDownloadFailureBanner(page: Page): Promise<string> {
  const banner = page.locator('div').filter({ hasText: /^Download failed:/ }).first()
  const visible = await banner.isVisible().catch(() => false)
  if (!visible) return ''
  return ((await banner.textContent().catch(() => '')) || '').trim()
}

async function captureDownloadDiagnostics(page: Page): Promise<string> {
  const route = ((await page.getByTestId('transport-route').textContent().catch(() => '')) || '').trim()
  const source = ((await page.getByTestId('transport-cache-source').textContent().catch(() => '')) || '').trim()
  const freshness = ((await page.getByTestId('transport-cache-freshness').textContent().catch(() => '')) || '').trim()
  const failure = await readDownloadFailureBanner(page)
  const receipt = (await page.locator('div').filter({ hasText: /^Receipt failed:/ }).first().allTextContents()).join('').trim()
  const parts = [
    route ? `route=${route}` : '',
    source ? `cacheSource=${source}` : '',
    freshness ? `freshness=${freshness}` : '',
    failure ? `failure=${failure}` : '',
    receipt ? `receipt=${receipt}` : '',
  ].filter(Boolean)
  return parts.join(' | ') || 'no diagnostics available'
}

async function waitForDownloadEventOrFailure(
  page: Page,
  timeout: number,
  baselineFailure: string,
  onPoll?: () => Promise<void>,
): Promise<Download | null> {
  const outcomePromise = page
    .waitForEvent('download', { timeout })
    .then((download) => ({ kind: 'download' as const, download }))
    .catch(() => ({ kind: 'timeout' as const }))

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await onPoll?.()
    const outcome = await Promise.race([
      outcomePromise,
      page.waitForTimeout(500).then(() => null),
    ])
    if (outcome?.kind === 'download') return outcome.download
    if (outcome?.kind === 'timeout') return null
    const failure = await readDownloadFailureBanner(page)
    if (failure && failure !== baselineFailure) {
      throw new Error(`download failed before browser event: ${failure}`)
    }
  }
  return null
}

async function readDownloadBytes(page: Page, button: Locator, timeout = 120_000): Promise<Buffer> {
  await expect(button).toBeVisible({ timeout: 30_000 })
  await expect(button).toBeEnabled({ timeout: 60_000 })
  const baselineFailure = await readDownloadFailureBanner(page)
  const [download] = await Promise.all([waitForDownloadEventOrFailure(page, timeout, baselineFailure), button.click()])
  if (download) return readDownloadedBytes(download)
  throw new Error(`download event not emitted (${await captureDownloadDiagnostics(page)})`)
}

async function isUploaderResetToInitialState(page: Page): Promise<boolean> {
  const panelState = await page.getByTestId('mdu-upload-card').evaluateAll((nodes) => nodes.length === 1 ? nodes[0].getAttribute('data-panel-state') : null).catch(() => null)
  if (panelState !== 'idle') return false
  const step2State = await page.getByTestId('workflow-step-2').evaluateAll((nodes) => nodes.length === 1 ? nodes[0].getAttribute('data-step-state') : null).catch(() => null)
  const step3State = await page.getByTestId('workflow-step-3').evaluateAll((nodes) => nodes.length === 1 ? nodes[0].getAttribute('data-step-state') : null).catch(() => null)
  const step4State = await page.getByTestId('workflow-step-4').evaluateAll((nodes) => nodes.length === 1 ? nodes[0].getAttribute('data-step-state') : null).catch(() => null)
  const fileInputCount = await page.getByTestId('mdu-file-input').count().catch(() => 0)
  return step2State === 'idle' && step3State === 'idle' && step4State === 'idle' && fileInputCount > 0
}

async function hasDealFileRow(page: Page, expectedFilePath: string): Promise<boolean> {
  return page
    .locator('[data-testid="deal-detail-file-row"]')
    .evaluateAll(
      (rows, filePath) =>
        rows.some((row) => row.getAttribute('data-file-path') === filePath || (row.textContent || '').includes(filePath)),
      expectedFilePath,
    )
    .catch(() => false)
}

async function isCommitCompleteOrReset(
  page: Page,
  commitBtn: Locator,
  expectedFilePath: string,
  dealId: string,
  initialManifestRoot: string,
  allowReset: boolean,
  allowFileRowCompletion = true,
): Promise<boolean> {
  if (dealId) {
    const currentManifest = await readDealManifestRoot(page, dealId)
    if (currentManifest && currentManifest !== initialManifestRoot) return true
  }
  if (allowFileRowCompletion && expectedFilePath) {
    if (await hasDealFileRow(page, expectedFilePath)) return true
  }
  const panelState = await page.getByTestId('mdu-upload-card').evaluateAll((nodes) => nodes.length === 1 ? nodes[0].getAttribute('data-panel-state') : null).catch(() => null)
  if (allowFileRowCompletion && panelState === 'success') return true
  const text = ((await commitBtn.allTextContents().then((texts) => texts.length === 1 ? texts[0] : '').catch(() => '')) || '').trim()
  if (/Committed!/i.test(text)) return true
  if (allowFileRowCompletion && allowReset && (await isUploaderResetToInitialState(page))) return true
  return false
}

async function completeUploadAndCommit(
  uploadBtn: Locator,
  commitBtn: Locator,
  expectedFilePath: string,
  dealId: string,
  timeout = 300_000,
  options: { allowFileRowCompletion?: boolean } = {},
): Promise<void> {
  const page = uploadBtn.page()
  const allowFileRowCompletion = options.allowFileRowCompletion ?? true
  await waitForUploadControls(uploadBtn, commitBtn, timeout).catch(() => undefined)
  const initialManifestRoot = dealId ? await readDealManifestRoot(page, dealId) : ''

  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (
      await isCommitCompleteOrReset(
        page,
        commitBtn,
        expectedFilePath,
        dealId,
        initialManifestRoot,
        true,
        allowFileRowCompletion,
      )
    ) return

    const commitCount = await commitBtn.count().catch(() => 0)
    const commitEnabled = commitCount > 0 && (await commitBtn.evaluateAll((buttons) => buttons.length === 1 && buttons[0].matches(':enabled')).catch(() => false))
    if (commitEnabled) {
      await commitBtn.click()
      await expect
        .poll(
          () =>
            isCommitCompleteOrReset(
              page,
              commitBtn,
              expectedFilePath,
              dealId,
              initialManifestRoot,
              true,
              allowFileRowCompletion,
            ),
          { timeout: 180_000 },
        )
        .toBe(true)
      return
    }

    const uploadCount = await uploadBtn.count().catch(() => 0)
    const uploadVisible = uploadCount > 0 && (await uploadBtn.isVisible().catch(() => false))
    const uploadEnabled = uploadVisible && (await uploadBtn.evaluateAll((buttons) => buttons.length === 1 && buttons[0].matches(':enabled')).catch(() => false))
    if (uploadEnabled) {
      await uploadBtn.click({ force: true })
      await expect
        .poll(async () => {
          if (
            await isCommitCompleteOrReset(
              page,
              commitBtn,
              expectedFilePath,
              dealId,
              initialManifestRoot,
              true,
              allowFileRowCompletion,
            )
          ) return true
          const enabled = await commitBtn.evaluateAll((buttons) => buttons.length === 1 && buttons[0].matches(':enabled')).catch(() => false)
          if (enabled) return true
          const text = ((await uploadBtn.allTextContents().then((texts) => texts.length === 1 ? texts[0] : '').catch(() => '')) || '').trim()
          return /Upload Complete/i.test(text)
        }, { timeout: 120_000 })
        .toBe(true)
      if (
        await isCommitCompleteOrReset(
          page,
          commitBtn,
          expectedFilePath,
          dealId,
          initialManifestRoot,
          true,
          allowFileRowCompletion,
        )
      ) return
    }
    await page.waitForTimeout(500)
  }

  await expect
    .poll(
      () =>
        isCommitCompleteOrReset(
          page,
          commitBtn,
          expectedFilePath,
          dealId,
          initialManifestRoot,
          true,
          allowFileRowCompletion,
        ),
      { timeout: 180_000 },
    )
    .toBe(true)
  await page.waitForTimeout(150)
}

async function syncDealIndexIfNeeded(page: Page, timeout = 180_000): Promise<void> {
  const syncPanel = page.getByTestId('deal-index-sync-panel')
  if (!(await syncPanel.isVisible().catch(() => false))) return

  const syncButton = page.getByTestId('deal-index-sync-button')
  await expect(syncButton).toBeVisible({ timeout: 30_000 })
  await syncButton.click({ force: true })
  await expect(syncPanel).toBeHidden({ timeout })
}

async function waitForDealFileRow(
  page: Page,
  dealId: string,
  filePath: string,
  timeout = 180_000,
): Promise<Locator> {
  const workspaceTitle = page.getByTestId('workspace-deal-title')
  const dealRow = page.getByTestId(`deal-row-${dealId}`)
  const dealRowByText = page.getByRole('button', { name: new RegExp(`Deal\\s*#${dealId}\\b`, 'i') }).first()
  const refreshDealsBtn = page.getByRole('button', { name: /Refresh deals/i }).first()
  const filesTab = page.getByRole('button', { name: /^Files$/i }).first()
  const fileList = page.getByTestId('deal-detail-file-list')
  const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)

  const pollForRow = async (allowSync: boolean, pollTimeout: number) => {
    await expect
      .poll(async () => {
        const byTestIdCount = await dealRow.count().catch(() => 0)
        const targetRow = byTestIdCount > 0 ? dealRow.first() : dealRowByText
        if ((await targetRow.count().catch(() => 0)) <= 0) return false
        await targetRow.scrollIntoViewIfNeeded().catch(() => undefined)
        await targetRow.click({ force: true }).catch(() => undefined)
        const selectedTitle = ((await workspaceTitle.textContent().catch(() => '')) || '').trim()
        if (!selectedTitle.includes(`#${dealId}`)) return false
        if (await filesTab.isVisible().catch(() => false)) {
          await filesTab.click({ force: true }).catch(() => undefined)
        }
        if (allowSync && !(await fileRow.isVisible().catch(() => false))) {
          await syncDealIndexIfNeeded(page, Math.max(60_000, Math.floor(timeout / 2))).catch(() => undefined)
        }
        const listVisible = await fileList.isVisible().catch(() => false)
        if (!listVisible) return false
        return await fileRow.isVisible().catch(() => false)
      }, { timeout: pollTimeout })
      .toBe(true)
  }

  try {
    await pollForRow(false, Math.max(30_000, Math.floor(timeout / 2)))
  } catch {
    await page.reload({ waitUntil: 'networkidle' })
    try {
      await pollForRow(true, Math.max(60_000, Math.floor(timeout / 2)))
    } catch {
      if (await refreshDealsBtn.isVisible().catch(() => false)) {
        await refreshDealsBtn.click({ force: true }).catch(() => undefined)
      }
      await expect
        .poll(async () => {
          const byTestIdCount = await dealRow.count().catch(() => 0)
          const targetRow = byTestIdCount > 0 ? dealRow.first() : dealRowByText
          if ((await targetRow.count().catch(() => 0)) <= 0) return false
          await targetRow.scrollIntoViewIfNeeded().catch(() => undefined)
          await targetRow.click({ force: true }).catch(() => undefined)
          if (await filesTab.isVisible().catch(() => false)) {
            await filesTab.click({ force: true }).catch(() => undefined)
          }
          if (!(await fileRow.isVisible().catch(() => false))) {
            await syncDealIndexIfNeeded(page, Math.max(30_000, Math.floor(timeout / 3))).catch(() => undefined)
          }
          return await fileRow.isVisible().catch(() => false)
        }, { timeout: Math.max(60_000, Math.floor(timeout / 2)) })
        .toBe(true)
    }
  }

  return fileRow
}

async function installDealDetailContinuityProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = document.querySelector('[data-testid="deal-detail"]')
    if (!root) throw new Error('deal-detail root not found for continuity probe')

    const probe = {
      root,
      rootReplaced: false,
      loadingFileTableSeen: false,
      observer: undefined as MutationObserver | undefined,
    }

    const scanLoadingState = () => {
      if ((document.body.textContent || '').includes('Loading file table')) {
        probe.loadingFileTableSeen = true
      }
    }

    scanLoadingState()
    probe.observer = new MutationObserver((records) => {
      if (!document.contains(root)) {
        probe.rootReplaced = true
      }
      for (const record of records) {
        for (const node of Array.from(record.removedNodes)) {
          if (node === root || (node instanceof Element && node.contains(root))) {
            probe.rootReplaced = true
          }
        }
      }
      scanLoadingState()
    })
    probe.observer.observe(document.body, { childList: true, subtree: true, characterData: true })

    ;(window as unknown as { __dealDetailContinuityProbe?: typeof probe }).__dealDetailContinuityProbe = probe
  })
}

async function readDealDetailContinuityProbe(page: Page): Promise<{
  rootReplaced: boolean
  loadingFileTableSeen: boolean
  fileRowCount: number
}> {
  return page.evaluate(() => {
    const probe = (window as unknown as {
      __dealDetailContinuityProbe?: {
        root: Element
        rootReplaced: boolean
        loadingFileTableSeen: boolean
        observer?: MutationObserver
      }
    }).__dealDetailContinuityProbe
    if (!probe) throw new Error('deal-detail continuity probe was not installed')

    const currentRoot = document.querySelector('[data-testid="deal-detail"]')
    const rootReplaced = probe.rootReplaced || !document.contains(probe.root) || currentRoot !== probe.root
    const loadingFileTableSeen =
      probe.loadingFileTableSeen || (document.body.textContent || '').includes('Loading file table')
    probe.observer?.disconnect()

    return {
      rootReplaced,
      loadingFileTableSeen,
      fileRowCount: document.querySelectorAll('[data-testid="deal-detail-file-row"]').length,
    }
  })
}

function resolveRouterUploadDir(): string {
  const fromEnv = String(process.env.E2E_ROUTER_UPLOAD_DIR || '').trim()
  if (fromEnv) return path.resolve(fromEnv)
  // Default used by scripts/run_devnet_alpha_multi_sp.sh
  return path.resolve(process.cwd(), '..', '_artifacts', 'devnet_alpha_multi_sp', 'router_tmp')
}

async function ensureWalletConnected(page: Page): Promise<void> {
  const walletAddressSelector = '[data-testid="wallet-address"], [data-testid="wallet-address-full"]'
  const walletAddress = page.locator(walletAddressSelector).first()
  const polystoreIdentity = page.getByTestId('polystore-identity')
  const connectBtn = page.getByTestId('connect-wallet').first()

  await page.waitForSelector(`${walletAddressSelector}, [data-testid="polystore-identity"], [data-testid="connect-wallet"]`, {
    timeout: 60_000,
    state: 'attached',
  })

  const isConnected = async (): Promise<boolean> => {
    const walletVisible = await walletAddress.first().isVisible().catch(() => false)
    if (walletVisible) return true

    if (await polystoreIdentity.isVisible().catch(() => false)) {
      const raw = (await polystoreIdentity.textContent().catch(() => ''))?.trim()
      if (raw && raw !== '—' && !/^(?:—|—)$/.test(raw) && !/^not\s+connected$/i.test(raw)) {
        return true
      }
    }

    return false
  }

  const waitForConnected = async (timeout = 20_000): Promise<boolean> => {
    try {
      await expect.poll(isConnected, { timeout }).toBe(true)
      return true
    } catch (err) {
      void err
      return false
    }
  }

  if (await isConnected()) return

  if (await connectBtn.isVisible().catch(() => false)) {
    await connectBtn.click({ force: true })
  }

  const browserWalletBtn = page.getByRole('button', { name: /Browser Wallet/i })
  const fallbackWalletBtns = [
    page.getByRole('button', { name: /^MetaMask$/i }),
    page.getByRole('button', { name: /^WalletConnect$/i }),
  ]

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await isConnected()) return

    if (await browserWalletBtn.isVisible().catch(() => false)) {
      await browserWalletBtn.click({ force: true })
      if (await waitForConnected()) return
    }

    for (const candidate of fallbackWalletBtns) {
      if (await candidate.isVisible().catch(() => false)) {
        await candidate.click({ force: true })
        if (await waitForConnected()) return
      }
    }

    await page.waitForTimeout(500)

    if (await connectBtn.isVisible().catch(() => false)) {
      await connectBtn.click({ force: true })
    }
  }

  expect(await isConnected()).toBe(true)
}

async function hashCheckedDownload(download: Pick<Download, 'createReadStream' | 'cancel'>, checkDisk: () => Promise<void>) {
  let failure: unknown, checking: Promise<void> | undefined
  let stream: Readable | null = null
  const check = () => {
    if (!checking && !failure) checking = checkDisk().catch(async (error) => {
      failure = error
      stream?.destroy()
      await download.cancel().catch(() => {})
    }).finally(() => { checking = undefined })
    return checking
  }
  // The event announces the start of a download. Keep the guard alive while
  // createReadStream waits and while Chromium/Node finish consuming its bytes.
  const timer = setInterval(() => { void check() }, 5000)
  try {
    await check()
    if (failure) throw failure
    stream = await download.createReadStream()
    if (failure) throw failure
    if (!stream) throw new Error('download stream unavailable')
    const hash = crypto.createHash('sha256')
    let bytes = 0
    for await (const chunk of stream) { bytes += chunk.length; hash.update(chunk) }
    await check()
    if (failure) throw failure
    return { bytes, digest: hash.digest('hex') }
  } catch (error) { throw failure ?? error }
  finally { clearInterval(timer); stream?.destroy(); await checking }
}

test('streamed download disk guard cancels after the download event', async () => {
  for (const waitingForStream of [true, false]) {
    let checks = 0, cancelled = false
    let endDownload!: () => void
    const pending = new Promise<void>((resolve) => { endDownload = resolve })
    const stream = new Readable({ read() {} })
    stream.push(Buffer.from('first'))
    const download = {
      createReadStream: async () => {
        if (waitingForStream) { await pending; throw new Error('download cancelled') }
        return stream
      },
      // Once Playwright returns a stream, its download is already complete.
      cancel: async () => { cancelled = true; if (waitingForStream) endDownload() },
    }
    await expect(hashCheckedDownload(download, async () => {
      if (++checks === 2) throw new Error('scratch space below 2 GiB')
    })).rejects.toThrow('scratch space below 2 GiB')
    expect(cancelled).toBe(true)
    expect(checks).toBe(2)
    if (!waitingForStream) expect(stream.destroyed).toBe(true)
    stream.destroy()
  }
})

test.describe('mode2 streamed retrieval', () => {
  test.skip(!hasLocalStack || process.env.E2E_MODE2_STREAMED !== '1', 'opt-in real streamed retrieval')
  test.use({ acceptDownloads: true })
  test.describe.configure({ retries: 0 })

  test('mode2 streamed authenticated retrieval', async ({ page }, testInfo) => {
    const size = Number(process.env.E2E_MODE2_STREAMED_BYTES || 16_252_928)
    expect([16_252_928, 1_073_741_824]).toContain(size)
    const large = size === 1_073_741_824
    const route = process.env.E2E_MODE2_STREAMED_ROUTE || 'gateway'
    expect(['gateway', 'provider']).toContain(route)
    const downloadTimeout = large ? 3 * 60 * 60_000 : 15 * 60_000
    test.setTimeout(large ? 4 * 60 * 60_000 : 30 * 60_000)
    const expectedMdus = large ? 133 : 2, expectedSessions = large ? 1064 : 16, expectedBlobs = large ? 8457 : 128
    const fileName = 'mode2-streamed.bin', fixture = testInfo.outputPath(fileName)
    await fs.mkdir(testInfo.outputDir, { recursive: true })
    const diskPaths = [process.cwd(), testInfo.outputDir, tmpdir(), process.env.POLYSTORE_HOME || path.resolve('../_artifacts')]
    const checkDisk = async (minimumGiB: number) => {
      for (const directory of diskPaths) {
        const disk = await fs.statfs(directory)
        expect(disk.bavail * disk.bsize, `free disk at ${directory}`).toBeGreaterThanOrEqual(minimumGiB * 2 ** 30)
      }
    }
    await checkDisk(large ? 12 : 2)
    const cipher = crypto.createCipheriv('aes-256-ctr', Buffer.alloc(32, 0x57), Buffer.alloc(16))
    const hash = crypto.createHash('sha256'), zeros = Buffer.alloc(1024 * 1024)
    async function* source() {
      for (let offset = 0; offset < size; offset += zeros.length) {
        const chunk = cipher.update(zeros.subarray(0, Math.min(zeros.length, size - offset)))
        hash.update(chunk); yield chunk
      }
      const last = cipher.final(); hash.update(last); yield last
    }
    const summary: Record<string, unknown> = { size, route, expectedMdus, expectedSessions, expectedBlobs }
    try {
      await pipeline(Readable.from(source()), createWriteStream(fixture, { flags: 'wx' }))
      const expectedHash = hash.digest('hex')
      summary.expectedHash = expectedHash
      if (large) expect(expectedHash).toBe('5806efdf1f91fa2b8ab62f7b5e16541c0f866227cfe977238bd2ec9789664d9e')
      // Gateway FormData upload streams the disk-backed File. Fail closed if
      // gateway failure would select the whole-file browser sharding fallback.
      await page.addInitScript((name) => {
        const original = File.prototype.arrayBuffer
        File.prototype.arrayBuffer = function () {
          if (this.name === name) return Promise.reject(new Error('streamed fixture requires gateway ingest'))
          return original.call(this)
        }
      }, fileName)
      await page.setViewportSize({ width: 1280, height: 720 })
      await page.goto(dashboardPath, { waitUntil: 'networkidle' })
      await ensureWalletConnected(page)
      await waitForGatewayConnected(page)
      await checkDisk(large ? 12 : 2) // Before faucet, deal creation, or paid retrieval.
      await ensureWalletFunded(page, 180_000)
      await ensureCreateDealDrawerOpen(page)
      await page.getByTestId('alloc-submit').click()
      const title = page.getByTestId('workspace-deal-title')
      await expect(title).toHaveText(/Deal #\d+/, { timeout: 180_000 })
      await dismissCreateDealDrawer(page)
      const dealId = (await title.textContent())?.match(/#(\d+)/)?.[1]
      expect(dealId).toBeTruthy()
      summary.dealId = dealId
      await page.getByTestId(`deal-row-${dealId}`).click()
      await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 180_000 })
      const uploadStarted = Date.now()
      await page.getByTestId('mdu-file-input').setInputFiles(fixture)
      await completeUploadAndCommit(page.getByTestId('mdu-upload'), page.getByTestId('mdu-commit'), fileName, dealId!, 30 * 60_000)
      summary.uploadMs = Date.now() - uploadStarted
      await waitForDealFileRow(page, dealId!, fileName)
      const lcd = process.env.VITE_LCD_BASE || `http://localhost:${process.env.LCD_PORT || 1317}`
      const dealResponse = await page.request.get(`${lcd}/polystorechain/polystorechain/v1/deals/${dealId}`, { timeout: 15_000 })
      expect(dealResponse.ok()).toBe(true)
      const pin = parsePinnedGeneration(await dealResponse.json(), process.env.CHAIN_ID || '31337', BigInt(dealResponse.headers()['x-cosmos-block-height']), BigInt(dealId!))
      expect([pin.k, pin.m, Number(pin.userMdus), pin.assignments.length]).toEqual([8, 4, expectedMdus, 12])
      const listing = await page.request.get(`${configuredGatewayBase}/gateway/list-files/${pin.root}?deal_id=${dealId}&owner=${pin.owner}`, { timeout: 15_000 })
      expect(listing.ok()).toBe(true)
      const { files } = await listing.json()
      expect(files).toEqual([expect.objectContaining({ path: fileName, size_bytes: size, flags: 0, start_offset: 0 })])

      const windows: Array<{ id: string; gateway: boolean }> = []
      const proofRequests: Array<{ id: string; startMs: number; endMs?: number }> = []
      const pendingProofs = new Map<import('@playwright/test').Request, typeof proofRequests[number]>()
      page.on('request', (request) => {
        const url = new URL(request.url()), id = request.headers()['x-polystore-session-id']
        if (id && /\/(?:gateway|sp\/retrieval)\/mdu\//.test(url.pathname)) windows.push({ id, gateway: isGatewayOrigin(url.origin) })
        if (url.pathname === '/gateway/session-proof' && request.method() === 'POST') {
          const entry = { id: request.postDataJSON().session_id as string, startMs: Date.now() }
          proofRequests.push(entry); pendingProofs.set(request, entry)
        }
      })
      page.on('requestfinished', (request) => { const entry = pendingProofs.get(request); if (entry) { entry.endMs = Date.now(); pendingProofs.delete(request) } })
      summary.proofRequests = proofRequests
      summary.windows = windows
      await checkDisk(2)
      const button = await openFileActionMenuItem(page, fileName, route === 'gateway' ? 'deal-detail-download-gateway-provider' : 'deal-detail-download-sp')
      const retrievalStarted = Date.now()
      let checkedAt = 0
      const [download] = await Promise.all([
        waitForDownloadEventOrFailure(page, downloadTimeout, await readDownloadFailureBanner(page), async () => {
          if (Date.now() - checkedAt >= 5000) { await checkDisk(2); checkedAt = Date.now() }
        }), button.click(),
      ])
      if (!download) throw new Error(`streamed download event missing: ${await captureDownloadDiagnostics(page)}`)
      try {
        const { bytes, digest } = await hashCheckedDownload(download, () => checkDisk(2))
        summary.retrievalMs = Date.now() - retrievalStarted
        summary.actualBytes = bytes; summary.actualHash = digest
        expect(bytes).toBe(size); expect(digest).toBe(expectedHash)
      } finally { await download.delete() }
      expect(windows).toHaveLength(expectedSessions)
      const ids = [...new Set(windows.map((window) => window.id))]
      expect(ids).toHaveLength(expectedSessions)
      expect(windows.every((window) => window.gateway === (route === 'gateway'))).toBe(true)
      await expect(page.getByRole('status').filter({ hasText: /unsettled provider payment/ })).toHaveCount(0)
      let blobs = 0
      const mdus = new Set<string>()
      const settled = []
      for (let offset = 0; offset < ids.length; offset += 4) {
        const batch = await Promise.all(ids.slice(offset, offset + 4).map(async (id) => {
          expect(id).toMatch(/^0x[0-9a-f]{64}$/)
          const encoded = Buffer.from(id.slice(2), 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
          const response = await page.request.get(`${lcd}/polystorechain/polystorechain/v1/retrieval-sessions/${encoded}`, { timeout: 15_000 })
          expect(response.ok()).toBe(true)
          expect(response.headers()['x-cosmos-block-height']).toMatch(/^[1-9][0-9]*$/)
          const { session } = await response.json()
          expect(Buffer.from(session.session_id, 'base64').toString('hex')).toBe(id.slice(2))
          expect(session.status).toBe('RETRIEVAL_SESSION_STATUS_COMPLETED')
          expect(String(session.deal_id ?? 0)).toBe(dealId)
          expect(Buffer.from(session.manifest_root, 'base64').toString('hex')).toBe(pin.root.slice(2))
          return { id, mdu: String(session.start_mdu_index), blobs: Number(session.blob_count), payee: session.authorized_proof_provider, updatedHeight: session.updated_height }
        }))
        for (const entry of batch) { blobs += entry.blobs; mdus.add(entry.mdu); settled.push(entry) }
      }
      expect(blobs).toBe(expectedBlobs); expect(mdus.size).toBe(expectedMdus)
      Object.assign(summary, { success: true, blobs, sessions: settled })
      console.log(`[streamed retrieval] ${size} bytes, ${expectedSessions} completed sessions, ${blobs} blobs, ${summary.retrievalMs}ms`)
    } finally {
      try {
        await fs.writeFile(testInfo.outputPath('retrieval-summary.json'), JSON.stringify(summary, null, 2))
      } finally { await fs.rm(fixture, { force: true }) }
    }
  })
})

  test.describe('mode2 stripe', () => {
  test.skip(!hasLocalStack, 'requires local stack')
  test.use({ acceptDownloads: true })
  test.describe.configure({ retries: process.env.CI && !isMode2Fast ? 1 : 0 })

  test('mode2 deal → shard → upload → commit → retrieve', async ({ page }) => {
    test.setTimeout(mode2FastTestTimeoutMs)

    // The deployed default is disabled. The UI must wait for committed
    // activation before offering a paid download; only this isolated chain is active.
    const paramsRoute = '**/polystorechain/polystorechain/v1/params'
    await page.route(paramsRoute, (route) => route.fulfill({
      status: 200, contentType: 'application/json', headers: {
        'x-cosmos-block-height': '1', 'access-control-expose-headers': 'x-cosmos-block-height',
      },
      body: JSON.stringify({ params: { retrieval_v2_activation_height: '0' } }),
    }))

    const filePath = 'mode2-small.bin'
    const fileBytes = crypto.randomBytes(160 * 1024) // spans multiple blobs without compressing to a tiny payload

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)

    await ensureWalletFunded(page, mode2FastPrimaryWaitMs)

    await ensureCreateDealDrawerOpen(page)
    await page.getByTestId('alloc-submit').click()
    const workspaceTitle = page.getByTestId('workspace-deal-title')
    await expect(workspaceTitle).toHaveText(/Deal #\d+/, { timeout: mode2FastPrimaryWaitMs })
    await dismissCreateDealDrawer(page)
    const dealTitle = (await workspaceTitle.textContent().catch(() => '')) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    const newDealRow = page.getByTestId(`deal-row-${dealId}`)
    await expect(newDealRow).toBeVisible({ timeout: 60_000 })
    await newDealRow.click()
    await expect(workspaceTitle).toHaveText(new RegExp(`#${dealId}`), { timeout: 60_000 })

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: mode2FastPrimaryWaitMs })
    await waitForGatewayConnected(page)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: filePath,
      mimeType: 'application/octet-stream',
      buffer: fileBytes,
    })

    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')

    await completeUploadAndCommit(uploadBtn, commitBtn, filePath, dealId, mode2FastUploadWaitMs)

    const fileRow = await waitForDealFileRow(page, dealId, filePath, mode2FastPrimaryWaitMs)

    const autoDownloadBtn = page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`)
    const routeEl = page.getByTestId('transport-route')

    await expect(page.getByTestId('retrieval-availability')).toContainText('until this network activates')
    await expect(autoDownloadBtn).toBeDisabled()
    await page.unroute(paramsRoute)
    await expect(autoDownloadBtn).toBeEnabled({ timeout: mode2FastPrimaryWaitMs })

    // All download actions now share the authenticated, paid window path.
    // Count session-bound windows, excluding the unpaid metadata reads.
    const windows: Array<{ gateway: boolean; session: string }> = []
    page.on('request', (request) => {
      const session = request.headers()['x-polystore-session-id']
      if (session && /\/(?:gateway|sp\/retrieval)\/mdu\//.test(new URL(request.url()).pathname)) {
        windows.push({ gateway: isGatewayOrigin(new URL(request.url()).origin), session })
      }
    })
    const assertSettled = async () => {
      await expect(page.getByRole('status').filter({ hasText: /unsettled provider payment/ })).toHaveCount(0)
      const ids = [...new Set(windows.map((window) => window.session))]
      expect(ids.length).toBeGreaterThan(0)
      await expect.poll(async () => Promise.all(ids.map(async (id) => {
        expect(id).toMatch(/^0x[0-9a-f]{64}$/)
        const encoded = Buffer.from(id.slice(2), 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
        const lcd = process.env.VITE_LCD_BASE || `http://localhost:${process.env.LCD_PORT || 1317}`
        const response = await page.request.get(`${lcd}/polystorechain/polystorechain/v1/retrieval-sessions/${encodeURIComponent(encoded)}`)
        expect(response.ok()).toBe(true)
        expect(response.headers()['x-cosmos-block-height']).toMatch(/^[1-9][0-9]*$/)
        const { session } = await response.json()
        expect(Buffer.from(session.session_id, 'base64').toString('hex')).toBe(id.slice(2))
        return session.status
      })), { timeout: 30_000 }).toEqual(ids.map(() => 'RETRIEVAL_SESSION_STATUS_COMPLETED'))
    }
    const gatewayButton = await openFileActionMenuItem(page, filePath, 'deal-detail-download-gateway-provider')
    const gatewayBytes = await readDownloadBytes(page, gatewayButton, mode2FastMaybeDownloadMs)
    console.log('[secured retrieval] gateway bytes downloaded')
    expect(gatewayBytes.equals(fileBytes)).toBe(true)
    expect(windows.length).toBeGreaterThan(0)
    expect(windows.every((window) => window.gateway)).toBe(true)
    await assertSettled()
    await expect(routeEl).toContainText(/gateway/i)
    await expect(fileRow).toBeVisible()
    if (isMode2Fast) return

    const gatewaySessions = new Set(windows.map((window) => window.session))
    windows.length = 0
    const providerButton = await openFileActionMenuItem(page, filePath, 'deal-detail-download-sp')
    const providerBytes = await readDownloadBytes(page, providerButton)
    console.log('[secured retrieval] provider bytes downloaded')
    expect(providerBytes.equals(fileBytes)).toBe(true)
    expect(windows.length).toBeGreaterThan(0)
    expect(windows.every((window) => !window.gateway && !gatewaySessions.has(window.session))).toBe(true)
    await assertSettled()
    await expect(routeEl).toContainText(/Browser\s*->\s*Provider|direct sp/i)

    // Losing the user-gateway must still permit verified direct delivery.
    for (const origin of gatewayOrigins) await page.route(`${origin}/**`, (route) => route.abort('failed'))
    await page.evaluate(() => window.localStorage.setItem('polystore_local_gateway_connected', '0'))
    windows.length = 0
    const fallbackBytes = await readDownloadBytes(page, autoDownloadBtn)
    console.log('[secured retrieval] gateway-absent bytes downloaded')
    expect(fallbackBytes.equals(fileBytes)).toBe(true)
    await expect(page.getByText('Retrieval Options', { exact: true })).toBeHidden()
    expect(windows.some((window) => !window.gateway)).toBe(true)
    await expect(routeEl).toContainText(/Browser\s*->\s*Provider|direct sp/i)
  })

  test('mode2 upload without gateway supports verified provider download', async ({ page }) => {
    test.setTimeout(mode2FastTestTimeoutMs)

    const filePath = 'mode2-no-gateway-upload.txt'
    const fileBytes = Buffer.alloc(192 * 1024, 'N')
    const mduUploads: Array<{ bodyLen: number; fullSize: number | null; mduIndex: string }> = []
    const manifestUploads: Array<{ bodyLen: number; fullSize: number | null }> = []
    const shardUploads: Array<{ bodyLen: number; fullSize: number | null; mduIndex: string; slot: string }> = []
    const bundleUploads: Array<{ artifactCount: number }> = []

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)

    await ensureWalletFunded(page, mode2FastPrimaryWaitMs)

    await ensureCreateDealDrawerOpen(page)
    await page.getByTestId('alloc-submit').click()
    const workspaceTitle = page.getByTestId('workspace-deal-title')
    await expect(workspaceTitle).toHaveText(/Deal #\d+/, { timeout: mode2FastPrimaryWaitMs })
    await dismissCreateDealDrawer(page)
    const dealTitle = (await workspaceTitle.textContent().catch(() => '')) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    const newDealRow = page.getByTestId(`deal-row-${dealId}`)
    await expect(newDealRow).toBeVisible({ timeout: 60_000 })
    await newDealRow.click()
    await expect(workspaceTitle).toHaveText(new RegExp(`#${dealId}`), { timeout: 60_000 })

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: mode2FastPrimaryWaitMs })

    let blockGatewayUpload = true
    const unsignedMissingRangeRequests: string[] = []
    const maybeBlockGatewayUpload = async (route: import('@playwright/test').Route) => {
      if (blockGatewayUpload && route.request().method().toUpperCase() !== 'OPTIONS') {
        await route.abort('failed')
        return
      }
      await route.continue()
    }
    page.on('request', (req) => {
      const url = req.url()
      if (!url.includes('/gateway/fetch/') && !url.includes('/sp/retrieval/fetch/')) return
      const headers = req.headers()
      const hasAuth = Boolean(headers.authorization || headers['x-polystore-auth'] || headers['x-polystore-signature'] || headers['x-polystore-voucher'])
      const range = String(headers.range || '').trim()
      if (!hasAuth && !/^bytes=\d+-\d*$/.test(range)) {
        unsignedMissingRangeRequests.push(`${req.method()} ${url} range=${range || '<none>'}`)
      }
    })
    await page.route('**/gateway/upload*', maybeBlockGatewayUpload)
    await page.route('**/gateway/upload-status*', maybeBlockGatewayUpload)
    await page.route('**/sp/upload_bundle', async (route) => {
      const body = route.request().postDataBuffer() || Buffer.alloc(0)
      if (body.byteLength < 8 || body.subarray(0, 4).toString('utf8') !== 'NLB2') {
        await route.fulfill({ status: 400, body: 'invalid bundle' })
        return
      }
      const metaLen = body.readUInt32LE(4)
      const metaRaw = body.subarray(8, 8 + metaLen).toString('utf8')
      const meta = JSON.parse(metaRaw) as {
        artifacts?: Array<{
          kind?: string
          mdu_index?: number
          slot?: number
          full_size?: number
          send_size?: number
        }>
      }
      const artifacts = Array.isArray(meta.artifacts) ? meta.artifacts : []
      bundleUploads.push({ artifactCount: artifacts.length })
      for (const artifact of artifacts) {
        const bodyLen = Number(artifact.send_size || 0)
        const fullSize = Number.isFinite(Number(artifact.full_size)) ? Number(artifact.full_size) : null
        if (artifact.kind === 'mdu') {
          mduUploads.push({
            bodyLen,
            fullSize,
            mduIndex: String(artifact.mdu_index ?? ''),
          })
        } else if (artifact.kind === 'manifest') {
          manifestUploads.push({
            bodyLen,
            fullSize,
          })
        } else if (artifact.kind === 'shard') {
          shardUploads.push({
            bodyLen,
            fullSize,
            mduIndex: String(artifact.mdu_index ?? ''),
            slot: String(artifact.slot ?? ''),
          })
        }
      }
      await route.continue()
    })
    await page.route('**/sp/upload_mdu', async (route) => {
      const body = route.request().postDataBuffer() || Buffer.alloc(0)
      const headers = route.request().headers()
      const fullSizeHeader = headers['x-polystore-full-size']
      mduUploads.push({
        bodyLen: body.length,
        fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
        mduIndex: headers['x-polystore-mdu-index'] || '',
      })
      await route.continue()
    })
    await page.route('**/sp/upload_manifest', async (route) => {
      const body = route.request().postDataBuffer() || Buffer.alloc(0)
      const headers = route.request().headers()
      const fullSizeHeader = headers['x-polystore-full-size']
      manifestUploads.push({
        bodyLen: body.length,
        fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
      })
      await route.continue()
    })
    await page.route('**/sp/upload_shard', async (route) => {
      const body = route.request().postDataBuffer() || Buffer.alloc(0)
      const headers = route.request().headers()
      const fullSizeHeader = headers['x-polystore-full-size']
      shardUploads.push({
        bodyLen: body.length,
        fullSize: fullSizeHeader ? Number(fullSizeHeader) : null,
        mduIndex: headers['x-polystore-mdu-index'] || '',
        slot: headers['x-polystore-slot'] || '',
      })
      await route.continue()
    })

    const compressCheckbox = page.getByTestId('mdu-compress-toggle')
    if (await compressCheckbox.isChecked().catch(() => false)) {
      await page.getByText('Compress before upload', { exact: true }).click()
      await expect(compressCheckbox).not.toBeChecked()
    }

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: filePath,
      mimeType: 'text/plain',
      buffer: fileBytes,
    })

    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')
    await waitForUploadControls(uploadBtn, commitBtn, mode2FastUploadWaitMs)
    if ((await uploadBtn.count().catch(() => 0)) > 0) {
      await expect(uploadBtn).toBeEnabled({ timeout: mode2FastUploadWaitMs })
      await uploadBtn.click()
      await expect(uploadBtn).toHaveText(/Upload Complete/i, { timeout: mode2FastUploadWaitMs })
    }
    await expect
      .poll(() => mduUploads.length > 0 && manifestUploads.length > 0 && shardUploads.length > 0, {
        timeout: mode2FastUploadWaitMs,
      })
      .toBe(true)
    expect(mduUploads.length).toBeGreaterThan(0)
    expect(manifestUploads.length).toBeGreaterThan(0)
    expect(shardUploads.length).toBeGreaterThan(0)

    const sparseMduUploads = mduUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)
    const sparseManifestUploads = manifestUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)
    const sparseShardUploads = shardUploads.filter((upload) => upload.fullSize != null && upload.bodyLen < upload.fullSize)

    console.log('[mode2 sparse upload evidence]', {
      bundleUploads,
      mduUploads,
      manifestUploads,
      shardUploads: shardUploads.slice(0, 6),
    })

    expect(sparseMduUploads.length).toBeGreaterThan(0)
    expect(sparseManifestUploads.length).toBeGreaterThan(0)
    expect(sparseShardUploads.length).toBeGreaterThan(0)
    // The MDU0 sparse body carries the populated root-table prefix plus a small
    // transport envelope, so allow bounded overhead while still rejecting full
    // 8 MiB MDU uploads.
    expect(Math.max(...sparseMduUploads.map((upload) => upload.bodyLen))).toBeLessThan((2 * 1024 * 1024) + 4096)
    await expect
      .poll(() => isCommitCompleteOrReset(page, commitBtn, filePath, dealId, '', true), { timeout: mode2FastPrimaryWaitMs })
      .toBe(true)
    blockGatewayUpload = false

    await newDealRow.first().scrollIntoViewIfNeeded().catch(() => undefined)
    await newDealRow.click({ force: true }).catch(() => undefined)
    await expect(workspaceTitle).toHaveText(new RegExp(`#${dealId}`), { timeout: 60_000 })

    const fileRow = await waitForDealFileRow(page, dealId, filePath, mode2FastUploadWaitMs)
    const providerButton = await openFileActionMenuItem(page, filePath, 'deal-detail-download-sp')
    const downloaded = await readDownloadBytes(page, providerButton, mode2FastMaybeDownloadMs)
    expect(downloaded.equals(fileBytes)).toBe(true)
    expect(unsignedMissingRangeRequests, 'unsigned legacy file fetches').toEqual([])
    await expect(fileRow).toBeVisible()

  })

  test('mode2 append keeps prior files', async ({ page }) => {
    test.slow()
    test.setTimeout(600_000)

    const fileA = { name: 'mode2-a.txt', buffer: crypto.randomBytes(32 * 1024) }
    const fileB = { name: 'mode2-b.txt', buffer: crypto.randomBytes(32 * 1024) }

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)

    await ensureWalletFunded(page, 180_000)

    await ensureCreateDealDrawerOpen(page)
    await page.getByTestId('alloc-submit').click()
    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    await dismissCreateDealDrawer(page)
    const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 180_000 })
    await waitForGatewayConnected(page)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileA.name,
      mimeType: 'text/plain',
      buffer: fileA.buffer,
    })
    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')

    await completeUploadAndCommit(uploadBtn, commitBtn, fileA.name, dealId, 300_000)
    await waitForDealFileRow(page, dealId, fileA.name, 180_000)
    await installDealDetailContinuityProbe(page)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileB.name,
      mimeType: 'text/plain',
      buffer: fileB.buffer,
    })

    await completeUploadAndCommit(uploadBtn, commitBtn, fileB.name, dealId, 300_000, {
      allowFileRowCompletion: false,
    })

    const continuity = await readDealDetailContinuityProbe(page)
    expect(continuity.rootReplaced).toBe(false)
    expect(continuity.loadingFileTableSeen).toBe(false)
    expect(continuity.fileRowCount).toBeGreaterThanOrEqual(1)

    const fileARow = await waitForDealFileRow(page, dealId, fileA.name, 240_000)
    const fileBRow = await waitForDealFileRow(page, dealId, fileB.name, 240_000)
    await expect(fileARow).toContainText('start 0')
    await expect(fileBRow).not.toContainText('start 0')

    const fileAGatewayBtn = await openFileActionMenuItem(page, fileA.name, 'deal-detail-download-gateway-provider')
    const fileABytes = await readDownloadBytes(page, fileAGatewayBtn, 120_000)
    expect(fileABytes.equals(fileA.buffer)).toBe(true)

    const fileBGatewayBtn = await openFileActionMenuItem(page, fileB.name, 'deal-detail-download-gateway-provider')
    const fileBBytes = await readDownloadBytes(page, fileBGatewayBtn, 120_000)
    expect(fileBBytes.equals(fileB.buffer)).toBe(true)
  })

  test('mode2 append recovers by rehydrating local gateway from OPFS cache', async ({ page }) => {
    test.slow()
    test.setTimeout(900_000)

    const fileA = { name: 'rehydrate-a.txt', buffer: Buffer.alloc(128 * 1024, 'R') }
    const fileB = { name: 'rehydrate-b.txt', buffer: Buffer.alloc(96 * 1024, 'S') }

    console.log('[rehydrate-e2e] start')
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })
    console.log('[rehydrate-e2e] dashboard loaded')

    await ensureWalletConnected(page)

    await ensureWalletFunded(page, 180_000)
    console.log('[rehydrate-e2e] faucet funded')

    await ensureCreateDealDrawerOpen(page)
    await page.getByTestId('alloc-submit').click()
    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 180_000 })
    await dismissCreateDealDrawer(page)
    const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')
    console.log(`[rehydrate-e2e] deal created id=${dealId}`)

    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 180_000 })
    await waitForGatewayConnected(page)

    // Force first gateway ingest to fail so browser fallback computes and persists OPFS slab.
    // Keep subsequent attempts deterministic for local/CI by stubbing provider transport.
    let gatewayUploadPostCount = 0
    let fileBGatewayAttemptCount = 0
    let rehydratePhase: 'fileA' | 'fileB' = 'fileA'
    let mirrorMduCalls = 0
    let mirrorManifestCalls = 0
    let mirrorShardCalls = 0
    const retryManifestRoot = `0x${crypto.randomBytes(48).toString('hex')}`

    await page.route('**/sp/upload_mdu', async (route) => {
      await route.fulfill({ status: 200, body: 'ok' })
    })
    await page.route('**/sp/upload_manifest', async (route) => {
      await route.fulfill({ status: 200, body: 'ok' })
    })
    await page.route('**/sp/upload_shard', async (route) => {
      await route.fulfill({ status: 200, body: 'ok' })
    })

    for (const gatewayBase of gatewayOrigins) {
      await page.route(`${gatewayBase}/status`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ mode: 'router' }),
        })
      })
      await page.route(`${gatewayBase}/gateway/mirror_mdu`, async (route) => {
        mirrorMduCalls += 1
        await route.fulfill({ status: 200, body: 'ok' })
      })
      await page.route(`${gatewayBase}/gateway/mirror_manifest`, async (route) => {
        mirrorManifestCalls += 1
        await route.fulfill({ status: 200, body: 'ok' })
      })
      await page.route(`${gatewayBase}/gateway/mirror_shard`, async (route) => {
        mirrorShardCalls += 1
        await route.fulfill({ status: 200, body: 'ok' })
      })
    }

    await page.route('**/gateway/upload*', async (route) => {
      if (route.request().method().toUpperCase() === 'POST') {
        gatewayUploadPostCount += 1
        if (rehydratePhase === 'fileA') {
          await route.continue()
          return
        }

        fileBGatewayAttemptCount += 1
        // Simulate append recovery on fileB: first gateway ingest attempt fails due missing slab.
        if (fileBGatewayAttemptCount === 1) {
          await route.fulfill({
            status: 500,
            contentType: 'text/plain',
            body: 'mode2 append failed: failed to resolve existing slab dir',
          })
          return
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            manifest_root: retryManifestRoot,
            total_mdus: 3,
            witness_mdus: 1,
            size_bytes: fileA.buffer.length + fileB.buffer.length,
          }),
        })
        return
      }
      await route.continue()
    })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileA.name,
      mimeType: 'text/plain',
      buffer: fileA.buffer,
    })
    console.log('[rehydrate-e2e] fileA selected')

    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')

    await completeUploadAndCommit(uploadBtn, commitBtn, fileA.name, dealId, 300_000)
    console.log('[rehydrate-e2e] fileA upload+commit complete')
    rehydratePhase = 'fileB'

    const routerDealDir = path.join(resolveRouterUploadDir(), 'deals', String(dealId))
    let routerManifestDirName = ''
    const routerManifestDeadline = Date.now() + 120_000
    while (!routerManifestDirName && Date.now() < routerManifestDeadline) {
      const entries = await fs.readdir(routerDealDir, { withFileTypes: true }).catch(() => [])
      const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      routerManifestDirName = dirs[0] || ''
      if (!routerManifestDirName) {
        await page.waitForTimeout(500)
      }
    }
    const fileNameLikeMdu = (name: string) =>
      name === 'manifest.bin' || /^mdu_\d+\.bin$/.test(name) || /^mdu_\d+_slot_\d+\.bin$/.test(name)

    let seedBaseDir = ''
    let seedNames: string[] = []
    let manifestRoot: string | null = null
    let committedManifestRoot = ''
    const manifestCell = page.getByTestId(`deal-manifest-${dealId}`)
    if (await manifestCell.count().catch(() => 0)) {
      const rawManifest = (await manifestCell.first().textContent().catch(() => '')) || ''
      committedManifestRoot = extractManifestRoot(rawManifest)
    }
    if (routerManifestDirName) {
      seedBaseDir = path.join(routerDealDir, String(routerManifestDirName))
      const nested = await fs.readdir(seedBaseDir).catch(() => [])
      seedNames = nested.filter(fileNameLikeMdu)
      manifestRoot = `0x${String(routerManifestDirName).replace(/^0x/i, '')}`
    }
    if (seedNames.length === 0) {
      seedBaseDir = routerDealDir
      const flat = await fs.readdir(routerDealDir).catch(() => [])
      seedNames = flat.filter(fileNameLikeMdu)
      manifestRoot = null
    }
    if (!manifestRoot && committedManifestRoot) {
      manifestRoot = committedManifestRoot
    }

    if (seedNames.length > 0) {
      const seedFiles = await Promise.all(
        seedNames.map(async (name) => {
          const bytes = await fs.readFile(path.join(seedBaseDir, name))
          return { name, bytes: Array.from(bytes) }
        }),
      )
      await page.evaluate(
        async ({ dealId, manifestRoot, seedFiles }) => {
          const root = await navigator.storage.getDirectory()
          const dealDir = await root.getDirectoryHandle(`deal-${dealId}`, { create: true })
          const writeFile = async (name: string, data: Uint8Array) => {
            const fh = await dealDir.getFileHandle(name, { create: true })
            const writable = await fh.createWritable()
            await writable.write(data)
            await writable.close()
          }
          if (manifestRoot) {
            await writeFile('manifest_root.txt', new TextEncoder().encode(manifestRoot))
          }
          for (const file of seedFiles as Array<{ name: string; bytes: number[] }>) {
            await writeFile(file.name, new Uint8Array(file.bytes))
          }
        },
        {
          dealId,
          manifestRoot,
          seedFiles,
        },
      )
      console.log(`[rehydrate-e2e] seeded OPFS from router files count=${seedNames.length}`)
    } else {
      console.log(`[rehydrate-e2e] no router slab files found for deal ${dealId}; skipping explicit OPFS seed`)
    }
    await fs.rm(routerDealDir, { recursive: true, force: true })

    // Ensure the local gateway truly lost its prior slab state.
    const dirExists = await fs.stat(routerDealDir).then(() => true).catch(() => false)
    expect(dirExists).toBe(false)
    console.log(`[rehydrate-e2e] removed router slab dir=${routerDealDir}`)

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: fileB.name,
      mimeType: 'text/plain',
      buffer: fileB.buffer,
    })
    console.log('[rehydrate-e2e] fileB selected')

    await waitForUploadControls(uploadBtn, commitBtn, 300_000)
    if ((await uploadBtn.count().catch(() => 0)) > 0 && (await uploadBtn.isVisible().catch(() => false))) {
      const preUploadText = ((await uploadBtn.allTextContents().then((texts) => texts.length === 1 ? texts[0] : '').catch(() => '')) || '').trim()
      if (!/Upload Complete/i.test(preUploadText)) {
        await expect(uploadBtn).toBeEnabled({ timeout: 300_000 })
        await uploadBtn.click()
      }
      await expect
        .poll(async () => {
          const text = (await uploadBtn.allTextContents().then((texts) => texts.length === 1 ? texts[0] : '').catch(() => '')) || ''
          const committed = await commitBtn.evaluateAll((buttons) => buttons.length === 1 && buttons[0].matches(':enabled')).catch(() => false)
          return /Upload Complete/i.test(text) || committed
        }, { timeout: 300_000 })
        .toBe(true)
      console.log('[rehydrate-e2e] fileB upload complete (explicit upload button path)')
    }

    await expect.poll(() => fileBGatewayAttemptCount, { timeout: 300_000 }).toBeGreaterThanOrEqual(1)

    await expect
      .poll(() => isCommitCompleteOrReset(page, commitBtn, fileB.name, dealId, '', true), { timeout: 180_000 })
      .toBe(true)
    console.log('[rehydrate-e2e] fileB committed')
    console.log(
      `[rehydrate-e2e] completed successfully (gatewayUploads=${gatewayUploadPostCount}, mirrorCalls=${
        mirrorMduCalls + mirrorManifestCalls + mirrorShardCalls
      })`,
    )
  })
})

test('upload completion polling observes removed controls', async ({ page }) => {
  test.setTimeout(5_000)
  await page.setContent(`
    <div data-testid="mdu-upload-card" data-panel-state="uploading"></div>
    <button data-testid="mdu-commit" disabled>Confirming...</button>
  `)
  const commitBtn = page.getByTestId('mdu-commit')
  await commitBtn.evaluate((button) => button.remove())
  // Missing controls alone are not completion and must not block the next poll.
  expect(await isCommitCompleteOrReset(page, commitBtn, 'uploaded.bin', '', '', true)).toBe(false)

  // Duplicate locators remain invalid, matching the previous strict reads.
  await page.setContent(`
    <div data-testid="mdu-upload-card" data-panel-state="uploading"></div>
    <button data-testid="mdu-commit" disabled>Committed!</button>
    <button data-testid="mdu-commit" disabled>Committed!</button>
  `)
  expect(await isCommitCompleteOrReset(page, commitBtn, 'uploaded.bin', '', '', true)).toBe(false)
  await page.setContent(`
    <div data-testid="mdu-upload-card" data-panel-state="success"></div>
    <div data-testid="mdu-upload-card" data-panel-state="success"></div>
  `)
  expect(await isCommitCompleteOrReset(page, commitBtn, 'uploaded.bin', '', '', true)).toBe(false)

  await page.setContent(`
    <div data-testid="mdu-upload-card" data-panel-state="idle"></div>
    <div data-testid="workflow-step-2" data-step-state="idle"></div>
    <div data-testid="workflow-step-3" data-step-state="idle"></div>
    <div data-testid="workflow-step-4" data-step-state="idle"></div>
    <input data-testid="mdu-file-input" type="file">
  `)

  await expect.poll(() => isCommitCompleteOrReset(page, commitBtn, 'uploaded.bin', '', '', true), { timeout: 1_000 }).toBe(true)
  expect(await isCommitCompleteOrReset(page, commitBtn, 'uploaded.bin', '', '', false)).toBe(false)
  expect(await isCommitCompleteOrReset(page, commitBtn, 'uploaded.bin', '', '', true, false)).toBe(false)
  await page.setContent('')
  expect(await isCommitCompleteOrReset(page, commitBtn, 'uploaded.bin', '', '', true)).toBe(false)
})

test('upload completion polling survives automatic commit after upload removal', async ({ page }) => {
  test.setTimeout(5_000)
  await page.setContent(`
    <div data-testid="mdu-upload-card" data-panel-state="uploading"></div>
    <button data-testid="mdu-upload" onclick="this.remove(); setTimeout(() => {
      const row = document.createElement('div');
      row.dataset.testid = 'deal-detail-file-row';
      row.dataset.filePath = 'uploaded.bin';
      document.body.append(row);
    }, 250)">Upload</button>
  `)
  await completeUploadAndCommit(page.getByTestId('mdu-upload'), page.getByTestId('mdu-commit'), 'uploaded.bin', '', 2_000)
  await expect(page.getByTestId('deal-detail-file-row')).toHaveAttribute('data-file-path', 'uploaded.bin')
})
