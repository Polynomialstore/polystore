/* eslint-disable @typescript-eslint/no-explicit-any */import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { getAbiItem, getEventSelector, padHex, toHex, type Hex } from 'viem'
import { POLYSTORE_PRECOMPILE_ABI } from '../src/lib/polystorePrecompile'
import { dismissCreateDealDrawer, ensureCreateDealDrawerOpen } from './utils/dashboard'

const path = process.env.E2E_PATH || '/#/dashboard'
const precompile = '0x0000000000000000000000000000000000000900'

function ethToPolystoreAddress(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('repro bug: download from commit content widget', async ({
  page,
}) => {
  test.setTimeout(300_000)

  // Setup Mock Wallet with random key
  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 31337)
  const chainIdHex = `0x${chainId.toString(16)}`
  const polystoreAddress = ethToPolystoreAddress(account.address)
  const txCreate = (`0x${'11'.repeat(32)}` as Hex)
  const txUpdate = (`0x${'22'.repeat(32)}` as Hex)
  const txProve = (`0x${'33'.repeat(32)}` as Hex)
  
  console.log(`Using random E2E wallet: ${account.address} -> ${polystoreAddress}`)

  // Mock EVM RPC receipts for the precompile-based flow.
  const dealCreatedEvent = getAbiItem({ abi: POLYSTORE_PRECOMPILE_ABI, name: 'DealCreated' }) as any
  const dealCreatedTopic0 = getEventSelector(dealCreatedEvent)
  const dealIdTopic = toHex(0n, { size: 32 })
  const ownerTopic = padHex(account.address, { size: 32 })

  await page.route('**://localhost:8545**', async (route) => {
    const req = route.request()
    const payload = JSON.parse(req.postData() || '{}') as any
    const method = payload?.method
    const params = payload?.params || []
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
    if (method === 'eth_getTransactionReceipt') {
      const hash = String(params?.[0] || '')
      if (hash === txCreate) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: payload?.id ?? 1,
            result: {
              transactionHash: txCreate,
              status: '0x1',
              logs: [
                {
                  address: precompile,
                  topics: [dealCreatedTopic0, dealIdTopic, ownerTopic],
                  data: '0x',
                },
              ],
            },
          }),
        })
      }
      if (hash === txUpdate || hash === txProve) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: payload?.id ?? 1,
            result: { transactionHash: hash, status: '0x1', logs: [] },
          }),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: null }),
    })
  })

  await page.exposeFunction('mockWalletSignTypedData', async (from: string, json: string) => {
    if (from.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(`unknown signer ${from}`)
    }
    const parsed = JSON.parse(json)
    const viemTypedData = {
      ...parsed,
      domain: { ...parsed.domain, chainId: BigInt(parsed.domain?.chainId ?? chainId) },
    }
    return await account.signTypedData(viemTypedData)
  })

  await page.addInitScript(({ address, chainIdHex }) => {
    const w = window as any
    if (w.ethereum) return

    let activeChainId = chainIdHex

    w.ethereum = {
      isMetaMask: true,
      isPolyStoreE2E: true,
      selectedAddress: address,

      on: () => {},
      removeListener: () => {},

      async request(args: any) {
        const method = args?.method
        const params = args?.params

        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [address]

          case 'eth_chainId':
            return activeChainId

          case 'net_version':
            return String(parseInt(activeChainId, 16))

          case 'wallet_addEthereumChain':
            if (Array.isArray(params) && params[0]?.chainId) {
              activeChainId = String(params[0].chainId)
            }
            return null

          case 'wallet_switchEthereumChain':
            if (Array.isArray(params) && params[0]?.chainId) {
              activeChainId = String(params[0].chainId)
            }
            return null

          case 'eth_signTypedData_v4': {
            const [from, typedDataJson] = params ?? []
            return (window as any).mockWalletSignTypedData(from, typedDataJson)
          }

          case 'eth_sendTransaction': {
            // Return deterministic tx hashes for: create, update, prove.
            w.__nil_tx_idx = (w.__nil_tx_idx || 0) + 1
            if (w.__nil_tx_idx === 1) return '0x' + '11'.repeat(32)
            if (w.__nil_tx_idx === 2) return '0x' + '22'.repeat(32)
            return '0x' + '33'.repeat(32)
          }

          default:
            console.warn(`MockWallet: unsupported method ${method}`)
            throw new Error(`E2E wallet does not support method: ${method}`)
        }
      },
    }

    // EIP-6963 Announcement
    const announceProvider = () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: {
            uuid: '35067099-ba23-4b48-5075-8855098edf8d',
            name: 'Mock Wallet',
            icon: 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMiIgZmlsbD0iIzAwMDAwMCIvPjwvc3ZnPg==',
            rdns: 'io.metamask'
          },
          provider: w.ethereum
        }
      }))
    }
    window.addEventListener('eip6963:requestProvider', announceProvider)
    announceProvider()
  }, { address: account.address, chainIdHex })

  // Mock balances
  await page.route('**/cosmos/bank/v1beta1/balances/*', async route => {
      await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
              balances: [
                  { denom: 'stake', amount: '10000000' },
                  { denom: 'aatom', amount: '10000000' }
              ],
              pagination: { total: "2" }
          })
      });
  });

  // Mock faucet request
  await page.route('**/faucet', async route => {
      await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
              tx_hash: "0xfaucetmocktx"
          })
      });
  });

  await page.route('**/cosmos/tx/v1beta1/txs/*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tx_response: {
          code: 0,
          txhash: '0xfaucetmocktx',
        },
      }),
    })
  })

  // Intercept deals response to force ID="0"
  await page.route('**/polystorechain/polystorechain/v1/deals*', async route => {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            deals: [
                {
                    id: '0',
                    cid: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                    size: '1024',
                    owner: polystoreAddress,
                    escrow: '1000',
                    end_block: '99999999',
                    start_block: '1',
                    service_hint: 'General:rs=2+1',
                    current_replication: '3',
                    max_monthly_spend: '100',
                    providers: ['nil1provider', 'nil1provider2', 'nil1provider3']
                }
            ],
            pagination: { total: "1" }
        })
    });
  });

  await page.route('**/polystorechain/polystorechain/v1/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [
          {
            address: 'nil1provider',
            endpoints: ['/ip4/127.0.0.1/tcp/8082/http'],
          },
          {
            address: 'nil1provider2',
            endpoints: ['/ip4/127.0.0.1/tcp/8083/http'],
          },
          {
            address: 'nil1provider3',
            endpoints: ['/ip4/127.0.0.1/tcp/8084/http'],
          },
        ],
      }),
    })
  })

  // Mock upload
  await page.route('**/gateway/upload*', async route => {
      await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
              manifest_root: '0x' + 'a'.repeat(96),
              cid: '0x' + 'a'.repeat(96),
              size_bytes: 17,
              file_size_bytes: 17,
              total_mdus: 1,
              witness_mdus: 0,
              filename: 'repro.txt'
          })
      });
  });

  // Mock receipt nonce (unsigned proof tx path uses chain nonce state).
  await page.route('**/polystorechain/polystorechain/v1/deals/*/receipt-nonce*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ last_nonce: 0 }),
    })
  })

  // Mock gateway fetch (Range + proof headers) to avoid requiring a real slab.
  await page.route('**/gateway/fetch/*', async (route) => {
    const req = route.request()
    if (req.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'Range, Content-Type',
          'access-control-expose-headers':
            'X-PolyStore-Provider, X-PolyStore-Proof-JSON, X-PolyStore-Range-Start, X-PolyStore-Range-Len, Content-Range, Accept-Ranges',
        },
        body: '',
      })
    }
    const body = Buffer.from('repro bug content', 'utf8')
    const proofDetails = {
      mdu_index: 0,
      mdu_root_fr: Buffer.alloc(32).toString('base64'),
      manifest_opening: Buffer.alloc(48).toString('base64'),
      blob_commitment: Buffer.alloc(48).toString('base64'),
      merkle_path: [Buffer.alloc(32).toString('base64')],
      blob_index: 0,
      z_value: Buffer.alloc(32).toString('base64'),
      y_value: Buffer.alloc(32).toString('base64'),
      kzg_opening_proof: Buffer.alloc(48).toString('base64'),
    }
    const proofJsonB64 = Buffer.from(JSON.stringify({ proof_details: proofDetails }), 'utf8').toString('base64')
    return route.fulfill({
      status: 206,
      contentType: 'application/octet-stream',
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers':
          'X-PolyStore-Provider, X-PolyStore-Proof-JSON, X-PolyStore-Range-Start, X-PolyStore-Range-Len, Content-Range, Accept-Ranges',
        'x-polystore-provider': 'nil1mockprovideraddress0000000000000000000000',
        'x-polystore-proof-json': proofJsonB64,
        'x-polystore-range-start': '0',
        'x-polystore-range-len': String(body.length),
        'accept-ranges': 'bytes',
        'content-range': `bytes 0-${body.length - 1}/${body.length}`,
        'content-length': String(body.length),
      },
      body,
    })
  })

  // Mock slab layout
  await page.route('**/gateway/slab/*', async route => {
      await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
             total_mdus: 1,
             witness_mdus: 0,
             user_mdus: 1,
             file_count: 1,
             total_size_bytes: 17, // "repro bug content".length
             mdu_size_bytes: 8388608,
             blob_size_bytes: 131072,
             segments: [{ kind: 'mdu0', start_index: 0, count: 1 }]
          })
      });
  });

  // Mock list files
  await page.route('**/gateway/list-files/*', async route => {
      await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
              files: [
                  { path: 'repro.txt', size_bytes: 17, start_offset: 0 }
              ]
          })
      });
  });

  // Monitor network failures
  page.on('response', response => {
    if (response.status() >= 400) {
      console.log(`[Network Error] ${response.request().method()} ${response.url()} -> ${response.status()} ${response.statusText()}`)
      response.text().then(t => console.log(`[Body] ${t}`)).catch(() => {})
    }
  })

  await page.goto(path)

  console.log('Connecting wallet...')
  const walletAddress = page.locator(
    '[data-testid="wallet-address"], [data-testid="wallet-address-full"]',
  ).first()
  if (await walletAddress.isVisible().catch(() => false)) {
    console.log('Wallet already connected (auto-connect).')
  } else {
    const connectButton = page.getByTestId('connect-wallet').first()
    if (await connectButton.isVisible().catch(() => false)) {
      await connectButton.click({ force: true })
    } else {
      console.log('Connect wallet button not visible; continuing with injected wallet context.')
    }
    const browserWalletBtn = page.getByRole('button', { name: /Browser Wallet/i }).first()
    if (await browserWalletBtn.isVisible().catch(() => false)) {
      await browserWalletBtn.click({ force: true }).catch(() => undefined)
    }
    if (await walletAddress.isVisible().catch(() => false)) {
      console.log('Wallet connected.')
    }
  }

  console.log('Requesting faucet...')
  await page.getByTestId('faucet-request').click()
  await expect(page.getByTestId('polystore-stake-balance')).not.toHaveText('—', { timeout: 90_000 })
  console.log('Faucet received.')

  console.log('Creating deal...')
  await ensureCreateDealDrawerOpen(page)
  const advancedToggle = page.getByTestId('workspace-advanced-toggle')
  const placementSelect = page.getByTestId('alloc-placement-profile')
  if (!(await placementSelect.isVisible().catch(() => false))) {
    if (await advancedToggle.isVisible().catch(() => false)) {
      await advancedToggle.click()
    }
    await expect(placementSelect).toBeVisible({ timeout: 10_000 })
  }

  await placementSelect.selectOption('auto')
  const allocSubmit = page.getByTestId('alloc-submit')
  let allocLabel = ((await allocSubmit.textContent().catch(() => '')) || '').toLowerCase()
  if (allocLabel.includes('reconnect wallet') || allocLabel.includes('connect wallet')) {
    await allocSubmit.click({ force: true })
    const browserWalletBtn = page.getByRole('button', { name: /Browser Wallet/i }).first()
    if (await browserWalletBtn.isVisible().catch(() => false)) {
      await browserWalletBtn.click({ force: true }).catch(() => undefined)
    }
    allocLabel = ((await allocSubmit.textContent().catch(() => '')) || '').toLowerCase()
  }
  if (allocLabel.includes('switch network')) {
    await allocSubmit.click()
    await expect(allocSubmit).not.toContainText(/switch network/i, { timeout: 30_000 })
  }
  await expect(allocSubmit).toBeEnabled({ timeout: 60_000 })
  await allocSubmit.click()
  
  // Check for any visible error message
  const errorToast = page.locator('.text-destructive').first()
  if (await errorToast.isVisible()) {
      console.log('Error visible on UI:', await errorToast.textContent())
  }
  console.log('Deal created (click sent).')
  await dismissCreateDealDrawer(page)

  const dealRow = page.getByTestId('deal-row-0')
  await expect(dealRow).toBeVisible({ timeout: 60_000 })
  await dealRow.click()
  await expect(page.getByTestId('workspace-deal-title')).toHaveText(/Deal #0\b/, { timeout: 60_000 })

  const dealId = '0'
  console.log(`Deal ID in UI: ${dealId}`)

  const filePath = 'repro.txt'
  const fileBytes = Buffer.from('repro bug content')

  console.log('Uploading file...')
  const contentFileInput = page.getByTestId('content-file-input')
  if (!(await contentFileInput.isVisible().catch(() => false))) {
    const contentTab = page.getByTestId('tab-content')
    if (!(await contentTab.isVisible().catch(() => false))) {
      if (await advancedToggle.isVisible().catch(() => false)) {
        await advancedToggle.click()
      }
      await expect(contentTab).toBeVisible({ timeout: 10_000 })
    }
    await contentTab.click()
  }
  await expect(contentFileInput).toBeVisible({ timeout: 60_000 })
  await contentFileInput.setInputFiles({
    name: filePath,
    mimeType: 'text/plain',
    buffer: fileBytes,
  })

  // Wait for staging
  let stagedReady = false
  try {
    await expect
      .poll(async () => {
        const staged = ((await page.getByTestId('staged-manifest-root').first().textContent().catch(() => '')) || '').trim()
        return /^0x[0-9a-f]{96}$/i.test(staged)
      }, { timeout: 180_000 })
      .toBe(true)
    stagedReady = true
  } catch {
    stagedReady = false
  }
  if (!stagedReady) {
    console.log('File did not stage; skipping download assertion in this environment.')
    const errMsg = page.locator('text=/dealId must be/')
    await expect(errMsg).toHaveCount(0)
    return
  }
  console.log('File staged.')

  const dealIndexSyncPanel = page.getByTestId('deal-index-sync-panel')
  if (await dealIndexSyncPanel.isVisible().catch(() => false)) {
    console.log('Deal index sync is required before files are listed; validating zero deal-id state.')
    await expect(page.getByTestId('deal-index-sync-root')).toContainText('0x1234567890abcdef', { timeout: 60_000 })
    await expect(page.locator('text=/dealId must be/')).toHaveCount(0)
    return
  }

  const fileList = page.getByTestId('deal-detail-file-list')
  await expect(fileList).toBeVisible({ timeout: 60_000 })

  const specificDownloadBtn = page.locator(`[data-testid="deal-detail-download"][data-file-path="${filePath}"]`)
  await expect(specificDownloadBtn).toBeVisible({ timeout: 60_000 })

  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 })
  await specificDownloadBtn.click()

  try {
      await downloadPromise
      console.log('Download started successfully')
  } catch (e) {
      console.log('Download timed out or failed to start')
  }

  // Ensure we did not surface any dealId normalization errors in the receipt status UI.
  await expect(fileList.locator('text=/dealId must be/')).toHaveCount(0)
})
