import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import type { Hex } from 'viem'
import { appConfig } from '../config'
import { ethToPolystoreAddress } from '../lib/address'
import { decodeComputeRetrievalSessionIdsResult, encodeConfirmRetrievalSessionsData, encodeRetrievalV2Data, type RetrievalSessionV2Input } from '../lib/polystorePrecompile'
import { account, fetchPinnedGeneration, type FrozenSession, type PinnedGeneration, type RetrievalWindow, u64, uint, unhex } from '../lib/retrieval'
import { waitForRetrievalChallenge } from '../lib/retrievalFlow'
import type { SponsoredRetrievalAuth } from './useFetch'

let lastBrowserNonce = 0n

// One wallet transaction per bounded wave. Session identities stay ordered, even
// when the same provider serves several MDUs; no provider-keyed ID deduplication.
export function useRetrievalSessions() {
  const { address } = useAccount()
  const { data: wallet } = useWalletClient()
  const client = usePublicClient({ chainId: appConfig.chainId })
  const requireWallet = () => {
    if (!address || !wallet || !client) throw new Error('connect a wallet before retrieval')
    return { address, wallet, client, owner: ethToPolystoreAddress(address) }
  }
  const transact = async (data: Hex, signal?: AbortSignal) => {
    const { address, wallet, client } = requireWallet()
    signal?.throwIfAborted()
    const hash = await wallet.sendTransaction({ account: address, to: appConfig.polystorePrecompile as Hex, data })
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || receipt.blockNumber <= 0n) throw new Error('retrieval transaction did not commit successfully')
    signal?.throwIfAborted()
  }
  return {
    requireWallet,
    async open(pin: PinnedGeneration, windows: readonly RetrievalWindow[], auth: SponsoredRetrievalAuth = { type: 'none' }, signal?: AbortSignal, authorizedProofProvider?: string): Promise<FrozenSession[]> {
      const { address, client, owner } = requireWallet()
      if (!owner || !windows.length || windows.length > 64) throw new Error('invalid retrieval wave')
      const deputy = authorizedProofProvider === undefined ? undefined : account(authorizedProofProvider)
      const deadline = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])])
      // Refresh before funding, preserving the original generation pin. A later
      // content update can never silently replace the authenticated FAT/root.
      const current = await fetchPinnedGeneration(appConfig.lcdBase, appConfig.cosmosChainId, pin.dealId.toString(), deadline)
      if (current.root !== pin.root || current.generation !== pin.generation || current.layout !== pin.layout || current.k !== pin.k || current.m !== pin.m || current.metadataMdus !== pin.metadataMdus || current.userMdus !== pin.userMdus || current.owner !== pin.owner || current.endHeight !== pin.endHeight || windows.some((w) => !current.assignments[w.slot]?.active || current.assignments[w.slot].provider !== w.provider)) throw new Error('committed generation or assignment changed before payment')
      const expiry = current.height + 512n < pin.endHeight ? current.height + 512n : pin.endHeight
      if (expiry < current.height + 4n) throw new Error('deal has insufficient response time')
      const clockNonce = BigInt(Date.now()) << 16n
      const nonce = clockNonce > lastBrowserNonce ? clockNonce : lastBrowserNonce + 1n
      lastBrowserNonce = nonce + BigInt(windows.length)
      const requests: RetrievalSessionV2Input[] = windows.map((w, i) => ({ dealId: pin.dealId, provider: w.provider, manifestRoot: pin.root, startMduIndex: w.mduIndex,
        startBlobIndex: w.startBlobIndex, blobCount: BigInt(w.blobCount), nonce: nonce + BigInt(i), expiresAt: expiry, authorizedProofProvider: deputy ?? w.provider }))
      const computed = await client.call({ account: address, to: appConfig.polystorePrecompile as Hex, data: encodeRetrievalV2Data('computeRetrievalSessionIds', requests) })
      if (!computed.data) throw new Error('missing retrieval session IDs')
      const ids = decodeComputeRetrievalSessionIdsResult(computed.data)
      if (ids.providers.length !== requests.length || ids.sessionIds.length !== requests.length || new Set(ids.sessionIds).size !== requests.length || ids.providers.some((p, i) => p !== requests[i].provider)) throw new Error('nonmatching retrieval session IDs')
      ids.sessionIds.forEach((id) => unhex(id, 32))
      const isOwner = owner === pin.owner
      if (auth.type === 'voucher' && requests.length !== 1) throw new Error('voucher must authorize exactly one legal window before payment')
      const voucher = auth.type === 'voucher' ? auth.voucher : undefined
      // UI number fields must remain exactly representable before conversion.
      const numberU64 = (n: number | undefined) => n === undefined ? 0n : u64(String(uint(n, Number.MAX_SAFE_INTEGER)))
      const sponsored = requests.map((r) => ({ ...r, maxTotalFee: 0n, authType: auth.type === 'allowlist' ? 1 : auth.type === 'voucher' ? 2 : 0,
        allowlistLeafIndex: auth.type === 'allowlist' ? uint(auth.leafIndex) : 0, allowlistMerklePath: auth.type === 'allowlist' ? auth.merklePath : [],
        voucherRedeemer: voucher?.redeemer ?? '', voucherProvider: voucher?.provider ?? '', voucherExpiresAt: numberU64(voucher?.expiresAt), voucherNonce: numberU64(voucher?.nonce), voucherSignature: voucher?.signature ?? '0x' as Hex }))
      await transact(encodeRetrievalV2Data(isOwner ? 'openRetrievalSessions' : 'openRetrievalSessionsSponsored', isOwner ? requests : sponsored), deadline)
      const result: FrozenSession[] = []
      for (let i = 0; i < windows.length; i++) result.push(await waitForRetrievalChallenge(appConfig.lcdBase, { sessionId: ids.sessionIds[i], pin, window: windows[i], owner, payee: deputy ?? windows[i].provider, funding: isOwner ? 1 : 2 }, deadline))
      return result
    },
    async confirm(sessions: readonly FrozenSession[], signal?: AbortSignal) {
      if (!sessions.length || sessions.length > 64) throw new Error('invalid confirmation wave')
      await transact(encodeConfirmRetrievalSessionsData(sessions.map((s) => s.sessionId)), signal)
    },
  }
}
