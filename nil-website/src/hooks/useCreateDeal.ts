import { useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { appConfig } from '../config'
import { decodeEventLog, encodeFunctionData, type Hex } from 'viem'
import { NILSTORE_PRECOMPILE_ABI } from '../lib/nilstorePrecompile'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { buildServiceHint } from '../lib/serviceHint'
import { resolveActiveEvmAddress } from '../lib/walletAddress'
import { classifyWalletError } from '../lib/walletErrors'

export interface CreateDealInput {
  creator: string
  durationSeconds: number
  initialEscrow: string
  maxMonthlySpend: string
  serviceHint?: string
}

export function useCreateDeal() {
  const { address: connectedAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function submitDeal(input: CreateDealInput) {
    setLoading(true)
    setLastTx(null)
    try {
      if (!walletClient) throw new Error('Wallet not connected')
      const evmAddress = resolveActiveEvmAddress({ connectedAddress, creator: input.creator })
      const serviceHint = input.serviceHint && input.serviceHint.trim().length > 0
        ? input.serviceHint.trim()
        : buildServiceHint('General', { rsK: appConfig.defaultRsK, rsM: appConfig.defaultRsM })

      const durationSeconds = Math.max(1, Number(input.durationSeconds) || 0)
      const data = encodeFunctionData({
        abi: NILSTORE_PRECOMPILE_ABI,
        functionName: 'createDeal',
        args: [
          BigInt(durationSeconds),
          serviceHint,
          BigInt(String(input.initialEscrow || '0')),
          BigInt(String(input.maxMonthlySpend || '0')),
        ],
      })

      const txHash = await walletClient.sendTransaction({
        account: evmAddress as Hex,
        to: appConfig.nilstorePrecompile as Hex,
        data,
        gas: 5_000_000n,
      })
      setLastTx(txHash)

      const receipt = await waitForTransactionReceipt(txHash)
      const logs = receipt.logs || []
      for (const log of logs) {
        if (String(log.address || '').toLowerCase() !== appConfig.nilstorePrecompile.toLowerCase()) continue
        try {
          const decoded = decodeEventLog({
            abi: NILSTORE_PRECOMPILE_ABI,
            eventName: 'DealCreated',
            topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
            data: log.data,
          })
          const dealId = (decoded.args as { dealId: bigint }).dealId
          return { status: 'success', tx_hash: txHash, deal_id: String(dealId) }
        } catch {
          continue
        }
      }
      throw new Error('createDeal tx confirmed but DealCreated event not found')
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

  return { submitDeal, loading, lastTx }
}
