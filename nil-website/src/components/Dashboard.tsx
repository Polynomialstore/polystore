import { useAccount, useBalance, useConnect, useDisconnect } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { ethToNil } from '../lib/address'
import { useEffect, useState } from 'react'
import { Coins, RefreshCw, SendHorizonal, Wallet, CheckCircle2, ArrowDownRight, Upload } from 'lucide-react'
import { useFaucet } from '../hooks/useFaucet'
import { useCreateDeal } from '../hooks/useCreateDeal'
import { useUpload } from '../hooks/useUpload'
import { useProofs } from '../hooks/useProofs'
import { appConfig } from '../config'
import { StatusBar } from './StatusBar'

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
  const { connectAsync } = useConnect()
  const { disconnect } = useDisconnect()
  const { requestFunds, loading: faucetLoading, lastTx: faucetTx, txStatus: faucetTxStatus } = useFaucet()
  const { submitDeal, loading: dealLoading, lastTx } = useCreateDeal()
  const { upload, loading: uploadLoading } = useUpload()
  const [deals, setDeals] = useState<Deal[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null)
  const [nilAddress, setNilAddress] = useState('')
  const [cid, setCid] = useState('')
  const [size, setSize] = useState('1048576')
  const [duration, setDuration] = useState('100')
  const [initialEscrow, setInitialEscrow] = useState('1000000')
  const [maxMonthlySpend, setMaxMonthlySpend] = useState('5000000')
  const [replication, setReplication] = useState('1')
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [statusTone, setStatusTone] = useState<'neutral' | 'error' | 'success'>('neutral')
  const { proofs, loading: proofsLoading } = useProofs()

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
            // For the current devnet, deals are created by the faucet
            // on behalf of users, so we surface all active deals here
            // and normalise the LCD payload shape.
            const all: Deal[] = data.deals.map((d: any) => ({
              id: String(d.id ?? ''),
              cid: String(d.cid ?? ''),
              size: String(d.size ?? d.size_bytes ?? '0'),
              owner: String(d.owner ?? ''),
              escrow: String(d.escrow_balance ?? d.escrow ?? ''),
              end_block: String(d.end_block ?? ''),
              start_block: String(d.start_block ?? ''),
              service_hint: d.service_hint,
              current_replication: d.current_replication,
              max_monthly_spend: d.max_monthly_spend,
              providers: Array.isArray(d.providers) ? d.providers : [],
            }))
            let filtered = owner ? all.filter((d) => d.owner === owner) : all
            // Fallback: if no owner-matched deals but there are deals on-chain
            // (e.g. older faucet-owned deals), show all so the UI never lies.
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
      setSize(String(result.sizeBytes))
      setStatusTone('neutral')
      setStatusMsg(`File uploaded. Root CID derived from shard: ${result.cid.slice(0, 16)}...`)
    } catch (e) {
      console.error(e)
      setStatusTone('error')
      setStatusMsg('File upload/sharding failed. Check gateway logs.')
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
    if (!cid.trim()) {
      alert('CID is required')
      return
    }
      try {
        await submitDeal({
          creator: address || nilAddress,
          cid: cid.trim(),
          size: Number(size || '0'),
          duration: Number(duration || '0'),
          initialEscrow,
          maxMonthlySpend,
          replication: Number(replication || '1'),
        })
        setStatusTone('success')
        setStatusMsg('Deal submitted. Track tx in your wallet and blocks.')
        if (nilAddress) {
          await refreshDealsAfterCreate(nilAddress)
          await fetchBalances(nilAddress)
        }
      } catch (e) {
        setStatusTone('error')
        setStatusMsg('Deal submission failed. Check faucet server logs.')
      }
  }

  async function refreshDealsAfterCreate(owner: string) {
    const maxAttempts = 5
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const list = await fetchDeals(owner)
      if (list.length > 0) {
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
                  <div className="flex items-center gap-2 text-xs text-green-400">
                    <ArrowDownRight className="w-3 h-3" />
                    Faucet tx: <span className="font-mono">{faucetTx}</span> ({faucetTxStatus})
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
              <div className="bg-gray-950/40 border border-gray-800 rounded p-2 col-span-2">
                <div className="text-gray-500 uppercase tracking-wide">Cosmos atom</div>
                <div className="font-mono text-emerald-300">
                  {bankBalances.atom ? `${bankBalances.atom} aatom` : '—'}
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
          <button 
            onClick={handleRequestFunds}
            disabled={faucetLoading}
            className="flex items-center gap-2 px-3 py-2 text-sm font-medium bg-yellow-500/10 text-yellow-500 hover:bg-yellow-500/20 border border-yellow-500/20 rounded-md transition-colors disabled:opacity-50"
          >
            {faucetLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Coins className="w-3 h-3" />}
            {faucetLoading ? 'Requesting...' : 'Get Testnet NIL'}
          </button>
          <div className="text-xs text-gray-500">
            Uses faucet service at {appConfig.apiBase}/faucet (keyring: faucet)
          </div>
        </div>

        <div className="bg-gray-900/50 rounded-xl border border-gray-800 p-6 space-y-4">
          <div className="flex items-center gap-2 text-white font-semibold">
            <SendHorizonal className="w-4 h-4 text-indigo-400" />
            Create Storage Deal
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <label className="space-y-1 text-gray-400 sm:col-span-2">
              <span className="text-xs uppercase tracking-wide text-gray-500 flex items-center gap-2">
                <Upload className="w-3 h-3 text-indigo-400" />
                Source File (optional)
              </span>
              <input
                type="file"
                id="deal-file-input"
                onChange={handleFileChange}
                disabled={uploadLoading}
                className="w-full text-xs text-gray-300 file:mr-2 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-indigo-600 file:text-white hover:file:bg-indigo-500"
              />
              <p className="text-xs text-gray-500">
                If provided, the gateway will shard this file via <code>nil_cli shard</code> and derive a Root CID and size for you.
              </p>
            </label>
            <label className="space-y-1 text-gray-400">
              <span className="text-xs uppercase tracking-wide text-gray-500">Root CID</span>
              <input value={cid} onChange={e => setCid(e.target.value)} placeholder="bafy..." className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm" />
            </label>
            <label className="space-y-1 text-gray-400">
              <span className="text-xs uppercase tracking-wide text-gray-500">Size (bytes)</span>
              <input value={size} onChange={e => setSize(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm" />
            </label>
            <label className="space-y-1 text-gray-400">
              <span className="text-xs uppercase tracking-wide text-gray-500">Duration (blocks)</span>
              <input value={duration} onChange={e => setDuration(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm" />
            </label>
            <label className="space-y-1 text-gray-400">
              <span className="text-xs uppercase tracking-wide text-gray-500">Replication (providers)</span>
              <input
                type="number"
                min={1}
                max={12}
                value={replication}
                onChange={e => setReplication(e.target.value)}
                className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm"
              />
              <p className="text-[11px] text-gray-500">
                For local testnet, 1 is recommended. The chain will cap this by the number of available providers and the base replication factor.
              </p>
            </label>
            <label className="space-y-1 text-gray-400">
              <span className="text-xs uppercase tracking-wide text-gray-500">Initial Escrow (stake)</span>
              <input value={initialEscrow} onChange={e => setInitialEscrow(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm" />
            </label>
            <label className="space-y-1 text-gray-400">
              <span className="text-xs uppercase tracking-wide text-gray-500">Max Monthly Spend (stake)</span>
              <input value={maxMonthlySpend} onChange={e => setMaxMonthlySpend(e.target.value)} className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-white text-sm" />
            </label>
          </div>
          <div className="flex items-center justify-between">
            <div className="text-xs text-gray-500">
              From: <span className="font-mono text-indigo-300">{address || nilAddress}</span>
              {lastTx && <div className="text-green-400 mt-1 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Tx: {lastTx}</div>}
            </div>
            <button
              onClick={handleCreateDeal}
              disabled={dealLoading}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-md disabled:opacity-50"
            >
              {dealLoading ? 'Submitting...' : 'Submit Deal'}
            </button>
          </div>
          <p className="text-xs text-yellow-400">
            Note: The faucet service broadcasts this tx using its local keyring. Ensure the faucet is running with funds.
          </p>
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
                <svg className="w-8 h-8 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"></path></svg>
            </div>
            <h3 className="text-lg font-medium text-white mb-2">No active deals</h3>
            <p className="text-gray-400 mb-6 max-w-md mx-auto">You haven't stored any files on the NilNetwork yet. Upload a file to get started.</p>
            <button
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded-lg font-medium transition-all"
              onClick={() => {
                const el = document.getElementById('deal-file-input') as HTMLInputElement | null
                if (el) el.click()
              }}
            >
              Upload New File
            </button>
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
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Service Hint</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Replication</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Escrow Balance</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Status</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Providers</th>
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
                                {deal.cid.slice(0, 18)}...{deal.cid.slice(-8)}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">{(parseInt(deal.size) / 1024 / 1024).toFixed(2)} MB</td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">{deal.service_hint || '—'}</td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">
                                {deal.current_replication || (deal.providers?.length ? String(deal.providers.length) : '—')}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">{deal.escrow ? `${deal.escrow} stake` : '—'}</td>
                              <td className="px-6 py-4 whitespace-nowrap">
                                  <span className="px-2 py-1 text-xs rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
                                      Active
                                  </span>
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-300">
                                {deal.providers && deal.providers.length > 0
                                  ? `${deal.providers[0].slice(0, 10)}...${deal.providers[0].slice(-4)}${deal.providers.length > 1 ? ` (+${deal.providers.length - 1} more)` : ''}`
                                  : '—'}
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
            <div className="mt-6 rounded-xl border border-gray-800 bg-gray-900/60 p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <div className="text-xs text-gray-500 uppercase tracking-wider">Selected Deal</div>
                  <div className="text-sm font-semibold text-white">#{selectedDeal.id}</div>
                </div>
                <button
                  onClick={() => setSelectedDeal(null)}
                  className="text-xs text-gray-400 hover:text-gray-200 underline"
                >
                  Clear
                </button>
              </div>
              <div className="grid sm:grid-cols-2 gap-3 text-xs text-gray-300">
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Content Hash (CID)</div>
                  <div className="font-mono break-all bg-gray-950/40 border border-gray-800 rounded px-3 py-2">
                    {selectedDeal.cid}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Owner</div>
                  <div className="font-mono text-[11px] bg-gray-950/40 border border-gray-800 rounded px-3 py-2">
                    {selectedDeal.owner}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Size</div>
                  <div>
                    {(parseInt(selectedDeal.size) / 1024 / 1024).toFixed(2)} MB
                    <span className="text-gray-500"> ({selectedDeal.size} bytes)</span>
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Escrow</div>
                  <div>{selectedDeal.escrow ? `${selectedDeal.escrow} stake` : '—'}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Service Hint</div>
                  <div>{selectedDeal.service_hint || '—'}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Replication</div>
                  <div>
                    {selectedDeal.current_replication ||
                      (selectedDeal.providers?.length ? String(selectedDeal.providers.length) : '—')}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Blocks</div>
                  <div>
                    {selectedDeal.start_block ?? '—'} → {selectedDeal.end_block}
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-gray-500 uppercase tracking-wide">Providers</div>
                  <div className="space-y-1">
                    {selectedDeal.providers && selectedDeal.providers.length > 0 ? (
                      selectedDeal.providers.map((p) => (
                        <div key={p} className="font-mono text-[11px] text-indigo-300">
                          {p}
                        </div>
                      ))
                    ) : (
                      <span>—</span>
                    )}
                  </div>
                </div>
              </div>
              <div className="mt-3 text-[11px] text-gray-500">
                LCD detail:{' '}
                <a
                  href={`${appConfig.lcdBase}/nilchain/nilchain/v1/deals/${selectedDeal.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:text-indigo-200 underline"
                >
                  /nilchain/nilchain/v1/deals/{selectedDeal.id}
                </a>
              </div>
              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => {
                    if (!selectedDeal?.cid) return
                    const url = `${appConfig.gatewayBase}/gateway/fetch/${encodeURIComponent(selectedDeal.cid)}`
                    window.open(url, '_blank')
                  }}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-indigo-600/80 hover:bg-indigo-500 text-white rounded-md"
                >
                  <ArrowDownRight className="w-3 h-3" />
                  Download file
                </button>
              </div>
            </div>
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
