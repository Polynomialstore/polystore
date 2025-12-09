import { useState } from 'react'
import { appConfig } from '../config'

export interface UpdateDealContentInput {
  creator: string
  dealId: number
  cid: string
  sizeBytes: number
}

export function useUpdateDealContent() {
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function submitUpdate(input: UpdateDealContentInput) {
    setLoading(true)
    setLastTx(null)
    try {
      const isEvm = input.creator.startsWith('0x')
      const evmAddress = isEvm ? input.creator : ''
      if (!isEvm) {
        throw new Error('EVM address required for EVM-bridged update')
      }

      // Build Intent
      const nonceKey = `nilstore:evmNonces:${evmAddress.toLowerCase()}`
      const currentNonce = Number(window.localStorage.getItem(nonceKey) || '0') || 0
      const nextNonce = currentNonce + 1
      window.localStorage.setItem(nonceKey, String(nextNonce))

      const intent = {
        creator_evm: evmAddress,
        deal_id: input.dealId,
        cid: input.cid,
        size_bytes: input.sizeBytes,
        nonce: nextNonce,
        chain_id: appConfig.cosmosChainId,
      }

      const message = buildEvmUpdateContentMessage(intent)
      const ethereum = (window as any).ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }

      const signature: string = await ethereum.request({
        method: 'personal_sign',
        params: [message, evmAddress],
      })

      const response = await fetch(`${appConfig.gatewayBase}/gateway/update-deal-content-evm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent,
          evm_signature: signature,
        }),
      })

      if (!response.ok) {
        const errText = await response.text()
        throw new Error(errText || 'Update content submission failed')
      }

      const json = await response.json().catch(() => ({}))
      if (json.tx_hash) setLastTx(json.tx_hash)
      return json
    } finally {
      setLoading(false)
    }
  }

  return { submitUpdate, loading, lastTx }
}

function buildEvmUpdateContentMessage(intent: {
  creator_evm: string
  deal_id: number
  cid: string
  size_bytes: number
  nonce: number
  chain_id: string
}): string {
  const creator = intent.creator_evm.trim().toLowerCase().startsWith('0x')
    ? intent.creator_evm.trim().toLowerCase()
    : `0x${intent.creator_evm.trim().toLowerCase()}`

  const parts = [
    'NILSTORE_EVM_UPDATE_CONTENT',
    creator,
    String(intent.deal_id),
    intent.cid.trim(),
    String(intent.size_bytes),
    String(intent.nonce),
    intent.chain_id.trim(),
  ]

  return parts.join('|')
}
