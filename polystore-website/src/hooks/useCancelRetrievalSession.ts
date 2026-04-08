import { useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { encodeFunctionData, type Hex } from 'viem'
import { appConfig } from '../config'
import { NILSTORE_PRECOMPILE_ABI } from '../lib/nilstorePrecompile'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { resolveActiveEvmAddress } from '../lib/walletAddress'
import { classifyWalletError } from '../lib/walletErrors'

export interface CancelRetrievalSessionInput {
  creator: string
  sessionId: Hex
}

export function useCancelRetrievalSession() {
  const { address: connectedAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function submitCancel(input: CancelRetrievalSessionInput) {
    setLoading(true)
    setLastTx(null)
    try {
      if (!walletClient) throw new Error('Wallet not connected')
      const evmAddress = resolveActiveEvmAddress({ connectedAddress, creator: input.creator })
      const sessionId = String(input.sessionId || '').trim() as Hex
      if (!sessionId.startsWith('0x') || sessionId.length !== 66) {
        throw new Error('sessionId must be a 32-byte 0x-prefixed hex string')
      }

      const data = encodeFunctionData({
        abi: NILSTORE_PRECOMPILE_ABI,
        functionName: 'cancelRetrievalSession',
        args: [sessionId],
      })

      const txHash = await walletClient.sendTransaction({
        account: evmAddress as Hex,
        to: appConfig.nilstorePrecompile as Hex,
        data,
        gas: 2_000_000n,
      })
      setLastTx(txHash)
      await waitForTransactionReceipt(txHash)
      return { status: 'success', tx_hash: txHash }
    } catch (error) {
      const walletError = classifyWalletError(error)
      if (walletError.reconnectSuggested) {
        throw new Error(walletError.message)
      }
      throw error
    } finally {
      setLoading(false)
    }
  }

  return { submitCancel, loading, lastTx }
}
