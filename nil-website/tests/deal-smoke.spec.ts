/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { planNilfsFileRangeChunks } from '../src/lib/rangeChunker'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { type Hex } from 'viem'

const path = process.env.E2E_PATH || '/#/dashboard'
const gatewayBase = process.env.E2E_GATEWAY_BASE || 'http://localhost:8080'
const lcdBase = process.env.E2E_LCD_BASE || 'http://localhost:1317'

type SlabLayoutResponse = {
  mdu_size_bytes?: number
  blob_size_bytes?: number
}

type ListFilesResponse = {
  files?: Array<{ path?: string; size_bytes?: number; start_offset?: number }>
}

type DealHeatResponse = {
  heat?: {
    successful_retrievals_total?: number | string
    bytes_served_total?: number | string
  }
}

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('deal lifecycle smoke (connect → fund → create → upload → commit → explore → fetch)', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000)

  // Setup Mock Wallet
  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 31337)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)

  console.log(`Using random E2E wallet: ${account.address} -> ${nilAddress}`)

  // Inject Wallet
  await page.addInitScript(({ address, chainIdHex }) => {
    const w = window as any
    if (w.ethereum) return

    w.ethereum = {
      isMetaMask: true,
      isNilStoreE2E: true,
      selectedAddress: address,
      on: () => {},
      removeListener: () => {},
      async request(args: any) {
        const method = args?.method
        switch (method) {
          case 'eth_requestAccounts': return [address]
          case 'eth_accounts': return [address]
          case 'eth_chainId': return chainIdHex
          case 'net_version': return String(parseInt(chainIdHex, 16))
          case 'eth_sendTransaction': return '0x' + '11'.repeat(32) // Dummy tx
          default: return null
        }
      },
    }
    const announceProvider = () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: { uuid: 'test-uuid-smoke', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
          provider: w.ethereum
        }
      }))
    }
    window.addEventListener('eip6963:requestProvider', announceProvider)
    announceProvider()
  }, { address: account.address, chainIdHex })

  await page.goto(path)

  await page.getByTestId('connect-wallet').first().click({ force: true })
  await expect(page.getByTestId('wallet-address')).toBeVisible()
  
  // The dashboard shows truncated address or name?
  // It shows 'nil1...' if mapped? Wait, wallet connects with ETH address.
  // The dashboard converts it to nil address.
  // We check for 'nil1' prefix.
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

  // Load slab + file table to choose a per-blob range (NilFS file offsets may not be blob-aligned).
  const fetchBaseUrl = `${gatewayBase}/gateway/fetch/${encodeURIComponent(manifestRoot)}?deal_id=${encodeURIComponent(
    dealId,
  )}&owner=${encodeURIComponent(owner)}&file_path=${encodeURIComponent(filePath)}`

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

  // Compute chunk plan (default UI behavior uses range-chunked fetches so each receipt/proof corresponds to a single blob).
  const slabResp = await request.get(
    `${gatewayBase}/gateway/slab/${encodeURIComponent(manifestRoot)}?deal_id=${encodeURIComponent(dealId)}&owner=${encodeURIComponent(
      owner,
    )}`,
  )
  expect(slabResp.ok()).toBeTruthy()
  const slabJson = (await slabResp.json().catch(() => null)) as SlabLayoutResponse | null
  const listResp = await request.get(
    `${gatewayBase}/gateway/list-files/${encodeURIComponent(
      manifestRoot,
    )}?deal_id=${encodeURIComponent(dealId)}&owner=${encodeURIComponent(owner)}`,
  )
  expect(listResp.ok()).toBeTruthy()
  const listJson = (await listResp.json().catch(() => null)) as ListFilesResponse | null
  const files = Array.isArray(listJson?.files) ? listJson!.files! : []
  const entry = files.find((f) => f?.path === filePath)
  expect(entry).toBeTruthy()
  const chunkPlan = planNilfsFileRangeChunks({
    fileStartOffset: Number(entry?.start_offset || 0),
    fileSizeBytes: Number(entry?.size_bytes || 0),
    rangeStart: 0,
    rangeLen: Number(entry?.size_bytes || 0),
    mduSizeBytes: Number(slabJson?.mdu_size_bytes || 8 * 1024 * 1024),
    blobSizeBytes: Number(slabJson?.blob_size_bytes || 128 * 1024),
  })
  const expectedChunks = chunkPlan.length
  expect(expectedChunks).toBeGreaterThanOrEqual(1)

  // Directly hit the gateway to measure /gateway/fetch performance.
  // Hard timeout: 20s; target proof generation < 1s for a single chunk.
  const first = chunkPlan[0]
  const end = first.rangeStart + first.rangeLen - 1
  const perfStart = Date.now()
  const perfResp = await request.get(fetchBaseUrl, {
    timeout: 20_000,
    headers: {
      Range: `bytes=${first.rangeStart}-${end}`,
    },
  })
  const perfElapsedMs = Date.now() - perfStart
  expect(perfResp.status()).toBe(206)
  expect(perfElapsedMs).toBeLessThan(20_000)
  const proofMsRaw = perfResp.headers()['x-nil-gateway-proof-ms']
  expect(proofMsRaw).toBeTruthy()
  const proofMs = Number(proofMsRaw)
  expect(Number.isFinite(proofMs)).toBeTruthy()
  expect(proofMs).toBeLessThan(1_000)
  const perfBody = await perfResp.body()
  expect(Buffer.from(perfBody)).toEqual(fileBytes.subarray(first.rangeStart, first.rangeStart + first.rangeLen))

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
      const json = (await heatResp.json().catch(() => null)) as DealHeatResponse | null
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