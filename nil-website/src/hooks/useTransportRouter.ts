import { useCallback, useMemo } from 'react'
import { appConfig } from '../config'
import {
  gatewayFetchSlabLayout,
  gatewayFetchManifestInfo,
  gatewayFetchMduKzg,
  gatewayListFiles,
  gatewayPlanRetrievalSession,
  gatewayUpload,
} from '../api/gatewayClient'
import type { GatewayPlanResponse, UploadResult } from '../api/gatewayClient'
import type { ManifestInfoData, MduKzgData, NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'
import { useTransportContext } from '../context/TransportContext'
import { executeWithFallback, TransportTraceError } from '../lib/transport/router'
import type { DecisionTrace, TransportCandidate, TransportOutcome, RoutePreference } from '../lib/transport/types'
import { classifyStatus, TransportError } from '../lib/transport/errors'
import { libp2pFetchRange } from '../lib/transport/libp2pClient'
import type { P2pTarget } from '../lib/multiaddr'
import { allowNonGatewayBackends, resolveTransportPreference } from '../lib/transport/mode'

const LOCAL_GATEWAY_CONNECTED_KEY = 'nil_local_gateway_connected'

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
      return resolveTransportPreference({
        candidate,
        gatewayDisabled: appConfig.gatewayDisabled,
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

  const listFiles = useCallback(async (req: ListFilesRequest): Promise<TransportOutcome<NilfsFileEntry[]>> => {
    const effectivePreference = resolvePreference(req.preference)
    const directBase = resolveDirectBase(req.directBase)
    const candidates: TransportCandidate<NilfsFileEntry[]>[] = [
      ...(!appConfig.gatewayDisabled
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
    if (directBase && allowNonGatewayBackends(effectivePreference)) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayListFiles(directBase, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
            }),
          )
        },
      })
    }
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
  }, [recordTrace, resolveDirectBase, resolvePreference, wrapExecute])

  const slab = useCallback(async (req: SlabRequest): Promise<TransportOutcome<SlabLayoutData>> => {
    const effectivePreference = resolvePreference(req.preference)
    const directBase = resolveDirectBase(req.directBase)
    const candidates: TransportCandidate<SlabLayoutData>[] = [
      ...(!appConfig.gatewayDisabled
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
    if (directBase && allowNonGatewayBackends(effectivePreference)) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayFetchSlabLayout(directBase, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
            }),
          )
        },
      })
    }
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
  }, [recordTrace, resolveDirectBase, resolvePreference, wrapExecute])

  const plan = useCallback(async (req: PlanRequest): Promise<TransportOutcome<GatewayPlanResponse>> => {
    const effectivePreference = resolvePreference(req.preference)
    const directBase = resolveDirectBase(req.directBase)
    const candidates: TransportCandidate<GatewayPlanResponse>[] = [
      ...(!appConfig.gatewayDisabled
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
            gatewayPlanRetrievalSession(directBase, req.manifestRoot, {
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
    const candidates: TransportCandidate<UploadResult>[] = [
      ...(!appConfig.gatewayDisabled
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
            gatewayUpload(directBase, {
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
    const directBase = resolveDirectBase(req.directBase)
    const candidates: TransportCandidate<ManifestInfoData>[] = [
      ...(!appConfig.gatewayDisabled
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
    if (directBase && allowNonGatewayBackends(effectivePreference)) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayFetchManifestInfo(
              directBase,
              req.manifestRoot,
              req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            ),
          )
        },
      })
    }
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
  }, [recordTrace, resolveDirectBase, resolvePreference, wrapExecute])

  const mduKzg = useCallback(async (req: MduKzgRequest): Promise<TransportOutcome<MduKzgData>> => {
    const effectivePreference = resolvePreference(req.preference)
    const directBase = resolveDirectBase(req.directBase)
    const candidates: TransportCandidate<MduKzgData>[] = [
      ...(!appConfig.gatewayDisabled
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
    if (directBase && allowNonGatewayBackends(effectivePreference)) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayFetchMduKzg(
              directBase,
              req.manifestRoot,
              req.mduIndex,
              req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            ),
          )
        },
      })
    }
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
  }, [recordTrace, resolveDirectBase, resolvePreference, wrapExecute])

  const fetchRange = useCallback(async (req: FetchRangeRequest): Promise<TransportOutcome<FetchRangeOutcome>> => {
    if (!Number.isFinite(req.rangeLen) || req.rangeLen <= 0) {
      throw new Error('rangeLen must be > 0')
    }

    const effectivePreference = resolvePreference(req.preference)
    const directBase = resolveDirectBase(req.directBase)
    const directP2p = req.p2pTarget?.multiaddr?.trim()
    const normalizeBase = (base: string) => base.replace(/\/$/, '')
    const rangeEnd = req.rangeStart + req.rangeLen - 1

    const buildUrl = (base: string, deputy: boolean) => {
      const q = new URLSearchParams({
        deal_id: req.dealId,
        owner: req.owner,
        file_path: req.filePath,
      })
      if (deputy) q.set('deputy', '1')
      return `${normalizeBase(base)}/gateway/fetch/${encodeURIComponent(req.manifestRoot)}?${q.toString()}`
    }

    const executeFetch = async (base: string, signal: AbortSignal, deputy: boolean): Promise<FetchRangeOutcome> => {
      const gatewayBase = normalizeBase(appConfig.gatewayBase)
      const normalizedBase = normalizeBase(base)
      const throughGateway = normalizedBase === gatewayBase
      const res = await fetch(buildUrl(base, deputy), {
        method: 'GET',
        signal,
        headers: {
          Range: `bytes=${req.rangeStart}-${rangeEnd}`,
          'X-Nil-Session-Id': req.sessionId,
          ...(req.auth
            ? {
                'X-Nil-Req-Sig': req.auth.reqSig,
                'X-Nil-Req-Nonce': String(req.auth.reqNonce),
                'X-Nil-Req-Expires-At': String(req.auth.reqExpiresAt),
                'X-Nil-Req-Range-Start': String(req.auth.signedRangeStart),
                'X-Nil-Req-Range-Len': String(req.auth.signedRangeLen),
              }
            : {}),
        },
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new TransportError(txt || `fetch failed (${res.status})`, classifyStatus(res.status), res.status)
      }

      const deputyHeader = String(res.headers.get('X-Nil-Deputy') || '').trim().toLowerCase()
      const deputyServed = deputy && (deputyHeader === '1' || deputyHeader === 'true' || deputyHeader === 'yes')

      let provider = String(res.headers.get('X-Nil-Provider') || '').trim()
      if (!provider && req.expectedProvider && (deputyServed || throughGateway)) {
        provider = req.expectedProvider
      }
      if (!provider) {
        throw new TransportError('missing X-Nil-Provider', 'invalid_response')
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

      const cacheFreshness = String(res.headers.get('X-Nil-Cache-Freshness') || '').trim().toLowerCase()
      const cacheFreshnessReason = String(res.headers.get('X-Nil-Cache-Freshness-Reason') || '').trim().toLowerCase()

      return {
        bytes: new Uint8Array(await res.arrayBuffer()),
        provider,
        deputy: deputyServed,
        cacheFreshness: cacheFreshness || undefined,
        cacheFreshnessReason: cacheFreshnessReason || undefined,
      }
    }

    const candidates: TransportCandidate<FetchRangeOutcome>[] = [
      ...(!appConfig.gatewayDisabled
        ? [{
            backend: 'gateway' as const,
            endpoint: appConfig.gatewayBase,
            execute: async (signal: AbortSignal) => executeFetch(appConfig.gatewayBase, signal, true),
          }]
        : []),
    ]

    if (directBase && allowNonGatewayBackends(effectivePreference)) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: directBase,
        execute: async (signal) => executeFetch(directBase, signal, false),
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

          const provider = String(result.headers['X-Nil-Provider'] || '')
          if (!provider) {
            throw new TransportError('missing X-Nil-Provider', 'invalid_response')
          }
          if (req.expectedProvider && provider !== req.expectedProvider) {
            throw new TransportError(
              `provider mismatch: expected ${req.expectedProvider} got ${provider}`,
              'provider_mismatch',
            )
          }

          const cacheFreshness = String(result.headers['X-Nil-Cache-Freshness'] || '').trim().toLowerCase()
          const cacheFreshnessReason = String(result.headers['X-Nil-Cache-Freshness-Reason'] || '').trim().toLowerCase()
          const deputyHeader = String(result.headers['X-Nil-Deputy'] || '').trim().toLowerCase()
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
  }), [preference, lastTrace, setPreference, listFiles, slab, plan, uploadFile, manifestInfo, mduKzg, fetchRange])
}
