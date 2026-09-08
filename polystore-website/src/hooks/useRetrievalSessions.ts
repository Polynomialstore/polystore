import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'
import { appConfig } from '../config'
import { ethToPolystoreAddress } from '../lib/address'
import { decodeComputeRetrievalSessionIdsResult, encodeConfirmRetrievalSessionsData, encodeRetrievalV2Data, type RetrievalSessionV2Input } from '../lib/polystorePrecompile'
import { account, fetchFrozenSession, fetchActiveRetrievalGeneration, fetchRetrievalAvailability, type FrozenSession, type PinnedGeneration, type RetrievalWindow, u64, uint, unhex } from '../lib/retrieval'
import { waitForRetrievalChallenge } from '../lib/retrievalFlow'
import type { SponsoredRetrievalAuth } from './useFetch'
import { assertRetrievalWalletScope, browserRetrievalStore, retrievalIntentKey, retrievalGasLimit, settleBrowserTransaction, withRetrievalLock } from '../lib/retrievalTransactions'

let lastBrowserNonce = 0n

// One wallet transaction per bounded wave. Session identities stay ordered, even
// when the same provider serves several MDUs; no provider-keyed ID deduplication.
export function useRetrievalSessions() {
  const { address } = useAccount()
  const { data: wallet } = useWalletClient()
  const client = usePublicClient({ chainId: appConfig.chainId })
  const activation = useQuery({
    queryKey: ['retrieval-activation', appConfig.lcdBase],
    queryFn: ({ signal }) => fetchRetrievalAvailability(appConfig.lcdBase, undefined, AbortSignal.any([signal, AbortSignal.timeout(15_000)])),
    refetchInterval: 15_000, retry: false,
  })
  const requireWallet = () => {
    if (!address || !wallet || !client) throw new Error('connect a wallet before retrieval')
    assertRetrievalWalletScope(appConfig.chainId, wallet.chain?.id, client.chain?.id)
    return { address, wallet, client, owner: ethToPolystoreAddress(address) }
  }
  const scope = () => {
    const { address } = requireWallet()
    return [appConfig.cosmosChainId, appConfig.chainId, appConfig.polystorePrecompile.toLowerCase(), address.toLowerCase()]
  }
  const observed = (session: FrozenSession, signal: AbortSignal) => fetchFrozenSession(appConfig.lcdBase, {
    sessionId: session.sessionId, pin: session.pin, window: session.window, owner: session.owner,
    payee: session.payee, funding: session.funding as 1 | 2,
  }, signal)
  return {
    requireWallet, scope,
    unavailableReason: activation.error ? 'Cannot verify network retrieval availability. Check the chain connection.' : activation.data === undefined ? 'Checking network retrieval availability…' : activation.data,
    async open(pin: PinnedGeneration, windows: readonly RetrievalWindow[], auth: SponsoredRetrievalAuth = { type: 'none' }, signal?: AbortSignal, authorizedProofProvider?: string, recoveryKey = 'standalone'): Promise<FrozenSession[]> {
      const { address, wallet, client, owner } = requireWallet()
      if (!owner || !windows.length || windows.length > 64) throw new Error('invalid retrieval wave')
      const deputy = authorizedProofProvider === undefined ? undefined : account(authorizedProofProvider)
      const deadline = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])])
      // Refresh before funding, preserving the original generation pin. A later
      // content update can never silently replace the authenticated FAT/root.
      const current = await fetchActiveRetrievalGeneration(appConfig.lcdBase, appConfig.cosmosChainId, pin.dealId.toString(), deadline)
      if (current.root !== pin.root || current.generation !== pin.generation || current.layout !== pin.layout || current.k !== pin.k || current.m !== pin.m || current.metadataMdus !== pin.metadataMdus || current.userMdus !== pin.userMdus || current.owner !== pin.owner || current.endHeight !== pin.endHeight || windows.some((w) => !current.assignments[w.slot]?.active || current.assignments[w.slot].provider !== w.provider)) throw new Error('committed generation or assignment changed before payment')
      const key = 'open:' + await retrievalIntentKey([scope(), recoveryKey, pin.dealId, pin.root, pin.generation, windows.map((w) => [w.mduIndex, w.startBlobIndex, w.blobCount, w.provider, w.slot]), deputy, auth])
      return withRetrievalLock(key, async () => {
        let gas = 0n
        const transaction = await settleBrowserTransaction({
          key, store: browserRetrievalStore(), signal: deadline,
          prepare: async () => {
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
            const data = encodeRetrievalV2Data(isOwner ? 'openRetrievalSessions' : 'openRetrievalSessionsSponsored', isOwner ? requests : sponsored)
            gas = retrievalGasLimit(await client.estimateGas({ account: address, to: appConfig.polystorePrecompile as Hex, data }))
            return { data, intent: { ids: ids.sessionIds, pin } }
          },
          send: (data) => wallet.sendTransaction({ chain: client.chain, account: address, to: appConfig.polystorePrecompile as Hex, data, gas }),
          receipt: (hash) => client.waitForTransactionReceipt({ hash, timeout: 120_000 }),
          reconcile: async (tx) => {
            const signal = AbortSignal.timeout(15_000)
            for (let i = 0; i < windows.length; i++) await fetchFrozenSession(appConfig.lcdBase, { sessionId: tx.intent.ids[i], pin: tx.intent.pin, window: windows[i], owner, payee: deputy ?? windows[i].provider, funding: owner === pin.owner ? 1 : 2 }, signal)
            return true
          },
        })
        const result: FrozenSession[] = []
        for (let i = 0; i < windows.length; i++) result.push(await waitForRetrievalChallenge(appConfig.lcdBase, { sessionId: transaction.intent.ids[i], pin: transaction.intent.pin, window: windows[i], owner, payee: deputy ?? windows[i].provider, funding: owner === pin.owner ? 1 : 2 }, deadline))
        return result.map((session) => ({ ...session, browserTransactionKey: key }))
      })
    },
    async confirm(sessions: readonly FrozenSession[], signal?: AbortSignal, recoveryKey = 'standalone') {
      if (!sessions.length || sessions.length > 64) throw new Error('invalid confirmation wave')
      const { address, wallet, client } = requireWallet()
      const key = 'ack:' + await retrievalIntentKey([scope(), recoveryKey, sessions.map((s) => s.sessionId)])
      let gas = 0n
      await withRetrievalLock(key, () => settleBrowserTransaction({
        key, store: browserRetrievalStore(), signal,
        prepare: async () => {
          const data = encodeConfirmRetrievalSessionsData(sessions.map((s) => s.sessionId))
          gas = retrievalGasLimit(await client.estimateGas({ account: address, to: appConfig.polystorePrecompile as Hex, data }))
          return { data, intent: sessions.map((s) => s.sessionId) }
        },
        send: (data) => wallet.sendTransaction({ chain: client.chain, account: address, to: appConfig.polystorePrecompile as Hex, data, gas }),
        receipt: (hash) => client.waitForTransactionReceipt({ hash, timeout: 120_000 }),
        reconcile: async () => {
          const deadline = AbortSignal.timeout(15_000)
          for (const session of sessions) { const fresh = await observed(session, deadline); if (fresh.status !== 3 && fresh.status !== 4) return false }
          return true
        },
      }))
    },
    async forget(sessions: readonly Pick<FrozenSession, 'sessionId' | 'browserTransactionKey'>[], recoveryKey: string) {
      const store = browserRetrievalStore()
      store.remove('ack:' + await retrievalIntentKey([scope(), recoveryKey, sessions.map((s) => s.sessionId)]))
      for (const session of sessions) if (session.browserTransactionKey) store.remove(session.browserTransactionKey)
    },
  }
}
