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

      // EIP-712 Typed Data
      const domain = {
        name: 'NilStore',
        version: '1',
        chainId: appConfig.chainId, // Use configured EVM chain ID
        verifyingContract: '0x0000000000000000000000000000000000000000' as const,
      }

      const types = {
        UpdateContent: [
          { name: 'creator', type: 'address' },
          { name: 'deal_id', type: 'uint64' },
          { name: 'cid', type: 'string' },
          { name: 'size', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
        ],
      }

      const message = {
        creator: evmAddress,
        deal_id: Number(input.dealId),
        cid: input.cid,
        size: Number(input.sizeBytes),
        nonce: Number(nextNonce),
      }

      const typedData = {
        domain,
        types,
        primaryType: 'UpdateContent',
        message,
      }

      const ethereum = (window as any).ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }

      const signature: string = await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [evmAddress, JSON.stringify(typedData)],
      })

      // Construct intent for backend
      const intent = {
        creator_evm: evmAddress,
        deal_id: input.dealId,
        cid: input.cid,
        size_bytes: input.sizeBytes,
        nonce: nextNonce,
        chain_id: String(appConfig.chainId),
      }

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
