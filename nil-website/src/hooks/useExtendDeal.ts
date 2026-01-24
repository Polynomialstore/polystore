import { useState } from 'react'
import { encodeFunctionData, numberToHex, type Hex } from 'viem'
import { appConfig } from '../config'
import { NILSTORE_PRECOMPILE_ABI } from '../lib/nilstorePrecompile'
import { waitForTransactionReceipt } from '../lib/evmRpc'

export interface ExtendDealInput {
  creator: string
  dealId: number
  additionalDurationBlocks: number
}

export function useExtendDeal() {
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function submitExtend(input: ExtendDealInput) {
    setLoading(true)
    setLastTx(null)
    try {
      const evmAddress = String(input.creator || '')
      if (!evmAddress.startsWith('0x')) throw new Error('EVM address required')
      const ethereum = window.ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }
      const additional = Math.max(0, Number(input.additionalDurationBlocks || 0))
      if (!Number.isFinite(additional) || additional <= 0) {
        throw new Error('additionalDurationBlocks must be > 0')
      }

      const data = encodeFunctionData({
        abi: NILSTORE_PRECOMPILE_ABI,
        functionName: 'extendDeal',
        args: [BigInt(input.dealId), BigInt(additional)],
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

  return { submitExtend, loading, lastTx }
}
