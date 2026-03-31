import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Rocket,
  Server,
  Shield,
  Wallet,
} from 'lucide-react'

import { appConfig } from '../config'
import {
  lcdFetchLatestHeight,
  lcdFetchPendingProviderPairing,
  lcdFetchProviders,
  lcdFetchProvidersByOperator,
} from '../api/lcdClient'
import { providerFetchPublicStatus, type ProviderPublicStatusResponse } from '../api/providerClient'
import { FaucetAuthTokenInput } from '../components/FaucetAuthTokenInput'
import { PrimaryCtaAnchor } from '../components/PrimaryCta'
import { useNetwork } from '../hooks/useNetwork'
import { useOpenProviderPairing } from '../hooks/useOpenProviderPairing'
import { useSessionStatus } from '../hooks/useSessionStatus'
import {
  buildProviderAgentPrompt,
  buildProviderBootstrapCommand,
  buildProviderEndpointPlan,
  buildProviderHealthCommands,
  buildProviderPairCommand,
  evaluateProviderRunbookReadiness,
  findConfirmedProviderPairing,
  findProviderByAddress,
  pairingBlocksRemaining,
  pairingExpired,
  type ProviderEndpointInputMode,
  type ProviderHostMode,
} from '../lib/providerOnboarding'
import { createProviderPairingId } from '../lib/providerPairing'
import { extractProviderHttpBases } from '../lib/spDashboard'

const PROVIDER_DOCS_URL = 'https://github.com/Nil-Store/nil-store/blob/main/docs/ALPHA_PROVIDER_QUICKSTART.md'
const PROVIDER_PLAYBOOK_URL = 'https://github.com/Nil-Store/nil-store/blob/main/DEVNET_MULTI_PROVIDER.md'
const REPO_URL = 'https://github.com/Nil-Store/nil-store'
const LOCAL_HEALTH_URL = 'http://127.0.0.1:8091/health'
const PROVIDER_DRAFT_KEY = 'nilstore.provider-onboarding.v2'
const PROVIDER_AUTH_SESSION_KEY = 'nilstore.provider-onboarding.auth.v1'
const PAIRING_TTL_BLOCKS = 120

type PendingPairingState = Awaited<ReturnType<typeof lcdFetchPendingProviderPairing>>
type OperatorPairingsState = Awaited<ReturnType<typeof lcdFetchProvidersByOperator>>
type ProvidersState = Awaited<ReturnType<typeof lcdFetchProviders>>

type PublicHealthState =
  | { status: 'idle' }
  | { status: 'loading'; base: string }
  | { status: 'ok'; base: string; ms: number }
  | { status: 'error'; base: string; error: string }

type ProviderPublicStatusState = ProviderPublicStatusResponse | null

type StoredProviderDraft = {
  hostMode: ProviderHostMode
  endpointMode: ProviderEndpointInputMode
  endpointValue: string
  publicPort: string
  providerKey: string
  pairingId: string
  pairingTxHash: string
}

function loadStoredDraft(): StoredProviderDraft {
  if (typeof window === 'undefined') {
    return {
      hostMode: 'home-tunnel',
      endpointMode: 'domain',
      endpointValue: '',
      publicPort: '443',
      providerKey: 'provider1',
      pairingId: '',
      pairingTxHash: '',
    }
  }

  try {
    const raw = window.localStorage.getItem(PROVIDER_DRAFT_KEY)
    if (!raw) throw new Error('missing draft')
    const parsed = JSON.parse(raw) as Partial<StoredProviderDraft>
    return {
      hostMode: parsed.hostMode === 'public-vps' ? 'public-vps' : 'home-tunnel',
      endpointMode:
        parsed.endpointMode === 'ipv4' || parsed.endpointMode === 'multiaddr' || parsed.endpointMode === 'domain'
          ? parsed.endpointMode
          : 'domain',
      endpointValue: String(parsed.endpointValue || ''),
      publicPort: String(parsed.publicPort || '443'),
      providerKey: String(parsed.providerKey || 'provider1'),
      pairingId: String(parsed.pairingId || ''),
      pairingTxHash: String(parsed.pairingTxHash || ''),
    }
  } catch {
    return {
      hostMode: 'home-tunnel',
      endpointMode: 'domain',
      endpointValue: '',
      publicPort: '443',
      providerKey: 'provider1',
      pairingId: '',
      pairingTxHash: '',
    }
  }
}

function loadSessionAuthToken(): string {
  if (typeof window === 'undefined') return ''
  try {
    return String(window.sessionStorage.getItem(PROVIDER_AUTH_SESSION_KEY) || '')
  } catch {
    return ''
  }
}

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

function statusTone(state: 'ready' | 'pending' | 'action' | 'idle'): string {
  if (state === 'ready') return 'border-accent/40 bg-accent/10 text-accent'
  if (state === 'pending') return 'border-primary/40 bg-primary/10 text-primary'
  if (state === 'action') return 'border-destructive/40 bg-destructive/10 text-destructive'
  return 'border-border bg-background/60 text-muted-foreground'
}

function StatusPill({ label, state }: { label: string; state: 'ready' | 'pending' | 'action' | 'idle' }) {
  return (
    <span className={`inline-flex items-center gap-2 border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em] ${statusTone(state)}`}>
      {label}
    </span>
  )
}

function CopyButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 border border-border bg-background/60 px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
    >
      <Copy className="h-4 w-4" />
      {label}
    </button>
  )
}

const WALLET_ACCESS_REQUIRED_MESSAGE =
  'Wallet access is required. If you switched accounts in MetaMask, click Connect Wallet and approve access for the active account.'

export function SpOnboarding() {
  const storedDraft = useMemo(() => loadStoredDraft(), [])
  const { openConnectModal } = useConnectModal()
  const { switchNetwork } = useNetwork()
  const { openPairing, loading: openingPairing } = useOpenProviderPairing()
  const session = useSessionStatus()
  const {
    address,
    nilAddress,
    walletAddressShort,
    isConnected,
    hasFunds,
    balanceLabel,
    isWrongNetwork,
    walletChainId,
    genesisMismatch,
    needsReconnect,
    refreshWalletNetwork,
    faucetEnabled,
    faucetBusy,
    faucetTxStatus,
    requestFunds,
  } = session

  const [hostMode, setHostMode] = useState<ProviderHostMode>(storedDraft.hostMode)
  const [endpointMode, setEndpointMode] = useState<ProviderEndpointInputMode>(storedDraft.endpointMode)
  const [endpointValue, setEndpointValue] = useState(storedDraft.endpointValue)
  const [publicPort, setPublicPort] = useState(storedDraft.publicPort)
  const [providerKey, setProviderKey] = useState(storedDraft.providerKey)
  const [pairingId, setPairingId] = useState(storedDraft.pairingId)
  const [pairingTxHash, setPairingTxHash] = useState(storedDraft.pairingTxHash)
  const [authToken, setAuthToken] = useState(loadSessionAuthToken)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [latestHeight, setLatestHeight] = useState<number | null>(null)
  const [pendingPairing, setPendingPairing] = useState<PendingPairingState>(null)
  const [operatorPairings, setOperatorPairings] = useState<OperatorPairingsState>([])
  const [providers, setProviders] = useState<ProvidersState>([])
  const [loadingLiveState, setLoadingLiveState] = useState(false)
  const [publicStatus, setPublicStatus] = useState<ProviderPublicStatusState>(null)
  const [publicStatusError, setPublicStatusError] = useState<string | null>(null)
  const [loadingPublicStatus, setLoadingPublicStatus] = useState(false)
  const [healthProbe, setHealthProbe] = useState<PublicHealthState>({ status: 'idle' })

  useEffect(() => {
    if (hostMode === 'home-tunnel' && endpointMode === 'ipv4') {
      setEndpointMode('domain')
    }
  }, [hostMode, endpointMode])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const payload: StoredProviderDraft = {
      hostMode,
      endpointMode,
      endpointValue,
      publicPort,
      providerKey,
      pairingId,
      pairingTxHash,
    }
    window.localStorage.setItem(PROVIDER_DRAFT_KEY, JSON.stringify(payload))
  }, [endpointMode, endpointValue, hostMode, pairingId, pairingTxHash, providerKey, publicPort])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (authToken.trim()) {
      window.sessionStorage.setItem(PROVIDER_AUTH_SESSION_KEY, authToken)
    } else {
      window.sessionStorage.removeItem(PROVIDER_AUTH_SESSION_KEY)
    }
  }, [authToken])

  const endpointPlan = useMemo(
    () =>
      buildProviderEndpointPlan({
        hostMode,
        endpointMode,
        endpointValue,
        publicPort: Number(publicPort),
      }),
    [endpointMode, endpointValue, hostMode, publicPort],
  )

  const confirmedPairing = useMemo(
    () => findConfirmedProviderPairing(operatorPairings, pairingId),
    [operatorPairings, pairingId],
  )
  const providerRecord = useMemo(
    () => findProviderByAddress(providers, confirmedPairing?.provider ?? ''),
    [confirmedPairing?.provider, providers],
  )
  const onchainBases = useMemo(() => extractProviderHttpBases(providerRecord?.endpoints), [providerRecord?.endpoints])
  const effectivePublicBase = onchainBases[0] || endpointPlan?.publicBase || null
  const providerStatusDetail = publicStatus?.provider ?? null
  const providerDaemonStatusReady = String(publicStatus?.persona || '').trim().toLowerCase() === 'provider-daemon'
  const authoritativePublicBase = providerStatusDetail?.public_base || effectivePublicBase
  const pairingRemainingBlocks = pairingBlocksRemaining(pendingPairing, latestHeight)
  const pairingIsExpired = pairingExpired(pendingPairing, latestHeight)
  const hasAuthToken = Boolean(authToken.trim())
  const runbookReadiness = useMemo(
    () =>
      evaluateProviderRunbookReadiness({
        endpointPlan,
        pairingId,
        authToken,
      }),
    [authToken, endpointPlan, pairingId],
  )

  const walletReady = isConnected && !isWrongNetwork && !needsReconnect
  const funded = hasFunds || faucetTxStatus === 'confirmed'
  const walletInlineError =
    needsReconnect || String(error || '').includes('Wallet access is required.')
      ? WALLET_ACCESS_REQUIRED_MESSAGE
      : null
  const pageError = walletInlineError && error === walletInlineError ? null : error
  const canOpenPairing = walletReady && funded && Boolean(address)
  const bootstrapReady = runbookReadiness.ready
  const pairingLinked = Boolean(pairingId)
  const pairingConfirmed = Boolean(confirmedPairing)
  const providerRegistered = Boolean(providerRecord)
  const publicHealthReady = providerDaemonStatusReady
    ? Boolean(providerStatusDetail?.public_health_ok)
    : healthProbe.status === 'ok' && healthProbe.base === effectivePublicBase

  const bootstrapCommand = useMemo(
    () =>
      buildProviderBootstrapCommand({
        hostMode,
        endpointMode,
        endpointValue,
        publicPort: Number(publicPort),
        pairingId,
        providerKey,
        authToken,
      }),
    [authToken, endpointMode, endpointValue, hostMode, pairingId, providerKey, publicPort],
  )
  const healthCommands = useMemo(() => buildProviderHealthCommands(authoritativePublicBase), [authoritativePublicBase])
  const pairCommand = useMemo(
    () => (pairingLinked ? buildProviderPairCommand(providerKey, pairingId) : ''),
    [pairingId, pairingLinked, providerKey],
  )
  const agentPrompt = useMemo(
    () =>
      buildProviderAgentPrompt({
        pairingId,
        providerEndpoint: endpointPlan?.providerEndpoint,
        publicBase: authoritativePublicBase,
        providerKey,
      }),
    [authoritativePublicBase, endpointPlan?.providerEndpoint, pairingId, providerKey],
  )

  const handleCopy = useCallback(async (label: string, text: string) => {
    try {
      await copyText(text)
      setCopyStatus(`${label} copied.`)
      window.setTimeout(() => setCopyStatus(null), 1800)
    } catch {
      setCopyStatus(`Could not copy ${label}.`)
      window.setTimeout(() => setCopyStatus(null), 2200)
    }
  }, [])

  const refreshLiveState = useCallback(async () => {
    setLoadingLiveState(true)
    try {
      const [height, pending, pairings] = await Promise.all([
        lcdFetchLatestHeight(appConfig.lcdBase).catch(() => null),
        pairingId ? lcdFetchPendingProviderPairing(appConfig.lcdBase, pairingId).catch(() => null) : Promise.resolve(null),
        nilAddress ? lcdFetchProvidersByOperator(appConfig.lcdBase, nilAddress).catch(() => []) : Promise.resolve([]),
      ])

      setLatestHeight(height)
      setPendingPairing(pending)
      setOperatorPairings(pairings)

      if (pairings.length > 0) {
        const registryProviders = await lcdFetchProviders(appConfig.lcdBase).catch(() => [])
        setProviders(registryProviders)
      } else {
        setProviders([])
      }
    } finally {
      setLoadingLiveState(false)
    }
  }, [nilAddress, pairingId])

  const refreshPublicStatus = useCallback(async (base: string) => {
    const normalizedBase = String(base || '').trim().replace(/\/$/, '')
    if (!normalizedBase) {
      setPublicStatus(null)
      setPublicStatusError(null)
      setLoadingPublicStatus(false)
      return
    }

    setLoadingPublicStatus(true)
    try {
      const status = await providerFetchPublicStatus(normalizedBase)
      setPublicStatus(status)
      setPublicStatusError(null)
    } catch (statusError) {
      setPublicStatus(null)
      setPublicStatusError(statusError instanceof Error ? statusError.message : 'provider-daemon status unavailable')
    } finally {
      setLoadingPublicStatus(false)
    }
  }, [])

  const probePublicHealth = useCallback(async (base: string) => {
    const normalizedBase = String(base || '').trim().replace(/\/$/, '')
    if (!normalizedBase) {
      setHealthProbe({ status: 'idle' })
      return
    }

    const started = performance.now()
    setHealthProbe({ status: 'loading', base: normalizedBase })
    try {
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${normalizedBase}/health`, { signal: controller.signal })
      window.clearTimeout(timeout)
      if (!res.ok) {
        setHealthProbe({ status: 'error', base: normalizedBase, error: `HTTP ${res.status}` })
        return
      }
      setHealthProbe({ status: 'ok', base: normalizedBase, ms: Math.round(performance.now() - started) })
    } catch (probeError) {
      const message = probeError instanceof Error ? probeError.message : 'probe failed'
      setHealthProbe({ status: 'error', base: normalizedBase, error: message })
    }
  }, [])

  useEffect(() => {
    if (!pairingId && !nilAddress) {
      setPendingPairing(null)
      setOperatorPairings([])
      setProviders([])
      setLatestHeight(null)
      return
    }

    void refreshLiveState()
    const timer = window.setInterval(() => {
      void refreshLiveState()
    }, 8000)

    return () => window.clearInterval(timer)
  }, [nilAddress, pairingId, refreshLiveState])

  useEffect(() => {
    if (!effectivePublicBase || !pairingConfirmed) {
      setHealthProbe({ status: 'idle' })
      return
    }

    void probePublicHealth(effectivePublicBase)
    const timer = window.setInterval(() => {
      void probePublicHealth(effectivePublicBase)
    }, 12000)
    return () => window.clearInterval(timer)
  }, [effectivePublicBase, pairingConfirmed, probePublicHealth])

  useEffect(() => {
    if (!authoritativePublicBase) {
      setPublicStatus(null)
      setPublicStatusError(null)
      setLoadingPublicStatus(false)
      return
    }

    void refreshPublicStatus(authoritativePublicBase)
    const timer = window.setInterval(() => {
      void refreshPublicStatus(authoritativePublicBase)
    }, 12000)
    return () => window.clearInterval(timer)
  }, [authoritativePublicBase, refreshPublicStatus])

  const handleSwitchNetwork = async () => {
    setError(null)
    setNotice(null)
    try {
      await switchNetwork({ forceAdd: genesisMismatch })
      await refreshWalletNetwork()
    } catch (switchError) {
      const message = switchError instanceof Error ? switchError.message : 'Failed to switch network'
      setError(message)
    }
  }

  const handleOpenPairing = async () => {
    setError(null)
    setNotice(null)

    if (!address) {
      setError('Connect the operator wallet first.')
      return
    }
    if (!walletReady) {
      setError('Switch the wallet onto NilStore testnet before opening pairing.')
      return
    }
    if (!funded) {
      setError('Fund the operator wallet before opening pairing.')
      return
    }

    const height = latestHeight ?? (await lcdFetchLatestHeight(appConfig.lcdBase).catch(() => null))
    if (!height) {
      setError('Could not load the latest chain height from the LCD.')
      return
    }

    const nextPairingId = createProviderPairingId()
    const expiresAt = height + PAIRING_TTL_BLOCKS

    try {
      const result = await openPairing({ creator: address, pairingId: nextPairingId, expiresAt })
      setPairingId(result.pairing_id)
      setPairingTxHash(result.tx_hash)
      setPendingPairing({
        pairing_id: result.pairing_id,
        operator: nilAddress || result.operator,
        expires_at: String(expiresAt),
        opened_height: String(height),
      })
      setNotice('Pairing request opened on-chain. Copy the provider host commands now and finish the website-managed bootstrap flow.')
      await refreshLiveState()
    } catch (openError) {
      const message = openError instanceof Error ? openError.message : 'Could not open provider pairing'
      setError(message)
    }
  }

  const walletState: 'ready' | 'pending' | 'action' | 'idle' = !isConnected
    ? 'action'
    : needsReconnect || isWrongNetwork
      ? 'action'
      : funded
        ? 'ready'
        : 'pending'
  const pairingState: 'ready' | 'pending' | 'action' | 'idle' = pairingConfirmed
    ? 'ready'
    : pairingIsExpired
      ? 'action'
      : pendingPairing || openingPairing || (pairingId && !pairingConfirmed)
        ? 'pending'
        : 'idle'
  const providerState: 'ready' | 'pending' | 'action' | 'idle' = publicHealthReady
    ? 'ready'
    : providerRegistered
      ? 'pending'
      : pairingConfirmed
        ? 'pending'
        : bootstrapReady
          ? 'action'
          : 'idle'

  return (
    <div className="px-4 pb-12 pt-24">
      <div className="container mx-auto max-w-6xl">
        <section className="overflow-hidden glass-panel industrial-border p-8">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="max-w-3xl space-y-4">
              <div className="inline-flex items-center gap-2 border border-border bg-background/40 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                <Server className="h-4 w-4 text-primary" />
                <span className="font-mono-data text-foreground/80">/sp/onboarding</span>
              </div>
              <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">First Healthy Provider</h1>
              <p className="max-w-2xl text-muted-foreground">
                This is the web-first operator flow for bringing up a NilStore <span className="font-mono">provider-daemon</span>.
                Describe the provider endpoint, initialize and fund the key, open pairing from the browser,
                then bootstrap and verify registration and public health from the same screen.
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <PrimaryCtaAnchor href="#operator-flow" size="md" leftIcon={<Rocket className="h-4 w-4" />}>
                Start Flow
              </PrimaryCtaAnchor>
              <Link
                to="/sp-dashboard"
                className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
              >
                <Shield className="h-4 w-4" />
                Provider Console
              </Link>
              <a
                href={PROVIDER_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
              >
                <ExternalLink className="h-4 w-4" />
                Quickstart
              </a>
            </div>
          </div>

          <div className="mt-8 grid gap-4 border-t border-border/60 pt-6 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Operator wallet</div>
              <div className="flex items-center gap-2 text-sm text-foreground">
                <StatusPill label={walletReady && funded ? 'Ready' : !isConnected ? 'Connect' : funded ? 'Ready' : 'Fund'} state={walletState} />
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pairing</div>
              <div className="flex items-center gap-2 text-sm text-foreground">
                <StatusPill label={pairingConfirmed ? 'Confirmed' : pairingId ? 'Pending' : 'Idle'} state={pairingState} />
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider registration</div>
              <div className="flex items-center gap-2 text-sm text-foreground">
                <StatusPill label={providerRegistered ? 'On-chain' : pairingConfirmed ? 'Waiting' : 'Idle'} state={providerRegistered ? 'ready' : pairingConfirmed ? 'pending' : 'idle'} />
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Public health</div>
              <div className="flex items-center gap-2 text-sm text-foreground">
                <StatusPill
                  label={
                    publicHealthReady
                      ? providerDaemonStatusReady
                        ? 'Healthy (daemon)'
                        : 'Healthy (browser)'
                      : providerDaemonStatusReady && providerStatusDetail && !providerStatusDetail.public_health_ok
                        ? 'Unhealthy'
                        : healthProbe.status === 'error'
                          ? 'Unhealthy'
                          : 'Waiting'
                  }
                  state={
                    publicHealthReady
                      ? 'ready'
                      : providerDaemonStatusReady && providerStatusDetail && !providerStatusDetail.public_health_ok
                        ? 'action'
                        : healthProbe.status === 'error'
                          ? 'action'
                          : 'pending'
                  }
                />
              </div>
            </div>
          </div>
        </section>

        {pageError ? (
          <div className="mt-6 border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4" />
              <div>{pageError}</div>
            </div>
          </div>
        ) : null}

        {notice ? (
          <div className="mt-6 border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4" />
              <div>{notice}</div>
            </div>
          </div>
        ) : null}

        <div id="operator-flow" className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div className="space-y-6">
            <section className="glass-panel industrial-border p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">1. Operator wallet</div>
                  <h2 className="text-2xl font-semibold text-foreground">Connect, switch, and fund the browser wallet</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Pairing starts from the browser. The wallet must be connected to NilStore testnet and funded enough to send the pairing transaction.
                  </p>
                </div>
                <StatusPill label={walletReady && funded ? 'Ready' : 'Action needed'} state={walletState} />
              </div>

              {walletInlineError ? (
                <div className="mt-6 border border-destructive/40 bg-background px-4 py-4 shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
                  <div className="flex items-start gap-3">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <div className="space-y-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-destructive">Wallet permission required</div>
                      <p className="text-sm text-foreground">{walletInlineError}</p>
                      <p className="text-sm text-muted-foreground">
                        Reconnect the active MetaMask account in this step before trying pairing or funding again.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}

              <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
                <div className="space-y-3 text-sm text-muted-foreground">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="border border-border bg-background/40 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Wallet</div>
                      <div className="mt-2 font-mono-data text-foreground">{isConnected ? walletAddressShort : 'Not connected'}</div>
                    </div>
                    <div className="border border-border bg-background/40 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Nil address</div>
                      <div className="mt-2 break-all font-mono-data text-foreground">{nilAddress || '—'}</div>
                    </div>
                    <div className="border border-border bg-background/40 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Balance</div>
                      <div className="mt-2 font-mono-data text-foreground">{balanceLabel}</div>
                    </div>
                    <div className="border border-border bg-background/40 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Wallet chain</div>
                      <div className="mt-2 font-mono-data text-foreground">{walletChainId ?? '—'}</div>
                    </div>
                  </div>
                </div>
                <div className="flex min-w-[220px] flex-col gap-2">
                  {!isConnected ? (
                    <button
                      type="button"
                      onClick={() => openConnectModal?.()}
                      className="inline-flex items-center justify-center gap-2 bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90"
                    >
                      <Wallet className="h-4 w-4" />
                      Connect Wallet
                    </button>
                  ) : null}
                  {isWrongNetwork ? (
                    <button
                      type="button"
                      onClick={() => void handleSwitchNetwork()}
                      className="inline-flex items-center justify-center gap-2 border border-border bg-background/60 px-4 py-3 text-sm font-semibold text-foreground hover:bg-secondary/40"
                    >
                      <RefreshCw className="h-4 w-4" />
                      {genesisMismatch ? 'Repair Network Entry' : 'Switch To NilStore'}
                    </button>
                  ) : null}
                  {walletReady && !funded && faucetEnabled ? (
                    <button
                      type="button"
                      onClick={() => void requestFunds()}
                      disabled={faucetBusy}
                      className="inline-flex items-center justify-center gap-2 border border-border bg-background/60 px-4 py-3 text-sm font-semibold text-foreground hover:bg-secondary/40 disabled:opacity-50"
                    >
                      {faucetBusy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                      {faucetBusy ? 'Funding…' : 'Request Faucet Funds'}
                    </button>
                  ) : null}
                </div>
              </div>

              {walletReady && !funded && faucetEnabled ? <FaucetAuthTokenInput className="mt-4" /> : null}
            </section>

            <section className="glass-panel industrial-border p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">2. Pairing</div>
                  <h2 className="text-2xl font-semibold text-foreground">Open pairing on-chain from the browser</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Pairing is required for the website-managed onboarding flow on this page. If you want to bootstrap without pairing, use the manual quickstart and verify the provider outside the website first.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill label={pairingConfirmed ? 'Confirmed' : pendingPairing ? 'Pending' : 'Not opened'} state={pairingState} />
                  <button
                    type="button"
                    onClick={() => void refreshLiveState()}
                    className="inline-flex items-center gap-2 border border-border bg-background/60 px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                  >
                    <RefreshCw className={`h-4 w-4 ${loadingLiveState ? 'animate-spin' : ''}`} /> Refresh
                  </button>
                </div>
              </div>

              <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_240px]">
                <div className="min-w-0 space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="border border-border bg-background/40 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Latest height</div>
                      <div className="mt-2 font-mono-data text-foreground">{latestHeight ?? '—'}</div>
                    </div>
                    <div className="border border-border bg-background/40 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pairing ID</div>
                      <div className="mt-2 break-all font-mono-data text-foreground">{pairingId || '—'}</div>
                    </div>
                    <div className="border border-border bg-background/40 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Expires in</div>
                      <div className="mt-2 font-mono-data text-foreground">
                        {pairingRemainingBlocks === null ? '—' : `${pairingRemainingBlocks} blocks`}
                      </div>
                    </div>
                    <div className="border border-border bg-background/40 p-3">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pairing tx</div>
                      <div className="mt-2 break-all font-mono-data text-foreground">{pairingTxHash || '—'}</div>
                    </div>
                  </div>

                  {pairingConfirmed ? (
                    <div className="border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
                      Provider pairing confirmed. The operator wallet now owns <span className="font-mono">{confirmedPairing?.provider}</span>.
                    </div>
                  ) : pendingPairing ? (
                    <div className={`border px-4 py-3 text-sm ${pairingIsExpired ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-primary/30 bg-primary/10 text-primary'}`}>
                      {pairingIsExpired
                        ? 'The pairing session expired before the provider host confirmed it. Open a new pairing and copy a fresh provider host runbook.'
                        : 'Pairing is open on-chain. Run the provider host commands now so bootstrap can confirm pairing before expiry.'}
                    </div>
                  ) : (
                    <div className="border border-border bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                      Open pairing once the wallet is connected, on the right chain, and funded. This page does not track unpaired providers.
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-2 xl:min-w-[220px]">
                  <button
                    type="button"
                    onClick={() => void handleOpenPairing()}
                    disabled={!canOpenPairing || openingPairing}
                    className="inline-flex items-center justify-center gap-2 bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {openingPairing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                    {pairingId ? 'Open New Pairing' : 'Open Pairing'}
                  </button>
                  <div className="border border-border bg-background/40 px-3 py-3 text-xs text-muted-foreground">
                    Pairing TTL: <span className="font-mono text-foreground">{PAIRING_TTL_BLOCKS}</span> blocks. Draft state is saved locally in this browser; the provider auth token is kept only in this browser session.
                  </div>
                </div>
              </div>
            </section>

            <section className="glass-panel industrial-border p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">3. Provider host</div>
                  <h2 className="text-2xl font-semibold text-foreground">Describe the public endpoint and provider-daemon key</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    The provider-host runbook is opinionated: canonical public testnet defaults are built in. You provide the endpoint, provider key, and the shared provider auth token from the hub operator. Pairing is required for this website-managed flow.
                  </p>
                </div>
                <StatusPill label={endpointPlan ? 'Endpoint ready' : 'Need endpoint'} state={endpointPlan ? 'ready' : 'action'} />
              </div>

              <div className="mt-6 space-y-5">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Host type</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setHostMode('home-tunnel')}
                      className={`border px-3 py-2 text-sm font-semibold ${hostMode === 'home-tunnel' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/60 text-foreground hover:bg-secondary/40'}`}
                    >
                      Home server + tunnel
                    </button>
                    <button
                      type="button"
                      onClick={() => setHostMode('public-vps')}
                      className={`border px-3 py-2 text-sm font-semibold ${hostMode === 'public-vps' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/60 text-foreground hover:bg-secondary/40'}`}
                    >
                      Public VPS
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Endpoint input</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setEndpointMode('domain')}
                      className={`border px-3 py-2 text-sm font-semibold ${endpointMode === 'domain' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/60 text-foreground hover:bg-secondary/40'}`}
                    >
                      Hostname
                    </button>
                    <button
                      type="button"
                      onClick={() => setEndpointMode('ipv4')}
                      disabled={hostMode === 'home-tunnel'}
                      className={`border px-3 py-2 text-sm font-semibold ${endpointMode === 'ipv4' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/60 text-foreground hover:bg-secondary/40'} disabled:opacity-40`}
                    >
                      IPv4
                    </button>
                    <button
                      type="button"
                      onClick={() => setEndpointMode('multiaddr')}
                      className={`border px-3 py-2 text-sm font-semibold ${endpointMode === 'multiaddr' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/60 text-foreground hover:bg-secondary/40'}`}
                    >
                      Full multiaddr
                    </button>
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="space-y-2 text-sm">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                      {endpointMode === 'multiaddr'
                        ? 'Provider endpoint'
                        : endpointMode === 'ipv4'
                          ? 'Public IPv4'
                          : 'Public hostname'}
                    </span>
                    <input
                      value={endpointValue}
                      onChange={(event) => setEndpointValue(event.target.value)}
                      placeholder={endpointMode === 'multiaddr' ? '/dns4/sp.example.com/tcp/443/https' : endpointMode === 'ipv4' ? '203.0.113.10' : 'sp.example.com'}
                      className="w-full border border-border bg-background/60 px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                    />
                  </label>
                  <label className="space-y-2 text-sm">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Public port</span>
                    <input
                      value={publicPort}
                      onChange={(event) => setPublicPort(event.target.value.replace(/[^0-9]/g, ''))}
                      placeholder="443"
                      disabled={endpointMode === 'multiaddr'}
                      className="w-full border border-border bg-background/60 px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
                    />
                  </label>
                  <label className="space-y-2 text-sm">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider key name</span>
                    <input
                      value={providerKey}
                      onChange={(event) => setProviderKey(event.target.value)}
                      placeholder="provider1"
                      className="w-full border border-border bg-background/60 px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                    />
                  </label>
                  <label className="space-y-2 text-sm">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Shared provider auth token</span>
                    <input
                      data-testid="provider-auth-token"
                      value={authToken}
                      onChange={(event) => setAuthToken(event.target.value)}
                      placeholder="Paste token for provider host commands"
                      type="password"
                      className="w-full border border-border bg-background/60 px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                    />
                  </label>
                </div>

                <div className="grid gap-2 border border-border bg-background/40 p-4 text-sm text-muted-foreground sm:grid-cols-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Derived provider endpoint</div>
                    <div className="mt-2 break-all font-mono-data text-foreground">{endpointPlan?.providerEndpoint || '—'}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Public health</div>
                    <div className="mt-2 break-all font-mono-data text-foreground">{endpointPlan?.publicHealthUrl || '—'}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Local health</div>
                    <div className="mt-2 break-all font-mono-data text-foreground">{LOCAL_HEALTH_URL}</div>
                  </div>
                </div>
              </div>
            </section>

            <section className="glass-panel industrial-border p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">4. Verification</div>
                  <h2 className="text-2xl font-semibold text-foreground">Watch pairing, registration, and public health converge</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    After the provider host runs bootstrap, this page should move from pending pairing to paired provider, then to on-chain registration, then to healthy daemon-reported public reachability. The direct browser <span className="font-mono">/health</span> probe is only advisory.
                  </p>
                </div>
                <StatusPill label={publicHealthReady ? 'Healthy' : providerState === 'pending' ? 'In progress' : 'Waiting'} state={providerState} />
              </div>

              <div className="mt-6 space-y-4 text-sm">
                  <div className="border border-border bg-background/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pairing confirmation</div>
                      <div className="mt-1 text-foreground">
                        {confirmedPairing
                          ? `Confirmed for provider ${confirmedPairing.provider}`
                          : pairingId
                            ? 'Waiting for provider host to confirm pairing'
                            : 'Open pairing first; unpaired providers are not tracked on this page'}
                      </div>
                    </div>
                    <StatusPill label={confirmedPairing ? 'Confirmed' : pairingId ? 'Waiting' : 'Idle'} state={confirmedPairing ? 'ready' : pairingId ? 'pending' : 'idle'} />
                  </div>
                </div>

                <div data-testid="provider-status-card" className="border border-border bg-background/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">On-chain registration</div>
                      <div className="mt-1 text-foreground">
                        {providerRecord
                          ? providerRecord.endpoints?.join(', ') || 'Provider exists without endpoints'
                          : confirmedPairing
                            ? 'Pairing confirmed. Waiting for bootstrap to register or update endpoints.'
                            : 'Website registration tracking starts after pairing confirmation.'}
                      </div>
                    </div>
                    <StatusPill label={providerRecord ? 'Visible' : confirmedPairing ? 'Waiting' : 'Idle'} state={providerRecord ? 'ready' : confirmedPairing ? 'pending' : 'idle'} />
                  </div>
                </div>

                <div data-testid="provider-daemon-status-card" className="border border-border bg-background/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider-daemon status</div>
                      <div className="mt-1 text-foreground">
                        {providerDaemonStatusReady
                          ? providerStatusDetail?.public_health_ok
                            ? `${providerStatusDetail.public_health_url || `${authoritativePublicBase || effectivePublicBase}/health`} is reachable from the provider-daemon host`
                            : `${providerStatusDetail?.public_health_url || `${authoritativePublicBase || effectivePublicBase || 'public base unavailable'}/health`} is not reachable from the provider-daemon host`
                          : authoritativePublicBase
                            ? loadingPublicStatus
                              ? `Polling ${authoritativePublicBase}/status`
                              : publicStatusError
                                ? `/status failed at ${authoritativePublicBase}: ${publicStatusError}`
                                : `Waiting for ${authoritativePublicBase}/status to identify a provider-daemon`
                            : 'Waiting for a public base URL from your endpoint draft or on-chain registration'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill
                        label={
                          providerDaemonStatusReady
                            ? providerStatusDetail?.public_health_ok
                              ? 'Healthy'
                              : 'Failed'
                            : loadingPublicStatus
                              ? 'Polling'
                              : publicStatusError
                                ? 'Unavailable'
                                : 'Waiting'
                        }
                        state={
                          providerDaemonStatusReady
                            ? providerStatusDetail?.public_health_ok
                              ? 'ready'
                              : 'action'
                            : publicStatusError
                              ? 'action'
                              : 'pending'
                        }
                      />
                      {authoritativePublicBase ? (
                        <button
                          type="button"
                          onClick={() => void refreshPublicStatus(authoritativePublicBase)}
                          className="inline-flex items-center gap-2 border border-border bg-background/60 px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                        >
                          <RefreshCw className={`h-4 w-4 ${loadingPublicStatus ? 'animate-spin' : ''}`} /> Refresh
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div data-testid="provider-browser-health-card" className="border border-border bg-background/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Direct browser health probe</div>
                      <div className="mt-1 text-foreground">
                        {healthProbe.status === 'ok'
                          ? `${healthProbe.base}/health responded in ${healthProbe.ms}ms`
                          : healthProbe.status === 'error'
                            ? `${healthProbe.base}/health failed: ${healthProbe.error}`
                            : effectivePublicBase
                              ? `Waiting to probe ${effectivePublicBase}/health`
                              : 'Waiting for a public base URL from your endpoint draft or on-chain registration'}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusPill
                        label={healthProbe.status === 'ok' ? 'Healthy' : healthProbe.status === 'error' ? 'Failed' : 'Idle'}
                        state={healthProbe.status === 'ok' ? 'ready' : healthProbe.status === 'error' ? 'action' : 'idle'}
                      />
                      {effectivePublicBase ? (
                        <button
                          type="button"
                          onClick={() => void probePublicHealth(effectivePublicBase)}
                          className="inline-flex items-center gap-2 border border-border bg-background/60 px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                        >
                          <RefreshCw className={`h-4 w-4 ${healthProbe.status === 'loading' ? 'animate-spin' : ''}`} /> Probe
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>

                {publicStatus?.issues?.length ? (
                  <div className="border border-destructive/30 bg-destructive/5 p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-destructive">Provider-daemon issues</div>
                    <div className="mt-3 space-y-2 text-sm text-destructive">
                      {publicStatus.issues.map((issue) => (
                        <div key={issue}>{issue}</div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="mt-5 grid gap-3 border-t border-border/60 pt-5 sm:grid-cols-2">
                <div className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                  <div className="font-semibold text-foreground">When pairing is still pending</div>
                  <div className="mt-2">
                    The provider host has not confirmed the pairing request yet. Re-copy the provider host runbook if the pairing ID changed, then rerun <span className="font-mono">./scripts/run_devnet_provider.sh pair</span> if the host is already configured, or rerun <span className="font-mono">./scripts/run_devnet_provider.sh bootstrap</span> on the provider host once the key is funded.
                  </div>
                </div>
                <div className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                  <div className="font-semibold text-foreground">When health is failing</div>
                  <div className="mt-2">
                    Treat the direct browser probe as advisory. Prioritize the provider-daemon <span className="font-mono">/status</span> view plus the doctor, verify, and local curl commands from the command rail before assuming the provider itself is down.
                  </div>
                </div>
              </div>
            </section>
          </div>

          <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
            <section className="glass-panel industrial-border overflow-hidden">
              <div className="border-b border-border/60 px-6 py-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Command rail</div>
                    <h2 className="mt-2 text-2xl font-semibold text-foreground">Provider host runbook</h2>
                  </div>
                <StatusPill label={bootstrapReady ? 'Command ready' : 'Waiting'} state={bootstrapReady ? 'ready' : 'pending'} />
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                  New provider keys need an init-and-fund step before bootstrap. The auth token is kept only in this browser session so refreshes can resume, but it is not written to the long-lived onboarding draft.
              </p>
              </div>

              <div className="space-y-5 px-6 py-5">
                {!hasAuthToken ? (
                  <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    Add the shared provider auth token from the hub operator before copying provider host commands.
                  </div>
                ) : null}
                {!pairingLinked ? (
                  <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                    Open pairing first. This website-managed flow only generates run-ready commands after pairing is opened.
                  </div>
                ) : null}
                <div className="grid gap-3 border-b border-border/60 pb-5 text-sm text-muted-foreground">
                  <div className="flex items-center justify-between gap-3">
                    <span>Pairing ID</span>
                    <span className="font-mono-data text-foreground">{pairingLinked ? pairingId : 'required'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Provider endpoint</span>
                    <span className="max-w-[240px] break-all text-right font-mono-data text-foreground">{endpointPlan?.providerEndpoint || '—'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Public health</span>
                    <span className="max-w-[240px] break-all text-right font-mono-data text-foreground">{effectivePublicBase ? `${effectivePublicBase}/health` : '—'}</span>
                  </div>
                </div>

                {bootstrapReady ? (
                  <>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-foreground">Provider host commands</div>
                        <CopyButton label="Copy" onClick={() => void handleCopy('Provider host commands', bootstrapCommand)} />
                      </div>
                      <pre data-testid="provider-host-commands" className="overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{bootstrapCommand}</pre>
                    </div>

                    {pairingLinked ? (
                      <div className="space-y-3 border-t border-border/60 pt-5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-foreground">Pair-only repair</div>
                          <CopyButton label="Copy" onClick={() => void handleCopy('Pair-only repair', pairCommand)} />
                        </div>
                        <pre className="overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{pairCommand}</pre>
                      </div>
                    ) : null}

                    <div className="space-y-3 border-t border-border/60 pt-5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-foreground">Verification commands</div>
                        <CopyButton label="Copy" onClick={() => void handleCopy('Verification commands', healthCommands)} />
                      </div>
                      <pre className="overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{healthCommands}</pre>
                    </div>

                    <details className="border-t border-border/60 pt-5">
                      <summary className="cursor-pointer text-sm font-semibold text-foreground">Agent prompt</summary>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Use this when a coding agent is running on the provider host and you want it to execute the bootstrap and repair loop directly.
                      </p>
                      <div className="mt-3 flex justify-end">
                        <CopyButton label="Copy" onClick={() => void handleCopy('Agent prompt', agentPrompt)} />
                      </div>
                      <pre className="mt-3 overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{agentPrompt}</pre>
                    </details>
                  </>
                ) : (
                  <div className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                    {runbookReadiness.missing.includes('endpoint')
                      ? 'Describe the public endpoint to generate the provider host runbook.'
                      : runbookReadiness.missing.includes('pairing')
                        ? 'Open pairing from the browser before this page will generate run-ready provider host commands.'
                        : 'Add the shared provider auth token from the hub operator before this page will generate run-ready provider host commands.'}
                  </div>
                )}

                <div className="flex flex-wrap gap-3 border-t border-border/60 pt-5">
                  <Link
                    to="/sp-dashboard"
                    className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                  >
                    <Shield className="h-4 w-4" />
                    Provider Console
                  </Link>
                  <a
                    href={PROVIDER_PLAYBOOK_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Operator Playbook
                  </a>
                  <a
                    href={REPO_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                  >
                    <ExternalLink className="h-4 w-4" />
                    Repo
                  </a>
                </div>
              </div>
            </section>

            {copyStatus ? (
              <div className="border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">{copyStatus}</div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  )
}
