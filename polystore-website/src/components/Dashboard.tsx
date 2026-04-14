import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RefreshCw, CheckCircle2, HardDrive, Database, ChevronDown, ChevronUp, Coins } from 'lucide-react'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useCreateDeal } from '../hooks/useCreateDeal'
import { useUpdateDealContent } from '../hooks/useUpdateDealContent'
import { useUpload } from '../hooks/useUpload'
import { useNetwork } from '../hooks/useNetwork'
import { appConfig } from '../config'
import { DealDetail } from './DealDetail'
import { StatusBar } from './StatusBar'
import { FileSharder } from './FileSharder'
import { buildServiceHint, parseServiceHint } from '../lib/serviceHint'
import { maybeWrapPolyceZstd } from '../lib/polyce'
import { classifyWalletError } from '../lib/walletErrors'
import { lcdFetchDeals, lcdFetchParams } from '../api/lcdClient'
import type { LcdDeal as Deal, LcdParams } from '../domain/lcd'
import { toHexFromBase64OrHex } from '../domain/hex'
import { multiaddrToHttpUrl } from '../lib/multiaddr'
import { useSessionStatus } from '../hooks/useSessionStatus'
import { cn } from '../lib/utils'
import { InlineNotice, type InlineNoticeTone } from './InlineNotice'

interface Provider {
  address: string
  capabilities: string
  total_storage: string
  used_storage: string
  status: string
  reputation_score: string
  endpoints?: string[]
}

type StagedUpload = {
  cid: string
  sizeBytes: number
  fileSizeBytes: number
  logicalSizeBytes?: number
  contentEncoding?: string
  allocatedLength?: number
  totalMdus?: number
  witnessMdus?: number
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

type CreateDealFeedback = {
  tone: Exclude<InlineNoticeTone, 'pending'>
  title: string
  message: string
}

const RECENT_FILES_KEY = 'polystore_recent_files_v1'
const MAX_RECENT_FILES = 3
const DASHBOARD_DIAGNOSTICS_KEY = 'polystore_dashboard_show_diagnostics_v1'
const RETRIEVAL_SESSIONS_POLL_MS = 120_000
const RETRIEVAL_SESSIONS_HIDDEN_POLL_MS = 600_000
const RETRIEVAL_PARAMS_POLL_MS = 600_000
const RETRIEVAL_PARAMS_HIDDEN_POLL_MS = 1_800_000
const RPC_HEALTH_POLL_MS = 60_000
const RPC_HEALTH_HIDDEN_POLL_MS = 300_000

const DURATION_PRESETS = [
  { value: '1d', label: '1 day', seconds: 24 * 60 * 60 },
  { value: '1w', label: '1 week', seconds: 7 * 24 * 60 * 60 },
  { value: '1m', label: '1 month', seconds: 30 * 24 * 60 * 60 },
  { value: '3m', label: '3 months', seconds: 90 * 24 * 60 * 60 },
  { value: '6m', label: '6 months', seconds: 182 * 24 * 60 * 60 },
  { value: '1y', label: '1 year', seconds: 365 * 24 * 60 * 60 },
  { value: '2y', label: '2 years', seconds: 2 * 365 * 24 * 60 * 60 },
  { value: 'custom', label: 'Custom' },
] as const

const DURATION_PRESET_BY_SECONDS = Object.fromEntries(
  DURATION_PRESETS.filter((preset) => preset.value !== 'custom').map((preset) => [preset.value, preset.seconds]),
)

export function Dashboard() {
  const { openConnectModal } = useConnectModal()
  const { submitDeal, loading: dealLoading, lastTx: createDealTx, phase: createDealPhase } = useCreateDeal()
  const { submitUpdate, loading: updateLoading, lastTx: updateTx } = useUpdateDealContent()
  const { upload, loading: uploadLoading } = useUpload()
  const { switchNetwork } = useNetwork()
  const session = useSessionStatus()
  const {
    address,
    isConnected,
    polystoreAddress,
    hasFunds,
    isWrongNetwork,
    walletChainId,
    genesisMismatch,
    accountPermissionMismatch,
    refreshWalletNetwork,
    faucetTx,
    faucetTxStatus,
  } = session
  const [deals, setDeals] = useState<Deal[]>([])
  const [allDeals, setAllDeals] = useState<Deal[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'content' | 'mdu'>('mdu')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showSystemStatus, setShowSystemStatus] = useState(false)
  const [showCreateDeal, setShowCreateDeal] = useState(false)
  const [createDealFeedback, setCreateDealFeedback] = useState<CreateDealFeedback | null>(null)
  const [dealFilter, setDealFilter] = useState('')
  const [compressUploads, setCompressUploads] = useState(true)
  const providerCount = providers.length
  const defaultRsLabel = `${appConfig.defaultRsK}+${appConfig.defaultRsM}`
  const defaultMode2Slots = appConfig.defaultRsK + appConfig.defaultRsM
  const activeChainId = walletChainId
  // Check if the RPC node itself is on the right chain
  const [rpcChainId, setRpcChainId] = useState<number | null>(null)
  const [rpcHeight, setRpcHeight] = useState<number | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.sessionStorage.getItem(DASHBOARD_DIAGNOSTICS_KEY)
      if (raw === '1') setShowSystemStatus(true)
    } catch (e) {
      console.warn('Failed to load dashboard diagnostics preference', e)
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.setItem(DASHBOARD_DIAGNOSTICS_KEY, showSystemStatus ? '1' : '0')
    } catch (e) {
      console.warn('Failed to persist dashboard diagnostics preference', e)
    }
  }, [showSystemStatus])

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null

    const checkRpc = async () => {
      if (cancelled) return
      try {
        const [chainRes, heightRes] = await Promise.all([
          fetch(appConfig.evmRpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
          }),
          fetch(appConfig.evmRpc, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 2 }),
          }),
        ])
        const chainJson = await chainRes.json()
        const heightJson = await heightRes.json()
        const chainRaw = typeof chainJson?.result === 'string' ? chainJson.result : ''
        const id = chainRaw ? parseInt(chainRaw, 16) : NaN
        setRpcChainId(Number.isFinite(id) ? id : null)
        const heightRaw = typeof heightJson?.result === 'string' ? heightJson.result : ''
        const height = heightRaw ? parseInt(heightRaw, 16) : NaN
        setRpcHeight(Number.isFinite(height) ? height : null)
      } catch (e) {
        console.error('RPC Check failed', e)
        if (!cancelled) setRpcHeight(null)
      }
    }

    const schedule = (delayMs: number) => {
      if (cancelled) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void runLoop()
      }, delayMs)
    }

    const runLoop = async () => {
      if (cancelled) return
      await checkRpc()
      if (cancelled) return
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      schedule(hidden ? RPC_HEALTH_HIDDEN_POLL_MS : RPC_HEALTH_POLL_MS)
    }

    void runLoop()
    const handleVisibility = () => {
      if (cancelled || typeof document === 'undefined') return
      if (document.visibilityState === 'visible') {
        void runLoop()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility)
    }

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility)
      }
    }
  }, [])

  const rpcMismatch = rpcChainId !== null && rpcChainId !== appConfig.chainId
  const handleSwitchNetwork = useCallback(async (options?: { forceAdd?: boolean }) => {
    try {
      await switchNetwork({ forceAdd: options?.forceAdd })
      await refreshWalletNetwork()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e instanceof Error && e.message === 'GENESIS_MISMATCH_AFTER_SWITCH') {
        setStatusTone('error')
        setStatusMsg(
          `MetaMask is still using a different RPC for chain ${appConfig.chainId}. Open MetaMask > Networks > PolyStore Devnet and set RPC URL to ${appConfig.evmRpc}, or remove/re-add the network.`,
        )
        return
      }
      alert(`Could not switch network. Please switch to Chain ID ${appConfig.chainId} manually.`)
    }
  }, [refreshWalletNetwork, switchNetwork])

  const handleRefreshSummary = async () => {
    if (!polystoreAddress) return
    await Promise.allSettled([fetchDeals(polystoreAddress), fetchBalances(polystoreAddress), fetchProviders()])
  }


  // Step 1: Alloc State
  const [duration, setDuration] = useState('31536000')
  const [durationPreset, setDurationPreset] = useState('1y')
  const [initialEscrow, setInitialEscrow] = useState('1000000')
  const [maxMonthlySpend, setMaxMonthlySpend] = useState('5000000')
  const [placementProfile, setPlacementProfile] = useState<'auto' | 'custom'>('auto')
  const [rsK, setRsK] = useState(String(appConfig.defaultRsK))
  const [rsM, setRsM] = useState(String(appConfig.defaultRsM))

  // Step 2: Content State
  const [targetDealId, setTargetDealId] = useState('')
  const [dealUploadActiveById, setDealUploadActiveById] = useState<Record<string, boolean>>({})
  const [stagedUpload, setStagedUpload] = useState<StagedUpload | null>(null)
  const [, setContentSlabLoading] = useState(false)
  const [, setContentSlabError] = useState<string | null>(null)

  const [, setStatusMsg] = useState<string | null>(null)
  const [, setStatusTone] = useState<'neutral' | 'error' | 'success'>('neutral')
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([])
  const [downloadToast, setDownloadToast] = useState<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const autoSwitchMismatchKeyRef = useRef<string | null>(null)
  const allocRef = useRef<HTMLDivElement | null>(null)
  const mduRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const dealDetailRef = useRef<HTMLDivElement | null>(null)
  const optimisticCidTtlMs = 2 * 60_000
  const optimisticCidOverridesRef = useRef<Record<string, { cid: string; expiresAtMs: number }>>({})
  const [pendingScrollTarget, setPendingScrollTarget] = useState<'workspace' | 'deal' | 'create' | null>(null)
  const [dealDetailRequestedTab] = useState<'files' | 'info' | 'manifest' | 'activity' | null>(null)
  const [dealDetailRequestedTabNonce] = useState(0)

  const handleWalletError = useCallback((error: unknown, fallback: string) => {
    const walletError = classifyWalletError(error, fallback)
    setStatusTone('error')
    setStatusMsg(walletError.message)
    return walletError.message
  }, [])

  const openCreateDealDrawer = useCallback(() => {
    setCreateDealFeedback(null)
    setShowCreateDeal(true)
  }, [])

  const closeCreateDealDrawer = useCallback(() => {
    if (dealLoading) return
    setShowCreateDeal(false)
    setCreateDealFeedback(null)
  }, [dealLoading])

  const reportCreateDealFeedback = useCallback((feedback: CreateDealFeedback) => {
    setCreateDealFeedback(feedback)
  }, [])

  const pendingCreateDealFeedback = useMemo(() => {
    if (!dealLoading) return null
    if (createDealPhase === 'confirming') {
      return {
        tone: 'pending' as const,
        title: 'Waiting for chain confirmation',
        message: createDealTx
          ? `Transaction ${createDealTx.slice(0, 10)}... submitted. Keep this panel open until the receipt returns.`
          : 'Transaction submitted. Keep this panel open until the receipt returns.',
      }
    }
    return {
      tone: 'pending' as const,
      title: 'Confirm in MetaMask',
      message: 'Approve or reject the create-deal request in MetaMask.',
    }
  }, [createDealPhase, createDealTx, dealLoading])

  const requestWalletReconnect = useCallback(async () => {
    try {
      const ethereum = (window as { ethereum?: { request?: (args: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum
      if (ethereum?.request) {
        try {
          await ethereum.request({
            method: 'wallet_requestPermissions',
            params: [{ eth_accounts: {} }],
          })
        } catch {
          await ethereum.request({ method: 'eth_requestAccounts' })
        }
      } else {
        openConnectModal?.()
      }
      setStatusTone('neutral')
      setStatusMsg('Wallet access request sent. Approve in your wallet, then retry.')
      reportCreateDealFeedback({
        tone: 'info',
        title: 'Approve wallet access',
        message: 'Wallet access request sent. Approve in MetaMask, then retry creating the deal.',
      })
    } catch (error) {
      handleWalletError(error, 'Wallet reconnection failed')
    }
  }, [handleWalletError, openConnectModal, reportCreateDealFeedback])

  useEffect(() => {
    if (!accountPermissionMismatch) return
    setStatusTone('error')
    setStatusMsg('Wallet access is required. Unlock MetaMask (if needed), then click Connect Wallet and approve access for the active account.')
  }, [accountPermissionMismatch])

  useEffect(() => {
    if (!isConnected || !isWrongNetwork) {
      autoSwitchMismatchKeyRef.current = null
      return
    }
    const mismatchKind = genesisMismatch ? 'genesis' : 'chain'
    const key = `${String(activeChainId ?? 'unknown')}:${mismatchKind}`
    if (autoSwitchMismatchKeyRef.current === key) return
    autoSwitchMismatchKeyRef.current = key
    void handleSwitchNetwork({ forceAdd: genesisMismatch })
  }, [
    activeChainId,
    genesisMismatch,
    handleSwitchNetwork,
    isConnected,
    isWrongNetwork,
  ])

  const [retrievalSessions, setRetrievalSessions] = useState<Record<string, unknown>[]>([])
  const [, setRetrievalSessionsLoading] = useState(false)
  const [, setRetrievalSessionsError] = useState<string | null>(null)
  const [, setRetrievalParams] = useState<LcdParams | null>(null)
  const [, setRetrievalParamsError] = useState<string | null>(null)

  useEffect(() => {
    if (!polystoreAddress) {
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
        const url = `${appConfig.lcdBase}/polystorechain/polystorechain/v1/retrieval-sessions/by-owner/${encodeURIComponent(
          polystoreAddress,
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

    let timer: number | null = null

    const schedule = (delayMs: number) => {
      if (cancelled) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void runLoop()
      }, delayMs)
    }

    const runLoop = async () => {
      if (cancelled) return
      await refreshSessions()
      if (cancelled) return
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      schedule(hidden ? RETRIEVAL_SESSIONS_HIDDEN_POLL_MS : RETRIEVAL_SESSIONS_POLL_MS)
    }

    void runLoop()
    const handleVisibility = () => {
      if (cancelled || typeof document === 'undefined') return
      if (document.visibilityState === 'visible') {
        void runLoop()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility)
    }

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility)
      }
    }
  }, [polystoreAddress])

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

    let timer: number | null = null

    const schedule = (delayMs: number) => {
      if (cancelled) return
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        void runLoop()
      }, delayMs)
    }

    const runLoop = async () => {
      if (cancelled) return
      await refreshParams()
      if (cancelled) return
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      schedule(hidden ? RETRIEVAL_PARAMS_HIDDEN_POLL_MS : RETRIEVAL_PARAMS_POLL_MS)
    }

    void runLoop()
    const handleVisibility = () => {
      if (cancelled || typeof document === 'undefined') return
      if (document.visibilityState === 'visible') {
        void runLoop()
      }
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility)
    }

    return () => {
      cancelled = true
      if (timer !== null) window.clearTimeout(timer)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility)
      }
    }
  }, [])

  const ownedDeals = useMemo(
    () => (polystoreAddress ? deals.filter((deal) => deal.owner === polystoreAddress) : deals),
    [deals, polystoreAddress],
  )
  const targetDeal = useMemo(() => {
    if (!targetDealId) return null
    return deals.find((d) => d.id === targetDealId) || null
  }, [deals, targetDealId])
  const targetDealService = useMemo(
    () => parseServiceHint(targetDeal?.service_hint),
    [targetDeal?.service_hint],
  )
  const targetDealEndBlock = useMemo(() => {
    if (!targetDeal?.end_block) return null
    const n = Number(targetDeal.end_block)
    return Number.isFinite(n) ? n : null
  }, [targetDeal?.end_block])
  const targetDealExpired = useMemo(() => {
    if (!targetDealEndBlock || rpcHeight === null) return false
    return rpcHeight > targetDealEndBlock
  }, [rpcHeight, targetDealEndBlock])
  const targetDealExpiryMsg = useMemo(() => {
    if (!targetDealEndBlock) return null
    if (rpcHeight === null) return `Deal expires at block ${targetDealEndBlock}.`
    if (!targetDealExpired) return null
    return `Deal expired at block ${targetDealEndBlock} (current ${rpcHeight}). Create a new deal to continue uploading/committing.`
  }, [rpcHeight, targetDealEndBlock, targetDealExpired])
  const isTargetDealMode2 = targetDealService.mode === 'mode2' || targetDealService.mode === 'auto'
  const hasSelectedDeal = Boolean(targetDealId)
  const recentActivityByDeal = useMemo(() => {
    const out = new Map<string, RecentFileEntry>()
    for (const entry of recentFiles) {
      if (!entry?.dealId) continue
      const existing = out.get(entry.dealId)
      if (!existing || existing.updatedAt < entry.updatedAt) {
        out.set(entry.dealId, entry)
      }
    }
    return out
  }, [recentFiles])
  const filteredOwnedDeals = useMemo(() => {
    const query = dealFilter.trim().toLowerCase()
    if (!query) return ownedDeals
    return ownedDeals.filter((deal) => {
      const id = String(deal.id || '').toLowerCase()
      const manifest = String(deal.cid || '').toLowerCase()
      return id.includes(query) || manifest.includes(query)
    })
  }, [dealFilter, ownedDeals])

  const setDurationFromPreset = useCallback(
    (preset: string) => {
      setDurationPreset(preset)
      const matched = DURATION_PRESET_BY_SECONDS[preset]
      if (typeof matched === 'number') {
        setDuration(String(matched))
      }
    },
    [],
  )

  useEffect(() => {
    if (hasSelectedDeal && !isTargetDealMode2) {
      setShowAdvanced(true)
    }
  }, [hasSelectedDeal, isTargetDealMode2])

  useEffect(() => {
    if (targetDealId) return
    if (!polystoreAddress) return
    if (ownedDeals.length === 0) return
    const newestDeal = ownedDeals[ownedDeals.length - 1]
    if (!newestDeal?.id) return
    setTargetDealId(String(newestDeal.id))
  }, [polystoreAddress, ownedDeals, targetDealId])

  const mode2Config = useMemo(() => {
    if (placementProfile !== 'custom') return { slots: null as number | null, error: null as string | null }
    const k = Number(rsK)
    const m = Number(rsM)
    if (!Number.isFinite(k) || !Number.isFinite(m) || k <= 0 || m <= 0) {
      return { slots: null, error: 'Enter numeric K and M values.' }
    }
    const slots = k + m
    if (64 % k !== 0) {
      return { slots, error: 'K must divide 64.' }
    }
    if (providerCount <= 0) {
      return { slots, error: 'Provider list not loaded yet. Retry in a few seconds.' }
    }
    if (slots > providerCount) {
      return { slots, error: `Need ${slots} providers (K+M); only ${providerCount} available.` }
    }
    return { slots, error: null }
  }, [placementProfile, providerCount, rsK, rsM])
  const autoMode2ProviderError = useMemo(() => {
    if (placementProfile !== 'auto') return null
    if (providerCount <= 0) {
      return 'Provider list not loaded yet. Retry in a few seconds.'
    }
    if (defaultMode2Slots > providerCount) {
      return `Default Mode 2 profile requires ${defaultMode2Slots} providers (K+M), but only ${providerCount} are available.`
    }
    return null
  }, [defaultMode2Slots, placementProfile, providerCount])
  const createDealProviderError = placementProfile === 'custom' ? mode2Config.error : autoMode2ProviderError

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

  const selectedDealUploadActive = useMemo(() => {
    const dealKey = String(targetDealId || '').trim()
    if (!dealKey) return false
    return Boolean(dealUploadActiveById[dealKey])
  }, [dealUploadActiveById, targetDealId])

  const handleWorkflowActiveChange = useCallback((dealId: string, active: boolean) => {
    const dealKey = String(dealId || '').trim()
    if (!dealKey) return
    setDealUploadActiveById((prev) => {
      if (Boolean(prev[dealKey]) === active) return prev
      return { ...prev, [dealKey]: active }
    })
  }, [])

  useEffect(() => {
    setStagedUpload(null)
    setContentSlabError(null)
    setContentSlabLoading(false)
  }, [targetDealId])

  useEffect(() => {
    if (address && polystoreAddress) {
      optimisticCidOverridesRef.current = {}
      fetchDeals(polystoreAddress)
      fetchBalances(polystoreAddress)
      fetchProviders()
    } else {
      optimisticCidOverridesRef.current = {}
      setDeals([])
      setAllDeals([])
      setProviders([])
    }
  }, [address, polystoreAddress])

  async function fetchDeals(owner?: string): Promise<Deal[]> {
    setLoading(true)
    try {
        const all = await lcdFetchDeals(appConfig.lcdBase)
        const overrides = optimisticCidOverridesRef.current
        const now = Date.now()
        for (const [id, entry] of Object.entries(overrides)) {
          if (!entry || entry.expiresAtMs <= now) {
            delete overrides[id]
          }
        }
        const merged = all.map((deal) => {
          const id = String(deal.id ?? '')
          const override = id ? overrides[id] : undefined
          if (!override) return deal
          const cid = String(deal.cid || '').trim()
          const cidHex = toHexFromBase64OrHex(cid) || cid
          if (cidHex && cidHex === override.cid) {
            delete overrides[id]
            return deal
          }
          return { ...deal, cid: override.cid }
        })
        setAllDeals(merged)
        let filtered = owner ? merged.filter((d) => d.owner === owner) : merged
        if (owner && filtered.length === 0 && all.length > 0) {
          filtered = merged
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
      return next
    } catch (e) {
      console.error('fetchBalances failed', e)
    }
    return null
  }

  async function fetchProviders() {
    try {
      const res = await fetch(`${appConfig.lcdBase}/polystorechain/polystorechain/v1/providers`)
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

    if (pendingScrollTarget === 'create') {
      const target = allocRef.current
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setPendingScrollTarget(null)
      return
    }

    if (pendingScrollTarget === 'workspace') {
      const target = activeTab === 'mdu' ? mduRef.current : contentRef.current
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      setPendingScrollTarget(null)
      return
    }

    const root = dealDetailRef.current
    if (root) {
      const fileList = root.querySelector('[data-testid="deal-detail-file-list"]') as HTMLElement | null
      ;(fileList ?? root).scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    setPendingScrollTarget(null)
  }, [pendingScrollTarget, activeTab, targetDealId])

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

  function formatRelativeTime(ts: number | null | undefined): string {
    if (!ts || !Number.isFinite(ts)) return '—'
    const deltaMs = Date.now() - ts
    if (deltaMs < 60_000) return 'just now'
    const minutes = Math.floor(deltaMs / 60_000)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
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
    if (targetDealExpired) {
      setStatusTone('error')
      setStatusMsg(targetDealExpiryMsg || 'Deal is expired. Create a new deal to continue.')
      return
    }
    try {
      let uploadFile = file
      if (compressUploads) {
        setStatusTone('neutral')
        setStatusMsg('Compressing file (PolyCE)...')
        const buf = new Uint8Array(await file.arrayBuffer())
        const wrapped = await maybeWrapPolyceZstd(buf)
        if (wrapped.wrapped && wrapped.encoding === 'zstd') {
          const view = wrapped.bytes
          const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer
          uploadFile = new File([buffer], file.name, {
            type: file.type || 'application/octet-stream',
            lastModified: file.lastModified,
          })
        }
      }
      const dealForUpload = allDeals.find((d) => d.id === targetDealId) || deals.find((d) => d.id === targetDealId) || null
      const opts: { dealId?: string; directBase?: string } = {
        dealId: targetDealId,
        directBase: resolveProviderBase(dealForUpload),
      }

      const result = await upload(uploadFile, address, opts)
      const totalMdus = result.totalMdus ?? result.allocatedLength
      const witnessMdus = result.witnessMdus
      setStagedUpload({
        cid: result.cid,
        sizeBytes: result.sizeBytes,
        fileSizeBytes: result.fileSizeBytes,
        logicalSizeBytes: result.logicalSizeBytes ?? file.size,
        contentEncoding: result.contentEncoding,
        allocatedLength: result.allocatedLength,
        totalMdus,
        witnessMdus,
        filename: result.filename || file.name,
      })
      setStatusTone('neutral')
      setStatusMsg(`File uploaded and sharded. New manifest root: ${result.cid.slice(0, 16)}...`)

      // Auto-commit into the selected deal.
      await handleUpdateContent(result.cid, result.sizeBytes, totalMdus, witnessMdus)
    } catch (e) {
      console.error(e)
      setStatusTone('error')
      setStatusMsg(`File upload/sharding failed: ${e instanceof Error ? e.message : String(e) || 'Check gateway logs.'}`)
    }
  }

  const handleCreateDeal = async (evmCreator: string) => {
    if (!hasFunds) {
      setStatusTone('error')
      setStatusMsg(
        appConfig.faucetEnabled
          ? 'You must request testnet NIL from the faucet before creating a storage deal.'
          : 'Your wallet needs funds before creating a storage deal.',
      )
      return
    }
    const previousTargetDealId = targetDealId
    // Prevent accidental uploads to a stale deal while createDeal is still in-flight.
    setTargetDealId('')
    setStagedUpload(null)

    try {
      let serviceHint = ''
      // Default trusted-devnet profile: explicit 2+1 (overridable in Advanced).
      serviceHint = buildServiceHint('General', { rsK: appConfig.defaultRsK, rsM: appConfig.defaultRsM })

      if (createDealProviderError) {
        setStatusTone('error')
        setStatusMsg(createDealProviderError)
        reportCreateDealFeedback({
          tone: 'error',
          title: 'Create deal failed',
          message: createDealProviderError,
        })
        setTargetDealId(previousTargetDealId)
        return
      }

      // Optional: explicit RS profile.
      if (placementProfile === 'custom') {
        const k = Number(rsK)
        const m = Number(rsM)
        if (!Number.isFinite(k) || !Number.isFinite(m) || k <= 0 || m <= 0) {
          setStatusTone('error')
          setStatusMsg('Custom Mode 2 profile requires numeric K and M values.')
          reportCreateDealFeedback({
            tone: 'error',
            title: 'Create deal failed',
            message: 'Custom Mode 2 profile requires numeric K and M values.',
          })
          setTargetDealId(previousTargetDealId)
          return
        }
        if (64 % k !== 0) {
          setStatusTone('error')
          setStatusMsg('Custom Mode 2 profile requires K to divide 64.')
          reportCreateDealFeedback({
            tone: 'error',
            title: 'Create deal failed',
            message: 'Custom Mode 2 profile requires K to divide 64.',
          })
          setTargetDealId(previousTargetDealId)
          return
        }
        const slots = k + m
        if (providerCount === 0) {
          setStatusTone('error')
          setStatusMsg('Provider list not loaded yet. Retry in a few seconds.')
          reportCreateDealFeedback({
            tone: 'error',
            title: 'Create deal failed',
            message: 'Provider list not loaded yet. Retry in a few seconds.',
          })
          setTargetDealId(previousTargetDealId)
          return
        }
        if (slots > providerCount) {
          const message = `Custom Mode 2 profile requires ${slots} providers (K+M), but only ${providerCount} are available.`
          setStatusTone('error')
          setStatusMsg(message)
          reportCreateDealFeedback({
            tone: 'error',
            title: 'Create deal failed',
            message,
          })
          setTargetDealId(previousTargetDealId)
          return
        }
        serviceHint = buildServiceHint('General', { rsK: k, rsM: m })
      }
      if (autoMode2ProviderError) {
        setStatusTone('error')
        setStatusMsg(autoMode2ProviderError)
        reportCreateDealFeedback({
          tone: 'error',
          title: 'Create deal failed',
          message: autoMode2ProviderError,
        })
        setTargetDealId(previousTargetDealId)
        return
      }

      const res = await submitDeal({
        creator: evmCreator,
        durationSeconds: Number(duration),
        initialEscrow,
        maxMonthlySpend,
        serviceHint,
      })
      reportCreateDealFeedback({
        tone: 'success',
        title: 'Deal created',
        message: `Deal #${res.deal_id} created successfully. Transaction ${res.tx_hash.slice(0, 10)}... confirmed.`,
      })
      setStatusTone('success')
      setStatusMsg(`Capacity Allocated. Deal ID: ${res.deal_id}. Now verify via content tab.`)
      if (polystoreAddress) {
        await refreshDealsAfterCreate(polystoreAddress, String(res.deal_id))
        await fetchBalances(polystoreAddress)
        // Auto-switch to content tab and pre-fill deal ID
        setTargetDealId(String(res.deal_id))
        setActiveTab('mdu')
      }
    } catch (e) {
      setTargetDealId(previousTargetDealId)
      reportCreateDealFeedback({
        tone: 'error',
        title: 'Create deal failed',
        message: handleWalletError(e, 'Deal allocation failed. Check gateway logs.'),
      })
    }
  }

  const handleCreateDealClick = async () => {
    if (!hasFunds) {
      const message = appConfig.faucetEnabled
        ? 'You must request testnet NIL from the faucet before creating a storage deal.'
        : 'Your wallet needs funds before creating a storage deal.'
      setStatusTone('error')
      setStatusMsg(message)
      reportCreateDealFeedback({
        tone: 'error',
        title: 'Create deal failed',
        message,
      })
      return
    }

    try {
      setCreateDealFeedback(null)
      if (accountPermissionMismatch) {
        await requestWalletReconnect()
        return
      }
      if (!isConnected || !address) {
        openConnectModal?.()
        return
      }
      if (isWrongNetwork) {
        try {
          await switchNetwork({ forceAdd: genesisMismatch })
        } catch (error) {
          const fallback = genesisMismatch
            ? `Network identity mismatch for chain ${appConfig.chainId}. Re-add PolyStore Devnet in MetaMask using RPC ${appConfig.evmRpc}.`
            : `Wrong network. Switch wallet to chain ${appConfig.chainId} and retry.`
          reportCreateDealFeedback({
            tone: 'error',
            title: 'Create deal failed',
            message: handleWalletError(error, fallback),
          })
        }
        return
      }
      if (!address || !address.startsWith('0x')) throw new Error('Connect wallet to create a deal.')
      await handleCreateDeal(address)
    } catch (e) {
      reportCreateDealFeedback({
        tone: 'error',
        title: 'Create deal failed',
        message: handleWalletError(e, 'Failed to connect wallet'),
      })
    }
  }

  const handleUpdateContent = async (
    manifestRoot: string,
    manifestSize: number,
    totalMdusMaybe?: number,
    witnessMdusMaybe?: number,
  ): Promise<boolean> => {
    if (!targetDealId) { alert('Select a deal to commit into'); return false }
    if (!manifestRoot) { alert('Upload a file first'); return false }

    if (!address || !address.startsWith('0x')) {
      alert('Connect wallet to commit content on-chain.')
      return false
    }
    if (targetDealExpired) {
      const msg = targetDealExpiryMsg || 'Deal is expired. Create a new deal to continue.'
      setStatusTone('error')
      setStatusMsg(msg)
      alert(msg)
      return false
    }

    const trimmedRoot = manifestRoot.trim()
    const manifestHex = toHexFromBase64OrHex(trimmedRoot) || trimmedRoot
    const totalMdusRaw = totalMdusMaybe ?? stagedUpload?.totalMdus ?? stagedUpload?.allocatedLength
    const witnessMdusRaw = witnessMdusMaybe ?? stagedUpload?.witnessMdus
    const totalMdus = Number(totalMdusRaw || 0)
    const witnessMdus = Number(witnessMdusRaw || 0)
    if (!Number.isFinite(totalMdus) || totalMdus <= 0) {
      alert('Upload did not include total_mdus; retry upload.')
      return false
    }
    if (!Number.isFinite(witnessMdus) || witnessMdus < 0) {
      alert('Upload did not include witness_mdus; retry upload.')
      return false
    }
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
            creator: address,
            dealId: Number(targetDealId),
            previousManifestRoot: String(targetDeal?.cid || '').trim(),
            cid: trimmedRoot,
            sizeBytes: manifestSize,
            totalMdus,
            witnessMdus,
        })
        setStatusTone('success')
        setStatusMsg(`Content committed to deal ${targetDealId}.`)
        optimisticCidOverridesRef.current[String(targetDealId)] = {
          cid: manifestHex,
          expiresAtMs: Date.now() + optimisticCidTtlMs,
        }
        setDeals((prev) =>
          prev.map((d) => (String(d.id) === String(targetDealId) ? { ...d, cid: manifestHex } : d)),
        )
        setAllDeals((prev) =>
          prev.map((d) => (String(d.id) === String(targetDealId) ? { ...d, cid: manifestHex } : d)),
        )
        if (polystoreAddress) await refreshDealsAfterContentCommit(polystoreAddress, targetDealId, manifestHex)
        recordUpload('success')
        return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/expired at end_block/i.test(msg || '')) {
        setStatusTone('error')
        setStatusMsg(targetDealExpiryMsg || 'Deal is expired. Create a new deal to continue.')
      } else {
        handleWalletError(e, 'Content commit failed. Check gateway + chain logs.')
      }
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

  const handleMduCommitSuccess = (
    dealId: string,
    manifestRoot: string,
    fileMeta?: { filePath: string; fileSizeBytes: number },
  ) => {
    const trimmedRoot = manifestRoot.trim()
    const manifestHex = toHexFromBase64OrHex(trimmedRoot) || trimmedRoot

    // Optimistic UI: update the selected deal immediately so Deal Explorer can refresh
    // while the LCD catches up.
    optimisticCidOverridesRef.current[String(dealId)] = {
      cid: manifestHex,
      expiresAtMs: Date.now() + optimisticCidTtlMs,
    }
    setDeals((prev) =>
      prev.map((d) => (String(d.id) === String(dealId) ? { ...d, cid: manifestHex } : d)),
    )
    setAllDeals((prev) =>
      prev.map((d) => (String(d.id) === String(dealId) ? { ...d, cid: manifestHex } : d)),
    )

    if (polystoreAddress) {
      refreshDealsAfterContentCommit(polystoreAddress, dealId, manifestHex)
    }
    if (fileMeta?.filePath) {
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

  // Content downloads are tracked via Deal Explorer download actions.

  useEffect(() => {
    if (!appConfig.faucetEnabled) return
    if (faucetTxStatus === 'confirmed' && faucetTx) {
      setStatusTone('success')
      setStatusMsg(`Faucet tx ${faucetTx} confirmed.`)
      if (polystoreAddress) fetchBalances(polystoreAddress)
    } else if (faucetTxStatus === 'failed' && faucetTx) {
      setStatusTone('error')
      setStatusMsg(`Faucet tx ${faucetTx} failed.`)
    }
  }, [faucetTxStatus, faucetTx, polystoreAddress])

  if (!isConnected)
    return (
      <div className="px-4 pb-12 pt-24">
        <div className="container mx-auto max-w-6xl">
          <div className="glass-panel industrial-border p-12 text-center">
            <div className="nil-section-label">/DASHBOARD</div>
            <h2 className="mt-2 text-xl font-semibold text-foreground">Connect MetaMask to open the dashboard</h2>
            <p className="mt-3 text-muted-foreground">
              Connect your wallet to allocate deals, upload files, inspect manifests, and verify retrieval health.
            </p>
            <button
              type="button"
              onClick={() => openConnectModal?.()}
              className="cta-shadow mt-6 inline-flex items-center justify-center gap-3 border border-primary bg-primary px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-primary-foreground transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px]"
            >
              Connect Wallet
            </button>
          </div>
        </div>
      </div>
    )

  if (!hasFunds)
    return (
      <div className="px-4 pb-12 pt-24">
        <div className="container mx-auto max-w-6xl">
          <div className="glass-panel industrial-border p-12 text-center">
            <div className="nil-section-label">/DASHBOARD</div>
            <h2 className="mt-2 text-xl font-semibold text-foreground">Fund your wallet to continue</h2>
            <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
              Your wallet is connected, but it needs testnet NIL before you can allocate deals or upload data.
            </p>
            <button
              type="button"
              onClick={() => void session.requestFunds()}
              disabled={!address || session.faucetBusy || !session.faucetEnabled}
              className="cta-shadow mt-6 inline-flex items-center justify-center gap-3 border border-primary bg-primary px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-primary-foreground transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {session.faucetBusy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Coins className="h-4 w-4" />}
              {session.faucetBusy ? 'Funding' : 'Fund Wallet'}
            </button>
          </div>
        </div>
      </div>
    )

  const onChainCid = String(targetDeal?.cid || '').trim()

  const dealExplorerTopPanel = (
    <div className="p-5 space-y-4 bg-card">
      {showAdvanced ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={() => setActiveTab((tab) => (tab === 'content' ? 'mdu' : 'content'))}
              data-testid="tab-content"
              className="nil-inset inline-flex items-center gap-2 rounded-none px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Database className="h-3.5 w-3.5 text-muted-foreground" />
              {activeTab === 'content' ? 'Back to Upload' : 'Mode 1 (advanced)'}
            </button>
        </div>
      ) : null}

      {activeTab === 'content' ? (
        !showAdvanced ? (
          <div
            ref={contentRef}
            className="nil-inset glass-panel industrial-border flex flex-col gap-3 px-4 py-3 text-[11px] font-mono-data text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <div className="nil-section-label text-xs tracking-widest dark:text-foreground/90">/gateway/tools</div>
              <div className="mt-1 font-semibold text-foreground">Advanced tools are hidden</div>
              <div className="mt-1 text-[11px] font-mono-data text-muted-foreground">Enable Advanced to access gateway sharding (Mode 1).</div>
            </div>
            <button
              type="button"
              onClick={() => setShowAdvanced(true)}
              className="inline-flex items-center justify-center border border-primary/30 bg-primary/10 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary hover:bg-primary/15"
            >
              Enable Advanced
            </button>
          </div>
        ) : (
          <div ref={contentRef} className="space-y-4">
            <p className="text-[11px] font-mono-data text-muted-foreground">
              Legacy gateway sharding (Mode 1). For Mode 2, use the Upload tab.
            </p>
            <div className="grid grid-cols-1 gap-3 text-sm">
              <div className="nil-inset glass-panel industrial-border px-3 py-2 text-[11px] font-mono-data text-muted-foreground">
                Target deal:{' '}
                <span className="font-mono-data text-foreground">{targetDealId ? `#${targetDealId}` : '—'}</span>
                {!targetDealId ? <span className="ml-2">Select a deal above to continue.</span> : null}
              </div>
              {targetDealId && (
                <div className="text-[11px] font-mono-data text-muted-foreground">
                  On-chain:{' '}
                  {onChainCid ? (
                    <span className="font-mono-data text-primary">{`${onChainCid.slice(0, 18)}...`}</span>
                  ) : (
                    <span className="italic">Empty container</span>
                  )}{' '}
                  • Size: <span className="font-mono-data text-foreground">{targetDeal?.size ?? '0'}</span>
                </div>
              )}
              {isTargetDealMode2 && (
                <div className="nil-inset glass-panel industrial-border px-3 py-2 text-[11px] font-mono-data text-primary ring-1 ring-primary/25">
                  This is a Mode 2 deal. Use the Upload tab (Mode 2).
                </div>
              )}
              {targetDealExpired && (
                <div className="rounded-none border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                  {targetDealExpiryMsg}
                </div>
              )}
              <label className="space-y-1">
                <span className="nil-section-label">Select file</span>
                <input
                  type="file"
                  onChange={handleFileChange}
                  disabled={!targetDealId || uploadLoading || isTargetDealMode2 || targetDealExpired}
                  data-testid="content-file-input"
                  className="w-full recessed-input px-3 py-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30 disabled:opacity-50"
                />
              </label>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={compressUploads}
                  onChange={(e) => setCompressUploads(e.target.checked)}
                  className="h-3 w-3 rounded-none border-border text-primary focus:ring-primary/40"
                />
                Compress before upload (PolyCE, recommended)
              </label>
              {stagedUpload && (
                <div className="nil-inset glass-panel industrial-border space-y-1 px-3 py-2 text-[11px] font-mono-data text-muted-foreground">
                  <div>
                    Staged: <span className="text-foreground">{stagedUpload.filename}</span>
                  </div>
                  <div>
                    Manifest root:{' '}
                    <span className="text-primary select-all" data-testid="staged-manifest-root">
                      {stagedUpload.cid}
                    </span>
                  </div>
                  {stagedUpload.logicalSizeBytes && stagedUpload.logicalSizeBytes !== stagedUpload.sizeBytes && (
                    <div>
                      Logical size:{' '}
                      <span className="text-foreground">{stagedUpload.logicalSizeBytes}</span>
                      {stagedUpload.contentEncoding ? (
                        <span className="ml-2 text-[10px] uppercase text-muted-foreground">
                          {stagedUpload.contentEncoding}
                        </span>
                      ) : null}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between pt-2">
              <div className="text-xs text-muted-foreground">
                {updateTx && (
                  <div className="text-success flex items-center gap-2 font-mono-data text-[10px] uppercase tracking-[0.2em]">
                    <CheckCircle2 className="w-3 h-3" /> Commit Tx: {updateTx.slice(0, 10)}...
                  </div>
                )}
              </div>
              <button
                onClick={() => {
                  if (!stagedUpload) return
                  void handleUpdateContent(
                    stagedUpload.cid,
                    stagedUpload.sizeBytes,
                    stagedUpload.totalMdus,
                    stagedUpload.witnessMdus,
                  )
                }}
                disabled={updateLoading || !stagedUpload || !targetDealId || isTargetDealMode2 || targetDealExpired}
                data-testid="content-commit"
                className="px-4 py-3 bg-primary hover:bg-primary/90 text-primary-foreground text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data shadow-[0_0_50px_rgba(0,0,0,0.06)] dark:shadow-[0_0_60px_rgba(0,0,0,0.8)] disabled:opacity-50 transition-all"
              >
                {updateLoading ? 'Committing...' : 'Commit uploaded content'}
              </button>
            </div>
          </div>
        )
      ) : (
        <div ref={mduRef} className="space-y-4">
          {targetDealId ? targetDealExpired ? (
            <div className="rounded-none border border-destructive/40 bg-destructive/10 p-5">
              <div className="text-sm font-semibold text-destructive">Deal expired</div>
              <div className="mt-1 text-xs text-destructive/90">
                {targetDealExpiryMsg}
              </div>
            </div>
          ) : (
            <FileSharder
              dealId={targetDealId}
              onCommitSuccess={handleMduCommitSuccess}
              onWorkflowActiveChange={handleWorkflowActiveChange}
            />
          ) : (
            <div className="nil-inset rounded-none border-dashed p-10 text-center">
              <div className="text-sm font-semibold text-foreground">Select a deal to upload</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Choose a deal from the left to upload, list, and download files.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )

  const createDealDrawer = (
    <div ref={allocRef} className="flex h-full flex-col overflow-y-auto bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-border/40 px-6 py-5">
        <div>
          <div className="nil-section-label">/ALLOC/CREATE_DEAL</div>
          <div className="mt-2 text-sm font-semibold text-foreground">Create deal container</div>
          <p className="mt-1 text-[11px] font-mono-data text-muted-foreground">
            Allocate the container first, then upload content into it.
          </p>
        </div>
        <button
          type="button"
          data-testid="create-deal-close"
          onClick={closeCreateDealDrawer}
          disabled={dealLoading}
          className="nil-inset inline-flex items-center justify-center px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          Close
        </button>
      </div>

      <div className="space-y-4 px-6 py-5">
        {pendingCreateDealFeedback ? (
          <InlineNotice tone={pendingCreateDealFeedback.tone} title={pendingCreateDealFeedback.title} testId="create-deal-feedback">
            {pendingCreateDealFeedback.message}
          </InlineNotice>
        ) : createDealFeedback ? (
          <InlineNotice tone={createDealFeedback.tone} title={createDealFeedback.title} testId="create-deal-feedback">
            {createDealFeedback.message}
          </InlineNotice>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <div className="text-[11px] font-mono-data text-muted-foreground">
            Mode 2 is default for trusted devnet uploads.
          </div>
          <button
            type="button"
            data-testid="workspace-advanced-toggle"
            onClick={() => setShowAdvanced((value) => !value)}
            className="inline-flex items-center justify-center border border-primary/30 bg-primary/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary transition-colors hover:bg-primary/15"
          >
            {showAdvanced ? 'Hide Advanced' : 'Show Advanced'}
          </button>
        </div>

        <div className="flex flex-col gap-2">
          <label className="nil-section-label text-foreground">Duration</label>
          <select
            value={durationPreset}
            onChange={(e) => setDurationFromPreset(e.target.value)}
            className="recessed-input px-3 py-2 text-xs"
          >
            {DURATION_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <label className="nil-section-label text-foreground">Escrow</label>
            <input
              type="number"
              value={initialEscrow}
              onChange={(e) => setInitialEscrow(e.target.value)}
              className="recessed-input px-3 py-2 text-xs"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="nil-section-label text-foreground">Max Spend</label>
            <input
              type="number"
              value={maxMonthlySpend}
              onChange={(e) => setMaxMonthlySpend(e.target.value)}
              className="recessed-input px-3 py-2 text-xs"
            />
          </div>
        </div>

        <div className="nil-inset p-3 text-[10px]">
          <span className="font-bold uppercase text-primary">Redundancy:</span>
          <span className="ml-2 text-muted-foreground">Mode 2 (default RS {defaultRsLabel}).</span>
        </div>

        {showAdvanced ? (
          <div className="space-y-4 border border-border/40 bg-background/40 p-4">
            <div className="nil-section-label">/ALLOC/ADVANCED</div>
            <div className="flex flex-col gap-2">
              <label className="nil-section-label text-foreground">Placement Profile</label>
              <select
                value={placementProfile}
                onChange={(e) => setPlacementProfile(e.target.value as 'auto' | 'custom')}
                data-testid="alloc-placement-profile"
                className="recessed-input px-3 py-2 text-xs"
              >
                <option value="auto">Automatic</option>
                <option value="custom">Custom RS</option>
              </select>
            </div>

            {placementProfile === 'custom' ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-2">
                  <label className="nil-section-label text-foreground">RS K</label>
                  <input
                    type="number"
                    min="1"
                    value={rsK}
                    onChange={(e) => setRsK(e.target.value)}
                    className="recessed-input px-3 py-2 text-xs"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <label className="nil-section-label text-foreground">RS M</label>
                  <input
                    type="number"
                    min="1"
                    value={rsM}
                    onChange={(e) => setRsM(e.target.value)}
                    className="recessed-input px-3 py-2 text-xs"
                  />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <button
          onClick={handleCreateDealClick}
          disabled={dealLoading || !initialEscrow}
          data-testid="alloc-submit"
          className="w-full bg-primary py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {dealLoading ? 'Allocating...' : 'Create Deal Container'}
        </button>
      </div>
    </div>
  )

  return (
    <div className="px-4 pb-12 pt-24">
      <div className="container mx-auto max-w-6xl space-y-6">
      {/* TOP HEADER PANEL */}
      <div className="glass-panel industrial-border">
        <div className="flex items-end justify-between gap-6 border-b border-border/20 p-6">
          <div>
            <div className="nil-section-label leading-none">/DASHBOARD</div>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">Dashboard</h1>
          </div>
          <button
            type="button"
            onClick={() => setShowSystemStatus((prev) => !prev)}
            className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground transition-colors hover:text-foreground"
          >
            {showSystemStatus ? 'Hide diagnostics' : 'Show diagnostics'}
            {showSystemStatus ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
        {showSystemStatus ? (
          <div className="border-t border-border/10 px-6 pb-6 pt-6">
            {rpcMismatch ? (
              <div className="nil-inset border-destructive/30 bg-destructive/10 p-4">
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-destructive">
                  rpc_mismatch
                </div>
                <div className="mt-2 text-sm font-semibold text-foreground">Critical Node Mismatch</div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Your local RPC node is running on Chain ID <strong>{rpcChainId}</strong>, but the app expects <strong>{appConfig.chainId}</strong>.
                  Restart the local stack or repair the RPC endpoint before using this workspace.
                </p>
              </div>
            ) : null}
            <div className={rpcMismatch ? 'mt-6' : ''}>
              <StatusBar noBorder />
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
        {/* Sidebar: Registry + Recent Files */}
        <div className="min-w-0 order-1 lg:order-1 space-y-6">
          {/* Registry Panel */}
          <DashboardListCard
            badge="/REGISTRY/DEALS"
            description="Select container to manage files."
            actions={
              <>
                <button
                  type="button"
                  onClick={() => {
                    if (showCreateDeal) {
                      closeCreateDealDrawer()
                    } else {
                      openCreateDealDrawer()
                    }
                  }}
                  disabled={dealLoading}
                  className={cn(
                    'inline-flex items-center justify-center border border-primary px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data transition-colors',
                    showCreateDeal ? 'bg-primary/10 text-primary' : 'bg-transparent text-primary hover:bg-primary/5',
                    dealLoading && 'cursor-not-allowed opacity-50',
                  )}
                >
                  + New Deal
                </button>
                <button
                  type="button"
                  onClick={() => void handleRefreshSummary()}
                  title="Refresh deals"
                  className="nil-inset inline-flex items-center justify-center p-2 text-muted-foreground hover:bg-secondary"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </>
            }
          >

            <div className="border-b border-border/40 bg-card p-4">
              <label className="nil-section-label text-foreground">Deal filter</label>
              <input
                type="text"
                value={dealFilter}
                onChange={(event) => setDealFilter(event.target.value)}
                placeholder="Search by id or manifest root"
                className="recessed-input mt-2 w-full px-3 py-2 text-xs"
              />
            </div>

            {loading ? (
              <div className="text-center py-10">
                <div className="animate-spin rounded-none h-10 w-10 border-b-2 border-primary mx-auto mb-3"></div>
                <p className="text-sm text-muted-foreground uppercase tracking-widest font-black">Syncing...</p>
              </div>
            ) : (
              <div className="divide-y divide-border/30">
                {ownedDeals.length === 0 ? (
                  <EmptyStateCard title="No deals detected." compact />
                ) : filteredOwnedDeals.length === 0 ? (
                  <EmptyStateCard title="No deals match filter." compact />
                ) : (
                  <>
                    <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 border-b border-border/40 bg-card/80 px-4 py-2 text-[9px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                      <span>Deal</span>
                      <span>Status</span>
                      <span>Size</span>
                      <span>Last Activity</span>
                    </div>
                    {filteredOwnedDeals.map((deal) => {
                      const recent = recentActivityByDeal.get(String(deal.id))
                      const recentLabel = recent ? formatRelativeTime(recent.updatedAt) : '—'
                      const sizeNum = Number(deal.size)
                      const sizeLabel = formatBytes(sizeNum > 0 ? sizeNum : 0)
                      const isSelected = String(deal.id) === String(targetDealId || '')
                      return (
                        <DealRow
                          key={deal.id}
                          dealId={String(deal.id)}
                          isActive={Boolean(deal.cid)}
                          sizeLabel={sizeLabel}
                          lastActivityLabel={recentLabel}
                          selected={isSelected}
                          onClick={() => setTargetDealId(String(deal.id))}
                        />
                      )
                    })}
                  </>
                )}
              </div>
            )}
          </DashboardListCard>

        </div>

        {/* Workspace: Deal Detail + Advanced */}
        <div ref={workspaceRef} className="min-w-0 order-2 lg:order-2 space-y-6">
          <div ref={dealDetailRef} className="min-w-0">
            {ownedDeals.length === 0 ? (
              <div className="glass-panel industrial-border p-0" data-testid="deal-detail">
                <EmptyStateCard
                  icon={<Database className="w-12 h-12 text-muted-foreground" />}
                  title="Ready for Deal Creation"
                  className="p-12 opacity-40"
                />
              </div>
            ) : targetDeal ? (
              <DealDetail
                deal={targetDeal}
                polystoreAddress={polystoreAddress}
                onFileActivity={recordRecentActivity}
                topPanel={dealExplorerTopPanel}
                uploadWorkflowActive={selectedDealUploadActive}
                requestedTab={dealDetailRequestedTab ?? undefined}
                requestedTabNonce={dealDetailRequestedTabNonce}
              />
            ) : (
              <div className="glass-panel industrial-border p-0" data-testid="deal-detail">
                <div className="flex items-center justify-between p-6 border-b border-border/60 bg-card">
                  <div className="flex items-center gap-4">
                    <div className="nil-inset glass-panel industrial-border p-2.5">
                      <HardDrive className="w-6 h-6 text-primary" />
                    </div>
                    <div>
                      <div className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground/40">/STORAGE/EXPLORER</div>
                      <div className="text-xl font-bold text-foreground mt-1">Select a deal</div>
                    </div>
                  </div>
                </div>
                <EmptyStateCard title="Awaiting synchronization." className="p-12 opacity-40" />
              </div>
            )}
          </div>

          {showAdvanced && (
            <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
              {/* Advanced Retrieval Sessions Table */}
              <div className="glass-panel industrial-border overflow-hidden">
                <div className="px-6 py-3 border-b border-border/60 bg-card text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground/40">
                  /RETRIEVAL/SESSIONS --ACTIVE
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-border/40 text-xs">
                    <thead className="bg-card">
                      <tr>
                        <th className="px-4 py-2 text-left text-[9px] font-black text-muted-foreground/60 uppercase tracking-widest">Session</th>
                        <th className="px-4 py-2 text-right text-[9px] font-black text-muted-foreground/60 uppercase tracking-widest">Deal</th>
                        <th className="px-4 py-2 text-left text-[9px] font-black text-muted-foreground/60 uppercase tracking-widest">Status</th>
                        <th className="px-4 py-2 text-right text-[9px] font-black text-muted-foreground/60 uppercase tracking-widest">Transfer</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/40">
                      {retrievalSessions.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-6 py-8 text-center text-[10px] text-muted-foreground italic uppercase tracking-widest opacity-40">
                            No active retrieval sessions.
                          </td>
                        </tr>
                      ) : (
                        retrievalSessions.map((raw) => {
                          const s = raw as Record<string, unknown>
                          const status = formatSessionStatus(s['status'])
                          const totalBytes = formatBytesU64(s['total_bytes'])
                          return (
                            <tr key={String(s['session_id'])} className="hover:bg-secondary/40 transition-colors">
                              <td className="px-4 py-3 font-mono-data text-[10px] text-primary font-bold">
                                {String(s['session_id']).slice(0, 12)}...
                              </td>
                              <td className="px-4 py-3 text-right font-mono-data">{String(s['deal_id'])}</td>
                              <td className="px-4 py-3">
                                <span className="border border-border/40 bg-background/70 px-1.5 py-0.5 text-[9px] font-bold uppercase">
                                  {status}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-right font-mono-data">{totalBytes}</td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {showCreateDeal ? (
        <div className="fixed inset-0 z-40">
          <div
            data-testid="create-deal-overlay"
            className="absolute inset-0 bg-background/70 backdrop-blur-[1px]"
            onClick={closeCreateDealDrawer}
          />
          <aside data-testid="create-deal-drawer" className="absolute right-0 top-0 h-full w-full max-w-xl border-l border-border/40 shadow-2xl">
            {createDealDrawer}
          </aside>
        </div>
      ) : null}

      {downloadToast && (
        <div className="fixed bottom-8 right-8 z-50">
          <div className="flex items-center gap-3 glass-panel industrial-border px-5 py-3 text-[10px] font-black uppercase tracking-[0.3em] font-mono-data text-success border-success/40 bg-success/5 shadow-xl animate-in fade-in slide-in-from-right-8 duration-500">
            <CheckCircle2 className="h-4 w-4" />
            {downloadToast}
          </div>
        </div>
      )}
      </div>
    </div>
  )
}

function DashboardListCard({
  badge,
  description,
  actions,
  children,
}: {
  badge: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="glass-panel industrial-border">
      <div className="flex flex-col gap-3 border-b border-border/60 bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="nil-section-label leading-none">{badge}</div>
          {description ? (
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <div className="bg-secondary/30">{children}</div>
    </div>
  )
}

function DealRow({
  dealId,
  isActive,
  sizeLabel,
  lastActivityLabel,
  selected,
  onClick,
}: {
  dealId: string
  isActive: boolean
  sizeLabel: string
  lastActivityLabel: string
  selected?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      data-testid={`deal-row-${dealId}`}
      className={cn(
        'nil-list-row group grid w-full grid-cols-[1fr_auto_auto_auto] items-center gap-2 border-b border-border/20 bg-background/50 px-4 py-3 text-left last:border-b-0',
        selected && 'border-primary/30 bg-primary/10',
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="font-mono-data text-sm font-black text-foreground">#{dealId}</span>
      </div>
      <div>
        <span
          className={cn(
            'border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider',
            isActive ? 'border-success/20 bg-success/5 text-success' : 'border-border/20 bg-background/70 text-muted-foreground',
          )}
        >
          {isActive ? 'ACTIVE' : 'EMPTY'}
        </span>
      </div>
      <span className="font-mono-data text-[11px] text-muted-foreground">{sizeLabel}</span>
      <span className="font-mono-data text-[11px] text-muted-foreground">{lastActivityLabel}</span>
    </button>
  )
}

function EmptyStateCard({
  icon,
  title,
  description,
  compact = false,
  className,
}: {
  icon?: ReactNode
  title: string
  description?: string
  compact?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'text-center',
        compact ? 'px-6 py-8 text-[10px] italic uppercase tracking-widest text-muted-foreground opacity-40' : 'space-y-4',
        className,
      )}
    >
      {icon ? <div className="mx-auto mb-4 flex justify-center">{icon}</div> : null}
      <p className={cn(compact ? '' : 'text-[10px] font-black uppercase tracking-[0.2em]')}>{title}</p>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
    </div>
  )
}
