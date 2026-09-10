import { retrievalDiagnostic, timeRetrieval } from '../lib/retrievalDiagnostics'
import { useEffect, useRef, useState } from 'react'
import { gatewayFetchRetrievalMetadata, providerFetchRetrievalMetadata } from '../api/providerClient'
import { appConfig } from '../config'
import { BLOB_SIZE_BYTES, RAW_MDU_CAPACITY_BYTES } from '../domain/polyfsLayout'
import { resolveProviderEndpointByAddress, type ProviderEndpoint } from '../lib/providerDiscovery'
import { account, fetchActiveRetrievalGeneration, planRetrievalWindows, u64, type FrozenSession, type RetrievalWindow } from '../lib/retrieval'
import { decodeRetrievalOutput, executeRetrievalWindows, validateRetrievalAllocation, validateRetrievalMduPacking } from '../lib/retrievalFlow'
import { createRecoveryCommitmentReader, recoverRetrievalMdu, recoveryWindows } from '../lib/retrievalRecovery'
import { readLocalGatewayConnectedHint } from '../lib/retrievalMode'
import { confirmAndRequestRetrievalProofs, type RetrievalSettlementOutcome } from '../lib/retrievalSettlement'
import { isGatewayTransportEnabled } from '../lib/transport/mode'
import type { RoutePreference } from '../lib/transport/types'
import { classifyWalletError } from '../lib/walletErrors'
import { workerClient } from '../lib/worker-client'
import { openRetrievalCheckpoint } from '../lib/retrievalCheckpoint'
import { handoffOwnedDownload } from '../lib/retrievalDownloadPublication'
import { fetchActiveGenerationV3, generationAsPinnedV2Shape, planV3Chunks, type FrozenSessionV3 } from '../lib/retrievalV3'
import { assertRetrievalV3CheckpointScope, hasSettledRetrievalV3Cache, openRetrievalV3Checkpoint, readRetrievalV3Checkpoint, retrievalV3DownloadCheckpointKey } from '../lib/retrievalV3Checkpoint'
import { executeRetrievalV3, retrievalV3OutputComplete, type RetrievalV3Execution } from '../lib/retrievalV3Flow'
import { recoverRetrievalV3Checkpoint } from '../lib/retrievalV3Recovery'
import { requestRetrievalProofV3 } from '../lib/retrievalV3Settlement'
import type { SponsoredRetrievalAuth } from '../lib/retrievalSponsoredAuth'
import { useRetrievalSessions } from './useRetrievalSessions'
import { useTransportRouter } from './useTransportRouter'

export interface FetchInput {
  signal?: AbortSignal
  dealId: string
  manifestRoot: string
  owner: string
  generation?: string
  filePath: string
  /**
   * Optional provider HTTP base for metadata and direct retries.
   * The configured `appConfig.gatewayBase` uses `/gateway/*` relay routes;
   * other bases use provider routes. Every response is verified locally.
   */
  serviceBase?: string
  rangeStart?: number
  rangeLen?: number
  fileStartOffset?: number
  fileSizeBytes?: number
  mduSizeBytes?: number
  blobSizeBytes?: number
  decodePolyce?: boolean
  authorizedProofProvider?: string
  sponsoredAuth?: SponsoredRetrievalAuth
  routePreference?: RoutePreference
  checkpointKey?: string
}

export type FetchPhase =
  | 'idle'
  | 'opening_session_tx'
  | 'fetching'
  | 'confirming_session_tx'
  | 'submitting_proof_request'
  | 'done'
  | 'error'

export interface FetchProgress {
  phase: FetchPhase
  filePath: string
  chunksFetched: number
  chunkCount: number
  bytesFetched: number
  bytesTotal: number
  receiptsSubmitted: number
  receiptsTotal: number
  message?: string
  route?: string
  cacheSource?: string
  cacheFreshness?: string
}

export interface FetchResult {
  url: string
  blob: Blob
  cleanup?: () => Promise<void>
  route?: string
  cacheSource?: string
  cacheFreshness?: string
  provider?: string
}

export interface RetrievalPlanSummary {
  capturedAtMs: number
  dealId: string
  manifestRoot: string
  filePath: string
  routePreference?: RoutePreference
  mduSizeBytes: number
  blobSizeBytes: number
  leafCount: bigint
  globalStart: bigint
  globalEnd: bigint
  providers: Array<{
    provider: string
    backend: string
    endpoint?: string
    startMduIndex: bigint
    startBlobIndex: number
    blobCount: bigint
  }>
}

export type { SponsoredRetrievalAuth, VoucherAuthInput } from '../lib/retrievalSponsoredAuth'

export function useFetch() {
  const payment = useRetrievalSessions(), transport = useTransportRouter()
  const [loading, setLoading] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)
  const [receiptStatus, setReceiptStatus] = useState<'idle' | 'submitted' | 'failed'>('idle')
  const [receiptError, setReceiptError] = useState<string | null>(null)
  const [lastPlan, setLastPlan] = useState<RetrievalPlanSummary | null>(null)
  const [progress, setProgress] = useState<FetchProgress>({ phase: 'idle', filePath: '', chunksFetched: 0, chunkCount: 0, bytesFetched: 0, bytesTotal: 0, receiptsSubmitted: 0, receiptsTotal: 0 })
  const active = useRef<AbortController | null>(null)
  const saved = useRef<{ url: string; cleanup: () => Promise<void> } | null>(null)
  useEffect(() => () => { active.current?.abort(); if (saved.current) { URL.revokeObjectURL(saved.current.url); void saved.current.cleanup().catch(() => {}) } }, [])

  async function fetchFile(input: FetchInput): Promise<FetchResult> {
    active.current?.abort()
    const controller = new AbortController(); active.current = controller
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
    setLoading(true); setReceiptStatus('idle'); setReceiptError(null); setLastPlan(null)
    setProgress({ phase: 'idle', filePath: input.filePath, chunksFetched: 0, chunkCount: 0, bytesFetched: 0, bytesTotal: 0, receiptsSubmitted: 0, receiptsTotal: 0 })
    let checkpoint: Awaited<ReturnType<typeof openRetrievalCheckpoint>> | null = null
    let checkpointV3: Awaited<ReturnType<typeof openRetrievalV3Checkpoint>> | null = null
    try {
      if (saved.current) {
        const previous = saved.current; saved.current = null
        URL.revokeObjectURL(previous.url)
        await previous.cleanup().catch(() => {})
        signal.throwIfAborted()
      }
      const deputy = input.authorizedProofProvider === undefined ? undefined : account(input.authorizedProofProvider)
      const requester = payment.requireWallet().owner
      const v3Key = input.checkpointKey ?? await retrievalV3DownloadCheckpointKey(payment.scope(), input.dealId, input.filePath,
        input.rangeStart, input.rangeLen, deputy)
      if (!/^output-v3:[0-9a-f]{64}$/.test(v3Key)) throw new Error('invalid v3 retrieval checkpoint key')
      let savedV3 = readRetrievalV3Checkpoint(v3Key)
      if (savedV3) {
        checkpointV3 = await openRetrievalV3Checkpoint(v3Key)
        savedV3 = checkpointV3.state
      }
      if (savedV3 && deputy !== undefined) throw new Error('alternate v3 proof providers are not supported by the frozen session plan')
      if (savedV3) await assertRetrievalV3CheckpointScope(v3Key, savedV3, payment.scope(), requester, appConfig.cosmosChainId)
      if (savedV3 && !input.checkpointKey && (input.manifestRoot.toLowerCase() !== savedV3.authority.polyfsRoot ||
        input.owner !== savedV3.authority.owner || input.generation !== savedV3.authority.generation.toString())) {
        throw new Error('a saved v3 retrieval belongs to a prior frozen generation; use its paid recovery entry')
      }
      if (savedV3 && input.checkpointKey && (savedV3.authority.dealId.toString() !== input.dealId || savedV3.file.path !== input.filePath ||
        BigInt(input.rangeStart ?? 0) !== savedV3.rangeStart || BigInt(input.rangeLen || Number(savedV3.rangeLength)) !== savedV3.rangeLength)) {
        throw new Error('saved v3 recovery entry does not match the requested frozen file')
      }
      if (savedV3?.session && hasSettledRetrievalV3Cache(savedV3.authority.dealId, savedV3.file.path, v3Key)) {
        const lockedCheckpoint = checkpointV3!
        if (lockedCheckpoint.state.session?.lockedFee !== 0n || !retrievalV3OutputComplete(lockedCheckpoint.state.session, lockedCheckpoint.cursors)) {
          throw new Error('settled v3 retrieval cache is incomplete')
        }
        const blob = await lockedCheckpoint.output.file()
        const url = URL.createObjectURL(blob)
        return await handoffOwnedDownload(signal, () => active.current === controller, url, async () => {
          const cleanup = await checkpointV3!.handoff(); checkpointV3 = null; return cleanup
        }, (cleanup) => {
          let released = false
          const releaseDownload = async () => { if (released) return; released = true; URL.revokeObjectURL(url); await cleanup?.(); if (saved.current?.url === url) saved.current = null }
          saved.current = { url, cleanup: releaseDownload }
          setDownloadUrl(url); setReceiptStatus('submitted')
          setProgress((progress) => ({ ...progress, phase: 'done', bytesFetched: Number(savedV3.length), bytesTotal: Number(savedV3.length), route: 'browser_v3_cache' }))
          return { url, blob, cleanup: releaseDownload, route: 'browser_v3_cache', cacheSource: 'verified_file' as const, cacheFreshness: 'frozen_v3_generation' }
        })
      }
      await workerClient.initRetrievalWasm()
      let restoredSession: FrozenSessionV3 | undefined
      let activeV3: Awaited<ReturnType<typeof fetchActiveGenerationV3>>
      const readyV3 = (current: FrozenSessionV3, refresh = false) => {
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(120_000)])
        return refresh ? payment.observeV3(current, bounded).then((fresh) => payment.readyV3(fresh, bounded)) : payment.readyV3(current, bounded)
      }
      if (savedV3) {
        const lockedCheckpoint = checkpointV3!
        const recovered = await recoverRetrievalV3Checkpoint(savedV3, {
          open: (state) => payment.openV3(state.authority, state.fileRecordIndex, state.file, state.rangeStart, state.rangeLength, input.sponsoredAuth, signal),
          observe: (session) => payment.observeV3(session, AbortSignal.any([signal, AbortSignal.timeout(60_000)])),
          ready: (session) => readyV3(session),
          refund: (session) => payment.refundV3(session, signal),
          persist: (session, bind) => bind ? lockedCheckpoint.bind(session) : lockedCheckpoint.refresh(session),
        })
        restoredSession = recovered.session
        activeV3 = savedV3.authority
        if (recovered.expired) {
          if (!retrievalV3OutputComplete(restoredSession, lockedCheckpoint.cursors)) {
            await payment.forgetV3(restoredSession)
            await lockedCheckpoint.discard(); checkpointV3 = null
            throw new Error('the saved v3 session expired before the verified output completed; its remaining fee was refunded')
          }
          const blob = await lockedCheckpoint.output.file(), url = URL.createObjectURL(blob)
          await payment.forgetV3(restoredSession)
          return await handoffOwnedDownload(signal, () => active.current === controller, url, async () => {
            const cleanup = await lockedCheckpoint.handoff(); checkpointV3 = null; return cleanup
          }, (cleanup) => {
            let released = false
            const releaseDownload = async () => { if (released) return; released = true; URL.revokeObjectURL(url); await cleanup?.(); if (saved.current?.url === url) saved.current = null }
            saved.current = { url, cleanup: releaseDownload }
            setDownloadUrl(url); setReceiptStatus('submitted')
            setProgress((progress) => ({ ...progress, phase: 'done', bytesFetched: Number(savedV3.length), bytesTotal: Number(savedV3.length), route: 'browser_v3_recovery' }))
            return { url, blob, cleanup: releaseDownload, route: 'browser_v3_recovery', cacheSource: 'verified_file' as const, cacheFreshness: 'frozen_v3_generation' }
          })
        }
      } else {
        activeV3 = await fetchActiveGenerationV3(appConfig.lcdBase, appConfig.cosmosChainId, input.dealId,
          AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
      }
      const endpoints = new Map<string, ProviderEndpoint | null>()
      const endpoint = async (provider: string) => {
        if (!endpoints.has(provider)) endpoints.set(provider, await resolveProviderEndpointByAddress(appConfig.lcdBase, provider))
        return endpoints.get(provider)
      }
      if (activeV3) {
        if (deputy !== undefined) throw new Error('alternate v3 proof providers are not supported by the frozen session plan')
        if (!savedV3 && (input.manifestRoot.toLowerCase() !== activeV3.polyfsRoot || input.owner !== activeV3.owner)) throw new Error('displayed file generation changed; refresh before retrieval')
        const pinV3 = generationAsPinnedV2Shape(activeV3)
        const gatewayBase = appConfig.gatewayBase.replace(/\/$/, '')
        const metadataBases = new Set([input.serviceBase, appConfig.spBase].filter((x): x is string => Boolean(x) && x!.replace(/\/$/, '') !== gatewayBase))
        if (transport.allowsV3Direct(input.routePreference)) for (const provider of activeV3.providers) {
          const e = await endpoint(provider).catch(() => null); if (e?.baseUrl) metadataBases.add(e.baseUrl); if (metadataBases.size >= 4) break
        }
        const metadata = await transport.fetchV3Metadata({ authority: activeV3, directBases: [...metadataBases], preference: input.routePreference, signal })
        const records = metadata.data
        validateRetrievalAllocation(pinV3, records)
        const recordIndex = records.findIndex((record) => record.path === (savedV3?.file.path ?? input.filePath) && record.path !== '')
        if (recordIndex < 0) throw new Error('file absent from authenticated generation')
        const file = records[recordIndex]
        if (savedV3 && (savedV3.fileRecordIndex !== recordIndex || savedV3.file.path !== file.path || savedV3.file.start_offset !== file.start_offset || savedV3.file.size_bytes !== file.size_bytes)) {
          throw new Error('saved v3 retrieval FAT record does not match its authenticated generation')
        }
        const exactNumber = (n: number | undefined, fallback: bigint) => n === undefined ? fallback : Number.isSafeInteger(n) && n >= 0 ? u64(String(n)) : (() => { throw new Error('invalid exact file range') })()
        const start = savedV3?.rangeStart ?? exactNumber(input.rangeStart, 0n)
        const length = savedV3?.rangeLength ?? exactNumber(input.rangeLen === 0 ? undefined : input.rangeLen, file.size_bytes - start)
        if (!length || length > 1n << 30n || start + length > file.size_bytes) throw new Error('v3 file range must contain at most 1 GiB inside the authenticated extent')
        if (file.flags !== 0) throw new Error('transformed/encrypted v3 retrieval requires a supported bounded decoder before payment')
        checkpointV3 ??= await openRetrievalV3Checkpoint(v3Key, savedV3 ? undefined : { length, authority: activeV3, fileRecordIndex: recordIndex, file,
          rangeStart: start, rangeLength: length, requestRangeStart: input.rangeStart ?? null, requestRangeLength: input.rangeLen ?? null, requester })
        let session = restoredSession ?? checkpointV3.state.session
        if (session) session = await readyV3(session)
        else {
          setProgress((progress) => ({ ...progress, phase: 'opening_session_tx' }))
          session = await payment.openV3(activeV3, recordIndex, file, start, length, input.sponsoredAuth, signal)
          checkpointV3.bind(session)
          session = await readyV3(session)
          checkpointV3.refresh(session)
        }
        if (!session) throw new Error('v3 session was not opened')
        const sessionOwner = session.owner, receiptsTotal = session.obligations.length
        let chunkCount = 0
        const chunks = planV3Chunks(session)
        while (!chunks.next().done) chunkCount++
        setProgress((progress) => ({ ...progress, chunkCount, bytesTotal: Number(length), receiptsTotal }))
        const proofBase = isGatewayTransportEnabled({ gatewayDisabled: appConfig.gatewayDisabled, gatewayBase: appConfig.gatewayBase,
          localGatewayConnected: readLocalGatewayConnectedHint() }) ? appConfig.gatewayBase : undefined
        let route: string | undefined
        const result: RetrievalV3Execution = await executeRetrievalV3(session, checkpointV3, {
          fetch: async (chunk, chunkSignal) => {
            setProgress((progress) => ({ ...progress, phase: 'fetching' }))
            const direct = transport.allowsV3Direct(input.routePreference) ? await endpoint(activeV3.providers[chunk.slot]).catch(() => null) : null
            const directBases = [direct?.baseUrl, input.serviceBase, appConfig.spBase].filter((base): base is string =>
              Boolean(base) && base!.replace(/\/$/, '') !== gatewayBase)
            const outcome = await transport.fetchV3Chunk({ authority: activeV3, chunk, owner: sessionOwner, directBases,
              preference: input.routePreference, signal: chunkSignal })
            route = outcome.backend === 'gateway' ? 'gateway' : 'provider'
            return outcome.data
          },
          verify: (chunk, envelope) => workerClient.verifyRetrievalDataV3(chunk, envelope),
          acknowledge: async (current, slot) => {
            setProgress((progress) => ({ ...progress, phase: 'confirming_session_tx' }))
            const next = await payment.acknowledgeV3(current, slot, signal)
            setProgress((progress) => ({ ...progress, receiptsSubmitted: progress.receiptsSubmitted + 1 }))
            return next
          },
          requestProof: async (current, slot) => {
            const payee = current.obligations.find((obligation) => obligation.slot === slot)!.payee
            return proofBase ? requestRetrievalProofV3(proofBase, { dealId: current.authority.dealId, sessionId: current.sessionId, provider: payee }, signal) :
              { state: 'unknown', sessionId: current.sessionId, responseUnknown: true,
                message: 'No authenticated provider or user-gateway proof route is available.' }
          },
          observe: (current) => readyV3(current, true),
          progress: (chunksFetched, logicalBytes) => setProgress((progress) => ({ ...progress, chunksFetched, bytesFetched: Number(logicalBytes) })),
        }, signal)
        checkpointV3.refresh(result.session)
        const blob = await checkpointV3.output.file()
        const url = URL.createObjectURL(blob)
        if (result.session.lockedFee === 0n) await payment.forgetV3(result.session)
        const unsettled = result.session.lockedFee !== 0n
        const issue = result.outcomes.find((outcome) => outcome.state !== 'accepted')
        const message = unsettled ? `Download verified and acknowledged. Provider payment remains unsettled. ${issue?.message ?? ''} Retry this same file to reconcile the saved session without another payment or download.` : undefined
        return await handoffOwnedDownload(signal, () => active.current === controller, url, async () => {
          const cleanup = await checkpointV3!.handoff(); checkpointV3 = null; return cleanup
        }, (cleanup) => {
          let released = false
          const releaseDownload = async () => { if (released) return; released = true; URL.revokeObjectURL(url); await cleanup?.(); if (saved.current?.url === url) saved.current = null }
          saved.current = { url, cleanup: releaseDownload }
          setDownloadUrl(url); setReceiptStatus(unsettled ? 'failed' : 'submitted'); setReceiptError(message ?? null)
          setProgress((progress) => ({ ...progress, phase: 'done', route, message }))
          return { url, blob, cleanup: releaseDownload, route, cacheSource: 'verified_file' as const, cacheFreshness: 'frozen_v3_generation' }
        })
      }
      const pin = await fetchActiveRetrievalGeneration(appConfig.lcdBase, appConfig.cosmosChainId, input.dealId, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
      if (input.manifestRoot.toLowerCase() !== pin.root || input.owner !== pin.owner) throw new Error('displayed file generation changed; refresh before retrieval')
      const bases = new Set([input.serviceBase, appConfig.gatewayDisabled ? undefined : appConfig.gatewayBase, appConfig.spBase].filter((x): x is string => Boolean(x)))
      for (const assignment of pin.assignments) { const e = await endpoint(assignment.provider); if (e?.baseUrl) bases.add(e.baseUrl); if (bases.size >= 4) break }
      const fetchMetadata = (base: string, index: bigint) => {
        const get = base.replace(/\/$/, '') === appConfig.gatewayBase.replace(/\/$/, '') ? gatewayFetchRetrievalMetadata : providerFetchRetrievalMetadata
        return get(base, pin, index, signal)
      }
      let mdu0: Uint8Array | undefined
      let records: Awaited<ReturnType<typeof workerClient.verifyRetrievalMetadata>> | undefined, lastError: unknown
      for (const base of bases) {
        try { const bytes = await fetchMetadata(base, 0n); records = await workerClient.verifyRetrievalMetadata(bytes, pin); mdu0 = bytes; break } catch (error) { signal.throwIfAborted(); lastError = error }
      }
      if (!records || !mdu0) throw lastError ?? new Error('authenticated metadata unavailable')
      validateRetrievalAllocation(pin, records)
      const file = records.find((r) => r.path === input.filePath && r.path !== '')
      if (!file) throw new Error('file absent from authenticated generation')
      const exactNumber = (n: number | undefined, fallback: bigint) => n === undefined ? fallback : Number.isSafeInteger(n) && n >= 0 ? u64(String(n)) : (() => { throw new Error('invalid exact file range') })()
      const start = exactNumber(input.rangeStart, 0n), length = exactNumber(input.rangeLen === 0 ? undefined : input.rangeLen, file.size_bytes - start)
      if (start < 0n || length < 0n || start + length > file.size_bytes) throw new Error('file range outside authenticated extent')
      let count = 0
      if (length) for (const window of planRetrievalWindows(pin, file, start, length, true)) {
        if (!pin.assignments[window.slot].active) {
          if (input.sponsoredAuth?.type === 'voucher') throw new Error('unavailable slot requires a fresh recovery authorization before payment')
          recoveryWindows(pin, window.mduIndex - pin.metadataMdus)
        }
        count++
      }
      if (input.sponsoredAuth?.type === 'voucher' && count !== 1) throw new Error('voucher must authorize exactly one legal window before payment')
      // Storage availability and all allocation/layout checks precede funding.
      checkpoint = await openRetrievalCheckpoint([payment.scope(), 'download', pin.dealId, pin.root, pin.generation, file.path, start, length, deputy, input.sponsoredAuth ?? { type: 'none' }], length)
      setProgress((p) => ({ ...p, chunkCount: count, bytesTotal: Number(length), receiptsTotal: count }))
      setLastPlan({ capturedAtMs: Date.now(), dealId: pin.dealId.toString(), manifestRoot: pin.root, filePath: file.path, routePreference: input.routePreference,
        mduSizeBytes: RAW_MDU_CAPACITY_BYTES, blobSizeBytes: BLOB_SIZE_BYTES, leafCount: BigInt(pin.leafCount), globalStart: (pin.metadataMdus + (file.start_offset + start) / BigInt(RAW_MDU_CAPACITY_BYTES)) * BigInt(pin.leafCount), globalEnd: (pin.metadataMdus + (file.start_offset + start + (length || 1n) - 1n) / BigInt(RAW_MDU_CAPACITY_BYTES)) * BigInt(pin.leafCount), providers: [] })
      let logicalBytes = 0, confirmed = checkpoint.state.confirmed ?? 0, route: string | undefined
      let unsettled = checkpoint.state.unsettled ?? 0, firstSettlementIssue: RetrievalSettlementOutcome | undefined = checkpoint.state.firstSettlementIssue
      const job = checkpoint, sink = job.output
      const availableProofBase = () => isGatewayTransportEnabled({ gatewayDisabled: appConfig.gatewayDisabled, gatewayBase: appConfig.gatewayBase, localGatewayConnected: readLocalGatewayConnectedHint() }) ? appConfig.gatewayBase : undefined
      await job.reconcile((sessions, previousBase) => confirmAndRequestRetrievalProofs(sessions, {
        // Durable settlement rows are written only after the original ACK commits.
        confirm: async () => {}, gatewayBase: availableProofBase() ?? previousBase, signal,
      }), (sessions) => payment.forget(sessions, job.key), signal)
      unsettled = job.state.unsettled ?? 0; firstSettlementIssue = job.state.firstSettlementIssue
      setProgress((p) => ({ ...p, receiptsSubmitted: confirmed }))
      let currentOrdinal = -1n
      const fetchSession = async (session: FrozenSession) => {
        setProgress((p) => ({ ...p, phase: 'fetching' }))
        const e = await endpoint(session.payee)
        const result = await transport.fetchWindow({ session, directBase: e?.baseUrl || input.serviceBase, p2pTarget: e?.p2pTarget, preference: input.routePreference, signal })
        retrievalDiagnostic({ phase: 'verified_window', sessionId: session.sessionId, bytes: result.data.length })
        route = result.backend; return result.data
      }
      const confirm = async (sessions: readonly FrozenSession[]) => {
        setProgress((p) => ({ ...p, phase: 'confirming_session_tx' }))
        const gatewayBase = job.state.pending?.proofBase ?? availableProofBase()
        job.prepare(currentOrdinal, sessions, gatewayBase)
        const outcomes = await timeRetrieval('ack_and_provider_settlement', () => confirmAndRequestRetrievalProofs(sessions, {
          confirm: (wave) => timeRetrieval('owner_ack', () => payment.confirm(wave, signal, job.key)), signal,
          gatewayBase,
          onConfirmed: () => { retrievalDiagnostic({ phase: 'acked', sessionIds: sessions.map((s) => s.sessionId) }); confirmed += sessions.length; setProgress((p) => ({ ...p, receiptsSubmitted: confirmed, phase: 'submitting_proof_request' })) },
        }))
        if (outcomes.some((outcome) => outcome.responseUnknown)) throw new Error('Provider proof request outcome is unknown. Retry this saved retrieval to reconcile the same session; its ACK is already committed.')
        for (const outcome of outcomes) if (outcome.state !== 'committed') { unsettled++; firstSettlementIssue ??= outcome }
        job.complete(currentOrdinal, outcomes)
        if (job.state.cleanup) { await payment.forget(job.state.cleanup, job.key); job.cleaned() }
      }
      const consume = async (window: RetrievalWindow, bytes: Uint8Array) => {
        await timeRetrieval('decode_write', async () => {
          for (const part of decodeRetrievalOutput(pin, file, window, bytes)) {
            await sink.write(part.offset, part.bytes)
            retrievalDiagnostic({ phase: 'verified_write', offset: Number(part.offset), bytes: part.bytes.length })
          }
        })
      }
      const flushOutput = async () => { await timeRetrieval('flush', () => sink.flush()); retrievalDiagnostic({ phase: 'flushed' }) }
      const readCommitments = createRecoveryCommitmentReader(pin, mdu0, {
        fetch: async (index) => {
          let last: unknown
          for (const base of bases) {
            try { return await fetchMetadata(base, index) }
            catch (error) { signal.throwIfAborted(); last = error }
          }
          throw last ?? new Error('witness unavailable')
        },
        verifyWitness: workerClient.verifyRetrievalWitness,
        readCommitments: workerClient.readRetrievalCommitments,
      }, signal)
      // Process one MDU at a time. Recovery retains at most K shards and one
      // output MDU; file length never increases the in-memory working set.
      const processMdu = async (windows: RetrievalWindow[]) => {
        const ordinal = windows[0].mduIndex - pin.metadataMdus
        currentOrdinal = ordinal
        if (ordinal <= job.state.through) return
        if (job.state.pending) {
          if (job.state.pending.ordinal !== ordinal) throw new Error('saved retrieval cursor does not match file')
          await confirm(job.state.pending.sessions); return
        }
        let fetchFailed = false
        if (windows.every((w) => pin.assignments[w.slot].active)) {
          try {
            await executeRetrievalWindows(windows, {
              open: async (wave) => { setProgress((p) => ({ ...p, phase: 'opening_session_tx' })); return payment.open(pin, wave, input.sponsoredAuth, signal, deputy, job.key) },
              fetchAndVerify: async (session) => { try { return await fetchSession(session) } catch (error) { fetchFailed = true; throw error } },
              consume, flush: flushOutput, confirm,
            }, signal, 64)
            return
          } catch (error) { signal.throwIfAborted(); if (!fetchFailed) throw error }
        }
        if (input.sponsoredAuth?.type === 'voucher') throw new Error('failed retrieval needs a fresh voucher for separately funded recovery')
        recoveryWindows(pin, ordinal)
        const commitments = await readCommitments(ordinal)
        await recoverRetrievalMdu(pin, ordinal, {
          open: (wave) => payment.open(pin, wave, input.sponsoredAuth, signal, deputy, job.key),
          fetchAndVerify: fetchSession,
          reconstructAndVerify: (shards) => workerClient.reconstructRetrievalMdu(pin, shards, commitments),
          consumeAndFlush: async (encoded) => {
            validateRetrievalMduPacking(pin, records, ordinal, encoded)
            for (const window of windows) {
              const selected = new Uint8Array(window.blobCount * BLOB_SIZE_BYTES)
              window.slices.forEach((slice, i) => selected.set(encoded.subarray(slice.encodedBlobIndex * BLOB_SIZE_BYTES, (slice.encodedBlobIndex + 1) * BLOB_SIZE_BYTES), i * BLOB_SIZE_BYTES))
              await consume(window, selected)
            }
            await flushOutput()
          }, confirm,
        }, signal)
      }
      if (length) {
        let windows: RetrievalWindow[] = []
        let completed = 0
        const flush = async () => {
          if (!windows.length) return
          await processMdu(windows)
          logicalBytes += windows.reduce((sum, w) => sum + w.slices.reduce((n, slice) => n + slice.length, 0), 0)
          completed += windows.length
          setProgress((p) => ({ ...p, bytesFetched: logicalBytes, chunksFetched: completed }))
          windows = []
        }
        for (const window of planRetrievalWindows(pin, file, start, length, true)) {
          if (windows.length && windows[0].mduIndex !== window.mduIndex) await flush()
          windows.push(window)
        }
        await flush()
      }
      const blob = await sink.file()
      const url = URL.createObjectURL(blob)
      // The same output is needed to retry settlement without another download.
      // A retained checkpoint owns its bytes across URL replacement and unmount.
      const settlementMessage = firstSettlementIssue ? `Download verified and acknowledged. ${unsettled} session(s) have unsettled provider payment. ${firstSettlementIssue.message ?? ''} Retry this same file when the trusted local gateway is available to settle the saved sessions without another payment or download.` : undefined
      return await handoffOwnedDownload(signal, () => active.current === controller, url, async () => {
        const cleanup = await job.handoff(); checkpoint = null; return cleanup
      }, (cleanup) => {
        let released = false
        const releaseDownload = async () => { if (released) return; released = true; URL.revokeObjectURL(url); await cleanup?.(); if (saved.current?.url === url) saved.current = null }
        saved.current = { url, cleanup: releaseDownload }
        setDownloadUrl(url); setReceiptStatus(firstSettlementIssue ? 'failed' : 'submitted'); setReceiptError(settlementMessage ?? null)
        setProgress((p) => ({ ...p, phase: 'done', route, message: settlementMessage }))
        return { url, blob, cleanup: releaseDownload, route, cacheSource: 'verified_file' as const, cacheFreshness: 'pinned_generation' }
      })
    } catch (error) {
      const message = classifyWalletError(error, 'Fetch failed').message + (checkpoint ? ' Saved retrieval progress is retained in this browser. Retry the same file to resume and reconcile its existing sessions.' : '')
      if (active.current === controller) { setProgress((p) => ({ ...p, phase: 'error', message })); setReceiptStatus('failed'); setReceiptError(message) }
      throw new Error(message)
    } finally { await checkpoint?.retain().catch(() => {}); await checkpointV3?.retain().catch(() => {}); if (active.current === controller) { setLoading(false); active.current = null } }
  }
  return { fetchFile, discardUnboundV3: payment.discardUnboundV3, loading, downloadUrl, receiptStatus, receiptError, progress, lastPlan, unavailableReason: payment.unavailableReason }
}
