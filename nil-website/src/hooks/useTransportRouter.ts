import { appConfig } from '../config'
import {
  gatewayFetchSlabLayout,
  gatewayFetchManifestInfo,
  gatewayFetchMduKzg,
  gatewayListFiles,
  gatewayPlanRetrievalSession,
  gatewayUpload,
} from '../api/gatewayClient'
import type { GatewayPlanResponse } from '../api/gatewayClient'
import type { NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'
import { useTransportContext } from '../context/TransportContext'
import { executeWithFallback, TransportTraceError } from '../lib/transport/router'
import type { DecisionTrace, TransportOutcome, RoutePreference } from '../lib/transport/types'
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

  const recordTrace = (trace: DecisionTrace) => setLastTrace(trace)

  const coerceHttpError = (err: unknown): never => {
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
  }

  async function listFiles(req: ListFilesRequest): Promise<TransportOutcome<NilfsFileEntry[]>> {
    const candidates = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async () => {
          try {
            return await gatewayListFiles(appConfig.gatewayBase, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
            })
          } catch (err) {
            coerceHttpError(err)
          }
        },
      },
    ]
    if (req.directBase && req.directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: req.directBase,
        execute: async () => {
          try {
            return await gatewayListFiles(req.directBase!, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
            })
          } catch (err) {
            coerceHttpError(err)
          }
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
  }

  async function slab(req: SlabRequest): Promise<TransportOutcome<SlabLayoutData>> {
    const candidates = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async () => {
          try {
            return await gatewayFetchSlabLayout(appConfig.gatewayBase, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
            })
          } catch (err) {
            coerceHttpError(err)
          }
        },
      },
    ]
    if (req.directBase && req.directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: req.directBase,
        execute: async () => {
          try {
            return await gatewayFetchSlabLayout(req.directBase!, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
            })
          } catch (err) {
            coerceHttpError(err)
          }
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
  }

  async function plan(req: PlanRequest): Promise<TransportOutcome<GatewayPlanResponse>> {
    const candidates = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async () => {
          try {
            return await gatewayPlanRetrievalSession(appConfig.gatewayBase, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
              filePath: req.filePath,
              rangeStart: req.rangeStart,
              rangeLen: req.rangeLen,
            })
          } catch (err) {
            coerceHttpError(err)
          }
        },
      },
    ]
    if (req.directBase && req.directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: req.directBase,
        execute: async () => {
          try {
            return await gatewayPlanRetrievalSession(req.directBase!, req.manifestRoot, {
              dealId: req.dealId,
              owner: req.owner,
              filePath: req.filePath,
              rangeStart: req.rangeStart,
              rangeLen: req.rangeLen,
            })
          } catch (err) {
            coerceHttpError(err)
          }
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
  }

  async function uploadFile(req: UploadRequest) {
    const candidates = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async () => {
          try {
            return await gatewayUpload(appConfig.gatewayBase, {
              file: req.file,
              owner: req.owner,
              dealId: req.dealId,
              maxUserMdus: req.maxUserMdus,
            })
          } catch (err) {
            coerceHttpError(err)
          }
        },
      },
    ]
    const directBase = req.directBase && req.directBase !== appConfig.gatewayBase ? req.directBase : appConfig.spBase
    if (directBase && directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: directBase,
        execute: async () => {
          try {
            return await gatewayUpload(directBase, {
              file: req.file,
              owner: req.owner,
              dealId: req.dealId,
              maxUserMdus: req.maxUserMdus,
            })
          } catch (err) {
            coerceHttpError(err)
          }
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
  }

  async function manifestInfo(req: ManifestInfoRequest) {
    const candidates = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async () => {
          try {
            return await gatewayFetchManifestInfo(
              appConfig.gatewayBase,
              req.manifestRoot,
              req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            )
          } catch (err) {
            coerceHttpError(err)
          }
        },
      },
    ]
    if (req.directBase && req.directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: req.directBase,
        execute: async () => {
          try {
            return await gatewayFetchManifestInfo(
              req.directBase!,
              req.manifestRoot,
              req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            )
          } catch (err) {
            coerceHttpError(err)
          }
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
  }

  async function mduKzg(req: MduKzgRequest) {
    const candidates = [
      {
        backend: 'gateway' as const,
        endpoint: appConfig.gatewayBase,
        execute: async () => {
          try {
            return await gatewayFetchMduKzg(
              appConfig.gatewayBase,
              req.manifestRoot,
              req.mduIndex,
              req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            )
          } catch (err) {
            coerceHttpError(err)
          }
        },
      },
    ]
    if (req.directBase && req.directBase !== appConfig.gatewayBase) {
      candidates.push({
        backend: 'direct_sp' as const,
        endpoint: req.directBase,
        execute: async () => {
          try {
            return await gatewayFetchMduKzg(
              req.directBase!,
              req.manifestRoot,
              req.mduIndex,
              req.dealId && req.owner ? { dealId: req.dealId, owner: req.owner } : undefined,
            )
          } catch (err) {
            coerceHttpError(err)
          }
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
  }

  return {
    preference,
    lastTrace,
    setPreference,
    listFiles,
    slab,
    plan,
    uploadFile,
    manifestInfo,
    mduKzg,
  }
}
