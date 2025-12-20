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
import {
  p2pGatewayFetchManifestInfo,
  p2pGatewayFetchMduKzg,
  p2pGatewayFetchRange,
  p2pGatewayFetchSlabLayout,
  p2pGatewayListFiles,
  p2pGatewayPlanRetrievalSession,
} from '../api/p2pGatewayClient'
import type { GatewayPlanResponse, UploadResult } from '../api/gatewayClient'
import type { ManifestInfoData, MduKzgData, NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'
import { useTransportContext } from '../context/TransportContext'
import { executeWithFallback, TransportTraceError } from '../lib/transport/router'
import type { DecisionTrace, TransportCandidate, TransportOutcome, RoutePreference } from '../lib/transport/types'
import { classifyStatus, TransportError } from '../lib/transport/errors'
import type { P2pTarget } from '../lib/multiaddr'

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
type FetchRangeRequest = {
  manifestRoot: string
  owner: string
  dealId: string
  filePath: string
  rangeStart: number
  rangeLen: number
  sessionId: string
  expectedProvider?: string
  directBase?: string
  p2pTarget?: P2pTarget
  preference?: RoutePreference
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
      if (appConfig.gatewayDisabled) {
        if (candidate === 'prefer_p2p' && appConfig.p2pEnabled) return 'prefer_p2p'
        return 'prefer_direct_sp'
      }
      if (candidate === 'prefer_p2p' && !appConfig.p2pEnabled) return 'auto'
      return candidate
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
    const directBase = resolveDirectBase(req.directBase)
    const p2pTarget = req.p2pTarget
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
    if (directBase) {
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
    if (appConfig.p2pEnabled && p2pTarget) {
      candidates.push({
        backend: 'libp2p' as const,
        endpoint: p2pTarget.multiaddr,
        execute: async (signal) => p2pGatewayListFiles(p2pTarget, req.manifestRoot, { dealId: req.dealId, owner: req.owner }, signal),
      })
    }
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for list files')
    }

    try {
      const result = await executeWithFallback('list_files', candidates, {
        preference: resolvePreference(req.preference),
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
    const directBase = resolveDirectBase(req.directBase)
    const p2pTarget = req.p2pTarget
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
    if (directBase) {
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
    if (appConfig.p2pEnabled && p2pTarget) {
      candidates.push({
        backend: 'libp2p' as const,
        endpoint: p2pTarget.multiaddr,
        execute: async (signal) =>
          p2pGatewayFetchSlabLayout(
            p2pTarget,
            req.manifestRoot,
            { dealId: req.dealId, owner: req.owner },
            signal,
          ),
      })
    }
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for slab')
    }

    try {
      const result = await executeWithFallback('slab', candidates, {
        preference: resolvePreference(req.preference),
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
    const directBase = resolveDirectBase(req.directBase)
    const p2pTarget = req.p2pTarget
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
    if (directBase) {
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
    if (appConfig.p2pEnabled && p2pTarget) {
      candidates.push({
        backend: 'libp2p' as const,
        endpoint: p2pTarget.multiaddr,
        execute: async (signal) =>
          p2pGatewayPlanRetrievalSession(
            p2pTarget,
            req.manifestRoot,
            {
              dealId: req.dealId,
              owner: req.owner,
              filePath: req.filePath,
              rangeStart: req.rangeStart,
              rangeLen: req.rangeLen,
            },
            signal,
          ),
      })
    }
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for retrieval plan')
    }

    try {
      const result = await executeWithFallback('plan', candidates, {
        preference: resolvePreference(req.preference),
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
    const directBase = resolveDirectBase(req.directBase)
    const p2pTarget = req.p2pTarget
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
    if (directBase) {
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
    if (appConfig.p2pEnabled && p2pTarget) {
      candidates.push({
        backend: 'libp2p' as const,
        endpoint: p2pTarget.multiaddr,
        execute: async (signal) =>
          p2pGatewayFetchManifestInfo(
            p2pTarget,
            req.manifestRoot,
            req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            signal,
          ),
      })
    }
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for manifest info')
    }

    try {
      const result = await executeWithFallback('manifest_info', candidates, {
        preference: resolvePreference(req.preference),
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
    const directBase = resolveDirectBase(req.directBase)
    const p2pTarget = req.p2pTarget
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
    if (directBase) {
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
    if (appConfig.p2pEnabled && p2pTarget) {
      candidates.push({
        backend: 'libp2p' as const,
        endpoint: p2pTarget.multiaddr,
        execute: async (signal) =>
          p2pGatewayFetchMduKzg(
            p2pTarget,
            req.manifestRoot,
            req.mduIndex,
            req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            signal,
          ),
      })
    }
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for MDU KZG')
    }

    try {
      const result = await executeWithFallback('mdu_kzg', candidates, {
        preference: resolvePreference(req.preference),
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

  const fetchRange = useCallback(async (req: FetchRangeRequest): Promise<TransportOutcome<{ bytes: Uint8Array; provider: string }>> => {
    if (!Number.isFinite(req.rangeLen) || req.rangeLen <= 0) {
      throw new Error('rangeLen must be > 0')
    }

    const directBase = resolveDirectBase(req.directBase)
    const p2pTarget = req.p2pTarget
    const normalizeBase = (base: string) => base.replace(/\/$/, '')
    const rangeEnd = req.rangeStart + req.rangeLen - 1

    const buildUrl = (base: string) => {
      const q = new URLSearchParams({
        deal_id: req.dealId,
        owner: req.owner,
        file_path: req.filePath,
      })
      return `${normalizeBase(base)}/gateway/fetch/${encodeURIComponent(req.manifestRoot)}?${q.toString()}`
    }

    const executeFetch = async (base: string, signal: AbortSignal) => {
      const res = await fetch(buildUrl(base), {
        method: 'GET',
        signal,
        headers: {
          Range: `bytes=${req.rangeStart}-${rangeEnd}`,
          'X-Nil-Session-Id': req.sessionId,
        },
      })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new TransportError(txt || `fetch failed (${res.status})`, classifyStatus(res.status), res.status)
      }

      const provider = String(res.headers.get('X-Nil-Provider') || '')
      if (!provider) {
        throw new TransportError('missing X-Nil-Provider', 'invalid_response')
      }
      if (req.expectedProvider && provider !== req.expectedProvider) {
        throw new TransportError(
          `provider mismatch: expected ${req.expectedProvider} got ${provider}`,
          'provider_mismatch',
        )
      }

      return { bytes: new Uint8Array(await res.arrayBuffer()), provider }
    }

    const candidates: TransportCandidate<{ bytes: Uint8Array; provider: string }>[] = [
      ...(!appConfig.gatewayDisabled
        ? [{
            backend: 'gateway' as const,
            endpoint: appConfig.gatewayBase,
            execute: async (signal: AbortSignal) => executeFetch(appConfig.gatewayBase, signal),
          }]
        : []),
    ]

    if (directBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: directBase,
        execute: async (signal) => executeFetch(directBase, signal),
      })
    }
    if (appConfig.p2pEnabled && p2pTarget) {
      candidates.push({
        backend: 'libp2p' as const,
        endpoint: p2pTarget.multiaddr,
        execute: async (signal) =>
          p2pGatewayFetchRange(
            p2pTarget,
            {
              manifestRoot: req.manifestRoot,
              owner: req.owner,
              dealId: req.dealId,
              filePath: req.filePath,
              rangeStart: req.rangeStart,
              rangeEnd,
              sessionId: req.sessionId,
              expectedProvider: req.expectedProvider,
            },
            signal,
          ),
      })
    }
    if (candidates.length === 0) {
      throw new Error('No available transport candidates for fetch')
    }

    try {
      const result = await executeWithFallback('fetch', candidates, {
        preference: resolvePreference(req.preference),
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
