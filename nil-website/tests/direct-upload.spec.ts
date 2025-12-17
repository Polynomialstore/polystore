/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'
import { type Hex } from 'viem'

const path = process.env.E2E_PATH || '/#/dashboard'

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex')
  const words = bech32.toWords(data)
  return bech32.encode('nil', words)
}

test('Thick Client: Direct Upload and Commit', async ({ page }) => {
  test.setTimeout(300_000)

  // Setup Mock Wallet
  const randomPk = generatePrivateKey()
  const account = privateKeyToAccount(randomPk)
  const chainId = Number(process.env.CHAIN_ID || 31337)
  const chainIdHex = `0x${chainId.toString(16)}`
  const nilAddress = ethToNil(account.address)
  // We need distinct transaction hashes for commit content
  const txCommit = (`0x${'44'.repeat(32)}` as Hex)

  console.log(`Using random E2E wallet: ${account.address} -> ${nilAddress}`)

  // Intercept SP Upload
  await page.route('**/sp/upload_mdu', async (route) => {
    const headers = route.request().headers()
    const dealId = headers['x-nil-deal-id']
    const manifestRoot = headers['x-nil-manifest-root']
    const mduIndex = headers['x-nil-mdu-index']

    if (!dealId || !manifestRoot || !mduIndex) {
        console.log(`[SP Upload Mock] Missing headers: Deal=${dealId}, Root=${manifestRoot}, Index=${mduIndex}`)
        return route.fulfill({ status: 400, body: 'Missing headers' })
    }
    console.log(`[SP Upload Mock] Received MDU #${mduIndex} for Deal ${dealId} (Root: ${manifestRoot})`)
    return route.fulfill({ status: 200, body: 'OK' })
  })

  // Mock EVM RPC
  await page.route('**://localhost:8545', async (route) => {
    const req = route.request()
    const payload = JSON.parse(req.postData() || '{}') as any
    const method = payload?.method
    const params = payload?.params || []

    if (method === 'eth_sendTransaction') {
        // Assume this is the commit transaction
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ jsonrpc: '2.0', id: payload?.id ?? 1, result: txCommit }),
        })
    }

    if (method === 'eth_getTransactionReceipt') {
      const hash = String(params?.[0] || '')
      if (hash === txCommit) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: payload?.id ?? 1,
            result: {
              transactionHash: txCommit,
              transactionIndex: '0x1',
              blockHash: '0x' + '11'.repeat(32),
              blockNumber: '0x1',
              from: account.address,
              to: '0x0000000000000000000000000000000000000900',
              cumulativeGasUsed: '0x1',
              gasUsed: '0x1',
              contractAddress: null,
              logs: [],
              logsBloom: '0x0000000000000000000000000000000000000000',
              status: '0x1',
              effectiveGasPrice: '0x1',
              type: '0x0',
            },
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

  // Mock LCD Deals
  await page.route('**/nilchain/nilchain/v1/deals**', async route => {
      await route.fulfill({
          status: 200,
          body: JSON.stringify({
              deals: [
                  {
                      id: '1',
                      owner: nilAddress,
                      cid: '',
                      size: '0',
                      escrow_balance: '1000000',
                      end_block: '1000',
                      providers: ['nil1provider'],
                  }
              ]
          })
      })
  })

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

              case 'eth_sendTransaction': {

                 const params = args?.params || []

                 const txData = params?.[0]?.data

                 if (typeof txData === 'string' && txData.length >= 202) {

                     const sizeHex = txData.slice(138, 202)

                     const sizeVal = parseInt(sizeHex, 16)

                     console.log(`[Mock Wallet] eth_sendTransaction: sizeBytes=${sizeVal}`)

                     if (sizeVal === 0) {

                         throw new Error('Validation Failed: SizeBytes is 0!')

                     }

                 }

                 return '0x' + '44'.repeat(32)

              }

              default: return null

            }

          },

        }
    const announceProvider = () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: { uuid: 'test-uuid', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' },
          provider: w.ethereum
        }
      }))
    }
    window.addEventListener('eip6963:requestProvider', announceProvider)
    announceProvider()
  }, { address: account.address, chainIdHex })

  // Mock Balances/Faucet needed? Component checks connection.
  await page.route('**/cosmos/bank/v1beta1/balances/*', async route => {
      await route.fulfill({
          status: 200, body: JSON.stringify({ balances: [{ denom: 'stake', amount: '1000' }], pagination: { total: "1" } })
      });
  });

  await page.goto(path)

  console.log('Connecting wallet...')
  if (await page.getByTestId('wallet-address').isVisible()) {
    console.log('Wallet already connected.')
  } else {
    await page.getByTestId('connect-wallet').click({ force: true })
    await expect(page.getByTestId('wallet-address')).toBeVisible()
  }

  console.log('Switching to Local MDU tab...')
  await page.getByTestId('tab-mdu').click()

  console.log('Selecting Deal #1...')
  await page.getByTestId('mdu-deal-select').selectOption('1')

  await expect(page.getByText('WASM: ready')).toBeVisible({ timeout: 30000 })

  // Find the Client-Side Expansion section
  const filePath = 'test-direct.txt'
  const fileBytes = Buffer.alloc(1024 * 1024, 'a') // 1MB file

  console.log('Uploading file to FileSharder input...')
  // The input is hidden, handleFileSelect is triggered on change.
  await page.locator('input[type="file"]').setInputFiles({
    name: filePath,
    mimeType: 'text/plain',
    buffer: fileBytes,
  })

  // Wait for Sharding to complete.
  await expect(page.getByText('Client-side expansion complete')).toBeVisible({ timeout: 60000 })
  console.log('Sharding complete.')

  // Check if "Upload to SP" button is enabled.
  const uploadBtn = page.getByRole('button', { name: /Upload \d+ MDUs to SP/ })
  await expect(uploadBtn).toBeEnabled()
  
  console.log('Clicking Upload to SP...')
  await uploadBtn.click()

  // Wait for "Upload Complete".
  await expect(page.getByRole('button', { name: 'Upload Complete' })).toBeVisible({ timeout: 30000 })
  console.log('Upload complete.')

  // Check "Commit to Chain" button
  const commitBtn = page.getByRole('button', { name: 'Commit to Chain' })
  await expect(commitBtn).toBeVisible()
  
  console.log('Clicking Commit to Chain...')
  await commitBtn.click()

  // Wait for "Confirming..." (Validation passed if we got here)
  await expect(page.getByRole('button', { name: 'Confirming...' })).toBeVisible({ timeout: 30000 })
  console.log('Commit transaction sent (validation passed).')
})
