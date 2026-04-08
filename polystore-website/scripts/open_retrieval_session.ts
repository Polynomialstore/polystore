/* eslint-disable @typescript-eslint/no-explicit-any */
import { createPublicClient, createWalletClient, decodeEventLog, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { POLYSTORE_PRECOMPILE_ABI, encodeOpenRetrievalSessionsData, type RetrievalSessionInput } from '../src/lib/polystorePrecompile'

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} env var required`)
  return v
}

async function main() {
  const privKey = (process.env.EVM_PRIVKEY || process.env.NIL_EVM_DEV_PRIVKEY) as Hex | undefined
  if (!privKey) throw new Error('EVM_PRIVKEY env var required')

  const rpcUrl = process.env.EVM_RPC || process.env.VITE_EVM_RPC || 'http://localhost:8545'
  const chainId = Number(process.env.EVM_CHAIN_ID || 31337)
  const precompile = (process.env.POLYSTORE_PRECOMPILE ||
    process.env.VITE_POLYSTORE_PRECOMPILE ||
    '0x0000000000000000000000000000000000000900') as Hex

  const account = privateKeyToAccount(privKey)

  const client = createPublicClient({
    chain: {
      id: chainId,
      name: 'nilstore-e2e',
      nativeCurrency: { name: 'ATOM', symbol: 'ATOM', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl),
  })

  const wallet = createWalletClient({
    account,
    chain: client.chain,
    transport: http(rpcUrl),
  })

  const session: RetrievalSessionInput = {
    dealId: BigInt(requiredEnv('DEAL_ID')),
    provider: requiredEnv('PROVIDER'),
    manifestRoot: requiredEnv('MANIFEST_ROOT') as Hex,
    startMduIndex: BigInt(requiredEnv('START_MDU_INDEX')),
    startBlobIndex: Number(requiredEnv('START_BLOB_INDEX')),
    blobCount: BigInt(requiredEnv('BLOB_COUNT')),
    nonce: BigInt(requiredEnv('NONCE')),
    expiresAt: BigInt(requiredEnv('EXPIRES_AT')),
  }

  const data = encodeOpenRetrievalSessionsData([session])

  const txHash = await wallet.sendTransaction({
    to: precompile,
    data,
  })

  const receipt = await client.waitForTransactionReceipt({
    hash: txHash,
    timeout: 120_000,
  })

  let sessionId: Hex | null = null
  for (const log of receipt.logs) {
    // Some clients return mixed-case addresses in logs; normalize before compare.
    if (String(log.address).toLowerCase() !== String(precompile).toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: POLYSTORE_PRECOMPILE_ABI,
        data: log.data,
        topics: log.topics,
      })
      if (decoded.eventName !== 'RetrievalSessionOpened') continue
      const args = decoded.args as any
      if (BigInt(args?.dealId ?? -1n) !== session.dealId) continue
      sessionId = args?.sessionId as Hex
      break
    } catch {
      // ignore non-matching logs
    }
  }

  if (!sessionId) {
    throw new Error(`failed to resolve session id from receipt logs (tx=${txHash})`)
  }

  process.stdout.write(
    JSON.stringify({
      tx_hash: txHash,
      session_id: sessionId,
    }),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
