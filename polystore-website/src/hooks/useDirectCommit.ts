import { useCallback } from 'react'
import { useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import type { Hex } from 'viem'
import { POLYSTORE_PRECOMPILE_ABI } from '../lib/polystorePrecompile'
import { appConfig } from '../config'
import { classifyPolyfsCommitError } from '../lib/polyfsCommitError'

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
  const { data: hash, writeContractAsync, isPending, error: writeError } = useWriteContract()
  
  const { isLoading: isConfirming, isSuccess, error: receiptError } = useWaitForTransactionReceipt({
    hash,
  });

  const commitContent = useCallback(async (options: DirectCommitOptions) => {
    const { dealId, previousManifestRoot, manifestRoot, fileSize, totalMdus, witnessMdus } = options
    
    // Ensure manifestRoot is bytes (0x prefixed)
    const formattedPreviousRoot = previousManifestRoot
      ? (previousManifestRoot.startsWith('0x') ? previousManifestRoot : `0x${previousManifestRoot}`)
      : '0x'
    const formattedRoot = manifestRoot.startsWith('0x') ? manifestRoot : `0x${manifestRoot}`;

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
      const txHash = await writeContractAsync({
        address: appConfig.polystorePrecompile as Hex,
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
      options.onSuccess?.(String(txHash))
    } catch (e) {
      const classified = classifyPolyfsCommitError(e)
      const error = new Error(classified.message)
      options.onError?.(error)
      throw error
    }
  }, [writeContractAsync]);

  const normalizedError = (() => {
    const raw = writeError || receiptError
    if (!raw) return null
    const classified = classifyPolyfsCommitError(raw)
    return new Error(classified.message)
  })()

  return {
    commitContent,
    isPending,      // Waiting for wallet signature
    isConfirming,   // Waiting for block inclusion
    isSuccess,      // Transaction confirmed
    hash,
    error: normalizedError,
  };
}
