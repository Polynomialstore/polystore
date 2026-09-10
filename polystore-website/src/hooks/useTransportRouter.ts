import { timeRetrieval } from '../lib/retrievalDiagnostics'
import { useCallback, useMemo } from 'react'
import type { GatewayPlanResponse, UploadResult } from '../api/gatewayClient'
import {
  gatewayFetchManifestInfo,
  gatewayFetchMduKzg,
  gatewayFetchSlabLayout,
  gatewayListFiles,
  gatewayPlanRetrievalSession,
  gatewayUpload,
} from '../api/gatewayClient'
import { fetchRetrievalChunkV3, gatewayFetchRetrievalMetadata, gatewayFetchRetrievalWindow, providerFetchRetrievalMetadata, providerFetchRetrievalWindow, providerPlanRetrievalSession, providerUpload } from '../api/providerClient'
import { appConfig } from '../config'
import { useTransportContext } from '../context/TransportContext'
import type { ManifestInfoData, MduKzgData, PolyfsFileEntry, SlabLayoutData } from '../domain/polyfs'
import type { P2pTarget } from '../lib/multiaddr'
import type { FrozenSession } from '../lib/retrieval'
import { generationAsPinnedV2Shape, type FrozenGenerationV3 } from '../lib/retrievalV3'
import type { RetrievalV3ChunkAuthority, RetrievalV3Envelope } from '../lib/retrievalWire'
import { classifyStatus, TransportError } from '../lib/transport/errors'
import { libp2pFetchRange, libp2pFetchRetrievalWindow } from '../lib/transport/libp2pClient'
import {
  allowNonGatewayBackends,
  isGatewayTransportEnabled,
  isTrustedLocalGatewayBase,
  resolveTransportPreference,
} from '../lib/transport/mode'
import { executeWithFallback, TransportTraceError } from '../lib/transport/router'
import type { DecisionTrace, RoutePreference, TransportCandidate, TransportOutcome } from '../lib/transport/types'
import { v3RetrievalCandidates } from '../lib/transport/v3Candidates'
import { workerClient } from '../lib/worker-client'
import { readLocalGatewayConnectedBase } from '../lib/retrievalMode'

const LOCAL_GATEWAY_CONNECTED_KEY = 'polystore_local_gateway_connected'

function readLocalGatewayConnectedHint(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(LOCAL_GATEWAY_CONNECTED_KEY) === '1'
  } catch {
    return false
  }
}

type ListFilesRequest = {
  manifestRoot: string
  owner: string
  dealId: string
  directBase?: string
  p2pTarget?: P2pTarget
  preference?: RoutePreference
}
type SlabRequest = {
  manifestRoot: string
  owner: string
  dealId: string
  directBase?: string
  p2pTarget?: P2pTarget
  preference?: RoutePreference
}
type PlanRequest = {
  manifestRoot: string
  owner: string
  dealId: string
  filePath: string
  rangeStart?: number
  rangeLen?: number
  directBase?: string
  p2pTarget?: P2pTarget
  preference?: RoutePreference
}
type UploadRequest = {
  file: File
  owner: string
  dealId?: string
  maxUserMdus?: number
  directBase?: string
  p2pTarget?: P2pTarget
}
type ManifestInfoRequest = {
  manifestRoot: string
  owner?: string
  dealId?: string
  directBase?: string
  p2pTarget?: P2pTarget
  preference?: RoutePreference
}
type MduKzgRequest = {
  manifestRoot: string
  owner?: string
  dealId?: string
  mduIndex: number
  directBase?: string
  p2pTarget?: P2pTarget
  preference?: RoutePreference
}
type FetchRangeAuth = {
  reqSig: string
  reqNonce: number
  reqExpiresAt: number
  signedRangeStart: number
  signedRangeLen: number
}

type FetchRangeRequest = {
  manifestRoot: string
  owner: string
  dealId: string
  filePath: string
  rangeStart: number
  rangeLen: number
  sessionId: string
  auth?: FetchRangeAuth
  expectedProvider?: string
  directBase?: string
  p2pTarget?: P2pTarget
  preference?: RoutePreference
}

type FetchRangeOutcome = {
  bytes: Uint8Array
  provider: string
  cacheFreshness?: string
  cacheFreshnessReason?: string
  deputy?: boolean
}

type V3TransportRequest = {
  authority: FrozenGenerationV3
  directBases: readonly string[]
  preference?: RoutePreference
  signal?: AbortSignal
}

export function useTransportRouter() {
  const { preference, lastTrace, setLastTrace, setPreference } = useTransportContext()

  const recordTrace = useCallback((trace: DecisionTrace) => setLastTrace(trace), [setLastTrace])

  const coerceHttpError = useCallback((err: unknown): never => {
    if (err instanceof TransportError) {
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    const match = msg.match(/\b(\d{3})\b/)
    if (match) {
      const status = Number(match[1])
      throw new TransportError(msg, classifyStatus(status), status)
    }
    throw err instanceof Error ? err : new Error(msg)
  }, [])

  const wrapExecute = useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (err) {
      return coerceHttpError(err)
    }
  }, [coerceHttpError])

  const resolvePreference = useCallback(
    (override?: RoutePreference): RoutePreference => {
      const candidate = override ?? preference
      const gatewayTrusted = isTrustedLocalGatewayBase(appConfig.gatewayBase)
      return resolveTransportPreference({
        candidate,
        gatewayDisabled: appConfig.gatewayDisabled || !gatewayTrusted,
        p2pEnabled: appConfig.p2pEnabled,
        localGatewayConnected: readLocalGatewayConnectedHint(),
      })
    },
    [preference],
  )

  const resolveDirectBase = useCallback((explicit?: string): string | undefined => {
    const trimmed = explicit?.trim()
    if (trimmed && trimmed !== appConfig.gatewayBase) return trimmed
    if (appConfig.gatewayDisabled && appConfig.spBase && appConfig.spBase !== appConfig.gatewayBase) {
      return appConfig.spBase
    }
    return undefined
  }, [])

  const listFiles = useCallback(async (req: ListFilesRequest): Promise<TransportOutcome<PolyfsFileEntry[]>> => {
    const effectivePreference = resolvePreference(req.preference)
    const gatewayEnabled = isGatewayTransportEnabled({
      gatewayDisabled: appConfig.gatewayDisabled,
      gatewayBase: appConfig.gatewayBase,
      localGatewayConnected: readLocalGatewayConnectedHint(),
    })
    const candidates: TransportCandidate<PolyfsFileEntry[]>[] = [
      ...(gatewayEnabled
        ? [{
            backend: 'gateway' as const,
            endpoint: appConfig.gatewayBase,
            execute: async (signal: AbortSignal) => {
              void signal
              return wrapExecute(() =>
                gatewayListFiles(appConfig.gatewayBase, req.manifestRoot, {
                  dealId: req.dealId,
                  owner: req.owner,
                }),
              )
            },
          }]
        : []),
    ]
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for list files')
    }

    try {
      const result = await executeWithFallback('list_files', candidates, {
        preference: effectivePreference,
        timeoutMs: 10_000,
        maxAttemptsPerBackend: 2,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [recordTrace, resolvePreference, wrapExecute])

  const slab = useCallback(async (req: SlabRequest): Promise<TransportOutcome<SlabLayoutData>> => {
    const effectivePreference = resolvePreference(req.preference)
    const gatewayEnabled = isGatewayTransportEnabled({
      gatewayDisabled: appConfig.gatewayDisabled,
      gatewayBase: appConfig.gatewayBase,
      localGatewayConnected: readLocalGatewayConnectedHint(),
    })
    const candidates: TransportCandidate<SlabLayoutData>[] = [
      ...(gatewayEnabled
        ? [{
            backend: 'gateway' as const,
            endpoint: appConfig.gatewayBase,
            execute: async (signal: AbortSignal) => {
              void signal
              return wrapExecute(() =>
                gatewayFetchSlabLayout(appConfig.gatewayBase, req.manifestRoot, {
                  dealId: req.dealId,
                  owner: req.owner,
                }),
              )
            },
          }]
        : []),
    ]
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for slab')
    }

    try {
      const result = await executeWithFallback('slab', candidates, {
        preference: effectivePreference,
        timeoutMs: 10_000,
        maxAttemptsPerBackend: 2,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [recordTrace, resolvePreference, wrapExecute])

  const plan = useCallback(async (req: PlanRequest): Promise<TransportOutcome<GatewayPlanResponse>> => {
    const effectivePreference = resolvePreference(req.preference)
    const directBase = resolveDirectBase(req.directBase)
    const gatewayEnabled = isGatewayTransportEnabled({
      gatewayDisabled: appConfig.gatewayDisabled,
      gatewayBase: appConfig.gatewayBase,
      localGatewayConnected: readLocalGatewayConnectedHint(),
    })
    const candidates: TransportCandidate<GatewayPlanResponse>[] = [
      ...(gatewayEnabled
        ? [{
            backend: 'gateway' as const,
            endpoint: appConfig.gatewayBase,
            execute: async (signal: AbortSignal) => {
              void signal
              return wrapExecute(() =>
                gatewayPlanRetrievalSession(appConfig.gatewayBase, req.manifestRoot, {
                  dealId: req.dealId,
                  owner: req.owner,
                  filePath: req.filePath,
                  rangeStart: req.rangeStart,
                  rangeLen: req.rangeLen,
                }),
              )
            },
          }]
        : []),
    ]
    if (directBase && allowNonGatewayBackends(effectivePreference)) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            providerPlanRetrievalSession(directBase, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
              filePath: req.filePath,
              rangeStart: req.rangeStart,
              rangeLen: req.rangeLen,
            }),
          )
        },
      })
    }
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for retrieval plan')
    }

    try {
      const result = await executeWithFallback('plan', candidates, {
        preference: effectivePreference,
        timeoutMs: 10_000,
        maxAttemptsPerBackend: 2,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [recordTrace, resolveDirectBase, resolvePreference, wrapExecute])

  const uploadFile = useCallback(async (req: UploadRequest): Promise<TransportOutcome<UploadResult>> => {
    const directBase = resolveDirectBase(req.directBase) ?? appConfig.spBase
    const gatewayEnabled = isGatewayTransportEnabled({
      gatewayDisabled: appConfig.gatewayDisabled,
      gatewayBase: appConfig.gatewayBase,
      localGatewayConnected: readLocalGatewayConnectedHint(),
    })
    const candidates: TransportCandidate<UploadResult>[] = [
      ...(gatewayEnabled
        ? [{
            backend: 'gateway' as const,
            endpoint: appConfig.gatewayBase,
            execute: async (signal: AbortSignal) => {
              void signal
              return wrapExecute(() =>
                gatewayUpload(appConfig.gatewayBase, {
                  file: req.file,
                  owner: req.owner,
                  dealId: req.dealId,
                  maxUserMdus: req.maxUserMdus,
                }),
              )
            },
          }]
        : []),
    ]
    if (directBase && directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            providerUpload(directBase, {
              file: req.file,
              owner: req.owner,
              dealId: req.dealId,
              maxUserMdus: req.maxUserMdus,
            }),
          )
        },
      })
    }
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for upload')
    }

    try {
      const result = await executeWithFallback('upload', candidates, {
        preference: resolvePreference(),
        timeoutMs: 60_000,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [recordTrace, resolveDirectBase, resolvePreference, wrapExecute])

  const manifestInfo = useCallback(async (req: ManifestInfoRequest): Promise<TransportOutcome<ManifestInfoData>> => {
    const effectivePreference = resolvePreference(req.preference)
    const gatewayEnabled = isGatewayTransportEnabled({
      gatewayDisabled: appConfig.gatewayDisabled,
      gatewayBase: appConfig.gatewayBase,
      localGatewayConnected: readLocalGatewayConnectedHint(),
    })
    const candidates: TransportCandidate<ManifestInfoData>[] = [
      ...(gatewayEnabled
        ? [{
            backend: 'gateway' as const,
            endpoint: appConfig.gatewayBase,
            execute: async (signal: AbortSignal) => {
              void signal
              return wrapExecute(() =>
                gatewayFetchManifestInfo(
                  appConfig.gatewayBase,
                  req.manifestRoot,
                  req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
                ),
              )
            },
          }]
        : []),
    ]
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for manifest info')
    }

    try {
      const result = await executeWithFallback('manifest_info', candidates, {
        preference: effectivePreference,
        timeoutMs: 10_000,
        maxAttemptsPerBackend: 2,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [recordTrace, resolvePreference, wrapExecute])

  const mduKzg = useCallback(async (req: MduKzgRequest): Promise<TransportOutcome<MduKzgData>> => {
    const effectivePreference = resolvePreference(req.preference)
    const gatewayEnabled = isGatewayTransportEnabled({
      gatewayDisabled: appConfig.gatewayDisabled,
      gatewayBase: appConfig.gatewayBase,
      localGatewayConnected: readLocalGatewayConnectedHint(),
    })
    const candidates: TransportCandidate<MduKzgData>[] = [
      ...(gatewayEnabled
        ? [{
            backend: 'gateway' as const,
            endpoint: appConfig.gatewayBase,
            execute: async (signal: AbortSignal) => {
              void signal
              return wrapExecute(() =>
                gatewayFetchMduKzg(
                  appConfig.gatewayBase,
                  req.manifestRoot,
                  req.mduIndex,
                  req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
                ),
              )
            },
          }]
        : []),
    ]
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for MDU KZG')
    }

    try {
      const result = await executeWithFallback('mdu_kzg', candidates, {
        preference: effectivePreference,
        timeoutMs: 30_000,
        maxAttemptsPerBackend: 2,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [recordTrace, resolvePreference, wrapExecute])

  const fetchRange = useCallback(async (req: FetchRangeRequest): Promise<TransportOutcome<FetchRangeOutcome>> => {
    if (!Number.isFinite(req.rangeLen) || req.rangeLen <= 0) {
      throw new Error('rangeLen must be > 0')
    }

    const effectivePreference = resolvePreference(req.preference)
    const directBase = resolveDirectBase(req.directBase)
    const directP2p = req.p2pTarget?.multiaddr?.trim()
    const gatewayEnabled = !appConfig.gatewayDisabled && isTrustedLocalGatewayBase(appConfig.gatewayBase) && readLocalGatewayConnectedHint()
    const normalizeBase = (base: string) => base.replace(/\/$/, '')
    const rangeEnd = req.rangeStart + req.rangeLen - 1

    const buildUrl = (base: string, backend: 'gateway' | 'direct_sp', deputy: boolean) => {
      const q = new URLSearchParams({
        deal_id: req.dealId,
        owner: req.owner,
        file_path: req.filePath,
      })
      if (deputy) q.set('deputy', '1')
      const path = backend === 'gateway' ? '/gateway/fetch/' : '/sp/retrieval/fetch/'
      return `${normalizeBase(base)}${path}${encodeURIComponent(req.manifestRoot)}?${q.toString()}`
    }

    const executeFetch = async (
      base: string,
      backend: 'gateway' | 'direct_sp',
      signal: AbortSignal,
      deputy: boolean,
    ): Promise<FetchRangeOutcome> => {
      const throughGateway = backend === 'gateway'
      const res = await fetch(buildUrl(base, backend, deputy), {
        method: 'GET',
        signal,
        headers: {
          Range: `bytes=${req.rangeStart}-${rangeEnd}`,
          'X-PolyStore-Session-Id': req.sessionId,
          ...(req.auth
            ? {
                'X-PolyStore-Req-Sig': req.auth.reqSig,
                'X-PolyStore-Req-Nonce': String(req.auth.reqNonce),
                'X-PolyStore-Req-Expires-At': String(req.auth.reqExpiresAt),
                'X-PolyStore-Req-Range-Start': String(req.auth.signedRangeStart),
                'X-PolyStore-Req-Range-Len': String(req.auth.signedRangeLen),
              }
            : {}),
        },
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new TransportError(txt || `fetch failed (${res.status})`, classifyStatus(res.status), res.status)
      }

      const deputyHeader = String(res.headers.get('X-PolyStore-Deputy') || '').trim().toLowerCase()
      const deputyServed = deputy && (deputyHeader === '1' || deputyHeader === 'true' || deputyHeader === 'yes')

      let provider = String(res.headers.get('X-PolyStore-Provider') || '').trim()
      if (!provider && req.expectedProvider && (deputyServed || throughGateway)) {
        provider = req.expectedProvider
      }
      if (!provider) {
        throw new TransportError('missing X-PolyStore-Provider', 'invalid_response')
      }
      if (req.expectedProvider && provider !== req.expectedProvider) {
        if (deputyServed || throughGateway) {
          provider = req.expectedProvider
        } else {
          throw new TransportError(
            `provider mismatch: expected ${req.expectedProvider} got ${provider}`,
            'provider_mismatch',
          )
        }
      }

      const cacheFreshness = String(res.headers.get('X-PolyStore-Cache-Freshness') || '').trim().toLowerCase()
      const cacheFreshnessReason = String(res.headers.get('X-PolyStore-Cache-Freshness-Reason') || '').trim().toLowerCase()

      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        provider,
        deputy: deputyServed,
        cacheFreshness: cacheFreshness || undefined,
        cacheFreshnessReason: cacheFreshnessReason || undefined,
      }
    }

    const candidates: TransportCandidate<FetchRangeOutcome>[] = [
      ...(gatewayEnabled
        ? [{
            backend: 'gateway' as const,
            endpoint: appConfig.gatewayBase,
            execute: async (signal: AbortSignal) => executeFetch(appConfig.gatewayBase, 'gateway', signal, true),
          }]
        : []),
    ]

    if (directBase && allowNonGatewayBackends(effectivePreference)) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: directBase,
        execute: async (signal) => executeFetch(directBase, 'direct_sp', signal, false),
      })
    }
    if (directP2p && appConfig.p2pEnabled && allowNonGatewayBackends(effectivePreference)) {
      candidates.push({
        backend: 'libp2p' as const,
        endpoint: directP2p,
        execute: async (signal) => {
          const result = await libp2pFetchRange(directP2p, {
            manifestRoot: req.manifestRoot,
            dealId: req.dealId,
            owner: req.owner,
            filePath: req.filePath,
            rangeStart: req.rangeStart,
            rangeLen: req.rangeLen,
            sessionId: req.sessionId,
            reqSig: req.auth?.reqSig,
            reqNonce: req.auth?.reqNonce,
            reqExpiresAt: req.auth?.reqExpiresAt,
            reqRangeStart: req.auth?.signedRangeStart,
            reqRangeLen: req.auth?.signedRangeLen,
          }, signal)

          if (result.status < 200 || result.status >= 300) {
            throw new TransportError(
              result.error || `libp2p fetch failed (${result.status})`,
              classifyStatus(result.status),
              result.status,
            )
          }

          const provider = String(result.headers['X-PolyStore-Provider'] || '')
          if (!provider) {
            throw new TransportError('missing X-PolyStore-Provider', 'invalid_response')
          }
          if (req.expectedProvider && provider !== req.expectedProvider) {
            throw new TransportError(
              `provider mismatch: expected ${req.expectedProvider} got ${provider}`,
              'provider_mismatch',
            )
          }

          const cacheFreshness = String(result.headers['X-PolyStore-Cache-Freshness'] || '').trim().toLowerCase()
          const cacheFreshnessReason = String(result.headers['X-PolyStore-Cache-Freshness-Reason'] || '').trim().toLowerCase()
          const deputyHeader = String(result.headers['X-PolyStore-Deputy'] || '').trim().toLowerCase()
          return {
            bytes: result.body,
            provider,
            deputy: deputyHeader === '1' || deputyHeader === 'true' || deputyHeader === 'yes',
            cacheFreshness: cacheFreshness || undefined,
            cacheFreshnessReason: cacheFreshnessReason || undefined,
          }
        },
      })
    }
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for fetch')
    }

    try {
      const result = await executeWithFallback('fetch', candidates, {
        preference: effectivePreference,
        timeoutMs: 30_000,
        maxAttemptsPerBackend: 2,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [recordTrace, resolveDirectBase, resolvePreference])

  const v3GatewayBase = appConfig.gatewayDisabled ? undefined : readLocalGatewayConnectedBase()
  const allowsV3Direct = useCallback((requested?: RoutePreference) => allowNonGatewayBackends(resolvePreference(requested)), [resolvePreference])

  const fetchV3Metadata = useCallback(async (req: V3TransportRequest) => {
    const effectivePreference = resolvePreference(req.preference), pin = generationAsPinnedV2Shape(req.authority)
    const candidates = v3RetrievalCandidates(effectivePreference, v3GatewayBase, req.directBases, async (base, gateway, attemptSignal) => {
      const signal = req.signal ? AbortSignal.any([req.signal, attemptSignal]) : attemptSignal
      const bytes = await wrapExecute(() => gateway ? gatewayFetchRetrievalMetadata(base, pin, 0n, signal) : providerFetchRetrievalMetadata(base, pin, 0n, signal))
      return workerClient.verifyRetrievalMetadataV3(bytes, req.authority)
    })
    if (!candidates.length) throw new Error('No authenticated v3 metadata transport available')
    try {
      const result = await executeWithFallback('fetch', candidates, { preference: effectivePreference, timeoutMs: 60_000, maxAttemptsPerBackend: 1 })
      recordTrace(result.trace)
      return result
    } catch (error) { if (error instanceof TransportTraceError) recordTrace(error.trace); throw error }
  }, [recordTrace, resolvePreference, v3GatewayBase, wrapExecute])

  const fetchV3Chunk = useCallback(async (req: V3TransportRequest & { chunk: RetrievalV3ChunkAuthority; owner: string }): Promise<TransportOutcome<RetrievalV3Envelope>> => {
    const effectivePreference = resolvePreference(req.preference)
    const candidates = v3RetrievalCandidates(effectivePreference, v3GatewayBase, req.directBases, (base, gateway, attemptSignal) => {
      const signal = req.signal ? AbortSignal.any([req.signal, attemptSignal]) : attemptSignal
      return wrapExecute(() => fetchRetrievalChunkV3(base, gateway ? '/gateway/mdu' : '/sp/retrieval/mdu', req.chunk,
        req.authority.dealId, req.owner, signal))
    })
    if (!candidates.length) throw new Error('No authenticated v3 data transport available')
    try {
      const result = await executeWithFallback('fetch', candidates, { preference: effectivePreference, timeoutMs: 345_000, maxAttemptsPerBackend: 1 })
      recordTrace(result.trace)
      return result
    } catch (error) { if (error instanceof TransportTraceError) recordTrace(error.trace); throw error }
  }, [recordTrace, resolvePreference, v3GatewayBase, wrapExecute])

  const fetchWindow = useCallback(async (req: { session: FrozenSession; directBase?: string; p2pTarget?: P2pTarget; preference?: RoutePreference; signal?: AbortSignal }): Promise<TransportOutcome<Uint8Array>> => {
    const effectivePreference = resolvePreference(req.preference)
    const candidates: TransportCandidate<Uint8Array>[] = []
    const verify = async (get: (signal: AbortSignal) => ReturnType<typeof providerFetchRetrievalWindow>, signal: AbortSignal) => {
      const activeSignal = req.signal ? AbortSignal.any([req.signal, signal]) : signal
      activeSignal.throwIfAborted()
      const response = await timeRetrieval('window_transport', () => get(activeSignal), req.session.sessionId)
      const bytes = await timeRetrieval('browser_verify', () => workerClient.verifyRetrievalWindow(req.session, response), req.session.sessionId)
      activeSignal.throwIfAborted()
      return bytes
    }
    if (!appConfig.gatewayDisabled && isTrustedLocalGatewayBase(appConfig.gatewayBase) && readLocalGatewayConnectedHint()) {
      candidates.push({ backend: 'gateway', endpoint: appConfig.gatewayBase, execute: (signal) => verify((s) => gatewayFetchRetrievalWindow(appConfig.gatewayBase, req.session, s), signal) })
    }
    if (req.directBase && allowNonGatewayBackends(effectivePreference)) candidates.push({ backend: 'direct_sp', endpoint: req.directBase, execute: (signal) => verify((s) => providerFetchRetrievalWindow(req.directBase!, req.session, s), signal) })
    if (req.p2pTarget && appConfig.p2pEnabled && allowNonGatewayBackends(effectivePreference)) candidates.push({ backend: 'libp2p', endpoint: req.p2pTarget.multiaddr, execute: (signal) => verify((s) => libp2pFetchRetrievalWindow(req.p2pTarget!.multiaddr, req.session, s), signal) })
    if (!candidates.length) throw new Error('No secured retrieval transport available')
    try {
      const result = await executeWithFallback('fetch', candidates, { preference: effectivePreference, timeoutMs: 60_000, maxAttemptsPerBackend: 1 })
      recordTrace(result.trace)
      return result
    } catch (error) { if (error instanceof TransportTraceError) recordTrace(error.trace); throw error }
  }, [recordTrace, resolvePreference])

  return useMemo(() => ({
    preference,
    lastTrace,
    setPreference,
    listFiles,
    slab,
    plan,
    uploadFile,
    manifestInfo,
    mduKzg,
    fetchRange,
    fetchWindow,
    fetchV3Metadata,
    fetchV3Chunk,
    allowsV3Direct,
  }), [preference, lastTrace, setPreference, listFiles, slab, plan, uploadFile, manifestInfo, mduKzg, fetchRange, fetchWindow, fetchV3Metadata, fetchV3Chunk, allowsV3Direct])
}
