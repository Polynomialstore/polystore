import { useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { encodeFunctionData, type Hex } from 'viem'
import { appConfig } from '../config'
import { POLYSTORE_PRECOMPILE_ABI } from '../lib/polystorePrecompile'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { resolveActiveEvmAddress } from '../lib/walletAddress'
import { classifyWalletError } from '../lib/walletErrors'

export interface ExtendDealInput {
  creator: string
  dealId: number
  additionalDurationBlocks: number
}

export function useExtendDeal() {
  const { address: connectedAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function submitExtend(input: ExtendDealInput) {
    setLoading(true)
    setLastTx(null)
    try {
      if (!walletClient) throw new Error('Wallet not connected')
      const evmAddress = resolveActiveEvmAddress({ connectedAddress, creator: input.creator })
      const additional = Math.max(0, Number(input.additionalDurationBlocks || 0))
      if (!Number.isFinite(additional) || additional <= 0) {
        throw new Error('additionalDurationBlocks must be > 0')
      }

      const data = encodeFunctionData({
        abi: POLYSTORE_PRECOMPILE_ABI,
        functionName: 'extendDeal',
        args: [BigInt(input.dealId), BigInt(additional)],
      })

      const txHash = await walletClient.sendTransaction({
        account: evmAddress as Hex,
        to: appConfig.polystorePrecompile as Hex,
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

  return { submitExtend, loading, lastTx }
}
