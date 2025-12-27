/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { bech32 } from 'bech32'

const path = process.env.E2E_PATH || '/#/dashboard'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('Deal Explorer: manifest + mdu commitments fall back to OPFS when gateway missing slab', async ({ page }) => {
  test.setTimeout(300_000)

  const dealId = '1'
  const ethAddress = '0x' + '11'.repeat(20)
  const nilAddress = ethToNil(ethAddress)
  const chainId = Number(process.env.CHAIN_ID || 31337)
  const chainIdHex = `0x${chainId.toString(16)}`
  const manifestRoot = `0x${'cc'.repeat(48)}`
  const filePath = 'opfs.txt'
  const fileSize = 1024

  await page.route('**/nilchain/nilchain/v1/deals**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        deals: [
          {
            id: dealId,
            owner: nilAddress,
            cid: manifestRoot,
            size: String(24 * 1024 * 1024),
            escrow_balance: '1000000',
            end_block: '1000',
            providers: ['nil1provider'],
          },
        ],
      }),
    })
  })

  await page.route('**/cosmos/bank/v1beta1/balances/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ balances: [{ denom: 'stake', amount: '1000' }], pagination: { total: '1' } }),
    })
  })

  // Gateway has no slab; list-files empty to force OPFS file parsing.
  await page.route('**/gateway/slab/**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'slab not found on disk' }),
    })
  })
  await page.route('**/gateway/list-files/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ files: [] }),
    })
  })

  // These endpoints fail on gateway; Deal Explorer should compute from OPFS instead.
  await page.route('**/gateway/manifest-info/**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'slab not found on disk' }),
    })
  })
  await page.route('**/gateway/mdu-kzg/**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'slab not found on disk' }),
    })
  })

  // Minimal injected wallet so the dashboard shows deals.
  await page.addInitScript(({ address, chainIdHex }) => {
    const w = window as any
    if (w.ethereum) return
    w.ethereum = {
      isMetaMask: true,
      selectedAddress: address,
      on: () => {},
      removeListener: () => {},
      async request(args: any) {
        const method = args?.method
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [address]
          case 'eth_chainId':
            return chainIdHex
          case 'net_version':
            return String(parseInt(chainIdHex, 16))
          default:
            return null
        }
      },
    }
    const announceProvider = () => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { uuid: 'test-uuid-manifest-opfs', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
            provider: w.ethereum,
          },
        }),
      )
    }
    window.addEventListener('eip6963:requestProvider', announceProvider)
    announceProvider()
  }, { address: ethAddress, chainIdHex })

  await page.route('**://localhost:8545/**', async (route) => {
    let payload: any = null
    try {
      payload = JSON.parse(route.request().postData() || 'null')
    } catch {
      payload = null
    }
    const method = payload?.method
    if (method === 'eth_chainId') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: chainIdHex }),
      })
    }
    if (method === 'eth_blockNumber') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: '0x1' }),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }),
    })
  })

  await page.goto(path)

  if (!(await page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first().isVisible())) {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.locator('[data-testid="wallet-address"], [data-testid="wallet-address-full"]').first()).toBeVisible()
  }

  // Seed OPFS with a minimal NilFS MDU0 + 1 witness + 1 user MDU.
  await page.evaluate(async ({ dealId, manifestRoot, filePath, fileSize }) => {
    const MDU_SIZE_BYTES = 8 * 1024 * 1024
    const BLOB_SIZE_BYTES = 128 * 1024
    const FILE_TABLE_START = 16 * BLOB_SIZE_BYTES
    const FILE_TABLE_HEADER_SIZE = 128

    const root = await navigator.storage.getDirectory()
    try {
      await (root as any).removeEntry(`deal-${dealId}`, { recursive: true })
    } catch {
      // ignore
    }
    const dealDir = await root.getDirectoryHandle(`deal-${dealId}`, { create: true })

    const writeFile = async (name: string, bytes: Uint8Array | string) => {
      const h = await dealDir.getFileHandle(name, { create: true })
      const w = await (h as any).createWritable()
      await w.write(bytes as any)
      await w.close()
    }

    // manifest_root.txt
    await writeFile('manifest_root.txt', manifestRoot)

    // mdu_0.bin with a single file record.
    const mdu0 = new Uint8Array(MDU_SIZE_BYTES)
    const view = new DataView(mdu0.buffer)
    mdu0.set(new TextEncoder().encode('NILF'), FILE_TABLE_START)
    view.setUint32(FILE_TABLE_START + 8, 1, true)
    const rec0 = FILE_TABLE_START + FILE_TABLE_HEADER_SIZE
    view.setBigUint64(rec0 + 0, 0n, true) // start_offset
    const lengthAndFlags = (BigInt(fileSize) & 0x00ff_ffff_ffff_ffffn) | (0n << 56n)
    view.setBigUint64(rec0 + 8, lengthAndFlags, true)
    const pathBytes = new TextEncoder().encode(filePath)
    mdu0.set(pathBytes.slice(0, 40), rec0 + 24)
    await writeFile('mdu_0.bin', mdu0)

    await writeFile('mdu_1.bin', new Uint8Array(MDU_SIZE_BYTES))
    await writeFile('mdu_2.bin', new Uint8Array(MDU_SIZE_BYTES))
  }, { dealId, manifestRoot, filePath, fileSize })

  await page.getByTestId(`deal-row-${dealId}`).click()
  await expect(page.getByTestId('deal-detail')).toBeVisible({ timeout: 60_000 })

  await page.getByTestId('deal-detail-tab-manifest').click()

  // Slab layout should be inferred from OPFS.
  await expect(page.getByText('Source: browser (OPFS)')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('No manifest details available yet.')).not.toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('slab not found on disk')).not.toBeVisible({ timeout: 60_000 })

  // MDU inspector should be able to compute commitments locally too.
  await page.getByText('Load Commitments').click()
  await expect(page.getByText('Blob Commitments', { exact: true })).toBeVisible({ timeout: 120_000 })
})
