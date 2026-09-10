import { expect, type Download, type Page, type Response } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'

import { RetrievalProgress, startRetrievalWatchdog } from './utils/retrievalProgress'
import { persistentTest as test } from './utils/persistentBrowser'
import type { RetrievalDiagnostic } from '../src/lib/retrievalDiagnostics'

const enabled = process.env.E2E_NATIVE_V3_BROWSER === '1'
const dealId = process.env.E2E_NATIVE_V3_DEAL_ID || ''
const payer = process.env.E2E_NATIVE_V3_PAYER || ''
const filePath = process.env.E2E_NATIVE_V3_FILE || 'payload.bin'
const expectedBytes = Number(process.env.E2E_NATIVE_V3_BYTES || 1024)
const expectedHash = process.env.E2E_NATIVE_V3_SHA256 || ''
const lcd = process.env.VITE_LCD_BASE || 'http://127.0.0.1:1317'
const resultPath = process.env.E2E_NATIVE_V3_RESULT || ''

async function balance(page: Page, address: string, denom: string): Promise<bigint> {
  const response = await page.request.get(`${lcd}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${denom}`)
  expect(response.ok()).toBe(true)
  return BigInt((await response.json()).balance?.amount || '0')
}

type JsonObject = Record<string, unknown>

async function deal(page: Page): Promise<JsonObject> {
  const response = await page.request.get(`${lcd}/polystorechain/polystorechain/v1/deals/${dealId}`)
  expect(response.ok()).toBe(true)
  return (await response.json()).deal
}

async function sessionById(page: Page, sessionId: string): Promise<JsonObject> {
  const encoded = Buffer.from(sessionId.slice(2), 'hex').toString('base64url')
  const response = await page.request.get(`${lcd}/polystorechain/polystorechain/v1/retrieval-sessions-v3/${encoded}`)
  expect(response.ok()).toBe(true)
  return (await response.json()).session
}

async function hashDownload(download: Download): Promise<{ bytes: number; sha256: string }> {
  const digest = crypto.createHash('sha256')
  let bytes = 0
  const stream = await download.createReadStream()
  if (!stream) throw new Error('browser download stream unavailable')
  for await (const chunk of stream) { const value = Buffer.from(chunk); bytes += value.length; digest.update(value) }
  return { bytes, sha256: digest.digest('hex') }
}

async function openDownload(page: Page) {
  const menu = page.locator(`[data-testid="deal-detail-actions-menu"][data-file-path="${filePath}"]`)
  await expect(menu).toBeVisible({ timeout: 120_000 })
  await menu.click()
  const button = page.locator(`[data-testid="deal-detail-download-gateway-provider"][data-file-path="${filePath}"]`)
  await expect(button).toBeVisible()
  return button
}

async function ensureDealIndex(page: Page): Promise<void> {
  const fileMenu = page.locator(`[data-testid="deal-detail-actions-menu"][data-file-path="${filePath}"]`)
  const sync = page.getByTestId('deal-index-sync-button')
  await expect(fileMenu.or(sync)).toBeVisible({ timeout: 120_000 })
  if (await sync.isVisible()) await sync.click()
  await expect(fileMenu).toBeVisible({ timeout: 120_000 })
}

test.describe('native V3 browser qualification', () => {
  test.skip(!enabled, 'requires the owned four-validator browser stack')
  test.use({ acceptDownloads: true })

  test('PUBLIC native deal is paid, verified, acknowledged, cached and downloaded by its sponsor', async ({ page }) => {
    const retrievalTimeout = expectedBytes >= 2 ** 30 ? 30 * 60_000 : 10 * 60_000
    test.setTimeout(expectedBytes >= 2 ** 30 ? 75 * 60_000 : 15 * 60_000)
    expect(dealId).toMatch(/^[1-9][0-9]*$/)
    expect(payer).toMatch(/^nil1[0-9a-z]+$/)
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/)
    const progress = new RetrievalProgress()
    const diagnostics: RetrievalDiagnostic[] = []
    const providerProofOutcomes: unknown[] = []
    let rawTransactions = 0
    let failure: Error | undefined
    const summary: Record<string, unknown> = { dealId, payer, filePath, expectedBytes, expectedHash, diagnostics, providerProofOutcomes }
    let saved: Promise<void> = Promise.resolve()
    const persist = () => {
      if (!resultPath) return
      const temporary = `${resultPath}.tmp`
      const json = JSON.stringify({ ...summary, progress: progress.snapshot() },
        (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)
      saved = saved.then(() => fs.writeFile(temporary, json)).then(() => fs.rename(temporary, resultPath))
      void saved.catch(() => undefined)
    }
    const stopWatchdog = startRetrievalWatchdog(progress, () => {
      console.log('[native-v3-browser heartbeat]', JSON.stringify(progress.snapshot()))
      persist()
    }, (error) => { failure = error; void page.context().close().catch(() => {}) })
    try {
      await page.exposeFunction('__nativeV3Diagnostic', (event: RetrievalDiagnostic) => {
        diagnostics.push(event); progress.event(event)
      })
      await page.addInitScript(() => {
        const scope = window as unknown as { __polystoreRetrievalDiagnostic: (event: unknown) => void; __nativeV3Diagnostic: (event: unknown) => Promise<void> }
        scope.__polystoreRetrievalDiagnostic = (event) => { void scope.__nativeV3Diagnostic(event) }
      })
      page.on('request', (request) => {
        if (request.method() !== 'POST') return
        try { if (JSON.parse(request.postData() || '{}').method === 'eth_sendRawTransaction') rawTransactions++ } catch { /* evidence remains countable */ }
      })
      page.on('response', (response: Response) => {
        if (new URL(response.url()).pathname !== '/gateway/session-proof' || !response.ok()) return
        void response.json().then((body: unknown) => {
          if (!body || typeof body !== 'object') return
          const outcome = body as JsonObject
          const timing = outcome.timing
          if (timing && typeof timing === 'object' && (timing as JsonObject).schema === 'polystore-v3-provider-timing-v1') {
            providerProofOutcomes.push({ url: response.url(), txHash: outcome.tx_hash, body: outcome })
          }
        }).catch(() => undefined)
      })
      const before = { stake: await balance(page, payer, 'stake'), aatom: await balance(page, payer, 'aatom'), deal: await deal(page) }
      expect(before.deal.owner).not.toBe(payer)
      const policy = before.deal.retrieval_policy
      expect(policy && typeof policy === 'object' && (policy as JsonObject).mode)
        .toBe('RETRIEVAL_POLICY_MODE_PUBLIC')
      progress.enter('deal_detail')
      await page.goto('/#/dashboard', { waitUntil: 'networkidle' })
      const mounted = await page.evaluate(async ({ dealId, payer }) => {
        const modulePath = '/tests/utils/nativeV3DealDetail.tsx'
        const driver = await import(/* @vite-ignore */ modulePath) as typeof import('./utils/nativeV3DealDetail')
        await driver.mountNativeV3DealDetail(dealId, payer)
        return true
      }, { dealId, payer })
      expect(mounted).toBe(true)
      const driver = page.getByTestId('native-v3-live-driver')
      await expect(driver).toHaveAttribute('data-ready', 'true', { timeout: 120_000 })
      await expect(driver).toHaveAttribute('data-gateway-url', /http:\/\/(?:127\.0\.0\.1|localhost):(?:8080|18080)$/)
      await ensureDealIndex(page)
      const feeCap = page.getByTestId('retrieval-max-total-fee')
      await expect(feeCap).toBeVisible({ timeout: 120_000 })
      await feeCap.fill('1000000000')
      await feeCap.blur()
      progress.startRetrieval(retrievalTimeout)
      const button = await openDownload(page)
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: retrievalTimeout }), button.click()])
      const downloaded = await hashDownload(download)
      await download.delete()
      expect(downloaded).toEqual({ bytes: expectedBytes, sha256: expectedHash })
      const sessionId = diagnostics.map((event) => event.sessionId).find((value): value is string => typeof value === 'string')
      expect(sessionId).toMatch(/^0x[0-9a-f]{64}$/)
      const session = await sessionById(page, sessionId!)
      expect(session.owner).toBe(payer)
      expect(session.payer).toBe(payer)
      expect(session.funding).toBe('RETRIEVAL_SESSION_FUNDING_REQUESTER')
      const obligations = session.obligations
      expect(Array.isArray(obligations)).toBe(true)
      const expectedMask = (obligations as JsonObject[]).reduce((mask, row) =>
        mask | (1n << BigInt(String(row.slot))), 0n)
      expect(BigInt(String(session.acked_slots_mask))).toBe(expectedMask)
      expect(BigInt(String(session.settled_slots_mask))).toBe(expectedMask)
      expect(BigInt(String(session.locked_fee))).toBe(0n)
      const variableFee = (obligations as JsonObject[]).reduce((sum, row) =>
        sum + BigInt(String(row.blob_count)) * BigInt(String(session.price_per_blob)), 0n)
      const chargedStake = BigInt(String(session.base_fee)) + variableFee
      const afterPaid = { stake: await balance(page, payer, 'stake'), aatom: await balance(page, payer, 'aatom'), deal: await deal(page) }
      expect(before.stake - afterPaid.stake).toBe(chargedStake)
      expect(afterPaid.aatom).toBeLessThan(before.aatom)
      expect(afterPaid.deal.escrow_balance).toBe(before.deal.escrow_balance)
      expect(rawTransactions).toBeGreaterThan(0)
      await expect.poll(() => providerProofOutcomes.length).toBeGreaterThan(0)
      for (const observed of providerProofOutcomes) {
        const row = observed as JsonObject
        expect(row.txHash).toMatch(/^[0-9a-f]{64}$/i)
        const body = row.body as JsonObject
        const timing = body.timing as JsonObject
        expect(timing.schema).toBe('polystore-v3-provider-timing-v1')
        for (const field of ['authority_ns', 'proof_preparation_ns', 'commit_observation_ns', 'provider_total_ns']) {
          expect(Number(timing[field])).toBeGreaterThanOrEqual(0)
        }
        expect(Array.isArray(timing.submission_attempts)).toBe(true)
        expect((timing.submission_attempts as unknown[]).length).toBeGreaterThan(0)
      }
      const progressAfterPaid = progress.snapshot()
      expect(progressAfterPaid.verifiedLogicalBytesWritten).toBe(expectedBytes)
      expect(progressAfterPaid.flushedLogicalBytes).toBe(expectedBytes)
      expect(progressAfterPaid.verifiedChunks).toBeGreaterThan(0)
      expect(progressAfterPaid.ackedObligations).toBe((obligations as JsonObject[]).length)
      for (const phase of ['chunk_transport', 'browser_verify', 'decode_write', 'flush']) {
        expect(diagnostics.some((event) => event.phase === phase && event.edge === 'start')).toBe(true)
        expect(diagnostics.some((event) => event.phase === phase && event.edge === 'end')).toBe(true)
      }
      const paidTransactions = rawTransactions
      const cacheButton = page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`)
      const [cachedDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: retrievalTimeout }), cacheButton.click(),
      ])
      const cached = await hashDownload(cachedDownload)
      await cachedDownload.delete()
      expect(cached).toEqual(downloaded)
      expect(rawTransactions).toBe(paidTransactions)
      expect(await balance(page, payer, 'stake')).toBe(afterPaid.stake)
      expect(await balance(page, payer, 'aatom')).toBe(afterPaid.aatom)
      if (failure) throw failure
      Object.assign(summary, { success: true, before, afterPaid, chargedStake: String(chargedStake), session, rawTransactions, downloaded })
    } finally {
      stopWatchdog()
      persist()
      await saved
    }
  })
})
