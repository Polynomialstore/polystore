import { useCallback, useEffect, useMemo, useState } from 'react'
import { appConfig } from '../config'
import { ArrowDownRight, FileJson, Server, Activity } from 'lucide-react'
import { useProofs } from '../hooks/useProofs'
import { useFetch } from '../hooks/useFetch'
import { DealLivenessHeatmap } from './DealLivenessHeatmap'
import type { ManifestInfoData, MduKzgData, NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'
import { buildBlake2sMerkleLayers } from '../lib/merkle'
import type { LcdDeal } from '../domain/lcd'
import { deleteCachedFile, hasCachedFile, readCachedFile, readMdu, readManifestRoot, writeCachedFile } from '../lib/storage/OpfsAdapter'
import { parseNilfsFilesFromMdu0 } from '../lib/nilfsLocal'
import { inferWitnessCountFromOpfs, readNilfsFileFromOpfs } from '../lib/nilfsOpfsFetch'
import { workerClient } from '../lib/worker-client'
import { multiaddrToHttpUrl, multiaddrToP2pTarget } from '../lib/multiaddr'
import { useTransportRouter } from '../hooks/useTransportRouter'
import { parseServiceHint } from '../lib/serviceHint'
import { toHexFromBase64OrHex } from '../domain/hex'

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
  onClose: () => void
  nilAddress: string
  onFileActivity?: (activity: FileActivity) => void
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

export function DealDetail({ deal, onClose, nilAddress, onFileActivity }: DealDetailProps) {
  const serviceHint = parseServiceHint(deal?.service_hint)
  const isMode2 = serviceHint.mode === 'mode2'
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
      isMode2: serviceHint.mode === 'mode2' && Boolean(serviceHint.rsK && serviceHint.rsM),
    }
  }, [serviceHint.mode, serviceHint.rsK, serviceHint.rsM])
  const [slab, setSlab] = useState<SlabLayoutData | null>(null)
  const [slabSource, setSlabSource] = useState<'none' | 'gateway' | 'opfs'>('none')
  const [gatewaySlabStatus, setGatewaySlabStatus] = useState<'unknown' | 'present' | 'missing' | 'error'>('unknown')
  const [gatewayReachable, setGatewayReachable] = useState<'unknown' | 'yes' | 'no'>('unknown')
  const [heat, setHeat] = useState<HeatState | null>(null)
  const [providersByAddr, setProvidersByAddr] = useState<Record<string, ProviderInfo>>({})
  const [loadingSlab, setLoadingSlab] = useState(false)
  const [files, setFiles] = useState<NilfsFileEntry[] | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [browserCachedByPath, setBrowserCachedByPath] = useState<Record<string, boolean>>({})
  const [busyFilePath, setBusyFilePath] = useState<string | null>(null)
  const [fileActionError, setFileActionError] = useState<string | null>(null)
  const [downloadRangeStart, setDownloadRangeStart] = useState<number>(0)
  const [downloadRangeLen, setDownloadRangeLen] = useState<number>(0)
  const [manifestInfo, setManifestInfo] = useState<ManifestInfoData | null>(null)
  const [loadingManifestInfo, setLoadingManifestInfo] = useState(false)
  const [manifestInfoError, setManifestInfoError] = useState<string | null>(null)
  const [selectedMdu, setSelectedMdu] = useState<number>(0)
  const [mduKzg, setMduKzg] = useState<MduKzgData | null>(null)
  const [loadingMduKzg, setLoadingMduKzg] = useState(false)
  const [mduKzgError, setMduKzgError] = useState<string | null>(null)
  const [mduRootMerkle, setMduRootMerkle] = useState<string[][] | null>(null)
  const [merkleError, setMerkleError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'info' | 'manifest' | 'heat'>('info')
  const { proofs } = useProofs()
  const { fetchFile, loading: downloading, receiptStatus, receiptError, progress } = useFetch()
  const {
    slab: fetchSlabLayout,
    listFiles: listFilesTransport,
    manifestInfo: manifestInfoTransport,
    mduKzg: mduKzgTransport,
    lastTrace,
  } = useTransportRouter()

  // Filter proofs for this deal
  const dealProofs = proofs.filter(p => p.dealId === String(deal.id))
  const dealProviders = deal.providers || []
  const dealProvidersKey = dealProviders.join(',')
  const primaryProvider = dealProviders[0] || ''
  const lastRouteLabel = useMemo(() => {
    const backend = lastTrace?.chosen?.backend
    return backend ? backend.replace('_', ' ') : ''
  }, [lastTrace])
  const lastAttemptSummary = useMemo(() => {
    if (!lastTrace?.attempts?.length) return ''
    return lastTrace.attempts
      .map((attempt) => `${attempt.backend}:${attempt.ok ? 'ok' : 'fail'}`)
      .join(',')
  }, [lastTrace])
  const lastFailureSummary = useMemo(() => {
    const failed = lastTrace?.attempts?.find((attempt) => !attempt.ok)
    if (!failed) return ''
    const msg = failed.errorMessage ? `:${failed.errorMessage}` : ''
    return `${failed.backend}${msg}`
  }, [lastTrace])

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

  useEffect(() => {
    let canceled = false
    async function pingGateway() {
      try {
        setGatewayReachable('unknown')
        const res = await fetch(`${appConfig.gatewayBase}/health`, { method: 'GET', signal: AbortSignal.timeout(2500) })
        if (canceled) return
        setGatewayReachable(res.ok ? 'yes' : 'no')
      } catch {
        if (canceled) return
        setGatewayReachable('no')
      }
    }
    void pingGateway()
    return () => {
      canceled = true
    }
  }, [])

  const fetchLocalFiles = useCallback(async (dealId: string) => {
    setLoadingFiles(true)
    try {
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
        const localManifest = await readManifestRoot(String(dealId)).catch(() => null)
        if (!localManifest || localManifest.trim() !== cid.trim()) return
        const mdu0 = await readMdu(String(dealId), 0)
        if (!mdu0) return
        const localFiles = parseNilfsFilesFromMdu0(mdu0)
        const { witnessCount, totalMdus, userCount } = await inferWitnessCountFromOpfs(String(dealId), localFiles)
        const totalSizeBytes = localFiles.reduce((acc, f) => acc + (Number(f.size_bytes) || 0), 0)
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
          manifest_root: cid,
          mdu_size_bytes: mduSizeBytes,
          blob_size_bytes: blobSizeBytes,
          total_mdus: totalMdus,
          witness_mdus: witnessCount,
          user_mdus: userCount,
          file_records: localFiles.length,
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
  }, [fetchSlabLayout, resolveProviderHttpBase, resolveProviderP2pTarget])

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

      const localManifest = await readManifestRoot(String(dealId)).catch(() => null)
      if (localManifest && localManifest.trim() !== cid.trim()) {
        // Local slab doesn't match chain; still show gateway result (empty) to avoid confusion.
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
  }, [fetchLocalFiles, resolveProviderHttpBase, resolveProviderP2pTarget, listFilesTransport])

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
        const localManifest = await readManifestRoot(String(dealId)).catch(() => null)
        if (!localManifest) throw new Error('missing local manifest root')
        if (cid && localManifest.trim() !== cid.trim()) throw new Error('local slab does not match chain CID')

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
          manifest_root: cid || computedRoot,
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
  }, [manifestInfoTransport, resolveProviderHttpBase, resolveProviderP2pTarget])

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
        const localManifest = await readManifestRoot(String(dealId)).catch(() => null)
        if (!localManifest) throw new Error('missing local manifest root')
        if (cid && localManifest.trim() !== cid.trim()) throw new Error('local slab does not match chain CID')

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
    <div className="mt-6 rounded-xl border border-border bg-card p-0 overflow-hidden shadow-sm" data-testid="deal-detail">
      <div className="flex items-center justify-between p-5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-3">
            <div className="bg-primary/10 p-2 rounded-lg">
                <FileJson className="w-5 h-5 text-primary" />
            </div>
            <div>
                <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Deal Explorer</div>
                <div className="text-lg font-bold text-foreground">Deal #{deal.id}</div>
            </div>
        </div>
        <button
          onClick={onClose}
          data-testid="deal-detail-close"
          className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md hover:bg-secondary transition-colors"
        >
          Close
        </button>
      </div>

      <div className="flex border-b border-border">
          <button 
            onClick={() => setActiveTab('info')}
            data-testid="deal-detail-tab-info"
            className={`flex-1 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'info' ? 'border-primary text-foreground bg-secondary/50' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
              Overview
          </button>
          <button 
            onClick={() => setActiveTab('manifest')}
            data-testid="deal-detail-tab-manifest"
            className={`flex-1 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'manifest' ? 'border-primary text-foreground bg-secondary/50' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
              Manifest &amp; MDUs
          </button>
          <button 
            onClick={() => setActiveTab('heat')}
            data-testid="deal-detail-tab-heat"
            className={`flex-1 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'heat' ? 'border-primary text-foreground bg-secondary/50' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
              Heat &amp; Liveness
          </button>
      </div>

      <div className="p-5">
        {activeTab === 'info' && (
            <div className="grid sm:grid-cols-2 gap-4 text-xs text-muted-foreground">
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">Content Hash (CID)</div>
                  <div
                    className="font-mono break-all bg-secondary/50 border border-border rounded px-3 py-2 text-primary select-all"
                    data-testid="deal-detail-cid"
                  >
                    {deal.cid || 'Empty Container'}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">Owner</div>
                  <div className="font-mono text-[11px] bg-secondary/50 border border-border rounded px-3 py-2 text-foreground select-all">
                    {deal.owner}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">Size</div>
                  <div className="flex items-center justify-between">
                    <span className="text-foreground font-mono">
                        {deal.size !== '0' ? `${(parseInt(deal.size) / 1024 / 1024).toFixed(2)} MB` : '0 MB'}
                    </span>
                    {/* Tier removed */}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">Redundancy</div>
                  <div className="bg-secondary/50 border border-border rounded px-2 py-1 text-[11px] text-foreground">
                    {isMode2 && serviceHint.rsK && serviceHint.rsM
                      ? `Mode 2 • RS(${serviceHint.rsK},${serviceHint.rsM})`
                      : `Mode 1 • Replicas ${serviceHint.replicas ?? '—'}`}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">Economics</div>
                  <div className="grid grid-cols-2 gap-2">
                      <div className="bg-secondary/50 px-2 py-1 rounded border border-border">
                          <span className="text-muted-foreground block text-[10px]">Escrow Remaining</span>
                          <span className="text-foreground">{deal.escrow ? `${deal.escrow} stake` : '—'}</span>
                      </div>
                      <div className="bg-secondary/50 px-2 py-1 rounded border border-border">
                          <span className="text-muted-foreground block text-[10px]">Max Spend</span>
                          <span className="text-foreground">{deal.max_monthly_spend ? `${deal.max_monthly_spend} stake` : '—'}</span>
                      </div>
                  </div>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <div className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">Providers</div>
                  <div className="bg-secondary/50 border border-border rounded p-2">
                    {deal.providers && deal.providers.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {deal.providers.map((p: string, idx: number) => (
                            <div key={p} className="space-y-1">
                              <div className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                                <Server className="w-3 h-3" />
                                {isMode2 && (
                                  <span className="text-[10px] text-muted-foreground">Slot {idx}</span>
                                )}
                                {p}
                                {providersByAddr[p]?.status && (
                                  <span className="text-muted-foreground">({providersByAddr[p]?.status})</span>
                                )}
                              </div>
                              {providersByAddr[p]?.endpoints && providersByAddr[p].endpoints!.length > 0 && (
                                <div className="font-mono text-[10px] text-muted-foreground break-all">
                                  {providersByAddr[p].endpoints![0]}
                                </div>
                              )}
                            </div>
                          ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground italic">No providers assigned yet</span>
                    )}
                  </div>
                </div>
                
                {(deal.cid || loadingFiles || (files && files.length > 0)) && (
                    <div className="sm:col-span-2 mt-2 space-y-2">
                      <div className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">Files (NilFS)</div>
                      {!deal.cid && (
                        <div className="text-[11px] text-muted-foreground">
                          Showing local OPFS slab (not yet committed on-chain).
                        </div>
                      )}
                      {fileActionError && (
                        <div className="text-[11px] text-red-500 dark:text-red-400">
                          Download failed{fileActionError ? `: ${fileActionError}` : ''}
                        </div>
                      )}
                      {receiptStatus !== 'idle' && (
                        <div className="text-[11px]">
                          {receiptStatus === 'submitted' ? (
                            <span className="text-green-500 dark:text-green-400">Receipt submitted on-chain</span>
                          ) : (
                            <span className="text-red-500 dark:text-red-400">
                              Receipt failed{receiptError ? `: ${receiptError}` : ''}
                            </span>
                          )}
                        </div>
                      )}
                      {lastRouteLabel && (
                        <div
                          className="text-[11px] text-muted-foreground"
                          data-testid="transport-route"
                          data-transport-attempts={lastAttemptSummary}
                          data-transport-failure={lastFailureSummary}
                        >
                          Route: {lastRouteLabel}
                        </div>
                      )}

                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                        <div className="bg-secondary/50 px-2 py-2 rounded border border-border">
                          <div className="text-[10px] text-muted-foreground uppercase">Bytes Served</div>
                          <div className="font-mono text-foreground">
                            {heat ? `${(Number(heat.bytes_served_total) / 1024 / 1024).toFixed(2)} MB` : '—'}
                          </div>
                        </div>
                        <div className="bg-secondary/50 px-2 py-2 rounded border border-border">
                          <div className="text-[10px] text-muted-foreground uppercase">Escrow Remaining</div>
                          <div className="font-mono text-foreground">{deal.escrow ? `${deal.escrow} stake` : '—'}</div>
                        </div>
                        <div className="bg-secondary/50 px-2 py-2 rounded border border-border">
                          <div className="text-[10px] text-muted-foreground uppercase">Chunks</div>
                          <div className="font-mono text-foreground">
                            {progress.phase === 'idle' ? '—' : `${progress.chunksFetched}/${progress.chunkCount || 0}`}
                          </div>
                        </div>
                        <div className="bg-secondary/50 px-2 py-2 rounded border border-border">
                          <div className="text-[10px] text-muted-foreground uppercase">Receipt</div>
                          <div className="font-mono text-foreground">
                            {progress.phase === 'idle'
                              ? '—'
                              : `${progress.receiptsSubmitted}/${progress.receiptsTotal || 0}`}
                          </div>
                        </div>
                      </div>

                      <div className="bg-secondary/50 border border-border rounded p-3 text-[11px] space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-[10px] text-muted-foreground uppercase font-semibold">Download Range</div>
                          <div className="text-[10px] text-muted-foreground">
                            Len=0 downloads to EOF
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="flex flex-col gap-1">
                            <span className="text-[10px] text-muted-foreground uppercase">Start</span>
                            <input
                              type="number"
                              min={0}
                              value={downloadRangeStart}
                              onChange={(e) => setDownloadRangeStart(Math.max(0, Number(e.target.value || 0) || 0))}
                              className="px-2 py-1 rounded border border-border bg-background text-foreground text-[11px] font-mono"
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[10px] text-muted-foreground uppercase">Len</span>
                            <input
                              type="number"
                              min={0}
                              value={downloadRangeLen}
                              onChange={(e) => setDownloadRangeLen(Math.max(0, Number(e.target.value || 0) || 0))}
                              className="px-2 py-1 rounded border border-border bg-background text-foreground text-[11px] font-mono"
                            />
                          </label>
                        </div>
                        {progress.phase !== 'idle' ? (
                          <div className="text-[10px] text-muted-foreground">
                            {progress.filePath ? `${progress.filePath} • ` : ''}
                            {progress.phase}
                            {progress.bytesTotal
                              ? ` • ${(progress.bytesFetched / 1024).toFixed(1)} KiB / ${(progress.bytesTotal / 1024).toFixed(1)} KiB`
                              : ''}
                            {progress.message ? ` • ${progress.message}` : ''}
                          </div>
                        ) : null}
                      </div>

                      {loadingFiles ? (
                        <div className="text-xs text-muted-foreground">Loading file table…</div>
                      ) : files && files.length > 0 ? (
                        <div className="space-y-2" data-testid="deal-detail-file-list">
                          {files.map((f) => {
                            const cached = !!browserCachedByPath[f.path]
                            const isBusy = busyFilePath === f.path
                            return (
                              <div
                                key={`${f.path}:${f.start_offset}`}
                                data-testid="deal-detail-file-row"
                                data-file-path={f.path}
                                className="bg-secondary/50 border border-border rounded px-3 py-2 space-y-2"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="font-mono text-[11px] text-foreground truncate" title={f.path}>
                                      {f.path}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground">{f.size_bytes} bytes</div>
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">
                                    File cache: {cached ? 'yes' : 'no'} • Gateway: {gatewayReachable} • Slab: {gatewaySlabStatus}
                                  </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-[11px]">
                                  <div className="min-w-0 rounded border border-border bg-background/40 p-2 space-y-2">
                                    <div className="flex items-center justify-between">
                                      <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
                                        Browser
                                      </div>
                                      <div className="text-[10px] text-muted-foreground">
                                        cache {cached ? 'yes' : 'no'} • slab {slabSource === 'opfs' ? 'yes' : 'unknown'}
                                      </div>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        onClick={async () => {
                                          setFileActionError(null)
                                          setBusyFilePath(f.path)
                                          const dealId = String(deal.id)
                                          try {
                                            const cachedBytes = await readCachedFile(dealId, f.path)
                                            if (!cachedBytes) throw new Error('not cached in browser')
                                            downloadBytesAsFile(cachedBytes, f.path)
                                          } catch (e: unknown) {
                                            const msg = e instanceof Error ? e.message : String(e)
                                            setFileActionError(msg)
                                          } finally {
                                            setBusyFilePath(null)
                                          }
                                        }}
                                        disabled={isBusy || !cached}
                                        data-testid="deal-detail-download-browser-cache"
                                        data-file-path={f.path}
                                        className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold border border-border bg-secondary hover:bg-secondary/70 text-foreground rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none"
                                      >
                                        Cached
                                      </button>
                                      <button
                                        onClick={async () => {
                                          setFileActionError(null)
                                          setBusyFilePath(f.path)
                                          const dealId = String(deal.id)
                                          const safeStart = Math.max(0, Number(downloadRangeStart || 0) || 0)
                                          const safeLen = Math.max(0, Number(downloadRangeLen || 0) || 0)
                                          try {
                                            const chainCid = String(deal.cid || '').trim()
                                            const localManifest = await readManifestRoot(dealId).catch(() => null)
                                            const canUseLocalSlab =
                                              !!localManifest && !!chainCid && localManifest.trim() === chainCid
                                            if (!canUseLocalSlab) throw new Error('local slab not available')

                                            const bytes = await readNilfsFileFromOpfs({
                                              dealId,
                                              file: f,
                                              allFiles: files || [],
                                              rangeStart: safeStart,
                                              rangeLen: safeLen,
                                            })
                                            await writeCachedFile(dealId, f.path, bytes)
                                            setBrowserCachedByPath((prev) => ({ ...prev, [f.path]: true }))
                                            downloadBytesAsFile(bytes, f.path)
                                          } catch (e: unknown) {
                                            const msg = e instanceof Error ? e.message : String(e)
                                            setFileActionError(msg)
                                          } finally {
                                            setBusyFilePath(null)
                                          }
                                        }}
                                        disabled={isBusy}
                                        data-testid="deal-detail-download-browser-slab"
                                        data-file-path={f.path}
                                        className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none"
                                      >
                                        <ArrowDownRight className="w-4 h-4" />
                                        {isBusy ? 'Loading...' : 'Slab'}
                                      </button>
                                      <button
                                        onClick={async () => {
                                          setFileActionError(null)
                                          const dealId = String(deal.id)
                                          try {
                                            await deleteCachedFile(dealId, f.path)
                                            setBrowserCachedByPath((prev) => ({ ...prev, [f.path]: false }))
                                          } catch (e: unknown) {
                                            const msg = e instanceof Error ? e.message : String(e)
                                            setFileActionError(msg)
                                          }
                                        }}
                                        disabled={downloading || isBusy || !cached}
                                        data-testid="deal-detail-clear-browser-cache"
                                        data-file-path={f.path}
                                        className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold border border-border bg-secondary hover:bg-secondary/70 text-foreground rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none"
                                      >
                                        Clear
                                      </button>
                                      <button
                                        onClick={async () => {
                                          setFileActionError(null)
                                          setBusyFilePath(f.path)
                                          const dealId = String(deal.id)
                                          const safeStart = Math.max(0, Number(downloadRangeStart || 0) || 0)
                                          const safeLen = Math.max(0, Number(downloadRangeLen || 0) || 0)
                                          try {
                                            const cachedBytes = await readCachedFile(dealId, f.path)
                                            if (cachedBytes) {
                                              downloadBytesAsFile(cachedBytes, f.path)
                                              return
                                            }

                                            if (!deal.cid) throw new Error('commit required (no on-chain CID)')
                                            const manifestHex = toHexFromBase64OrHex(deal.cid) || deal.cid
                                            onFileActivity?.({
                                              dealId,
                                              filePath: f.path,
                                              sizeBytes: f.size_bytes,
                                              manifestRoot: manifestHex,
                                              action: 'download',
                                              status: 'pending',
                                            })
                                            const result = await fetchFile({
                                              dealId,
                                              manifestRoot: manifestHex,
                                              owner: nilAddress,
                                              filePath: f.path,
                                              serviceBase: isMode2 ? undefined : resolveProviderHttpBase(),
                                              rangeStart: safeStart,
                                              rangeLen: safeLen,
                                              fileStartOffset: f.start_offset,
                                              fileSizeBytes: f.size_bytes,
                                              mduSizeBytes: slab?.mdu_size_bytes ?? 8 * 1024 * 1024,
                                              blobSizeBytes: slab?.blob_size_bytes ?? 128 * 1024,
                                            })
                                            if (!result) throw new Error('download failed')
                                            const bytes = new Uint8Array(await result.blob.arrayBuffer())
                                            await writeCachedFile(dealId, f.path, bytes)
                                            setBrowserCachedByPath((prev) => ({ ...prev, [f.path]: true }))
                                            downloadBlobAsFile(result.blob, f.path)
                                            onFileActivity?.({
                                              dealId,
                                              filePath: f.path,
                                              sizeBytes: f.size_bytes,
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
                                                filePath: f.path,
                                                sizeBytes: f.size_bytes,
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
                                        }}
                                        disabled={downloading || isBusy || !deal.cid}
                                        data-testid="deal-detail-download"
                                        data-file-path={f.path}
                                        className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold border border-border bg-secondary hover:bg-secondary/70 text-foreground rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none"
                                      >
                                        Download
                                      </button>
                                    </div>
                                  </div>

                                  <div className="min-w-0 rounded border border-border bg-background/40 p-2 space-y-2">
                                    <div className="flex items-center justify-between">
                                      <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
                                        Gateway
                                      </div>
                                      <div className="text-[10px] text-muted-foreground">
                                        reach {gatewayReachable} • slab {gatewaySlabStatus}
                                      </div>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        onClick={async () => {
                                          setFileActionError(null)
                                          setBusyFilePath(f.path)
                                          try {
                                            if (!deal.cid) throw new Error('commit required (no on-chain CID)')
                                            const safeStart = Math.max(0, Number(downloadRangeStart || 0) || 0)
                                            const safeLen = Math.max(0, Number(downloadRangeLen || 0) || 0)
                                            const q = new URLSearchParams()
                                            q.set('deal_id', String(deal.id))
                                            q.set('owner', String(nilAddress))
                                            q.set('file_path', f.path)
                                            q.set('range_start', String(safeStart))
                                            q.set('range_len', String(safeLen))
                                            const url = `${appConfig.gatewayBase}/gateway/debug/raw-fetch/${encodeURIComponent(
                                              deal.cid,
                                            )}?${q.toString()}`
                                            const res = await fetch(url)
                                            if (!res.ok) {
                                              const txt = await res.text().catch(() => '')
                                              throw new Error(txt || `gateway raw fetch failed (${res.status})`)
                                            }
                                            const bytes = new Uint8Array(await res.arrayBuffer())
                                            await writeCachedFile(String(deal.id), f.path, bytes)
                                            setBrowserCachedByPath((prev) => ({ ...prev, [f.path]: true }))
                                            downloadBytesAsFile(bytes, f.path)
                                          } catch (e: unknown) {
                                            const msg = e instanceof Error ? e.message : String(e)
                                            setFileActionError(msg)
                                          } finally {
                                            setBusyFilePath(null)
                                          }
                                        }}
                                        disabled={downloading || isBusy || gatewaySlabStatus !== 'present'}
                                        data-testid="deal-detail-download-gateway"
                                        data-file-path={f.path}
                                        className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold border border-border bg-secondary hover:bg-secondary/70 text-foreground rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none"
                                      >
                                        Download
                                      </button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground">
                                      Requires gateway slab on disk (and debug raw fetch enabled).
                                    </div>
                                  </div>

                                  <div className="min-w-0 rounded border border-border bg-background/40 p-2 space-y-2">
                                    <div className="flex items-center justify-between">
                                      <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
                                        SP (interactive)
                                      </div>
                                      <div className="text-[10px] text-muted-foreground">
                                        {downloading ? 'in progress' : 'wallet'}
                                      </div>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <button
                                        onClick={async () => {
                                          setFileActionError(null)
                                          setBusyFilePath(f.path)
                                          const dealId = String(deal.id)
                                          const safeStart = Math.max(0, Number(downloadRangeStart || 0) || 0)
                                          const safeLen = Math.max(0, Number(downloadRangeLen || 0) || 0)
                                          try {
                                            if (!deal.cid) throw new Error('commit required (no on-chain CID)')
                                            const manifestHex = toHexFromBase64OrHex(deal.cid) || deal.cid
                                            onFileActivity?.({
                                              dealId,
                                              filePath: f.path,
                                              sizeBytes: f.size_bytes,
                                              manifestRoot: manifestHex,
                                              action: 'download',
                                              status: 'pending',
                                            })
                                            const result = await fetchFile({
                                              dealId,
                                              manifestRoot: manifestHex,
                                              owner: nilAddress,
                                              filePath: f.path,
                                              serviceBase: isMode2 ? undefined : resolveProviderHttpBase(),
                                              rangeStart: safeStart,
                                              rangeLen: safeLen,
                                              fileStartOffset: f.start_offset,
                                              fileSizeBytes: f.size_bytes,
                                              mduSizeBytes: slab?.mdu_size_bytes ?? 8 * 1024 * 1024,
                                              blobSizeBytes: slab?.blob_size_bytes ?? 128 * 1024,
                                            })
                                            if (!result) throw new Error('download failed')
                                            const bytes = new Uint8Array(await result.blob.arrayBuffer())
                                            await writeCachedFile(dealId, f.path, bytes)
                                            setBrowserCachedByPath((prev) => ({ ...prev, [f.path]: true }))
                                            downloadBlobAsFile(result.blob, f.path)
                                            onFileActivity?.({
                                              dealId,
                                              filePath: f.path,
                                              sizeBytes: f.size_bytes,
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
                                                filePath: f.path,
                                                sizeBytes: f.size_bytes,
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
                                        }}
                                        disabled={downloading || isBusy || !deal.cid}
                                        data-testid="deal-detail-download-sp"
                                        data-file-path={f.path}
                                        className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-md transition-colors disabled:opacity-50 disabled:pointer-events-none"
                                      >
                                        <ArrowDownRight className="w-4 h-4" />
                                        Download
                                      </button>
                                    </div>
                                    <div className="text-[10px] text-muted-foreground">
                                      Opens a retrieval session and submits the receipt on-chain; then caches in-browser.
                                    </div>
                                  </div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground italic">No files found for this manifest root.</div>
                      )}
                    </div>
                )}
            </div>
        )}

        {activeTab === 'manifest' && (
            <div className="space-y-4">
                {loadingSlab ? (
                    <div className="text-center py-8 text-muted-foreground text-xs">Loading slab layout...</div>
                ) : slab ? (
                    <>
                        <div className="grid grid-cols-2 gap-4 text-xs">
                            <div className="bg-secondary/50 p-3 rounded border border-border">
                                <div className="text-muted-foreground uppercase text-[10px]">Slab MDUs</div>
                                <div className="text-lg font-mono text-foreground">{slab.total_mdus}</div>
                                <div className="text-[10px] text-muted-foreground mt-1">
                                    MDU #0 + {slab.witness_mdus} witness + {slab.user_mdus} user
                                </div>
                                <div className="text-[10px] text-muted-foreground mt-1">
                                    Source: {slabSource === 'gateway' ? 'gateway' : slabSource === 'opfs' ? 'browser (OPFS)' : '—'}
                                </div>
                            </div>
                            <div className="bg-secondary/50 p-3 rounded border border-border">
                                <div className="text-muted-foreground uppercase text-[10px]">Manifest Root</div>
                                <div className="font-mono text-primary text-[10px] truncate" title={slab.manifest_root}>
                                    {slab.manifest_root.slice(0, 16)}...
                                </div>
                            </div>
                        </div>

                        <div className="bg-secondary/50 border border-border rounded p-3 text-xs space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="text-xs text-muted-foreground uppercase font-semibold">Layout</div>
                                <div className="text-[10px] text-muted-foreground">
                                    {Math.round(slab.mdu_size_bytes / 1024 / 1024)} MiB / MDU • {Math.round(slab.blob_size_bytes / 1024)} KiB / Blob
                                </div>
                            </div>
                            <div className="h-2 bg-secondary rounded-full overflow-hidden flex border border-border/50">
                                {slab.segments.map((seg) => (
                                    <div
                                        key={`${seg.kind}:${seg.start_index}`}
                                        style={{ flexGrow: Math.max(1, seg.count) }}
                                        className={
                                            seg.kind === 'mdu0'
                                                ? 'bg-blue-500/60'
                                                : seg.kind === 'witness'
                                                    ? 'bg-purple-500/60'
                                                    : 'bg-emerald-500/60'
                                        }
                                        title={`${seg.kind} • start=${seg.start_index} • count=${seg.count}`}
                                    />
                                ))}
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
                                <div>
                                    <span className="text-blue-500 font-semibold">MDU #0</span>: Super-Manifest (File Table + Root Table)
                                </div>
                                <div>
                                    <span className="text-purple-500 font-semibold">Witness</span>:{' '}
                                    {slab.witness_mdus > 0 ? `MDU #1..#${slab.witness_mdus}` : 'none'}
                                </div>
                                <div>
                                    <span className="text-emerald-500 font-semibold">User</span>:{' '}
                                    {slab.user_mdus > 0 ? `MDU #${1 + slab.witness_mdus}..#${slab.total_mdus - 1}` : 'none'}
                                </div>
                            </div>
                        </div>

                        <div className="bg-secondary/50 border border-border rounded p-3 text-xs">
                            <div className="text-muted-foreground uppercase text-[10px]">NilFS</div>
                            <div className="mt-1 text-[11px] text-foreground">
                                {slab.file_count} files • {slab.total_size_bytes} bytes
                            </div>
                            <div className="text-[10px] text-muted-foreground mt-1">
                                File records: {slab.file_records}
                            </div>
                        </div>

                        <div className="bg-secondary/50 border border-border rounded p-3 text-xs space-y-3">
                            <div className="flex items-center justify-between">
                                <div className="text-xs text-muted-foreground uppercase font-semibold">Manifest Commitment</div>
                                <div className="text-[10px] text-muted-foreground">KZG commitment over MDU roots</div>
                            </div>

                            {loadingManifestInfo ? (
                              <div className="text-[11px] text-muted-foreground">Loading manifest details…</div>
                            ) : manifestInfo ? (
                              <>
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="bg-background/50 border border-border rounded p-2">
                                    <div className="text-[10px] text-muted-foreground uppercase">Manifest Root</div>
                                    <div className="font-mono text-[10px] text-foreground break-all">{manifestInfo.manifest_root}</div>
                                  </div>
                                  <div className="bg-background/50 border border-border rounded p-2">
                                    <div className="text-[10px] text-muted-foreground uppercase">Manifest Blob</div>
                                    <div className="font-mono text-[10px] text-foreground break-all" title={manifestInfo.manifest_blob_hex}>
                                      {shortHex(manifestInfo.manifest_blob_hex, 24, 12)}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground mt-1">
                                      Encodes the ordered root vector for KZG commitment
                                    </div>
                                  </div>
                                </div>

                                <div className="bg-background/50 border border-border rounded p-2">
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
                                      className="text-[10px] px-2 py-1 rounded border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
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
                                          <div className="font-mono text-[10px] text-foreground truncate" title={r.root_hex}>
                                            {shortHex(r.root_hex, 16, 10)}
                                          </div>
                                        </div>
                                        <button
                                          onClick={() => {
                                            setSelectedMdu(r.mdu_index)
                                            fetchMduKzg(manifestInfo.manifest_root, r.mdu_index, deal.id, nilAddress)
                                          }}
                                          className="shrink-0 text-[10px] px-2 py-1 rounded border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
                                        >
                                          Inspect
                                        </button>
                                      </div>
                                    ))}
                                  </div>

                                  {merkleError && <div className="mt-2 text-[10px] text-red-500">{merkleError}</div>}

                                  {mduRootMerkle && mduRootMerkle.length > 0 && (
                                    <div className="mt-3 space-y-2">
                                      <div className="text-[10px] text-muted-foreground">
                                        Debug Merkle tree over the root vector (Blake2s, duplicate-last on odd levels).
                                      </div>
                                      <div className="space-y-2 max-h-64 overflow-auto pr-1">
                                        {mduRootMerkle.map((layer, idx) => (
                                          <div key={idx} className="bg-background/50 border border-border rounded p-2">
                                            <div className="text-[10px] text-muted-foreground uppercase">
                                              Level {idx} • {layer.length} nodes
                                            </div>
                                            <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1">
                                              {layer.map((h, j) => (
                                                <div
                                                  key={`${idx}:${j}`}
                                                  className="font-mono text-[10px] text-foreground truncate"
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
                          <div className="bg-secondary/50 border border-border rounded p-3 text-xs space-y-2">
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
                                      <div className="font-mono text-[10px] text-foreground truncate" title={r.root_hex}>
                                        {shortHex(r.root_hex, 16, 10)}
                                      </div>
                                    </div>
                                    <button
                                      onClick={() => {
                                        setSelectedMdu(r.mdu_index)
                                        fetchMduKzg(manifestInfo.manifest_root, r.mdu_index, deal.id, nilAddress)
                                      }}
                                      className="shrink-0 text-[10px] px-2 py-1 rounded border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
                                    >
                                      Inspect
                                    </button>
                                  </div>
                                ))}
                            </div>
                          </div>
                        ) : null}

                        <div className="bg-secondary/50 border border-border rounded p-3 text-xs space-y-2">
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
                                className="text-[10px] bg-background border border-border rounded px-2 py-1 text-foreground"
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
                                className="text-[10px] px-2 py-1 rounded border border-border bg-secondary hover:bg-secondary/70 text-foreground transition-colors"
                              >
                                {loadingMduKzg ? 'Loading…' : 'Load Commitments'}
                              </button>
                            </div>
                          </div>

                          {mduKzgError && <div className="text-[10px] text-red-500">{mduKzgError}</div>}

                          {mduKzg && mduKzg.mdu_index === selectedMdu ? (
                            <div className="space-y-2">
                              <div className="grid grid-cols-2 gap-2">
                                <div className="bg-background/50 border border-border rounded p-2">
                                  <div className="text-[10px] text-muted-foreground uppercase">MDU Root</div>
                                  <div className="font-mono text-[10px] text-foreground break-all">
                                    {shortHex(mduKzg.root_hex, 24, 12)}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground mt-1">
                                    Blake2s Merkle root over 64 blob commitments
                                  </div>
                                </div>
                                <div className="bg-background/50 border border-border rounded p-2">
                                  <div className="text-[10px] text-muted-foreground uppercase">Blob Commitments</div>
                                  <div className="text-[11px] text-foreground font-mono">{mduKzg.blobs.length}</div>
                                  <div className="text-[10px] text-muted-foreground mt-1">
                                    128 KiB each • {Math.round(slab.mdu_size_bytes / 1024 / 1024)} MiB total
                                  </div>
                                </div>
                              </div>

                              <div className="bg-background/50 border border-border rounded p-2">
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
                                          'flex items-center justify-center rounded-sm border border-border/40 text-[9px] font-mono',
                                          hasBlob
                                            ? 'bg-blue-500/50 text-blue-50'
                                            : isDataSlot
                                              ? 'bg-muted/30 text-muted-foreground'
                                              : 'bg-emerald-500/30 text-emerald-200',
                                        ].join(' ')}
                                      >
                                        {label}
                                      </div>
                                    )
                                  })}
                                </div>
                                <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted-foreground">
                                  <div className="inline-flex items-center gap-1">
                                    <span className="h-2 w-2 rounded-sm bg-blue-500/70" />
                                    Data blob
                                  </div>
                                  <div className="inline-flex items-center gap-1">
                                    <span className="h-2 w-2 rounded-sm bg-emerald-500/60" />
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
                <div className="bg-secondary/50 border border-border rounded p-4 text-center">
                    <Activity className="w-8 h-8 text-orange-500 mx-auto mb-2" />
                    <h4 className="text-sm font-medium text-foreground">Traffic Analysis</h4>
                    <p className="text-xs text-muted-foreground mt-1">Real-time stats from chain state</p>
                </div>
                
                {heat ? (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                        <div className="bg-secondary/50 p-3 rounded border border-border">
                            <div className="text-muted-foreground uppercase text-[10px]">Total Traffic</div>
                            <div className="text-lg font-mono text-foreground">
                                {(Number(heat.bytes_served_total) / 1024 / 1024).toFixed(2)} MB
                            </div>
                        </div>
                        <div className="bg-secondary/50 p-3 rounded border border-border">
                            <div className="text-muted-foreground uppercase text-[10px]">Total Retrievals</div>
                            <div className="text-lg font-mono text-green-500 dark:text-green-400">
                                {heat.successful_retrievals_total || '0'}
                            </div>
                        </div>
                        <div className="bg-secondary/50 p-3 rounded border border-border">
                            <div className="text-muted-foreground uppercase text-[10px]">Failed Proofs</div>
                            <div className="text-lg font-mono text-red-500 dark:text-red-400">
                                {heat.failed_challenges_total}
                            </div>
                        </div>
                        <div className="bg-secondary/50 p-3 rounded border border-border">
                            <div className="text-muted-foreground uppercase text-[10px]">Last Activity</div>
                            <div className="text-lg font-mono text-foreground">
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
