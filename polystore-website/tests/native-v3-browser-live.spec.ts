import { expect, type APIRequestContext, type Download, type Page, type Response, type Route } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'

import { RetrievalProgress, startRetrievalWatchdog } from './utils/retrievalProgress'
import { persistentTest as test } from './utils/persistentBrowser'
import type { RetrievalDiagnostic } from '../src/lib/retrievalDiagnostics'

const enabled = process.env.E2E_NATIVE_V3_BROWSER === '1'
const expiryEnabled = process.env.E2E_NATIVE_V3_EXPIRY === '1'
const faultsEnabled = process.env.E2E_NATIVE_V3_FAULTS === '1'
const dealId = process.env.E2E_NATIVE_V3_DEAL_ID || ''
const payer = process.env.E2E_NATIVE_V3_PAYER || ''
const filePath = process.env.E2E_NATIVE_V3_FILE || 'payload.bin'
const expectedBytes = Number(process.env.E2E_NATIVE_V3_BYTES || 1024)
const expectedHash = process.env.E2E_NATIVE_V3_SHA256 || ''
const lcd = process.env.VITE_LCD_BASE || 'http://127.0.0.1:1317'
const evm = process.env.VITE_EVM_RPC || 'http://127.0.0.1:8545'
const resultPath = process.env.E2E_NATIVE_V3_RESULT || ''

async function balance(page: Page, address: string, denom: string): Promise<bigint> {
  const response = await page.request.get(`${lcd}/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${denom}`)
  expect(response.ok()).toBe(true)
  return BigInt((await response.json()).balance?.amount || '0')
}

type JsonObject = Record<string, unknown>

type EvmRpcRequest = { id?: string | number; method?: string; params?: unknown[] }
type V3PlannedChunk = { id: string; slot: number; mduIndex: string; startBlobIndex: number; entries: string[] }
type V3CheckpointObservation = {
  sessionId: string; nonce: string; population: string; sampleCount: string; ackedMask: number; settledMask: number
  lockedFee: string; cursors: Record<string, string>; chunks: V3PlannedChunk[]; unsampled: string[]
}

type MduRequestCounts = {
  gatewayMetadata: number; gatewayData: number; directMetadata: number; directData: number
}

function proofOutcomeSlots(outcomes: unknown[]): number[] {
  const slots = outcomes.flatMap((observed) => {
    if (!observed || typeof observed !== 'object') return []
    const body = (observed as JsonObject).body
    if (!body || typeof body !== 'object') return []
    const slot = Number((body as JsonObject).slot)
    return Number.isInteger(slot) ? [slot] : []
  })
  return [...new Set(slots)].sort((a, b) => a - b)
}

async function evmRpc(page: Page, method: string, params: unknown[]): Promise<unknown> {
  const response = await page.request.post(evm, {
    data: { jsonrpc: '2.0', id: method, method, params },
  })
  expect(response.ok()).toBe(true)
  const body = await response.json() as JsonObject
  expect(body.error).toBeUndefined()
  return body.result
}

async function deal(page: Page): Promise<JsonObject> {
  const response = await page.request.get(`${lcd}/polystorechain/polystorechain/v1/deals/${dealId}`)
  expect(response.ok()).toBe(true)
  return (await response.json()).deal
}

async function sessionById(page: Page, sessionId: string): Promise<JsonObject> {
  const encoded = Buffer.from(sessionId.slice(2), 'hex').toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
  const response = await page.request.get(`${lcd}/polystorechain/polystorechain/v1/retrieval-sessions-v3/${encodeURIComponent(encoded)}`)
  expect(response.ok()).toBe(true)
  return (await response.json()).session
}

async function latestHeight(request: APIRequestContext): Promise<bigint> {
  const response = await request.get(`${lcd}/cosmos/base/tendermint/v1beta1/blocks/latest`)
  expect(response.ok()).toBe(true)
  const body = await response.json() as JsonObject
  const block = body.block as JsonObject | undefined
  const header = block?.header as JsonObject | undefined
  return BigInt(String(header?.height || '0'))
}

async function observeV3Checkpoint(page: Page): Promise<V3CheckpointObservation> {
  return page.evaluate(async ({ dealId, payer }) => {
    const checkpoints = await import(/* @vite-ignore */ '/src/lib/retrievalV3Checkpoint.ts') as typeof import('../src/lib/retrievalV3Checkpoint')
    const transactions = await import(/* @vite-ignore */ '/src/lib/retrievalTransactions.ts') as typeof import('../src/lib/retrievalTransactions')
    const retrieval = await import(/* @vite-ignore */ '/src/lib/retrievalV3.ts') as typeof import('../src/lib/retrievalV3')
    const { workerClient } = await import(/* @vite-ignore */ '/src/lib/worker-client.ts') as typeof import('../src/lib/worker-client')
    const { appConfig } = await import(/* @vite-ignore */ '/src/config.ts') as typeof import('../src/config')
    const rows = checkpoints.listRetrievalV3Checkpoints(BigInt(dealId), payer, appConfig.cosmosChainId,
      transactions.browserRetrievalStore())
    if (rows.length !== 1 || !rows[0].state.session?.anchorSeed) throw new Error('expected one ready frozen v3 checkpoint')
    const state = rows[0].state, session = state.session
    const challenges = await workerClient.retrievalV3Challenges(session.context, session.anchorSeed)
    const selected = new Set<string>(), view = new DataView(challenges.buffer, challenges.byteOffset, challenges.byteLength)
    for (let offset = 0; offset < challenges.byteLength; offset += 72) selected.add(view.getBigUint64(offset + 16).toString())
    const chunks = [...retrieval.planV3Chunks(session)].map((chunk) => ({
      id: `${chunk.slot}:${chunk.entries[0].t}:${chunk.entries[chunk.entries.length - 1].t}`,
      slot: chunk.slot, mduIndex: chunk.mduIndex.toString(), startBlobIndex: chunk.startBlobIndex,
      entries: chunk.entries.map((entry) => entry.t.toString()),
    }))
    const unsampled: string[] = []
    for (let t = session.first; t <= session.last; t++) if (!selected.has(t.toString())) unsampled.push(t.toString())
    return {
      sessionId: session.sessionId, nonce: session.nonce.toString(), population: session.population.toString(),
      sampleCount: session.sampleCount.toString(), ackedMask: session.ackedMask, settledMask: session.settledMask,
      lockedFee: session.lockedFee.toString(),
      cursors: Object.fromEntries(Object.entries(state.cursors).map(([slot, through]) => [slot, through!.toString()])),
      chunks, unsampled,
    }
  }, { dealId, payer })
}

function mutateV3Multipart(body: Buffer, contentType: string, kind: 'corrupt' | 'multipart-order' | 'truncate', blob = 0): Buffer {
  const boundary = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean)
  if (!boundary) throw new Error('missing v3 multipart boundary')
  const opening = Buffer.from(`--${boundary}\r\n`), middle = Buffer.from(`\r\n--${boundary}\r\n`)
  const closing = Buffer.from(`\r\n--${boundary}--`), headerEnd = Buffer.from('\r\n\r\n')
  const split = body.indexOf(middle, opening.length), close = body.indexOf(closing, split + middle.length)
  const secondHeader = body.indexOf(headerEnd, split + middle.length)
  if (!body.subarray(0, opening.length).equals(opening) || split < 0 || close < 0 || secondHeader < 0) {
    throw new Error('unexpected v3 multipart framing')
  }
  if (kind === 'multipart-order') {
    const first = body.subarray(opening.length, split), second = body.subarray(split + middle.length, close)
    return Buffer.concat([opening, second, middle, first, body.subarray(close)])
  }
  const dataStart = secondHeader + headerEnd.length
  if (close - dataStart < 1) throw new Error('missing v3 multipart bytes')
  if (kind === 'truncate') return Buffer.concat([body.subarray(0, close - 1), body.subarray(close)])
  const offset = dataStart + blob * 131_072 + 1
  if (offset >= close) throw new Error('corruption target lies outside v3 multipart bytes')
  const mutated = Buffer.from(body)
  mutated[offset] ^= 1
  return mutated
}

async function hashDownload(download: Download): Promise<{ bytes: number; sha256: string }> {
  const digest = crypto.createHash('sha256')
  let bytes = 0
  const stream = await download.createReadStream()
  if (!stream) throw new Error('browser download stream unavailable')
  for await (const chunk of stream) { const value = Buffer.from(chunk); bytes += value.length; digest.update(value) }
  return { bytes, sha256: digest.digest('hex') }
}

async function readDownloadFailureBanner(page: Page): Promise<string> {
  const banner = page.locator('div').filter({ hasText: /^Download failed:/ }).first()
  if (!await banner.isVisible().catch(() => false)) return ''
  return ((await banner.textContent().catch(() => '')) || '').trim()
}

async function waitForDownloadEventOrFailure(page: Page, timeout: number, baselineFailure: string): Promise<Download> {
  const outcomePromise = page.waitForEvent('download', { timeout })
    .then((download) => ({ kind: 'download' as const, download }))
    .catch(() => ({ kind: 'timeout' as const }))
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const outcome = await Promise.race([outcomePromise, page.waitForTimeout(500).then(() => null)])
    if (outcome?.kind === 'download') return outcome.download
    if (outcome?.kind === 'timeout') break
    const failure = await readDownloadFailureBanner(page)
    if (failure && failure !== baselineFailure) throw new Error(`download failed before browser event: ${failure}`)
  }
  const failure = await readDownloadFailureBanner(page)
  throw new Error(`download event not emitted${failure ? `: ${failure}` : ''}`)
}

async function waitForRetrievalFailure(page: Page, timeout = 120_000): Promise<string> {
  await expect.poll(() => readDownloadFailureBanner(page), { timeout }).toContain('Download failed:')
  const failure = await readDownloadFailureBanner(page)
  expect(failure).toContain('Download failed:')
  return failure
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

async function rejectNextWalletTransactionBeforeLoad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Provider = {
      isPolyStoreE2E?: boolean
      request: (args: { method: string; params?: unknown }) => Promise<unknown>
    }
    const scope = window as unknown as {
      ethereum?: Provider
      __nativeV3WalletRejection?: { installed: boolean; rejected: number }
    }
    const evidence = { installed: false, rejected: 0 }
    scope.__nativeV3WalletRejection = evidence
    let installed: Provider | undefined
    Object.defineProperty(scope, 'ethereum', {
      configurable: true,
      enumerable: true,
      get: () => installed,
      set: (provider: Provider) => {
        installed = provider
        if (provider?.isPolyStoreE2E !== true || typeof provider.request !== 'function') {
          throw new Error('qualification expected the installed PolyStore E2E wallet')
        }
        const request = provider.request.bind(provider)
        let reject = true
        provider.request = async (args) => {
          if (reject && args.method === 'eth_sendTransaction') {
            reject = false
            evidence.rejected++
            throw Object.assign(new Error('qualification wallet rejection'), { code: 4001 })
          }
          return request(args)
        }
        evidence.installed = true
        Object.defineProperty(scope, 'ethereum', {
          configurable: true, enumerable: true, writable: true, value: provider,
        })
      },
    })
  })
}

async function mountDealDetail(page: Page, prepareRetrieval = true): Promise<string> {
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
  const gatewayUrl = await driver.getAttribute('data-gateway-url')
  if (!gatewayUrl) throw new Error('native V3 gateway URL unavailable')
  if (prepareRetrieval) {
    await ensureDealIndex(page)
    const feeCap = page.getByTestId('retrieval-max-total-fee')
    await expect(feeCap).toBeVisible({ timeout: 120_000 })
    await feeCap.fill('1000000000')
    await feeCap.blur()
  }
  return gatewayUrl
}

async function latestNonce(page: Page): Promise<{ found: boolean; nonce: string }> {
  const response = await page.request.get(
    `${lcd}/polystorechain/polystorechain/v1/retrieval-sessions-v3/by-owner/${payer}/deals/${dealId}/nonce`,
  )
  expect(response.ok()).toBe(true)
  const body = await response.json() as JsonObject
  return { found: body.found === true, nonce: String(body.nonce || '0') }
}

async function unfinishedLocalState(page: Page): Promise<{ checkpoints: number; unbound: number; journals: Array<{ state: string; hasHash: boolean }> }> {
  return page.evaluate(async ({ dealId, payer }) => {
    const checkpointsPath = '/src/lib/retrievalV3Checkpoint.ts'
    const transactionsPath = '/src/lib/retrievalTransactions.ts'
    const configPath = '/src/config.ts'
    const checkpoints = await import(/* @vite-ignore */ checkpointsPath) as typeof import('../src/lib/retrievalV3Checkpoint')
    const transactions = await import(/* @vite-ignore */ transactionsPath) as typeof import('../src/lib/retrievalTransactions')
    const { appConfig } = await import(/* @vite-ignore */ configPath) as typeof import('../src/config')
    const store = transactions.browserRetrievalStore()
    const rows = checkpoints.listRetrievalV3Checkpoints(BigInt(dealId), payer, appConfig.cosmosChainId, store)
    return {
      checkpoints: rows.length,
      unbound: rows.filter(({ state }) => state.session === undefined).length,
      journals: (store.keys?.('open-v3:') || []).map((key) => {
        const value = store.get<{ state?: unknown; hash?: unknown }>(key)
        return { state: String(value?.state || ''), hasHash: typeof value?.hash === 'string' }
      }),
    }
  }, { dealId, payer })
}

test.describe('native V3 browser qualification', () => {
  test.skip(!enabled, 'requires the owned four-validator browser stack')
  test.use({ acceptDownloads: true })

  test('PUBLIC native deal is paid, verified, acknowledged, cached and downloaded by its sponsor', async ({ page }) => {
    test.skip(expiryEnabled || faultsEnabled, 'dedicated fault invocations skip the happy path')
    const retrievalTimeout = expectedBytes >= 2 ** 30 ? 30 * 60_000 : 10 * 60_000
    test.setTimeout(expectedBytes >= 2 ** 30 ? 75 * 60_000 : 15 * 60_000)
    expect(dealId).toMatch(/^(?:0|[1-9][0-9]*)$/)
    expect(payer).toMatch(/^nil1[0-9a-z]+$/)
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/)
    const progress = new RetrievalProgress()
    const diagnostics: RetrievalDiagnostic[] = []
    const providerProofOutcomes: unknown[] = []
    const evmResponseHashes: string[] = []
    const evmTransactions: JsonObject[] = []
    const evmReceipts: JsonObject[] = []
    const gatewayMduCanceled: Array<{ url: string; kind: 'metadata' | 'data'; error: string }> = []
    const directSpMduRequests: string[] = []
    const mduNetworkRequests: MduRequestCounts = {
      gatewayMetadata: 0, gatewayData: 0, directMetadata: 0, directData: 0,
    }
    const snapshotMduRequests = (): MduRequestCounts => ({ ...mduNetworkRequests })
    let rawTransactions = 0
    let failure: Error | undefined
    const summary: Record<string, unknown> = {
      dealId, payer, filePath, expectedBytes, expectedHash, diagnostics, providerProofOutcomes,
      evmResponseHashes, evmTransactions, evmReceipts,
    }
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
        const path = new URL(request.url()).pathname
        const gatewayMdu = /^\/gateway\/mdu\/[^/]+\/[^/]+$/.test(path)
        const directMdu = /^\/sp\/retrieval\/mdu\/[^/]+\/[^/]+$/.test(path)
        if (gatewayMdu || directMdu) {
          const data = Boolean(request.headers()['x-polystore-session-id'])
          if (gatewayMdu && data) mduNetworkRequests.gatewayData++
          else if (gatewayMdu) mduNetworkRequests.gatewayMetadata++
          else if (data) mduNetworkRequests.directData++
          else mduNetworkRequests.directMetadata++
        }
        if (directMdu) {
          directSpMduRequests.push(request.url())
        }
        if (request.method() !== 'POST') return
        try { if (JSON.parse(request.postData() || '{}').method === 'eth_sendRawTransaction') rawTransactions++ } catch { /* evidence remains countable */ }
      })
      page.on('requestfailed', (request) => {
        const path = new URL(request.url()).pathname
        if (!/^\/gateway\/mdu\/[^/]+\/[^/]+$/.test(path)) return
        gatewayMduCanceled.push({
          url: request.url(),
          kind: request.headers()['x-polystore-session-id'] ? 'data' : 'metadata',
          error: request.failure()?.errorText || 'request failed',
        })
      })
      page.on('response', (response: Response) => {
        if (response.request().method() === 'POST' && response.url().startsWith(evm)) {
          let request: EvmRpcRequest
          try { request = JSON.parse(response.request().postData() || '{}') as EvmRpcRequest } catch { request = {} }
          if (request.method === 'eth_sendRawTransaction' && response.ok()) {
            void response.json().then((body: JsonObject) => {
              if (typeof body.result === 'string' && /^0x[0-9a-f]{64}$/i.test(body.result)) evmResponseHashes.push(body.result)
            }).catch(() => undefined)
          }
        }
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
      await mountDealDetail(page)
      progress.startRetrieval(retrievalTimeout)
      const button = await openDownload(page)
      const [download] = await Promise.all([
        waitForDownloadEventOrFailure(page, retrievalTimeout, await readDownloadFailureBanner(page)), button.click(),
      ])
      const downloaded = await hashDownload(download)
      await download.delete()
      expect(downloaded).toEqual({ bytes: expectedBytes, sha256: expectedHash })
      const openedSessions = diagnostics.filter((event) => event.phase === 'opened_session')
      expect(openedSessions).toHaveLength(1)
      const sessionId = openedSessions[0].sessionId
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
      const completedHeight = String(session.updated_height)
      expect(completedHeight).toMatch(/^[1-9][0-9]*$/)
      progress.completed(sessionId!, completedHeight)
      const variableFee = (obligations as JsonObject[]).reduce((sum, row) =>
        sum + BigInt(String(row.blob_count)) * BigInt(String(session.price_per_blob)), 0n)
      const chargedStake = BigInt(String(session.base_fee)) + variableFee
      const afterPaid = { stake: await balance(page, payer, 'stake'), aatom: await balance(page, payer, 'aatom'), deal: await deal(page) }
      expect(before.stake - afterPaid.stake).toBe(chargedStake)
      expect(afterPaid.aatom).toBeLessThan(before.aatom)
      expect(afterPaid.deal.escrow_balance).toBe(before.deal.escrow_balance)
      expect(rawTransactions).toBeGreaterThan(0)
      await expect.poll(() => evmResponseHashes.length).toBe(rawTransactions)
      for (const hash of evmResponseHashes) {
        const transaction = await evmRpc(page, 'eth_getTransactionByHash', [hash])
        const receipt = await evmRpc(page, 'eth_getTransactionReceipt', [hash])
        expect(transaction && typeof transaction === 'object').toBe(true)
        expect(receipt && typeof receipt === 'object').toBe(true)
        const tx = transaction as JsonObject, committed = receipt as JsonObject
        expect(tx.hash).toBe(hash)
        expect(committed.transactionHash).toBe(hash)
        expect(committed.status).toBe('0x1')
        expect(BigInt(String(committed.blockNumber))).toBeGreaterThan(0n)
        evmTransactions.push(tx)
        evmReceipts.push(committed)
      }
      const obligationSlots = (obligations as JsonObject[]).map((row) => Number(row.slot)).sort((a, b) => a - b)
      await expect.poll(() => proofOutcomeSlots(providerProofOutcomes)).toEqual(obligationSlots)
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
      for (const phase of ['metadata_authentication', 'chunk_transport', 'browser_verify', 'decode_write', 'flush']) {
        expect(diagnostics.some((event) => event.phase === phase && event.edge === 'start')).toBe(true)
        expect(diagnostics.some((event) => event.phase === phase && event.edge === 'end')).toBe(true)
      }
      const requestCounts = snapshotMduRequests()
      expect(requestCounts.gatewayMetadata).toBeGreaterThan(0)
      expect(requestCounts.gatewayData).toBeGreaterThan(0)
      expect(requestCounts.directMetadata).toBe(0)
      expect(requestCounts.directData).toBe(0)
      expect(directSpMduRequests).toHaveLength(0)
      const retrievalHttp = {
        requestCounts,
        canceled: { count: gatewayMduCanceled.length, responses: gatewayMduCanceled },
        wireBytesMeasured: false,
      }
      Object.assign(summary, { paidDiagnosticCount: diagnostics.length, progressAfterPaid, retrievalHttp })
      const paidTransactions = rawTransactions
      const cacheMduRequests = { before: snapshotMduRequests(), after: snapshotMduRequests() }
      const cacheButton = page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`)
      const [cachedDownload] = await Promise.all([
        waitForDownloadEventOrFailure(page, retrievalTimeout, await readDownloadFailureBanner(page)), cacheButton.click(),
      ])
      const cached = await hashDownload(cachedDownload)
      await cachedDownload.delete()
      cacheMduRequests.after = snapshotMduRequests()
      expect(cached).toEqual(downloaded)
      expect(cacheMduRequests.after).toEqual(cacheMduRequests.before)
      expect(rawTransactions).toBe(paidTransactions)
      expect(await balance(page, payer, 'stake')).toBe(afterPaid.stake)
      expect(await balance(page, payer, 'aatom')).toBe(afterPaid.aatom)
      if (failure) throw failure
      Object.assign(summary, { success: true, before, afterPaid, chargedStake: String(chargedStake), session,
        rawTransactions, downloaded, cached, cacheMduRequests })
    } finally {
      stopWatchdog()
      persist()
      await saved
    }
  })

  for (const fault of ['estimate rejected', 'wallet 4001'] as const) {
    test(`${fault} before payment preserves an unfinished request without spending`, async ({ page }) => {
      test.skip(expiryEnabled || faultsEnabled, 'dedicated fault invocations skip pre-payment cases')
      test.setTimeout(5 * 60_000)
      expect(dealId).toMatch(/^(?:0|[1-9][0-9]*)$/)
      expect(payer).toMatch(/^nil1[0-9a-z]+$/)
      let estimates = 0, rawTransactions = 0
      const context = page.context()
      context.on('request', (request) => {
        if (request.method() !== 'POST' || !request.url().startsWith(evm)) return
        try {
          const body = JSON.parse(request.postData() || '{}') as EvmRpcRequest
          if (body.method === 'eth_estimateGas') estimates++
          if (body.method === 'eth_sendRawTransaction') rawTransactions++
        } catch { /* malformed requests cannot count as payment evidence */ }
      })
      if (fault === 'estimate rejected') {
        await page.route(evm, async (route) => {
          const request = route.request()
          let body: EvmRpcRequest
          try { body = JSON.parse(request.postData() || '{}') as EvmRpcRequest } catch { return route.continue() }
          if (body.method !== 'eth_estimateGas') return route.continue()
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              jsonrpc: '2.0', id: body.id,
              error: { code: -32000, message: 'qualification estimate rejection' },
            }),
          })
        })
      } else {
        await rejectNextWalletTransactionBeforeLoad(page)
      }
      const before = {
        stake: await balance(page, payer, 'stake'),
        aatom: await balance(page, payer, 'aatom'),
        nonce: await latestNonce(page),
      }
      await mountDealDetail(page)
      if (fault === 'wallet 4001') {
        expect(await page.evaluate(() => (window as unknown as {
          __nativeV3WalletRejection?: { installed: boolean; rejected: number }
        }).__nativeV3WalletRejection)).toEqual({ installed: true, rejected: 0 })
      }
      const button = await openDownload(page)
      await button.click()
      await expect(page.locator('div').filter({ hasText: /^Download failed:/ }).first()).toBeVisible({ timeout: 120_000 })
      if (fault === 'wallet 4001') {
        expect(await page.evaluate(() => (window as unknown as {
          __nativeV3WalletRejection?: { installed: boolean; rejected: number }
        }).__nativeV3WalletRejection)).toEqual({ installed: true, rejected: 1 })
      }
      expect(estimates).toBeGreaterThan(0)
      expect(rawTransactions).toBe(0)
      const after = {
        stake: await balance(page, payer, 'stake'),
        aatom: await balance(page, payer, 'aatom'),
        nonce: await latestNonce(page),
      }
      expect(after.stake).toBe(before.stake)
      expect(after.aatom).toBe(before.aatom)
      expect(after.nonce).toEqual(before.nonce)
      await expect.poll(() => unfinishedLocalState(page)).toEqual({
        checkpoints: 1,
        unbound: 1,
        journals: fault === 'wallet 4001' ? [{ state: 'prepared', hasHash: false }] : [],
      })
      const localState = await unfinishedLocalState(page)
      await page.close()
      const reopened = await context.newPage()
      await mountDealDetail(reopened, false)
      await expect.poll(() => unfinishedLocalState(reopened)).toEqual(localState)
      const discard = reopened.locator(
        `[data-testid="deal-detail-discard-unbound-v3"][data-file-path="${filePath}"]`,
      )
      await expect(discard).toBeVisible({ timeout: 120_000 })
      await discard.click()
      const clearedState = { checkpoints: 0, unbound: 0, journals: [] }
      await expect.poll(() => unfinishedLocalState(reopened)).toEqual(clearedState)
      await expect(discard).toHaveCount(0)
      const afterDiscard = {
        stake: await balance(reopened, payer, 'stake'),
        aatom: await balance(reopened, payer, 'aatom'),
        nonce: await latestNonce(reopened),
      }
      expect(afterDiscard.stake).toBe(before.stake)
      expect(afterDiscard.aatom).toBe(before.aatom)
      expect(afterDiscard.nonce).toEqual(before.nonce)
      expect(rawTransactions).toBe(0)
      if (resultPath) {
        const result = JSON.parse(await fs.readFile(resultPath, 'utf8')) as JsonObject
        expect(result.success).toBe(true)
        const outcomes = result.prepayOutcomes && typeof result.prepayOutcomes === 'object'
          ? result.prepayOutcomes as JsonObject : {}
        outcomes[fault] = {
          estimates, rawTransactions, before: { ...before, stake: String(before.stake), aatom: String(before.aatom) },
          after: { ...after, stake: String(after.stake), aatom: String(after.aatom) },
          localState, survivedReopen: true, clearedState,
          afterDiscard: { ...afterDiscard, stake: String(afterDiscard.stake), aatom: String(afterDiscard.aatom) },
        }
        result.prepayOutcomes = outcomes
        const temporary = `${resultPath}.${fault.replace(/ /g, '-')}.tmp`
        await fs.writeFile(temporary, JSON.stringify(result, null, 2))
        await fs.rename(temporary, resultPath)
      }
    })
  }

  test('expired paid checkpoint refunds without a second open or provider access', async ({ page }) => {
    test.skip(!expiryEnabled || faultsEnabled, 'requires only the dedicated short-lived native V3 deal')
    test.setTimeout(8 * 60_000)
    expect(dealId).toMatch(/^(?:0|[1-9][0-9]*)$/)
    expect(payer).toMatch(/^nil1[0-9a-z]+$/)
    const context = page.context()
    const diagnostics: RetrievalDiagnostic[] = []
    const evmResponseHashes: string[] = []
    const evmTransactions: JsonObject[] = []
    const evmReceipts: JsonObject[] = []
    const durableStages: string[] = []
    let rawTransactions = 0
    let downloads = 0
    const summary: Record<string, unknown> = {
      success: false, dealId, payer, filePath, expectedBytes, expectedHash, diagnostics,
      evmResponseHashes, evmTransactions, evmReceipts,
      resultDurability: { atomicReplace: true, verifiedStages: durableStages },
    }
    let saved: Promise<void> = Promise.resolve()
    const persist = () => {
      if (!resultPath) return
      const temporary = `${resultPath}.tmp`
      const json = JSON.stringify(summary, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)
      saved = saved.then(() => fs.writeFile(temporary, json)).then(() => fs.rename(temporary, resultPath))
      void saved.catch(() => undefined)
    }
    const durable = async (stage: string) => {
      if (!resultPath) return
      persist()
      await saved
      const retained = JSON.parse(await fs.readFile(resultPath, 'utf8')) as JsonObject
      expect(retained.stage).toBe(stage)
      durableStages.push(stage)
    }
    try {
      const countDownloads = (candidate: Page) => { candidate.on('download', () => { downloads++ }) }
      context.on('page', countDownloads)
      countDownloads(page)
      await context.exposeFunction('__nativeV3ExpiryDiagnostic', (event: RetrievalDiagnostic) => diagnostics.push(event))
      await context.addInitScript(() => {
        const scope = window as unknown as {
          __polystoreRetrievalDiagnostic: (event: unknown) => void
          __nativeV3ExpiryDiagnostic: (event: unknown) => Promise<void>
        }
        scope.__polystoreRetrievalDiagnostic = (event) => { void scope.__nativeV3ExpiryDiagnostic(event) }
      })
      context.on('request', (request) => {
        if (request.method() !== 'POST' || !request.url().startsWith(evm)) return
        try { if ((JSON.parse(request.postData() || '{}') as EvmRpcRequest).method === 'eth_sendRawTransaction') rawTransactions++ }
        catch { /* malformed requests cannot count as financial evidence */ }
      })
      context.on('response', (response: Response) => {
        if (response.request().method() !== 'POST' || !response.url().startsWith(evm)) return
        let request: EvmRpcRequest
        try { request = JSON.parse(response.request().postData() || '{}') as EvmRpcRequest } catch { return }
        if (request.method !== 'eth_sendRawTransaction' || !response.ok()) return
        void response.json().then((body: JsonObject) => {
          if (typeof body.result === 'string' && /^0x[0-9a-f]{64}$/i.test(body.result)) evmResponseHashes.push(body.result)
        }).catch(() => undefined)
      })

      const before = {
        stake: await balance(page, payer, 'stake'), aatom: await balance(page, payer, 'aatom'),
        nonce: await latestNonce(page), deal: await deal(page), height: await latestHeight(page.request),
      }
      const endBlock = BigInt(String(before.deal.end_block || '0'))
      expect(before.deal.owner).not.toBe(payer)
      expect((before.deal.retrieval_policy as JsonObject | undefined)?.mode)
        .toBe('RETRIEVAL_POLICY_MODE_PUBLIC')

      const gatewayUrl = await mountDealDetail(page)
      let abortedDataRequests = 0
      let requestedSessionId = ''
      const abortPaidData = async (route: Route) => {
        const sessionId = route.request().headers()['x-polystore-session-id'] || ''
        if (!sessionId) return route.continue()
        abortedDataRequests++
        requestedSessionId = sessionId
        await route.abort('failed')
      }
      await page.route('**/gateway/mdu/**', abortPaidData)
      await page.route('**/sp/retrieval/mdu/**', abortPaidData)
      const heightBeforeOpen = await latestHeight(page.request)
      const remaining = endBlock - heightBeforeOpen
      expect(remaining).toBeGreaterThanOrEqual(60n)
      expect(remaining).toBeLessThanOrEqual(180n)
      const button = await openDownload(page)
      await button.click()
      await expect.poll(() => readDownloadFailureBanner(page), { timeout: 120_000 })
        .toContain('Download failed:')
      expect(abortedDataRequests).toBe(1)
      expect(downloads).toBe(0)
      expect(requestedSessionId).toMatch(/^0x[0-9a-f]{64}$/i)
      await expect.poll(() => diagnostics.filter((event) => event.phase === 'opened_session').length).toBe(1)
      const openedSession = diagnostics.find((event) => event.phase === 'opened_session')
      expect(openedSession?.sessionId).toBe(requestedSessionId)
      const phaseGuards = {
        openedSessions: diagnostics.filter((event) => event.phase === 'opened_session').length,
        verifiedWrites: diagnostics.filter((event) => event.phase === 'verified_write').length,
        flushedChunks: diagnostics.filter((event) => event.phase === 'flushed').length,
        verifiedChunks: diagnostics.filter((event) => event.phase === 'verified_chunk').length,
        acknowledgedObligations: diagnostics.filter((event) => event.phase === 'acked_obligation').length,
      }
      expect(phaseGuards).toEqual({
        openedSessions: 1, verifiedWrites: 0, flushedChunks: 0, verifiedChunks: 0, acknowledgedObligations: 0,
      })

      const sessionBeforeRefund = await sessionById(page, requestedSessionId)
      expect(sessionBeforeRefund.owner).toBe(payer)
      expect(sessionBeforeRefund.payer).toBe(payer)
      expect(sessionBeforeRefund.funding).toBe('RETRIEVAL_SESSION_FUNDING_REQUESTER')
      expect(BigInt(String(sessionBeforeRefund.locked_fee))).toBeGreaterThan(0n)
      expect(BigInt(String(sessionBeforeRefund.acked_slots_mask))).toBe(0n)
      expect(BigInt(String(sessionBeforeRefund.settled_slots_mask))).toBe(0n)
      expect(BigInt(String(sessionBeforeRefund.refunded_slots_mask))).toBe(0n)
      const localStateBeforeRefund = await unfinishedLocalState(page)
      expect(localStateBeforeRefund).toEqual({
        checkpoints: 1, unbound: 0, journals: [{ state: 'committed', hasHash: true }],
      })
      const afterInterrupted = {
        stake: await balance(page, payer, 'stake'), aatom: await balance(page, payer, 'aatom'),
        nonce: await latestNonce(page), height: await latestHeight(page.request),
      }
      const lockedFee = BigInt(String(sessionBeforeRefund.locked_fee))
      const baseFee = BigInt(String(sessionBeforeRefund.base_fee))
      expect(before.stake - afterInterrupted.stake).toBe(baseFee + lockedFee)
      expect(afterInterrupted.aatom).toBeLessThan(before.aatom)
      expect(afterInterrupted.nonce.found).toBe(true)
      expect(BigInt(afterInterrupted.nonce.nonce)).toBe(BigInt(before.nonce.nonce) + 1n)
      Object.assign(summary, {
        stage: 'interrupted', gatewayUrl, abortedDataRequests, requestedSessionId, sessionBeforeRefund,
        before, heightBeforeOpen, afterInterrupted, localStateBeforeRefund, remainingBlocksAtOpen: remaining, phaseGuards,
      })
      await durable('interrupted')

      await page.close()
      const deadline = BigInt(String(sessionBeforeRefund.deadline_height))
      await expect.poll(() => latestHeight(context.request), { timeout: 4 * 60_000, intervals: [500, 1000] })
        .toBeGreaterThan(deadline)

      const reopened = await context.newPage()
      let retryMduRequests = 0
      const abortRetryMdu = async (route: Route) => {
        retryMduRequests++
        await route.abort('failed')
      }
      await reopened.route('**/gateway/mdu/**', abortRetryMdu)
      await reopened.route('**/sp/retrieval/mdu/**', abortRetryMdu)
      await mountDealDetail(reopened, false)
      const recoveryRow = reopened.getByTestId('deal-detail-file-row').filter({
        has: reopened.getByTestId('v3-frozen-recovery').filter({ hasText: 'Paid recovery' }),
      })
      await expect(recoveryRow).toHaveCount(1)
      const retryMduRequestsBeforeRefund = retryMduRequests
      const recoveryButton = recoveryRow.getByTestId('deal-detail-download')
      await expect(recoveryButton).toBeVisible({ timeout: 120_000 })
      await recoveryButton.click()
      await expect.poll(() => readDownloadFailureBanner(reopened), { timeout: 120_000 })
        .toContain('remaining fee was refunded')
      expect(retryMduRequests).toBe(retryMduRequestsBeforeRefund)
      expect(downloads).toBe(0)
      await expect.poll(() => unfinishedLocalState(reopened)).toEqual({ checkpoints: 0, unbound: 0, journals: [] })

      const session = await sessionById(reopened, requestedSessionId)
      const obligations = session.obligations as JsonObject[]
      const expectedMask = obligations.reduce((mask, row) => mask | (1n << BigInt(String(row.slot))), 0n)
      expect(session.expired).toBe(true)
      expect(BigInt(String(session.locked_fee))).toBe(0n)
      expect(BigInt(String(session.acked_slots_mask))).toBe(0n)
      expect(BigInt(String(session.settled_slots_mask))).toBe(0n)
      expect(BigInt(String(session.refunded_slots_mask))).toBe(expectedMask)
      const afterRefund = {
        stake: await balance(reopened, payer, 'stake'), aatom: await balance(reopened, payer, 'aatom'),
        nonce: await latestNonce(reopened), height: await latestHeight(reopened.request),
      }
      expect(afterRefund.stake).toBe(afterInterrupted.stake + lockedFee)
      expect(afterRefund.stake).toBe(before.stake - baseFee)
      expect(afterRefund.aatom).toBeLessThan(afterInterrupted.aatom)
      expect(afterRefund.nonce).toEqual(afterInterrupted.nonce)
      expect(rawTransactions).toBe(2)
      await expect.poll(() => evmResponseHashes.length).toBe(rawTransactions)
      for (const hash of evmResponseHashes) {
        const transaction = await evmRpc(reopened, 'eth_getTransactionByHash', [hash])
        const receipt = await evmRpc(reopened, 'eth_getTransactionReceipt', [hash])
        expect(transaction && typeof transaction === 'object').toBe(true)
        expect(receipt && typeof receipt === 'object').toBe(true)
        const tx = transaction as JsonObject, committed = receipt as JsonObject
        expect(tx.hash).toBe(hash)
        expect(committed.transactionHash).toBe(hash)
        expect(committed.status).toBe('0x1')
        evmTransactions.push(tx)
        evmReceipts.push(committed)
      }
      Object.assign(summary, {
        success: true, stage: 'refunded', session, afterRefund, rawTransactions,
        retryMduRequests, retryMduRequestsBeforeRefund, strictExpiryObserved: afterRefund.height > deadline,
      })
      await durable('refunded')
    } finally {
      persist()
      await saved
    }
  })

  test('one paid session survives unknown open, authenticated faults and page replacement', async ({ page }) => {
    test.skip(!faultsEnabled || expiryEnabled, 'requires only the dedicated 16 MiB + 1 native V3 deal')
    test.setTimeout(25 * 60_000)
    expect(dealId).toMatch(/^(?:0|[1-9][0-9]*)$/)
    expect(payer).toMatch(/^nil1[0-9a-z]+$/)
    expect(expectedBytes).toBe(16 * 1024 * 1024 + 1)
    expect(expectedHash).toMatch(/^[0-9a-f]{64}$/)

    const context = page.context()
    const diagnostics: Array<RetrievalDiagnostic & { segment: string }> = []
    const evmResponseHashes: string[] = []
    const evmTransactions: JsonObject[] = []
    const evmReceipts: JsonObject[] = []
    const providerProofOutcomes: unknown[] = []
    const mduNetworkRequests: MduRequestCounts = {
      gatewayMetadata: 0, gatewayData: 0, directMetadata: 0, directData: 0,
    }
    const snapshotMduRequests = (): MduRequestCounts => ({ ...mduNetworkRequests })
    const durableStages: string[] = []
    const faultDeliveries = { corrupt: 0, 'multipart-order': 0, truncate: 0 }
    const faultFailures: Record<string, string> = {}
    let segment = 'initial'
    let rawTransactions = 0
    let rawTransactionAttempts = 0
    let unknownOpenRaw = ''
    let unknownOpenHash = ''
    let holdAckEstimate = false
    let heldAckEstimate = false
    let releaseHeldAck: (() => void) | undefined
    let activePage = page
    let faultMode: 'corrupt' | 'multipart-order' | 'truncate' | 'pass' = 'corrupt'
    let planned: V3CheckpointObservation | undefined
    let targetChunk: V3PlannedChunk | undefined
    let targetT = ''
    let targetBlob = -1
    let dataRequests = 0
    let targetRequests = 0
    const summary: Record<string, unknown> = {
      success: false, dealId, payer, filePath, expectedBytes, expectedHash, diagnostics,
      evmResponseHashes, evmTransactions, evmReceipts, providerProofOutcomes, faultDeliveries,
      resultDurability: { atomicReplace: true, verifiedStages: durableStages },
    }
    let saved: Promise<void> = Promise.resolve()
    const persist = () => {
      if (!resultPath) return
      const temporary = `${resultPath}.tmp`
      const json = JSON.stringify(summary, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)
      saved = saved.then(() => fs.writeFile(temporary, json)).then(() => fs.rename(temporary, resultPath))
      void saved.catch(() => undefined)
    }
    const durable = async (stage: string) => {
      Object.assign(summary, { stage })
      if (!resultPath) return
      persist()
      await saved
      const retained = JSON.parse(await fs.readFile(resultPath, 'utf8')) as JsonObject
      expect(retained.stage).toBe(stage)
      durableStages.push(stage)
    }

    await context.exposeFunction('__nativeV3FaultDiagnostic', (event: RetrievalDiagnostic) => {
      diagnostics.push({ ...event, segment })
    })
    await context.addInitScript(() => {
      const scope = window as unknown as {
        __polystoreRetrievalDiagnostic: (event: unknown) => void
        __nativeV3FaultDiagnostic: (event: unknown) => Promise<void>
      }
      scope.__polystoreRetrievalDiagnostic = (event) => { void scope.__nativeV3FaultDiagnostic(event) }
    })
    context.on('response', (response: Response) => {
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

    await context.route(evm, async (route) => {
      const request = route.request()
      if (request.method() !== 'POST') return route.continue()
      let rpc: EvmRpcRequest
      try { rpc = JSON.parse(request.postData() || '{}') as EvmRpcRequest } catch { return route.continue() }
      if (rpc.method === 'eth_estimateGas' && holdAckEstimate) {
        holdAckEstimate = false
        heldAckEstimate = true
        await new Promise<void>((resolve) => { releaseHeldAck = resolve })
        await route.abort('failed').catch(() => undefined)
        return
      }
      if (rpc.method !== 'eth_sendRawTransaction') return route.continue()
      rawTransactionAttempts++
      const raw = typeof rpc.params?.[0] === 'string' ? rpc.params[0] : ''
      expect(raw).toMatch(/^0x[0-9a-f]+$/i)
      if (unknownOpenRaw && raw === unknownOpenRaw) {
        await route.abort('failed')
        return
      }
      rawTransactions++
      const upstream = await route.fetch()
      const body = await upstream.body()
      const payload = JSON.parse(body.toString()) as JsonObject
      expect(payload.error).toBeUndefined()
      expect(payload.result).toMatch(/^0x[0-9a-f]{64}$/i)
      const hash = String(payload.result)
      evmResponseHashes.push(hash)
      if (!unknownOpenRaw) {
        unknownOpenRaw = raw
        unknownOpenHash = hash
        await route.abort('failed')
        return
      }
      await route.fulfill({ response: upstream, body })
    })

    const mutateTarget = async (route: Route) => {
      const request = route.request(), headers = request.headers()
      const path = new URL(request.url()).pathname
      const sessionId = headers['x-polystore-session-id'] || ''
      const direct = path.startsWith('/sp/retrieval/mdu/')
      if (direct && sessionId) mduNetworkRequests.directData++
      else if (direct) mduNetworkRequests.directMetadata++
      else if (sessionId) mduNetworkRequests.gatewayData++
      else mduNetworkRequests.gatewayMetadata++
      if (!sessionId) return route.continue()
      dataRequests++
      if (!planned) {
        planned = await observeV3Checkpoint(activePage)
        expect(planned.population).toBe('133')
        expect(planned.sampleCount).toBe('132')
        expect(planned.unsampled).toHaveLength(1)
        expect(planned.chunks).toHaveLength(21)
        targetT = planned.unsampled[0]
        targetChunk = planned.chunks.find((chunk) => chunk.entries.includes(targetT))
        if (!targetChunk) throw new Error('unsampled coordinate has no planned v3 chunk')
        targetBlob = targetChunk.entries.indexOf(targetT)
      }
      expect(sessionId).toBe(planned.sessionId)
      const url = new URL(request.url())
      const mduIndex = url.pathname.split('/').filter(Boolean).at(-1)
      const isTarget = headers['x-polystore-slot'] === String(targetChunk!.slot) &&
        headers['x-polystore-start-blob-index'] === String(targetChunk!.startBlobIndex) && mduIndex === targetChunk!.mduIndex
      if (!isTarget) return route.continue()
      targetRequests++
      if (faultMode === 'pass') return route.continue()
      faultDeliveries[faultMode]++
      const upstream = await route.fetch()
      const body = await upstream.body()
      const contentType = upstream.headers()['content-type'] || ''
      const mutated = mutateV3Multipart(body, contentType, faultMode, targetBlob)
      await route.fulfill({ response: upstream, body: mutated })
    }
    await context.route('**/gateway/mdu/**', mutateTarget)
    await context.route('**/sp/retrieval/mdu/**', mutateTarget)

    try {
      const before = {
        stake: await balance(page, payer, 'stake'), aatom: await balance(page, payer, 'aatom'),
        nonce: await latestNonce(page), deal: await deal(page),
      }
      expect(before.deal.owner).not.toBe(payer)
      expect((before.deal.retrieval_policy as JsonObject | undefined)?.mode)
        .toBe('RETRIEVAL_POLICY_MODE_PUBLIC')
      const gatewayUrl = await mountDealDetail(page)
      const initialButton = await openDownload(page)
      await initialButton.click()
      const unknownFailure = await waitForRetrievalFailure(page)
      expect(unknownOpenHash).toMatch(/^0x[0-9a-f]{64}$/i)
      expect(rawTransactions).toBe(1)
      expect(rawTransactionAttempts).toBeGreaterThanOrEqual(rawTransactions)
      expect(evmResponseHashes).toEqual([unknownOpenHash])
      await expect.poll(() => unfinishedLocalState(page)).toEqual({
        checkpoints: 1, unbound: 1, journals: [{ state: 'broadcasting', hasHash: false }],
      })
      const includedNonce = (BigInt(before.nonce.nonce) + 1n).toString()
      await expect.poll(async () => (await latestNonce(page)).nonce, { timeout: 120_000 }).toBe(includedNonce)
      await expect.poll(async () => (await balance(page, payer, 'stake')) < before.stake, { timeout: 120_000 }).toBe(true)
      const afterUnknown = {
        stake: await balance(page, payer, 'stake'), aatom: await balance(page, payer, 'aatom'),
        nonce: await latestNonce(page),
      }
      expect(afterUnknown.stake).toBeLessThan(before.stake)
      expect(afterUnknown.aatom).toBeLessThan(before.aatom)
      expect(afterUnknown.nonce).toEqual({ found: true, nonce: includedNonce })
      Object.assign(summary, { stage: 'unknown-open', before, afterUnknown, gatewayUrl, unknownFailure, unknownOpenHash,
        rawTransactions, rawTransactionAttempts })
      await durable('unknown-open')

      const recoveryButton = () => activePage.locator(
        `[data-testid="deal-detail-download"][data-file-path="${filePath}"]`,
      ).last()
      const faultSnapshots: Record<string, V3CheckpointObservation> = {}
      for (const kind of ['corrupt', 'multipart-order', 'truncate'] as const) {
        segment = kind
        faultMode = kind
        await expect(recoveryButton()).toBeVisible({ timeout: 120_000 })
        await recoveryButton().click()
        await expect.poll(() => faultDeliveries[kind], { timeout: 120_000 }).toBeGreaterThan(0)
        await expect(recoveryButton()).toBeEnabled({ timeout: 120_000 })
        faultFailures[kind] = await waitForRetrievalFailure(activePage)
        expect(faultFailures[kind]).toMatch(kind === 'corrupt' ? /integrity verification/i : /multipart/i)
        const snapshot = await observeV3Checkpoint(activePage)
        faultSnapshots[kind] = snapshot
        expect(snapshot.sessionId).toBe(planned!.sessionId)
        expect(snapshot.nonce).toBe(planned!.nonce)
        const targetPosition = planned!.chunks.indexOf(targetChunk!)
        const previous = planned!.chunks.slice(0, targetPosition).filter((chunk) => chunk.slot === targetChunk!.slot).at(-1)
        expect(snapshot.cursors[String(targetChunk!.slot)] || '-1')
          .toBe(previous?.entries.at(-1) || '-1')
        expect(snapshot.ackedMask & (1 << targetChunk!.slot)).toBe(0)
        expect(snapshot.settledMask & (1 << targetChunk!.slot)).toBe(0)
        expect(diagnostics.some((event) => event.chunkId === targetChunk!.id &&
          ['verified_write', 'flushed', 'verified_chunk'].includes(event.phase))).toBe(false)
        expect(diagnostics.some((event) => event.phase === 'acked_obligation' && event.slot === targetChunk!.slot)).toBe(false)
        expect(rawTransactions).toBe(1 + diagnostics.filter((event) => event.phase === 'acked_obligation').length)
        expect((await latestNonce(activePage)).nonce).toBe(afterUnknown.nonce.nonce)
        Object.assign(summary, { stage: kind, planned, targetT, targetChunk, targetBlob, faultSnapshots, faultFailures,
          dataRequests, targetRequests })
        await durable(kind)
      }

      segment = 'durable-before-reopen'
      faultMode = 'pass'
      holdAckEstimate = true
      await recoveryButton().click()
      await expect.poll(() => heldAckEstimate, { timeout: 180_000 }).toBe(true)
      const durableCheckpoint = await observeV3Checkpoint(activePage)
      const targetSlotEnd = planned!.chunks.filter((chunk) => chunk.slot === targetChunk!.slot).at(-1)!.entries.at(-1)!
      expect(durableCheckpoint.cursors[String(targetChunk!.slot)]).toBe(targetSlotEnd)
      expect(durableCheckpoint.ackedMask & (1 << targetChunk!.slot)).toBe(0)
      expect(diagnostics.some((event) => event.phase === 'verified_chunk' && event.chunkId === targetChunk!.id)).toBe(true)
      const requestsBeforeReopen = { data: dataRequests, target: targetRequests }
      Object.assign(summary, { stage: 'durable-before-reopen', durableCheckpoint, requestsBeforeReopen })
      await durable('durable-before-reopen')

      const closing = activePage.close()
      releaseHeldAck?.()
      await closing
      segment = 'reopened'
      activePage = await context.newPage()
      await mountDealDetail(activePage, false)
      await expect(recoveryButton()).toBeVisible({ timeout: 120_000 })
      const [download] = await Promise.all([
        waitForDownloadEventOrFailure(activePage, 10 * 60_000, await readDownloadFailureBanner(activePage)),
        recoveryButton().click(),
      ])
      const downloaded = await hashDownload(download)
      await download.delete()
      expect(downloaded).toEqual({ bytes: expectedBytes, sha256: expectedHash })
      expect(targetRequests).toBe(requestsBeforeReopen.target)

      const session = await sessionById(activePage, planned!.sessionId)
      const obligations = session.obligations as JsonObject[]
      const expectedMask = obligations.reduce((mask, row) => mask | (1n << BigInt(String(row.slot))), 0n)
      expect(BigInt(String(session.acked_slots_mask))).toBe(expectedMask)
      expect(BigInt(String(session.settled_slots_mask))).toBe(expectedMask)
      expect(BigInt(String(session.refunded_slots_mask))).toBe(0n)
      expect(BigInt(String(session.locked_fee))).toBe(0n)
      expect(rawTransactions).toBe(1 + obligations.length)
      expect(rawTransactionAttempts).toBeGreaterThanOrEqual(rawTransactions)
      expect(evmResponseHashes).toHaveLength(rawTransactions)
      expect(new Set(evmResponseHashes).size).toBe(rawTransactions)
      expect(evmResponseHashes[0]).toBe(unknownOpenHash)
      for (const hash of evmResponseHashes) {
        const transaction = await evmRpc(activePage, 'eth_getTransactionByHash', [hash])
        const receipt = await evmRpc(activePage, 'eth_getTransactionReceipt', [hash])
        expect(transaction && typeof transaction === 'object').toBe(true)
        expect(receipt && typeof receipt === 'object').toBe(true)
        const tx = transaction as JsonObject, committed = receipt as JsonObject
        expect(tx.hash).toBe(hash)
        expect(committed.transactionHash).toBe(hash)
        expect(committed.status).toBe('0x1')
        evmTransactions.push(tx)
        evmReceipts.push(committed)
      }
      const obligationSlots = obligations.map((row) => Number(row.slot)).sort((a, b) => a - b)
      await expect.poll(() => proofOutcomeSlots(providerProofOutcomes)).toEqual(obligationSlots)
      for (const observed of providerProofOutcomes) {
        const row = observed as JsonObject, body = row.body as JsonObject, timing = body.timing as JsonObject
        expect(row.txHash).toMatch(/^[0-9a-f]{64}$/i)
        expect(String(body.session_id)).toMatch(/^0x[0-9a-f]{64}$/i)
        expect(String(body.session_id).slice(2).toLowerCase()).toBe(planned!.sessionId.slice(2).toLowerCase())
        expect(Number(body.slot)).toBeGreaterThanOrEqual(0)
        expect(Number(body.proof_count)).toBeGreaterThan(0)
        expect(timing.schema).toBe('polystore-v3-provider-timing-v1')
        expect(Array.isArray(timing.submission_attempts)).toBe(true)
        expect((timing.submission_attempts as unknown[]).length).toBeGreaterThan(0)
      }
      const variableFee = obligations.reduce((sum, row) =>
        sum + BigInt(String(row.blob_count)) * BigInt(String(session.price_per_blob)), 0n)
      const chargedStake = BigInt(String(session.base_fee)) + variableFee
      const after = {
        stake: await balance(activePage, payer, 'stake'), aatom: await balance(activePage, payer, 'aatom'),
        nonce: await latestNonce(activePage),
      }
      expect(before.stake - after.stake).toBe(chargedStake)
      expect(after.aatom).toBeLessThan(before.aatom)
      expect(after.nonce).toEqual(afterUnknown.nonce)
      await expect.poll(() => unfinishedLocalState(activePage)).toEqual({ checkpoints: 1, unbound: 0, journals: [] })

      const requestsBeforeCache = { data: dataRequests, target: targetRequests, raw: rawTransactions }
      const cacheMduRequests = { before: snapshotMduRequests(), after: snapshotMduRequests() }
      const cacheButton = activePage.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`).first()
      const [cachedDownload] = await Promise.all([
        waitForDownloadEventOrFailure(activePage, 120_000, await readDownloadFailureBanner(activePage)), cacheButton.click(),
      ])
      const cached = await hashDownload(cachedDownload)
      await cachedDownload.delete()
      cacheMduRequests.after = snapshotMduRequests()
      expect(cached).toEqual(downloaded)
      expect(cacheMduRequests.after).toEqual(cacheMduRequests.before)
      expect({ data: dataRequests, target: targetRequests, raw: rawTransactions }).toEqual(requestsBeforeCache)
      const phaseGuards = {
        openedSessions: diagnostics.filter((event) => event.phase === 'opened_session').length,
        acknowledgedObligations: diagnostics.filter((event) => event.phase === 'acked_obligation').length,
        targetVerifiedChunks: diagnostics.filter((event) => event.phase === 'verified_chunk' && event.chunkId === targetChunk!.id).length,
      }
      expect(phaseGuards).toEqual({ openedSessions: 1, acknowledgedObligations: obligations.length, targetVerifiedChunks: 1 })
      Object.assign(summary, {
        success: true, stage: 'settled-cache', session, before, afterUnknown, after, rawTransactions,
        rawTransactionAttempts,
        downloaded, cached, chargedStake: String(chargedStake), requestsBeforeCache, dataRequests, targetRequests,
        cacheMduRequests, paidDiagnosticCount: diagnostics.length, phaseGuards,
        localState: await unfinishedLocalState(activePage),
      })
      await durable('settled-cache')
    } finally {
      releaseHeldAck?.()
      persist()
      await saved
    }
  })
})
