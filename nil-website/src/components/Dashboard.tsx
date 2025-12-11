import { useAccount, useBalance, useConnect, useDisconnect, useChainId } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { ethToNil } from '../lib/address'
import { useEffect, useMemo, useState } from 'react'
import { Coins, RefreshCw, Wallet, CheckCircle2, ArrowDownRight, Upload, HardDrive, Database } from 'lucide-react'
import { useFaucet } from '../hooks/useFaucet'
import { useCreateDeal } from '../hooks/useCreateDeal'
import { useUpdateDealContent } from '../hooks/useUpdateDealContent'
import { useUpload } from '../hooks/useUpload'
import { useProofs } from '../hooks/useProofs'
import { useNetwork } from '../hooks/useNetwork'
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
  const { connectAsync } = useConnect()
  const { disconnect } = useDisconnect()
  const { requestFunds, loading: faucetLoading, lastTx: faucetTx, txStatus: faucetTxStatus } = useFaucet()
  const { submitDeal, loading: dealLoading, lastTx: createTx } = useCreateDeal()
  const { submitUpdate, loading: updateLoading, lastTx: updateTx } = useUpdateDealContent()
  const { upload, loading: uploadLoading } = useUpload()
  const { switchNetwork } = useNetwork()
  const [deals, setDeals] = useState<Deal[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null)
  const [nilAddress, setNilAddress] = useState('')
  const [activeTab, setActiveTab] = useState<'alloc' | 'content'>('alloc')

  // Track MetaMask chain ID directly to handle Localhost caching issues where Wagmi might be stale
  const [metamaskChainId, setMetamaskChainId] = useState<number | undefined>(undefined)
  useEffect(() => {
    const getChainId = async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eth = (window as any).ethereum
        if (eth) {
            try {
                const hex = await eth.request({ method: 'eth_chainId' })
                setMetamaskChainId(parseInt(hex, 16))
            } catch (e) {
                console.error(e)
            }
        }
    }
    getChainId()
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eth = (window as any).ethereum
    if (eth && eth.on) {
        const handleChainChanged = (hex: string) => setMetamaskChainId(parseInt(hex, 16))
        eth.on('chainChanged', handleChainChanged)
        return () => eth.removeListener('chainChanged', handleChainChanged)
    }
  }, [])

  // Prefer the direct MetaMask ID if available, otherwise fallback to Wagmi
  const activeChainId = metamaskChainId ?? chainId
  const isWrongNetwork = activeChainId !== appConfig.chainId

  // Check if the RPC node itself is on the right chain
  const [rpcChainId, setRpcChainId] = useState<number | null>(null)
  useEffect(() => {
    const checkRpc = async () => {
      try {
        const res = await fetch(appConfig.evmRpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
        })
        const json = await res.json()
        const id = parseInt(json.result, 16)
        setRpcChainId(id)
      } catch (e) {
        console.error('RPC Check failed', e)
      }
    }
    checkRpc()
    const timer = setInterval(checkRpc, 5000)
    return () => clearInterval(timer)
  }, [])

  const rpcMismatch = rpcChainId !== null && rpcChainId !== appConfig.chainId

  const handleSwitchNetwork = async () => {
    try {
      await switchNetwork()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      alert(`Could not switch network. Please switch to Chain ID ${appConfig.chainId} manually.`)
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
            const all: Deal[] = data.deals.map((d: any) => {
              let dealSizeVal = 0
              if (d.deal_size === 'DEAL_SIZE_4GIB') dealSizeVal = 1
              else if (d.deal_size === 'DEAL_SIZE_32GIB') dealSizeVal = 2
              else if (d.deal_size === 'DEAL_SIZE_512GIB') dealSizeVal = 3
              else if (typeof d.deal_size === 'number') dealSizeVal = d.deal_size

              // Helper to convert base64 to hex
              const toHex = (str: string) => {
                  if (!str) return ''
                  if (str.startsWith('0x')) return str
                  try {
                      const binary = atob(str)
                      const bytes = new Uint8Array(binary.length)
                      for (let i = 0; i < binary.length; i++) {
                          bytes[i] = binary.charCodeAt(i)
                      }
                      return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
                  } catch (e) {
                      return str // Return original if not base64
                  }
              }

              const manifestRootHex = d.manifest_root ? toHex(d.manifest_root) : ''
              const cid = d.cid ? String(d.cid) : manifestRootHex

              return {
                id: String(d.id ?? ''),
                cid: cid,
                size: String(d.size ?? d.size_bytes ?? '0'),
                owner: String(d.owner ?? ''),
                escrow: String(d.escrow_balance ?? d.escrow ?? ''),
                end_block: String(d.end_block ?? ''),
                start_block: String(d.start_block ?? ''),
                service_hint: d.service_hint,
                current_replication: d.current_replication,
                max_monthly_spend: d.max_monthly_spend,
                providers: Array.isArray(d.providers) ? d.providers : [],
                deal_size: dealSizeVal,
              }
            })
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
          await refreshDealsAfterCreate(nilAddress, String(res.deal_id))
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
          if (nilAddress) await refreshDealsAfterCreate(nilAddress, targetDealId)
      } catch (e) {
          setStatusTone('error')
          setStatusMsg('Content commit failed.')
      }
  }

  async function refreshDealsAfterCreate(owner: string, newDealId: string) {
    const maxAttempts = 10
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const list = await fetchDeals(owner)
      if (list.some(d => d.id === newDealId)) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1500))
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
        <h2 className="text-xl font-semibold text-foreground mb-2">Connect Your Wallet</h2>
        <p className="text-muted-foreground mb-4">Access your storage deals and manage your files.</p>
        <button
          onClick={() => connectAsync({ connector: injected() })}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md shadow transition-colors"
        >
          <Wallet className="w-4 h-4" />
          Connect MetaMask
        </button>
    </div>
  )

  return (
    <div className="space-y-6 w-full max-w-6xl mx-auto px-4 pt-8">
      <StatusBar />
      
      {rpcMismatch && (
        <div className="bg-destructive/10 border border-destructive/50 rounded-xl p-4 flex items-center justify-between animate-pulse">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-destructive/20 rounded-full">
              <RefreshCw className="w-5 h-5 text-destructive" />
            </div>
            <div>
              <h3 className="font-bold text-destructive-foreground">Critical Node Mismatch</h3>
              <p className="text-sm text-destructive-foreground/80">
                Your local RPC node is running on Chain ID <strong>{rpcChainId}</strong>, but the app expects <strong>{appConfig.chainId}</strong>.
                <br/>Please restart your local stack or check your <code>run_local_stack.sh</code> configuration.
              </p>
            </div>
          </div>
        </div>
      )}

      {isWrongNetwork && (
        <div className="bg-yellow-500/10 border border-yellow-500/50 rounded-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-yellow-500/20 rounded-full">
              <RefreshCw className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
            </div>
            <div>
              <h3 className="font-bold text-yellow-700 dark:text-yellow-200">Wrong Network</h3>
              <p className="text-sm text-yellow-600 dark:text-yellow-300">
                Connected to Chain ID <strong>{activeChainId}</strong>. App requires <strong>{appConfig.chainId}</strong> (NilChain Local).
              </p>
            </div>
          </div>
          <button
            onClick={handleSwitchNetwork}
            className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white text-sm font-bold rounded-lg transition-colors"
          >
            Switch Network
          </button>
        </div>
      )}

      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card p-6 rounded-xl border border-border shadow-sm">
        <div>
            <h2 className="text-2xl font-bold text-foreground">My Storage Deals</h2>
            <p className="text-muted-foreground text-sm mt-1">Manage your active file contracts</p>
        </div>
        <div className="flex flex-col items-end gap-2">
            <div className="flex items-center gap-3">
                <button 
                    onClick={handleRequestFunds}
                    disabled={faucetLoading}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 rounded-md transition-colors disabled:opacity-50"
                >
                    {faucetLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Coins className="w-3 h-3" />}
                    {faucetLoading ? 'Sending...' : 'Get Testnet NIL'}
                </button>
                {faucetTx && (
                  <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-2 py-1 rounded border border-green-500/20">
                    <ArrowDownRight className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate max-w-[120px]" title={faucetTx}>
                        Tx: <span className="font-mono">{faucetTx.slice(0, 10)}...{faucetTx.slice(-8)}</span>
                    </span>
                    <span className="opacity-75">({faucetTxStatus})</span>
                  </div>
                )}
                <div className="text-right">
                    <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Cosmos Identity</div>
                    <div className="font-mono text-primary bg-primary/5 px-3 py-1 rounded text-sm border border-primary/10">
                        {nilAddress}
                    </div>
                </div>
            </div>
        </div>
      </div>

      {statusMsg && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${
          statusTone === 'error'
            ? 'border-destructive/50 bg-destructive/10 text-destructive'
            : statusTone === 'success'
            ? 'border-green-500/50 bg-green-500/10 text-green-600 dark:text-green-400'
            : 'border-border bg-secondary/50 text-muted-foreground'
        }`}>
          {statusMsg}
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-card rounded-xl border border-border p-6 space-y-4 shadow-sm">
          <div className="flex items-center gap-2 text-foreground font-semibold">
            <Coins className="w-4 h-4 text-yellow-500" />
            Wallet & Funds
          </div>
          <div className="text-sm text-muted-foreground space-y-3">
            <div className="font-mono text-primary break-all">Address: {address || nilAddress}</div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="bg-secondary/50 border border-border rounded p-2">
                <div className="text-muted-foreground uppercase tracking-wide">EVM (atom)</div>
                <div className="font-mono text-green-600 dark:text-green-400">
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
              <div className="bg-secondary/50 border border-border rounded p-2">
                <div className="text-muted-foreground uppercase tracking-wide">Cosmos stake</div>
                <div className="font-mono text-blue-600 dark:text-blue-400">
                  {bankBalances.stake ? `${bankBalances.stake} stake` : '—'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
                <button
                onClick={() => disconnect()}
                className="text-xs text-muted-foreground hover:text-foreground underline"
                >
                Disconnect
                </button>
                <span className="text-border">|</span>
                <button
                onClick={() => switchNetwork()}
                className="text-xs text-primary hover:text-primary/80 underline"
                >
                Force Switch Network
                </button>
            </div>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-0 overflow-hidden flex flex-col shadow-sm">
          {/* Tabs */}
          <div className="flex border-b border-border">
              <button 
                onClick={() => setActiveTab('alloc')}
                className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'alloc' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}
              >
                  <HardDrive className="w-4 h-4" />
                  1. Alloc Capacity
              </button>
              <button 
                onClick={() => setActiveTab('content')}
                className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'content' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}
              >
                  <Database className="w-4 h-4" />
                  2. Commit Content
              </button>
          </div>

          <div className="p-6 flex-1">
            {activeTab === 'alloc' ? (
                <div className="space-y-4">
                    <p className="text-xs text-muted-foreground">Reserve storage space on the network by creating a "Container".</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Size Tier</span>
                            <select 
                                value={sizeTier} 
                                onChange={e => setSizeTier(e.target.value)}
                                className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                            >
                                <option value="1">Tier 1: 4 GiB (Dev)</option>
                                <option value="2">Tier 2: 32 GiB (Std)</option>
                                <option value="3">Tier 3: 512 GiB (Wholesale)</option>
                            </select>
                        </label>
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Duration (blocks)</span>
                            <input value={duration} onChange={e => setDuration(e.target.value)} className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary" />
                        </label>
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Initial Escrow</span>
                            <input value={initialEscrow} onChange={e => setInitialEscrow(e.target.value)} className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary" />
                        </label>
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Max Monthly Spend</span>
                            <input value={maxMonthlySpend} onChange={e => setMaxMonthlySpend(e.target.value)} className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary" />
                        </label>
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Replication</span>
                            <input
                                type="number"
                                min={1}
                                max={12}
                                value={replication}
                                onChange={e => setReplication(e.target.value)}
                                className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                            />
                        </label>
                    </div>
                    <div className="flex items-center justify-between pt-2">
                        <div className="text-xs text-muted-foreground">
                            {createTx && <div className="text-green-600 dark:text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Alloc Tx: {createTx.slice(0,10)}...</div>}
                        </div>
                        <button
                            onClick={handleCreateDeal}
                            disabled={dealLoading}
                            className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-md disabled:opacity-50 transition-colors"
                        >
                            {dealLoading ? 'Allocating...' : 'Allocate'}
                        </button>
                    </div>
                </div>
            ) : (
                <div className="space-y-4">
                    <p className="text-xs text-muted-foreground">Upload a file and commit its cryptographic hash to your deal.</p>
                    <div className="grid grid-cols-1 gap-3 text-sm">
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Target Deal ID</span>
                            <select 
                                value={targetDealId} 
                                onChange={e => setTargetDealId(e.target.value)}
                                className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                            >
                                <option value="">Select a Deal...</option>
                                {deals.filter(d => d.owner === nilAddress).map(d => (
                                    <option key={d.id} value={d.id}>Deal #{d.id} ({d.cid ? 'Active' : 'Empty'}) - {d.deal_size === 1 ? '4GiB' : d.deal_size === 2 ? '32GiB' : '512GiB'}</option>
                                ))}
                            </select>
                        </label>
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                                <Upload className="w-3 h-3 text-primary" />
                                Upload & Shard
                            </span>
                            <input
                                type="file"
                                onChange={handleFileChange}
                                disabled={uploadLoading}
                                className="w-full text-xs text-muted-foreground file:mr-2 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 file:cursor-pointer cursor-pointer"
                            />
                        </label>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="space-y-1">
                                <span className="text-xs uppercase tracking-wide text-muted-foreground">Root CID</span>
                                <input value={cid} onChange={e => setCid(e.target.value)} className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm font-mono text-xs focus:outline-none focus:border-primary" />
                            </label>
                            <label className="space-y-1">
                                <span className="text-xs uppercase tracking-wide text-muted-foreground">Size (Bytes)</span>
                                <input value={sizeBytes} onChange={e => setSizeBytes(e.target.value)} className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm font-mono text-xs focus:outline-none focus:border-primary" />
                            </label>
                        </div>
                    </div>
                    <div className="flex items-center justify-between pt-2">
                        <div className="text-xs text-muted-foreground">
                            {updateTx && <div className="text-green-600 dark:text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Commit Tx: {updateTx.slice(0,10)}...</div>}
                        </div>
                        <button
                            onClick={handleUpdateContent}
                            disabled={updateLoading || !cid || !targetDealId}
                            className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-md disabled:opacity-50 transition-colors"
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
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Syncing with NilChain...</p>
        </div>
      ) : deals.length === 0 ? (
        <div className="bg-card rounded-xl p-16 text-center border border-border border-dashed shadow-sm">
            <div className="w-16 h-16 bg-secondary rounded-full flex items-center justify-center mx-auto mb-6">
                <HardDrive className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-medium text-foreground mb-2">No active deals</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">Alloc capacity above to get started.</p>
        </div>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <table className="min-w-full divide-y divide-border">
                  <thead className="bg-muted/50">
                      <tr>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Deal ID</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Content Hash (CID)</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Size</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Tier</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Retrievals</th>
                      </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                      {deals.map((deal) => (
                      <tr
                        key={deal.id}
                        className="hover:bg-muted/50 transition-colors cursor-pointer"
                        onClick={() => setSelectedDeal(deal)}
                      >
                              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-foreground">#{deal.id}</td>
                              <td
                                className="px-6 py-4 whitespace-nowrap text-sm font-mono text-primary"
                                title={deal.cid}
                              >
                                {deal.cid ? `${deal.cid.slice(0, 18)}...` : <span className="text-muted-foreground italic">Empty</span>}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                                {deal.size !== '0' ? `${(parseInt(deal.size) / 1024 / 1024).toFixed(2)} MB` : '—'}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                                {deal.deal_size === 1 ? '4 GiB' : deal.deal_size === 2 ? '32 GiB' : deal.deal_size === 3 ? '512 GiB' : 'Unk'}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                  {deal.cid ? (
                                      <span className="px-2 py-1 text-xs rounded-full bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
                                          Active
                                      </span>
                                  ) : (
                                      <span className="px-2 py-1 text-xs rounded-full bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border border-yellow-500/20">
                                          Allocated
                                      </span>
                                  )}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                                {retrievalCountsByDeal[deal.id] !== undefined ? retrievalCountsByDeal[deal.id] : 0}
                              </td>
                      </tr>
                      ))}
                  </tbody>
              </table>
          </div>

          {providers.length > 0 && (
            <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <div className="px-6 py-3 border-b border-border bg-muted/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Active Providers
              </div>
              <table className="min-w-full divide-y divide-border text-xs">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Address</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Capabilities</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="px-4 py-2 text-right font-medium text-muted-foreground uppercase tracking-wider">Total Storage</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {providers.map((p) => (
                    <tr key={p.address} className="hover:bg-muted/50 transition-colors">
                      <td className="px-4 py-2 font-mono text-[11px] text-primary">
                        {p.address.slice(0, 12)}...{p.address.slice(-6)}
                      </td>
                      <td className="px-4 py-2 text-foreground">{p.capabilities}</td>
                      <td className="px-4 py-2">
                        <span className="px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                          {p.status}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-muted-foreground">
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
            <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <div className="px-6 py-3 border-b border-border bg-muted/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
                <span>Liveness &amp; Performance</span>
                {proofsLoading && <span className="text-[10px] text-muted-foreground">Syncing proofs…</span>}
              </div>
              <table className="min-w-full divide-y divide-border text-xs">
                <thead className="bg-muted/30">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Deal</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Provider</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Tier</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Block</th>
                    <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Valid</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(() => {
                    const myDealIds = new Set(deals.map((d) => d.id))
                    const myProofs = proofs.filter((p) => p.dealId && myDealIds.has(p.dealId))
                    return (myProofs.length > 0 ? myProofs : proofs).slice(0, 10).map((p) => (
                      <tr key={p.id} className="hover:bg-muted/50 transition-colors">
                        <td className="px-4 py-2 text-foreground">
                          {p.dealId ? `#${p.dealId}` : '—'}
                        </td>
                        <td className="px-4 py-2 font-mono text-[11px] text-primary">
                          {p.creator ? `${p.creator.slice(0, 10)}...${p.creator.slice(-4)}` : '—'}
                        </td>
                        <td className="px-4 py-2 text-foreground">
                          {p.tier || '—'}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {p.blockHeight || 0}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`px-2 py-0.5 rounded-full border text-[10px] ${
                            p.valid
                              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
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
