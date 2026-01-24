import { useState } from 'react'
import { encodeFunctionData, numberToHex, type Hex } from 'viem'
import { appConfig } from '../config'
import { NILSTORE_PRECOMPILE_ABI } from '../lib/nilstorePrecompile'
import { waitForTransactionReceipt } from '../lib/evmRpc'

export interface CancelRetrievalSessionInput {
  creator: string
  sessionId: Hex
}

export function useCancelRetrievalSession() {
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function submitCancel(input: CancelRetrievalSessionInput) {
    setLoading(true)
    setLastTx(null)
    try {
      const evmAddress = String(input.creator || '')
      if (!evmAddress.startsWith('0x')) throw new Error('EVM address required')
      const ethereum = window.ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }
      const sessionId = String(input.sessionId || '').trim() as Hex
      if (!sessionId.startsWith('0x') || sessionId.length !== 66) {
        throw new Error('sessionId must be a 32-byte 0x-prefixed hex string')
      }

      const data = encodeFunctionData({
        abi: NILSTORE_PRECOMPILE_ABI,
        functionName: 'cancelRetrievalSession',
        args: [sessionId],
      })

      const txHash = (await ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: evmAddress, to: appConfig.nilstorePrecompile, data, gas: numberToHex(2_000_000) }],
      })) as Hex
      setLastTx(txHash)
      await waitForTransactionReceipt(txHash)
      return { status: 'success', tx_hash: txHash }
    } finally {
      setLoading(false)
    }
  }

  return { submitCancel, loading, lastTx }
}

