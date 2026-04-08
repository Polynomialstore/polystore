import { randomBytes, randomUUID, scryptSync, createCipheriv } from 'node:crypto'
import { chmodSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { concat, type Hex, hexToBytes, keccak256 } from 'viem'

import { ethToNil } from '../src/lib/address'

type Mode = 'generate' | 'export-keystore'

function usage(): never {
  console.error(
    'usage: testnet_burner_wallet.ts <generate|export-keystore> [--out <path>] [--private-key <0x...>] [--password <value>]',
  )
  process.exit(1)
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name)
  if (idx < 0) return undefined
  const value = process.argv[idx + 1]
  if (!value || value.startsWith('--')) return undefined
  return value
}

function normalizePrivateKey(raw: string): Hex {
  const trimmed = String(raw).trim()
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error('private key must be 32 bytes hex')
  }
  return withPrefix.toLowerCase() as Hex
}

function generateWallet() {
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  const nilAddress = ethToNil(account.address)
  process.stdout.write(
    JSON.stringify({
      private_key: privateKey,
      address: account.address,
      polystore_address: nilAddress,
    }),
  )
}

function exportKeystore() {
  const privateKey = normalizePrivateKey(
    argValue('--private-key') || process.env.EVM_PRIVKEY || process.env.POLYSTORE_EVM_DEV_PRIVKEY || '',
  )
  const password = argValue('--password') || process.env.KEYSTORE_PASSWORD || ''
  const out = argValue('--out') || process.env.KEYSTORE_OUT || ''

  if (!password) {
    throw new Error('missing keystore password')
  }
  if (!out) {
    throw new Error('missing --out path')
  }

  // Testnet default scrypt cost profile: secure enough for burner keys while
  // keeping CLI latency acceptable on common laptops.
  const n = 1 << 14
  const r = 8
  const p = 1
  const dklen = 32

  const iv = randomBytes(16)
  const salt = randomBytes(32)
  const derivedKey = scryptSync(password, salt, dklen, {
    N: n,
    r,
    p,
    maxmem: 256 * n * r,
  })

  const cipher = createCipheriv('aes-128-ctr', derivedKey.subarray(0, 16), iv)
  const ciphertext = Buffer.concat([cipher.update(hexToBytes(privateKey)), cipher.final()])
  const mac = keccak256(concat([derivedKey.subarray(16, 32), ciphertext]) as Hex)
  const account = privateKeyToAccount(privateKey)

  const keystore = {
    version: 3,
    id: randomUUID(),
    address: account.address.slice(2).toLowerCase(),
    crypto: {
      cipher: 'aes-128-ctr',
      cipherparams: { iv: iv.toString('hex') },
      ciphertext: ciphertext.toString('hex'),
      kdf: 'scrypt',
      kdfparams: {
        dklen,
        salt: salt.toString('hex'),
        n,
        r,
        p,
      },
      mac: mac.slice(2),
    },
  }

  const outPath = resolve(out)
  writeFileSync(outPath, JSON.stringify(keystore, null, 2), { encoding: 'utf8', mode: 0o600 })
  chmodSync(outPath, 0o600)

  process.stdout.write(
    JSON.stringify({
      address: account.address,
      polystore_address: ethToNil(account.address),
      keystore_path: outPath,
    }),
  )
}

function main() {
  const mode = process.argv[2] as Mode | undefined
  if (!mode || (mode !== 'generate' && mode !== 'export-keystore')) {
    usage()
  }

  if (mode === 'generate') {
    generateWallet()
    return
  }

  exportKeystore()
}

main()
