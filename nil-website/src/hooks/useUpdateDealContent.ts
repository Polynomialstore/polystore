import { useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { appConfig } from '../config'
import { encodeFunctionData, type Hex } from 'viem'
import { NILSTORE_PRECOMPILE_ABI } from '../lib/nilstorePrecompile'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { resolveActiveEvmAddress } from '../lib/walletAddress'
import { classifyWalletError } from '../lib/walletErrors'

export interface UpdateDealContentInput {
  creator: string
  dealId: number
  previousManifestRoot: string
  cid: string
  sizeBytes: number
  totalMdus: number
  witnessMdus: number
}

export function useUpdateDealContent() {
  const { address: connectedAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function submitUpdate(input: UpdateDealContentInput) {
    setLoading(true)
    setLastTx(null)
    try {
      if (!walletClient) throw new Error('Wallet not connected')
      const evmAddress = resolveActiveEvmAddress({ connectedAddress, creator: input.creator })
      const previousManifestRoot = (
        String(input.previousManifestRoot || '').trim() || '0x'
      ) as Hex
      const manifestRoot = String(input.cid || '').trim() as Hex
      const totalMdus = Number(input.totalMdus)
      const witnessMdus = Number(input.witnessMdus)
      if (!Number.isFinite(totalMdus) || totalMdus <= 0) throw new Error('totalMdus must be > 0')
      if (!Number.isFinite(witnessMdus) || witnessMdus < 0) throw new Error('witnessMdus must be >= 0')
      if (totalMdus <= 1 + witnessMdus) throw new Error('totalMdus must be > 1 + witnessMdus')
      const data = encodeFunctionData({
        abi: NILSTORE_PRECOMPILE_ABI,
        functionName: 'updateDealContent',
        args: [
          BigInt(input.dealId),
          previousManifestRoot,
          manifestRoot,
          BigInt(input.sizeBytes),
          BigInt(totalMdus),
          BigInt(witnessMdus),
        ],
      })

      const txHash = await walletClient.sendTransaction({
        account: evmAddress as Hex,
        to: appConfig.nilstorePrecompile as Hex,
        data,
        gas: 3_000_000n,
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

  return { submitUpdate, loading, lastTx }
}
