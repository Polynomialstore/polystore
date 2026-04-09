import { useCallback, useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import { encodeFunctionData, type Hex } from 'viem'
import { POLYSTORE_PRECOMPILE_ABI } from '../lib/polystorePrecompile'
import { appConfig } from '../config'
import { classifyPolyfsCommitError } from '../lib/polyfsCommitError'
import { waitForTransactionReceipt } from '../lib/evmRpc'
import { resolveActiveEvmAddress } from '../lib/walletAddress'

interface DirectCommitOptions {
  dealId: string; // The deal ID (string representation of uint64)
  previousManifestRoot: string; // Previous committed manifest root or empty on first commit
  manifestRoot: string; // The canonical 0x-prefixed hex string
  fileSize: number; // Size in bytes
  totalMdus: number;
  witnessMdus: number;
  onSuccess?: (txHash: string) => void;
  onError?: (error: Error) => void;
}

export function useDirectCommit() {
  const { address: connectedAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [hash, setHash] = useState<Hex | undefined>(undefined)
  const [isPending, setIsPending] = useState(false)
  const [isConfirming, setIsConfirming] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const commitContent = useCallback(async (options: DirectCommitOptions) => {
    const { dealId, previousManifestRoot, manifestRoot, fileSize, totalMdus, witnessMdus } = options

    // Ensure manifestRoot is bytes (0x prefixed)
    const formattedPreviousRoot = previousManifestRoot
      ? (previousManifestRoot.startsWith('0x') ? previousManifestRoot : `0x${previousManifestRoot}`)
      : '0x'
    const formattedRoot = manifestRoot.startsWith('0x') ? manifestRoot : `0x${manifestRoot}`

    const totalMdusInt = Math.max(0, Number(totalMdus))
    const witnessMdusInt = Math.max(0, Number(witnessMdus))
    if (!Number.isFinite(totalMdusInt) || totalMdusInt <= 0) {
      throw new Error('Commit requires totalMdus > 0')
    }
    if (!Number.isFinite(witnessMdusInt) || witnessMdusInt < 0) {
      throw new Error('Commit requires witnessMdus >= 0')
    }
    if (totalMdusInt <= 1 + witnessMdusInt) {
      throw new Error('Commit requires totalMdus > 1 + witnessMdus')
    }

    try {
      if (!walletClient) throw new Error('Wallet not connected')
      setError(null)
      setHash(undefined)
      setIsSuccess(false)
      setIsConfirming(false)
      setIsPending(true)

      const signer = resolveActiveEvmAddress({ connectedAddress, creator: walletClient.account?.address })
      const data = encodeFunctionData({
        abi: POLYSTORE_PRECOMPILE_ABI,
        functionName: 'updateDealContent',
        args: [
          BigInt(dealId),
          formattedPreviousRoot as Hex,
          formattedRoot as Hex,
          BigInt(fileSize),
          BigInt(totalMdusInt),
          BigInt(witnessMdusInt),
        ],
      })

      const txHash = await walletClient.sendTransaction({
        account: signer as Hex,
        to: appConfig.polystorePrecompile as Hex,
        data,
        gas: 5_000_000n,
        chain: walletClient.chain ?? undefined,
      })

      setHash(txHash)
      setIsPending(false)
      setIsConfirming(true)
      await waitForTransactionReceipt(txHash)
      setIsConfirming(false)
      setIsSuccess(true)
      options.onSuccess?.(String(txHash))
    } catch (e) {
      const classified = classifyPolyfsCommitError(e)
      const error = new Error(classified.message)
      setIsPending(false)
      setIsConfirming(false)
      setIsSuccess(false)
      setError(error)
      options.onError?.(error)
      throw error
    }
  }, [connectedAddress, walletClient])

  return {
    commitContent,
    isPending,      // Waiting for wallet signature
    isConfirming,   // Waiting for block inclusion
    isSuccess,      // Transaction confirmed
    hash,
    error,
  }
}
