import { useEffect, useState } from 'react'
import { appConfig } from '../config'
import { ArrowDownRight, FileJson, Server, Activity } from 'lucide-react'
import { useProofs } from '../hooks/useProofs'
import { DealLivenessHeatmap } from './DealLivenessHeatmap'

interface DealDetailProps {
  deal: any
  onClose: () => void
  nilAddress: string
}

interface HeatState {
    bytes_served_total: string
    failed_challenges_total: string
    last_update_height: string
}

interface SlabSegment {
  kind: 'mdu0' | 'witness' | 'user'
  start_index: number
  count: number
  size_bytes: number
}

interface SlabLayoutData {
  manifest_root: string
  mdu_size_bytes: number
  blob_size_bytes: number
  total_mdus: number
  witness_mdus: number
  user_mdus: number
  file_records: number
  file_count: number
  total_size_bytes: number
  segments: SlabSegment[]
}

interface NilfsFileEntry {
  path: string
  size_bytes: number
  start_offset: number
  flags: number
}

export function DealDetail({ deal, onClose, nilAddress }: DealDetailProps) {
  const [slab, setSlab] = useState<SlabLayoutData | null>(null)
  const [heat, setHeat] = useState<HeatState | null>(null)
  const [loadingSlab, setLoadingSlab] = useState(false)
  const [files, setFiles] = useState<NilfsFileEntry[] | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [activeTab, setActiveTab] = useState<'info' | 'manifest' | 'heat'>('info')
  const { proofs } = useProofs()

  // Filter proofs for this deal
  const dealProofs = proofs.filter(p => p.dealId === String(deal.id))

  useEffect(() => {
    if (deal.cid && deal.cid !== '') {
      fetchSlab(deal.cid, deal.id, nilAddress)
      fetchFiles(deal.cid, deal.id, nilAddress)
    } else {
      setFiles(null)
    }
    fetchHeat(deal.id)
  }, [deal.cid, deal.id, nilAddress])

  async function fetchSlab(cid: string, dealId?: string, owner?: string) {
    setLoadingSlab(true)
    try {
      let url = `${appConfig.gatewayBase}/gateway/slab/${encodeURIComponent(cid)}`
      if (dealId && owner) {
        const q = new URLSearchParams()
        q.set('deal_id', String(dealId))
        q.set('owner', owner)
        url = `${url}?${q.toString()}`
      }
      const res = await fetch(url)
      if (res.ok) {
        const json = await res.json()
        setSlab(json)
      }
    } catch (e) {
      console.error('Failed to fetch slab layout', e)
    } finally {
      setLoadingSlab(false)
    }
  }

  async function fetchFiles(cid: string, dealId: string, owner: string) {
    if (!cid || !dealId || !owner) return
    setLoadingFiles(true)
    try {
      const url = `${appConfig.gatewayBase}/gateway/list-files/${encodeURIComponent(
        cid,
      )}?deal_id=${encodeURIComponent(dealId)}&owner=${encodeURIComponent(owner)}`
      const res = await fetch(url)
      if (!res.ok) {
        setFiles([])
        return
      }
      const json = await res.json()
      if (Array.isArray(json.files)) {
        setFiles(json.files as NilfsFileEntry[])
      } else {
        setFiles([])
      }
    } catch (e) {
      console.error('Failed to fetch NilFS file list', e)
      setFiles([])
    } finally {
      setLoadingFiles(false)
    }
  }

  async function fetchHeat(dealId: string) {
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
  }

  return (
    <div className="mt-6 rounded-xl border border-border bg-card p-0 overflow-hidden shadow-sm">
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
          className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md hover:bg-secondary transition-colors"
        >
          Close
        </button>
      </div>

      <div className="flex border-b border-border">
          <button 
            onClick={() => setActiveTab('info')}
            className={`flex-1 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'info' ? 'border-primary text-foreground bg-secondary/50' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
              Overview
          </button>
          <button 
            onClick={() => setActiveTab('manifest')}
            className={`flex-1 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'manifest' ? 'border-primary text-foreground bg-secondary/50' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
              Manifest &amp; MDUs
          </button>
          <button 
            onClick={() => setActiveTab('heat')}
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
                  <div className="font-mono break-all bg-secondary/50 border border-border rounded px-3 py-2 text-primary select-all">
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
                  <div className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">Economics</div>
                  <div className="grid grid-cols-2 gap-2">
                      <div className="bg-secondary/50 px-2 py-1 rounded border border-border">
                          <span className="text-muted-foreground block text-[10px]">Escrow</span>
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
                          {deal.providers.map((p: string) => (
                            <div key={p} className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                                <Server className="w-3 h-3" />
                                {p}
                            </div>
                          ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground italic">No providers assigned yet</span>
                    )}
                  </div>
                </div>
                
                {deal.cid && (
                    <div className="sm:col-span-2 mt-2 space-y-2">
                      <div className="text-xs uppercase tracking-wide font-semibold text-muted-foreground">Files (NilFS)</div>
                      {loadingFiles ? (
                        <div className="text-xs text-muted-foreground">Loading file table…</div>
                      ) : files && files.length > 0 ? (
                        <div className="space-y-2">
                          {files.map((f) => {
                            const downloadUrl = `${appConfig.gatewayBase}/gateway/fetch/${encodeURIComponent(
                              deal.cid,
                            )}?deal_id=${encodeURIComponent(deal.id)}&owner=${encodeURIComponent(
                              nilAddress,
                            )}&file_path=${encodeURIComponent(f.path)}`
                            return (
                              <div
                                key={`${f.path}:${f.start_offset}`}
                                className="flex items-center justify-between gap-3 bg-secondary/50 border border-border rounded px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <div className="font-mono text-[11px] text-foreground truncate" title={f.path}>
                                    {f.path}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {f.size_bytes} bytes
                                  </div>
                                </div>
                                <button
                                  onClick={() => window.open(downloadUrl, '_blank')}
                                  className="shrink-0 inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-md transition-colors"
                                >
                                  <ArrowDownRight className="w-4 h-4" />
                                  Download
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground italic">
                          No files found for this manifest root.
                        </div>
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
                    <div className="grid grid-cols-3 gap-4 text-xs">
                        <div className="bg-secondary/50 p-3 rounded border border-border">
                            <div className="text-muted-foreground uppercase text-[10px]">Total Traffic</div>
                            <div className="text-lg font-mono text-foreground">
                                {(Number(heat.bytes_served_total) / 1024 / 1024).toFixed(2)} MB
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
