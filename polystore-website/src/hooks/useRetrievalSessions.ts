import { retrievalDiagnostic, timeRetrieval } from '../lib/retrievalDiagnostics'
import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'
import { appConfig } from '../config'
import { ethToPolystoreAddress } from '../lib/address'
import { decodeComputeRetrievalSessionIdsResult, encodeAcknowledgeRetrievalObligationV3Data, encodeConfirmRetrievalSessionsData, encodeOpenRetrievalSessionV3Data, encodeOpenRetrievalSessionV3SponsoredData, encodeRefundRetrievalSessionV3Data, encodeRetrievalV2Data, type RetrievalSessionV2Input } from '../lib/polystorePrecompile'
import { account, fetchFrozenSession, fetchActiveRetrievalGeneration, fetchRetrievalAvailability, type FrozenSession, type PinnedGeneration, type RetrievalWindow, u64, uint, unhex } from '../lib/retrieval'
import { waitForRetrievalChallenge } from '../lib/retrievalFlow'
import type { SponsoredRetrievalAuth } from './useFetch'
import { assertRetrievalWalletScope, browserRetrievalStore, retrievalIntentKey, retrievalGasLimit, retrievalV3OpenTransactionKey, settleBrowserTransaction, withRetrievalLock } from '../lib/retrievalTransactions'
import { assertSponsoredPolicyV3, fetchActiveGenerationV3, fetchLatestNonceV3, fetchSessionIDByNonceV3, fetchSessionV3, prepareV3Binding, preserveV3BrowserTransactionKey, sameFrozenGenerationV3, sameFrozenRetrievalRequestV3, type FrozenGenerationV3, type FrozenSessionV3 } from '../lib/retrievalV3'
import type { RetrievalFile } from '../lib/retrieval'
import { workerClient } from '../lib/worker-client'
import { BLOB_SIZE_BYTES } from '../domain/polyfsLayout'
import { accountBytes } from '../lib/retrieval'
import { discardUnboundRetrievalV3Checkpoint } from '../lib/retrievalV3Checkpoint'

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
  const expectedV3 = (session: FrozenSessionV3) => ({ ...session, recordIndex: session.fileRecordIndex,
    frozenContextHash: session.contextHash, deadline: session.deadline, funding: session.funding,
    range: workerClient.retrievalV3Range, contextHash: workerClient.retrievalV3ContextHash,
    seed: workerClient.retrievalV3Seed, challenges: workerClient.retrievalV3Challenges })
  const observedV3 = async (session: FrozenSessionV3, signal?: AbortSignal) => preserveV3BrowserTransactionKey(session,
    await fetchSessionV3(appConfig.lcdBase, session.authority, expectedV3(session), signal))
  const readyV3 = async (initial: FrozenSessionV3, signal?: AbortSignal) => {
    let session = initial
    while (!session.anchorSeed || session.height < session.firstResponse) {
      signal?.throwIfAborted()
      if (session.expired || session.height > session.deadline) return session
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, 750)
        function done() { signal?.removeEventListener('abort', aborted); resolve() }
        function aborted() { clearTimeout(timer); reject(signal?.reason) }
        signal?.addEventListener('abort', aborted, { once: true })
      })
      session = await observedV3(session, signal)
    }
    return session
  }
  return {
    requireWallet, scope, observeV3: observedV3, readyV3,
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
        const transaction = await timeRetrieval('open_transaction', () => settleBrowserTransaction({
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
          send: (data) => timeRetrieval('open_send', () => wallet.sendTransaction({ chain: client.chain, account: address, to: appConfig.polystorePrecompile as Hex, data, gas })),
          receipt: (hash) => timeRetrieval('open_inclusion', () => client.waitForTransactionReceipt({ hash, timeout: 120_000 })),
          reconcile: async (tx) => {
            const signal = AbortSignal.timeout(15_000)
            for (let i = 0; i < windows.length; i++) await fetchFrozenSession(appConfig.lcdBase, { sessionId: tx.intent.ids[i], pin: tx.intent.pin, window: windows[i], owner, payee: deputy ?? windows[i].provider, funding: owner === pin.owner ? 1 : 2 }, signal)
            return true
          },
        }))
        const result: FrozenSession[] = []
        for (let i = 0; i < windows.length; i++) result.push(await timeRetrieval('challenge_ready', () => waitForRetrievalChallenge(appConfig.lcdBase, { sessionId: transaction.intent.ids[i], pin: transaction.intent.pin, window: windows[i], owner, payee: deputy ?? windows[i].provider, funding: owner === pin.owner ? 1 : 2 }, deadline), transaction.intent.ids[i]))
        for (const session of result) retrievalDiagnostic({ phase: 'challenge_height', sessionId: session.sessionId, height: String(session.height) })
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
        send: (data) => timeRetrieval('ack_send', () => wallet.sendTransaction({ chain: client.chain, account: address, to: appConfig.polystorePrecompile as Hex, data, gas })),
        receipt: (hash) => timeRetrieval('ack_inclusion', () => client.waitForTransactionReceipt({ hash, timeout: 120_000 })),
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
    async openV3(authority: FrozenGenerationV3, recordIndex: number, file: RetrievalFile, rangeStart: bigint, rangeLength: bigint,
      auth: SponsoredRetrievalAuth = { type: 'none' }, signal?: AbortSignal): Promise<FrozenSessionV3> {
      const { address, wallet, client, owner } = requireWallet()
      const deadline = AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])])
      const ownerDeal = await retrievalV3OpenTransactionKey(scope(), owner, authority.dealId)
      return withRetrievalLock(ownerDeal, async () => {
        const store = browserRetrievalStore()
        let gas = 0n
        const transaction = await settleBrowserTransaction({
          key: ownerDeal, store, signal: deadline,
          prepare: async () => {
            const current = await fetchActiveGenerationV3(appConfig.lcdBase, authority.chainId, authority.dealId.toString(), deadline)
            if (!current || !sameFrozenGenerationV3(current, authority)) throw new Error('committed v3 generation changed before payment')
            assertSponsoredPolicyV3(authority, owner, auth.type)
            const latest = await fetchLatestNonceV3(appConfig.lcdBase, owner, authority.dealId, deadline)
            if (latest.nonce === (1n << 64n) - 1n) throw new Error('v3 retrieval nonce exhausted')
            const nonce = latest.found ? latest.nonce + 1n : 1n
            const binding = await prepareV3Binding(workerClient, authority, owner, recordIndex, file, rangeStart, rangeLength, nonce)
            const expiry = latest.height + 4096n < authority.dealEnd ? latest.height + 4096n : authority.dealEnd
            if (expiry < latest.height + 4n) throw new Error('deal has insufficient response time')
            const request = { dealId: authority.dealId, generation: authority.generation,
              range: { fileRecordIndex: recordIndex, fileStartOffset: file.start_offset, fileLength: file.size_bytes, rangeStart, rangeLength }, nonce, deadlineHeight: expiry }
            let data: Hex
            if (owner === authority.owner) data = encodeOpenRetrievalSessionV3Data(request)
            else {
              if (auth.maxTotalFee === undefined || auth.maxTotalFee <= 0n) throw new Error('sponsored v3 retrieval requires a positive explicit maximum fee')
              if (auth.type === 'voucher' && (binding.obligations.length !== 1 || binding.obligations[0].blobCount !== 1n)) throw new Error('voucher must authorize exactly one v3 blob')
              const voucher = auth.type === 'voucher' ? auth.voucher : undefined
              const first = binding.range.first, offset = first % 64n
              const slot = Number(offset % 8n), leaf = slot * 8 + Number(offset / 8n)
              data = encodeOpenRetrievalSessionV3SponsoredData({ ...request, maxTotalFee: auth.maxTotalFee,
                authType: auth.type === 'allowlist' ? 1 : auth.type === 'voucher' ? 2 : 0, allowlistLeafIndex: auth.type === 'allowlist' ? uint(auth.leafIndex) : 0,
                allowlistMerklePath: auth.type === 'allowlist' ? auth.merklePath : [], voucherRedeemer: voucher?.redeemer ?? '',
                voucherManifestRoot: authority.polyfsRoot, voucherProvider: voucher?.provider ?? '',
                voucherStartMduIndex: authority.metadataMdus + first / 64n, voucherStartBlobIndex: leaf,
                voucherBlobCount: binding.obligations[0]?.blobCount ?? 0n, voucherExpiresAt: voucher ? u64(String(uint(voucher.expiresAt, Number.MAX_SAFE_INTEGER))) : 0n,
                voucherNonce: voucher ? u64(String(uint(voucher.nonce, Number.MAX_SAFE_INTEGER))) : 0n, voucherSignature: voucher?.signature ?? '0x' })
            }
            gas = retrievalGasLimit(await client.estimateGas({ account: address, to: appConfig.polystorePrecompile as Hex, data }))
            return { data, intent: { authority, recordIndex, file, rangeStart, rangeLength, nonce, expiry, binding } }
          },
          send: (data) => wallet.sendTransaction({ chain: client.chain, account: address, to: appConfig.polystorePrecompile as Hex, data, gas }),
          receipt: (hash) => client.waitForTransactionReceipt({ hash, timeout: 120_000 }),
          reconcile: async (tx) => (await fetchSessionIDByNonceV3(appConfig.lcdBase, owner, tx.intent.authority.dealId, tx.intent.nonce, AbortSignal.timeout(15_000))) === tx.intent.binding.sessionId,
        })
        const expected = { sessionId: transaction.intent.binding.sessionId, owner, recordIndex: transaction.intent.recordIndex,
          file: transaction.intent.file, rangeStart: transaction.intent.rangeStart, rangeLength: transaction.intent.rangeLength,
          nonce: transaction.intent.nonce, planHash: transaction.intent.binding.planHash, deadline: transaction.intent.expiry,
          funding: owner === transaction.intent.authority.owner ? 1 as const : 2 as const, range: workerClient.retrievalV3Range,
          contextHash: workerClient.retrievalV3ContextHash, seed: workerClient.retrievalV3Seed, challenges: workerClient.retrievalV3Challenges }
        if (!sameFrozenRetrievalRequestV3(transaction.intent, { authority, recordIndex, file, rangeStart, rangeLength })) {
          throw new Error('another frozen v3 retrieval for this owner and deal must be resumed before opening a different request')
        }
        const session = await fetchSessionV3(appConfig.lcdBase, transaction.intent.authority, expected, deadline)
        return { ...session, browserTransactionKey: ownerDeal }
      })
    },
    async discardUnboundV3(key: string) {
      const { owner } = requireWallet()
      await discardUnboundRetrievalV3Checkpoint(key, scope(), owner, appConfig.cosmosChainId)
    },
    async acknowledgeV3(session: FrozenSessionV3, slot: number, signal?: AbortSignal): Promise<FrozenSessionV3> {
      const { address, wallet, client, owner } = requireWallet()
      if (owner !== session.owner) throw new Error('only the frozen session owner may acknowledge')
      const obligation = session.obligations.find((value) => value.slot === slot)
      if (!obligation) throw new Error('slot is not represented by this session')
      const digest = await workerClient.retrievalV3AckHash(session.authority.chainId, unhex(session.sessionId, 32), session.contextHash, session.planHash,
        slot, accountBytes(obligation.assigned), accountBytes(obligation.payee), obligation.blobCount, obligation.blobCount * BigInt(BLOB_SIZE_BYTES), unhex(session.authority.integrityRoot, 32))
      const data = encodeAcknowledgeRetrievalObligationV3Data(session.sessionId, slot, `0x${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`)
      const key = 'ack-v3:' + await retrievalIntentKey([scope(), session.sessionId, slot])
      let gas = 0n
      await withRetrievalLock(key, () => settleBrowserTransaction({ key, store: browserRetrievalStore(), signal,
        prepare: async () => { gas = retrievalGasLimit(await client.estimateGas({ account: address, to: appConfig.polystorePrecompile as Hex, data })); return { data, intent: { session, slot } } },
        send: (call) => wallet.sendTransaction({ chain: client.chain, account: address, to: appConfig.polystorePrecompile as Hex, data: call, gas }),
        receipt: (hash) => client.waitForTransactionReceipt({ hash, timeout: 120_000 }),
        reconcile: async () => Boolean((await observedV3(session, AbortSignal.timeout(15_000))).ackedMask & (1 << slot)),
      }))
      return observedV3(session, signal)
    },
    async refundV3(session: FrozenSessionV3, signal?: AbortSignal): Promise<FrozenSessionV3> {
      const { address, wallet, client } = requireWallet()
      const data = encodeRefundRetrievalSessionV3Data(session.sessionId), key = 'refund-v3:' + await retrievalIntentKey([scope(), session.sessionId])
      let gas = 0n
      await withRetrievalLock(key, () => settleBrowserTransaction({ key, store: browserRetrievalStore(), signal,
        prepare: async () => { gas = retrievalGasLimit(await client.estimateGas({ account: address, to: appConfig.polystorePrecompile as Hex, data })); return { data, intent: session } },
        send: (call) => wallet.sendTransaction({ chain: client.chain, account: address, to: appConfig.polystorePrecompile as Hex, data: call, gas }),
        receipt: (hash) => client.waitForTransactionReceipt({ hash, timeout: 120_000 }),
        reconcile: async () => (await observedV3(session, AbortSignal.timeout(15_000))).refundedMask !== session.refundedMask,
      }))
      return observedV3(session, signal)
    },
    async forgetV3(session: Pick<FrozenSessionV3, 'sessionId' | 'obligations' | 'browserTransactionKey'>) {
      const store = browserRetrievalStore()
      const openKey = session.browserTransactionKey
      if (openKey) await withRetrievalLock(openKey, async () => {
        const current = store.get<{ intent?: { binding?: { sessionId?: string } } }>(openKey)
        if (current?.intent?.binding?.sessionId === session.sessionId) store.remove(openKey)
      })
      for (const obligation of session.obligations) store.remove('ack-v3:' + await retrievalIntentKey([scope(), session.sessionId, obligation.slot]))
      store.remove('refund-v3:' + await retrievalIntentKey([scope(), session.sessionId]))
    },
  }
}
