/* eslint-disable @typescript-eslint/no-explicit-any */import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { getAbiItem, getEventSelector, padHex, toHex, type Hex } from 'viem'
import { NILSTORE_PRECOMPILE_ABI } from '../src/lib/nilstorePrecompile'

const path = process.env.E2E_PATH || '/#/dashboard'
const precompile = '0x0000000000000000000000000000000000000900'

function ethToNil(ethAddress: string): string {
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
  const nilAddress = ethToNil(account.address)
  const txCreate = (`0x${'11'.repeat(32)}` as Hex)
  const txUpdate = (`0x${'22'.repeat(32)}` as Hex)
  const txProve = (`0x${'33'.repeat(32)}` as Hex)
  
  console.log(`Using random E2E wallet: ${account.address} -> ${nilAddress}`)

  // Mock EVM RPC receipts for the precompile-based flow.
  const dealCreatedEvent = getAbiItem({ abi: NILSTORE_PRECOMPILE_ABI, name: 'DealCreated' }) as any
  const dealCreatedTopic0 = getEventSelector(dealCreatedEvent)
  const dealIdTopic = toHex(0n, { size: 32 })
  const ownerTopic = padHex(account.address, { size: 32 })

  await page.route('**://localhost:8545', async (route) => {
    const req = route.request()
    const payload = JSON.parse(req.postData() || '{}') as any
    const method = payload?.method
    const params = payload?.params || []
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

    w.ethereum = {
      isMetaMask: true,
      isNilStoreE2E: true,
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
            return chainIdHex

          case 'net_version':
            return String(parseInt(chainIdHex, 16))

          case 'wallet_addEthereumChain':
            return null

          case 'wallet_switchEthereumChain':
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

  // Intercept deals response to force ID="0"
  await page.route('**/nilchain/nilchain/v1/deals*', async route => {
    await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
            deals: [
                {
                    id: '0',
                    cid: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                    size: '1024',
                    owner: nilAddress,
                    escrow: '1000',
                    end_block: '1000',
                    start_block: '1',
                    service_hint: 'General:replicas=1',
                    current_replication: '1',
                    max_monthly_spend: '100',
                    providers: []
                }
            ],
            pagination: { total: "1" }
        })
    });
  });

  await page.route('**/nilchain/nilchain/v1/providers', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        providers: [
          {
            address: 'nil1provider',
            endpoints: ['/ip4/127.0.0.1/tcp/8082/http'],
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
              cid: '0x' + 'a'.repeat(96),
              size_bytes: 17,
              file_size_bytes: 17,
              filename: 'repro.txt'
          })
      });
  });

  // Mock receipt nonce (unsigned proof tx path uses chain nonce state).
  await page.route('**/nilchain/nilchain/v1/deals/*/receipt-nonce*', async (route) => {
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
            'X-Nil-Provider, X-Nil-Proof-JSON, X-Nil-Range-Start, X-Nil-Range-Len, Content-Range, Accept-Ranges',
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
          'X-Nil-Provider, X-Nil-Proof-JSON, X-Nil-Range-Start, X-Nil-Range-Len, Content-Range, Accept-Ranges',
        'x-nil-provider': 'nil1mockprovideraddress0000000000000000000000',
        'x-nil-proof-json': proofJsonB64,
        'x-nil-range-start': '0',
        'x-nil-range-len': String(body.length),
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
  if (await page.getByTestId('wallet-address').isVisible()) {
    console.log('Wallet already connected (auto-connect).')
  } else {
    await page.getByTestId('connect-wallet').first().click({ force: true })
    await expect(page.getByTestId('wallet-address')).toBeVisible()
    console.log('Wallet connected.')
  }

  console.log('Requesting faucet...')
  await page.getByTestId('faucet-request').click()
  await expect(page.getByTestId('cosmos-stake-balance')).not.toHaveText('—', { timeout: 90_000 })
  console.log('Faucet received.')

  console.log('Creating deal...')
  await page.getByTestId('alloc-submit').click()
  
  // Check for any visible error message
  const errorToast = page.locator('.text-destructive').first()
  if (await errorToast.isVisible()) {
      console.log('Error visible on UI:', await errorToast.textContent())
  }

  await page.getByTestId('tab-content').click()
  console.log('Deal created (click sent).')

  const dealSelect = page.getByTestId('content-deal-select')
  
  // Wait for our intercepted deal (ID 0) to appear in the options
  // The label should contain "Deal #0"
  await expect(dealSelect.locator('option', { hasText: 'Deal #0' })).toBeAttached({ timeout: 60_000 })
  
  // Select it
  await dealSelect.selectOption('0')
  
  const dealId = await dealSelect.inputValue()
  console.log(`Deal ID in UI: ${dealId}`)
  
  // If interception worked, dealId should be "0"
  if (dealId !== '0') {
      console.warn('WARNING: Deal ID is not 0. Interception might have failed or race condition.')
  }

  const filePath = 'repro.txt'
  const fileBytes = Buffer.from('repro bug content')

  console.log('Uploading file...')
  await page.getByTestId('content-file-input').setInputFiles({
    name: filePath,
    mimeType: 'text/plain',
    buffer: fileBytes,
  })

  // Wait for staging
  await expect(page.getByTestId('staged-manifest-root')).toHaveText(/^0x[0-9a-f]{96}$/i, { timeout: 180_000 })
  console.log('File staged.')

  // Commit content
  console.log('Committing content...')
  const commitBtn = page.getByTestId('content-commit')
  await expect(commitBtn).toBeVisible()
  
  if (await commitBtn.isDisabled()) {
      console.log('Commit button is disabled. Checking why...')
      await expect(commitBtn).toBeEnabled({ timeout: 10_000 }).catch(() => console.log('Commit button still disabled after 10s'))
  }
  
  await commitBtn.click()
  console.log('Commit button clicked.')
  
  // Wait for "Files In Slab" to appear
  const filesInSlab = page.getByText('Files In Slab')
  await expect(filesInSlab).toBeVisible({ timeout: 60_000 })
  
  // Find the container for "Files In Slab"
  // The text "Files In Slab" is in a header div. We want the parent container.
  const slabHeader = page.getByText('Files In Slab')
  const slabSection = slabHeader.locator('xpath=..')
  
  const fileRow = page.locator('div.flex.items-center.justify-between', { hasText: filePath })
  await expect(fileRow).toBeVisible({ timeout: 60_000 })
  
  const specificDownloadBtn = fileRow.locator('button', { hasText: 'Download' })
  
  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 }) // Short timeout as we expect failure
  
  await specificDownloadBtn.click()
  
  try {
      await downloadPromise
      console.log('Download started successfully')
  } catch (e) {
      console.log('Download timed out or failed to start')
  }

  // Ensure we did not surface any dealId normalization errors in the receipt status UI.
  const errMsg = slabSection.locator('text=/dealId must be/')
  await expect(errMsg).toHaveCount(0)
})
