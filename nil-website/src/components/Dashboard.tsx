import { useAccount, useBalance, useChainId } from 'wagmi'
import { ethToNil } from '../lib/address'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Coins, RefreshCw, Wallet, CheckCircle2, ArrowDownRight, HardDrive, Database, ExternalLink, Copy } from 'lucide-react'
import { useConnectModal } from '@rainbow-me/rainbowkit'
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
import { FaucetAuthTokenInput } from './FaucetAuthTokenInput'
import { buildServiceHint, parseServiceHint } from '../lib/serviceHint'
import { maybeWrapNilceZstd } from '../lib/nilce'
import { hasBuildFaucetAuthToken } from '../lib/faucetAuthToken'
import { classifyWalletError } from '../lib/walletErrors'
import { lcdFetchDeals, lcdFetchParams } from '../api/lcdClient'
import type { LcdDeal as Deal, LcdParams } from '../domain/lcd'
import type { SlabLayoutData } from '../domain/nilfs'
import { toHexFromBase64OrHex } from '../domain/hex'
import { useTransportRouter } from '../hooks/useTransportRouter'
import { multiaddrToHttpUrl, multiaddrToP2pTarget } from '../lib/multiaddr'
import { useWalletNetworkGuard } from '../hooks/useWalletNetworkGuard'
import { Link } from 'react-router-dom'

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

const RECENT_FILES_KEY = 'nil_recent_files_v1'
const MAX_RECENT_FILES = 6
const RETRIEVAL_SESSIONS_POLL_MS = 120_000
const RETRIEVAL_SESSIONS_HIDDEN_POLL_MS = 600_000
const RETRIEVAL_PARAMS_POLL_MS = 600_000
const RETRIEVAL_PARAMS_HIDDEN_POLL_MS = 1_800_000
const PROOFS_POLL_MS = 120_000
const PROOFS_HIDDEN_POLL_MS = 600_000
const RPC_HEALTH_POLL_MS = 60_000
const RPC_HEALTH_HIDDEN_POLL_MS = 300_000
const LOCAL_DEMO_STACK_CMD = './scripts/ensure_stack_local.sh'

async function copyText(text: string) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  if (typeof document === 'undefined') {
    throw new Error('clipboard unavailable')
  }
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', 'true')
  el.style.position = 'fixed'
  el.style.top = '0'
  el.style.left = '0'
  el.style.opacity = '0'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
}

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
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { openConnectModal } = useConnectModal()
  const { requestFunds, loading: faucetLoading, lastTx: faucetTx, txStatus: faucetTxStatus } = useFaucet()
  const { submitDeal, loading: dealLoading, lastTx: createTx } = useCreateDeal()
  const { submitUpdate, loading: updateLoading, lastTx: updateTx } = useUpdateDealContent()
  const { upload, loading: uploadLoading } = useUpload()
  const { switchNetwork } = useNetwork()
  const {
    walletChainId,
    isWrongNetwork: walletIsWrongNetwork,
    genesisMismatch,
    accountPermissionMismatch,
    refresh: refreshWalletNetwork,
  } = useWalletNetworkGuard({ enabled: isConnected, pollMs: 15_000 })
  const [deals, setDeals] = useState<Deal[]>([])
  const [allDeals, setAllDeals] = useState<Deal[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(false)
  const [nilAddress, setNilAddress] = useState('')
  const [activeTab, setActiveTab] = useState<'content' | 'mdu'>('mdu')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [compressUploads, setCompressUploads] = useState(true)
  const [bankBalances, setBankBalances] = useState<{ atom?: string; stake?: string }>({})
  const { refetch: refetchEvm } = useBalance({
    address,
    chainId: appConfig.chainId,
  })
  const providerCount = providers.length
  const defaultRsLabel = `${appConfig.defaultRsK}+${appConfig.defaultRsM}`
  const defaultMode2Slots = appConfig.defaultRsK + appConfig.defaultRsM
  const activeChainId = walletChainId ?? chainId
  const isWrongNetwork = isConnected && walletIsWrongNetwork
  const walletReady = Boolean(isConnected && address && !accountPermissionMismatch && !isWrongNetwork)

  // Check if the RPC node itself is on the right chain
  const [rpcChainId, setRpcChainId] = useState<number | null>(null)
  const [rpcHeight, setRpcHeight] = useState<number | null>(null)
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
  const faucetBusy = faucetLoading || faucetTxStatus === 'pending'

  const handleSwitchNetwork = useCallback(async (options?: { forceAdd?: boolean }) => {
    try {
      await switchNetwork({ forceAdd: options?.forceAdd })
      await refreshWalletNetwork()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (e instanceof Error && e.message === 'GENESIS_MISMATCH_AFTER_SWITCH') {
        setStatusTone('error')
        setStatusMsg(
          `MetaMask is still using a different RPC for chain ${appConfig.chainId}. Open MetaMask > Networks > NilStore Devnet and set RPC URL to ${appConfig.evmRpc}, or remove/re-add the network.`,
        )
        return
      }
      alert(`Could not switch network. Please switch to Chain ID ${appConfig.chainId} manually.`)
    }
  }, [refreshWalletNetwork, switchNetwork])

  const handleRefreshSummary = async () => {
    if (!nilAddress) return
    await Promise.allSettled([fetchDeals(nilAddress), fetchBalances(nilAddress), fetchProviders(), refetchEvm?.()])
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
  const [stagedUpload, setStagedUpload] = useState<StagedUpload | null>(null)
  const [contentSlab, setContentSlab] = useState<SlabLayoutData | null>(null)
  const [, setContentSlabLoading] = useState(false)
  const [, setContentSlabError] = useState<string | null>(null)

  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [statusTone, setStatusTone] = useState<'neutral' | 'error' | 'success'>('neutral')
  const [walletReconnectHint, setWalletReconnectHint] = useState(false)
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([])
  const [recentDownloadId, setRecentDownloadId] = useState<string | null>(null)
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
  const [dealDetailRequestedTab, setDealDetailRequestedTab] = useState<'files' | 'info' | 'manifest' | 'heat' | null>(null)
  const [dealDetailRequestedTabNonce, setDealDetailRequestedTabNonce] = useState(0)
  const { proofs, loading: proofsLoading } = useProofs({
    enabled: Boolean(nilAddress),
    pollMs: PROOFS_POLL_MS,
    hiddenPollMs: PROOFS_HIDDEN_POLL_MS,
  })
  const { fetchFile, loading: downloading } = useFetch()
  const { listFiles, slab } = useTransportRouter()

  const handleWalletError = useCallback((error: unknown, fallback: string) => {
    const walletError = classifyWalletError(error, fallback)
    setStatusTone('error')
    setStatusMsg(walletError.message)
    if (walletError.reconnectSuggested) {
      setWalletReconnectHint(true)
    }
  }, [])

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
      setWalletReconnectHint(false)
    } catch (error) {
      handleWalletError(error, 'Wallet reconnection failed')
    }
  }, [handleWalletError, openConnectModal])

  useEffect(() => {
    if (accountPermissionMismatch) {
      setWalletReconnectHint(true)
      return
    }
    if (isConnected && address) {
      setWalletReconnectHint(false)
    }
  }, [accountPermissionMismatch, address, isConnected])

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
  const [retrievalSessionsLoading, setRetrievalSessionsLoading] = useState(false)
  const [retrievalSessionsError, setRetrievalSessionsError] = useState<string | null>(null)
  const [retrievalParams, setRetrievalParams] = useState<LcdParams | null>(null)
  const [retrievalParamsError, setRetrievalParamsError] = useState<string | null>(null)

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

  const retrievalCountsByDeal = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const proof of proofs) {
      if (!proof.valid) continue
      const dealId = String(proof.dealId || '').trim()
      if (!dealId) continue
      counts[dealId] = (counts[dealId] || 0) + 1
    }
    return counts
  }, [proofs])

  const bytesServedByDeal = useMemo(() => {
    const totals: Record<string, bigint> = {}
    for (const raw of retrievalSessions) {
      const session = raw as Record<string, unknown>
      const dealId = String(session['deal_id'] ?? '').trim()
      if (!dealId) continue
      totals[dealId] = (totals[dealId] || 0n) + parseUint64(session['total_bytes'])
    }
    return totals
  }, [retrievalSessions])

  const ownedDeals = useMemo(
    () => (nilAddress ? deals.filter((deal) => deal.owner === nilAddress) : deals),
    [deals, nilAddress],
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
    if (!nilAddress) return
    if (ownedDeals.length === 0) return
    const newestDeal = ownedDeals[ownedDeals.length - 1]
    if (!newestDeal?.id) return
    setTargetDealId(String(newestDeal.id))
  }, [nilAddress, ownedDeals, targetDealId])
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
  const createDealRequiredSlots = placementProfile === 'custom' ? mode2Config.slots : defaultMode2Slots

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
    setContentSlab(null)
    setContentSlabError(null)
    setContentSlabLoading(false)
  }, [targetDealId])

  useEffect(() => {
    const manifestRoot = targetDeal?.cid
    const owner = nilAddress || targetDeal?.owner || ''
    if (!manifestRoot || !targetDealId || !owner) {
      setContentSlab(null)
      setContentSlabError(null)
      setContentSlabLoading(false)
      return
    }

    let cancelled = false

    const load = async () => {
      setContentSlabLoading(true)
      setContentSlabError(null)
      try {
        const directBase = resolveProviderBase(targetDeal)
        const p2pTarget = appConfig.p2pEnabled ? resolveProviderP2pTarget(targetDeal) : undefined
        const slabResult = await slab({
          manifestRoot,
          dealId: targetDealId,
          owner,
          directBase,
          p2pTarget,
        })

        if (cancelled) return

        setContentSlab(slabResult.data)
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Failed to load deal content observables'
        if (!cancelled) {
          setContentSlab(null)
          setContentSlabError(msg)
        }
      } finally {
        if (!cancelled) {
          setContentSlabLoading(false)
        }
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [nilAddress, resolveProviderBase, resolveProviderP2pTarget, targetDeal, targetDeal?.cid, targetDealId, slab])

  useEffect(() => {
    if (address) {
      optimisticCidOverridesRef.current = {}
      const cosmosAddress = ethToNil(address)
      setNilAddress(cosmosAddress)
      fetchDeals(cosmosAddress)
      fetchBalances(cosmosAddress)
      fetchProviders()
    } else {
        optimisticCidOverridesRef.current = {}
        setDeals([])
        setAllDeals([])
        setProviders([])
    }
  }, [address])

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
        const dealRetrievals = retrievalCountsByDeal[deal.id] || 0
        const dealBytesServed = bytesServedByDeal[deal.id] || 0n
        entry.retrievals += dealRetrievals
        entry.bytesServed +=
          dealBytesServed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(dealBytesServed) : Number.MAX_SAFE_INTEGER
        byProvider.set(providerAddr, entry)
      }
    }

    return byProvider
  }, [allDeals, bytesServedByDeal, retrievalCountsByDeal])

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
    if (targetDealExpired) {
      setStatusTone('error')
      setStatusMsg(targetDealExpiryMsg || 'Deal is expired. Create a new deal to continue.')
      return
    }
    try {
      let uploadFile = file
      if (compressUploads) {
        setStatusTone('neutral')
        setStatusMsg('Compressing file (NilCE)...')
        const buf = new Uint8Array(await file.arrayBuffer())
        const wrapped = await maybeWrapNilceZstd(buf)
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

  const handleRequestFunds = async () => {
      if (!appConfig.faucetEnabled) {
        setStatusTone('error')
        setStatusMsg('Faucet is disabled in this build. Fund your wallet externally to continue.')
        return
      }
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
          const details = e instanceof Error ? e.message : String(e)
          if (/rate limit/i.test(details)) {
            setStatusMsg('Faucet is rate-limited. A previous request may already be processing; check balance before retrying.')
          } else {
            setStatusMsg(`Faucet request failed: ${details || 'Unknown error'}`)
          }
      }
  }

  const handleCreateDeal = async (evmCreator: string) => {
    if (!bankBalances.stake && !bankBalances.atom) {
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
          setTargetDealId(previousTargetDealId)
          return
        }
        if (64 % k !== 0) {
          setStatusTone('error')
          setStatusMsg('Custom Mode 2 profile requires K to divide 64.')
          setTargetDealId(previousTargetDealId)
          return
        }
        const slots = k + m
        if (providerCount === 0) {
          setStatusTone('error')
          setStatusMsg('Provider list not loaded yet. Retry in a few seconds.')
          setTargetDealId(previousTargetDealId)
          return
        }
        if (slots > providerCount) {
          setStatusTone('error')
          setStatusMsg(`Custom Mode 2 profile requires ${slots} providers (K+M), but only ${providerCount} are available.`)
          setTargetDealId(previousTargetDealId)
          return
        }
        serviceHint = buildServiceHint('General', { rsK: k, rsM: m })
      }
      if (autoMode2ProviderError) {
        setStatusTone('error')
        setStatusMsg(autoMode2ProviderError)
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
      setStatusTone('success')
      setStatusMsg(`Capacity Allocated. Deal ID: ${res.deal_id}. Now verify via content tab.`)
      if (nilAddress) {
        await refreshDealsAfterCreate(nilAddress, String(res.deal_id))
        await fetchBalances(nilAddress)
        // Auto-switch to content tab and pre-fill deal ID
        setTargetDealId(String(res.deal_id))
        setActiveTab('mdu')
      }
    } catch (e) {
      setTargetDealId(previousTargetDealId)
      handleWalletError(e, 'Deal allocation failed. Check gateway logs.')
    }
  }

  const handleCreateDealClick = async () => {
    if (!bankBalances.stake && !bankBalances.atom) {
      setStatusTone('error')
      setStatusMsg(
        appConfig.faucetEnabled
          ? 'You must request testnet NIL from the faucet before creating a storage deal.'
          : 'Your wallet needs funds before creating a storage deal.',
      )
      return
    }

    try {
      if (accountPermissionMismatch) {
        await requestWalletReconnect()
        return
      }
      if (!isConnected || !address) {
        openConnectModal?.()
        return
      }
      if (isWrongNetwork) {
        await switchNetwork().catch(() => undefined)
        return
      }
      if (!address || !address.startsWith('0x')) throw new Error('Connect wallet to create a deal.')
      await handleCreateDeal(address)
    } catch (e) {
      handleWalletError(e, 'Failed to connect wallet')
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
        if (nilAddress) await refreshDealsAfterContentCommit(nilAddress, targetDealId, manifestHex)
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

    if (nilAddress) {
      refreshDealsAfterContentCommit(nilAddress, dealId, manifestHex)
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

  // Content downloads are tracked via Recent Files and Deal Explorer download actions.

  useEffect(() => {
    if (!appConfig.faucetEnabled) return
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
          onClick={() => openConnectModal?.()}
          data-testid="connect-wallet"
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground rounded-md shadow transition-colors"
        >
          <Wallet className="w-4 h-4" />
          Connect Wallet
        </button>
      </div>
  )

  const onChainCid = String(targetDeal?.cid || '').trim()
  const walletAddressShort = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Not connected'

  const dealExplorerTopPanel = (
    <div className="p-5 space-y-4 bg-card">
      {showAdvanced ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <button
              type="button"
              onClick={() => setActiveTab((tab) => (tab === 'content' ? 'mdu' : 'content'))}
              data-testid="tab-content"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background/60 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Database className="h-3.5 w-3.5 text-muted-foreground" />
              {activeTab === 'content' ? 'Back to Upload' : 'Mode 1 (advanced)'}
            </button>
        </div>
      ) : null}

      {targetDealId ? (
        <div className="glass-panel industrial-border p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                Storage layout (MDUs)
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Education lives on{" "}
                <Link to="/technology?section=mdu-primer" className="text-primary hover:underline">
                  Technology
                </Link>
                .
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setDealDetailRequestedTab('manifest')
                  setDealDetailRequestedTabNonce((n) => n + 1)
                  setPendingScrollTarget('deal')
                }}
                className="inline-flex items-center gap-2 border border-border/70 bg-background/60 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground hover:bg-secondary"
                title="Jump to Deal Explorer → Manifest & MDUs"
              >
                Inspect MDUs
                <ArrowDownRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3 text-xs">
            <div className="glass-panel industrial-border px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Manifest root</div>
              <div className="mt-1 font-mono-data text-[11px] text-foreground truncate" title={contentManifestRoot || undefined}>
                {contentManifestRoot ? `${contentManifestRoot.slice(0, 18)}…` : 'Empty container'}
              </div>
            </div>

            <div className="glass-panel industrial-border px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Slab MDUs</div>
              <div className="mt-1 font-mono-data text-[11px] text-foreground">
                {contentSlab ? contentSlab.total_mdus : '—'}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground font-mono-data uppercase tracking-[0.2em]">
                {contentSlab ? `1 meta • ${contentSlab.witness_mdus} witness • ${contentSlab.user_mdus} user` : 'Fetch in Deal Explorer to derive.'}
              </div>
            </div>

            <div className="glass-panel industrial-border px-3 py-2">
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Mode</div>
              <div className="mt-1 text-[11px] text-foreground font-semibold font-mono-data">
                {isTargetDealMode2
                  ? `Mode 2 RS(${targetDealService.rsK ?? appConfig.defaultRsK},${targetDealService.rsM ?? appConfig.defaultRsM})`
                  : showAdvanced ? 'Mode 1 (gateway)' : 'Mode 2 (auto)'}
              </div>
              <div className="mt-1 text-[10px] text-muted-foreground font-mono-data uppercase tracking-[0.2em]">
                {(() => {
                  const k = targetDealService.rsK ?? appConfig.defaultRsK
                  const mdu = contentSlab?.mdu_size_bytes ?? 8 * 1024 * 1024
                  return isTargetDealMode2 && k ? `per-slot shard: ${formatBytes(Math.floor(mdu / k))}` : '—'
                })()}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === 'content' ? (
        !showAdvanced ? (
          <div
            ref={contentRef}
            className="glass-panel industrial-border px-4 py-3 text-[11px] font-mono-data text-muted-foreground flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
          >
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground dark:text-foreground/90">/gateway/tools</div>
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
              <div className="glass-panel industrial-border px-3 py-2 text-[11px] font-mono-data text-muted-foreground">
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
                <div className="glass-panel industrial-border px-3 py-2 text-[11px] font-mono-data text-primary ring-1 ring-primary/25">
                  This is a Mode 2 deal. Use the Upload tab (Mode 2).
                </div>
              )}
              {targetDealExpired && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
                  {targetDealExpiryMsg}
                </div>
              )}
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Select file</span>
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
                  className="h-3 w-3 rounded border-border text-primary focus:ring-primary/40"
                />
                Compress before upload (NilCE, recommended)
              </label>
              {stagedUpload && (
                <div className="glass-panel industrial-border px-3 py-2 text-[11px] text-muted-foreground space-y-1 font-mono-data">
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
                  <div className="text-accent flex items-center gap-2 font-mono-data text-[10px] uppercase tracking-[0.2em]">
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
                className="px-4 py-3 bg-primary hover:bg-primary/90 text-primary-foreground text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data shadow-[4px_4px_0px_0px_rgba(0,0,0,0.10)] dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.16)] disabled:opacity-50 transition-all"
              >
                {updateLoading ? 'Committing...' : 'Commit uploaded content'}
              </button>
            </div>
          </div>
        )
      ) : (
        <div ref={mduRef} className="space-y-4">
          {targetDealId ? targetDealExpired ? (
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-5">
              <div className="text-sm font-semibold text-destructive">Deal expired</div>
              <div className="mt-1 text-xs text-destructive/90">
                {targetDealExpiryMsg}
              </div>
            </div>
          ) : (
            <FileSharder dealId={targetDealId} onCommitSuccess={handleMduCommitSuccess} />
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-background/60 p-10 text-center">
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

  return (
    <div className="space-y-6 w-full max-w-6xl mx-auto px-4 pt-8">
      {rpcMismatch && (
        <div className="relative overflow-hidden glass-panel industrial-border p-4 flex items-center justify-between ring-1 ring-destructive/40">
          <div className="absolute inset-0 pointer-events-none animate-scan opacity-30" />
          <div className="flex items-center gap-3">
            <div className="p-2 bg-destructive/10 border border-destructive/30">
              <RefreshCw className="w-5 h-5 text-destructive" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-destructive">
                rpc_mismatch
              </div>
              <h3 className="mt-1 text-sm font-bold text-foreground">Critical Node Mismatch</h3>
              <p className="mt-1 text-[11px] font-mono-data text-muted-foreground">
                Your local RPC node is running on Chain ID <strong>{rpcChainId}</strong>, but the app expects <strong>{appConfig.chainId}</strong>.
                <br/>Please restart your local stack or check your <code>run_local_stack.sh</code> configuration.
              </p>
            </div>
          </div>
        </div>
      )}

      {isWrongNetwork && (
        <div className="relative overflow-hidden glass-panel industrial-border p-4 flex items-center justify-between ring-1 ring-primary/30">
          <div className="absolute inset-0 pointer-events-none animate-scan opacity-20" />
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 border border-primary/30">
              <RefreshCw className="w-5 h-5 text-primary" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-primary">
                wallet_network
              </div>
              <h3 className="mt-1 text-sm font-bold text-foreground">Wrong Network</h3>
              <p className="mt-1 text-[11px] font-mono-data text-muted-foreground">
                {genesisMismatch ? (
                  <>
                    Connected to Chain ID <strong>{activeChainId}</strong>, but this is a different network than the NilStore RPC.
                    We will reconfigure MetaMask to use the NilStore Devnet endpoint.
                  </>
                ) : (
                  <>
                    Connected to Chain ID <strong>{activeChainId}</strong>. App requires <strong>{appConfig.chainId}</strong> (NilStore Devnet).
                  </>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={() => void handleSwitchNetwork({ forceAdd: genesisMismatch })}
            className="px-4 py-3 bg-primary text-primary-foreground text-[10px] font-bold uppercase tracking-[0.2em] shadow-[4px_4px_0px_0px_rgba(0,0,0,0.12)] dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.18)] dark:drop-shadow-[0_0_8px_hsl(var(--primary)_/_0.30)] hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] transition-all"
          >
            {genesisMismatch ? 'Repair MetaMask Network' : 'Switch Network'}
          </button>
        </div>
      )}

      {statusMsg && (
        <div className={`relative overflow-hidden glass-panel industrial-border px-4 py-3 text-[11px] font-mono-data ${
          statusTone === 'error'
            ? 'text-destructive ring-1 ring-destructive/40'
            : statusTone === 'success'
            ? 'text-accent ring-1 ring-accent/40'
            : 'text-muted-foreground ring-1 ring-border/40'
        }`}>
          <div className="absolute inset-0 pointer-events-none animate-scan opacity-15" />
          {statusMsg}
        </div>
      )}

      {walletReconnectHint && (
        <div className="glass-panel industrial-border px-4 py-3 ring-1 ring-primary/25 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-primary">wallet_access</div>
            <div className="mt-1 font-semibold text-foreground">Wallet access needs refresh</div>
            <div className="mt-1 text-[11px] font-mono-data text-muted-foreground">
              If you switched accounts in MetaMask, reconnect and approve access for the active account.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void requestWalletReconnect()}
            className="inline-flex items-center justify-center border border-primary/30 bg-primary/10 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-primary hover:bg-primary/15"
          >
            Reconnect Wallet
          </button>
        </div>
      )}

      <div className="relative overflow-hidden glass-panel industrial-border shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.08)]" data-testid="dashboard-utility-bar">
          <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none" />
          <div className="relative grid gap-3 p-4 lg:grid-cols-2">
          <div className="glass-panel industrial-border px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground dark:text-foreground/90">/wallet/testnet_funds</div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div
                  className="truncate font-mono-data text-[11px] text-foreground"
                  data-testid="cosmos-identity"
                  title={nilAddress || undefined}
                >
                  {nilAddress ? `${nilAddress.slice(0, 12)}…${nilAddress.slice(-6)}` : '—'}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground font-mono-data">
                  Stake:{' '}
                  <span className="text-foreground" data-testid="cosmos-stake-balance">
                    {bankBalances.stake || '—'}
                  </span>
                </div>
              </div>
              {appConfig.faucetEnabled ? (
                <button
                  data-testid="faucet-request"
                  onClick={handleRequestFunds}
                  disabled={!address || faucetBusy}
                  className="inline-flex items-center gap-2 bg-primary px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-primary-foreground shadow-[4px_4px_0px_0px_rgba(0,0,0,0.10)] dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.16)] transition-all hover:translate-x-[-1px] hover:translate-y-[-1px] active:translate-x-[2px] active:translate-y-[2px] disabled:opacity-50 disabled:pointer-events-none"
                >
                  <Coins className="h-3.5 w-3.5" />
                  {faucetLoading ? 'Requesting…' : faucetTxStatus === 'pending' ? 'Pending…' : 'Get NIL'}
                </button>
              ) : (
                <span className="text-[11px] text-muted-foreground">Faucet off</span>
              )}
            </div>
          </div>

          <div className="glass-panel industrial-border px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground dark:text-foreground/90">/wallet/account</div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate font-mono-data text-[11px] text-foreground" title={address || undefined}>
                  {walletAddressShort}
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground font-mono-data">
                  {accountPermissionMismatch
                    ? 'Wallet access required'
                    : isWrongNetwork
                      ? `Wrong chain (${activeChainId})`
                      : `Chain ${activeChainId}`}
                </div>
              </div>
              {walletReconnectHint ? (
                <button
                  type="button"
                  onClick={() => void requestWalletReconnect()}
                  className="inline-flex items-center gap-2 border border-primary/30 bg-primary/10 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-primary hover:bg-primary/15"
                >
                  <Wallet className="h-3.5 w-3.5" />
                  Reconnect
                </button>
              ) : isWrongNetwork ? (
                <button
                  type="button"
                  onClick={() => void handleSwitchNetwork({ forceAdd: genesisMismatch })}
                  className="inline-flex items-center gap-2 border border-border bg-background/80 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground hover:bg-secondary"
                >
                  <Wallet className="h-3.5 w-3.5" />
                  Switch
                </button>
              ) : (
                <span className="inline-flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-accent">
                  <span className="h-2 w-2 rounded-full bg-accent pulse-status" />
                  Ready
                </span>
              )}
            </div>
          </div>

          </div>
        {faucetTx ? (
          <div className="border-t border-border/80 px-4 py-2 text-[11px] text-muted-foreground">
            Faucet tx: <span className="font-mono-data text-foreground">{faucetTx.slice(0, 10)}…</span>
          </div>
        ) : null}
      </div>

      <StatusBar />

      <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
      <div ref={workspaceRef} className="min-w-0 order-2 lg:order-2 space-y-6">
        {/* Workspace panel intentionally removed (Deal Explorer + FileSharder cover this). */}

          <div ref={dealDetailRef} className="min-w-0">
            {ownedDeals.length === 0 ? (
              <div className="glass-panel industrial-border p-0 overflow-hidden shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]" data-testid="deal-detail">
                <div className="p-8 text-center">
                  <div className="w-14 h-14 glass-panel industrial-border flex items-center justify-center mx-auto mb-4">
                    <HardDrive className="w-7 h-7 text-muted-foreground" />
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground dark:text-foreground/90">/mnt/storage_deals</div>
                  <div className="mt-2 text-sm font-semibold text-foreground">No deals yet</div>
                  <div className="mt-1 text-[11px] font-mono-data text-muted-foreground">Create a deal to start uploading files.</div>
                </div>
              </div>
            ) : targetDeal ? (
              <DealDetail
                deal={targetDeal}
                nilAddress={nilAddress}
                onFileActivity={recordRecentActivity}
                topPanel={dealExplorerTopPanel}
                requestedTab={dealDetailRequestedTab ?? undefined}
                requestedTabNonce={dealDetailRequestedTabNonce}
              />
            ) : (
              <div className="glass-panel industrial-border p-0 overflow-hidden shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]" data-testid="deal-detail">
                <div className="flex items-center justify-between p-5 border-b border-border/60 bg-background/40">
                  <div className="flex items-center gap-3">
                    <div className="glass-panel industrial-border p-2">
                      <HardDrive className="w-5 h-5 text-primary" />
                    </div>
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground dark:text-foreground/90">/mnt/deal_explorer</div>
                      <div className="text-lg font-bold text-foreground" data-testid="workspace-deal-title">
                        {targetDealId ? `Deal #${targetDealId}` : 'Select a deal'}
                      </div>
                      <div className="mt-1 text-[11px] font-mono-data text-muted-foreground">
                        Upload, list, and download files inside a deal.
                      </div>
                    </div>
                  </div>
                </div>
                <div className="border-b border-border">{dealExplorerTopPanel}</div>
                <div className="p-5 text-[11px] font-mono-data text-muted-foreground">
                  {targetDealId ? 'Loading deal details…' : 'Select a deal from the left to view files.'}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 order-1 lg:order-1 space-y-6">
          {appConfig.faucetEnabled && !hasBuildFaucetAuthToken() ? (
            <div className="overflow-hidden glass-panel industrial-border shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)] p-4">
              <FaucetAuthTokenInput />
            </div>
          ) : null}

          <div className="overflow-hidden glass-panel industrial-border shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]">
          <div className="px-6 py-3 border-b border-border/60 bg-background/40 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground dark:text-foreground/90">/registry/deals</div>
              <p className="text-[11px] font-mono-data text-muted-foreground mt-1">
                Select a deal to manage files (upload, list, download).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                data-testid="workspace-advanced-toggle"
                className={`inline-flex items-center justify-center border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data transition-colors ${
                  showAdvanced
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-border bg-background/60 text-muted-foreground hover:bg-secondary'
                }`}
              >
                Advanced
              </button>
              <button
                type="button"
                onClick={() => void handleRefreshSummary()}
                title="Refresh deals"
                className="inline-flex items-center justify-center border border-border bg-background/60 p-2 text-muted-foreground hover:bg-secondary"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

            {loading ? (
              <div className="text-center py-10">
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-primary mx-auto mb-3"></div>
                <p className="text-sm text-muted-foreground">Syncing with NilChain...</p>
              </div>
            ) : ownedDeals.length === 0 ? null : (
              <div className="p-2">
                <div className="space-y-1">
                  {ownedDeals.map((deal) => {
                    const isSelected = String(deal.id) === String(targetDealId || '')
                    const hint = parseServiceHint(deal.service_hint)
                    const retrievalCount = retrievalCountsByDeal[deal.id] ?? 0
                    const sizeNum = Number(deal.size)
                    const sizeLabel =
                      Number.isFinite(sizeNum) && sizeNum > 0 ? formatBytes(sizeNum) : '0 B'
                    const endBlockNum = Number(deal.end_block)
                    const dealExpired =
                      rpcHeight !== null && Number.isFinite(endBlockNum) ? rpcHeight > endBlockNum : false
                    return (
                      <button
                        key={deal.id}
                        type="button"
                        data-testid={`deal-row-${deal.id}`}
                        onClick={() => {
                          setTargetDealId(String(deal.id ?? ''))
                          if (!showAdvanced && activeTab === 'content') {
                            setActiveTab('mdu')
                          }
                          setPendingScrollTarget('workspace')
                        }}
                        className={`w-full border px-3 py-3 text-left transition-colors ${
                          isSelected
                            ? 'border-primary/40 bg-primary/10 ring-1 ring-primary/20'
                            : 'border-border/60 bg-background/60 hover:bg-secondary'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-semibold text-foreground">Deal #{deal.id}</div>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground font-mono-data uppercase tracking-[0.2em]">
                              <span className="border border-border/60 bg-background/60 px-2 py-0.5">
                                {deal.cid ? 'Active' : 'Empty'}
                              </span>
                              <span className="border border-border/60 bg-background/60 px-2 py-0.5">
                                {hint.mode === 'mode2' ? 'Mode 2' : 'Mode 1'}
                              </span>
                              <span className="border border-border/60 bg-background/60 px-2 py-0.5">
                                {sizeLabel}
                              </span>
                              {dealExpired && (
                                <span className="border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-destructive">
                                  Expired
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="shrink-0 text-[10px] text-muted-foreground font-mono-data uppercase tracking-[0.2em]">
                            <span className="text-foreground">{retrievalCount}</span>
                            <span className="ml-1 hidden sm:inline">retrievals</span>
                          </div>
                        </div>
                        <div
                          className="mt-2 truncate font-mono-data text-[10px] text-muted-foreground dark:text-foreground"
                          title={deal.cid || ''}
                          data-testid={`deal-manifest-${deal.id}`}
                        >
                          {deal.cid ? `${deal.cid.slice(0, 22)}…` : 'Manifest: —'}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

          <div ref={allocRef} className="border-t border-border/60 bg-background/30 px-6 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-bold font-mono-data text-muted-foreground dark:text-foreground/90 uppercase tracking-[0.2em]">/alloc/create_deal</div>
                <p className="mt-1 text-[11px] font-mono-data text-muted-foreground">
                  Allocate a new deal on NilChain. Deals act like buckets for files.
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-3 text-[11px]">
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Duration</span>
                <select
                  value={durationPreset}
                  onChange={(e) => {
                    setDurationFromPreset(e.target.value)
                  }}
                  data-testid="alloc-duration"
                  className="w-full recessed-input px-3 py-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                >
                  {DURATION_PRESETS.map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Duration (seconds)</span>
                <input
                  value={duration ?? ''}
                  onChange={(e) => setDuration(e.target.value ?? '')}
                  readOnly={durationPreset !== 'custom'}
                  data-testid="alloc-duration-seconds"
                  className="w-full recessed-input px-3 py-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Initial escrow</span>
                <input
                  defaultValue={initialEscrow ?? ''}
                  onChange={(e) => setInitialEscrow(e.target.value ?? '')}
                  data-testid="alloc-initial-escrow"
                  className="w-full recessed-input px-3 py-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Max monthly spend</span>
                <input
                  defaultValue={maxMonthlySpend ?? ''}
                  onChange={(e) => setMaxMonthlySpend(e.target.value ?? '')}
                  data-testid="alloc-max-monthly-spend"
                  className="w-full recessed-input px-3 py-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                />
              </label>

              {!showAdvanced ? (
                <div className="glass-panel industrial-border px-3 py-2 text-[11px] text-muted-foreground space-y-1">
                  <div>
                    <span className="font-semibold text-foreground">Redundancy:</span> Mode 2 (default RS {defaultRsLabel}, recommended)
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      Turn on Advanced to override K/M.
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Slots required:{' '}
                    <span className="font-mono-data text-foreground">{defaultMode2Slots}</span>
                    {' '}• Providers available:{' '}
                    <span className="font-mono-data text-foreground">{providerCount || '—'}</span>
                    {autoMode2ProviderError && (
                      <div className="mt-1 text-[11px] font-mono-data text-destructive">{autoMode2ProviderError}</div>
                    )}
                    {autoMode2ProviderError && (
                      <div className="mt-2 glass-panel industrial-border p-2 text-[11px] text-muted-foreground">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className="font-semibold text-foreground">Local demo quickstart:</span>{' '}
                            start chain + faucet + demo providers.
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void copyText(LOCAL_DEMO_STACK_CMD)}
                              className="inline-flex items-center gap-2 border border-border/70 bg-background/60 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground hover:bg-secondary"
                            >
                              <Copy className="h-3 w-3" /> Copy
                            </button>
                            <Link to="/sp-onboarding" className="inline-flex items-center gap-1 text-primary hover:underline">
                              SP onboarding <ExternalLink className="h-3 w-3" />
                            </Link>
                          </div>
                        </div>
                        <div className="mt-2 font-mono-data text-foreground">{LOCAL_DEMO_STACK_CMD}</div>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <label className="space-y-1">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">Placement profile</span>
                    <select
                      value={placementProfile}
                      onChange={(e) => setPlacementProfile((e.target.value as 'auto' | 'custom') || 'auto')}
                      data-testid="alloc-placement-profile"
                      className="w-full recessed-input px-3 py-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                    >
                      <option value="auto">Mode 2 (Default {defaultRsLabel}, recommended)</option>
                      <option value="custom">Mode 2 (Custom RS)</option>
                    </select>
                  </label>

                  {placementProfile === 'custom' && (
                    <div className="grid grid-cols-2 gap-3">
                      <label className="space-y-1">
                        <span className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">RS K (Data)</span>
                        <input
                          type="number"
                          min={1}
                          max={64}
                          defaultValue={rsK ?? ''}
                          onChange={(e) => setRsK(e.target.value ?? '')}
                          data-testid="alloc-rs-k"
                          className="w-full recessed-input px-3 py-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">RS M (Parity)</span>
                        <input
                          type="number"
                          min={1}
                          max={64}
                          defaultValue={rsM ?? ''}
                          onChange={(e) => setRsM(e.target.value ?? '')}
                          data-testid="alloc-rs-m"
                          className="w-full recessed-input px-3 py-2 text-[11px] focus:outline-none focus:ring-1 focus:ring-primary/30"
                        />
                      </label>
                    </div>
                  )}

                  {placementProfile === 'custom' && (
                    <div className="text-[11px] text-muted-foreground">
                      Slots required:{' '}
                      <span className="font-mono-data text-foreground">{mode2Config.slots ?? '—'}</span>
                      {' '}• Providers available:{' '}
                      <span className="font-mono-data text-foreground">{providerCount || '—'}</span>
                      {mode2Config.error && (
                        <div className="mt-1 text-[11px] font-mono-data text-destructive">{mode2Config.error}</div>
                      )}
                      {mode2Config.error && (
                        <div className="mt-2 glass-panel industrial-border p-2 text-[11px] text-muted-foreground">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="font-semibold text-foreground">Local demo quickstart:</span>{' '}
                              start chain + faucet + demo providers.
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void copyText(LOCAL_DEMO_STACK_CMD)}
                                className="inline-flex items-center gap-2 border border-border/70 bg-background/60 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground hover:bg-secondary"
                              >
                                <Copy className="h-3 w-3" /> Copy
                              </button>
                              <Link to="/sp-onboarding" className="inline-flex items-center gap-1 text-primary hover:underline">
                                SP onboarding <ExternalLink className="h-3 w-3" />
                              </Link>
                            </div>
                          </div>
                          <div className="mt-1 font-mono-data text-foreground">{LOCAL_DEMO_STACK_CMD}</div>
                        </div>
                      )}
                    </div>
                  )}
                  {placementProfile === 'auto' && (
                    <div className="text-[11px] text-muted-foreground">
                      Slots required:{' '}
                      <span className="font-mono-data text-foreground">{defaultMode2Slots}</span>
                      {' '}• Providers available:{' '}
                      <span className="font-mono-data text-foreground">{providerCount || '—'}</span>
                      {autoMode2ProviderError && (
                        <div className="mt-1 text-[11px] font-mono-data text-destructive">{autoMode2ProviderError}</div>
                      )}
                      {autoMode2ProviderError && (
                        <div className="mt-2 glass-panel industrial-border p-2 text-[11px] text-muted-foreground">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <span className="font-semibold text-foreground">Local demo quickstart:</span>{' '}
                              start chain + faucet + demo providers.
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => void copyText(LOCAL_DEMO_STACK_CMD)}
                                className="inline-flex items-center gap-2 border border-border/70 bg-background/60 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground hover:bg-secondary"
                              >
                                <Copy className="h-3 w-3" /> Copy
                              </button>
                              <Link to="/sp-onboarding" className="inline-flex items-center gap-1 text-primary hover:underline">
                                SP onboarding <ExternalLink className="h-3 w-3" />
                              </Link>
                            </div>
                          </div>
                          <div className="mt-2 font-mono-data text-foreground">{LOCAL_DEMO_STACK_CMD}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-start justify-between gap-3 pt-1">
                <div className="text-xs text-muted-foreground">
                  {createTx && (
                    <div className="text-accent flex items-center gap-2 font-mono-data text-[10px] uppercase tracking-[0.2em]">
                      <CheckCircle2 className="w-3 h-3" /> Alloc Tx: {createTx.slice(0, 10)}...
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <button
                    onClick={
                      accountPermissionMismatch
                        ? () => void requestWalletReconnect()
                        : isWrongNetwork
                          ? () => void handleSwitchNetwork({ forceAdd: genesisMismatch })
                          : handleCreateDealClick
                    }
                    disabled={dealLoading || Boolean(createDealProviderError)}
                    data-testid="alloc-submit"
                    className="px-4 py-3 bg-primary hover:bg-primary/90 text-primary-foreground text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data shadow-[4px_4px_0px_0px_rgba(0,0,0,0.10)] dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.16)] disabled:opacity-50 transition-all"
                  >
                    {dealLoading
                      ? 'Creating...'
                      : accountPermissionMismatch
                        ? 'Reconnect wallet'
                        : isWrongNetwork
                        ? 'Switch network'
                        : !walletReady
                            ? 'Connect wallet'
                            : 'Create deal'}
                  </button>
                  <div
                    data-testid="alloc-provider-guard"
                    className={createDealProviderError ? 'text-[11px] font-mono-data text-destructive text-right' : 'text-[11px] font-mono-data text-muted-foreground text-right'}
                  >
                    Need {createDealRequiredSlots ?? '—'} providers • Found {providerCount || 0}
                    {createDealProviderError ? ` • ${createDealProviderError}` : ''}
                  </div>
                </div>
              </div>
            </div>
          </div>
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
                  <div key={entry.id} className="glass-panel industrial-border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold text-foreground truncate font-mono-data" title={entry.filePath}>
                          {entry.filePath}
                        </div>
                        <div className="mt-1 text-[10px] text-muted-foreground font-mono-data uppercase tracking-[0.2em]">
                          Deal #{entry.dealId} • {formatBytes(entry.sizeBytes)} • {formatRelativeTime(entry.updatedAt)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRecentDownload(entry)}
                        disabled={isBusy}
                        className="inline-flex items-center gap-2 border border-primary/30 bg-primary/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary hover:bg-primary/15 disabled:opacity-50"
                      >
                        <ArrowDownRight className="w-3 h-3" />
                        {actionLabel}
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground font-mono-data uppercase tracking-[0.2em]">
                      <span className="border border-border/60 bg-background/60 px-2 py-0.5">
                        Last: {entry.lastAction}
                      </span>
                      <span className={`border px-2 py-0.5 ${
                        entry.status === 'failed'
                          ? 'border-destructive/40 text-destructive'
                          : entry.status === 'pending'
                            ? 'border-primary/40 text-primary'
                            : 'border-accent/40 text-accent'
                      }`}>
                        {entry.status}
                      </span>
                    </div>
                    {entry.error && (
                      <div className="mt-2 text-[10px] text-destructive font-mono-data truncate" title={entry.error}>
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
      </div>

      {showAdvanced ? (
        <div className="mt-6 overflow-hidden glass-panel industrial-border shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]">
          <div className="px-6 py-3 border-b border-border/60 bg-background/40 text-[10px] font-bold font-mono-data text-muted-foreground dark:text-foreground/90 uppercase tracking-[0.2em]">
            /net/routing --advanced
          </div>
          <div className="p-6 space-y-6">
          {proofs.length > 0 && (
            <div className="overflow-hidden glass-panel industrial-border">
              <div className="px-6 py-3 border-b border-border/60 bg-background/40 flex items-center justify-between">
                <span className="text-[10px] font-bold font-mono-data text-muted-foreground dark:text-foreground/90 uppercase tracking-[0.2em]">/obs/liveness</span>
                {proofsLoading && <span className="text-[10px] font-mono-data text-muted-foreground dark:text-foreground/90 uppercase tracking-[0.2em]">Syncing proofs…</span>}
              </div>
              <table className="min-w-full divide-y divide-border/40 text-xs">
                <thead className="bg-background/40">
                  <tr>
                    <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Deal</th>
                    <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Provider</th>
                    <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Block</th>
                    <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Valid</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {(() => {
                    const myDealIds = new Set(deals.map((d) => d.id))
                    const myProofs = proofs.filter((p) => p.dealId && myDealIds.has(p.dealId))
                    return (myProofs.length > 0 ? myProofs : proofs).slice(0, 10).map((p) => (
                      <tr key={p.id} className="hover:bg-secondary transition-colors">
                        <td className="px-4 py-2 text-foreground font-mono-data">
                          {p.dealId ? `#${p.dealId}` : '—'}
                        </td>
                        <td className="px-4 py-2 font-mono-data text-[10px] text-primary">
                          {p.creator ? `${p.creator.slice(0, 10)}...${p.creator.slice(-4)}` : '—'}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground dark:text-foreground font-mono-data">
                          {p.blockHeight || 0}
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`px-2 py-0.5 border text-[10px] font-bold font-mono-data uppercase tracking-[0.2em] ${
                              p.valid
                                ? 'border-accent/40 bg-accent/10 text-accent'
                                : 'border-destructive/40 bg-destructive/10 text-destructive'
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

          <div className="overflow-hidden glass-panel industrial-border">
            <div className="px-6 py-3 border-b border-border/60 bg-background/40 text-[10px] font-bold font-mono-data text-muted-foreground dark:text-foreground/90 uppercase tracking-[0.2em]">
              /registry/providers
            </div>
            <table className="min-w-full divide-y divide-border/40 text-xs" data-testid="providers-table">
              <thead className="bg-background/40">
                <tr>
                  <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Address</th>
                  <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Capabilities</th>
                  <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Status</th>
                  <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Endpoints</th>
                  <th className="px-4 py-2 text-right text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Deals</th>
                  <th className="px-4 py-2 text-right text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Active</th>
                  <th className="px-4 py-2 text-right text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Retrievals</th>
                  <th className="px-4 py-2 text-right text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Bytes Served</th>
                  <th className="px-4 py-2 text-right text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Total Storage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
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
                      <tr key={p.address} className="hover:bg-secondary transition-colors">
                        <td className="px-4 py-2 font-mono-data text-[10px] text-primary" title={p.address}>
                          {p.address.slice(0, 12)}...{p.address.slice(-6)}
                        </td>
                        <td className="px-4 py-2 text-foreground">{p.capabilities}</td>
                        <td className="px-4 py-2">
                          <span className="px-2 py-0.5 border border-accent/40 bg-accent/10 text-accent text-[10px] font-bold font-mono-data uppercase tracking-[0.2em]">
                            {p.status}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono-data text-[10px] text-muted-foreground dark:text-foreground">
                          {Array.isArray(p.endpoints) && p.endpoints.length > 0 ? (
                            <span title={p.endpoints.join('\n')}>{p.endpoints[0]}</span>
                          ) : (
                            <span className="italic">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right text-muted-foreground dark:text-foreground font-mono-data">{stats.assignedDeals}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground dark:text-foreground font-mono-data">{stats.activeDeals}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground dark:text-foreground font-mono-data">{stats.retrievals}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground dark:text-foreground font-mono-data">{formatBytes(stats.bytesServed)}</td>
                        <td className="px-4 py-2 text-right text-muted-foreground dark:text-foreground font-mono-data">
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

          {!showAdvanced ? (
            <div className="overflow-hidden glass-panel industrial-border shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]">
              <div className="px-6 py-3 border-b border-border/60 bg-background/40 text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">
                /retrieval/economics --advanced
              </div>
              <div className="px-6 py-4 grid grid-cols-1 gap-4 text-[11px] sm:grid-cols-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Base Fee</div>
                  <div className="mt-1 text-[11px] font-mono-data text-foreground">{formatCoin(retrievalParams?.base_retrieval_fee)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Per-Blob Fee</div>
                  <div className="mt-1 text-[11px] font-mono-data text-foreground">{formatCoin(retrievalParams?.retrieval_price_per_blob)}</div>
                </div>
                <div className="flex items-end gap-2 sm:justify-end">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced(true)}
                    className="inline-flex items-center gap-2 border border-border/70 bg-background/60 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground hover:bg-secondary"
                  >
                    Show Advanced
                    <ArrowDownRight className="h-4 w-4" />
                  </button>
                  <Link
                    to="/proofs"
                    className="inline-flex items-center gap-2 border border-border/70 bg-background/60 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground hover:bg-secondary"
                    title="View receipts, proofs, and sessions"
                  >
                    Proofs
                    <ArrowDownRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
              <div className="px-6 pb-4 text-[11px] font-mono-data text-muted-foreground">
                Fees and on-chain retrieval sessions are developer-focused. Use Advanced mode for full tables.
                {retrievalParamsError ? (
                  <span className="block mt-1 text-[11px] text-destructive">{retrievalParamsError}</span>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              <div className="overflow-hidden glass-panel industrial-border shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]">
                <div className="px-6 py-3 border-b border-border/60 bg-background/40 text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">
                  /retrieval/fees gamma-4
                </div>
                <div className="px-6 py-4 grid grid-cols-1 gap-4 text-[11px] sm:grid-cols-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Base Fee</div>
                    <div className="mt-1 text-[11px] font-mono-data text-foreground">{formatCoin(retrievalParams?.base_retrieval_fee)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Per-Blob Fee</div>
                    <div className="mt-1 text-[11px] font-mono-data text-foreground">{formatCoin(retrievalParams?.retrieval_price_per_blob)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">Burn Cut</div>
                    <div className="mt-1 text-[11px] font-mono-data text-foreground">{formatBps(retrievalParams?.retrieval_burn_bps)}</div>
                  </div>
                </div>
                <div className="px-6 pb-4 text-[11px] font-mono-data text-muted-foreground">
                  {retrievalFeeNote}
                  {retrievalParamsError ? (
                    <span className="block mt-1 text-[11px] text-destructive">{retrievalParamsError}</span>
                  ) : null}
                </div>
              </div>

              <div className="overflow-hidden glass-panel industrial-border shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]">
                <div className="px-6 py-3 border-b border-border/60 bg-background/40 text-[10px] font-bold font-mono-data text-muted-foreground dark:text-foreground/90 uppercase tracking-[0.2em]">
                  /retrieval/sessions
                </div>
                <table className="min-w-full divide-y divide-border/40 text-xs" data-testid="retrieval-sessions-table">
                  <thead className="bg-background/40">
                    <tr>
                      <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Session</th>
                      <th className="px-4 py-2 text-right text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Deal</th>
                      <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Provider</th>
                      <th className="px-4 py-2 text-left text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Status</th>
                      <th className="px-4 py-2 text-right text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Total Bytes</th>
                      <th className="px-4 py-2 text-right text-[10px] font-bold font-mono-data text-muted-foreground uppercase tracking-[0.2em]">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/40">
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
                            <span className="block mt-1 text-[11px] font-mono-data text-destructive">{retrievalSessionsError}</span>
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
                            className="hover:bg-secondary transition-colors"
                          >
                            <td className="px-4 py-2 font-mono-data text-[10px] text-primary" title={sessionHex || undefined}>
                              {shortSession}
                            </td>
                            <td className="px-4 py-2 text-right text-muted-foreground dark:text-foreground font-mono-data">{dealId || '—'}</td>
                            <td className="px-4 py-2 font-mono-data text-[10px] text-muted-foreground dark:text-foreground" title={provider || undefined}>
                              {provider ? `${provider.slice(0, 12)}…${provider.slice(-6)}` : '—'}
                            </td>
                            <td className="px-4 py-2 text-muted-foreground dark:text-foreground font-mono-data">{status}</td>
                            <td className="px-4 py-2 text-right text-muted-foreground dark:text-foreground font-mono-data">{totalBytes}</td>
                            <td className="px-4 py-2 text-right text-muted-foreground dark:text-foreground font-mono-data">{updatedHeight || '—'}</td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
          </div>
        </div>
      ) : null}

      {downloadToast && (
        <div className="fixed bottom-6 right-6 z-50">
          <div className="flex items-center gap-2 glass-panel industrial-border px-4 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-accent ring-1 ring-accent/30 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.10)] dark:shadow-[0_0_24px_hsl(var(--accent)_/_0.16)]">
            <CheckCircle2 className="h-4 w-4" />
            {downloadToast}
          </div>
        </div>
      )}

    </div>
  )
}
