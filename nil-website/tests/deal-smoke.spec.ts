/* eslint-disable @typescript-eslint/no-explicit-any */import { test, expect } from '@playwright/test'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'
import { buildRetrievalRequestTypedData } from '../src/lib/eip712'
import { planNilfsFileRangeChunks } from '../src/lib/rangeChunker'

const path = process.env.E2E_PATH || '/#/dashboard'
const gatewayBase = process.env.E2E_GATEWAY_BASE || 'http://localhost:8080'
const lcdBase = process.env.E2E_LCD_BASE || 'http://localhost:1317'

test('deal lifecycle smoke (connect → fund → create → upload → commit → explore → fetch)', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000)

  await page.goto(path)

  await page.getByTestId('connect-wallet').click()
  await expect(page.getByTestId('wallet-address')).toBeVisible()
  await expect(page.getByTestId('cosmos-identity')).toContainText('nil1')
  const owner = (await page.getByTestId('cosmos-identity').textContent())?.trim() || ''
  expect(owner).toMatch(/^nil1/i)

  await page.getByTestId('faucet-request').click()
  await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText('—', { timeout: 90_000 })

  await page.getByTestId('alloc-submit').click()
  await page.getByTestId('tab-content').click()

  const dealSelect = page.getByTestId('content-deal-select')
  await expect(dealSelect).not.toHaveValue('', { timeout: 60_000 })
  const dealId = await dealSelect.inputValue()

  const filePath = 'e2e.txt'
  const fileBytes = Buffer.alloc(1024 * 1024, 'A')

  await page.getByTestId('content-file-input').setInputFiles({
    name: filePath,
    mimeType: 'text/plain',
    buffer: fileBytes,
  })

  const stagedManifestRoot = page.getByTestId('staged-manifest-root')
  await expect(stagedManifestRoot).toHaveText(/^0x[0-9a-f]{96}$/i, { timeout: 180_000 })
  const manifestRoot = (await stagedManifestRoot.textContent())?.trim() || ''
  expect(manifestRoot).toMatch(/^0x[0-9a-f]{96}$/i)

  const stagedSizeText = (await page.getByTestId('staged-total-size').textContent())?.trim() || ''
  expect(Number(stagedSizeText)).toBeGreaterThan(0)

  const dealManifestCell = page.getByTestId(`deal-manifest-${dealId}`)
  await expect(dealManifestCell).toHaveAttribute('title', manifestRoot, { timeout: 120_000 })

  const dealSizeCell = page.getByTestId(`deal-size-${dealId}`)
  await expect(dealSizeCell).not.toHaveText('—', { timeout: 120_000 })

  const dealSizeMb = Number.parseFloat((await dealSizeCell.textContent()) || '0')
  expect(dealSizeMb).toBeGreaterThan(0)

  // Directly hit the gateway to measure /gateway/fetch performance.
  // Hard timeout: 20s; target proof generation < 1s.
  const e2ePk = (process.env.VITE_E2E_PK ||
    '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1') as Hex
  const account = privateKeyToAccount(e2ePk)
  const reqNonce = 1
  const reqExpiresAt = Math.floor(Date.now() / 1000) + 120
  const reqTypedData = buildRetrievalRequestTypedData(
    {
      deal_id: Number(dealId),
      file_path: filePath,
      range_start: 0,
      range_len: 0,
      nonce: reqNonce,
      expires_at: reqExpiresAt,
    },
    Number(process.env.CHAIN_ID || 31337),
  )
  const reqSig = await account.signTypedData({
    ...reqTypedData,
    domain: { ...reqTypedData.domain, chainId: BigInt(reqTypedData.domain.chainId) },
  } as any)

  const fetchUrl = `${gatewayBase}/gateway/fetch/${encodeURIComponent(manifestRoot)}?deal_id=${encodeURIComponent(
    dealId,
  )}&owner=${encodeURIComponent(owner)}&file_path=${encodeURIComponent(filePath)}`
  const perfStart = Date.now()
  const perfResp = await request.get(fetchUrl, {
    timeout: 20_000,
    headers: {
      'X-Nil-Req-Sig': reqSig,
      'X-Nil-Req-Nonce': String(reqNonce),
      'X-Nil-Req-Expires-At': String(reqExpiresAt),
      'X-Nil-Req-Range-Start': '0',
      'X-Nil-Req-Range-Len': '0',
    },
  })
  const perfElapsedMs = Date.now() - perfStart
  expect(perfResp.status()).toBe(200)
  expect(perfElapsedMs).toBeLessThan(20_000)
  const proofMsRaw = perfResp.headers()['x-nil-gateway-proof-ms']
  expect(proofMsRaw).toBeTruthy()
  const proofMs = Number(proofMsRaw)
  expect(Number.isFinite(proofMs)).toBeTruthy()
  expect(proofMs).toBeLessThan(1_000)
  const perfBody = await perfResp.body()
  expect(Buffer.from(perfBody)).toEqual(fileBytes)

  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('deal-detail')).toBeVisible()

  const fileRow = page.locator('[data-testid="deal-detail-file-row"][data-file-path="e2e.txt"]')
  await expect(fileRow).toBeVisible({ timeout: 120_000 })

  // Trigger download via UI to exercise client-side signing
  const downloadPromise = page.waitForEvent('download', { timeout: 240_000 })
  await page.locator('[data-testid="deal-detail-download"][data-file-path="e2e.txt"]').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(filePath)

  const stream = await download.createReadStream()
  const downloadedBytes = await streamToBuffer(stream)
  expect(downloadedBytes).toEqual(fileBytes)

  // Compute expected chunk count for a full-file download (default UI behavior now uses
  // range-chunked fetches to ensure each receipt/proof corresponds to a single blob/MDU window).
  const slabResp = await request.get(
    `${gatewayBase}/gateway/slab/${encodeURIComponent(manifestRoot)}?deal_id=${encodeURIComponent(dealId)}&owner=${encodeURIComponent(
      owner,
    )}`,
  )
  expect(slabResp.ok()).toBeTruthy()
  const slabJson: any = await slabResp.json().catch(() => null)
  const listResp = await request.get(
    `${gatewayBase}/gateway/list-files/${encodeURIComponent(
      manifestRoot,
    )}?deal_id=${encodeURIComponent(dealId)}&owner=${encodeURIComponent(owner)}`,
  )
  expect(listResp.ok()).toBeTruthy()
  const listJson: any = await listResp.json().catch(() => null)
  const files: any[] = listJson?.files || []
  const entry = files.find((f) => f?.path === filePath)
  expect(entry).toBeTruthy()
  const expectedChunks = planNilfsFileRangeChunks({
    fileStartOffset: Number(entry.start_offset),
    fileSizeBytes: Number(entry.size_bytes),
    rangeStart: 0,
    rangeLen: Number(entry.size_bytes),
    mduSizeBytes: Number(slabJson?.mdu_size_bytes || 8 * 1024 * 1024),
    blobSizeBytes: Number(slabJson?.blob_size_bytes || 128 * 1024),
  }).length
  expect(expectedChunks).toBeGreaterThanOrEqual(1)

  // Verify Retrieval Count increment (one proof per chunk)
  await page.getByTestId('deal-detail-close').click()
  const retrievalsCell = page.getByTestId(`deal-retrievals-${dealId}`)
  await expect(retrievalsCell).toHaveText(String(expectedChunks), { timeout: 120_000 })

  // Verify on-chain DealHeatState incremented (successful_retrievals_total + bytes_served_total)
  const heatUrl = `${lcdBase}/nilchain/nilchain/v1/deals/${encodeURIComponent(dealId)}/heat`
  let heatOk = false
  for (let i = 0; i < 20; i++) {
    const heatResp = await request.get(heatUrl)
    if (heatResp.ok()) {
      const json: any = await heatResp.json().catch(() => null)
      const heat = json?.heat
      const retrievals = Number(heat?.successful_retrievals_total || 0)
      const bytesServed = Number(heat?.bytes_served_total || 0)
      if (retrievals >= expectedChunks && bytesServed >= fileBytes.length) {
        heatOk = true
        break
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  expect(heatOk).toBeTruthy()
})

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
