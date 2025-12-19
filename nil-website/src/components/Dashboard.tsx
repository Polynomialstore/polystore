import { useAccount, useBalance, useConnect, useDisconnect, useChainId } from 'wagmi'
import { ethToNil } from '../lib/address'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Coins, RefreshCw, Wallet, CheckCircle2, ArrowDownRight, Upload, HardDrive, Database, Cpu, ArrowUpRight } from 'lucide-react'
import { useFaucet } from '../hooks/useFaucet'
import { useCreateDeal } from '../hooks/useCreateDeal'
import { useUpdateDealContent } from '../hooks/useUpdateDealContent'
import { useUpload } from '../hooks/useUpload'
import { useProofs } from '../hooks/useProofs'
import { useNetwork } from '../hooks/useNetwork'
import { useFetch } from '../hooks/useFetch'
import { appConfig } from '../config'
import { DealDetail } from './DealDetail'
import { StatusBar } from './StatusBar'
import { FileSharder } from './FileSharder'
import { buildServiceHint } from '../lib/serviceHint'
import { injectedConnector } from '../lib/web3Config'
import { formatUnits } from 'viem'
import { lcdFetchDeals, lcdFetchParams } from '../api/lcdClient'
import type { LcdDeal as Deal, LcdParams } from '../domain/lcd'
import type { NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'
import { toHexFromBase64OrHex } from '../domain/hex'
import { useTransportRouter } from '../hooks/useTransportRouter'
import { multiaddrToHttpUrl } from '../lib/multiaddr'

interface Provider {
  address: string
  capabilities: string
  total_storage: string
  used_storage: string
  status: string
  reputation_score: string
  endpoints?: string[]
}

interface DealHeatState {
  successful_retrievals_total?: string
  bytes_served_total?: string
}

type StagedUpload = {
  cid: string
  sizeBytes: number
  fileSizeBytes: number
  allocatedLength?: number
  filename: string
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
  const [allDeals, setAllDeals] = useState<Deal[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null)
  const [nilAddress, setNilAddress] = useState('')
  const [activeTab, setActiveTab] = useState<'alloc' | 'content' | 'mdu'>('alloc')

  // Track MetaMask chain ID directly to handle Localhost caching issues where Wagmi might be stale
  const [metamaskChainId, setMetamaskChainId] = useState<number | undefined>(undefined)
  useEffect(() => {
    const getChainId = async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const eth = (window as any).ethereum
        if (eth) {
            try {
                const hex = await eth.request({ method: 'eth_chainId' })
                const parsed = typeof hex === 'string' ? parseInt(hex, 16) : NaN
                setMetamaskChainId(Number.isFinite(parsed) ? parsed : undefined)
            } catch (e) {
                console.error(e)
            }
        }
    }
    getChainId()
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eth = (window as any).ethereum
    if (eth && eth.on) {
        const handleChainChanged = (hex: string) => {
          const parsed = typeof hex === 'string' ? parseInt(hex, 16) : NaN
          setMetamaskChainId(Number.isFinite(parsed) ? parsed : undefined)
        }
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
        const raw = typeof json?.result === 'string' ? json.result : ''
        const id = raw ? parseInt(raw, 16) : NaN
        setRpcChainId(Number.isFinite(id) ? id : null)
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
  const [duration, setDuration] = useState('100')
  const [initialEscrow, setInitialEscrow] = useState('1000000')
  const [maxMonthlySpend, setMaxMonthlySpend] = useState('5000000')
  const [replication, setReplication] = useState('1')
  const [redundancyMode, setRedundancyMode] = useState<'mode1' | 'mode2'>('mode1')
  const [rsK, setRsK] = useState('8')
  const [rsM, setRsM] = useState('4')

  // Step 2: Content State
  const [targetDealId, setTargetDealId] = useState('')
  const [stagedUpload, setStagedUpload] = useState<StagedUpload | null>(null)
  const [contentFiles, setContentFiles] = useState<NilfsFileEntry[] | null>(null)
  const [contentFilesLoading, setContentFilesLoading] = useState(false)
  const [contentFilesError, setContentFilesError] = useState<string | null>(null)
  const [contentSlab, setContentSlab] = useState<SlabLayoutData | null>(null)
  const [contentSlabLoading, setContentSlabLoading] = useState(false)
  const [contentSlabError, setContentSlabError] = useState<string | null>(null)

  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [statusTone, setStatusTone] = useState<'neutral' | 'error' | 'success'>('neutral')
  const { proofs, loading: proofsLoading } = useProofs()
  const { fetchFile, loading: downloading, receiptStatus, receiptError } = useFetch()
  const { listFiles, slab } = useTransportRouter()

  const [dealHeatById, setDealHeatById] = useState<Record<string, DealHeatState>>({})
  const [retrievalSessions, setRetrievalSessions] = useState<Record<string, unknown>[]>([])
  const [retrievalSessionsLoading, setRetrievalSessionsLoading] = useState(false)
  const [retrievalSessionsError, setRetrievalSessionsError] = useState<string | null>(null)
  const [retrievalParams, setRetrievalParams] = useState<LcdParams | null>(null)
  const [retrievalParamsError, setRetrievalParamsError] = useState<string | null>(null)

  useEffect(() => {
    if (allDeals.length === 0) {
      setDealHeatById({})
      return
    }

    let cancelled = false

    async function refreshHeat() {
      const next: Record<string, DealHeatState> = {}
      await Promise.all(
        allDeals.map(async (deal) => {
          try {
            const res = await fetch(`${appConfig.lcdBase}/nilchain/nilchain/v1/deals/${encodeURIComponent(deal.id)}/heat`)
            if (!res.ok) return
            const json = await res.json().catch(() => null)
            const heat = (json as { heat?: DealHeatState } | null)?.heat
            if (!heat) return
            next[deal.id] = heat
          } catch {
            // ignore
          }
        }),
      )
      if (!cancelled) setDealHeatById(next)
    }

    refreshHeat()
    const interval = window.setInterval(refreshHeat, 2000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [allDeals])

  useEffect(() => {
    if (!nilAddress) {
      setRetrievalSessions([])
      setRetrievalSessionsError(null)
      setRetrievalSessionsLoading(false)
      return
    }

    let cancelled = false

    async function refreshSessions() {
      if (cancelled) return
      setRetrievalSessionsLoading(true)
      try {
        const url = `${appConfig.lcdBase}/nilchain/nilchain/v1/retrieval-sessions/by-owner/${encodeURIComponent(
          nilAddress,
        )}?pagination.limit=1000`
        const res = await fetch(url)
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(text || `status ${res.status}`)
        }
        const json = (await res.json().catch(() => null)) as { sessions?: unknown[] } | null
        const sessions = Array.isArray(json?.sessions) ? json!.sessions : []
        if (!cancelled) setRetrievalSessions(sessions as Record<string, unknown>[])
        if (!cancelled) setRetrievalSessionsError(null)
      } catch (e) {
        if (!cancelled) setRetrievalSessionsError(e instanceof Error ? e.message : 'Failed to fetch retrieval sessions')
      } finally {
        if (!cancelled) setRetrievalSessionsLoading(false)
      }
    }

    refreshSessions()
    const interval = window.setInterval(refreshSessions, 4000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [nilAddress])

  useEffect(() => {
    let cancelled = false

    async function refreshParams() {
      try {
        const params = await lcdFetchParams(appConfig.lcdBase)
        if (!cancelled) {
          setRetrievalParams(params)
          setRetrievalParamsError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setRetrievalParams(null)
          setRetrievalParamsError(e instanceof Error ? e.message : 'Failed to fetch retrieval params')
        }
      }
    }

    refreshParams()
    const interval = window.setInterval(refreshParams, 30000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  const retrievalCountsByDeal = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const deal of deals) {
      const heat = dealHeatById[deal.id]
      const raw = heat?.successful_retrievals_total
      counts[deal.id] = raw ? Number(raw) || 0 : 0
    }
    return counts
  }, [dealHeatById, deals])

  const targetDeal = useMemo(() => {
    if (!targetDealId) return null
    return deals.find((d) => d.id === targetDealId) || null
  }, [deals, targetDealId])

  const providerEndpointsByAddr = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const p of providers) {
      if (!p.address) continue
      const endpoints = Array.isArray(p.endpoints) ? p.endpoints : []
      map.set(p.address, endpoints.filter((e): e is string => typeof e === 'string'))
    }
    return map
  }, [providers])

  const resolveProviderBase = useCallback(
    (deal: Deal | null): string | undefined => {
      if (!deal || !deal.providers || deal.providers.length === 0) return undefined
      const primary = deal.providers[0]
      const endpoints = providerEndpointsByAddr.get(primary) ?? []
      for (const ep of endpoints) {
        if (/^https?:\/\//i.test(ep)) return ep.replace(/\/$/, '')
        const url = multiaddrToHttpUrl(ep)
        if (url) return url
      }
      return appConfig.spBase
    },
    [providerEndpointsByAddr],
  )

  const contentManifestRoot = targetDeal?.cid || ''

  useEffect(() => {
    setStagedUpload(null)
    setContentFiles(null)
    setContentFilesError(null)
    setContentFilesLoading(false)
    setContentSlab(null)
    setContentSlabError(null)
    setContentSlabLoading(false)
  }, [targetDealId])

  useEffect(() => {
    const manifestRoot = targetDeal?.cid
    const owner = nilAddress || targetDeal?.owner || ''
    if (!manifestRoot || !targetDealId || !owner) {
      setContentFiles(null)
      setContentFilesError(null)
      setContentFilesLoading(false)
      setContentSlab(null)
      setContentSlabError(null)
      setContentSlabLoading(false)
      return
    }

    let cancelled = false

    const load = async () => {
      setContentFilesLoading(true)
      setContentFilesError(null)
      setContentSlabLoading(true)
      setContentSlabError(null)
      try {
        const directBase = resolveProviderBase(targetDeal)
        const [filesResult, slabResult] = await Promise.allSettled([
          listFiles({
            manifestRoot,
            dealId: targetDealId,
            owner,
            directBase,
          }),
          slab({
            manifestRoot,
            dealId: targetDealId,
            owner,
            directBase,
          }),
        ])

        if (cancelled) return

        if (filesResult.status === 'fulfilled') {
          setContentFiles(filesResult.value.data)
        } else {
          setContentFiles([])
          setContentFilesError(filesResult.reason instanceof Error ? filesResult.reason.message : 'Failed to load NilFS file table')
        }

        if (slabResult.status === 'fulfilled') {
          setContentSlab(slabResult.value.data)
        } else {
          setContentSlab(null)
          setContentSlabError(slabResult.reason instanceof Error ? slabResult.reason.message : 'Failed to load slab layout')
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Failed to load deal content observables'
        if (!cancelled) {
          setContentFiles([])
          setContentSlab(null)
          setContentFilesError(msg)
          setContentSlabError(msg)
        }
      } finally {
        if (!cancelled) {
          setContentFilesLoading(false)
          setContentSlabLoading(false)
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [nilAddress, resolveProviderBase, targetDeal, targetDeal?.cid, targetDealId, listFiles, slab])

  useEffect(() => {
    if (address) {
      const cosmosAddress = ethToNil(address)
      setNilAddress(cosmosAddress)
      fetchDeals(cosmosAddress)
      fetchBalances(cosmosAddress)
      fetchProviders()
    } else {
        setDeals([])
        setAllDeals([])
        setProviders([])
    }
  }, [address])

  async function fetchDeals(owner?: string): Promise<Deal[]> {
    setLoading(true)
    try {
        const all = await lcdFetchDeals(appConfig.lcdBase)
        setAllDeals(all)
        let filtered = owner ? all.filter((d) => d.owner === owner) : all
        if (owner && filtered.length === 0 && all.length > 0) {
          filtered = all
        }
        setDeals(filtered)
        return filtered
    } catch (e) {
        console.error("Failed to fetch deals", e)
        setAllDeals([])
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
        const hit = bal.find((b: { denom: string; amount: string }) => b.denom === denom)
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

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let idx = 0
    let value = bytes
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024
      idx++
    }
    return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`
  }

  function parseUint64(v: unknown): bigint {
    if (typeof v === 'bigint') return v
    if (typeof v === 'number') return BigInt(Math.max(0, Math.floor(v)))
    if (typeof v === 'string') {
      const trimmed = v.trim()
      if (!trimmed) return 0n
      if (trimmed.startsWith('0x')) {
        try {
          return BigInt(trimmed)
        } catch {
          return 0n
        }
      }
      try {
        return BigInt(trimmed)
      } catch {
        return 0n
      }
    }
    return 0n
  }

  function formatBytesU64(v: unknown): string {
    const b = parseUint64(v)
    if (b <= BigInt(Number.MAX_SAFE_INTEGER)) return formatBytes(Number(b))
    return `${b.toString()} B`
  }

  function formatSessionStatus(v: unknown): string {
    if (typeof v === 'number') {
      const map: Record<number, string> = {
        0: 'UNSPECIFIED',
        1: 'OPEN',
        2: 'PROOF_SUBMITTED',
        3: 'USER_CONFIRMED',
        4: 'COMPLETED',
        5: 'EXPIRED',
        6: 'CANCELED',
      }
      return map[v] || String(v)
    }
    if (typeof v === 'string') {
      const trimmed = v.trim()
      if (!trimmed) return '—'
      return trimmed.replace('RETRIEVAL_SESSION_STATUS_', '')
    }
    return '—'
  }

  function formatCoin(coin?: { amount: string; denom: string } | null): string {
    if (!coin) return '—'
    const amount = String(coin.amount || '')
    const denom = String(coin.denom || '')
    if (!amount && !denom) return '—'
    if (!denom) return amount || '0'
    return `${amount || '0'} ${denom}`
  }

  function formatBps(value: unknown): string {
    const num = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(num)) return '—'
    return `${(num / 100).toFixed(num % 100 === 0 ? 0 : 2)}%`
  }

  const providerStatsByAddress = useMemo(() => {
    const byProvider = new Map<string, { assignedDeals: number; activeDeals: number; retrievals: number; bytesServed: number }>()

    for (const deal of allDeals) {
      for (const providerAddr of deal.providers || []) {
        const entry = byProvider.get(providerAddr) ?? {
          assignedDeals: 0,
          activeDeals: 0,
          retrievals: 0,
          bytesServed: 0,
        }
        entry.assignedDeals += 1
        if (String(deal.cid || '').trim().startsWith('0x')) entry.activeDeals += 1
        const heat = dealHeatById[deal.id]
        entry.retrievals += Number(heat?.successful_retrievals_total || 0) || 0
        entry.bytesServed += Number(heat?.bytes_served_total || 0) || 0
        byProvider.set(providerAddr, entry)
      }
    }

    return byProvider
  }, [allDeals, dealHeatById])

  const retrievalFeeNote = retrievalParams
    ? 'Base fee burned on session open. Variable fee locked until completion or cancel.'
    : 'Loading retrieval parameters...'

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !address) {
      return
    }
    if (!targetDealId) {
      setStatusTone('error')
      setStatusMsg('Select a target deal before uploading.')
      return
    }
    try {
      const dealForUpload = allDeals.find((d) => d.id === targetDealId) || deals.find((d) => d.id === targetDealId) || null
      const opts: { dealId?: string; directBase?: string } = {
        dealId: targetDealId,
        directBase: resolveProviderBase(dealForUpload),
      }

      const result = await upload(file, address, opts)
      setStagedUpload({
        cid: result.cid,
        sizeBytes: result.sizeBytes,
        fileSizeBytes: result.fileSizeBytes,
        allocatedLength: result.allocatedLength,
        filename: result.filename || file.name,
      })
      setStatusTone('neutral')
      setStatusMsg(`File uploaded and sharded. New manifest root: ${result.cid.slice(0, 16)}...`)

      // Auto-commit into the selected deal.
      await handleUpdateContent(result.cid, result.sizeBytes)
    } catch (e) {
      console.error(e)
      setStatusTone('error')
      setStatusMsg(`File upload/sharding failed: ${e instanceof Error ? e.message : String(e) || 'Check gateway logs.'}`)
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
        let serviceHint = ''
        if (redundancyMode === 'mode2') {
          const k = Number(rsK)
          const m = Number(rsM)
          if (!Number.isFinite(k) || !Number.isFinite(m) || k <= 0 || m <= 0) {
            setStatusTone('error')
            setStatusMsg('Mode 2 requires numeric K and M values.')
            return
          }
          if (64 % k !== 0) {
            setStatusTone('error')
            setStatusMsg('Mode 2 requires K to divide 64.')
            return
          }
          const n = k + m
          serviceHint = buildServiceHint('General', { replicas: n, rsK: k, rsM: m })
        } else {
          const replicas = Number(replication)
          serviceHint = buildServiceHint('General', { replicas })
        }
        const res = await submitDeal({
          creator: address || nilAddress,
          duration: Number(duration),
          initialEscrow,
          maxMonthlySpend,
          replication: Number(replication),
          serviceHint,
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

  const handleUpdateContent = async (manifestRoot: string, manifestSize: number) => {
    if (!targetDealId) { alert('Select a deal to commit into'); return }
    if (!manifestRoot) { alert('Upload a file first'); return }
    
    try {
        await submitUpdate({
            creator: address || nilAddress,
            dealId: Number(targetDealId),
            cid: manifestRoot.trim(),
            sizeBytes: manifestSize
        })
        setStatusTone('success')
        setStatusMsg(`Content committed to deal ${targetDealId}.`)
        if (nilAddress) await refreshDealsAfterContentCommit(nilAddress, targetDealId, manifestRoot.trim())
    } catch (e) {
        setStatusTone('error')
        setStatusMsg('Content commit failed. Check gateway + chain logs.')
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

  async function refreshDealsAfterContentCommit(owner: string, dealId: string, expectedCid: string) {
    const maxAttempts = 20
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const list = await fetchDeals(owner)
      const found = list.find((d) => d.id === dealId)
      if (found && String(found.cid || '').trim() === expectedCid) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  const handleMduCommitSuccess = (dealId: string, manifestRoot: string) => {
    if (!nilAddress) return
    refreshDealsAfterContentCommit(nilAddress, dealId, manifestRoot)
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
          onClick={() => connectAsync({ connector: injectedConnector })}
          data-testid="connect-wallet"
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
                    data-testid="faucet-request"
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
                    <div className="font-mono text-primary bg-primary/5 px-3 py-1 rounded text-sm border border-primary/10" data-testid="cosmos-identity">
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
                <div className="text-muted-foreground uppercase tracking-wide">EVM (NIL)</div>
                <div className="font-mono text-green-600 dark:text-green-400">
                  {(() => {
                    if (!evmBalance) return '—'
                    const symbol = evmBalance.symbol || 'NIL'
                    const formatted = formatUnits(evmBalance.value, evmBalance.decimals)
                    const [whole, frac] = formatted.split('.')
                    const trimmed = frac ? `${whole}.${frac.slice(0, 4)}` : whole
                    return `${trimmed} ${symbol}`
                  })()}
                </div>
              </div>
              <div className="bg-secondary/50 border border-border rounded p-2">
                <div className="text-muted-foreground uppercase tracking-wide">Cosmos stake</div>
                <div className="font-mono text-blue-600 dark:text-blue-400" data-testid="cosmos-stake-balance">
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
                data-testid="tab-alloc"
                className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'alloc' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}
              >
                  <HardDrive className="w-4 h-4" />
                  1. Alloc Capacity
              </button>
              <button 
                onClick={() => setActiveTab('content')}
                data-testid="tab-content"
                className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'content' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}
              >
                  <Database className="w-4 h-4" />
                  2. Commit Content
              </button>
              <button 
                onClick={() => setActiveTab('mdu')}
                data-testid="tab-mdu"
                className={`flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 transition-colors ${activeTab === 'mdu' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'}`}
              >
                  <Cpu className="w-4 h-4" />
                  Local MDU (WASM)
              </button>
          </div>

          <div className="p-6 flex-1">
            {activeTab === 'alloc' ? (
                <div className="space-y-4">
                    <p className="text-xs text-muted-foreground">Reserve storage space on the network by creating a "Container".</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Duration (blocks)</span>
                            <input
                              defaultValue={duration ?? ''}
                              onChange={(e) => setDuration(e.target.value ?? '')}
                              data-testid="alloc-duration"
                              className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                            />
                        </label>
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Initial Escrow</span>
                            <input
                              defaultValue={initialEscrow ?? ''}
                              onChange={(e) => setInitialEscrow(e.target.value ?? '')}
                              data-testid="alloc-initial-escrow"
                              className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                            />
                        </label>
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Max Monthly Spend</span>
                            <input
                              defaultValue={maxMonthlySpend ?? ''}
                              onChange={(e) => setMaxMonthlySpend(e.target.value ?? '')}
                              data-testid="alloc-max-monthly-spend"
                              className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                            />
                        </label>
                        <label className="space-y-1">
                            <span className="text-xs uppercase tracking-wide text-muted-foreground">Redundancy Mode</span>
                            <select
                                defaultValue={redundancyMode || 'mode1'}
                                onChange={(e) =>
                                  setRedundancyMode((e.target.value as 'mode1' | 'mode2') || 'mode1')
                                }
                                data-testid="alloc-redundancy-mode"
                                className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                            >
                                <option value="mode1">Mode 1: Full Replica</option>
                                <option value="mode2">Mode 2: StripeReplica (RS)</option>
                            </select>
                        </label>
                        {redundancyMode === 'mode1' ? (
                          <label className="space-y-1">
                              <span className="text-xs uppercase tracking-wide text-muted-foreground">Replication</span>
                              <input
                                  type="number"
                                  min={1}
                                  max={12}
                                  defaultValue={replication ?? ''}
                                  onChange={e => setReplication(e.target.value ?? '')}
                                  data-testid="alloc-replication"
                                  className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                              />
                          </label>
                        ) : (
                          <div className="grid grid-cols-2 gap-3">
                              <label className="space-y-1">
                                  <span className="text-xs uppercase tracking-wide text-muted-foreground">RS K (Data)</span>
                                  <input
                                      type="number"
                                      min={1}
                                      max={64}
                                      defaultValue={rsK ?? ''}
                                      onChange={e => setRsK(e.target.value ?? '')}
                                      data-testid="alloc-rs-k"
                                      className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                                  />
                              </label>
                              <label className="space-y-1">
                                  <span className="text-xs uppercase tracking-wide text-muted-foreground">RS M (Parity)</span>
                                  <input
                                      type="number"
                                      min={1}
                                      max={64}
                                      defaultValue={rsM ?? ''}
                                      onChange={e => setRsM(e.target.value ?? '')}
                                      data-testid="alloc-rs-m"
                                      className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                                  />
                              </label>
                          </div>
                        )}
                    </div>
                    <div className="flex items-center justify-between pt-2">
                        <div className="text-xs text-muted-foreground">
                            {createTx && <div className="text-green-600 dark:text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Alloc Tx: {createTx.slice(0,10)}...</div>}
                        </div>
                        <button
                            onClick={handleCreateDeal}
                            disabled={dealLoading}
                            data-testid="alloc-submit"
                            className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-md disabled:opacity-50 transition-colors"
                        >
                            {dealLoading ? 'Allocating...' : 'Allocate'}
                        </button>
                    </div>
                </div>
              ) : activeTab === 'content' ? (
                  <div className="space-y-4">
                      <p className="text-xs text-muted-foreground">Upload a file and commit its cryptographic hash to your deal.</p>
                      <div className="grid grid-cols-1 gap-3 text-sm">
                          <label className="space-y-1">
                              <span className="text-xs uppercase tracking-wide text-muted-foreground">Target Deal ID</span>
                              <select 
                                  value={targetDealId ?? ''} 
                                  onChange={e => setTargetDealId(String(e.target.value ?? ''))}
                                  data-testid="content-deal-select"
                                  className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                              >
                                  <option value="">Select a Deal...</option>
                                  {deals.filter(d => d.owner === nilAddress).map(d => (
                                      <option key={d.id} value={d.id}>
                                        Deal #{d.id} ({d.cid ? 'Active' : 'Empty'})
                                      </option>
                                  ))}
                              </select>
                          </label>
                          {targetDealId && (
                            <div className="text-xs text-muted-foreground">
                              On-chain:{" "}
                              {targetDeal?.cid ? (
                                <span className="font-mono text-primary">{`${targetDeal.cid.slice(0, 18)}...`}</span>
                              ) : (
                                <span className="italic">Empty container</span>
                              )}{" "}
                              • Size: <span className="font-mono text-foreground">{targetDeal?.size ?? '0'}</span>
                            </div>
                          )}
                          <label className="space-y-1">
                              <span className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                                  <Upload className="w-3 h-3 text-primary" />
                                  Upload & Shard (gateway)
                              </span>
                              <input
                                  type="file"
                                  onChange={handleFileChange}
                                  disabled={uploadLoading || !targetDealId}
                                  data-testid="content-file-input"
                                  className="w-full text-xs text-muted-foreground file:mr-2 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-primary file:text-primary-foreground hover:file:bg-primary/90 file:cursor-pointer cursor-pointer"
                              />
                          </label>
                          <div className="grid grid-cols-2 gap-3">
                              <div className="space-y-1">
                                  <span className="text-xs uppercase tracking-wide text-muted-foreground">Staged Manifest Root</span>
                                  <div
                                    className="w-full bg-secondary border border-border rounded px-3 py-2 text-foreground text-sm font-mono text-xs min-h-[40px] flex items-center"
                                    data-testid="staged-manifest-root"
                                  >
                                    {stagedUpload?.cid ? stagedUpload.cid : <span className="text-muted-foreground">Upload a file to populate</span>}
                                  </div>
                              </div>
                              <div className="space-y-1">
                                  <span className="text-xs uppercase tracking-wide text-muted-foreground">Staged Total Size (bytes)</span>
                                  <div
                                    className="w-full bg-secondary border border-border rounded px-3 py-2 text-foreground text-sm font-mono text-xs min-h-[40px] flex items-center"
                                    data-testid="staged-total-size"
                                  >
                                    {stagedUpload?.sizeBytes ? String(stagedUpload.sizeBytes) : <span className="text-muted-foreground">Upload a file</span>}
                                  </div>
                              </div>
                          </div>
                          {stagedUpload && (
                            <div className="text-xs text-muted-foreground">
                              Last upload: <span className="font-semibold text-foreground">{stagedUpload.filename}</span> • File size:{' '}
                              <span className="font-mono text-foreground">{stagedUpload.fileSizeBytes}</span>
                              {stagedUpload.allocatedLength !== undefined && (
                                <>
                                  {' '}
                                  • Allocated MDUs: <span className="font-mono text-foreground">{stagedUpload.allocatedLength}</span>
                                </>
                              )}
                            </div>
                          )}

                          {targetDealId && contentManifestRoot && (
                            <div className="rounded-md border border-border bg-secondary/40 p-3 space-y-2">
                              <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
                                Slab Layout
                              </div>
                              {contentSlabLoading ? (
                                <div className="text-xs text-muted-foreground">Loading slab layout…</div>
                              ) : contentSlab ? (
                                <>
                                  <div className="grid grid-cols-2 gap-3 text-xs">
                                    <div className="bg-background/60 border border-border rounded px-3 py-2">
                                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Total MDUs</div>
                                      <div className="font-mono text-foreground">{contentSlab.total_mdus}</div>
                                      <div className="text-[10px] text-muted-foreground mt-1">
                                        MDU #0 + {contentSlab.witness_mdus} witness + {contentSlab.user_mdus} user
                                      </div>
                                    </div>
                                    <div className="bg-background/60 border border-border rounded px-3 py-2">
                                      <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Files</div>
                                      <div className="font-mono text-foreground">{contentSlab.file_count}</div>
                                      <div className="text-[10px] text-muted-foreground mt-1">
                                        {contentSlab.total_size_bytes} bytes total
                                      </div>
                                    </div>
                                  </div>

                                  {Array.isArray(contentSlab.segments) && contentSlab.segments.length > 0 && (
                                    <div className="bg-background/60 border border-border rounded px-3 py-2">
                                      <div className="flex items-center justify-between">
                                        <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
                                          MDU Segments
                                        </div>
                                        <div className="text-[10px] text-muted-foreground">
                                          {(() => {
                                            const mduSize = Number(contentSlab.mdu_size_bytes)
                                            if (!Number.isFinite(mduSize) || mduSize <= 0) return '—'
                                            return `${Math.round(mduSize / (1024 * 1024))} MiB / MDU`
                                          })()}
                                        </div>
                                      </div>
                                      <div className="mt-2 flex h-2 w-full overflow-hidden rounded bg-muted">
                                        {contentSlab.segments.map((seg) => {
                                          const segCount = Number(seg.count)
                                          const safeCount = Number.isFinite(segCount) && segCount > 0 ? segCount : 1
                                          return (
                                            <div
                                              key={`${seg.kind}:${seg.start_index}`}
                                              style={{ flexGrow: Math.max(1, safeCount) }}
                                              className={
                                                seg.kind === 'mdu0'
                                                  ? 'bg-blue-500/60'
                                                  : seg.kind === 'witness'
                                                    ? 'bg-purple-500/60'
                                                    : 'bg-emerald-500/60'
                                              }
                                              title={`${seg.kind} • start=${seg.start_index} • count=${seg.count}`}
                                            />
                                          )
                                        })}
                                      </div>
                                      <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
                                        <div>
                                          <span className="text-blue-500 font-semibold">MDU #0</span>: Super-Manifest
                                        </div>
                                        <div>
                                          <span className="text-purple-500 font-semibold">Witness</span>:{' '}
                                          {contentSlab.witness_mdus > 0 ? `MDU #1..#${contentSlab.witness_mdus}` : 'none'}
                                        </div>
                                        <div>
                                          <span className="text-emerald-500 font-semibold">User</span>:{' '}
                                          {contentSlab.user_mdus > 0
                                            ? `MDU #${1 + contentSlab.witness_mdus}..#${contentSlab.total_mdus - 1}`
                                            : 'none'}
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </>
                              ) : (
                                <div className="text-xs text-muted-foreground italic">
                                  No slab layout found for this manifest.
                                </div>
                              )}
                              {contentSlabError && (
                                <div className="text-xs text-destructive truncate" title={contentSlabError}>
                                  {contentSlabError}
                                </div>
                              )}
                            </div>
                          )}

                          {targetDealId && contentManifestRoot && (
                            <div className="rounded-md border border-border bg-secondary/40 p-3 space-y-2">
                              <div className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
                                Files In Slab
                              </div>
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
                              {contentFilesLoading ? (
                                <div className="text-xs text-muted-foreground">Loading file table…</div>
                              ) : contentFiles && contentFiles.length > 0 ? (
                                <div className="space-y-2">
                                  {contentFiles.map((f) => {
                                    return (
                                      <div
                                        key={`${f.path}:${f.start_offset}`}
                                        className="flex items-center justify-between gap-3 bg-background/60 border border-border rounded px-3 py-2"
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
                                          onClick={async () => {
                                            const result = await fetchFile({
                                              dealId: String(targetDealId),
                                              manifestRoot: contentManifestRoot,
                                              owner: nilAddress,
                                              filePath: f.path,
                                              rangeStart: 0,
                                              rangeLen: f.size_bytes,
                                              fileStartOffset: f.start_offset,
                                              fileSizeBytes: f.size_bytes,
                                              mduSizeBytes: contentSlab?.mdu_size_bytes ?? 8 * 1024 * 1024,
                                              blobSizeBytes: contentSlab?.blob_size_bytes ?? 128 * 1024,
                                            })
                                            if (result?.url) {
                                              const a = document.createElement('a')
                                              a.href = result.url
                                              a.download = f.path.split('/').pop() || 'download'
                                              a.click()
                                              setTimeout(() => window.URL.revokeObjectURL(result.url), 1000)
                                            }
                                            }}
                                          disabled={downloading}
                                          className="shrink-0 inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-md transition-colors disabled:opacity-50"
                                        >
                                          <ArrowDownRight className="w-4 h-4" />
                                          {downloading ? 'Downloading...' : 'Download'}
                                        </button>
                                      </div>
                                    )
                                  })}
                                </div>
                              ) : (
                                <div className="text-xs text-muted-foreground italic">
                                  No files yet for this manifest.
                                </div>
                              )}
                              {contentFilesError && (
                                <div className="text-xs text-destructive truncate" title={contentFilesError}>
                                  {contentFilesError}
                                </div>
                              )}
                            </div>
                          )}
                      </div>
                      <div className="flex items-center justify-between pt-2">
                          <div className="text-xs text-muted-foreground">
                              {updateTx && <div className="text-green-600 dark:text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Commit Tx: {updateTx.slice(0,10)}...</div>}
                          </div>
                          <button
                              onClick={() => stagedUpload && handleUpdateContent(stagedUpload.cid, stagedUpload.sizeBytes)}
                              disabled={updateLoading || !stagedUpload || !targetDealId}
                              data-testid="content-commit"
                              className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-md disabled:opacity-50 transition-colors"
                          >
                              {updateLoading ? 'Committing...' : 'Commit uploaded content'}
                          </button>
                      </div>
                  </div>
              ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">Run the Rust WASM sharder locally to produce MDUs and commitments before sending to the gateway.</p>
                  <div className="text-[11px] text-muted-foreground bg-secondary/60 px-2 py-1 rounded-md flex items-center gap-1">
                    <ArrowUpRight className="w-3 h-3" /> Offloads heavy work to your browser.
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 text-sm">
                    <label className="space-y-1">
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">Target Deal ID</span>
                        <select 
                            value={targetDealId ?? ''} 
                            onChange={e => setTargetDealId(String(e.target.value ?? ''))}
                            data-testid="mdu-deal-select"
                            className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                        >
                            <option value="">Select a Deal...</option>
                            {deals.filter(d => d.owner === nilAddress).map(d => (
                                <option key={d.id} value={d.id}>
                                  Deal #{d.id} ({d.cid ? 'Active' : 'Empty'})
                                </option>
                            ))}
                        </select>
                    </label>
                </div>

                {targetDealId ? (
                    <FileSharder dealId={targetDealId} onCommitSuccess={handleMduCommitSuccess} />
                ) : (
                    <div className="p-8 text-center border border-dashed border-border rounded-xl">
                        <p className="text-muted-foreground text-sm">Select a deal to begin client-side sharding.</p>
                    </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="px-6 py-3 border-b border-border bg-muted/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Providers (Deals &amp; Retrievals)
        </div>
        <table className="min-w-full divide-y divide-border text-xs" data-testid="providers-table">
          <thead className="bg-muted/30">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Address</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Capabilities</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Endpoints</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground uppercase tracking-wider">Deals</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground uppercase tracking-wider">Active</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground uppercase tracking-wider">Retrievals</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground uppercase tracking-wider">Bytes Served</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground uppercase tracking-wider">Total Storage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {providers.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-6 py-6 text-sm text-muted-foreground">
                  No providers found.
                </td>
              </tr>
            ) : (
              providers.map((p) => {
                const stats = providerStatsByAddress.get(p.address) ?? {
                  assignedDeals: 0,
                  activeDeals: 0,
                  retrievals: 0,
                  bytesServed: 0,
                }
                return (
                  <tr key={p.address} className="hover:bg-muted/50 transition-colors">
                    <td className="px-4 py-2 font-mono text-[11px] text-primary" title={p.address}>
                      {p.address.slice(0, 12)}...{p.address.slice(-6)}
                    </td>
                    <td className="px-4 py-2 text-foreground">{p.capabilities}</td>
                    <td className="px-4 py-2">
                      <span className="px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        {p.status}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground">
                      {Array.isArray(p.endpoints) && p.endpoints.length > 0 ? (
                        <span title={p.endpoints.join('\n')}>{p.endpoints[0]}</span>
                      ) : (
                        <span className="italic">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{stats.assignedDeals}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{stats.activeDeals}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{stats.retrievals}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{formatBytes(stats.bytesServed)}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">
                      {(() => {
                        const totalStorage = Number(p.total_storage)
                        if (!Number.isFinite(totalStorage) || totalStorage <= 0) return '—'
                        return `${(totalStorage / (1024 ** 4)).toFixed(2)} TiB`
                      })()}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="px-6 py-3 border-b border-border bg-muted/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Retrieval Fees (Gamma-4)
        </div>
        <div className="px-6 py-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Base Fee</div>
            <div className="text-sm text-foreground">{formatCoin(retrievalParams?.base_retrieval_fee)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Per-Blob Fee</div>
            <div className="text-sm text-foreground">{formatCoin(retrievalParams?.retrieval_price_per_blob)}</div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Burn Cut</div>
            <div className="text-sm text-foreground">{formatBps(retrievalParams?.retrieval_burn_bps)}</div>
          </div>
        </div>
        <div className="px-6 pb-4 text-xs text-muted-foreground">
          {retrievalFeeNote}
          {retrievalParamsError ? (
            <span className="block mt-1 text-[11px] text-red-500/80">{retrievalParamsError}</span>
          ) : null}
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="px-6 py-3 border-b border-border bg-muted/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          My Retrieval Sessions
        </div>
        <table className="min-w-full divide-y divide-border text-xs" data-testid="retrieval-sessions-table">
          <thead className="bg-muted/30">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Session</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground uppercase tracking-wider">Deal</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Provider</th>
              <th className="px-4 py-2 text-left font-medium text-muted-foreground uppercase tracking-wider">Status</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground uppercase tracking-wider">Total Bytes</th>
              <th className="px-4 py-2 text-right font-medium text-muted-foreground uppercase tracking-wider">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {!nilAddress ? (
              <tr>
                <td colSpan={6} className="px-6 py-6 text-sm text-muted-foreground">
                  Connect a wallet to view retrieval sessions.
                </td>
              </tr>
            ) : retrievalSessionsLoading ? (
              <tr>
                <td colSpan={6} className="px-6 py-6 text-sm text-muted-foreground">
                  Loading sessions…
                </td>
              </tr>
            ) : retrievalSessions.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-6 text-sm text-muted-foreground">
                  No retrieval sessions found.
                  {retrievalSessionsError ? (
                    <span className="block mt-1 text-[11px] text-red-500/80">{retrievalSessionsError}</span>
                  ) : null}
                </td>
              </tr>
            ) : (
              retrievalSessions.map((raw) => {
                const s = raw as Record<string, unknown>
                const dealId = String(s['deal_id'] ?? '')
                const provider = String(s['provider'] ?? '')
                const status = formatSessionStatus(s['status'])
                const updatedHeight = String(s['updated_height'] ?? '')
                const totalBytes = formatBytesU64(s['total_bytes'])
                const sessionHex = toHexFromBase64OrHex(s['session_id'], { expectedBytes: [32] })
                const shortSession = sessionHex ? `${sessionHex.slice(0, 12)}…${sessionHex.slice(-6)}` : '—'
                return (
                  <tr key={`${dealId}-${provider}-${updatedHeight}-${shortSession}`} className="hover:bg-muted/50 transition-colors">
                    <td className="px-4 py-2 font-mono text-[11px] text-primary" title={sessionHex || undefined}>
                      {shortSession}
                    </td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{dealId || '—'}</td>
                    <td className="px-4 py-2 font-mono text-[11px] text-muted-foreground" title={provider || undefined}>
                      {provider ? `${provider.slice(0, 12)}…${provider.slice(-6)}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{status}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{totalBytes}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{updatedHeight || '—'}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
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
              <table className="min-w-full divide-y divide-border" data-testid="deals-table">
                  <thead className="bg-muted/50">
                      <tr>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Deal ID</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Manifest Root</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Size</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Provider</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Retrievals</th>
                          <th className="px-6 py-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
                      </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                      {deals.map((deal) => (
                      <tr
                        key={deal.id}
                        data-testid={`deal-row-${deal.id}`}
                        className="hover:bg-muted/50 transition-colors cursor-pointer"
                        onClick={() => setSelectedDeal(deal)}
                      >
                              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-foreground">#{deal.id}</td>
                              <td
                                className="px-6 py-4 whitespace-nowrap text-sm font-mono text-primary"
                                title={deal.cid}
                                data-testid={`deal-manifest-${deal.id}`}
                              >
                                {deal.cid ? `${deal.cid.slice(0, 18)}...` : <span className="text-muted-foreground italic">Empty</span>}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground" data-testid={`deal-size-${deal.id}`}>
                                {(() => {
                                  const sizeNum = Number(deal.size)
                                  if (!Number.isFinite(sizeNum) || sizeNum <= 0) return '—'
                                  return `${(sizeNum / 1024 / 1024).toFixed(2)} MB`
                                })()}
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
                              <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-muted-foreground">
                                {deal.providers && deal.providers.length > 0 ? `${deal.providers[0].slice(0, 10)}...${deal.providers[0].slice(-4)}` : '—'}
                              </td>
                              <td
                                className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground"
                                data-testid={`deal-retrievals-${deal.id}`}
                              >
                                {retrievalCountsByDeal[deal.id] !== undefined ? retrievalCountsByDeal[deal.id] : 0}
                              </td>
                              <td className="px-6 py-4 whitespace-nowrap text-sm">
                                <button
                                  onClick={(e) => { e.stopPropagation(); setTargetDealId(String(deal.id ?? '')); setActiveTab('content'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                                  className="px-3 py-1.5 text-xs rounded-md border border-primary/30 text-primary hover:bg-primary/10"
                                >
                                  Upload to deal
                                </button>
                              </td>
                      </tr>
                      ))}
                  </tbody>
              </table>
          </div>

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
