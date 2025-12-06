import { useState } from 'react'
import { appConfig } from '../config'
import { ethToNil } from '../lib/address'

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
      const creator = input.creator.startsWith('0x') ? ethToNil(input.creator) : input.creator
      const replicas = Number.isFinite(input.replication) && input.replication > 0 ? input.replication : 1
      const serviceHint = `General:owner=${creator}:replicas=${replicas}`
      const response = await fetch(`${appConfig.gatewayBase}/gateway/create-deal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creator,
          cid: input.cid,
          size_bytes: input.size,
          duration_blocks: input.duration,
          service_hint: serviceHint,
          initial_escrow: input.initialEscrow,
          max_monthly_spend: input.maxMonthlySpend,
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
