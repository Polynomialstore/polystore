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

type ListFilesRequest = { manifestRoot: string; owner: string; dealId: string; directBase?: string; preference?: RoutePreference }
type SlabRequest = { manifestRoot: string; owner: string; dealId: string; directBase?: string; preference?: RoutePreference }
type PlanRequest = {
  manifestRoot: string
  owner: string
  dealId: string
  filePath: string
  rangeStart?: number
  rangeLen?: number
  directBase?: string
  preference?: RoutePreference
}
type UploadRequest = {
  file: File
  owner: string
  dealId?: string
  maxUserMdus?: number
  directBase?: string
}
type ManifestInfoRequest = { manifestRoot: string; owner?: string; dealId?: string; directBase?: string; preference?: RoutePreference }
type MduKzgRequest = { manifestRoot: string; owner?: string; dealId?: string; mduIndex: number; directBase?: string; preference?: RoutePreference }

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

  const listFiles = useCallback(async (req: ListFilesRequest): Promise<TransportOutcome<NilfsFileEntry[]>> => {
    const candidates: TransportCandidate<NilfsFileEntry[]>[] = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayListFiles(appConfig.gatewayBase, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
            }),
          )
        },
      },
    ]
    if (req.directBase && req.directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: req.directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayListFiles(req.directBase!, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
            }),
          )
        },
      })
    }

    try {
      const result = await executeWithFallback('list_files', candidates, {
        preference: req.preference ?? preference,
        timeoutMs: 10_000,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [preference, recordTrace, wrapExecute])

  const slab = useCallback(async (req: SlabRequest): Promise<TransportOutcome<SlabLayoutData>> => {
    const candidates: TransportCandidate<SlabLayoutData>[] = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayFetchSlabLayout(appConfig.gatewayBase, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
            }),
          )
        },
      },
    ]
    if (req.directBase && req.directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: req.directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayFetchSlabLayout(req.directBase!, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
            }),
          )
        },
      })
    }

    try {
      const result = await executeWithFallback('slab', candidates, {
        preference: req.preference ?? preference,
        timeoutMs: 10_000,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [preference, recordTrace, wrapExecute])

  const plan = useCallback(async (req: PlanRequest): Promise<TransportOutcome<GatewayPlanResponse>> => {
    const candidates: TransportCandidate<GatewayPlanResponse>[] = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async (signal) => {
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
      },
    ]
    if (req.directBase && req.directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: req.directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayPlanRetrievalSession(req.directBase!, req.manifestRoot, {
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

    try {
      const result = await executeWithFallback('plan', candidates, {
        preference: req.preference ?? preference,
        timeoutMs: 10_000,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [preference, recordTrace, wrapExecute])

  const uploadFile = useCallback(async (req: UploadRequest): Promise<TransportOutcome<UploadResult>> => {
    const candidates: TransportCandidate<UploadResult>[] = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async (signal) => {
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
      },
    ]
    const directBase = req.directBase && req.directBase !== appConfig.gatewayBase ? req.directBase : appConfig.spBase
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

    try {
      const result = await executeWithFallback('upload', candidates, { preference, timeoutMs: 60_000 })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [preference, recordTrace, wrapExecute])

  const manifestInfo = useCallback(async (req: ManifestInfoRequest): Promise<TransportOutcome<ManifestInfoData>> => {
    const candidates: TransportCandidate<ManifestInfoData>[] = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayFetchManifestInfo(
              appConfig.gatewayBase,
              req.manifestRoot,
              req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            ),
          )
        },
      },
    ]
    if (req.directBase && req.directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: req.directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayFetchManifestInfo(
              req.directBase!,
              req.manifestRoot,
              req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            ),
          )
        },
      })
    }

    try {
      const result = await executeWithFallback('manifest_info', candidates, {
        preference: req.preference ?? preference,
        timeoutMs: 10_000,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [preference, recordTrace, wrapExecute])

  const mduKzg = useCallback(async (req: MduKzgRequest): Promise<TransportOutcome<MduKzgData>> => {
    const candidates: TransportCandidate<MduKzgData>[] = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async (signal) => {
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
      },
    ]
    if (req.directBase && req.directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: req.directBase,
        execute: async (signal) => {
          void signal
          return wrapExecute(() =>
            gatewayFetchMduKzg(
              req.directBase!,
              req.manifestRoot,
              req.mduIndex,
              req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            ),
          )
        },
      })
    }

    try {
      const result = await executeWithFallback('mdu_kzg', candidates, {
        preference: req.preference ?? preference,
        timeoutMs: 30_000,
      })
      recordTrace(result.trace)
      return result
    } catch (err) {
      if (err instanceof TransportTraceError) recordTrace(err.trace)
      throw err
    }
  }, [preference, recordTrace, wrapExecute])

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
  }), [preference, lastTrace, setPreference, listFiles, slab, plan, uploadFile, manifestInfo, mduKzg])
}
