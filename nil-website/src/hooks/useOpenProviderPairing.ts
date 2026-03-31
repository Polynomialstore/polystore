import { useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { Hex } from 'viem'
import { appConfig } from '../config'
import { ethToNil } from '../lib/address'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { encodeOpenProviderPairingData } from '../lib/nilstorePrecompile'
import { resolveActiveEvmAddress } from '../lib/walletAddress'
import { classifyWalletError } from '../lib/walletErrors'

export interface OpenProviderPairingInput {
  creator?: string
  pairingId: string
  expiresAt: number
}

export function useOpenProviderPairing() {
  const { address: connectedAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function openPairing(input: OpenProviderPairingInput) {
    setLoading(true)
    setLastTx(null)
    try {
      if (!walletClient) throw new Error('Wallet not connected')

      const pairingId = String(input.pairingId || '').trim()
      if (!pairingId) {
        throw new Error('pairingId is required')
      }

      const expiresAt = Math.max(0, Math.floor(Number(input.expiresAt) || 0))
      if (expiresAt <= 0) {
        throw new Error('expiresAt must be greater than 0')
      }

      const evmAddress = resolveActiveEvmAddress({ connectedAddress, creator: input.creator })
      const txHash = await walletClient.sendTransaction({
        account: evmAddress as Hex,
        to: appConfig.nilstorePrecompile as Hex,
        data: encodeOpenProviderPairingData(pairingId, BigInt(expiresAt)),
        gas: 2_000_000n,
      })

      setLastTx(txHash)
      await waitForTransactionReceipt(txHash)

      return {
        status: 'success' as const,
        tx_hash: txHash,
        pairing_id: pairingId,
        operator: ethToNil(evmAddress),
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

  return { openPairing, loading, lastTx }
}
