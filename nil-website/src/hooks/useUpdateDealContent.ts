import { useState } from 'react'
import { appConfig } from '../config'
import { encodeFunctionData, numberToHex, type Hex } from 'viem'
import { NILSTORE_PRECOMPILE_ABI } from '../lib/nilstorePrecompile'
import { waitForTransactionReceipt } from '../lib/evmRpc'

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
      const evmAddress = String(input.creator || '')
      if (!evmAddress.startsWith('0x')) throw new Error('EVM address required')
      const ethereum = window.ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }
      const manifestRoot = String(input.cid || '').trim() as Hex
      const data = encodeFunctionData({
        abi: NILSTORE_PRECOMPILE_ABI,
        functionName: 'updateDealContent',
        args: [BigInt(input.dealId), manifestRoot, BigInt(input.sizeBytes)],
      })

      const txHash = (await ethereum.request({
        method: 'eth_sendTransaction',
        params: [{ from: evmAddress, to: appConfig.nilstorePrecompile, data, gas: numberToHex(3_000_000) }],
      })) as Hex
      setLastTx(txHash)
      await waitForTransactionReceipt(txHash)
      return { status: 'success', tx_hash: txHash }
    } finally {
      setLoading(false)
    }
  }

  return { submitUpdate, loading, lastTx }
}
