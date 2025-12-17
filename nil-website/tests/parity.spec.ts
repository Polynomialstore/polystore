/* eslint-disable @typescript-eslint/no-explicit-any */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { bech32 } from 'bech32';

const NIL_CLI_PATH = path.resolve('..', 'nil_cli/target/release/nil_cli');
const TEST_FILE_PATH = 'test-parity.txt';
const TEST_FILE_SIZE = 1024 * 1024; // 1MB

function ethToNil(ethAddress: string): string {
  const data = Buffer.from(ethAddress.replace(/^0x/, ''), 'hex');
  const words = bech32.toWords(data);
  return bech32.encode('nil', words);
}

test('WASM Parity: Client-side sharding matches nil_cli', async ({ page }) => {
  test.setTimeout(300_000);

  // 1. Generate Test File
  const fileBytes = Buffer.alloc(TEST_FILE_SIZE, 'a'); // 'a' content
  fs.writeFileSync(TEST_FILE_PATH, fileBytes);

  // 2. Run nil_cli to get reference Manifest Root
  console.log('Running nil_cli shard...');
  let referenceRoot = '';
  try {
    // Check if nil_cli exists
    if (!fs.existsSync(NIL_CLI_PATH)) {
        console.warn(`nil_cli not found at ${NIL_CLI_PATH}. Skipping parity check logic that requires CLI.`);
        // Fail the test if CLI is missing, as requested
        test.fail(true, "nil_cli binary missing");
        return;
    }

    const trustedSetupPath = path.resolve('..', 'nilchain/trusted_setup.txt');
    console.log('Trusted Setup Path:', trustedSetupPath);
    console.log('File Path:', path.resolve(TEST_FILE_PATH));
    
    // Run CLI
    execSync(`${NIL_CLI_PATH} shard ${path.resolve(TEST_FILE_PATH)} --out output.json`, {
        encoding: 'utf-8',
        env: { ...process.env, CKZG_TRUSTED_SETUP: trustedSetupPath }
    });
    
    // Read JSON
    const json = JSON.parse(fs.readFileSync('output.json', 'utf-8'));
    referenceRoot = json.manifest_root_hex || json.manifest_root;
  } catch (e) {
    console.error('Failed to run nil_cli:', e);
    throw e;
  }
  
  console.log('Reference Root (nil_cli):', referenceRoot);
  expect(referenceRoot).toMatch(/^0x[0-9a-f]{96}$/);

  // 3. Setup Browser Env
  // Setup Mock Wallet
  const randomPk = generatePrivateKey();
  const account = privateKeyToAccount(randomPk);
  const chainIdHex = '0x7A69'; // 31337
  const nilAddress = ethToNil(account.address);

  // Mock LCD Deals to allow selection
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
      });
  });

  // Mock SP Upload (to prevent 404s/errors during upload phase)
  await page.route('**/sp/upload_mdu', async (route) => {
      return route.fulfill({ status: 200, body: 'OK' });
  });

  // Capture Console Logs to find the calculated root
  let calculatedRoot = '';
  page.on('console', msg => {
      const text = msg.text();
      console.log(`[Browser] ${text}`);
      if (text.startsWith('[Debug] Full Manifest Root:')) {
          calculatedRoot = text.split(': ')[1].trim();
          console.log('Captured Calculated Root:', calculatedRoot);
      }
  });

  // Inject Wallet
  await page.addInitScript(({ address, chainIdHex }) => {
    const w = window as any;
    if (w.ethereum) return;
    w.ethereum = {
      isMetaMask: true,
      isNilStoreE2E: true,
      selectedAddress: address,
      on: () => {},
      removeListener: () => {},
      async request(args: any) {
        switch (args?.method) {
          case 'eth_requestAccounts': return [address];
          case 'eth_accounts': return [address];
          case 'eth_chainId': return chainIdHex;
          case 'net_version': return String(parseInt(chainIdHex, 16));
          default: return null;
        }
      },
    };
    const announceProvider = () => {
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
        detail: { info: { uuid: 'test-uuid', name: 'Mock Wallet', icon: '', rdns: 'io.metamask' }, provider: w.ethereum }
      }));
    };
    window.addEventListener('eip6963:requestProvider', announceProvider);
    announceProvider();
  }, { address: account.address, chainIdHex });

  await page.goto('/#/dashboard');

  console.log('Connecting wallet...');
  if (await page.getByTestId('wallet-address').isVisible()) {
    console.log('Wallet already connected.');
  } else {
    const connectBtn = page.getByTestId('connect-wallet').first();
    await expect(connectBtn).toBeVisible({ timeout: 60000 });
    await connectBtn.click({ force: true });
    await expect(page.getByTestId('wallet-address')).toBeVisible();
  }

  console.log('Switching to Local MDU tab...');
  await page.getByTestId('tab-mdu').click();

  console.log('Selecting Deal #1...');
  await page.getByTestId('mdu-deal-select').selectOption('1');

  await expect(page.getByText('WASM: ready')).toBeVisible({ timeout: 30000 });

  console.log('Uploading file...');
  await page.locator('input[type="file"]').setInputFiles({
    name: path.basename(TEST_FILE_PATH),
    mimeType: 'text/plain',
    buffer: fileBytes,
  });

  // Wait for sharding to complete (manifest root logged)
  await expect.poll(() => calculatedRoot, { timeout: 60000 }).toMatch(/^0x/);

  console.log('Comparing Roots...');
  console.log(`Reference: ${referenceRoot}`);
  console.log(`Calculated: ${calculatedRoot}`);

  expect(calculatedRoot).toBe(referenceRoot);
});