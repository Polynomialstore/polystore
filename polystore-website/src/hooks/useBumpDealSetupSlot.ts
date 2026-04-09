import { useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { decodeEventLog, encodeFunctionData, type Hex } from 'viem'
import { POLYSTORE_PRECOMPILE_ABI } from '../lib/polystorePrecompile'
import { appConfig } from '../config'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { resolveActiveEvmAddress } from '../lib/walletAddress'
import { classifyWalletError } from '../lib/walletErrors'

export interface BumpDealSetupSlotInput {
  dealId: string
  slot: number
  expectedProvider?: string
}

export type BumpDealSetupSlotPhase = 'idle' | 'awaiting_wallet' | 'confirming'

export interface BumpDealSetupSlotResult {
  txHash: `0x${string}`
  newProvider: string | null
}

export function useBumpDealSetupSlot() {
  const { address: connectedAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)
  const [lastNewProvider, setLastNewProvider] = useState<string | null>(null)
  const [phase, setPhase] = useState<BumpDealSetupSlotPhase>('idle')
  const [error, setError] = useState<Error | null>(null)

  async function bumpSetupSlot(input: BumpDealSetupSlotInput): Promise<BumpDealSetupSlotResult> {
    setLoading(true)
    setLastTx(null)
    setLastNewProvider(null)
    setError(null)
    setPhase('awaiting_wallet')
    try {
      if (!walletClient) throw new Error('Wallet not connected')

      const signer = resolveActiveEvmAddress({
        connectedAddress,
        creator: walletClient.account?.address,
      })
      const data = encodeFunctionData({
        abi: POLYSTORE_PRECOMPILE_ABI,
        functionName: 'bumpDealSetupSlot',
        args: [
          BigInt(input.dealId),
          input.slot,
          String(input.expectedProvider || '').trim(),
        ],
      })

      const txHash = await walletClient.sendTransaction({
        account: signer as Hex,
        to: appConfig.polystorePrecompile as Hex,
        data,
        gas: 5_000_000n,
        chain: walletClient.chain ?? undefined,
      })
      setLastTx(txHash)
      setPhase('confirming')

      const receipt = await waitForTransactionReceipt(txHash)
      let newProvider: string | null = null
      for (const log of receipt.logs || []) {
        if (String(log.address || '').toLowerCase() !== appConfig.polystorePrecompile.toLowerCase()) continue
        try {
          const decoded = decodeEventLog({
            abi: POLYSTORE_PRECOMPILE_ABI,
            eventName: 'DealSetupSlotBumped',
            topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
            data: log.data,
          })
          const args = decoded.args as { newProvider?: string }
          if (typeof args.newProvider === 'string' && args.newProvider.trim()) {
            newProvider = args.newProvider.trim()
            break
          }
        } catch {
          continue
        }
      }
      setLastNewProvider(newProvider)
      return { txHash, newProvider }
    } catch (error) {
      const walletError = classifyWalletError(error, 'Setup slot bump failed')
      const normalized = new Error(walletError.message)
      setError(normalized)
      throw normalized
    } finally {
      setLoading(false)
      setPhase('idle')
    }
  }

  return {
    bumpSetupSlot,
    loading,
    lastTx,
    lastNewProvider,
    phase,
    error,
  }
}
