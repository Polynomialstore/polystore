import { test, expect } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { bech32 } from 'bech32'

const path = process.env.E2E_PATH || '/#/dashboard'

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
  
  console.log(`Using random E2E wallet: ${account.address} -> ${nilAddress}`)

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

          default:
            console.warn(`MockWallet: unsupported method ${method}`)
            throw new Error(`E2E wallet does not support method: ${method}`)
        }
      },
    }
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
  await page.route('**/nilchain/nilchain/v1/faucet', async route => {
      await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
              tx_hash: "0xfaucetmocktx"
          })
      });
  });

  // Intercept deals response to force ID="0"
  await page.route('**/nilchain/nilchain/v1/deals*', async route => {
    const response = await route.fetch();
    const json = await response.json();
    if (json.deals && Array.isArray(json.deals)) {
        const myDeal = json.deals.find((d: { owner: string; id: string }) => d.owner === nilAddress)
        if (myDeal) {
            console.log(`Intercepting deal ${myDeal.id} for ${nilAddress} and changing ID to 0`)
            myDeal.id = '0';
        }
    }
    await route.fulfill({ json });
  });

  // Mock commit success
  await page.route('**/gateway/update-deal-content-evm', async route => {
      await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ tx_hash: '0xmocktxhash' })
      });
  });

  // Mock slab layout
  await page.route('**/gateway/slab/*', async route => {
      await route.fulfill({
          status: 200,
          contentType: 'application/json',
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
  await page.getByTestId('connect-wallet').click()
  await expect(page.getByTestId('wallet-address')).toBeVisible()
  console.log('Wallet connected.')

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
  await expect(fileRow).toBeVisible()
  
  const specificDownloadBtn = fileRow.locator('button', { hasText: 'Download' })
  
  const downloadPromise = page.waitForEvent('download', { timeout: 10_000 }) // Short timeout as we expect failure
  
  await specificDownloadBtn.click()
  
  try {
      await downloadPromise
      console.log('Download started successfully')
  } catch (e) {
      console.log('Download timed out or failed to start')
  }

  // Check for error message
  console.log('Slab section text:', await slabSection.textContent())
  const errorMsg = slabSection.locator('text=Receipt failed: dealId must be a positive integer')
  const isVisible = await errorMsg.isVisible()
  
  if (isVisible) {
      throw new Error('Reproduction successful: Found error message "Receipt failed: dealId must be a positive integer"')
  } else {
      console.log('Error message NOT found.')
  }
})