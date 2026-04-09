import { test, expect, type Locator, type Page } from '@playwright/test'
import crypto from 'node:crypto'
import { multiaddrToHttpUrl } from '../src/lib/multiaddr'
import { dismissCreateDealDrawer, ensureCreateDealDrawerOpen } from './utils/dashboard'

const dashboardPath = process.env.E2E_PATH || '/#/dashboard'
const hasLocalStack = process.env.E2E_LOCAL_STACK === '1'
const providerCount = Number(process.env.PROVIDER_COUNT || '0')
const lcdBase = process.env.E2E_LCD_BASE || 'http://127.0.0.1:3317'

type DealResponse = {
  deal?: {
    id?: string
    current_gen?: string
    manifest_root?: string
    mode2_slots?: Array<{
      slot?: number
      provider?: string
      status?: string
    }>
  }
}

type ProviderResponse = {
  provider?: {
    endpoints?: string[]
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`request failed (${response.status}) for ${url}`)
  }
  return (await response.json()) as T
}

async function fetchDeal(dealId: string): Promise<DealResponse['deal']> {
  const payload = await fetchJson<DealResponse>(`${lcdBase}/polystorechain/polystorechain/v1/deals/${dealId}`)
  if (!payload.deal) throw new Error(`missing deal payload for ${dealId}`)
  return payload.deal
}

async function fetchProviderHttpBase(address: string): Promise<string> {
  const payload = await fetchJson<ProviderResponse>(`${lcdBase}/polystorechain/polystorechain/v1/providers/${address}`)
  const endpoints = payload.provider?.endpoints || []
  for (const endpoint of endpoints) {
    const httpUrl = multiaddrToHttpUrl(endpoint)
    if (httpUrl) return httpUrl.replace(/\/+$/, '')
  }
  throw new Error(`no http endpoint for provider ${address}`)
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
    const walletVisible = await walletAddress.isVisible().catch(() => false)
    if (walletVisible) return true

    if (await polystoreIdentity.isVisible().catch(() => false)) {
      const raw = ((await polystoreIdentity.textContent().catch(() => '')) || '').trim()
      if (raw && raw !== '—' && !/^not\s+connected$/i.test(raw)) return true
    }
    return false
  }

  if (await isConnected()) return
  if (await connectBtn.isVisible().catch(() => false)) {
    await connectBtn.click({ force: true })
  }

  const browserWalletBtn = page.getByRole('button', { name: /Browser Wallet/i })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (await isConnected()) return
    if (await browserWalletBtn.isVisible().catch(() => false)) {
      await browserWalletBtn.click({ force: true })
    }
    await page.waitForTimeout(500)
    if (await connectBtn.isVisible().catch(() => false)) {
      await connectBtn.click({ force: true })
    }
  }

  expect(await isConnected()).toBe(true)
}

async function ensureWalletFunded(page: Page, timeout = 120_000): Promise<void> {
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
}

async function isCommitCompleteOrReset(page: Page, commitBtn: Locator, filePath: string, dealId?: string): Promise<boolean> {
  const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)
  if ((await fileRow.count().catch(() => 0)) > 0 && (await fileRow.first().isVisible().catch(() => false))) return true

  if (dealId) {
    const liveDeal = await fetchDeal(dealId).catch(() => null)
    if (liveDeal && String(liveDeal.current_gen || '') === '1' && String(liveDeal.manifest_root || '') !== '') {
      return true
    }
  }

  const panelState = await page.getByTestId('mdu-upload-card').getAttribute('data-panel-state').catch(() => null)
  if (panelState === 'success') return true

  const text = ((await commitBtn.textContent().catch(() => '')) || '').trim()
  if (/Committed!/i.test(text)) return true
  return false
}

async function completeUploadAndCommit(uploadBtn: Locator, commitBtn: Locator, filePath: string, dealId: string, timeout = 300_000): Promise<void> {
  const page = uploadBtn.page()
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await isCommitCompleteOrReset(page, commitBtn, filePath, dealId)) return

    const commitEnabled = (await commitBtn.count().catch(() => 0)) > 0 && (await commitBtn.isEnabled().catch(() => false))
    if (commitEnabled) {
      await commitBtn.click({ force: true })
      await expect.poll(() => isCommitCompleteOrReset(page, commitBtn, filePath, dealId), { timeout: 180_000 }).toBe(true)
      return
    }

    const uploadEnabled = (await uploadBtn.count().catch(() => 0)) > 0 && (await uploadBtn.isEnabled().catch(() => false))
    if (uploadEnabled) {
      await uploadBtn.click({ force: true })
    }

    await page.waitForTimeout(500)
  }

  await expect.poll(() => isCommitCompleteOrReset(page, commitBtn, filePath, dealId), { timeout: 180_000 }).toBe(true)
}

test.describe('mode2 setup bump live', () => {
  test.skip(!hasLocalStack, 'requires local stack')
  test.skip(providerCount < 4, 'requires at least 4 providers so a spare replacement exists')

  test('failed setup slot is bumped and retried on a replacement provider', async ({ page }) => {
    test.setTimeout(420_000)

    const filePath = 'mode2-setup-bump-live.bin'
    const fileBytes = crypto.randomBytes(224 * 1024)
    const failedSlot = 0
    let forcedFailure = false
    let failedSlotTarget = ''
    const bundleTargets = new Set<string>()

    await page.route('**/gateway/upload*', async (route) => {
      await route.abort('failed')
    })
    await page.route('**/gateway/upload-status*', async (route) => {
      await route.abort('failed')
    })
    await page.route('**/sp/upload_bundle', async (route) => {
      const target = new URL(route.request().url()).origin
      bundleTargets.add(target)
      if (target === failedSlotTarget && !forcedFailure && route.request().method().toUpperCase() === 'POST') {
        forcedFailure = true
        await route.fulfill({
          status: 503,
          contentType: 'text/plain',
          body: 'forced setup slot failure',
        })
        return
      }
      await route.continue()
    })

    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(dashboardPath, { waitUntil: 'networkidle' })

    await ensureWalletConnected(page)
    await expect(page.getByText('Wrong Network')).toHaveCount(0)
    await ensureWalletFunded(page)

    await ensureCreateDealDrawerOpen(page)
    await page.getByTestId('alloc-submit').click()
    const workspaceTitle = page.getByTestId('workspace-deal-title')
    await expect(workspaceTitle).toHaveText(/Deal #\d+/, { timeout: 120_000 })
    await dismissCreateDealDrawer(page)

    const dealTitle = (await workspaceTitle.textContent().catch(() => '')) || ''
    const dealId = dealTitle.match(/#(\d+)/)?.[1] || ''
    expect(dealId).not.toBe('')

    const initialDeal = await fetchDeal(dealId)
    const initialSlots = initialDeal.mode2_slots || []
    const initialSlot = initialSlots.find((entry) => Number(entry.slot) === failedSlot) || initialSlots[failedSlot]
    expect(initialSlot?.provider || '').not.toBe('')
    const initialProvider = String(initialSlot?.provider || '')
    failedSlotTarget = await fetchProviderHttpBase(initialProvider)

    const dealRow = page.getByTestId(`deal-row-${dealId}`)
    await expect(dealRow).toBeVisible({ timeout: 60_000 })
    await dealRow.click()
    await expect(workspaceTitle).toHaveText(new RegExp(`#${dealId}`), { timeout: 60_000 })
    await expect(page.getByTestId('mdu-file-input')).toHaveCount(1, { timeout: 120_000 })

    await page.getByTestId('mdu-file-input').setInputFiles({
      name: filePath,
      mimeType: 'application/octet-stream',
      buffer: fileBytes,
    })

    const uploadBtn = page.getByTestId('mdu-upload')
    const commitBtn = page.getByTestId('mdu-commit')
    await waitForUploadControls(uploadBtn, commitBtn, 180_000)
    await completeUploadAndCommit(uploadBtn, commitBtn, filePath, dealId, 300_000)

    expect(forcedFailure).toBe(true)

    await dealRow.click({ force: true }).catch(() => undefined)
    const filesTab = page.getByRole('button', { name: /^Files$/ })
    if (await filesTab.isVisible().catch(() => false)) {
      await filesTab.click({ force: true })
    }

    const fileRow = page.locator(`[data-testid="deal-detail-file-row"][data-file-path="${filePath}"]`)
    await fileRow.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined)

    const finalDeal = await fetchDeal(dealId)
    const finalSlots = finalDeal.mode2_slots || []
    const finalSlot = finalSlots.find((entry) => Number(entry.slot) === failedSlot) || finalSlots[failedSlot]
    expect(finalSlot?.provider || '').not.toBe('')
    const replacementProvider = String(finalSlot?.provider || '')
    const replacementTarget = await fetchProviderHttpBase(replacementProvider)

    expect(replacementProvider).not.toBe(initialProvider)
    expect(bundleTargets.has(failedSlotTarget)).toBe(true)
    expect(bundleTargets.has(replacementTarget)).toBe(true)
    expect(String(finalDeal.current_gen || '')).toBe('1')
    expect(String(finalDeal.manifest_root || '')).not.toBe('')

    console.log('[mode2 setup bump live evidence]', {
      dealId,
      failedSlot,
      initialProvider,
      replacementProvider,
      failedSlotTarget,
      replacementTarget,
      bundleTargets: Array.from(bundleTargets),
      fileVisibleInUi: await fileRow.isVisible().catch(() => false),
    })
  })
})
