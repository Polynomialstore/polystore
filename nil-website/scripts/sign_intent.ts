import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

import {
  buildCreateDealTypedData,
  buildUpdateContentTypedData,
  CreateDealIntent,
  UpdateContentIntent,
} from '../src/lib/eip712'

const mode = process.argv[2]
if (!mode || (mode !== 'create-deal' && mode !== 'update-content')) {
  console.error('usage: sign_intent.ts <create-deal|update-content>')
  process.exit(1)
}

const privKey = (process.env.EVM_PRIVKEY || process.env.NIL_EVM_DEV_PRIVKEY) as Hex | undefined
if (!privKey) {
  console.error('EVM_PRIVKEY env var required')
  process.exit(1)
}

const evmChainId = Number(process.env.EVM_CHAIN_ID || 31337)
const cosmosChainId = process.env.CHAIN_ID || 'test-1'
const account = privateKeyToAccount(privKey)

async function signTypedData(typedData: any) {
  // viem requires bigint chainId for signing.
  const viemTypedData = {
    ...typedData,
    domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) },
  }
  return account.signTypedData(viemTypedData)
}

async function main() {
  if (mode === 'create-deal') {
    const intent: CreateDealIntent = {
      creator_evm: account.address,
      duration_blocks: Number(process.env.DURATION_BLOCKS || 100),
      service_hint: process.env.SERVICE_HINT || 'General',
      initial_escrow: process.env.INITIAL_ESCROW || '1000000',
      max_monthly_spend: process.env.MAX_MONTHLY_SPEND || '500000',
      nonce: Number(process.env.NONCE || 1),
    }

    const typedData = buildCreateDealTypedData(intent, evmChainId)
    const sig = await signTypedData(typedData)

    process.stdout.write(
      JSON.stringify({
        intent: { ...intent, chain_id: cosmosChainId },
        evm_signature: sig,
      }),
    )
    return
  }

  const cid = process.env.CID
  if (!cid) {
    console.error('CID env var required for update-content')
    process.exit(1)
  }

  const intent: UpdateContentIntent = {
    creator_evm: account.address,
    deal_id: Number(process.env.DEAL_ID || 0),
    cid,
    size_bytes: Number(process.env.SIZE_BYTES || 0),
    nonce: Number(process.env.NONCE || 1),
  }

  const typedData = buildUpdateContentTypedData(intent, evmChainId)
  const sig = await signTypedData(typedData)

  process.stdout.write(
    JSON.stringify({
      intent: { ...intent, chain_id: cosmosChainId },
      evm_signature: sig,
    }),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
