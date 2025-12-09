import { useState } from 'react'
import { appConfig } from '../config'

export interface CreateDealInput {
  creator: string
  cid: string
  size: number
  duration: number
  initialEscrow: string
  maxMonthlySpend: string
  replication: number
}

export function useCreateDeal() {
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function submitDeal(input: CreateDealInput) {
    setLoading(true)
    setLastTx(null)
    try {
      const isEvm = input.creator.startsWith('0x')
      const evmAddress = isEvm ? input.creator : ''
      if (!isEvm) {
        throw new Error('EVM address required for EVM-bridged deal creation')
      }
      const replicas = Number.isFinite(input.replication) && input.replication > 0 ? input.replication : 1
      const serviceHint = `General:replicas=${replicas}`

      // Build EvmCreateDealIntent payload.
      const nonceKey = `nilstore:evmNonces:${evmAddress.toLowerCase()}`
      const currentNonce = Number(window.localStorage.getItem(nonceKey) || '0') || 0
      const nextNonce = currentNonce + 1
      window.localStorage.setItem(nonceKey, String(nextNonce))

      const intent = {
        creator_evm: evmAddress,
        cid: input.cid,
        size_bytes: input.size,
        duration_blocks: input.duration,
        service_hint: serviceHint,
        initial_escrow: input.initialEscrow,
        max_monthly_spend: input.maxMonthlySpend,
        nonce: nextNonce,
        chain_id: appConfig.cosmosChainId,
      }

      const message = buildEvmCreateDealMessage(intent)
      const ethereum = (window as any).ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }

      const signature: string = await ethereum.request({
        method: 'personal_sign',
        params: [message, evmAddress],
      })

      const response = await fetch(`${appConfig.gatewayBase}/gateway/create-deal-evm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent,
          evm_signature: signature,
        }),
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(errText || 'Deal submission failed')
      }

      const json = await response.json().catch(() => ({}))
      if (json.tx_hash) setLastTx(json.tx_hash)
      return json
    } finally {
      setLoading(false)
    }
  }

  return { submitDeal, loading, lastTx }
}

function buildEvmCreateDealMessage(intent: {
  creator_evm: string
  cid: string
  size_bytes: number
  duration_blocks: number
  service_hint: string
  initial_escrow: string
  max_monthly_spend: string
  nonce: number
  chain_id: string
}): string {
  const creator = intent.creator_evm.trim().toLowerCase().startsWith('0x')
    ? intent.creator_evm.trim().toLowerCase()
    : `0x${intent.creator_evm.trim().toLowerCase()}`

  const parts = [
    'NILSTORE_EVM_CREATE_DEAL',
    creator,
    intent.cid.trim(),
    String(intent.size_bytes),
    String(intent.duration_blocks),
    intent.service_hint.trim(),
    intent.initial_escrow,
    intent.max_monthly_spend,
    String(intent.nonce),
    intent.chain_id.trim(),
  ]

  return parts.join('|')
}
