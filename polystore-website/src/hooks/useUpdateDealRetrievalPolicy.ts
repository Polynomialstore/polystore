import { useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { encodeFunctionData, type Hex } from 'viem'
import { appConfig } from '../config'
import { POLYSTORE_PRECOMPILE_ABI } from '../lib/polystorePrecompile'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { resolveActiveEvmAddress } from '../lib/walletAddress'
import { classifyWalletError } from '../lib/walletErrors'

export type RetrievalPolicyMode = 1 | 2 | 3 | 4 | 5

export interface UpdateDealRetrievalPolicyInput {
  creator: string
  dealId: number
  mode: RetrievalPolicyMode
  allowlistRoot?: Hex
  voucherSigner?: Hex
}

const ZERO_BYTES32 = '0x' + '00'.repeat(32)
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function useUpdateDealRetrievalPolicy() {
  const { address: connectedAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function submitPolicyUpdate(input: UpdateDealRetrievalPolicyInput) {
    setLoading(true)
    setLastTx(null)
    try {
      if (!walletClient) throw new Error('Wallet not connected')
      const evmAddress = resolveActiveEvmAddress({ connectedAddress, creator: input.creator })
      const mode = Number(input.mode)
      if (!Number.isFinite(mode) || mode < 1 || mode > 5) {
        throw new Error('mode must be 1..5')
      }

      const allowlistRoot = (input.allowlistRoot || ZERO_BYTES32) as Hex
      const voucherSigner = (input.voucherSigner || ZERO_ADDRESS) as Hex

      const data = encodeFunctionData({
        abi: POLYSTORE_PRECOMPILE_ABI,
        functionName: 'updateDealRetrievalPolicy',
        args: [BigInt(input.dealId), mode, allowlistRoot, voucherSigner],
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

  return { submitPolicyUpdate, loading, lastTx }
}
