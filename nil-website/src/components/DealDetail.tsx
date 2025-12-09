import { useEffect, useState } from 'react'
import { appConfig } from '../config'
import { ArrowDownRight, FileJson, Server, Activity } from 'lucide-react'

interface DealDetailProps {
  deal: any
  onClose: () => void
  nilAddress: string
}

interface ManifestData {
  total_mdus: number
  manifest_root_hex: string
  mdus: {
    index: number
    root_hex: string
    blobs: string[] // List of 64 hex strings
  }[]
}

export function DealDetail({ deal, onClose, nilAddress }: DealDetailProps) {
  const [manifest, setManifest] = useState<ManifestData | null>(null)
  const [loadingManifest, setLoadingManifest] = useState(false)
  const [activeTab, setActiveTab] = useState<'info' | 'manifest' | 'heat'>('info')

  useEffect(() => {
    if (deal.cid && deal.cid !== '') {
      fetchManifest(deal.cid)
    }
  }, [deal.cid])

  async function fetchManifest(cid: string) {
    setLoadingManifest(true)
    try {
      const res = await fetch(`${appConfig.gatewayBase}/gateway/manifest/${cid}`)
      if (res.ok) {
        const json = await res.json()
        setManifest(json)
      }
    } catch (e) {
      console.error('Failed to fetch manifest', e)
    } finally {
      setLoadingManifest(false)
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-gray-800 bg-gray-900/60 p-0 overflow-hidden">
      <div className="flex items-center justify-between p-5 border-b border-gray-800 bg-gray-950/30">
        <div className="flex items-center gap-3">
            <div className="bg-indigo-500/10 p-2 rounded-lg">
                <FileJson className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
                <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Deal Explorer</div>
                <div className="text-lg font-bold text-white">Deal #{deal.id}</div>
            </div>
        </div>
        <button
          onClick={onClose}
          className="text-xs text-gray-400 hover:text-gray-200 px-3 py-1.5 rounded-md hover:bg-white/5 transition-colors"
        >
          Close
        </button>
      </div>

      <div className="flex border-b border-gray-800">
          <button 
            onClick={() => setActiveTab('info')}
            className={`flex-1 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'info' ? 'border-indigo-500 text-white bg-white/5' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
          >
              Overview
          </button>
          <button 
            onClick={() => setActiveTab('manifest')}
            className={`flex-1 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'manifest' ? 'border-indigo-500 text-white bg-white/5' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
          >
              Manifest &amp; MDUs
          </button>
          <button 
            onClick={() => setActiveTab('heat')}
            className={`flex-1 py-3 text-xs font-medium border-b-2 transition-colors ${activeTab === 'heat' ? 'border-indigo-500 text-white bg-white/5' : 'border-transparent text-gray-400 hover:text-gray-200'}`}
          >
              Heat &amp; Liveness
          </button>
      </div>

      <div className="p-5">
        {activeTab === 'info' && (
            <div className="grid sm:grid-cols-2 gap-4 text-xs text-gray-300">
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Content Hash (CID)</div>
                  <div className="font-mono break-all bg-gray-950/40 border border-gray-800 rounded px-3 py-2 text-indigo-300 select-all">
                    {deal.cid || 'Empty Container'}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Owner</div>
                  <div className="font-mono text-[11px] bg-gray-950/40 border border-gray-800 rounded px-3 py-2 text-gray-300 select-all">
                    {deal.owner}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Size</div>
                  <div className="flex items-center justify-between">
                    <span>
                        {deal.size !== '0' ? `${(parseInt(deal.size) / 1024 / 1024).toFixed(2)} MB` : '0 MB'}
                    </span>
                    <span className="text-gray-500">Tier: {deal.deal_size === 1 ? '4 GiB' : deal.deal_size === 2 ? '32 GiB' : '512 GiB'}</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Economics</div>
                  <div className="grid grid-cols-2 gap-2">
                      <div className="bg-gray-950/40 px-2 py-1 rounded border border-gray-800">
                          <span className="text-gray-500 block text-[10px]">Escrow</span>
                          {deal.escrow ? `${deal.escrow} stake` : '—'}
                      </div>
                      <div className="bg-gray-950/40 px-2 py-1 rounded border border-gray-800">
                          <span className="text-gray-500 block text-[10px]">Max Spend</span>
                          {deal.max_monthly_spend ? `${deal.max_monthly_spend} stake` : '—'}
                      </div>
                  </div>
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <div className="text-gray-500 uppercase tracking-wide">Providers</div>
                  <div className="bg-gray-950/40 border border-gray-800 rounded p-2">
                    {deal.providers && deal.providers.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {deal.providers.map((p: string) => (
                            <div key={p} className="font-mono text-[10px] text-emerald-400 flex items-center gap-2">
                                <Server className="w-3 h-3" />
                                {p}
                            </div>
                          ))}
                      </div>
                    ) : (
                      <span className="text-gray-500 italic">No providers assigned yet</span>
                    )}
                  </div>
                </div>
                
                {deal.cid && (
                    <div className="sm:col-span-2 mt-2">
                        <button
                        onClick={() => {
                            if (!deal.cid || !nilAddress) return
                            const url = `${appConfig.gatewayBase}/gateway/fetch/${encodeURIComponent(
                            deal.cid,
                            )}?deal_id=${encodeURIComponent(deal.id)}&owner=${encodeURIComponent(nilAddress)}`
                            window.open(url, '_blank')
                        }}
                        className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-md transition-colors"
                        >
                        <ArrowDownRight className="w-4 h-4" />
                        Download File & Verify Retrieval
                        </button>
                    </div>
                )}
            </div>
        )}

        {activeTab === 'manifest' && (
            <div className="space-y-4">
                {loadingManifest ? (
                    <div className="text-center py-8 text-gray-500 text-xs">Loading manifest structure...</div>
                ) : manifest ? (
                    <>
                        <div className="grid grid-cols-2 gap-4 text-xs">
                            <div className="bg-gray-950/40 p-3 rounded border border-gray-800">
                                <div className="text-gray-500 uppercase text-[10px]">Total MDUs</div>
                                <div className="text-lg font-mono text-white">{manifest.total_mdus}</div>
                            </div>
                            <div className="bg-gray-950/40 p-3 rounded border border-gray-800">
                                <div className="text-gray-500 uppercase text-[10px]">Manifest Root</div>
                                <div className="font-mono text-indigo-400 text-[10px] truncate" title={manifest.manifest_root_hex}>
                                    {manifest.manifest_root_hex.slice(0, 16)}...
                                </div>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <div className="text-xs text-gray-500 uppercase font-semibold">MDU Layout</div>
                            {manifest.mdus.map((mdu) => (
                                <div key={mdu.index} className="bg-gray-950/40 border border-gray-800 rounded p-3 text-xs">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="font-medium text-white">MDU #{mdu.index}</span>
                                        <span className="font-mono text-gray-500 text-[10px]">{mdu.root_hex.slice(0, 12)}...</span>
                                    </div>
                                    <div className="h-2 bg-gray-800 rounded-full overflow-hidden flex">
                                        {/* Visualize blobs as segments */}
                                        {Array.from({ length: 64 }).map((_, i) => (
                                            <div 
                                                key={i} 
                                                className={`h-full flex-1 border-r border-gray-900 ${i < mdu.blobs.length ? 'bg-indigo-500/50' : 'bg-transparent'}`}
                                                title={`Blob ${i}`}
                                            />
                                        ))}
                                    </div>
                                    <div className="mt-1 text-[10px] text-gray-600 flex justify-between">
                                        <span>64 Blobs</span>
                                        <span>8 MiB</span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                ) : (
                    <div className="text-center py-8 text-gray-500 text-xs">
                        No manifest available. (This deal might be capacity-only or the gateway index is missing).
                    </div>
                )}
            </div>
        )}

        {activeTab === 'heat' && (
            <div className="space-y-4">
                <div className="bg-gray-950/40 border border-gray-800 rounded p-4 text-center">
                    <Activity className="w-8 h-8 text-orange-500 mx-auto mb-2" />
                    <h4 className="text-sm font-medium text-white">Traffic Analysis</h4>
                    <p className="text-xs text-gray-500 mt-1">Real-time heat metrics coming in v2.6.1</p>
                </div>
                {/* Placeholder for future charts */}
                <div className="h-32 bg-gray-950/20 border border-gray-800 border-dashed rounded flex items-center justify-center text-xs text-gray-600">
                    Liveness Heatmap Visualization
                </div>
            </div>
        )}
      </div>
    </div>
  )
}
