import { useAccount, useBalance, useConnect, useDisconnect, useChainId, useSwitchChain } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { ethToNil } from '../lib/address'
import { useEffect, useMemo, useState } from 'react'
import { Coins, RefreshCw, Wallet, CheckCircle2, ArrowDownRight, Upload, HardDrive, Database } from 'lucide-react'
import { useFaucet } from '../hooks/useFaucet'
import { useCreateDeal } from '../hooks/useCreateDeal'
import { useUpdateDealContent } from '../hooks/useUpdateDealContent'
import { useUpload } from '../hooks/useUpload'
import { useProofs } from '../hooks/useProofs'
import { appConfig } from '../config'
import { StatusBar } from './StatusBar'
import { DealDetail } from './DealDetail'

interface Deal {
  id: string
  cid: string
  size: string
  owner: string
  escrow: string
  end_block: string
  start_block?: string
  service_hint?: string
  current_replication?: string
  max_monthly_spend?: string
  providers?: string[]
  deal_size?: number
}

interface Provider {
  address: string
  capabilities: string
  total_storage: string
  used_storage: string
  status: string
  reputation_score: string
}

export function Dashboard() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChainAsync } = useSwitchChain()
  const { connectAsync } = useConnect()
  const { disconnect } = useDisconnect()
  const { requestFunds, loading: faucetLoading, lastTx: faucetTx, txStatus: faucetTxStatus } = useFaucet()
  const { submitDeal, loading: dealLoading, lastTx: createTx } = useCreateDeal()
  const { submitUpdate, loading: updateLoading, lastTx: updateTx } = useUpdateDealContent()
  const { upload, loading: uploadLoading } = useUpload()
  const [deals, setDeals] = useState<Deal[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null)
  const [nilAddress, setNilAddress] = useState('')
  const [activeTab, setActiveTab] = useState<'alloc' | 'content'>('alloc')

  const isWrongNetwork = chainId !== appConfig.chainId

  const handleSwitchNetwork = async () => {
    try {
      await switchChainAsync({ chainId: appConfig.chainId })
    } catch (e: any) {
      console.error('Failed to switch network:', e)
      
      // Error code 4902 means the chain has not been added to MetaMask.
      if (e.code === 4902 || e.message?.includes('Unrecognized chain ID') || e.code === -32603) {
         try {
             await (window as any).ethereum.request({
                 method: 'wallet_addEthereumChain',
                 params: [{
                     chainId: '0x40000', // 262144 in hex
                     chainName: 'NilChain Local',
                     nativeCurrency: {
                         name: 'AATOM',
                         symbol: 'AATOM',
                         decimals: 18,
                     },
                     rpcUrls: [appConfig.evmRpc],
                     blockExplorerUrls: [],
                 }],
             })
         } catch (addError) {
             console.error('Failed to add network:', addError)
             alert('Failed to add NilChain Local network. Please add it manually: ChainID 262144, RPC http://localhost:8545')
         }
      } else {
          alert(`Could not switch network. Please switch to Chain ID ${appConfig.chainId} manually.`)
      }
    }
  }

  // Step 1: Alloc State
  const [sizeTier, setSizeTier] = useState('1')
  const [duration, setDuration] = useState('100')
  const [initialEscrow, setInitialEscrow] = useState('1000000')
  const [maxMonthlySpend, setMaxMonthlySpend] = useState('5000000')
  const [replication, setReplication] = useState('1')

  // Step 2: Content State
  const [targetDealId, setTargetDealId] = useState('')
  const [cid, setCid] = useState('')
  const [sizeBytes, setSizeBytes] = useState('0')

  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [statusTone, setStatusTone] = useState<'neutral' | 'error' | 'success'>('neutral')
  const { proofs, loading: proofsLoading } = useProofs()

  const retrievalCountsByDeal = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const p of proofs) {
      if (!p.dealId) continue
      counts[p.dealId] = (counts[p.dealId] ?? 0) + 1
    }
    return counts
  }, [proofs])

  useEffect(() => {
    if (address) {
      const cosmosAddress = ethToNil(address)
      setNilAddress(cosmosAddress)
      fetchDeals(cosmosAddress)
      fetchBalances(cosmosAddress)
      fetchProviders()
    } else {
        setDeals([])
        setProviders([])
    }
  }, [address])

  async function fetchDeals(owner?: string): Promise<Deal[]> {
    setLoading(true)
    try {
        const response = await fetch(`${appConfig.lcdBase}/nilchain/nilchain/v1/deals`)
        const data = await response.json()
        if (data.deals) {
            const all: Deal[] = data.deals.map((d: any) => ({
              id: String(d.id ?? ''),
              cid: d.cid ? String(d.cid) : (d.manifest_root ? String(d.manifest_root) : ''),
              size: String(d.size ?? d.size_bytes ?? '0'),
              owner: String(d.owner ?? ''),
              escrow: String(d.escrow_balance ?? d.escrow ?? ''),
              end_block: String(d.end_block ?? ''),
              start_block: String(d.start_block ?? ''),
              service_hint: d.service_hint,
              current_replication: d.current_replication,
              max_monthly_spend: d.max_monthly_spend,
              providers: Array.isArray(d.providers) ? d.providers : [],
              deal_size: d.deal_size ? Number(d.deal_size) : 0,
            }))
            let filtered = owner ? all.filter((d) => d.owner === owner) : all
            if (owner && filtered.length === 0 && all.length > 0) {
              filtered = all
            }
            setDeals(filtered)
            return filtered
        }
    } catch (e) {
        console.error("Failed to fetch deals", e)
    } finally {
        setLoading(false)
    }
    return []
  }

  const [bankBalances, setBankBalances] = useState<{ atom?: string; stake?: string }>({})
  const { data: evmBalance, refetch: refetchEvm } = useBalance({
    address,
    chainId: appConfig.chainId,
  })

  async function fetchBalances(owner: string) {
    try {
      const res = await fetch(`${appConfig.lcdBase}/cosmos/bank/v1beta1/balances/${owner}`)
      const json = await res.json()
      const bal = Array.isArray(json?.balances) ? json.balances : []
      const getAmt = (denom: string) => {
        const hit = bal.find((b: any) => b.denom === denom)
        return hit ? hit.amount : undefined
      }
      setBankBalances({
        atom: getAmt('aatom'),
        stake: getAmt('stake'),
      })
    } catch (e) {
      console.error('fetchBalances failed', e)
    }
  }

  async function fetchProviders() {
    try {
      const res = await fetch(`${appConfig.lcdBase}/nilchain/nilchain/v1/providers`)
      const json = await res.json()
      if (json.providers) {
        setProviders(json.providers as Provider[])
      }
    } catch (e) {
      console.error('Failed to fetch providers', e)
    }
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !address) {
      return
    }
    try {
      const result = await upload(file, address)
      setCid(result.cid)
      setSizeBytes(String(result.sizeBytes))
      setStatusTone('neutral')
      setStatusMsg(`File uploaded. Root CID derived: ${result.cid.slice(0, 16)}...`)
    } catch (e: any) {
      console.error(e)
      setStatusTone('error')
      setStatusMsg(`File upload/sharding failed: ${e.message || 'Check gateway logs.'}`)
    }
  }

  const handleRequestFunds = async () => {
      try {
          const resp = await requestFunds(address)
          if (nilAddress) fetchBalances(nilAddress)
          refetchEvm?.()
          setStatusTone('neutral')
          if (resp?.tx_hash) {
            setStatusMsg(`Faucet tx ${resp.tx_hash} pending...`)
          } else {
            setStatusMsg('Faucet requested. Awaiting inclusion...')
          }
      } catch (e) {
          setStatusTone('error')
          setStatusMsg('Faucet request failed. Is the faucet running?')
      }
  }

  const handleCreateDeal = async () => {
    if (!bankBalances.stake && !bankBalances.atom) {
      setStatusTone('error')
      setStatusMsg('You must request testnet NIL from the faucet before creating a storage deal.')
      return
    }
      try {
        const res = await submitDeal({
          creator: address || nilAddress,
          sizeTier: Number(sizeTier),
          duration: Number(duration),
          initialEscrow,
          maxMonthlySpend,
          replication: Number(replication),
        })
        setStatusTone('success')
        setStatusMsg(`Capacity Allocated. Deal ID: ${res.deal_id}. Now verify via content tab.`)
        if (nilAddress) {
          await refreshDealsAfterCreate(nilAddress)
          await fetchBalances(nilAddress)
          // Auto-switch to content tab and pre-fill deal ID
          setTargetDealId(String(res.deal_id))
          setActiveTab('content')
        }
      } catch (e) {
        setStatusTone('error')
        setStatusMsg('Deal allocation failed. Check gateway logs.')
      }
  }

  const handleUpdateContent = async () => {
      if (!targetDealId) { alert('Deal ID required'); return }
      if (!cid) { alert('CID required'); return }
      
      try {
          await submitUpdate({
              creator: address || nilAddress,
              dealId: Number(targetDealId),
              cid: cid.trim(),
              sizeBytes: Number(sizeBytes)
          })
          setStatusTone('success')
          setStatusMsg('Content Committed! The network will now replicate your data.')
          if (nilAddress) await refreshDealsAfterCreate(nilAddress)
      } catch (e) {
          setStatusTone('error')
          setStatusMsg('Content commit failed.')
      }
  }

  async function refreshDealsAfterCreate(owner: string) {
    const maxAttempts = 5
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const list = await fetchDeals(owner)
      if (list.length > 0) { // Simple check, ideally check for new ID
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  useEffect(() => {
    if (faucetTxStatus === 'confirmed' && faucetTx) {
      setStatusTone('success')
      setStatusMsg(`Faucet tx ${faucetTx} confirmed.`)
      if (nilAddress) fetchBalances(nilAddress)
      refetchEvm?.()
    } else if (faucetTxStatus === 'failed' && faucetTx) {
      setStatusTone('error')
      setStatusMsg(`Faucet tx ${faucetTx} failed.`)
    }
  }, [faucetTxStatus, faucetTx, nilAddress, refetchEvm])

  if (!isConnected) return (
    <div className="p-12 text-center">
        <h2 className="text-xl font-semibold text-gray-300 mb-2">Connect Your Wallet</h2>
        <p className="text-gray-500 mb-4">Access your storage deals and manage your files.</p>
        <button
          onClick={() => connectAsync({ connector: injected() })}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md shadow"
        >
          <Wallet className="w-4 h-4" />
          Connect MetaMask
        </button>
    </div>
  )

  return (
    <div className="space-y-6 w-full max-w-6xl mx-auto px-4 pt-8">
      <StatusBar />
      
      {isWrongNetwork && (
        <div className="bg-red-900/20 border border-red-500/50 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-red-500/20 rounded-full">
              <RefreshCw className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h3 className="font-bold text-red-200">Wrong Network</h3>
              <p className="text-sm text-red-300">You are connected to Chain ID {chainId}. Please switch to Local NilChain ({appConfig.chainId}).</p>
            </div>
          </div>
          <button
            onClick={handleSwitchNetwork}
            className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white text-sm font-bold rounded-lg transition-colors"
          >
            Switch Network
          </button>
        </div>
      )}

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-gray-900/30 p-6 rounded-xl border border-gray-800">
        <div>
            <h2 className="text-2xl font-bold text-white">My Storage Deals</h2>
            <p className="text-gray-400 text-sm mt-1">Manage your active file contracts</p>
        </div>
        <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-3">
                <button 
                    onClick={handleRequestFunds}
                    disabled={faucetLoading}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 border border-yellow-500/20 rounded-md transition-colors disabled:opacity-50"
                >
                    {faucetLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Coins className="w-3 h-3" />}
                    {faucetLoading ? 'Sending...' : 'Get Testnet NIL'}
                </button>
                {faucetTx && (
                  <div className="flex items-center gap-2 text-xs text-green-400 bg-green-950/30 px-2 py-1 rounded border border-green-500/20">
                    <ArrowDownRight className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate max-w-[120px]" title={faucetTx}>
                        Tx: <span className="font-mono">{faucetTx.slice(0, 10)}...{faucetTx.slice(-8)}</span>
                    </span>
                    <span className="opacity-75">({faucetTxStatus})</span>
                  </div>
                )}
                <div className="text-right">
                    <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold mb-1">Cosmos Identity</div>
                    <div className="font-mono text-indigo-400 bg-indigo-950/30 px-3 py-1 rounded text-sm border border-indigo-500/20">
                        {nilAddress}
                    </div>
                </div>
            </div>
        </div>
      </div>

      {statusMsg && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${
          statusTone === 'error'
            ? 'border-red-800 bg-red-900/30 text-red-200'
            : statusTone === 'success'
            ? 'border-green-800 bg-green-900/20 text-green-200'
            : 'border-slate-800 bg-slate-900/40 text-slate-200'
        }`}>
          {statusMsg}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-gray-900/50 rounded-xl border border-gray-800 p-6 space-y-4">
          <div className="flex items-center gap-2 text-white font-semibold">
            <Coins className="w-4 h-4 text-yellow-400" />
            Wallet & Funds
          </div>
          <div className="text-sm text-gray-400 space-y-3">
            <div className="font-mono text-indigo-300 break-all">Address: {address || nilAddress}</div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-gray-950/40 border border-gray-800 rounded p-2">
                <div className="text-gray-500 uppercase tracking-wide">EVM (atom)</div>
                <div className="font-mono text-green-300">
                  {(() => {
                    if (!evmBalance) return '—'
                    const anyBal = evmBalance as any
                    const symbol = anyBal.symbol ?? 'AATOM'
                    const raw = anyBal.value as bigint | undefined
                    const decimals = typeof anyBal.decimals === 'number' ? anyBal.decimals : 18
                    if (raw == null) {
                      return anyBal.formatted ? `${anyBal.formatted} ${symbol}` : `0 ${symbol}`
                    }
                    const asNumber = Number(raw) / 10 ** decimals
                    return `${asNumber} ${symbol}`
                  })()}
                </div>
              </div>
              <div className="bg-gray-950/40 border border-gray-800 rounded p-2">
                <div className="text-gray-500 uppercase tracking-wide">Cosmos stake</div>
                <div className="font-mono text-blue-300">
                  {bankBalances.stake ? `${bankBalances.stake} stake` : '—'}
                </div>
              </div>
            </div>
            <button
              onClick={() => disconnect()}
              className="text-xs text-gray-500 hover:text-white underline"
            >
              Disconnect
            </button>
          </div>
        </div>

        <div className="bg-gray-900/50 rounded-xl border border-gray-800 p-0 overflow-hidden flex flex-col">
          {/* Tabs */}
          <div className="flex border-b border-gray-800">
              <button 
                onClick={() => setActiveTab('alloc')}
                className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'alloc' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'}`}
              >
                  <HardDrive className="w-4 h-4" />
                  1. Alloc Capacity
              </button>
              <button 
                onClick={() => setActiveTab('content')}
                className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'content' ? 'bg-gray-800 text-white' : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'}`}
              >
                  <Database className="w-4 h-4" />
                  2. Commit Content
              </button>
          </div>

          <div className="p-6 flex-1">
            {activeTab === 'alloc' ? (
                <div className="space-y-4">
                    <p className="text-xs text-gray-400">Reserve storage space on the network by creating a "Container".</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                        <label className="space-y-1 text-gray-400">
                            <span className="text-xs uppercase tracking-wide text-gray-500">Size Tier</span>
                            <select 
                                value={sizeTier} 
                                onChange={e => setSizeTier(e.target.value)}
                                className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                            >
                                <option value="1">Tier 1: 4 GiB (Dev)</option>
                                <option value="2">Tier 2: 32 GiB (Std)</option>
                                <option value="3">Tier 3: 512 GiB (Wholesale)</option>
                            </select>
                        </label>
                        <label className="space-y-1 text-gray-400">
                            <span className="text-xs uppercase tracking-wide text-gray-500">Duration (blocks)</span>
                            <input value={duration} onChange={e => setDuration(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm" />
                        </label>
                        <label className="space-y-1 text-gray-400">
                            <span className="text-xs uppercase tracking-wide text-gray-500">Initial Escrow</span>
                            <input value={initialEscrow} onChange={e => setInitialEscrow(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm" />
                        </label>
                        <label className="space-y-1 text-gray-400">
                            <span className="text-xs uppercase tracking-wide text-gray-500">Max Monthly Spend</span>
                            <input value={maxMonthlySpend} onChange={e => setMaxMonthlySpend(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm" />
                        </label>
                        <label className="space-y-1 text-gray-400">
                            <span className="text-xs uppercase tracking-wide text-gray-500">Replication</span>
                            <input
                                type="number"
                                min={1}
                                max={12}
                                value={replication}
                                onChange={e => setReplication(e.target.value)}
                                className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm"
                            />
                        </label>
                    </div>
                    <div className="flex items-center justify-between pt-2">
                        <div className="text-xs text-gray-500">
                            {createTx && <div className="text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Alloc Tx: {createTx.slice(0,10)}...</div>}
                        </div>
                        <button
                            onClick={handleCreateDeal}
                            disabled={dealLoading}
                            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-md disabled:opacity-50"
                        >
                            {dealLoading ? 'Allocating...' : 'Allocate'}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    <p className="text-xs text-gray-400">Upload a file and commit its cryptographic hash to your deal.</p>
                    <div className="grid grid-cols-1 gap-3 text-sm">
                        <label className="space-y-1 text-gray-400">
                            <span className="text-xs uppercase tracking-wide text-gray-500">Target Deal ID</span>
                            <select 
                                value={targetDealId} 
                                onChange={e => setTargetDealId(e.target.value)}
                                className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-indigo-500"
                            >
                                <option value="">Select a Deal...</option>
                                {deals.filter(d => d.owner === nilAddress).map(d => (
                                    <option key={d.id} value={d.id}>Deal #{d.id} ({d.cid ? 'Active' : 'Empty'}) - {d.deal_size === 1 ? '4GiB' : d.deal_size === 2 ? '32GiB' : '512GiB'}</option>
                                ))}
                            </select>
                        </label>
                        <label className="space-y-1 text-gray-400">
                            <span className="text-xs uppercase tracking-wide text-gray-500 flex items-center gap-2">
                                <Upload className="w-3 h-3 text-indigo-400" />
                                Upload & Shard
                            </span>
                            <input
                                type="file"
                                onChange={handleFileChange}
                                disabled={uploadLoading}
                                className="w-full text-xs text-gray-300 file:mr-2 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-indigo-600 file:text-white hover:file:bg-indigo-500"
                            />
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="space-y-1 text-gray-400">
                                <span className="text-xs uppercase tracking-wide text-gray-500">Root CID</span>
                                <input value={cid} onChange={e => setCid(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm font-mono text-xs" />
                            </label>
                            <label className="space-y-1 text-gray-400">
                                <span className="text-xs uppercase tracking-wide text-gray-500">Size (Bytes)</span>
                                <input value={sizeBytes} onChange={e => setSizeBytes(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm font-mono text-xs" />
                            </label>
                        </div>
                    </div>
                    <div className="flex items-center justify-between pt-2">
                        <div className="text-xs text-gray-500">
                            {updateTx && <div className="text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Commit Tx: {updateTx.slice(0,10)}...</div>}
                        </div>
                        <button
                            onClick={handleUpdateContent}
                            disabled={updateLoading || !cid || !targetDealId}
                            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-md disabled:opacity-50"
                        >
                            {updateLoading ? 'Committing...' : 'Commit Content'}
                        </button>
                    </div>
                </div>
            )}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-24">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-500 mx-auto mb-4"></div>
            <p className="text-gray-500">Syncing with NilChain...</p>
        </div>
      ) : deals.length === 0 ? (
        <div className="bg-gray-900/50 rounded-xl p-16 text-center border border-gray-800 border-dashed">
            <div className="w-16 h-16 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-6">
                <HardDrive className="w-8 h-8 text-gray-500" />
            </div>
            <h3 className="text-lg font-medium text-white mb-2">No active deals</h3>
            <p className="text-gray-400 mb-6 max-w-md mx-auto">Alloc capacity above to get started.</p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-900/50 shadow-xl">
              <table className="min-w-full divide-y divide-gray-800">
                  <thead className="bg-gray-950/50">
                      <tr>
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Deal ID</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Content Hash (CID)</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Size</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Tier</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Status</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Retrievals</th>
                      </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                      {deals.map((deal) => (
                      <tr
                        key={deal.id}
                        className="hover:bg-white/5 transition-colors cursor-pointer"
                        onClick={() => setSelectedDeal(deal)}
                      >
                              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-white">#{deal.id}</td>
                              <td
                                className="px-6 py-4 whitespace-nowrap text-sm font-mono text-indigo-400"
                                title={deal.cid}
                              >
                                {deal.cid ? `${deal.cid.slice(0, 18)}...` : <span className="text-gray-600 italic">Empty</span>}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">
                                {deal.size !== '0' ? `${(parseInt(deal.size) / 1024 / 1024).toFixed(2)} MB` : '—'}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">
                                {deal.deal_size === 1 ? '4 GiB' : deal.deal_size === 2 ? '32 GiB' : deal.deal_size === 3 ? '512 GiB' : 'Unk'}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                  {deal.cid ? (
                                      <span className="px-2 py-1 text-xs rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                                          Active
                                      </span>
                                  ) : (
                                      <span className="px-2 py-1 text-xs rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                                          Allocated
                                      </span>
                                  )}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">
                                {retrievalCountsByDeal[deal.id] !== undefined ? retrievalCountsByDeal[deal.id] : 0}
                              </td>
                      </tr>
                      ))}
                  </tbody>
              </table>
          </div>

          {providers.length > 0 && (
            <div className="mt-6 overflow-hidden rounded-xl border border-gray-800 bg-gray-900/40">
              <div className="px-6 py-3 border-b border-gray-800 bg-gray-950/40 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Active Providers
              </div>
              <table className="min-w-full divide-y divide-gray-800 text-xs">
                <thead className="bg-gray-950/30">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-400 uppercase tracking-wider">Address</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-400 uppercase tracking-wider">Capabilities</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-400 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-2 text-right font-medium text-gray-400 uppercase tracking-wider">Total Storage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {providers.map((p) => (
                    <tr key={p.address} className="hover:bg-white/5 transition-colors">
                      <td className="px-4 py-2 font-mono text-[11px] text-indigo-300">
                        {p.address.slice(0, 12)}...{p.address.slice(-6)}
                      </td>
                      <td className="px-4 py-2 text-gray-200">{p.capabilities}</td>
                      <td className="px-4 py-2">
                        <span className="px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                          {p.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-gray-300">
                        {p.total_storage ? `${(parseInt(p.total_storage) / (1024 ** 4)).toFixed(2)} TiB` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Deal Details */}
          {selectedDeal && (
            <DealDetail 
                deal={selectedDeal} 
                onClose={() => setSelectedDeal(null)} 
                nilAddress={nilAddress} 
            />
          )}

          {/* Liveness & Performance */}
          {proofs.length > 0 && (
            <div className="mt-6 overflow-hidden rounded-xl border border-gray-800 bg-gray-900/40">
              <div className="px-6 py-3 border-b border-gray-800 bg-gray-950/40 text-xs font-semibold text-gray-400 uppercase tracking-wider flex items-center justify-between">
                <span>Liveness &amp; Performance</span>
                {proofsLoading && <span className="text-[10px] text-gray-500">Syncing proofs…</span>}
              </div>
              <table className="min-w-full divide-y divide-gray-800 text-xs">
                <thead className="bg-gray-950/30">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-gray-400 uppercase tracking-wider">Deal</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-400 uppercase tracking-wider">Provider</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-400 uppercase tracking-wider">Tier</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-400 uppercase tracking-wider">Block</th>
                    <th className="px-4 py-2 text-left font-medium text-gray-400 uppercase tracking-wider">Valid</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800">
                  {(() => {
                    const myDealIds = new Set(deals.map((d) => d.id))
                    const myProofs = proofs.filter((p) => p.dealId && myDealIds.has(p.dealId))
                    return (myProofs.length > 0 ? myProofs : proofs).slice(0, 10).map((p) => (
                      <tr key={p.id} className="hover:bg-white/5 transition-colors">
                        <td className="px-4 py-2 text-gray-200">
                          {p.dealId ? `#${p.dealId}` : '—'}
                        </td>
                        <td className="px-4 py-2 font-mono text-[11px] text-indigo-300">
                          {p.creator ? `${p.creator.slice(0, 10)}...${p.creator.slice(-4)}` : '—'}
                        </td>
                        <td className="px-4 py-2 text-gray-200">
                          {p.tier || '—'}
                        </td>
                        <td className="px-4 py-2 text-gray-400">
                          {p.blockHeight || 0}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`px-2 py-0.5 rounded-full border text-[10px] ${
                            p.valid
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                              : 'border-red-500/40 bg-red-500/10 text-red-300'
                          }`}>
                            {p.valid ? 'OK' : 'FAIL'}
                          </span>
                        </td>
                      </tr>
                    ))
                  })()}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
