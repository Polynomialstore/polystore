import { useAccount, useBalance, useConnect, useDisconnect, useChainId } from 'wagmi'
import { ethToNil } from '../lib/address'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Coins, RefreshCw, Wallet, CheckCircle2, ArrowDownRight, Upload, HardDrive, Database, Cpu } from 'lucide-react'
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
import { buildServiceHint, parseServiceHint } from '../lib/serviceHint'
import { injectedConnector } from '../lib/web3Config'
import { formatUnits } from 'viem'
import { lcdFetchDeals, lcdFetchParams } from '../api/lcdClient'
import type { LcdDeal as Deal, LcdParams } from '../domain/lcd'
import type { NilfsFileEntry, SlabLayoutData } from '../domain/nilfs'
import { toHexFromBase64OrHex } from '../domain/hex'
import { useTransportRouter } from '../hooks/useTransportRouter'
import { multiaddrToHttpUrl, multiaddrToP2pTarget } from '../lib/multiaddr'

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

type RecentFileEntry = {
  id: string
  dealId: string
  filePath: string
  sizeBytes: number
  manifestRoot: string
  updatedAt: number
  lastAction: 'upload' | 'download'
  status: 'pending' | 'success' | 'failed'
  error?: string
}

const RECENT_FILES_KEY = 'nil_recent_files_v1'
const MAX_RECENT_FILES = 6

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
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [bankBalances, setBankBalances] = useState<{ atom?: string; stake?: string }>({})
  const { data: evmBalance, refetch: refetchEvm } = useBalance({
    address,
    chainId: appConfig.chainId,
  })
  const providerCount = providers.length

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
  const [redundancyMode, setRedundancyMode] = useState<'mode1' | 'mode2'>('mode2')
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
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([])
  const [recentDownloadId, setRecentDownloadId] = useState<string | null>(null)
  const [downloadToast, setDownloadToast] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const dealDetailRef = useRef<HTMLDivElement | null>(null)
  const [pendingScrollTarget, setPendingScrollTarget] = useState<'workspace' | 'deal' | null>(null)
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

  const dealSummary = useMemo(() => {
    let active = 0
    let totalBytes = 0
    for (const deal of deals) {
      if (String(deal.cid || '').trim()) active += 1
      const sizeNum = Number(deal.size)
      if (Number.isFinite(sizeNum) && sizeNum > 0) totalBytes += sizeNum
    }
    const retrievals = Object.values(retrievalCountsByDeal).reduce((sum, count) => sum + (Number(count) || 0), 0)
    return {
      total: deals.length,
      active,
      allocated: Math.max(0, deals.length - active),
      totalBytes,
      retrievals,
    }
  }, [deals, retrievalCountsByDeal])

  const ownedDeals = useMemo(
    () => (nilAddress ? deals.filter((deal) => deal.owner === nilAddress) : deals),
    [deals, nilAddress],
  )
  const hasWallet = Boolean(nilAddress)
  const hasFunds =
    parseUint64(bankBalances.stake) > 0n ||
    parseUint64(bankBalances.atom) > 0n
  const hasAnyDeals = ownedDeals.length > 0
  const hasAnyContent = ownedDeals.some((deal) => String(deal.cid || '').trim())
  const hasRetrieval = dealSummary.retrievals > 0 || receiptStatus === 'submitted'
  const wizardDeal = useMemo(
    () => ownedDeals.find((deal) => String(deal.cid || '').trim()) || ownedDeals[ownedDeals.length - 1] || null,
    [ownedDeals],
  )
  const wizardUploadTab = useMemo(() => {
    const hint = parseServiceHint(wizardDeal?.service_hint)
    return hint.mode === 'mode2' ? 'mdu' : 'content'
  }, [wizardDeal?.service_hint])
  const wizardSteps = useMemo(
    () => [
      {
        id: 'connect',
        label: 'Connect wallet',
        hint: 'Link MetaMask to NilChain',
        done: hasWallet,
        actionLabel: 'Connect',
      },
      {
        id: 'fund',
        label: 'Fund with test NIL',
        hint: 'Request faucet funds',
        done: hasFunds,
        actionLabel: 'Request',
      },
      {
        id: 'deal',
        label: 'Create a deal',
        hint: 'Allocate a storage bucket',
        done: hasAnyDeals,
        actionLabel: 'Create',
      },
      {
        id: 'upload',
        label: 'Upload your first file',
        hint: 'Use Mode 2 upload flow',
        done: hasAnyContent,
        actionLabel: 'Upload',
      },
      {
        id: 'retrieve',
        label: 'Download and verify',
        hint: 'Pull file from providers',
        done: hasRetrieval,
        actionLabel: 'Download',
      },
    ],
    [hasAnyContent, hasAnyDeals, hasFunds, hasRetrieval, hasWallet],
  )
  const wizardNext = wizardSteps.find((step) => !step.done) || null
  const targetDeal = useMemo(() => {
    if (!targetDealId) return null
    return deals.find((d) => d.id === targetDealId) || null
  }, [deals, targetDealId])
  const targetDealService = useMemo(
    () => parseServiceHint(targetDeal?.service_hint),
    [targetDeal?.service_hint],
  )
  const isTargetDealMode2 = targetDealService.mode === 'mode2'
  const hasSelectedDeal = Boolean(targetDealId)
  const hasCommittedContent = Boolean(targetDeal?.cid)
  const activeDealStatus = hasCommittedContent ? 'Active' : hasSelectedDeal ? 'Allocated' : '—'
  const activeDealModeLabel = hasSelectedDeal ? (isTargetDealMode2 ? 'Mode 2' : 'Mode 1') : '—'

  useEffect(() => {
    if (hasSelectedDeal && !isTargetDealMode2) {
      setShowAdvanced(true)
    }
  }, [hasSelectedDeal, isTargetDealMode2])

  useEffect(() => {
    if (!showAdvanced && redundancyMode !== 'mode2') {
      setRedundancyMode('mode2')
    }
  }, [redundancyMode, showAdvanced])

  useEffect(() => {
    if (targetDealId) return
    if (!nilAddress) return
    if (ownedDeals.length !== 1) return
    const onlyDeal = ownedDeals[0]
    if (!onlyDeal?.id) return
    setTargetDealId(String(onlyDeal.id))
    setSelectedDeal(onlyDeal)
  }, [nilAddress, ownedDeals, targetDealId])
  const mode2Config = useMemo(() => {
    if (redundancyMode !== 'mode2') return { slots: null as number | null, error: null as string | null }
    const k = Number(rsK)
    const m = Number(rsM)
    if (!Number.isFinite(k) || !Number.isFinite(m) || k <= 0 || m <= 0) {
      return { slots: null, error: 'Enter numeric K and M values.' }
    }
    const slots = k + m
    if (64 % k !== 0) {
      return { slots, error: 'K must divide 64.' }
    }
    if (providerCount > 0 && slots > providerCount) {
      return { slots, error: `Need ${slots} providers (K+M); only ${providerCount} available.` }
    }
    return { slots, error: null }
  }, [providerCount, redundancyMode, rsK, rsM])

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

  const resolveProviderP2pTarget = useCallback(
    (deal: Deal | null) => {
      if (!deal || !deal.providers || deal.providers.length === 0) return undefined
      const primary = deal.providers[0]
      const endpoints = providerEndpointsByAddr.get(primary) ?? []
      for (const ep of endpoints) {
        const target = multiaddrToP2pTarget(ep)
        if (target) return target
      }
      return undefined
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
        const p2pTarget = appConfig.p2pEnabled ? resolveProviderP2pTarget(targetDeal) : undefined
        const [filesResult, slabResult] = await Promise.allSettled([
          listFiles({
            manifestRoot,
            dealId: targetDealId,
            owner,
            directBase,
            p2pTarget,
          }),
          slab({
            manifestRoot,
            dealId: targetDealId,
            owner,
            directBase,
            p2pTarget,
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
  }, [nilAddress, resolveProviderBase, resolveProviderP2pTarget, targetDeal, targetDeal?.cid, targetDealId, listFiles, slab])

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

  // Keep the open Deal Explorer panel in sync with deal list refreshes.
  useEffect(() => {
    if (!selectedDeal) return
    const selectedId = String(selectedDeal.id ?? '').trim()
    if (!selectedId) return
    const updated =
      deals.find((d) => String(d.id) === selectedId) ||
      allDeals.find((d) => String(d.id) === selectedId) ||
      null
    if (updated && updated !== selectedDeal) {
      setSelectedDeal(updated)
    }
  }, [allDeals, deals, selectedDeal])

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

  async function fetchBalances(owner: string): Promise<{ atom?: string; stake?: string } | null> {
    try {
      const res = await fetch(`${appConfig.lcdBase}/cosmos/bank/v1beta1/balances/${owner}`)
      const json = await res.json()
      const bal = Array.isArray(json?.balances) ? json.balances : []
      const getAmt = (denom: string) => {
        const hit = bal.find((b: { denom: string; amount: string }) => b.denom === denom)
        return hit ? hit.amount : undefined
      }
      const next = {
        atom: getAmt('aatom'),
        stake: getAmt('stake'),
      }
      setBankBalances(next)
      return next
    } catch (e) {
      console.error('fetchBalances failed', e)
    }
    return null
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

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(RECENT_FILES_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const sanitized = parsed
          .filter((entry) => entry && typeof entry === 'object')
          .map((entry) => {
            const lastAction: 'download' | 'upload' = entry.lastAction === 'download' ? 'download' : 'upload'
            const status: 'pending' | 'success' | 'failed' =
              entry.status === 'failed' ? 'failed' : entry.status === 'pending' ? 'pending' : 'success'
            return {
              id: String(entry.id ?? ''),
              dealId: String(entry.dealId ?? ''),
              filePath: String(entry.filePath ?? ''),
              sizeBytes: Number(entry.sizeBytes ?? 0) || 0,
              manifestRoot: String(entry.manifestRoot ?? ''),
              updatedAt: Number(entry.updatedAt ?? 0) || 0,
              lastAction,
              status,
              error: entry.error ? String(entry.error) : undefined,
            }
          })
          .filter((entry) => entry.id && entry.dealId && entry.filePath)
        if (sanitized.length > 0) setRecentFiles(sanitized.slice(0, MAX_RECENT_FILES))
      }
    } catch (e) {
      console.warn('Failed to load recent files', e)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(recentFiles))
    } catch (e) {
      console.warn('Failed to persist recent files', e)
    }
  }, [recentFiles])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!pendingScrollTarget) return
    const ref = pendingScrollTarget === 'workspace' ? workspaceRef : dealDetailRef
    if (!ref.current) return
    ref.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setPendingScrollTarget(null)
  }, [pendingScrollTarget, activeTab, selectedDeal])

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

  function formatRelativeTime(ts: number): string {
    if (!Number.isFinite(ts) || ts <= 0) return 'just now'
    const diff = Math.max(0, Date.now() - ts)
    if (diff < 60_000) return 'just now'
    const mins = Math.floor(diff / 60_000)
    if (mins < 60) return `${mins}m ago`
    const hours = Math.floor(mins / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return `${days}d ago`
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

  const upsertRecentFile = useCallback((entry: Omit<RecentFileEntry, 'id' | 'updatedAt'>) => {
    const id = `${entry.dealId}:${entry.filePath}`
    setRecentFiles((prev) => {
      const existing = prev.find((item) => item.id === id)
      const next: RecentFileEntry = {
        id,
        dealId: entry.dealId,
        filePath: entry.filePath,
        sizeBytes: entry.sizeBytes,
        manifestRoot: entry.manifestRoot,
        updatedAt: Date.now(),
        lastAction: entry.lastAction,
        status: entry.status,
        error: entry.error,
      }
      const merged = { ...existing, ...next }
      return [merged, ...prev.filter((item) => item.id !== id)].slice(0, MAX_RECENT_FILES)
    })
  }, [])

  const updateRecentFile = useCallback((id: string, patch: Partial<RecentFileEntry>) => {
    setRecentFiles((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item)),
    )
  }, [])

  const showDownloadToast = useCallback((filePath: string) => {
    const fileName = filePath.split('/').pop() || filePath
    setDownloadToast(`${fileName} saved to Downloads`)
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current)
    }
    toastTimerRef.current = window.setTimeout(() => {
      setDownloadToast(null)
    }, 2200)
  }, [])

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
          if (nilAddress) {
            setStatusMsg('Faucet requested. Waiting for balance...')
            await waitForStakeBalance(nilAddress)
          }
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
          const slots = k + m
          if (providerCount === 0) {
            setStatusTone('error')
            setStatusMsg('Provider list not loaded yet. Retry in a few seconds.')
            return
          }
          if (slots > providerCount) {
            setStatusTone('error')
            setStatusMsg(`Mode 2 requires ${slots} providers (K+M), but only ${providerCount} are available.`)
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
          setActiveTab(redundancyMode === 'mode2' ? 'mdu' : 'content')
        }
      } catch (e) {
        setStatusTone('error')
        setStatusMsg('Deal allocation failed. Check gateway logs.')
      }
  }

  const handleUpdateContent = async (manifestRoot: string, manifestSize: number): Promise<boolean> => {
    if (!targetDealId) { alert('Select a deal to commit into'); return false }
    if (!manifestRoot) { alert('Upload a file first'); return false }

    const trimmedRoot = manifestRoot.trim()
    const manifestHex = toHexFromBase64OrHex(trimmedRoot) || trimmedRoot
    const recordUpload = (status: 'success' | 'failed', error?: string) => {
      if (!stagedUpload?.filename) return
      upsertRecentFile({
        dealId: targetDealId,
        filePath: stagedUpload.filename,
        sizeBytes: stagedUpload.fileSizeBytes || stagedUpload.sizeBytes || manifestSize || 0,
        manifestRoot: manifestHex,
        lastAction: 'upload',
        status,
        error,
      })
    }

    try {
        await submitUpdate({
            creator: address || nilAddress,
            dealId: Number(targetDealId),
            cid: trimmedRoot,
            sizeBytes: manifestSize
        })
        setStatusTone('success')
        setStatusMsg(`Content committed to deal ${targetDealId}.`)
        if (nilAddress) await refreshDealsAfterContentCommit(nilAddress, targetDealId, trimmedRoot)
        recordUpload('success')
        return true
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setStatusTone('error')
        setStatusMsg('Content commit failed. Check gateway + chain logs.')
        recordUpload('failed', msg || 'commit failed')
        return false
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

  async function waitForStakeBalance(owner: string) {
    const maxAttempts = 60
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const balances = await fetchBalances(owner)
      const stake = balances?.stake
      if (stake) {
        try {
          if (BigInt(stake) > 0n) return true
        } catch {
          return true
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    return false
  }

  const handleMduCommitSuccess = (
    dealId: string,
    manifestRoot: string,
    fileMeta?: { filePath: string; fileSizeBytes: number },
  ) => {
    if (!nilAddress) return
    const trimmedRoot = manifestRoot.trim()
    refreshDealsAfterContentCommit(nilAddress, dealId, trimmedRoot)
    if (fileMeta?.filePath) {
      const manifestHex = toHexFromBase64OrHex(trimmedRoot) || trimmedRoot
      upsertRecentFile({
        dealId,
        filePath: fileMeta.filePath,
        sizeBytes: fileMeta.fileSizeBytes || 0,
        manifestRoot: manifestHex,
        lastAction: 'upload',
        status: 'success',
      })
    }
  }

  const resolveDealById = useCallback(
    (dealId: string): Deal | null =>
      allDeals.find((deal) => String(deal.id) === dealId) ||
      deals.find((deal) => String(deal.id) === dealId) ||
      null,
    [allDeals, deals],
  )

  const handleRecentDownload = useCallback(
    async (entry: RecentFileEntry) => {
      const id = entry.id
      setRecentDownloadId(id)
      updateRecentFile(id, { status: 'pending', lastAction: 'download', error: undefined })
      try {
        const deal = resolveDealById(entry.dealId)
        if (!deal) throw new Error('Deal not found')
        const owner = String(nilAddress || deal.owner || '').trim()
        if (!owner) throw new Error('Deal owner not available')
        const manifestRootRaw = String(deal.cid || entry.manifestRoot || '').trim()
        if (!manifestRootRaw) throw new Error('Manifest root missing')
        const manifestHex = toHexFromBase64OrHex(manifestRootRaw) || manifestRootRaw
        const directBase = resolveProviderBase(deal)
        const p2pTarget = appConfig.p2pEnabled ? resolveProviderP2pTarget(deal) : undefined

        const [filesResult, slabResult] = await Promise.allSettled([
          listFiles({
            manifestRoot: manifestRootRaw,
            dealId: entry.dealId,
            owner,
            directBase,
            p2pTarget,
          }),
          slab({
            manifestRoot: manifestRootRaw,
            dealId: entry.dealId,
            owner,
            directBase,
            p2pTarget,
          }),
        ])

        if (filesResult.status !== 'fulfilled') {
          throw filesResult.reason instanceof Error ? filesResult.reason : new Error('Failed to load file list')
        }
        const fileEntry = filesResult.value.data.find((f) => f.path === entry.filePath)
        if (!fileEntry) throw new Error('File not found on provider')

        const slabLayout = slabResult.status === 'fulfilled' ? slabResult.value.data : null
        const result = await fetchFile({
          dealId: entry.dealId,
          manifestRoot: manifestHex,
          owner,
          filePath: entry.filePath,
          rangeStart: 0,
          rangeLen: fileEntry.size_bytes,
          fileStartOffset: fileEntry.start_offset,
          fileSizeBytes: fileEntry.size_bytes,
          mduSizeBytes: slabLayout?.mdu_size_bytes ?? 8 * 1024 * 1024,
          blobSizeBytes: slabLayout?.blob_size_bytes ?? 128 * 1024,
        })
        if (!result?.url) throw new Error('Download failed')

        const anchor = document.createElement('a')
        anchor.href = result.url
        anchor.download = entry.filePath.split('/').pop() || 'download'
        anchor.click()
        setTimeout(() => window.URL.revokeObjectURL(result.url), 1000)

        updateRecentFile(id, {
          status: 'success',
          lastAction: 'download',
          sizeBytes: fileEntry.size_bytes,
          manifestRoot: manifestHex,
          error: undefined,
        })
        showDownloadToast(entry.filePath)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        updateRecentFile(id, { status: 'failed', lastAction: 'download', error: msg || 'Download failed' })
      } finally {
        setRecentDownloadId(null)
      }
    },
    [
      fetchFile,
      listFiles,
      nilAddress,
      resolveDealById,
      resolveProviderBase,
      resolveProviderP2pTarget,
      showDownloadToast,
      slab,
      updateRecentFile,
    ],
  )

  const recordRecentActivity = useCallback(
    (event: {
      dealId: string
      filePath: string
      sizeBytes: number
      manifestRoot: string
      action: 'upload' | 'download'
      status: 'pending' | 'success' | 'failed'
      error?: string
    }) => {
      const manifestHex = toHexFromBase64OrHex(event.manifestRoot) || event.manifestRoot
      upsertRecentFile({
        dealId: event.dealId,
        filePath: event.filePath,
        sizeBytes: event.sizeBytes || 0,
        manifestRoot: manifestHex,
        lastAction: event.action,
        status: event.status,
        error: event.error,
      })
      if (event.action === 'download' && event.status === 'success') {
        showDownloadToast(event.filePath)
      }
    },
    [showDownloadToast, upsertRecentFile],
  )

  const handleWizardAction = async (stepId: string) => {
    if (stepId === 'connect') {
      await connectAsync({ connector: injectedConnector })
      return
    }
    if (stepId === 'fund') {
      await handleRequestFunds()
      return
    }
    if (stepId === 'deal') {
      setActiveTab('alloc')
      setPendingScrollTarget('workspace')
      return
    }
    if (stepId === 'upload') {
      if (wizardDeal) {
        setTargetDealId(String(wizardDeal.id ?? ''))
      }
      setActiveTab(wizardUploadTab)
      setPendingScrollTarget('workspace')
      return
    }
    if (stepId === 'retrieve') {
      if (wizardDeal) {
        setTargetDealId(String(wizardDeal.id ?? ''))
        setSelectedDeal(wizardDeal)
        setPendingScrollTarget('deal')
      }
    }
  }

  const handleContentDownload = useCallback(
    async (file: NilfsFileEntry) => {
      if (!targetDealId) return
      const dealId = String(targetDealId)
      const manifestHex = toHexFromBase64OrHex(contentManifestRoot) || contentManifestRoot
      const id = `${dealId}:${file.path}`
      updateRecentFile(id, { status: 'pending', lastAction: 'download', error: undefined })
      upsertRecentFile({
        dealId,
        filePath: file.path,
        sizeBytes: file.size_bytes || 0,
        manifestRoot: manifestHex,
        lastAction: 'download',
        status: 'pending',
      })
      try {
        const result = await fetchFile({
          dealId,
          manifestRoot: manifestHex,
          owner: nilAddress,
          filePath: file.path,
          rangeStart: 0,
          rangeLen: file.size_bytes,
          fileStartOffset: file.start_offset,
          fileSizeBytes: file.size_bytes,
          mduSizeBytes: contentSlab?.mdu_size_bytes ?? 8 * 1024 * 1024,
          blobSizeBytes: contentSlab?.blob_size_bytes ?? 128 * 1024,
        })
        if (!result?.url) throw new Error('Download failed')
        const anchor = document.createElement('a')
        anchor.href = result.url
        anchor.download = file.path.split('/').pop() || 'download'
        anchor.click()
        setTimeout(() => window.URL.revokeObjectURL(result.url), 1000)
        updateRecentFile(id, { status: 'success', lastAction: 'download', error: undefined })
        showDownloadToast(file.path)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        updateRecentFile(id, { status: 'failed', lastAction: 'download', error: msg || 'Download failed' })
      }
    },
    [contentManifestRoot, contentSlab, fetchFile, nilAddress, showDownloadToast, targetDealId, upsertRecentFile, updateRecentFile],
  )

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
      <details className="rounded-xl border border-border bg-card shadow-sm">
        <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold text-foreground">
          Network &amp; routing <span className="text-xs font-normal text-muted-foreground">(advanced)</span>
        </summary>
        <div className="px-4 pb-4">
          <StatusBar />
        </div>
      </details>
      
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

      <div className="flex flex-col lg:flex-row lg:items-start gap-6">
        <div className="flex-1 space-y-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">NilStore Console</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Create a deal (bucket), upload files, and retrieve directly from providers.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span className="px-2 py-1 rounded-full border border-border bg-secondary/60">
              Chain <span className="font-mono text-foreground">{activeChainId}</span>
            </span>
            <span className="px-2 py-1 rounded-full border border-border bg-secondary/60">
              Providers <span className="font-mono text-foreground">{providerCount || 0}</span>
            </span>
            <span className="px-2 py-1 rounded-full border border-border bg-secondary/60">
              Deals <span className="font-mono text-foreground">{dealSummary.total}</span>
            </span>
            <span className="px-2 py-1 rounded-full border border-border bg-secondary/60">
              Stored <span className="font-mono text-foreground">{formatBytes(dealSummary.totalBytes)}</span>
            </span>
          </div>
        </div>

        <div className="bg-card rounded-xl border border-border p-6 space-y-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-foreground font-semibold">
              <Coins className="w-4 h-4 text-yellow-500" />
              Wallet & Funds
            </div>
            <button
              onClick={handleRequestFunds}
              disabled={faucetLoading}
              data-testid="faucet-request"
              className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 rounded-md transition-colors disabled:opacity-50"
            >
              {faucetLoading ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Coins className="w-3 h-3" />}
              {faucetLoading ? 'Sending...' : 'Get Testnet NIL'}
            </button>
          </div>

          {faucetTx && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-green-600 dark:text-green-400 bg-green-500/10 px-2 py-1 rounded border border-green-500/20">
              <ArrowDownRight className="w-3 h-3 flex-shrink-0" />
              <span className="truncate max-w-[160px]" title={faucetTx}>
                Tx: <span className="font-mono">{faucetTx.slice(0, 10)}...{faucetTx.slice(-8)}</span>
              </span>
              <span className="opacity-75">({faucetTxStatus})</span>
            </div>
          )}

          <div className="text-sm text-muted-foreground space-y-3">
            <div className="font-mono text-primary break-all" data-testid="wallet-address-full">
              Address: {address || nilAddress}
            </div>
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
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold mb-1">Cosmos Identity</div>
              <div
                className="font-mono text-primary bg-primary/5 px-3 py-1 rounded text-sm border border-primary/10"
                data-testid="cosmos-identity"
              >
                {nilAddress}
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

      <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">First Upload Wizard</div>
            <h3 className="text-lg font-semibold text-foreground">Finish your first storage flow</h3>
            <p className="text-xs text-muted-foreground mt-1">
              {wizardNext
                ? `Next: ${wizardNext.label}. ${wizardNext.hint}`
                : 'All steps complete. You can upload and retrieve freely.'}
            </p>
          </div>
          {wizardNext && (
            <button
              type="button"
              onClick={() => handleWizardAction(wizardNext.id)}
              className="inline-flex items-center gap-2 rounded-md border border-primary/30 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/10"
            >
              {wizardNext.actionLabel}
            </button>
          )}
        </div>
        <div className="mt-4 grid gap-2">
          {wizardSteps.map((step, idx) => (
            <div
              key={step.id}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
                step.done ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-border bg-background/60'
              }`}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold ${
                    step.done ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'border-border text-muted-foreground'
                  }`}
                >
                  {idx + 1}
                </span>
                <div>
                  <div className="text-sm font-semibold text-foreground">{step.label}</div>
                  <div className="text-[11px] text-muted-foreground">{step.hint}</div>
                </div>
              </div>
              {step.done ? (
                <div className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="w-3 h-3" />
                  Done
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => handleWizardAction(step.id)}
                  className="text-[11px] font-semibold text-primary hover:text-primary/80"
                >
                  {step.actionLabel}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div ref={workspaceRef} className="bg-card rounded-xl border border-border overflow-hidden flex flex-col shadow-sm">
        <div className="px-6 py-4 border-b border-border flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Workspace</div>
            <h3 className="text-lg font-semibold text-foreground">Create a deal and manage files</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Mode 2 is the default. Legacy Mode 1 tools live under Advanced.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <label className="space-y-1 min-w-[220px]">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Current deal</span>
              <select
                value={targetDealId ?? ''}
                onChange={(e) => {
                  const next = String(e.target.value ?? '')
                  setTargetDealId(next)
                  if (!next) {
                    setSelectedDeal(null)
                    return
                  }
                  const deal = resolveDealById(next)
                  if (deal) setSelectedDeal(deal)
                }}
                data-testid="workspace-deal-select"
                className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
              >
                <option value="">Select a deal…</option>
                {deals
                  .filter((d) => d.owner === nilAddress)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      Deal #{d.id} ({d.cid ? 'Active' : 'Empty'})
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              data-testid="workspace-advanced-toggle"
              className={`inline-flex items-center justify-center rounded-md border px-3 py-2 text-xs font-semibold transition-colors ${
                showAdvanced
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border bg-background/60 text-muted-foreground hover:bg-secondary/50'
              }`}
            >
              {showAdvanced ? 'Advanced: on' : 'Advanced'}
            </button>
          </div>
        </div>

        <div className="p-4 border-b border-border bg-muted/20 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('alloc')}
              data-testid="tab-alloc"
              className={`rounded-lg border px-4 py-2 text-left transition-colors ${
                activeTab === 'alloc'
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border bg-background/60 hover:bg-secondary/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-primary" />
                <div className="text-sm font-semibold text-foreground">Create deal</div>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Allocate a new bucket.</div>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('mdu')}
              data-testid="tab-mdu"
              className={`rounded-lg border px-4 py-2 text-left transition-colors ${
                activeTab === 'mdu'
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border bg-background/60 hover:bg-secondary/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-primary" />
                <div className="text-sm font-semibold text-foreground">Upload (Mode 2)</div>
                <span className="ml-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
                  Recommended
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">Local WASM expansion + striped upload.</div>
            </button>
            {showAdvanced && (
              <button
                type="button"
                onClick={() => setActiveTab('content')}
                data-testid="tab-content"
                className={`rounded-lg border px-4 py-2 text-left transition-colors ${
                  activeTab === 'content'
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-border bg-background/60 hover:bg-secondary/50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-primary" />
                  <div className="text-sm font-semibold text-foreground">Legacy upload (Mode 1)</div>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">Gateway sharding flow.</div>
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Selected</span>
              <span className="font-mono text-foreground" data-testid="selected-deal-id">
                {targetDealId ? `#${targetDealId}` : '—'}
              </span>
            </div>
            <span className="text-border">|</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Mode</span>
              <span className="font-semibold text-foreground">{activeDealModeLabel}</span>
            </div>
            <span className="text-border">|</span>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</span>
              <span className="font-semibold text-foreground">{activeDealStatus}</span>
            </div>
          </div>
        </div>

        <div className="p-6 flex-1">
            {activeTab === 'alloc' ? (
                  <div className="space-y-4">
                      <p className="text-xs text-muted-foreground">
                        Create a deal (a bucket). Mode 2 is the default; Mode 1 is available as legacy.
                      </p>
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
                            {!showAdvanced ? (
                              <div className="sm:col-span-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground space-y-1">
                                <div>
                                  <span className="font-semibold text-foreground">Redundancy:</span> Mode 2 (Striped RS, recommended){' '}
                                  <span className="font-mono text-foreground">K={rsK}</span>{' '}
                                  <span className="font-mono text-foreground">M={rsM}</span>
                                  <span className="ml-2 text-[11px] text-muted-foreground">
                                    Toggle Advanced for Mode 1 or custom tuning.
                                  </span>
                                </div>
                                <div className="text-[11px] text-muted-foreground">
                                  Slots required:{' '}
                                  <span className="font-mono text-foreground">{mode2Config.slots ?? '—'}</span>
                                  {' '}• Providers available:{' '}
                                  <span className="font-mono text-foreground">{providerCount || '—'}</span>
                                  {mode2Config.error && (
                                    <div className="mt-1 text-[11px] text-red-500">{mode2Config.error}</div>
                                  )}
                                </div>
                              </div>
                            ) : (
                            <>
                              <label className="space-y-1">
                                <span className="text-xs uppercase tracking-wide text-muted-foreground">Redundancy Mode</span>
                                <select
                                  value={redundancyMode}
                                  onChange={(e) => setRedundancyMode((e.target.value as 'mode1' | 'mode2') || 'mode2')}
                                  data-testid="alloc-redundancy-mode"
                                  className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                                >
                                  <option value="mode2">Mode 2 (Striped RS, recommended)</option>
                                  <option value="mode1">Mode 1 (Replication, legacy)</option>
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
                                    onChange={(e) => setReplication(e.target.value ?? '')}
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
                                      onChange={(e) => setRsK(e.target.value ?? '')}
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
                                      onChange={(e) => setRsM(e.target.value ?? '')}
                                      data-testid="alloc-rs-m"
                                      className="w-full bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
                                    />
                                  </label>
                                </div>
                              )}
                              {redundancyMode === 'mode2' && (
                                <div className="text-[11px] text-muted-foreground sm:col-span-2">
                                  Slots required:{' '}
                                  <span className="font-mono text-foreground">{mode2Config.slots ?? '—'}</span>
                                  {' '}• Providers available:{' '}
                                  <span className="font-mono text-foreground">{providerCount || '—'}</span>
                                  {mode2Config.error && (
                                    <div className="text-[11px] text-red-500 mt-1">{mode2Config.error}</div>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                      </div>
                    <div className="flex items-center justify-between pt-2">
                        <div className="text-xs text-muted-foreground">
                            {createTx && <div className="text-green-600 dark:text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Alloc Tx: {createTx.slice(0,10)}...</div>}
                        </div>
                        <button
                            onClick={handleCreateDeal}
                            disabled={dealLoading || (redundancyMode === 'mode2' && Boolean(mode2Config.error))}
                            data-testid="alloc-submit"
                            className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-md disabled:opacity-50 transition-colors"
                        >
                            {dealLoading ? 'Creating...' : 'Create Deal'}
                        </button>
                    </div>
                </div>
                  ) : activeTab === 'content' ? (
                    !showAdvanced ? (
                      <div className="rounded-xl border border-border bg-secondary/40 px-4 py-3 text-sm text-muted-foreground flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div>
                          <div className="font-semibold text-foreground">Legacy Mode 1 tools are hidden</div>
                          <div className="text-xs text-muted-foreground mt-1">
                            Enable Advanced to access gateway sharding (Mode 1).
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowAdvanced(true)}
                          className="inline-flex items-center justify-center rounded-md border border-primary/30 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/10"
                        >
                          Enable Advanced
                        </button>
                      </div>
                    ) : (
                      <div className="space-y-4">
                            <p className="text-xs text-muted-foreground">
                              Legacy gateway sharding (Mode 1). For Mode 2, use the Mode 2 upload card.
                            </p>
                          <div className="grid grid-cols-1 gap-3 text-sm">
                            <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                              Target deal:{' '}
                              <span className="font-mono text-foreground">
                                {targetDealId ? `#${targetDealId}` : '—'}
                              </span>
                              {!targetDealId ? (
                                <span className="ml-2">Select a deal above to continue.</span>
                              ) : null}
                            </div>
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
                              {isTargetDealMode2 && (
                              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                                This is a Mode 2 deal. Use the Mode 2 card — it will use the local gateway when available, otherwise fall back to in-browser WASM sharding + direct stripe uploads.
                              </div>
                            )}
                          <label className="space-y-1">
                              <span className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                                  <Upload className="w-3 h-3 text-primary" />
                                    Upload & Shard (gateway, Mode 1)
                                </span>
                              <input
                                  type="file"
                                  onChange={handleFileChange}
                                  disabled={uploadLoading || !targetDealId || isTargetDealMode2}
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
                                          onClick={() => handleContentDownload(f)}
                                          disabled={downloading}
                                          data-testid="content-download"
                                          data-file-path={f.path}
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
                              disabled={updateLoading || !stagedUpload || !targetDealId || isTargetDealMode2}
                              data-testid="content-commit"
                              className="px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium rounded-md disabled:opacity-50 transition-colors"
                          >
                              {updateLoading ? 'Committing...' : 'Commit uploaded content'}
                            </button>
                        </div>
                    </div>
                    )
                ) : (
                <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-muted-foreground">
                    Mode 2 upload: uses the local gateway when available; otherwise falls back to in-browser WASM sharding + direct stripe uploads.
                  </p>
                </div>

                <div className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                  Target deal:{' '}
                  <span className="font-mono text-foreground">
                    {targetDealId ? `#${targetDealId}` : '—'}
                  </span>
                  {!targetDealId ? <span className="ml-2">Select a deal above to begin.</span> : null}
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
            <h3 className="text-lg font-medium text-foreground mb-2">No deals yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">Create a deal above, then upload files into it.</p>
        </div>
      ) : (
        <>
          <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <div className="px-6 py-3 border-b border-border bg-muted/50">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Deal Library</div>
                <p className="text-[11px] text-muted-foreground mt-1">Select a deal to view details, upload, or retrieve files.</p>
              </div>
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
                          onClick={() => {
                            setSelectedDeal(deal)
                            setTargetDealId(String(deal.id ?? ''))
                          }}
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
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        const dealId = String(deal.id ?? '')
                                        setTargetDealId(dealId)
                                        const service = parseServiceHint(deal.service_hint)
                                        setActiveTab(service.mode === 'mode2' ? 'mdu' : 'content')
                                        setPendingScrollTarget('workspace')
                                      }}
                                      className="px-3 py-1.5 text-xs rounded-md border border-primary/30 text-primary hover:bg-primary/10"
                                    >
                                      Upload
                                    </button>
                                </td>
                      </tr>
                      ))}
                  </tbody>
              </table>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
              <div className="px-4 py-3 border-b border-border bg-muted/50 flex items-center justify-between">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Recent Files</div>
                <div className="text-[10px] text-muted-foreground">{recentFiles.length} tracked</div>
              </div>
              <div className="p-4 space-y-3">
                {recentFiles.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic">
                    Upload or download a file to see it here.
                  </div>
                ) : (
                  recentFiles.map((entry) => {
                    const isBusy = recentDownloadId === entry.id || downloading
                    const actionLabel =
                      entry.status === 'pending'
                        ? 'Downloading...'
                        : entry.status === 'failed'
                        ? 'Retry'
                        : 'Download'
                    return (
                      <div key={entry.id} className="rounded-lg border border-border bg-background/60 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-foreground truncate" title={entry.filePath}>
                              {entry.filePath}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              Deal #{entry.dealId} • {formatBytes(entry.sizeBytes)} • {formatRelativeTime(entry.updatedAt)}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRecentDownload(entry)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 rounded-md border border-primary/30 px-2 py-1 text-[10px] font-semibold text-primary hover:bg-primary/10 disabled:opacity-50"
                          >
                            <ArrowDownRight className="w-3 h-3" />
                            {actionLabel}
                          </button>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                          <span className="rounded-full border border-border px-2 py-0.5">
                            Last: {entry.lastAction}
                          </span>
                          <span className={`rounded-full border px-2 py-0.5 ${
                            entry.status === 'failed'
                              ? 'border-red-500/40 text-red-500'
                              : entry.status === 'pending'
                              ? 'border-yellow-500/40 text-yellow-600 dark:text-yellow-400'
                              : 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                          }`}>
                            {entry.status}
                          </span>
                        </div>
                        {entry.error && (
                          <div className="mt-2 text-[10px] text-red-500 truncate" title={entry.error}>
                            {entry.error}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>

          {selectedDeal && (
            <div ref={dealDetailRef}>
              <DealDetail 
                  deal={selectedDeal} 
                  onClose={() => setSelectedDeal(null)} 
                  nilAddress={nilAddress} 
                  onFileActivity={recordRecentActivity}
              />
            </div>
          )}
        </>
      )}

      <details className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <summary className="cursor-pointer select-none px-6 py-3 bg-muted/50 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Network &amp; Diagnostics (advanced)
        </summary>
        <div className="p-6 space-y-6">
          {proofs.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
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
                          <span
                            className={`px-2 py-0.5 rounded-full border text-[10px] ${
                              p.valid
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                : 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400'
                            }`}
                          >
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

          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
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

          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
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

          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
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
                      <tr
                        key={`${dealId}-${provider}-${updatedHeight}-${shortSession}`}
                        className="hover:bg-muted/50 transition-colors"
                      >
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
        </div>
      </details>

      {downloadToast && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className="flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/15 px-4 py-2 text-xs font-semibold text-emerald-700 shadow-lg dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            {downloadToast}
          </div>
        </div>
      )}

    </div>
  )
}
