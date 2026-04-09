import { test, expect } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { dismissCreateDealDrawer, ensureCreateDealDrawerOpen } from './utils/dashboard'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'
const uploadSizeBytes = Number(process.env.GATEWAY_ABSENT_FILE_SIZE_BYTES || 18)
const capturePreparePerf = process.env.CAPTURE_PREPARE_PERF === '1'
const stopAfterPreparePerf = process.env.STOP_AFTER_PREPARE_PERF === '1'

function extractManifestRoot(text: string): string {
  const match = String(text || '').match(/0x[0-9a-fA-F]{96}/)
  return (match?.[0] || '').toLowerCase()
}

async function readDealManifestRoot(page: Parameters<typeof test>[0]['page'], dealId: string): Promise<string> {
  const cell = page.getByTestId(`deal-manifest-${dealId}`)
  if ((await cell.count().catch(() => 0)) === 0) return ''
  const text = (await cell.first().textContent().catch(() => '')) || ''
  return extractManifestRoot(text)
}

async function isUploaderResetToInitialState(page: Parameters<typeof test>[0]['page']): Promise<boolean> {
  const panelState = await page.getByTestId('mdu-upload-card').getAttribute('data-panel-state').catch(() => null)
  if (panelState !== 'idle') return false
  const step2State = await page.getByTestId('workflow-step-2').getAttribute('data-step-state').catch(() => null)
  const step3State = await page.getByTestId('workflow-step-3').getAttribute('data-step-state').catch(() => null)
  const step4State = await page.getByTestId('workflow-step-4').getAttribute('data-step-state').catch(() => null)
  const fileInputCount = await page.getByTestId('mdu-file-input').count().catch(() => 0)
  return step2State === 'idle' && step3State === 'idle' && step4State === 'idle' && fileInputCount > 0
}

async function isCommitCompleteOrReset(
  page: Parameters<typeof test>[0]['page'],
  commitBtn: ReturnType<Parameters<typeof test>[0]['page']['getByTestId']>,
  expectedFilePath: string,
  dealId: string,
  initialManifestRoot: string,
  allowReset: boolean,
): Promise<boolean> {
  if (dealId) {
    const currentManifest = await readDealManifestRoot(page, dealId)
    if (currentManifest && currentManifest !== initialManifestRoot) return true
  }
  if (expectedFilePath) {
    const fileRow = page.getByTestId('deal-detail-file-row').filter({ hasText: expectedFilePath })
    if ((await fileRow.count().catch(() => 0)) > 0) return true
  }
  const panelState = await page.getByTestId('mdu-upload-card').getAttribute('data-panel-state').catch(() => null)
  if (panelState === 'success') return true
  const commitText = ((await commitBtn.textContent().catch(() => '')) || '').trim()
  if (/Committed!/i.test(commitText)) return true
  if (allowReset && (await isUploaderResetToInitialState(page))) return true
  return false
}

async function completeUploadAndCommit(
  page: Parameters<typeof test>[0]['page'],
  expectedFilePath: string,
  dealId: string,
  timeout = 300_000,
): Promise<void> {
  const uploadBtn = page.getByTestId('mdu-upload')
  const commitBtn = page.getByTestId('mdu-commit')
  const initialManifestRoot = dealId ? await readDealManifestRoot(page, dealId) : ''
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    if (await isCommitCompleteOrReset(page, commitBtn, expectedFilePath, dealId, initialManifestRoot, true)) return

    const commitReady = (await commitBtn.count().catch(() => 0)) > 0 && (await commitBtn.isEnabled().catch(() => false))
    if (commitReady) {
      await commitBtn.click()
      await expect
        .poll(() => isCommitCompleteOrReset(page, commitBtn, expectedFilePath, dealId, initialManifestRoot, true), { timeout: 180_000 })
        .toBe(true)
      return
    }

    const uploadReady = (await uploadBtn.count().catch(() => 0)) > 0 && (await uploadBtn.isVisible().catch(() => false)) && (await uploadBtn.isEnabled().catch(() => false))
    if (uploadReady) {
      await uploadBtn.click({ force: true })
      await expect
        .poll(async () => {
          if (await commitBtn.isEnabled().catch(() => false)) return true
          const text = ((await uploadBtn.textContent().catch(() => '')) || '').trim()
          return /Upload Complete/i.test(text)
        }, { timeout: 120_000 })
        .toBe(true)
    }

    await page.waitForTimeout(500)
  }

  await expect
    .poll(() => isCommitCompleteOrReset(page, commitBtn, expectedFilePath, dealId, initialManifestRoot, true), { timeout: 180_000 })
    .toBe(true)
}

test.describe('gateway absent', () => {
  test.skip(!hasLocalStack, 'requires local stack (gateway disabled)')

  test('gateway absent: dashboard upload falls back to direct SP', async ({ page }, testInfo) => {
    test.setTimeout(uploadSizeBytes > 50 * 1024 * 1024 ? 900_000 : 300_000)
    const fileName = 'gateway-absent.txt'
    const fileBytes = uploadSizeBytes > 1024 ? crypto.randomBytes(uploadSizeBytes) : Buffer.from('gateway-absent-upload')
    const perf = { profile: null as unknown }

    page.on('pageerror', (err) => {
      console.log(`[pageerror] ${err.message}`)
    })
    page.on('console', (msg) => {
      if (capturePreparePerf && msg.text().includes('[perf] prepare profile')) {
        void (async () => {
          const values: unknown[] = []
          for (const arg of msg.args()) {
            try {
              values.push(await arg.jsonValue())
            } catch {
              values.push(String(arg))
            }
          }
          perf.profile = values[1] ?? null
        })()
      }
      if (msg.type() === 'error') {
        console.log(`[console:${msg.type()}] ${msg.text()}`)
      }
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await page.waitForSelector('#root', { timeout: 60_000 })
    await page.waitForSelector(
      '[data-testid="connect-wallet"], [data-testid="wallet-address"], [data-testid="wallet-address-full"], [data-testid="polystore-identity"]',
      {
        timeout: 60_000,
        state: 'attached',
      },
    )
    const walletAddress = page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()
    const polystoreIdentity = page.getByTestId('polystore-identity')
    const connected =
      (await walletAddress.isVisible().catch(() => false)) ||
      (await polystoreIdentity.isVisible().catch(() => false))
    if (!connected) {
      const connectButton = page.getByTestId('connect-wallet').first()
      await connectButton.click({ force: true })
      await page.evaluate(async () => {
        const eth = (window as { ethereum?: { request?: (args: { method: string }) => Promise<unknown> } }).ethereum
        if (!eth?.request) {
          throw new Error('No injected wallet available for E2E')
        }
        await eth.request({ method: 'eth_requestAccounts' })
      })
      await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"], [data-testid="polystore-identity"]')).toBeVisible({
        timeout: 60_000,
      })
    }

    const fundWalletButton = page.getByRole('button', { name: /^Fund Wallet$/i }).first()
    if (await fundWalletButton.isVisible().catch(() => false)) {
      await fundWalletButton.click()
    } else {
      const faucetButton = page.getByTestId('faucet-request')
      if (await faucetButton.isVisible().catch(() => false)) {
        await faucetButton.click()
      }
    }

    await ensureCreateDealDrawerOpen(page)
    const allocSubmit = page.getByTestId('alloc-submit')
    await expect(allocSubmit).toBeVisible({ timeout: 120_000 })
    await allocSubmit.click()

    await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #\d+/, { timeout: 120_000 })
    await dismissCreateDealDrawer(page)
    const dealTitle = (await page.getByTestId('workspace-deal-title').textContent()) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    // Mode 2 upload uses the FileSharder (WASM sharding + direct SP fallback).
    // The input is hidden; interact with it directly via test id.
    const mode2FileInput = page.getByTestId('mdu-file-input')
    if ((await mode2FileInput.count().catch(() => 0)) === 0) {
      // If we're on the Legacy (Mode 1) panel, switch back to Upload.
      // `tab-content` is gated behind Advanced, so enable it if needed.
      const tabToggle = page.getByTestId('tab-content')
      if ((await tabToggle.count().catch(() => 0)) === 0) {
        const advancedToggle = page.getByTestId('workspace-advanced-toggle')
        if ((await advancedToggle.count().catch(() => 0)) > 0) {
          await advancedToggle.click({ force: true })
          await expect(tabToggle).toBeAttached({ timeout: 10_000 })
        }
      }
      if ((await tabToggle.count().catch(() => 0)) > 0) {
        await tabToggle.click({ force: true })
      }
    }
    await expect(mode2FileInput).toHaveCount(1, { timeout: 180_000 })
    const compressToggle = page.locator('label').filter({ hasText: 'Compress before upload' })
    const compressCheckbox = compressToggle.locator('input[type="checkbox"]')
    if (await compressCheckbox.isChecked().catch(() => false)) {
      await compressToggle.click({ force: true })
    }
    if (uploadSizeBytes > 50 * 1024 * 1024) {
      const uploadPath = testInfo.outputPath(fileName)
      await fs.writeFile(uploadPath, fileBytes)
      await mode2FileInput.setInputFiles(uploadPath)
    } else {
      await mode2FileInput.setInputFiles({
        name: fileName,
        mimeType: 'text/plain',
        buffer: fileBytes,
      })
    }

    if (stopAfterPreparePerf) {
      await expect
        .poll(
          () =>
            page.evaluate(() => {
              return (window as Window & { __nilPreparePerf?: unknown }).__nilPreparePerf ?? null
            }),
          {
            timeout: uploadSizeBytes > 50 * 1024 * 1024 ? 900_000 : 180_000,
          },
        )
        .not.toBeNull()

      const prepareProfile = await page.evaluate(() => {
        return (window as Window & { __nilPreparePerf?: unknown }).__nilPreparePerf ?? null
      })
      console.log('[gateway absent prepare profile]', prepareProfile)
      if (capturePreparePerf) {
        expect(prepareProfile).toBeTruthy()
      }
      return
    }

    await expect(page.getByTestId('mdu-upload-card')).toHaveAttribute('data-panel-state', 'running', { timeout: 60_000 })
    await expect(page.getByRole('button', { name: /Retry Upload/i })).toHaveCount(0)
    await expect(page.getByTestId('workflow-step-2')).toHaveAttribute('data-step-state', /^(active|done)$/i, {
      timeout: 60_000,
    })

    await completeUploadAndCommit(page, fileName, dealId, 180_000)

    await expect
      .poll(() => isCommitCompleteOrReset(page, page.getByTestId('mdu-commit'), fileName, dealId, '', true), { timeout: 180_000 })
      .toBe(true)
    await expect(page.getByTestId(`deal-manifest-${dealId}`)).toContainText('0x', { timeout: 180_000 })
    await expect(page.getByTestId('mdu-upload-card').getByText(/\/DEAL\/Upload/i)).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('Upload another file')).toHaveCount(0)
    await expect(page.getByTestId('deal-index-sync-panel')).toHaveCount(0)
    await expect(page.getByTestId('deal-detail-file-row')).toHaveCount(1, { timeout: 60_000 })
    await expect(page.getByTestId('deal-detail-file-row').first()).toContainText(fileName, { timeout: 60_000 })
  })
})
