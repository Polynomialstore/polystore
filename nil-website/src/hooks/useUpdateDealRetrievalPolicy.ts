import { useState } from 'react'
import { encodeFunctionData, numberToHex, type Hex } from 'viem'
import { appConfig } from '../config'
import { NILSTORE_PRECOMPILE_ABI } from '../lib/nilstorePrecompile'
import { waitForTransactionReceipt } from '../lib/evmRpc'

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
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)

  async function submitPolicyUpdate(input: UpdateDealRetrievalPolicyInput) {
    setLoading(true)
    setLastTx(null)
    try {
      const evmAddress = String(input.creator || '')
      if (!evmAddress.startsWith('0x')) throw new Error('EVM address required')
      const ethereum = window.ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }
      const mode = Number(input.mode)
      if (!Number.isFinite(mode) || mode < 1 || mode > 5) {
        throw new Error('mode must be 1..5')
      }

      const allowlistRoot = (input.allowlistRoot || ZERO_BYTES32) as Hex
      const voucherSigner = (input.voucherSigner || ZERO_ADDRESS) as Hex

      const data = encodeFunctionData({
        abi: NILSTORE_PRECOMPILE_ABI,
        functionName: 'updateDealRetrievalPolicy',
        args: [BigInt(input.dealId), mode, allowlistRoot, voucherSigner],
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

  return { submitPolicyUpdate, loading, lastTx }
}

