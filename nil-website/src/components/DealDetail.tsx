import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAccount } from 'wagmi'
import { appConfig } from '../config'
import { 
  FileJson, 
  Server, 
  Activity, 
  MoreVertical, 
  Zap, 
  Database, 
  Cpu, 
  Trash2,
  XCircle
} from 'lucide-react'
import { useProofs } from '../hooks/useProofs'
import { useFetch, type FetchInput, type FetchResult, type SponsoredRetrievalAuth } from '../hooks/useFetch'
import { useUpdateDealRetrievalPolicy, type RetrievalPolicyMode } from '../hooks/useUpdateDealRetrievalPolicy'
import type { Hex } from 'viem'
import { DealLivenessHeatmap } from './DealLivenessHeatmap'
import type { ManifestInfoData, MduKzgData, NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'
import { buildBlake2sMerkleLayers } from '../lib/merkle'
import type { LcdDeal } from '../domain/lcd'
import {
  deleteCachedFile,
  deleteDealDirectory,
  hasCachedFile,
  readCachedFile,
  readMdu,
  readManifestRoot,
  readSlabMetadata,
  writeCachedFile,
  writeManifestRoot,
  writeSlabMetadata,
} from '../lib/storage/OpfsAdapter'
import { parseNilfsFilesFromMdu0 } from '../lib/nilfsLocal'
import { inferWitnessCountFromOpfs, readNilfsFileFromOpfs } from '../lib/nilfsOpfsFetch'
import { workerClient } from '../lib/worker-client'
import { multiaddrToHttpUrl, multiaddrToP2pTarget } from '../lib/multiaddr'
import { useTransportRouter } from '../hooks/useTransportRouter'
import { parseServiceHint } from '../lib/serviceHint'
import { toHexFromBase64OrHex } from '../domain/hex'
import { evaluateCacheFreshness, normalizeManifestRoot } from '../lib/cacheFreshness'
import { isTrustedLocalGatewayBase } from '../lib/transport/mode'
import { planNilfsFileRangeChunks } from '../lib/rangeChunker'

let wasmReadyPromise: Promise<void> | null = null

function toU8(value: Uint8Array | number[] | null | undefined): Uint8Array {
  if (!value) return new Uint8Array()
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function bytesTo0xHex(bytes: Uint8Array): string {
  let out = '0x'
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0')
  return out
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—'
  const abs = Math.abs(bytes)
  if (abs < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (Math.abs(kb) < 1024) return `${kb.toFixed(1)} KiB`
  const mb = kb / 1024
  if (Math.abs(mb) < 1024) return `${mb.toFixed(1)} MiB`
  const gb = mb / 1024
  if (Math.abs(gb) < 1024) return `${gb.toFixed(2)} GiB`
  const tb = gb / 1024
  return `${tb.toFixed(2)} TiB`
}

function decodeGatewayHttpError(status: number, bodyText: string): string {
  const trimmed = String(bodyText ?? '').trim()
  if (!trimmed) return `Gateway download failed (${status})`
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>
    const err = typeof parsed.error === 'string' ? parsed.error.trim() : ''
    const hint = typeof parsed.hint === 'string' ? parsed.hint.trim() : ''
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : ''
    if (/missing X-Nil-Session-Id/i.test(err)) {
      return 'Gateway requires an on-chain retrieval session. Use Onchain Retrieval (or Auto source) and approve wallet access.'
    }
    if (err && hint) return `${err} (${hint})`
    if (err) return err
    if (message) return message
  } catch {
    // Ignore and use raw text.
  }
  return trimmed
}

function isGatewayOutdatedDownloadError(message: string): boolean {
  const text = String(message || '')
  if (/Range header is required/i.test(text) && /unsigned fetches must be chunked/i.test(text)) return true
  if (/Gateway download failed\s*\((404|405)\)/i.test(text)) return true
  if (/not found/i.test(text) && /gateway/i.test(text)) return true
  return false
}

function localGatewayBaseCandidates(rawBase: string): string[] {
  const trimmed = String(rawBase || '').trim().replace(/\/$/, '')
  const out: string[] = []
  const pushTrusted = (candidate: string | null | undefined) => {
    const clean = String(candidate || '').trim().replace(/\/$/, '')
    if (!clean) return
    if (!isTrustedLocalGatewayBase(clean)) return
    if (!out.includes(clean)) out.push(clean)
  }
  pushTrusted(trimmed)
  try {
    const parsed = new URL(trimmed)
    if (parsed.hostname === 'localhost') {
      parsed.hostname = '127.0.0.1'
      pushTrusted(parsed.toString().replace(/\/$/, ''))
    } else if (parsed.hostname === '127.0.0.1') {
      parsed.hostname = 'localhost'
      pushTrusted(parsed.toString().replace(/\/$/, ''))
    }
  } catch {
    // Ignore malformed configured base; caller will surface fetch failure.
  }
  pushTrusted('http://127.0.0.1:8080')
  pushTrusted('http://localhost:8080')
  return out
}

async function ensureWasmReady(): Promise<void> {
  if (wasmReadyPromise) return wasmReadyPromise
  wasmReadyPromise = (async () => {
    const res = await fetch('/trusted_setup.txt')
    if (!res.ok) throw new Error(`Failed to load trusted setup (${res.status})`)
    const buf = await res.arrayBuffer()
    const trustedSetupBytes = new Uint8Array(buf)
    try {
      await workerClient.initNilWasm(trustedSetupBytes)
    } catch (e) {
      // If the worker was already initialized, ignore and proceed.
      void e
    }
  })()
  return wasmReadyPromise
}

interface DealDetailProps {
  deal: LcdDeal
  nilAddress: string
  onFileActivity?: (activity: FileActivity) => void
  topPanel?: ReactNode
  requestedTab?: 'files' | 'info' | 'manifest' | 'heat'
  requestedTabNonce?: number
}

interface HeatState {
    bytes_served_total: string
    failed_challenges_total: string
    last_update_height: string
    successful_retrievals_total?: string
}

interface ProviderInfo {
  address: string
  endpoints?: string[]
  status?: string
}

interface FileActivity {
  dealId: string
  filePath: string
  sizeBytes: number
  manifestRoot: string
  action: 'download'
  status: 'pending' | 'success' | 'failed'
  error?: string
}

interface LocalCacheFreshnessResult {
  usable: boolean
  status: 'fresh' | 'stale' | 'unknown'
  reason: string
  localManifestRoot: string
  chainManifestRoot: string
}

interface FileRowProps {
  file: NilfsFileEntry
  deal: LcdDeal
  nilAddress: string
  browserCached: boolean
  gatewayCached: boolean
  isBusy: boolean
  isAnyDownloading: boolean
  isOpen: boolean
  onToggleMenu: () => void
  onFileActivity?: (activity: FileActivity) => void
  reconcileLocalMduCache: (dealId: string, chainManifestRoot: string) => Promise<LocalCacheFreshnessResult>
  downloadBytesAsFile: (bytes: Uint8Array, filePath: string) => void
  downloadBlobAsFile: (blob: Blob, filePath: string) => void
  markDownloadPath: (route: string, mode: string, cacheSource: string, freshness: string) => void
  downloadViaGatewayCache: (params: {
    manifestRoot: string
    dealId: string
    owner: string
    filePath: string
    rangeStart?: number
    rangeLen?: number
    fileSizeBytes?: number
    fileStartOffset?: number
    mduSizeBytes?: number
    blobSizeBytes?: number
  }) => Promise<Blob>
  fetchFile: (params: FetchInput) => Promise<FetchResult | null>
  resolveProviderHttpBase: () => string
  sponsoredAuth: SponsoredRetrievalAuth
  slab: SlabLayoutData | null
  setBrowserCachedByPath: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  setFileActionError: (error: string | null) => void
  setBusyFilePath: (path: string | null) => void
  downloadRangeStart: number
  downloadRangeLen: number
  allFiles: NilfsFileEntry[]
  transportPreference?: string
  setSelectedMdu: React.Dispatch<React.SetStateAction<number>>
  setActiveTab: (tab: 'files' | 'info' | 'manifest' | 'heat') => void
}

async function persistCachedDownloadState(dealId: string, manifestRoot: string, filePath: string, bytes: Uint8Array): Promise<void> {
  await writeCachedFile(dealId, filePath, bytes)
  const normalizedManifestRoot = normalizeManifestRoot(manifestRoot)
  if (normalizedManifestRoot) {
    await writeManifestRoot(dealId, normalizedManifestRoot)
  }
}

function FileRow({
  file,
  deal,
  nilAddress,
  browserCached,
  gatewayCached,
  isBusy,
  isAnyDownloading,
  isOpen,
  onToggleMenu,
  onFileActivity,
  reconcileLocalMduCache,
  downloadBytesAsFile,
  downloadBlobAsFile,
  markDownloadPath,
  downloadViaGatewayCache,
  fetchFile,
  resolveProviderHttpBase,
  sponsoredAuth,
  slab,
  setBrowserCachedByPath,
  setFileActionError,
  setBusyFilePath,
  downloadRangeStart,
  downloadRangeLen,
  allFiles,
  transportPreference,
}: FileRowProps) {
  const handleAutoDownload = async () => {
    setFileActionError(null)
    setBusyFilePath(file.path)
    const dealId = String(deal.id)
    const safeStart = Math.max(0, Number(downloadRangeStart || 0) || 0)
    const safeLen = Math.max(0, Number(downloadRangeLen || 0) || 0)
    try {
      if (!deal.cid) throw new Error('commit required (no on-chain CID)')
      const manifestHex = toHexFromBase64OrHex(deal.cid) || deal.cid
      const cacheFreshness = await reconcileLocalMduCache(dealId, manifestHex)
      if (cacheFreshness.usable) {
        const cachedBytes = await readCachedFile(dealId, file.path)
        if (cachedBytes) {
          downloadBytesAsFile(cachedBytes, file.path)
          markDownloadPath('browser cache', 'browser_cache', 'browser_cached_file', 'fresh')
          return
        }
      }
      onFileActivity?.({
        dealId,
        filePath: file.path,
        sizeBytes: file.size_bytes,
        manifestRoot: manifestHex,
        action: 'download',
        status: 'pending',
      })
      const autoRoutePreference =
        transportPreference === 'prefer_p2p'
          ? 'prefer_p2p'
          : transportPreference === 'prefer_direct_sp'
            ? 'prefer_direct_sp'
            : undefined
      try {
        const result = await fetchFile({
          dealId,
          manifestRoot: manifestHex,
          owner: String(deal.owner || nilAddress || ''),
          filePath: file.path,
          routePreference: autoRoutePreference,
          rangeStart: safeStart,
          rangeLen: safeLen,
          fileStartOffset: file.start_offset,
          fileSizeBytes: file.size_bytes,
          mduSizeBytes: slab?.mdu_size_bytes ?? 8 * 1024 * 1024,
          blobSizeBytes: slab?.blob_size_bytes ?? 128 * 1024,
          sponsoredAuth,
        })
        if (!result) throw new Error('download failed')
        const bytes = new Uint8Array(await result.blob.arrayBuffer())
        await persistCachedDownloadState(dealId, manifestHex, file.path, bytes)
        setBrowserCachedByPath((prev) => ({ ...prev, [file.path]: true }))
        downloadBlobAsFile(result.blob, file.path)
        onFileActivity?.({
          dealId,
          filePath: file.path,
          sizeBytes: file.size_bytes,
          manifestRoot: manifestHex,
          action: 'download',
          status: 'success',
        })
        return
      } catch (fetchErr) {
        if (!gatewayCached) throw fetchErr

        const fallbackReason = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        console.warn('Auto download transport path failed, falling back to gateway cache download', {
          dealId,
          filePath: file.path,
          error: fallbackReason,
        })
      }

      const gatewayBlob = await downloadViaGatewayCache({
        manifestRoot: manifestHex,
        dealId,
        owner: String(deal.owner || nilAddress || ''),
        filePath: file.path,
        rangeStart: safeStart,
        rangeLen: safeLen,
        fileSizeBytes: file.size_bytes,
        fileStartOffset: file.start_offset,
        mduSizeBytes: slab?.mdu_size_bytes ?? 8 * 1024 * 1024,
        blobSizeBytes: slab?.blob_size_bytes ?? 128 * 1024,
      })
      const bytes = new Uint8Array(await gatewayBlob.arrayBuffer())
      await persistCachedDownloadState(dealId, manifestHex, file.path, bytes)
      setBrowserCachedByPath((prev) => ({ ...prev, [file.path]: true }))
      downloadBlobAsFile(gatewayBlob, file.path)
      onFileActivity?.({
        dealId,
        filePath: file.path,
        sizeBytes: file.size_bytes,
        manifestRoot: manifestHex,
        action: 'download',
        status: 'success',
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (deal.cid) {
        const manifestHex = toHexFromBase64OrHex(deal.cid) || deal.cid
        onFileActivity?.({
          dealId,
          filePath: file.path,
          sizeBytes: file.size_bytes,
          manifestRoot: manifestHex,
          action: 'download',
          status: 'failed',
          error: msg,
        })
      }
      setFileActionError(msg)
    } finally {
      setBusyFilePath(null)
    }
  }

  const handleOnchainRetrieval = async () => {
    setFileActionError(null)
    setBusyFilePath(file.path)
    const dealId = String(deal.id)
    const safeStart = Math.max(0, Number(downloadRangeStart || 0) || 0)
    const safeLen = Math.max(0, Number(downloadRangeLen || 0) || 0)
    try {
      if (!deal.cid) throw new Error('commit required (no on-chain CID)')
      const manifestHex = toHexFromBase64OrHex(deal.cid) || deal.cid
      onFileActivity?.({
        dealId,
        filePath: file.path,
        sizeBytes: file.size_bytes,
        manifestRoot: manifestHex,
        action: 'download',
        status: 'pending',
      })
      const result = await fetchFile({
        dealId,
        manifestRoot: manifestHex,
        owner: String(deal.owner || nilAddress || ''),
        filePath: file.path,
        serviceBase: resolveProviderHttpBase(),
        routePreference: 'prefer_direct_sp',
        rangeStart: safeStart,
        rangeLen: safeLen,
        fileStartOffset: file.start_offset,
        fileSizeBytes: file.size_bytes,
        mduSizeBytes: slab?.mdu_size_bytes ?? 8 * 1024 * 1024,
        blobSizeBytes: slab?.blob_size_bytes ?? 128 * 1024,
        sponsoredAuth,
      })
      if (!result) throw new Error('download failed')
      const bytes = new Uint8Array(await result.blob.arrayBuffer())
      await persistCachedDownloadState(dealId, manifestHex, file.path, bytes)
      setBrowserCachedByPath((prev) => ({ ...prev, [file.path]: true }))
      downloadBlobAsFile(result.blob, file.path)
      onFileActivity?.({
        dealId,
        filePath: file.path,
        sizeBytes: file.size_bytes,
        manifestRoot: manifestHex,
        action: 'download',
        status: 'success',
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (deal.cid) {
        const manifestHex = toHexFromBase64OrHex(deal.cid) || deal.cid
        onFileActivity?.({
          dealId,
          filePath: file.path,
          sizeBytes: file.size_bytes,
          manifestRoot: manifestHex,
          action: 'download',
          status: 'failed',
          error: msg,
        })
      }
      setFileActionError(msg)
    } finally {
      setBusyFilePath(null)
      onToggleMenu()
    }
  }

  const handleGatewayCacheDownload = async () => {
    setFileActionError(null)
    setBusyFilePath(file.path)
    const dealId = String(deal.id)
    const safeStart = Math.max(0, Number(downloadRangeStart || 0) || 0)
    const safeLen = Math.max(0, Number(downloadRangeLen || 0) || 0)
    try {
      if (!deal.cid) throw new Error('commit required (no on-chain CID)')
      const manifestHex = toHexFromBase64OrHex(deal.cid) || deal.cid
      onFileActivity?.({
        dealId,
        filePath: file.path,
        sizeBytes: file.size_bytes,
        manifestRoot: manifestHex,
        action: 'download',
        status: 'pending',
      })
      const gatewayBlob = await downloadViaGatewayCache({
        manifestRoot: manifestHex,
        dealId,
        owner: String(deal.owner || nilAddress || ''),
        filePath: file.path,
        rangeStart: safeStart,
        rangeLen: safeLen,
        fileSizeBytes: file.size_bytes,
        fileStartOffset: file.start_offset,
        mduSizeBytes: slab?.mdu_size_bytes ?? 8 * 1024 * 1024,
        blobSizeBytes: slab?.blob_size_bytes ?? 128 * 1024,
      })
      const bytes = new Uint8Array(await gatewayBlob.arrayBuffer())
      await persistCachedDownloadState(dealId, manifestHex, file.path, bytes)
      setBrowserCachedByPath((prev) => ({ ...prev, [file.path]: true }))
      downloadBlobAsFile(gatewayBlob, file.path)
      onFileActivity?.({
        dealId,
        filePath: file.path,
        sizeBytes: file.size_bytes,
        manifestRoot: manifestHex,
        action: 'download',
        status: 'success',
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (deal.cid) {
        const manifestHex = toHexFromBase64OrHex(deal.cid) || deal.cid
        onFileActivity?.({
          dealId,
          filePath: file.path,
          sizeBytes: file.size_bytes,
          manifestRoot: manifestHex,
          action: 'download',
          status: 'failed',
          error: msg,
        })
      }
      setFileActionError(msg)
    } finally {
      setBusyFilePath(null)
      onToggleMenu()
    }
  }

  const handleAssembleMdus = async () => {
    setFileActionError(null)
    setBusyFilePath(file.path)
    const dealId = String(deal.id)
    const safeStart = Math.max(0, Number(downloadRangeStart || 0) || 0)
    const safeLen = Math.max(0, Number(downloadRangeLen || 0) || 0)
    try {
      const chainCid = String(deal.cid || '').trim()
      const cacheFreshness = await reconcileLocalMduCache(dealId, chainCid)
      if (!cacheFreshness.usable) throw new Error(`local slab not available (${cacheFreshness.reason})`)

      const bytes = await readNilfsFileFromOpfs({
        dealId,
        file,
        allFiles,
        rangeStart: safeStart,
        rangeLen: safeLen,
      })
      await persistCachedDownloadState(dealId, chainCid, file.path, bytes)
      setBrowserCachedByPath((prev) => ({ ...prev, [file.path]: true }))
      downloadBytesAsFile(bytes, file.path)
      markDownloadPath('browser mdu cache', 'browser_mdu_cache', 'browser_mdu_cache', 'fresh')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setFileActionError(msg)
    } finally {
      setBusyFilePath(null)
      onToggleMenu()
    }
  }

  const handleBrowserCacheDownload = async () => {
    setFileActionError(null)
    setBusyFilePath(file.path)
    const dealId = String(deal.id)
    try {
      const chainCid = String(deal.cid || '').trim()
      if (chainCid) {
        const cacheFreshness = await reconcileLocalMduCache(dealId, chainCid)
        if (!cacheFreshness.usable) {
          throw new Error(`browser cache unavailable (${cacheFreshness.reason})`)
        }
      }
      const cachedBytes = await readCachedFile(dealId, file.path)
      if (!cachedBytes) throw new Error('not cached in browser')
      downloadBytesAsFile(cachedBytes, file.path)
      markDownloadPath('browser cache', 'browser_cache', 'browser_cached_file', 'fresh')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setFileActionError(msg)
    } finally {
      setBusyFilePath(null)
      onToggleMenu()
    }
  }

  const handlePurgeCache = async () => {
    setFileActionError(null)
    const dealId = String(deal.id)
    try {
      await deleteCachedFile(dealId, file.path)
      setBrowserCachedByPath((prev) => ({ ...prev, [file.path]: false }))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setFileActionError(msg)
    } finally {
      onToggleMenu()
    }
  }

  return (
    <div
      data-testid="deal-detail-file-row"
      data-file-path={file.path}
      data-cache-browser={browserCached ? 'yes' : 'no'}
      data-cache-gateway={gatewayCached ? 'yes' : 'no'}
      className="nil-list-row relative flex items-center justify-between gap-3 border border-border bg-background/50 px-4 py-4 group"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold text-foreground" title={file.path}>
          {file.path}
        </div>
        <div className="nil-detail-meta mt-1 flex items-center gap-2 tracking-tight">
          <span className="text-foreground/70">{formatBytes(file.size_bytes)}</span>
          <span className="text-border/60">|</span>
          <span>BROWSER: <span className={browserCached ? 'text-success font-bold' : ''}>{browserCached ? 'YES' : '—'}</span></span>
          <span className="text-border/60">|</span>
          <span>GATEWAY: <span className={gatewayCached ? 'text-success font-bold' : ''}>{gatewayCached ? 'YES' : '—'}</span></span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleAutoDownload}
          disabled={isAnyDownloading || isBusy || !deal.cid}
          data-testid="deal-detail-download"
          data-file-path={file.path}
          className="bg-primary hover:bg-primary/90 text-primary-foreground px-3 py-1 text-[10px] font-bold uppercase tracking-wider rounded-none transition-colors disabled:opacity-50 shadow-[2px_2px_0px_0px_rgba(0,0,0,0.1)] active:shadow-none active:translate-x-[1px] active:translate-y-[1px]"
        >
          {isBusy ? 'BUSY' : 'Download'}
        </button>
        <div className="hidden xl:flex items-center gap-1">
          <button
            onClick={handleGatewayCacheDownload}
            disabled={isAnyDownloading || isBusy || !deal.cid}
            data-testid="deal-detail-download-gateway"
            data-file-path={file.path}
            className="border border-border bg-background px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-50"
          >
            Gateway
          </button>
          <button
            onClick={handleOnchainRetrieval}
            disabled={isAnyDownloading || isBusy || !deal.cid}
            data-testid="deal-detail-download-sp"
            data-file-path={file.path}
            className="border border-border bg-background px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-50"
          >
            Provider
          </button>
          <button
            onClick={handleAssembleMdus}
            disabled={isAnyDownloading || isBusy || !deal.cid}
            data-testid="deal-detail-download-browser-slab"
            data-file-path={file.path}
            className="border border-border bg-background px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-50"
          >
            Browser MDU
          </button>
          <button
            onClick={handleBrowserCacheDownload}
            disabled={isAnyDownloading || isBusy || !browserCached}
            data-testid="deal-detail-download-browser-cache"
            data-file-path={file.path}
            className="border border-border bg-background px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:opacity-50"
          >
            Browser Cache
          </button>
          <button
            onClick={handlePurgeCache}
            disabled={isAnyDownloading || isBusy || !browserCached}
            data-testid="deal-detail-clear-browser-cache"
            data-file-path={file.path}
            className="border border-border bg-background px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
          >
            Clear
          </button>
        </div>
        <button
          onClick={onToggleMenu}
          className={`p-1 hover:bg-secondary border transition-colors rounded-none ${isOpen ? 'border-primary/50 bg-secondary' : 'border-transparent'}`}
        >
          <MoreVertical className="w-4 h-4 text-muted-foreground" />
        </button>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={onToggleMenu} />
            <div className="absolute right-0 top-full mt-1 w-52 bg-background border border-border shadow-[4px_4px_0px_0px_rgba(0,0,0,0.2)] z-50 py-1 industrial-border">
              <div className="px-3 py-1.5 text-[9px] uppercase tracking-widest font-bold text-muted-foreground border-b border-border/40 mb-1">
                Retrieval Options
              </div>
              <button
                onClick={handleOnchainRetrieval}
                disabled={isAnyDownloading || isBusy || !deal.cid}
                className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-foreground hover:bg-primary/10 hover:text-primary transition-colors text-left disabled:opacity-50"
              >
                <Zap className="w-3.5 h-3.5" />
                On-chain Retrieval
              </button>
              <button
                onClick={handleGatewayCacheDownload}
                disabled={isAnyDownloading || isBusy || !deal.cid}
                className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-foreground hover:bg-primary/10 hover:text-primary transition-colors text-left disabled:opacity-50"
              >
                <Server className="w-3.5 h-3.5" />
                Gateway Cache
              </button>
              <button
                onClick={handleAssembleMdus}
                disabled={isAnyDownloading || isBusy || !deal.cid}
                className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-foreground hover:bg-primary/10 hover:text-primary transition-colors text-left disabled:opacity-50"
              >
                <Database className="w-3.5 h-3.5" />
                Assemble MDUs
              </button>
              <div className="h-px bg-border/40 my-1" />
              <button
                onClick={handleBrowserCacheDownload}
                disabled={isAnyDownloading || isBusy || !browserCached}
                className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-foreground hover:bg-primary/10 hover:text-primary transition-colors text-left disabled:opacity-50"
              >
                <Cpu className="w-3.5 h-3.5" />
                Browser Cache
              </button>
              <button
                onClick={handlePurgeCache}
                disabled={isAnyDownloading || isBusy || !browserCached}
                className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-semibold text-destructive hover:bg-destructive/10 transition-colors text-left disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Purge Cache
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function DealDetail({ deal, nilAddress, onFileActivity, topPanel, requestedTab, requestedTabNonce }: DealDetailProps) {
  const serviceHint = parseServiceHint(deal?.service_hint)
  const isMode2 = serviceHint.mode === 'mode2' || serviceHint.mode === 'auto'
  const hasCommittedContent = Boolean(String(deal.cid || '').trim())
  const dealStatusLabel = hasCommittedContent ? 'Active' : 'Empty'
  const dealSizeBytes = Number.parseInt(String(deal.size ?? '0'), 10)
  const dealSizeLabel = Number.isFinite(dealSizeBytes) && dealSizeBytes > 0
    ? `${(dealSizeBytes / 1024 / 1024).toFixed(2)} MB`
    : '0 B'
  const redundancyLabel = isMode2 && serviceHint.rsK && serviceHint.rsM
    ? `Mode 2 RS(${serviceHint.rsK},${serviceHint.rsM})`
    : 'Mode 2 (Auto)'
  const stripeLayout = useMemo(() => {
    const k = serviceHint.rsK ?? 8
    const m = serviceHint.rsM ?? 4
    const slots = k + m
    const rows = Math.max(1, Math.ceil(64 / k))
    return {
      k,
      m,
      slots,
      rows,
      isMode2: isMode2 && Boolean(serviceHint.rsK && serviceHint.rsM),
    }
  }, [isMode2, serviceHint.rsK, serviceHint.rsM])
  const { address } = useAccount()
  const { submitPolicyUpdate, loading: policyUpdating } = useUpdateDealRetrievalPolicy()
  const [policyMode, setPolicyMode] = useState<RetrievalPolicyMode>(() => {
    const raw = Number(deal.retrieval_policy?.mode ?? 1)
    return (raw >= 1 && raw <= 5 ? raw : 1) as RetrievalPolicyMode
  })
  const [policyAllowlistRoot, setPolicyAllowlistRoot] = useState<string>(() => {
    return String(deal.retrieval_policy?.allowlist_root || '')
  })
  const [policyVoucherSigner, setPolicyVoucherSigner] = useState<string>(() => {
    return String(deal.retrieval_policy?.voucher_signer || '')
  })
  const [, setPolicyError] = useState<string | null>(null)
  const [, setPolicyStatus] = useState<string | null>(null)
  const [sponsoredAuth, setSponsoredAuth] = useState<SponsoredRetrievalAuth>({ type: 'none' })
  const authStorageKey = useMemo(() => `nilstore.retrievalAuth.${deal.id}`, [deal.id])
  const [slab, setSlab] = useState<SlabLayoutData | null>(null)
  const [slabSource, setSlabSource] = useState<'none' | 'gateway' | 'opfs'>('none')
  const [, setGatewaySlabStatus] = useState<'unknown' | 'present' | 'missing' | 'error'>('unknown')
  const [heat, setHeat] = useState<HeatState | null>(null)
  const [providersByAddr, setProvidersByAddr] = useState<Record<string, ProviderInfo>>({})
  const [loadingSlab, setLoadingSlab] = useState(false)
  const [files, setFiles] = useState<NilfsFileEntry[] | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [browserCachedByPath, setBrowserCachedByPath] = useState<Record<string, boolean>>({})
  const [busyFilePath, setBusyFilePath] = useState<string | null>(null)
  const [openMenuFilePath, setOpenMenuFilePath] = useState<string | null>(null)
  const [fileActionError, setFileActionError] = useState<string | null>(null)
  const [downloadRangeStart] = useState<number>(0)
  const [downloadRangeLen] = useState<number>(0)
  const [manifestInfo, setManifestInfo] = useState<ManifestInfoData | null>(null)
  const [loadingManifestInfo, setLoadingManifestInfo] = useState(false)
  const [manifestInfoError, setManifestInfoError] = useState<string | null>(null)
  const [selectedMdu, setSelectedMdu] = useState<number>(0)
  const displayManifestRoot = normalizeManifestRoot(manifestInfo?.manifest_root || slab?.manifest_root || String(deal.cid || ''))

  useEffect(() => {
    const raw = Number(deal.retrieval_policy?.mode ?? 1)
    setPolicyMode((raw >= 1 && raw <= 5 ? raw : 1) as RetrievalPolicyMode)
    setPolicyAllowlistRoot(String(deal.retrieval_policy?.allowlist_root || ''))
    setPolicyVoucherSigner(String(deal.retrieval_policy?.voucher_signer || ''))
    setPolicyError(null)
    setPolicyStatus(null)
  }, [deal.id, deal.retrieval_policy?.mode, deal.retrieval_policy?.allowlist_root, deal.retrieval_policy?.voucher_signer])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const raw = window.localStorage.getItem(authStorageKey)
    if (!raw) {
      setSponsoredAuth({ type: 'none' })
      return
    }
    try {
      const parsed = JSON.parse(raw) as SponsoredRetrievalAuth
      if (parsed?.type === 'allowlist' || parsed?.type === 'voucher') {
        setSponsoredAuth(parsed)
        return
      }
      setSponsoredAuth({ type: 'none' })
    } catch {
      setSponsoredAuth({ type: 'none' })
    }
  }, [authStorageKey])
  const [mduKzg, setMduKzg] = useState<MduKzgData | null>(null)
  const [loadingMduKzg, setLoadingMduKzg] = useState(false)
  const [mduKzgError, setMduKzgError] = useState<string | null>(null)
  const [mduRootMerkle, setMduRootMerkle] = useState<string[][] | null>(null)
  const [merkleError, setMerkleError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'files' | 'info' | 'manifest' | 'heat'>('files')
  const { proofs } = useProofs()
  const { fetchFile, loading: downloading, receiptStatus, progress, lastPlan } = useFetch()
  const gatewayDownloadBases = useMemo(() => localGatewayBaseCandidates(appConfig.gatewayBase), [])
  const {
    slab: fetchSlabLayout,
    listFiles: listFilesTransport,
    manifestInfo: manifestInfoTransport,
    mduKzg: mduKzgTransport,
    lastTrace,
    preference: transportPreference,
  } = useTransportRouter()

  useEffect(() => {
    if (!requestedTabNonce) return
    if (!requestedTab) return
    setActiveTab(requestedTab)
  }, [requestedTab, requestedTabNonce])

  // Filter proofs for this deal
  const dealProofs = proofs.filter(p => p.dealId === String(deal.id))
  const dealProviders = deal.providers || []
  const dealProvidersKey = dealProviders.join(',')
  const primaryProvider = dealProviders[0] || ''
  const isDealOwner = Boolean(nilAddress && deal.owner === nilAddress)
  const [routeOverride, setRouteOverride] = useState<string>('')
  const [, setRouteModeOverride] = useState<string>('')
  const [cacheSourceOverride, setCacheSourceOverride] = useState<string>('')
  const [cacheFreshnessOverride, setCacheFreshnessOverride] = useState<string>('')
  const lastRouteLabel = useMemo(() => {
    if (routeOverride) return routeOverride
    const backend = lastTrace?.chosen?.backend
    return backend ? backend.replace('_', ' ') : ''
  }, [lastTrace, routeOverride])
  const displayCacheSource = cacheSourceOverride || progress.cacheSource || ''
  const displayCacheFreshness = cacheFreshnessOverride || progress.cacheFreshness || ''

  const markDownloadPath = useCallback(
    (route: string, mode: string, cacheSource: string, freshness: string) => {
      setRouteOverride(route)
      setRouteModeOverride(mode)
      setCacheSourceOverride(cacheSource)
      setCacheFreshnessOverride(freshness)
    },
    [],
  )

  useEffect(() => {
    if (!progress.route && !progress.cacheSource && !progress.cacheFreshness) return
    if (progress.route) setRouteOverride(progress.route.replace(/_/g, ' '))
    if (progress.cacheSource) setCacheSourceOverride(progress.cacheSource)
    if (progress.cacheFreshness) setCacheFreshnessOverride(progress.cacheFreshness)
  }, [progress.route, progress.cacheSource, progress.cacheFreshness])

  useEffect(() => {
    setRouteOverride('')
    setRouteModeOverride('')
    setCacheSourceOverride('')
    setCacheFreshnessOverride('')
  }, [deal.id, deal.cid])

  const resolveProviderHttpBase = useCallback((): string => {
    const endpoints = (primaryProvider && providersByAddr[primaryProvider]?.endpoints) || []
    for (const ep of endpoints) {
      const trimmed = String(ep || '').trim()
      if (!trimmed) continue
      if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/$/, '')
      const httpUrl = multiaddrToHttpUrl(trimmed)
      if (httpUrl) return httpUrl
    }
    return appConfig.spBase
  }, [primaryProvider, providersByAddr])

  const handlePolicyUpdate = useCallback(async () => {
    setPolicyError(null)
    setPolicyStatus(null)
    const evmAddress = String(address || '')
    if (!evmAddress.startsWith('0x')) {
      setPolicyError('Connect wallet to update retrieval policy')
      return
    }
    const allowlistRoot = policyAllowlistRoot.trim()
    if (allowlistRoot && !/^0x[0-9a-fA-F]{64}$/.test(allowlistRoot)) {
      setPolicyError('Allowlist root must be 0x + 32 bytes')
      return
    }
    const voucherSigner = policyVoucherSigner.trim()
    if (voucherSigner && !/^0x[0-9a-fA-F]{40}$/.test(voucherSigner)) {
      setPolicyError('Voucher signer must be a 0x address')
      return
    }
    const allowlistRootHex = allowlistRoot ? (allowlistRoot as Hex) : undefined
    const voucherSignerHex = voucherSigner ? (voucherSigner as Hex) : undefined

    try {
      await submitPolicyUpdate({
        creator: evmAddress,
        dealId: Number(deal.id),
        mode: policyMode,
        allowlistRoot: allowlistRootHex,
        voucherSigner: voucherSignerHex,
      })
      setPolicyStatus('Retrieval policy updated')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setPolicyError(msg)
    }
  }, [address, deal.id, policyAllowlistRoot, policyMode, policyVoucherSigner, submitPolicyUpdate])

  const resolveProviderP2pTarget = useCallback(() => {
    const endpoints = (primaryProvider && providersByAddr[primaryProvider]?.endpoints) || []
    for (const ep of endpoints) {
      const target = multiaddrToP2pTarget(ep)
      if (target) return target
    }
    return undefined
  }, [primaryProvider, providersByAddr])

  useEffect(() => {
    if (!dealProvidersKey) {
      setProvidersByAddr({})
      return
    }

    let cancelled = false
    async function loadProviders() {
      try {
        const res = await fetch(`${appConfig.lcdBase}/nilchain/nilchain/v1/providers`)
        if (!res.ok) return
        const json = await res.json().catch(() => null)
        const list = Array.isArray((json as { providers?: unknown[] } | null)?.providers) ? (json as { providers: unknown[] }).providers : []

        const next: Record<string, ProviderInfo> = {}
        for (const raw of list) {
          const p = raw as { address?: unknown; endpoints?: unknown; status?: unknown }
          const addr = typeof p.address === 'string' ? p.address : ''
          if (!addr) continue
          next[addr] = {
            address: addr,
            status: typeof p.status === 'string' ? p.status : undefined,
            endpoints: Array.isArray(p.endpoints) ? (p.endpoints.filter((e) => typeof e === 'string') as string[]) : undefined,
          }
        }

        if (!cancelled) setProvidersByAddr(next)
      } catch {
        // ignore
      }
    }

    loadProviders()
    return () => {
      cancelled = true
    }
  }, [dealProvidersKey])

  const fetchLocalFiles = useCallback(async (dealId: string) => {
    setLoadingFiles(true)
    try {
      const localMeta = await readSlabMetadata(String(dealId))
      const persistedManifestRoot = normalizeManifestRoot(await readManifestRoot(String(dealId)))
      const metadataManifestRoot = normalizeManifestRoot(localMeta?.manifest_root)
      const metadataFresh = persistedManifestRoot !== '' && metadataManifestRoot !== '' && metadataManifestRoot === persistedManifestRoot
      if (localMeta && metadataFresh && localMeta.file_records.length > 0) {
        setFiles(
          localMeta.file_records.map((rec) => ({
            path: rec.path,
            size_bytes: rec.size_bytes,
            start_offset: rec.start_offset,
            flags: rec.flags,
          })),
        )
        return
      }
      if (localMeta && !metadataFresh) {
        console.warn('Local slab metadata is stale for file listing; reparsing MDU #0', {
          dealId,
          metadataManifestRoot: localMeta.manifest_root,
          persistedManifestRoot,
        })
      }
      const mdu0 = await readMdu(String(dealId), 0)
      if (!mdu0) {
        setFiles([])
        return
      }
      const parsed = parseNilfsFilesFromMdu0(mdu0)
      setFiles(parsed)
    } catch (e) {
      console.error('Failed to fetch local NilFS file list', e)
      setFiles([])
    } finally {
      setLoadingFiles(false)
    }
  }, [])

  useEffect(() => {
    let canceled = false
    async function refreshBrowserCache() {
      if (!files || files.length === 0) {
        setBrowserCachedByPath({})
        return
      }
      const dealId = String(deal.id)
      const entries = await Promise.all(
        files.map(async (f) => {
          try {
            return [f.path, await hasCachedFile(dealId, f.path)] as const
          } catch {
            return [f.path, false] as const
          }
        }),
      )
      if (canceled) return
      const next: Record<string, boolean> = {}
      for (const [path, ok] of entries) next[path] = ok
      setBrowserCachedByPath(next)
    }
    void refreshBrowserCache()
    return () => {
      canceled = true
    }
  }, [deal.id, files])

  function downloadBytesAsFile(bytes: Uint8Array, filePath: string) {
    const safe = new Uint8Array(bytes.byteLength)
    safe.set(bytes)
    const url = window.URL.createObjectURL(new Blob([safe.buffer], { type: 'application/octet-stream' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filePath.split('/').pop() || 'download'
    a.click()
    setTimeout(() => window.URL.revokeObjectURL(url), 1000)
  }

  function downloadBlobAsFile(blob: Blob, filePath: string) {
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filePath.split('/').pop() || 'download'
    a.click()
    setTimeout(() => window.URL.revokeObjectURL(url), 1000)
  }

  const downloadViaGatewayCache = useCallback(async ({
    manifestRoot,
    dealId,
    owner,
    filePath,
    rangeStart,
    rangeLen,
    fileSizeBytes,
    fileStartOffset,
    mduSizeBytes,
    blobSizeBytes,
  }: {
    manifestRoot: string
    dealId: string
    owner: string
    filePath: string
    rangeStart?: number
    rangeLen?: number
    fileSizeBytes?: number
    fileStartOffset?: number
    mduSizeBytes?: number
    blobSizeBytes?: number
  }): Promise<Blob> => {
    const normalizedManifest = String(manifestRoot || '').trim()
    if (!normalizedManifest) throw new Error('manifestRoot is required')
    const normalizedDealId = String(dealId || '').trim()
    if (!normalizedDealId) throw new Error('dealId is required')
    const normalizedOwner = String(owner || '').trim()
    if (!normalizedOwner) throw new Error('owner is required')
    const normalizedFilePath = String(filePath || '').trim()
    if (!normalizedFilePath) throw new Error('filePath is required')

    const safeStart = Math.max(0, Number(rangeStart || 0) || 0)
    let safeLen = Math.max(0, Number(rangeLen || 0) || 0)
    const sizeBytes = Math.max(0, Number(fileSizeBytes || 0) || 0)
    if (safeLen === 0) {
      if (sizeBytes <= 0) throw new Error('file size is required for full gateway cache download')
      if (safeStart >= sizeBytes) throw new Error('rangeStart beyond EOF')
      safeLen = sizeBytes - safeStart
    }
    if (safeLen <= 0) throw new Error('rangeLen must be positive')

    const effectiveBlobSizeBytes = Math.max(1, Number(blobSizeBytes ?? slab?.blob_size_bytes ?? 128 * 1024))
    const effectiveMduSizeBytes = Math.max(1, Number(mduSizeBytes ?? slab?.mdu_size_bytes ?? 8 * 1024 * 1024))
    const hasChunkMeta = Number.isFinite(Number(fileStartOffset)) && sizeBytes > 0
    const legacyChunks = hasChunkMeta
      ? planNilfsFileRangeChunks({
          fileStartOffset: Number(fileStartOffset),
          fileSizeBytes: sizeBytes,
          rangeStart: safeStart,
          rangeLen: safeLen,
          mduSizeBytes: effectiveMduSizeBytes,
          blobSizeBytes: effectiveBlobSizeBytes,
        })
      : safeLen <= effectiveBlobSizeBytes
        ? [{ rangeStart: safeStart, rangeLen: safeLen }]
        : []

    const search = new URLSearchParams({
      deal_id: normalizedDealId,
      owner: normalizedOwner,
      file_path: normalizedFilePath,
    })
    search.set('range_start', String(safeStart))
    search.set('range_len', String(safeLen))
    const query = search.toString()

    const downloadViaLegacyChunkedFetch = async (gatewayBase: string): Promise<Blob> => {
      if (legacyChunks.length === 0) {
        throw new Error('Gateway compatibility mode requires NILFS metadata for multi-blob ranges')
      }
      const legacySearch = new URLSearchParams({
        deal_id: normalizedDealId,
        owner: normalizedOwner,
        file_path: normalizedFilePath,
        deputy: '1',
      })
      const legacyQuery = legacySearch.toString()
      const parts: ArrayBuffer[] = []
      for (const chunk of legacyChunks) {
        const chunkStart = Number(chunk.rangeStart)
        const chunkLen = Number(chunk.rangeLen)
        if (!Number.isFinite(chunkStart) || !Number.isFinite(chunkLen) || chunkLen <= 0) {
          throw new Error('invalid gateway cache chunk')
        }
        const chunkEnd = chunkStart + chunkLen - 1
        const legacyUrl = `${gatewayBase}/gateway/fetch/${encodeURIComponent(normalizedManifest)}?${legacyQuery}`
        const legacyRes = await fetch(legacyUrl, {
          method: 'GET',
          headers: { Range: `bytes=${chunkStart}-${chunkEnd}` },
        })
        if (!legacyRes.ok) {
          const txt = await legacyRes.text().catch(() => '')
          throw new Error(decodeGatewayHttpError(legacyRes.status, txt))
        }
        const buf = await legacyRes.arrayBuffer()
        if (buf.byteLength === 0) {
          throw new Error('gateway returned empty chunk')
        }
        const clampedLen = Math.min(buf.byteLength, chunkLen)
        parts.push(buf.byteLength === clampedLen ? buf : buf.slice(0, clampedLen))
        if (clampedLen < chunkLen) {
          throw new Error('gateway returned short chunk')
        }
      }
      return new Blob(parts, { type: 'application/octet-stream' })
    }

    let lastError: Error | null = null
    for (const gatewayBase of gatewayDownloadBases) {
      try {
        const url = `${gatewayBase}/gateway/download/${encodeURIComponent(normalizedManifest)}?${query}`
        const res = await fetch(url, {
          method: 'GET',
        })
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          const decoded = decodeGatewayHttpError(res.status, txt)
          if (isGatewayOutdatedDownloadError(decoded)) {
            const legacyBlob = await downloadViaLegacyChunkedFetch(gatewayBase)
            markDownloadPath('gateway', 'gateway_cache', 'gateway_mdu_cache', 'fresh')
            return legacyBlob
          }
          throw new Error(decoded)
        }
        const blob = await res.blob()
        if (!blob || blob.size === 0) throw new Error('gateway returned empty payload')

        markDownloadPath('gateway', 'gateway_cache', 'gateway_mdu_cache', 'fresh')
        return blob
      } catch (e: unknown) {
        lastError = e instanceof Error ? e : new Error(String(e))
      }
    }

    throw lastError ?? new Error('gateway cache download failed')
  }, [gatewayDownloadBases, markDownloadPath, slab?.blob_size_bytes, slab?.mdu_size_bytes])

  const reconcileLocalMduCache = useCallback(async (dealId: string, chainManifestRoot: string): Promise<LocalCacheFreshnessResult> => {
    const normalizedDealId = String(dealId)
    const persistedManifestRoot = normalizeManifestRoot(await readManifestRoot(normalizedDealId).catch(() => null))
    const localMeta = await readSlabMetadata(normalizedDealId).catch(() => null)
    const metadataManifestRoot = normalizeManifestRoot(localMeta?.manifest_root)
    const localManifestRoot = persistedManifestRoot || metadataManifestRoot
    const freshness = evaluateCacheFreshness(localManifestRoot, chainManifestRoot)
    const base: LocalCacheFreshnessResult = {
      usable: freshness.status === 'fresh',
      status: freshness.status,
      reason: freshness.reason,
      localManifestRoot: freshness.localManifestRoot,
      chainManifestRoot: freshness.chainManifestRoot,
    }

    if (freshness.status === 'fresh') {
      void (async () => {
        try {
          if (localMeta) {
            await writeSlabMetadata(normalizedDealId, {
              ...localMeta,
              last_validated_at: new Date().toISOString(),
            })
          }
          if (!persistedManifestRoot && metadataManifestRoot && metadataManifestRoot === freshness.localManifestRoot) {
            await writeManifestRoot(normalizedDealId, metadataManifestRoot)
          }
        } catch (e) {
          console.warn('Failed to update local slab metadata freshness timestamp', { dealId, error: e })
        }
      })()
      return base
    }

    if (freshness.status === 'stale') {
      try {
        await deleteDealDirectory(normalizedDealId)
        setBrowserCachedByPath({})
        console.info('Cleared stale browser MDU cache', {
          dealId,
          reason: freshness.reason,
          localManifestRoot: freshness.localManifestRoot,
          chainManifestRoot: freshness.chainManifestRoot,
        })
      } catch (e) {
        console.warn('Failed to clear stale browser MDU cache', {
          dealId,
          reason: freshness.reason,
          error: e,
        })
        return {
          ...base,
          status: 'unknown',
          reason: 'stale_cleanup_failed',
          usable: false,
        }
      }
    }
    return base
  }, [])

  const fetchSlab = useCallback(async (cid: string, dealId?: string, owner?: string) => {
    setLoadingSlab(true)
    try {
      setGatewaySlabStatus('unknown')
      setSlabSource('none')
      const directBase = resolveProviderHttpBase()
      const p2pTarget = appConfig.p2pEnabled ? resolveProviderP2pTarget() : undefined
      const result = await fetchSlabLayout({
        manifestRoot: cid,
        dealId: String(dealId || ''),
        owner: String(owner || ''),
        directBase,
        p2pTarget,
      })
      setSlab(result.data)
      setSlabSource('gateway')
      setGatewaySlabStatus('present')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/slab not found on disk/i.test(msg) || /\b404\b/.test(msg)) {
        setGatewaySlabStatus('missing')
      } else {
        setGatewaySlabStatus('error')
      }

      // Fall back to local OPFS slab layout if available (thick client / multi-tab).
      try {
        if (!dealId) return
        const cacheFreshness = await reconcileLocalMduCache(String(dealId), cid)
        if (!cacheFreshness.usable) return

        const localMeta = await readSlabMetadata(String(dealId))
        const persistedManifestRoot = normalizeManifestRoot(await readManifestRoot(String(dealId)))
        const expectedManifestRoot = normalizeManifestRoot(cid)
        const metadataManifestRoot = normalizeManifestRoot(localMeta?.manifest_root)
        const metadataFresh =
          !!localMeta &&
          persistedManifestRoot !== '' &&
          metadataManifestRoot === persistedManifestRoot &&
          (expectedManifestRoot === '' || metadataManifestRoot === expectedManifestRoot)

        let localFiles: NilfsFileEntry[] = []
        let witnessCount = 0
        let totalMdus = 0
        let userCount = 0
        let fileRecords = 0
        let totalSizeBytes = 0
        if (localMeta && metadataFresh) {
          localFiles = localMeta.file_records.map((rec) => ({
            path: rec.path,
            size_bytes: rec.size_bytes,
            start_offset: rec.start_offset,
            flags: rec.flags,
          }))
          witnessCount = localMeta.witness_mdus
          totalMdus = localMeta.total_mdus
          userCount = localMeta.user_mdus
          fileRecords = localMeta.file_records.length
          totalSizeBytes = localMeta.file_records.reduce((acc, rec) => acc + (Number(rec.size_bytes) || 0), 0)
        } else {
          if (localMeta && !metadataFresh) {
            console.warn('Local slab metadata is stale; reparsing MDU #0', {
              dealId,
              metadataManifestRoot: localMeta.manifest_root,
              persistedManifestRoot,
              expectedManifestRoot: cid,
            })
          }
          const mdu0 = await readMdu(String(dealId), 0)
          if (!mdu0) return
          localFiles = parseNilfsFilesFromMdu0(mdu0)
          const inferred = await inferWitnessCountFromOpfs(String(dealId), localFiles)
          witnessCount = inferred.witnessCount
          totalMdus = inferred.totalMdus
          userCount = inferred.userCount
          fileRecords = localFiles.length
          totalSizeBytes = localFiles.reduce((acc, f) => acc + (Number(f.size_bytes) || 0), 0)
        }
        const mduSizeBytes = 8 * 1024 * 1024
        const blobSizeBytes = 128 * 1024
        const segments = [
          { kind: 'mdu0', start_index: 0, count: 1, size_bytes: mduSizeBytes },
          ...(witnessCount > 0 ? [{ kind: 'witness', start_index: 1, count: witnessCount, size_bytes: witnessCount * mduSizeBytes }] : []),
          ...(userCount > 0
            ? [{ kind: 'user', start_index: 1 + witnessCount, count: userCount, size_bytes: userCount * mduSizeBytes }]
            : []),
        ] as SlabLayoutData['segments']
        setSlab({
          manifest_root: localMeta?.manifest_root || cid,
          mdu_size_bytes: mduSizeBytes,
          blob_size_bytes: blobSizeBytes,
          total_mdus: totalMdus,
          witness_mdus: witnessCount,
          user_mdus: userCount,
          file_records: fileRecords,
          file_count: localFiles.length,
          total_size_bytes: totalSizeBytes,
          segments,
        })
        setSlabSource('opfs')
      } catch (e2) {
        console.error('Failed to infer local slab layout', e2)
      }
    } finally {
      setLoadingSlab(false)
    }
  }, [fetchSlabLayout, resolveProviderHttpBase, resolveProviderP2pTarget, reconcileLocalMduCache])

  const fetchFiles = useCallback(async (cid: string, dealId: string, owner: string) => {
    if (!cid || !dealId || !owner) return
    setLoadingFiles(true)
    try {
      const directBase = resolveProviderHttpBase()
      const p2pTarget = appConfig.p2pEnabled ? resolveProviderP2pTarget() : undefined
      const result = await listFilesTransport({
        manifestRoot: cid,
        dealId,
        owner,
        directBase,
        p2pTarget,
      })
      const list = result.data
      if (list.length > 0) {
        setFiles(list)
        return
      }

      const cacheFreshness = await reconcileLocalMduCache(String(dealId), cid)
      if (!cacheFreshness.usable) {
        setFiles(list)
        return
      }

      const mdu0 = await readMdu(String(dealId), 0)
      if (!mdu0) {
        setFiles(list)
        return
      }
      setFiles(parseNilfsFilesFromMdu0(mdu0))
    } catch (e) {
      console.error('Failed to fetch NilFS file list', e)
      await fetchLocalFiles(dealId)
    } finally {
      setLoadingFiles(false)
    }
  }, [fetchLocalFiles, resolveProviderHttpBase, resolveProviderP2pTarget, listFilesTransport, reconcileLocalMduCache])

  const fetchManifestInfo = useCallback(async (cid: string, dealId?: string, owner?: string) => {
    setLoadingManifestInfo(true)
    setManifestInfoError(null)
    setMduRootMerkle(null)
    setMerkleError(null)
    try {
      const directBase = resolveProviderHttpBase()
      const p2pTarget = appConfig.p2pEnabled ? resolveProviderP2pTarget() : undefined
      const result = await manifestInfoTransport({
        manifestRoot: cid,
        dealId: dealId ? String(dealId) : undefined,
        owner,
        directBase,
        p2pTarget,
      })
      setManifestInfo(result.data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Failed to fetch manifest info', e)

      // Local OPFS fallback: compute manifest info from locally stored MDUs.
      try {
        if (!dealId) throw new Error('missing deal id')
        const cacheFreshness = await reconcileLocalMduCache(String(dealId), cid)
        if (!cacheFreshness.usable) throw new Error(`local slab not available (${cacheFreshness.reason})`)

        const mdu0 = await readMdu(String(dealId), 0)
        if (!mdu0) throw new Error('missing local MDU #0')
        const localFiles = parseNilfsFilesFromMdu0(mdu0)
        const { witnessCount, totalMdus, userCount } = await inferWitnessCountFromOpfs(String(dealId), localFiles)

        await ensureWasmReady()

        const rootsOut: { kind: 'mdu0' | 'witness' | 'user'; mdu_index: number; root_hex: string; root_table_index?: number }[] = []
        const rootsAgg = new Uint8Array(32 * totalMdus)

        for (let idx = 0; idx < totalMdus; idx++) {
          const bytes = await readMdu(String(dealId), idx)
          if (!bytes) throw new Error(`missing local MDU #${idx}`)
          const copy = new Uint8Array(bytes)
          const committed = await workerClient.shardFile(copy)
          const mduRoot = toU8((committed as { mdu_root?: Uint8Array | number[] }).mdu_root)
          if (mduRoot.byteLength !== 32) throw new Error(`invalid mdu_root length for MDU #${idx}`)
          rootsAgg.set(mduRoot, idx * 32)

          const kind = idx === 0 ? 'mdu0' : idx <= witnessCount ? 'witness' : 'user'
          const rootHex = bytesTo0xHex(mduRoot)
          const rec: (typeof rootsOut)[number] = { mdu_index: idx, kind, root_hex: rootHex }
          if (idx > 0) rec.root_table_index = idx - 1
          rootsOut.push(rec)
        }

        const manifest = await workerClient.computeManifest(rootsAgg)
        const computedRoot = bytesTo0xHex(toU8((manifest as { root?: Uint8Array | number[] }).root))
        const blobHex = bytesTo0xHex(toU8((manifest as { blob?: Uint8Array | number[] }).blob))

        if (cid && computedRoot.trim().toLowerCase() !== cid.trim().toLowerCase()) {
          setManifestInfoError(`manifest root mismatch: computed=${shortHex(computedRoot)} expected=${shortHex(cid)}`)
        }

        setManifestInfo({
          manifest_root: computedRoot || cid,
          manifest_blob_hex: blobHex,
          total_mdus: totalMdus,
          witness_mdus: witnessCount,
          user_mdus: userCount,
          roots: rootsOut,
        })
        return
      } catch (e2) {
        console.error('Failed to compute local manifest info', e2)
      }

      setManifestInfo(null)
      setManifestInfoError(msg || 'Failed to fetch manifest info')
    } finally {
      setLoadingManifestInfo(false)
    }
  }, [manifestInfoTransport, resolveProviderHttpBase, resolveProviderP2pTarget, reconcileLocalMduCache])

  async function fetchMduKzg(cid: string, mduIndex: number, dealId?: string, owner?: string) {
    setLoadingMduKzg(true)
    setMduKzgError(null)
    try {
      const directBase = resolveProviderHttpBase()
      const p2pTarget = appConfig.p2pEnabled ? resolveProviderP2pTarget() : undefined
      const result = await mduKzgTransport({
        manifestRoot: cid,
        mduIndex,
        dealId: dealId ? String(dealId) : undefined,
        owner,
        directBase,
        p2pTarget,
      })
      setMduKzg(result.data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('Failed to fetch MDU KZG', e)

      // Local OPFS fallback.
      try {
        if (!dealId) throw new Error('missing deal id')
        const cacheFreshness = await reconcileLocalMduCache(String(dealId), cid)
        if (!cacheFreshness.usable) throw new Error(`local slab not available (${cacheFreshness.reason})`)

        const bytes = await readMdu(String(dealId), mduIndex)
        if (!bytes) throw new Error(`missing local MDU #${mduIndex}`)

        await ensureWasmReady()
        const copy = new Uint8Array(bytes)
        const committed = await workerClient.shardFile(copy)

        const witnessFlat = toU8((committed as { witness_flat?: Uint8Array | number[] }).witness_flat)
        const mduRoot = toU8((committed as { mdu_root?: Uint8Array | number[] }).mdu_root)
        if (mduRoot.byteLength !== 32) throw new Error(`invalid mdu_root length for MDU #${mduIndex}`)
        if (witnessFlat.byteLength === 0 || witnessFlat.byteLength % 48 !== 0) throw new Error('invalid witness_flat length')

        const blobCount = witnessFlat.byteLength / 48
        const blobs: string[] = []
        for (let i = 0; i < blobCount; i++) {
          blobs.push(bytesTo0xHex(witnessFlat.slice(i * 48, (i + 1) * 48)))
        }

        const kind =
          slab && slab.total_mdus > 0
            ? mduIndex === 0
              ? 'mdu0'
              : mduIndex <= slab.witness_mdus
                ? 'witness'
                : 'user'
            : 'user'

        setMduKzg({
          manifest_root: cid,
          mdu_index: mduIndex,
          kind,
          root_hex: bytesTo0xHex(mduRoot),
          blobs,
        })
        return
      } catch (e2) {
        console.error('Failed to compute local MDU KZG', e2)
      }

      setMduKzg(null)
      setMduKzgError(msg || 'Failed to fetch MDU commitments')
    } finally {
      setLoadingMduKzg(false)
    }
  }

  function shortHex(hex: string, head = 10, tail = 6) {
    if (!hex) return '—'
    if (hex.length <= 2 + head + tail) return hex
    return `${hex.slice(0, 2 + head)}…${hex.slice(-tail)}`
  }

  function shortAddr(addr: string, head = 10, tail = 6) {
    const a = String(addr || '').trim()
    if (!a) return '—'
    if (a.length <= head + tail + 3) return a
    return `${a.slice(0, head)}…${a.slice(-tail)}`
  }

  function formatBigint(v: bigint): string {
    try {
      return v.toString()
    } catch {
      return '—'
    }
  }

  const fetchHeat = useCallback(async (dealId: string) => {
      try {
          const res = await fetch(`${appConfig.lcdBase}/nilchain/nilchain/v1/deals/${dealId}/heat`)
          if (res.ok) {
              const json = await res.json()
              if (json.heat) {
                  setHeat(json.heat)
              }
          }
      } catch (e) {
          console.error("Failed to fetch heat", e)
      }
  }, [])

  useEffect(() => {
    if (receiptStatus !== 'submitted') return
    let canceled = false
    const run = async () => {
      // The provider submits the receipt tx; wait briefly for inclusion even in sync-broadcast mode.
      for (let i = 0; i < 8; i++) {
        if (canceled) return
        await fetchHeat(deal.id)
        await new Promise((r) => setTimeout(r, 750))
      }
    }
    run()
    return () => {
      canceled = true
    }
  }, [fetchHeat, receiptStatus, deal.id])

  useEffect(() => {
    if (deal.cid && deal.cid !== '') {
      const owner = nilAddress || deal.owner
      void fetchSlab(deal.cid, deal.id, owner)
      void fetchFiles(deal.cid, deal.id, owner)
      void fetchManifestInfo(deal.cid, deal.id, owner)
    } else {
      // Do not surface local OPFS slabs for "empty" deals; OPFS is treated as a cache for on-chain content.
      // This avoids showing stale slabs after a chain reset where deal IDs are reused.
      setLoadingFiles(false)
      setLoadingSlab(false)
      setFiles(null)
      setSlab(null)
      setSlabSource('none')
      setGatewaySlabStatus('unknown')
      setBrowserCachedByPath({})
      setManifestInfo(null)
    }
    setFileActionError(null)
    void fetchHeat(deal.id)
  }, [deal.cid, deal.id, deal.owner, fetchFiles, fetchHeat, fetchLocalFiles, fetchManifestInfo, fetchSlab, nilAddress])

  return (
    <div
      className="glass-panel industrial-border cyber-grid p-0 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_25px_hsl(var(--border)_/_0.25)]"
      data-testid="deal-detail"
    >
      <div className="flex items-center justify-between p-5 border-b border-border/40 bg-background/40 backdrop-blur-md">
        <div className="flex items-center gap-3">
            <div className="bg-primary/10 p-2 border border-primary/30">
                <FileJson className="w-5 h-5 text-primary" />
            </div>
            <div>
                <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground dark:text-foreground/90">/deal/explorer</div>
                <div className="text-lg font-bold text-foreground" data-testid="workspace-deal-title">Deal #{deal.id}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span
                    className={`border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] ${
                      hasCommittedContent
                        ? 'border-success/40 bg-success/10 text-success'
                        : 'border-border bg-secondary/60 text-muted-foreground'
                    }`}
                  >
                    {dealStatusLabel}
                  </span>
                  <span className="font-mono-data text-foreground">{dealSizeLabel}</span>
                  <span className="text-border">|</span>
                  <span className="border border-border bg-secondary/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                    {redundancyLabel}
                  </span>
                </div>
                {displayManifestRoot ? (
                  <div
                    className="mt-2 font-mono-data text-[10px] text-primary break-all"
                    data-testid={`deal-manifest-${deal.id}`}
                    title={displayManifestRoot}
                  >
                    {displayManifestRoot}
                  </div>
                ) : null}
            </div>
        </div>
      </div>

      {topPanel ? <div className="border-b border-border">{topPanel}</div> : null}

      <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-border">
        <button
          onClick={() => setActiveTab('files')}
          data-testid="deal-detail-tab-files"
          className={`py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'files' ? 'border-primary text-foreground bg-secondary' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
        >
          Files
        </button>
        <button
          onClick={() => setActiveTab('info')}
          data-testid="deal-detail-tab-info"
          className={`py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'info' ? 'border-primary text-foreground bg-secondary' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
        >
          Deal info
        </button>
        <button
          onClick={() => setActiveTab('manifest')}
          data-testid="deal-detail-tab-manifest"
          className={`py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'manifest' ? 'border-primary text-foreground bg-secondary' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
        >
          Manifest &amp; MDUs
        </button>
        <button
          onClick={() => setActiveTab('heat')}
          data-testid="deal-detail-tab-heat"
          className={`py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'heat' ? 'border-primary text-foreground bg-secondary' : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'}`}
        >
          Heat &amp; Liveness
        </button>
      </div>

      <div className="p-6">
          {activeTab === 'info' && (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  {/* Identity Section */}
                  <div className="nil-tab-panel grid gap-6 sm:grid-cols-2">
                    <div className="space-y-2">
                        <div className="nil-detail-label">/CONTENT_HASH</div>
                        <div
                          className="nil-tab-inset font-mono-data break-all text-primary font-bold select-all"
                          data-testid="deal-detail-cid"
                        >
                          {deal.cid || 'EMPTY_CONTAINER'}
                        </div>
                    </div>
                    <div className="space-y-2">
                      <div className="nil-detail-label">/OWNER_ID</div>
                      <div className="nil-tab-inset font-mono-data text-[11px] text-foreground font-bold select-all">
                        {deal.owner}
                      </div>
                    </div>
                  </div>

                  {/* Economics Section */}
                  <div className="nil-tab-panel space-y-3">
                    <div className="nil-detail-label">/ECONOMICS</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      <div className="nil-detail-metric">
                        <span className="block text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Escrow</span>
                        <span className="text-foreground font-mono-data font-bold">{deal.escrow ? `${deal.escrow} NIL` : '—'}</span>
                      </div>
                      <div className="nil-detail-metric">
                        <span className="block text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Max Monthly</span>
                        <span className="text-foreground font-mono-data font-bold">{deal.max_monthly_spend ? `${deal.max_monthly_spend} NIL` : '—'}</span>
                      </div>
                      <div className="nil-detail-metric">
                        <span className="block text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Redundancy</span>
                        <span className="text-accent font-bold uppercase">{isMode2 ? 'Mode 2 (RS)' : 'Mode 1'}</span>
                      </div>
                      <div className="nil-detail-metric">
                        <span className="block text-[9px] font-bold uppercase tracking-wider text-muted-foreground">Status</span>
                        <span className={`font-bold uppercase ${deal.cid ? 'text-success' : 'text-muted-foreground'}`}>
                          {deal.cid ? 'Active' : 'Empty'}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Infrastructure / Providers Section */}
                  <div className="nil-tab-panel space-y-3">
                    <div className="nil-detail-label">/INFRASTRUCTURE_NODES</div>
                    <div className="nil-inset divide-y divide-border/30">
                        {deal.providers && deal.providers.length > 0 ? (
                          deal.providers.map((p: string, idx: number) => (
                            <div key={p} className="nil-list-row p-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                              <div className="flex items-center gap-4">
                                <div className="nil-inset flex h-8 w-8 items-center justify-center text-muted-foreground">
                                  <span className="text-[10px] font-black">{idx}</span>
                                </div>
                                <div className="space-y-1">
                                  <div className="font-mono-data text-[11px] text-foreground font-bold flex items-center gap-2">
                                    {shortAddr(p)}
                                    {providersByAddr[p]?.status && (
                                      <span className={`text-[9px] px-1.5 py-0.5 border ${
                                        providersByAddr[p].status === 'ok' ? 'text-success border-success/30 bg-success/5' : 'text-primary border-primary/30 bg-primary/5'
                                      }`}>
                                        {providersByAddr[p].status?.toUpperCase()}
                                      </span>
                                    )}
                                  </div>
                                  <div className="font-mono-data text-[10px] text-muted-foreground">
                                    {providersByAddr[p]?.endpoints?.[0] || 'NO_ENDPOINT_REPORTED'}
                                  </div>
                                </div>
                              </div>
                              <div className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">
                                {isMode2 ? `SLOT_ALLOCATION_${idx}` : 'REPLICA_NODE'}
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="p-8 text-center text-muted-foreground italic text-xs uppercase tracking-widest opacity-40">
                            No infrastructure nodes assigned to this container.
                          </div>
                        )}
                    </div>
                  </div>

                  {/* Technical Details Collapsible */}
                  <div className="nil-tab-panel">
                    <details className="group">
                      <summary className="nil-detail-label cursor-pointer select-none flex items-center gap-3 hover:text-primary transition-colors">
                        <div className="w-4 h-4 border border-current flex items-center justify-center group-open:rotate-90 transition-transform">
                          <span className="leading-none">+</span>
                        </div>
                        /TECHNICAL_DETAILS_AND_POLICIES
                      </summary>
                      <div className="mt-6 space-y-6 pl-7">
                        <div className="grid sm:grid-cols-2 gap-6">
                          {/* Retrieval Policy */}
                          <div className="space-y-3">
                            <div className="nil-detail-label text-[9px]">/RETRIEVAL_POLICY</div>
                            <div className="nil-tab-inset space-y-3">
                                <div className="text-[9px] text-muted-foreground uppercase font-black">Current Configuration</div>
                                <div className="text-xs font-bold text-foreground flex items-center gap-2">
                                  <div className="h-1.5 w-1.5 bg-primary" />
                                  {(deal.retrieval_policy?.mode ?? 1) === 1 && 'OWNER_ONLY'}
                                  {(deal.retrieval_policy?.mode ?? 1) === 2 && 'ALLOWLIST_ONLY'}
                                  {(deal.retrieval_policy?.mode ?? 1) === 3 && 'VOUCHER_ONLY'}
                                  {(deal.retrieval_policy?.mode ?? 1) === 4 && 'HYBRID_AUTH'}
                                  {(deal.retrieval_policy?.mode ?? 1) === 5 && 'PUBLIC_ACCESS'}
                                </div>
                                {deal.retrieval_policy?.allowlist_root && (
                                  <div className="text-[10px] text-muted-foreground font-mono-data break-all bg-background/40 p-2">
                                    ROOT: {deal.retrieval_policy.allowlist_root}
                                  </div>
                                )}
                             </div>
                          </div>

                          {/* Admin Override */}
                          {isDealOwner && (
                            <div className="space-y-3">
                              <div className="nil-detail-label text-[9px]">/ADMIN_OVERRIDE</div>
                              <div className="nil-tab-inset space-y-4">
                                <div className="grid gap-3">
                                  <select
                                    value={policyMode}
                                    onChange={(e) => setPolicyMode(Number(e.target.value) as RetrievalPolicyMode)}
                                    className="recessed-input px-3 py-2 text-[11px]"
                                  >
                                    <option value={1}>OWNER_ONLY</option>
                                    <option value={2}>ALLOWLIST</option>
                                    <option value={3}>VOUCHER</option>
                                    <option value={4}>HYBRID</option>
                                    <option value={5}>PUBLIC</option>
                                  </select>
                                  <button
                                    onClick={handlePolicyUpdate}
                                    disabled={policyUpdating}
                                    className="w-full border border-primary/40 bg-primary/5 py-2 text-[9px] font-black uppercase tracking-widest text-primary hover:bg-primary/10 transition-colors"
                                  >
                                    {policyUpdating ? 'COMMITING_CHANGES...' : 'UPDATE_POLICY_STATE'}
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Advanced Metrics */}
                        <div className="space-y-3">
                          <div className="nil-detail-label text-[9px]">/ADVANCED_TELEMETRY</div>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                              <div className="nil-detail-metric">
                                <div className="text-[9px] text-muted-foreground uppercase font-bold">Traffic</div>
                                <div className="font-mono-data text-[11px] text-foreground font-bold">
                                  {heat ? `${(Number(heat.bytes_served_total) / 1024 / 1024).toFixed(2)} MB` : '—'}
                                </div>
                              </div>
                              <div className="nil-detail-metric">
                                <div className="text-[9px] text-muted-foreground uppercase font-bold">Slab Source</div>
                                <div className="font-mono-data text-[11px] text-accent font-bold uppercase">{slabSource || '—'}</div>
                              </div>
                              {lastPlan && (
                                <div className="nil-detail-metric col-span-2">
                                  <div className="text-[9px] text-muted-foreground uppercase font-bold">Last Retrieval Window</div>
                                  <div className="font-mono-data text-[10px] text-foreground mt-1 truncate">
                                    MDU #{formatBigint(lastPlan.globalStart / lastPlan.leafCount)}..#{formatBigint(lastPlan.globalEnd / lastPlan.leafCount)}
                                  </div>
                                </div>
                              )}
                          </div>
                        </div>
                      </div>
                    </details>
                  </div>
              </div>
          )}

          {activeTab === 'files' && deal.cid && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                  <div className="nil-tab-panel space-y-3">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-3">
                        <div className="nil-detail-label">/VFS/CONTENT</div>
                        {files && <span className="nil-detail-meta border border-border bg-background/50 px-2 py-0.5">{files.length} ENTRIES</span>}
                      </div>
                      
                      <div className="nil-detail-meta flex flex-wrap items-center gap-4 uppercase tracking-widest">
                        <div className="flex items-center gap-2" data-testid="transport-route">
                          <span className="w-2 h-[1px] bg-border/40" />
                          ROUTE: <span className="text-foreground font-bold">{lastRouteLabel || '—'}</span>
                        </div>
                        <div className="flex items-center gap-2" data-testid="transport-cache-source">
                          <span className="w-2 h-[1px] bg-border/40" />
                          CACHE: <span className="text-foreground font-bold">{displayCacheSource || '—'}</span>
                        </div>
                        <div className="flex items-center gap-2" data-testid="transport-cache-freshness">
                          <span className="w-2 h-[1px] bg-border/40" />
                          FRESHNESS: <span className="text-foreground font-bold">{displayCacheFreshness || '—'}</span>
                        </div>
                      </div>
                    </div>

                    {files ? (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                        <div className="nil-tab-inset">
                          <div className="nil-detail-meta uppercase">Files</div>
                          <div className="mt-1 text-lg font-mono-data text-foreground">{files.length}</div>
                        </div>
                        <div className="nil-tab-inset">
                          <div className="nil-detail-meta uppercase">Route</div>
                          <div className="mt-1 text-sm font-bold text-foreground">{lastRouteLabel || '—'}</div>
                        </div>
                        <div className="nil-tab-inset">
                          <div className="nil-detail-meta uppercase">Cache</div>
                          <div className="mt-1 text-sm font-bold text-foreground">{displayCacheSource || '—'}</div>
                        </div>
                        <div className="nil-tab-inset">
                          <div className="nil-detail-meta uppercase">Freshness</div>
                          <div className="mt-1 text-sm font-bold text-foreground">{displayCacheFreshness || '—'}</div>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {fileActionError && (
                    <div className="nil-tab-panel border-destructive/30 bg-destructive/5 text-[10px] text-destructive font-bold uppercase tracking-widest flex items-center gap-2">
                      <XCircle className="w-3 h-3" />
                      Download failed: {fileActionError}
                    </div>
                  )}

                      {loadingFiles ? (
                        <div className="nil-tab-panel text-xs text-muted-foreground">Loading file table…</div>
                      ) : files && files.length > 0 ? (
                        <div className="nil-tab-panel space-y-2" data-testid="deal-detail-file-list">
                          {files.map((f) => (
                            <FileRow
                              key={`${f.path}:${f.start_offset}`}
                              file={f}
                              allFiles={files}
                              deal={deal}
                              nilAddress={nilAddress}
                              browserCached={!!browserCachedByPath[f.path]}
                              gatewayCached={f.cache_present === true}
                              isBusy={busyFilePath === f.path}
                              isAnyDownloading={downloading}
                              isOpen={openMenuFilePath === f.path}
                              onToggleMenu={() => setOpenMenuFilePath(openMenuFilePath === f.path ? null : f.path)}
                              onFileActivity={onFileActivity}
                              reconcileLocalMduCache={reconcileLocalMduCache}
                              downloadBytesAsFile={downloadBytesAsFile}
                              downloadBlobAsFile={downloadBlobAsFile}
                              markDownloadPath={markDownloadPath}
                              downloadViaGatewayCache={downloadViaGatewayCache}
                              fetchFile={fetchFile}
                              resolveProviderHttpBase={resolveProviderHttpBase}
                              sponsoredAuth={sponsoredAuth}
                              slab={slab}
                              setBrowserCachedByPath={setBrowserCachedByPath}
                              setFileActionError={setFileActionError}
                              setBusyFilePath={setBusyFilePath}
                              downloadRangeStart={downloadRangeStart}
                              downloadRangeLen={downloadRangeLen}
                              transportPreference={transportPreference}
                              setSelectedMdu={setSelectedMdu}
                              setActiveTab={setActiveTab}
                            />
                          ))}
                        </div>
                      ) : (
                        <div className="nil-tab-panel text-xs text-muted-foreground italic">No files found for this manifest root.</div>
                      )}
                    </div>
                  )}

                  {activeTab === 'files' && !deal.cid && (
                    <div className="nil-tab-panel sm:col-span-2 p-8 text-center">
                      <div className="text-sm font-semibold text-foreground">No files yet</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Upload a file inside this deal to store and retrieve.
                      </div>
                    </div>
                  )}

        {activeTab === 'manifest' && (
            <div className="space-y-4">
                {loadingSlab ? (
                    <div className="text-center py-8 text-muted-foreground text-xs">Loading slab layout...</div>
                ) : slab ? (
                    <>
                        <div className="grid grid-cols-2 gap-4 text-xs">
                              <div className="bg-secondary/50 p-3 rounded-none border border-border">
                                  <div className="text-muted-foreground uppercase text-[10px]">Slab MDUs</div>
                                  <div className="text-lg font-mono-data text-foreground">{slab.total_mdus}</div>
                                <div className="text-[10px] text-muted-foreground mt-1">
                                    MDU #0 + {slab.witness_mdus} witness + {slab.user_mdus} user
                                </div>
                                <div className="text-[10px] text-muted-foreground mt-1">
                                    Source: {slabSource === 'gateway' ? 'gateway' : slabSource === 'opfs' ? 'browser (OPFS)' : '—'}
                                </div>
                            </div>
                              <div className="bg-secondary/50 p-3 rounded-none border border-border">
                                  <div className="text-muted-foreground uppercase text-[10px]">Manifest Root</div>
                                  <div className="font-mono-data text-primary text-[10px] truncate" title={slab.manifest_root}>
                                      {slab.manifest_root.slice(0, 16)}...
                                  </div>
                              </div>
                        </div>

                        <div className="bg-secondary/50 border border-border rounded-none p-3 text-xs space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="text-xs text-muted-foreground uppercase font-semibold">Layout</div>
                                <div className="text-[10px] text-muted-foreground">
                                    {Math.round(slab.mdu_size_bytes / 1024 / 1024)} MiB / MDU • {Math.round(slab.blob_size_bytes / 1024)} KiB / Blob
                                </div>
                            </div>
                              <div className="h-2 bg-secondary overflow-hidden flex border border-border/50">
                                  {slab.segments.map((seg) => (
                                      <div
                                          key={`${seg.kind}:${seg.start_index}`}
                                          style={{ flexGrow: Math.max(1, seg.count) }}
                                          className={
                                              seg.kind === 'mdu0'
                                                  ? 'bg-primary/60'
                                                  : seg.kind === 'witness'
                                                      ? 'bg-foreground/15'
                                                      : 'bg-accent/60'
                                          }
                                          title={`${seg.kind} • start=${seg.start_index} • count=${seg.count}`}
                                      />
                                  ))}
                              </div>
                              <div className="grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
                                  <div>
                                      <span className="text-primary font-semibold">MDU #0</span>: Super-Manifest (File Table + Root Table)
                                  </div>
                                  <div>
                                      <span className="text-foreground font-semibold">Witness</span>:{' '}
                                      {slab.witness_mdus > 0 ? `MDU #1..#${slab.witness_mdus}` : 'none'}
                                  </div>
                                  <div>
                                      <span className="text-accent font-semibold">User</span>:{' '}
                                      {slab.user_mdus > 0 ? `MDU #${1 + slab.witness_mdus}..#${slab.total_mdus - 1}` : 'none'}
                                  </div>
                              </div>
                        </div>

                        <div className="bg-secondary/50 border border-border rounded-none p-3 text-xs">
                            <div className="text-muted-foreground uppercase text-[10px]">NilFS</div>
                            <div className="mt-1 text-[11px] text-foreground">
                                {slab.file_count} files • {slab.total_size_bytes} bytes
                            </div>
                            <div className="text-[10px] text-muted-foreground mt-1">
                                File records: {slab.file_records}
                            </div>
                        </div>

                        <div className="bg-secondary/50 border border-border rounded-none p-3 text-xs space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="text-xs text-muted-foreground uppercase font-semibold">Manifest Commitment</div>
                                <div className="text-[10px] text-muted-foreground">KZG commitment over MDU roots</div>
                            </div>

                            {loadingManifestInfo ? (
                              <div className="text-[11px] text-muted-foreground">Loading manifest details…</div>
                            ) : manifestInfo ? (
                              <>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="bg-background/50 border border-border rounded-none p-2">
                                    <div className="text-[10px] text-muted-foreground uppercase">Manifest Root</div>
                                      <div className="font-mono-data text-[10px] text-foreground break-all">{manifestInfo.manifest_root}</div>
                                  </div>
                                  <div className="bg-background/50 border border-border rounded-none p-2">
                                    <div className="text-[10px] text-muted-foreground uppercase">Manifest Blob</div>
                                      <div className="font-mono-data text-[10px] text-foreground break-all" title={manifestInfo.manifest_blob_hex}>
                                        {shortHex(manifestInfo.manifest_blob_hex, 24, 12)}
                                      </div>
                                    <div className="text-[10px] text-muted-foreground mt-1">
                                      Encodes the ordered root vector for KZG commitment
                                    </div>
                                  </div>
                                </div>

                                <div className="bg-background/50 border border-border rounded-none p-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <div className="text-[10px] text-muted-foreground uppercase">Ordered MDU Roots</div>
                                    <button
                                      onClick={() => {
                                        try {
                                          setMerkleError(null)
                                          const roots = manifestInfo.roots.map(r => r.root_hex).filter(Boolean)
                                          setMduRootMerkle(buildBlake2sMerkleLayers(roots))
                                        } catch (err) {
                                          setMduRootMerkle(null)
                                          setMerkleError(err instanceof Error ? err.message : 'Failed to build Merkle tree')
                                        }
                                      }}
                                      className="text-[10px] px-2 py-1 rounded-none border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
                                    >
                                      Build Merkle Tree (Debug)
                                    </button>
                                  </div>
                                  <div className="mt-2 space-y-1 max-h-52 overflow-auto pr-1">
                                    {manifestInfo.roots.map((r) => (
                                      <div key={`${r.kind}:${r.mdu_index}`} className="flex items-center justify-between gap-2">
                                        <div className="min-w-0">
                                          <div className="text-[10px] text-muted-foreground">
                                            MDU #{r.mdu_index} • {r.kind}
                                          </div>
                                            <div className="font-mono-data text-[10px] text-foreground truncate" title={r.root_hex}>
                                              {shortHex(r.root_hex, 16, 10)}
                                            </div>
                                        </div>
                                        <button
                                          onClick={() => {
                                            setSelectedMdu(r.mdu_index)
                                            fetchMduKzg(manifestInfo.manifest_root, r.mdu_index, deal.id, nilAddress)
                                          }}
                                          className="shrink-0 text-[10px] px-2 py-1 rounded-none border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
                                        >
                                          Inspect
                                        </button>
                                      </div>
                                    ))}
                                  </div>

                                    {merkleError && <div className="mt-2 text-[10px] text-destructive">{merkleError}</div>}

                                  {mduRootMerkle && mduRootMerkle.length > 0 && (
                                    <div className="mt-3 space-y-2">
                                      <div className="text-[10px] text-muted-foreground">
                                        Debug Merkle tree over the root vector (Blake2s, duplicate-last on odd levels).
                                      </div>
                                      <div className="space-y-2 max-h-64 overflow-auto pr-1">
                                        {mduRootMerkle.map((layer, idx) => (
                                          <div key={idx} className="bg-background/50 border border-border rounded-none p-2">
                                            <div className="text-[10px] text-muted-foreground uppercase">
                                              Level {idx} • {layer.length} nodes
                                            </div>
                                            <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1">
                                              {layer.map((h, j) => (
                                                <div
                                                  key={`${idx}:${j}`}
                                                    className="font-mono-data text-[10px] text-foreground truncate"
                                                    title={h}
                                                  >
                                                  {shortHex(h, 16, 10)}
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </>
                            ) : (
                              <div className="text-[11px] text-muted-foreground">
                                {manifestInfoError ?? 'No manifest details available yet.'}
                              </div>
                            )}
                        </div>

                        {manifestInfo?.roots?.length ? (
                          <div className="bg-secondary/50 border border-border rounded-none p-3 text-xs space-y-2">
                            <div className="flex items-center justify-between">
                              <div className="text-xs text-muted-foreground uppercase font-semibold">Root Table (MDU #0)</div>
                              <div className="text-[10px] text-muted-foreground">
                                {slab.witness_mdus + slab.user_mdus} entries
                              </div>
                            </div>
                            <div className="space-y-1 max-h-56 overflow-auto pr-1">
                              {manifestInfo.roots
                                .filter(r => r.root_table_index !== undefined)
                                .map((r) => (
                                  <div key={`rt:${r.mdu_index}`} className="flex items-center justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="text-[10px] text-muted-foreground">
                                        Root[{r.root_table_index}] → MDU #{r.mdu_index} • {r.kind}
                                      </div>
                                        <div className="font-mono-data text-[10px] text-foreground truncate" title={r.root_hex}>
                                          {shortHex(r.root_hex, 16, 10)}
                                        </div>
                                    </div>
                                    <button
                                      onClick={() => {
                                        setSelectedMdu(r.mdu_index)
                                        fetchMduKzg(manifestInfo.manifest_root, r.mdu_index, deal.id, nilAddress)
                                      }}
                                      className="shrink-0 text-[10px] px-2 py-1 rounded-none border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
                                    >
                                      Inspect
                                    </button>
                                  </div>
                                ))}
                            </div>
                          </div>
                        ) : null}

                        <div className="bg-secondary/50 border border-border rounded-none p-3 text-xs space-y-2">
                          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                            <div>
                              <div className="text-xs text-muted-foreground uppercase font-semibold">MDU Inspector</div>
                              <div className="text-[10px] text-muted-foreground">
                                Loads blob commitments (KZG) for a specific MDU
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <select
                                value={selectedMdu}
                                onChange={(e) => {
                                  const next = Number(e.target.value)
                                  setSelectedMdu(next)
                                  setMduKzg(null)
                                  setMduKzgError(null)
                                }}
                                className="text-[10px] bg-background border border-border rounded-none px-2 py-1 text-foreground"
                              >
                                {Array.from({ length: slab.total_mdus }).map((_, idx) => {
                                  const kind =
                                    idx === 0 ? 'mdu0' : idx <= slab.witness_mdus ? 'witness' : 'user'
                                  return (
                                    <option key={idx} value={idx}>
                                      MDU #{idx} • {kind}
                                    </option>
                                  )
                                })}
                              </select>
                              <button
                                onClick={() => fetchMduKzg(slab.manifest_root, selectedMdu, deal.id, nilAddress)}
                                className="text-[10px] px-2 py-1 rounded-none border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
                              >
                                {loadingMduKzg ? 'Loading…' : 'Load Commitments'}
                              </button>
                            </div>
                          </div>

                            {mduKzgError && <div className="text-[10px] text-destructive">{mduKzgError}</div>}

                          {mduKzg && mduKzg.mdu_index === selectedMdu ? (
                            <div className="space-y-2">
                              <div className="grid grid-cols-2 gap-2">
                                <div className="bg-background/50 border border-border rounded-none p-2">
                                  <div className="text-[10px] text-muted-foreground uppercase">MDU Root</div>
                                    <div className="font-mono-data text-[10px] text-foreground break-all">
                                      {shortHex(mduKzg.root_hex, 24, 12)}
                                    </div>
                                  <div className="text-[10px] text-muted-foreground mt-1">
                                    Blake2s Merkle root over 64 blob commitments
                                  </div>
                                </div>
                                <div className="bg-background/50 border border-border rounded-none p-2">
                                  <div className="text-[10px] text-muted-foreground uppercase">Blob Commitments</div>
                                    <div className="text-[11px] text-foreground font-mono-data">{mduKzg.blobs.length}</div>
                                  <div className="text-[10px] text-muted-foreground mt-1">
                                    128 KiB each • {Math.round(slab.mdu_size_bytes / 1024 / 1024)} MiB total
                                  </div>
                                </div>
                              </div>

                              <div className="bg-background/50 border border-border rounded-none p-2">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="text-[10px] text-muted-foreground uppercase">Stripe Layout</div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {stripeLayout.slots} slots ({stripeLayout.k}+{stripeLayout.m})
                                  </div>
                                </div>
                                {!stripeLayout.isMode2 && (
                                  <div className="text-[10px] text-muted-foreground mt-1">
                                    Mode 1 deals replicate full MDUs; stripe view is illustrative.
                                  </div>
                                )}
                                <div
                                  className="mt-2 grid gap-1"
                                  style={{ gridTemplateColumns: `repeat(${stripeLayout.slots}, minmax(0, 1fr))` }}
                                >
                                  {Array.from({ length: stripeLayout.rows * stripeLayout.slots }).map((_, cellIndex) => {
                                    const row = Math.floor(cellIndex / stripeLayout.slots)
                                    const col = cellIndex % stripeLayout.slots
                                    const isDataSlot = col < stripeLayout.k
                                    const dataIndex = row * stripeLayout.k + col
                                    const hasBlob = isDataSlot && dataIndex < mduKzg.blobs.length
                                    const label = hasBlob ? `#${dataIndex}` : isDataSlot ? '-' : 'P'
                                    const title = hasBlob
                                      ? `Blob ${dataIndex}: ${mduKzg.blobs[dataIndex]}`
                                      : isDataSlot
                                        ? 'Empty data slot'
                                        : `Parity slot ${col - stripeLayout.k + 1}`
                                      return (
                                        <div
                                          key={`stripe-${row}-${col}`}
                                          title={title}
                                          className={[
                                            'flex items-center justify-center rounded-none border border-border/40 text-[9px] font-mono-data',
                                            hasBlob
                                              ? 'bg-primary/25 text-foreground'
                                              : isDataSlot
                                                ? 'bg-muted/30 text-muted-foreground'
                                                : 'bg-accent/20 text-foreground',
                                          ].join(' ')}
                                        >
                                          {label}
                                        </div>
                                      )
                                    })}
                                  </div>
                                  <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
                                    <div className="inline-flex items-center gap-1">
                                      <span className="h-2 w-2 rounded-none bg-primary/70" />
                                      Data blob
                                    </div>
                                    <div className="inline-flex items-center gap-1">
                                      <span className="h-2 w-2 rounded-none bg-accent/60" />
                                      {stripeLayout.isMode2 ? 'Parity shard' : 'Replica slot'}
                                    </div>
                                  </div>
                              </div>
                            </div>
                          ) : (
                            <div className="text-[11px] text-muted-foreground">
                              Select an MDU and load its commitments to inspect the 64 blob commitments.
                            </div>
                          )}
                        </div>
                    </>
                ) : (
                    <div className="text-center py-8 text-muted-foreground text-xs">
                        No slab layout available. (This deal might be capacity-only or local slab data is missing).
                    </div>
                )}
            </div>
        )}

        {activeTab === 'heat' && (
            <div className="space-y-4">
                  <div className="bg-secondary/50 border border-border rounded-none p-4 text-center">
                      <Activity className="w-8 h-8 text-primary mx-auto mb-2" />
                      <h4 className="text-sm font-medium text-foreground">Traffic Analysis</h4>
                      <p className="text-xs text-muted-foreground mt-1">Real-time stats from chain state</p>
                  </div>
                  
                  {heat ? (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                          <div className="bg-secondary/50 p-3 rounded-none border border-border">
                              <div className="text-muted-foreground uppercase text-[10px]">Total Traffic</div>
                              <div className="text-lg font-mono-data text-foreground">
                                  {(Number(heat.bytes_served_total) / 1024 / 1024).toFixed(2)} MB
                              </div>
                          </div>
                          <div className="bg-secondary/50 p-3 rounded-none border border-border">
                              <div className="text-muted-foreground uppercase text-[10px]">Total Retrievals</div>
                              <div className="text-lg font-mono-data text-success">
                                  {heat.successful_retrievals_total || '0'}
                              </div>
                          </div>
                          <div className="bg-secondary/50 p-3 rounded-none border border-border">
                              <div className="text-muted-foreground uppercase text-[10px]">Failed Proofs</div>
                              <div className="text-lg font-mono-data text-destructive">
                                  {heat.failed_challenges_total}
                              </div>
                          </div>
                          <div className="bg-secondary/50 p-3 rounded-none border border-border">
                              <div className="text-muted-foreground uppercase text-[10px]">Last Activity</div>
                              <div className="text-lg font-mono-data text-foreground">
                                  Block {heat.last_update_height}
                              </div>
                          </div>
                      </div>
                ) : (
                    <div className="text-center py-8 text-muted-foreground text-xs">
                        No traffic data available yet.
                    </div>
                )}

                <DealLivenessHeatmap proofs={dealProofs} />
            </div>
        )}
      </div>
    </div>
  )
}
