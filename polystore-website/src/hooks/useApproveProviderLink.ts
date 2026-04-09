import { useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { Hex } from 'viem'

import { appConfig } from '../config'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { encodeApproveProviderLinkData } from '../lib/polystorePrecompile'
import { resolveActiveEvmAddress } from '../lib/walletAddress'
import { classifyWalletError } from '../lib/walletErrors'

export interface ApproveProviderLinkInput {
  creator?: string
  provider: string
}

export function useApproveProviderLink() {
  const { address: connectedAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function approveProviderLink(input: ApproveProviderLinkInput) {
    setLoading(true)
    setLastTx(null)
    try {
      if (!walletClient) throw new Error('Wallet not connected')

      const provider = String(input.provider || '').trim()
      if (!provider) {
        throw new Error('provider is required')
      }

      const evmAddress = resolveActiveEvmAddress({ connectedAddress, creator: input.creator })
      const txHash = await walletClient.sendTransaction({
        account: evmAddress as Hex,
        to: appConfig.polystorePrecompile as Hex,
        data: encodeApproveProviderLinkData(provider),
        gas: 2_000_000n,
      })

      setLastTx(txHash)
      await waitForTransactionReceipt(txHash)

      return {
        status: 'success' as const,
        tx_hash: txHash,
        provider,
        operator_evm: evmAddress,
      }
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

  return { approveProviderLink, loading, lastTx }
}
