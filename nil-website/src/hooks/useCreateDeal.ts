import { useState } from 'react'
import { appConfig } from '../config'
import { buildCreateDealTypedData, CreateDealIntent } from '../lib/eip712'

export interface CreateDealInput {
  creator: string
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
      let serviceHint = `General:replicas=${replicas}`

      // Build EvmCreateDealIntent payload.
      const nonceKey = `nilstore:evmNonces:${evmAddress.toLowerCase()}`
      const currentNonce = Number(window.localStorage.getItem(nonceKey) || '0') || 0
      const nextNonce = currentNonce + 1
      window.localStorage.setItem(nonceKey, String(nextNonce))

      const intent: CreateDealIntent = {
        creator_evm: evmAddress,
        duration_blocks: input.duration,
        service_hint: serviceHint,
        initial_escrow: input.initialEscrow,
        max_monthly_spend: input.maxMonthlySpend,
        nonce: nextNonce,
      }

      const typedData = buildCreateDealTypedData(intent, appConfig.chainId)

      const ethereum = (window as any).ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }

      const signature: string = await ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [evmAddress, JSON.stringify(typedData)],
      })

      // Construct the Intent object for the Gateway (must match protobuf/backend expectation)
      // Backend expects chain_id as string in the intent JSON.
      const gatewayIntent = { ...intent, chain_id: appConfig.cosmosChainId }

      const response = await fetch(`${appConfig.gatewayBase}/gateway/create-deal-evm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: gatewayIntent,
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
