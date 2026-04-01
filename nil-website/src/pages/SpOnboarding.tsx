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
  lcdFetchPendingProviderLinksByOperator,
  lcdFetchProviders,
  lcdFetchProvidersByOperator,
} from '../api/lcdClient'
import { providerFetchPublicStatus, type ProviderPublicStatusResponse } from '../api/providerClient'
import { FaucetAuthTokenInput } from '../components/FaucetAuthTokenInput'
import { PrimaryCtaAnchor, PrimaryCtaButton } from '../components/PrimaryCta'
import { useApproveProviderLink } from '../hooks/useApproveProviderLink'
import { useNetwork } from '../hooks/useNetwork'
import { useSessionStatus } from '../hooks/useSessionStatus'
import {
  buildProviderAgentPrompt,
  buildProviderBootstrapCommand,
  buildCloudflareTunnelBootstrapCommand,
  buildProviderEndpointPlan,
  buildProviderHealthCommands,
  buildProviderLinkCommand,
  findConfirmedProviderPairing,
  findMostRecentPendingProviderLink,
  findProviderByAddress,
  type ProviderEndpointInputMode,
  type ProviderHostMode,
} from '../lib/providerOnboarding'
import { buildProviderOnboardingFlow } from '../lib/providerOnboardingFlow'
import { extractProviderHttpBases } from '../lib/spDashboard'

const PROVIDER_DOCS_URL = 'https://github.com/Nil-Store/nil-store/blob/main/docs/ALPHA_PROVIDER_QUICKSTART.md'
const PROVIDER_PLAYBOOK_URL = 'https://github.com/Nil-Store/nil-store/blob/main/DEVNET_MULTI_PROVIDER.md'
const REPO_URL = 'https://github.com/Nil-Store/nil-store'
const REPO_CLONE_HTTPS = 'git clone https://github.com/Nil-Store/nil-store.git'
const REPO_CLONE_SSH = 'git clone git@github.com:Nil-Store/nil-store.git'
const REPO_CLONE_GH = 'gh repo clone Nil-Store/nil-store'
const REPO_ENTER_DIR = 'cd nil-store'
const LOCAL_HEALTH_URL = 'http://127.0.0.1:8091/health'
const PROVIDER_DRAFT_KEY = 'nilstore.provider-onboarding.v2'
const PROVIDER_AUTH_SESSION_KEY = 'nilstore.provider-onboarding.auth.v1'

type PendingLinksState = Awaited<ReturnType<typeof lcdFetchPendingProviderLinksByOperator>>
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
  tunnelName: string
  providerKey: string
  providerRepoReady: boolean
  providerKeyInitialized: boolean
  providerAddress: string
  linkTxHash: string
}

function loadStoredDraft(): StoredProviderDraft {
  if (typeof window === 'undefined') {
    return {
      hostMode: 'home-tunnel',
      endpointMode: 'domain',
      endpointValue: '',
      publicPort: '443',
      tunnelName: 'nilstore-sp',
      providerKey: 'provider1',
      providerRepoReady: false,
      providerKeyInitialized: false,
      providerAddress: '',
      linkTxHash: '',
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
      tunnelName: String(parsed.tunnelName || 'nilstore-sp'),
      providerKey: String(parsed.providerKey || 'provider1'),
      providerRepoReady: Boolean(parsed.providerRepoReady),
      providerKeyInitialized: Boolean(parsed.providerKeyInitialized),
      providerAddress: String(parsed.providerAddress || ''),
      linkTxHash: String(parsed.linkTxHash || ''),
    }
  } catch {
    return {
      hostMode: 'home-tunnel',
      endpointMode: 'domain',
      endpointValue: '',
      publicPort: '443',
      tunnelName: 'nilstore-sp',
      providerKey: 'provider1',
      providerRepoReady: false,
      providerKeyInitialized: false,
      providerAddress: '',
      linkTxHash: '',
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

type CloneMethod = 'https' | 'ssh' | 'gh'
type TunnelSetupMode = 'easy' | 'manual'

const CLONE_METHOD_OPTIONS: Array<{
  id: CloneMethod
  label: string
  command: string
  description: string
}> = [
  { id: 'https', label: 'HTTPS', command: REPO_CLONE_HTTPS, description: 'Clone using the web URL.' },
  { id: 'ssh', label: 'SSH', command: REPO_CLONE_SSH, description: 'Use an SSH key configured for GitHub.' },
  { id: 'gh', label: 'GitHub CLI', command: REPO_CLONE_GH, description: 'Clone quickly using the GitHub CLI.' },
]

export function SpOnboarding() {
  const storedDraft = useMemo(() => loadStoredDraft(), [])
  const { openConnectModal } = useConnectModal()
  const { switchNetwork } = useNetwork()
  const { approveProviderLink, loading: approvingLink } = useApproveProviderLink()
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
  const [tunnelName, setTunnelName] = useState(storedDraft.tunnelName)
  const [tunnelSetupMode, setTunnelSetupMode] = useState<TunnelSetupMode>('easy')
  const [providerKey, setProviderKey] = useState(storedDraft.providerKey)
  const [providerRepoReady, setProviderRepoReady] = useState(storedDraft.providerRepoReady)
  const [providerKeyInitialized, setProviderKeyInitialized] = useState(storedDraft.providerKeyInitialized)
  const [cloneMethod, setCloneMethod] = useState<CloneMethod>('https')
  const [providerAddress, setProviderAddress] = useState(storedDraft.providerAddress)
  const [linkTxHash, setLinkTxHash] = useState(storedDraft.linkTxHash)
  const [authToken, setAuthToken] = useState(loadSessionAuthToken)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [latestHeight, setLatestHeight] = useState<number | null>(null)
  const [pendingLinks, setPendingLinks] = useState<PendingLinksState>([])
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
      tunnelName,
      providerKey,
      providerRepoReady,
      providerKeyInitialized,
      providerAddress,
      linkTxHash,
    }
    window.localStorage.setItem(PROVIDER_DRAFT_KEY, JSON.stringify(payload))
  }, [endpointMode, endpointValue, hostMode, linkTxHash, providerAddress, providerKey, providerRepoReady, providerKeyInitialized, publicPort, tunnelName])

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
    () => findConfirmedProviderPairing(operatorPairings, nilAddress || ''),
    [nilAddress, operatorPairings],
  )
  const pendingLink = useMemo(
    () => findMostRecentPendingProviderLink(pendingLinks, nilAddress || ''),
    [nilAddress, pendingLinks],
  )
  const activeProviderAddress = useMemo(
    () =>
      String(providerAddress || '').trim() ||
      confirmedPairing?.provider ||
      pendingLink?.provider ||
      '',
    [confirmedPairing?.provider, pendingLink?.provider, providerAddress],
  )
  const providerRecord = useMemo(
    () => findProviderByAddress(providers, activeProviderAddress),
    [activeProviderAddress, providers],
  )
  const onchainBases = useMemo(() => extractProviderHttpBases(providerRecord?.endpoints), [providerRecord?.endpoints])
  const effectivePublicBase = onchainBases[0] || endpointPlan?.publicBase || null
  const providerStatusDetail = publicStatus?.provider ?? null
  const providerDaemonStatusReady = String(publicStatus?.persona || '').trim().toLowerCase() === 'provider-daemon'
  const authoritativePublicBase = providerStatusDetail?.public_base || effectivePublicBase
  const hasAuthToken = Boolean(authToken.trim())
  const hasOperatorAddress = Boolean(String(nilAddress || '').trim())
  const providerKeyLabel = String(providerKey || '').trim()
  const providerKeyReady = Boolean(providerKeyLabel)
  const selectedCloneOption = CLONE_METHOD_OPTIONS.find((option) => option.id === cloneMethod) ?? CLONE_METHOD_OPTIONS[0]

  const walletReady = isConnected && !isWrongNetwork && !needsReconnect
  const funded = hasFunds || faucetTxStatus === 'confirmed'
  const walletInlineError =
    needsReconnect || String(error || '').includes('Wallet access is required.')
      ? WALLET_ACCESS_REQUIRED_MESSAGE
      : null
  const pageError = walletInlineError && error === walletInlineError ? null : error
  const canApproveLink = walletReady && funded && Boolean(address) && Boolean(pendingLink?.provider) && !confirmedPairing
  const pairingLinked = Boolean(pendingLink)
  const pairingConfirmed = Boolean(confirmedPairing)
  const providerRegistered = Boolean(providerRecord)
  const publicHealthReady = providerDaemonStatusReady
    ? Boolean(providerStatusDetail?.public_health_ok)
    : healthProbe.status === 'ok' && healthProbe.base === effectivePublicBase
  const flow = useMemo(
    () =>
      buildProviderOnboardingFlow({
        walletReady,
        funded,
        hasOperatorAddress,
        providerRepoReady,
        providerKeyReady,
        providerKeyInitialized,
        pairingLinked,
        pairingConfirmed,
        endpointReady: Boolean(endpointPlan),
        hasAuthToken,
        providerRegistered,
        publicHealthReady,
      }),
    [
      funded,
      hasAuthToken,
      hasOperatorAddress,
      pairingConfirmed,
      pairingLinked,
      providerKeyInitialized,
      providerKeyReady,
      providerRegistered,
      providerRepoReady,
      publicHealthReady,
      walletReady,
      endpointPlan,
    ],
  )

  const bootstrapCommand = useMemo(
    () =>
      buildProviderBootstrapCommand({
        hostMode,
        endpointMode,
        endpointValue,
        publicPort: Number(publicPort),
        operatorAddress: nilAddress || '',
        providerKey,
        authToken,
      }),
    [authToken, endpointMode, endpointValue, hostMode, nilAddress, providerKey, publicPort],
  )
  const healthCommands = useMemo(() => buildProviderHealthCommands(authoritativePublicBase), [authoritativePublicBase])
  const cloudflareTunnelCommand = useMemo(
    () =>
      buildCloudflareTunnelBootstrapCommand({
        hostMode,
        endpointMode,
        endpointValue,
        publicPort: Number(publicPort),
        tunnelName,
      }),
    [endpointMode, endpointValue, hostMode, publicPort, tunnelName],
  )
  const cloudflareTunnelManualCommands = useMemo(() => {
    const normalizedHost = endpointPlan?.normalizedHost || '<public-hostname>'
    const normalizedTunnelName = String(tunnelName || '').trim() || 'nilstore-sp'
    return [
      `cloudflared tunnel login`,
      `cloudflared tunnel create ${normalizedTunnelName}`,
      `cloudflared tunnel route dns ${normalizedTunnelName} ${normalizedHost}`,
      `cloudflared tunnel run ${normalizedTunnelName}`,
    ].join('\n')
  }, [endpointPlan?.normalizedHost, tunnelName])
  const pairCommand = useMemo(
    () => buildProviderLinkCommand(providerKey, nilAddress || ''),
    [nilAddress, providerKey],
  )
  const providerInitCommand = useMemo(
    () => `PROVIDER_KEY='${providerKeyLabel || 'provider1'}' ./scripts/run_devnet_provider.sh init`,
    [providerKeyLabel],
  )
  const agentPrompt = useMemo(
    () =>
      buildProviderAgentPrompt({
        operatorAddress: nilAddress || '',
        providerEndpoint: endpointPlan?.providerEndpoint,
        publicBase: authoritativePublicBase,
        providerKey,
      }),
    [authoritativePublicBase, endpointPlan?.providerEndpoint, nilAddress, providerKey],
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
        nilAddress ? lcdFetchPendingProviderLinksByOperator(appConfig.lcdBase, nilAddress).catch(() => []) : Promise.resolve([]),
        nilAddress ? lcdFetchProvidersByOperator(appConfig.lcdBase, nilAddress).catch(() => []) : Promise.resolve([]),
      ])

      setLatestHeight(height)
      setPendingLinks(pending)
      setOperatorPairings(pairings)

      if (pairings.length > 0 || pending.length > 0) {
        const registryProviders = await lcdFetchProviders(appConfig.lcdBase).catch(() => [])
        setProviders(registryProviders)
      } else {
        setProviders([])
      }
    } finally {
      setLoadingLiveState(false)
    }
  }, [nilAddress])

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
    if (!nilAddress) {
      setPendingLinks([])
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
  }, [nilAddress, refreshLiveState])

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

  const handleApproveLink = async () => {
    setError(null)
    setNotice(null)

    if (!address) {
      setError('Connect the operator wallet first.')
      return
    }
    if (!walletReady) {
      setError('Switch the wallet onto NilStore testnet before approving provider link.')
      return
    }
    if (!funded) {
      setError('Fund the operator wallet before approving provider link.')
      return
    }
    if (!pendingLink?.provider) {
      setError('No pending provider link was found for this operator wallet yet.')
      return
    }

    try {
      const result = await approveProviderLink({ creator: address, provider: pendingLink.provider })
      setProviderAddress(pendingLink.provider)
      setLinkTxHash(result.tx_hash)
      setNotice('Provider link approved on-chain. Continue with endpoint, auth token, bootstrap, and health checks.')
      await refreshLiveState()
    } catch (openError) {
      const message = openError instanceof Error ? openError.message : 'Could not approve provider link'
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
  const hostSetupState: 'ready' | 'pending' | 'action' | 'idle' = providerRepoReady ? 'ready' : 'action'
  const pairingState: 'ready' | 'pending' | 'action' | 'idle' = pairingConfirmed
    ? 'ready'
    : !providerRepoReady || !providerKeyReady || !providerKeyInitialized || !hasOperatorAddress
      ? 'action'
      : pairingLinked
        ? 'pending'
        : 'action'
  const publicAccessState: 'ready' | 'pending' | 'action' | 'idle' = endpointPlan && hasAuthToken
    ? 'ready'
    : endpointPlan || hasAuthToken
      ? 'pending'
      : 'action'
  const providerState: 'ready' | 'pending' | 'action' | 'idle' = publicHealthReady
    ? 'ready'
    : providerRegistered
      ? 'pending'
      : pairingConfirmed
        ? 'pending'
        : flow.commandReady
          ? 'action'
          : 'idle'
  const scrollToStep = useCallback((anchor: string) => {
    if (typeof document === 'undefined') return
    const target = document.getElementById(anchor)
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

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
                Connect the operator wallet, prepare the provider host, pair the provider identity, configure public access,
                then run bootstrap and verify registration plus health from the same screen.
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
                <StatusPill
                  label={
                    !providerRepoReady
                      ? 'Prep host first'
                      : !providerKeyReady || !providerKeyInitialized
                        ? 'Prepare key'
                      : pairingConfirmed
                        ? 'Confirmed'
                        : pairingLinked
                          ? 'Awaiting browser approval'
                          : 'Open link request'
                  }
                  state={pairingState}
                />
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Public access</div>
              <div className="flex items-center gap-2 text-sm text-foreground">
                <StatusPill
                  label={endpointPlan && hasAuthToken ? 'Ready' : endpointPlan ? 'Missing auth' : hasAuthToken ? 'Missing endpoint' : 'Configure'}
                  state={publicAccessState}
                />
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Bootstrap + health</div>
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

        <section className="mt-6 border border-border bg-background px-6 py-5 shadow-[0_10px_30px_rgba(15,23,42,0.06)]">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Current step</div>
              <h2 className="text-2xl font-semibold text-foreground">
                Step {flow.currentStepIndex + 1}. {flow.currentStep.label}
              </h2>
              <p className="max-w-3xl text-sm text-muted-foreground">{flow.nextActionMessage}</p>
            </div>
            <PrimaryCtaButton size="md" onClick={() => scrollToStep(flow.currentStep.anchor)}>
              Go To Step {flow.currentStepIndex + 1}
            </PrimaryCtaButton>
          </div>

          <div className="mt-5 grid gap-3 border-t border-border/60 pt-4 sm:grid-cols-2 xl:grid-cols-5">
            {flow.steps.map((step) => (
              <button
                key={step.id}
                type="button"
                onClick={() => scrollToStep(step.anchor)}
                className="border border-border bg-background/40 p-3 text-left transition-colors hover:bg-secondary/20"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Step {step.index + 1}
                  </div>
                  <StatusPill label={step.statusLabel} state={step.state} />
                </div>
                <div className="mt-2 text-sm font-semibold text-foreground">{step.label}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Done when: <span className="font-medium text-foreground">{step.doneWhen}</span>
                </div>
              </button>
            ))}
          </div>
        </section>

        {pageError ? (
          <div className="mt-6 border border-destructive/40 bg-background px-4 py-4 shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-destructive">Onboarding blocked</div>
                <p className="text-sm text-foreground">{pageError}</p>
              </div>
            </div>
          </div>
        ) : null}

        {notice ? (
          <div className="mt-6 border border-primary/35 bg-background px-4 py-4 shadow-[0_10px_30px_rgba(15,23,42,0.08)]">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div className="space-y-1">
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">Onboarding update</div>
                <p className="text-sm text-foreground">{notice}</p>
              </div>
            </div>
          </div>
        ) : null}

        <div id="operator-flow" className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
          <div className="space-y-6">
            <section id="step-wallet" className="glass-panel industrial-border scroll-mt-28 p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">1. Connect operator wallet</div>
                  <h2 className="text-2xl font-semibold text-foreground">Connect the browser wallet that will approve this provider</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    This step gives the provider host its <span className="font-mono">OPERATOR_ADDRESS</span>. The same wallet also approves the pending provider link later in Step 3.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Done when: <span className="font-semibold text-foreground">wallet is connected, on NilStore testnet, and funded for the approval transaction</span>.
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

            <section id="step-host-setup" className="glass-panel industrial-border scroll-mt-28 p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">2. Prepare provider host</div>
                  <h2 className="text-2xl font-semibold text-foreground">Prepare the provider host workspace</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Pick one clone method and run it on the provider host. Every provider command in the rest of this flow assumes a local <span className="font-mono">nil-store</span> checkout.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Done when: <span className="font-semibold text-foreground">provider host has a local nil-store checkout and you are running commands inside it</span>.
                  </p>
                </div>
                <StatusPill label={providerRepoReady ? 'Host ready' : 'Clone required'} state={hostSetupState} />
              </div>

              <div className="mt-6 space-y-5">
                <div className="border border-border bg-background/60">
                  <div className="border-b border-border p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                      <Server className="h-4 w-4 text-muted-foreground" />
                      Clone
                    </div>
                    <div className="mt-3 flex items-end gap-6 border-b border-border">
                      {CLONE_METHOD_OPTIONS.map((option) => {
                        const active = cloneMethod === option.id
                        return (
                          <button
                            key={option.id}
                            type="button"
                            onClick={() => setCloneMethod(option.id)}
                            className={`-mb-px border-b-2 px-1 pb-2 text-base font-semibold transition-colors ${
                              active
                                ? 'border-primary text-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                            aria-pressed={active}
                          >
                            {option.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="space-y-4 p-4">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 overflow-x-auto border border-border bg-background/80 px-3 py-2 font-mono text-sm text-foreground">
                        {selectedCloneOption.command}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleCopy(`${selectedCloneOption.label} clone command`, selectedCloneOption.command)}
                        className="inline-flex h-10 w-10 items-center justify-center border border-border bg-background/70 text-foreground hover:bg-secondary/40"
                        aria-label={`Copy ${selectedCloneOption.label} clone command`}
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="text-sm text-muted-foreground">{selectedCloneOption.description}</div>

                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 overflow-x-auto border border-border bg-background/80 px-3 py-2 font-mono text-sm text-foreground">
                        {REPO_ENTER_DIR}
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleCopy('Change directory command', REPO_ENTER_DIR)}
                        className="inline-flex h-10 w-10 items-center justify-center border border-border bg-background/70 text-foreground hover:bg-secondary/40"
                        aria-label="Copy change directory command"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>

                <label className="inline-flex items-start gap-3 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={providerRepoReady}
                    onChange={(event) => setProviderRepoReady(event.target.checked)}
                    className="mt-1 h-4 w-4 border border-border bg-background"
                  />
                  <span>I cloned the repo on the provider host and I am running commands inside the `nil-store` directory.</span>
                </label>

                {!providerRepoReady ? (
                  <div className="border border-border bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                    Complete this first. Steps 3 through 5 assume the provider host can run <span className="font-mono">./scripts/run_devnet_provider.sh ...</span>.
                  </div>
                ) : null}
              </div>
            </section>

            <section id="step-pairing" className="glass-panel industrial-border scroll-mt-28 p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">3. Pair provider identity</div>
                  <h2 className="text-2xl font-semibold text-foreground">Prepare the provider key, open the link request, and approve it here</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    This step combines the provider-host and browser sides of pairing: choose the provider key, run init, fund it if new, request the link from the provider host, then approve it from this wallet.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Done when: <span className="font-semibold text-foreground">provider key is prepared and the provider link is approved on-chain</span>.
                  </p>
                </div>
                <StatusPill
                  label={
                    !providerKeyReady
                      ? 'Missing key name'
                      : !providerKeyInitialized
                        ? 'Prepare key'
                        : pairingConfirmed
                          ? 'Approved'
                          : pairingLinked
                            ? 'Approve in browser'
                            : 'Open link request'
                  }
                  state={pairingState}
                />
              </div>

              <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)]">
                <div className="space-y-5">
                  <label className="block max-w-xl space-y-2 text-sm">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Local provider key name</span>
                    <input
                      value={providerKey}
                      onChange={(event) => setProviderKey(event.target.value)}
                      placeholder="provider1"
                      className="w-full border border-border bg-background/60 px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                    />
                  </label>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-foreground">1. Provider key init command</div>
                      <CopyButton label="Copy" onClick={() => void handleCopy('Provider init command', providerInitCommand)} />
                    </div>
                    <pre className="overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{providerInitCommand}</pre>
                    <div className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                      Run this once for the key name above. If the key is new, fund the printed <span className="font-mono">nil1...</span> address with gas before requesting the provider link.
                    </div>
                  </div>

                  <label className="inline-flex items-start gap-3 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={providerKeyInitialized}
                      onChange={(event) => setProviderKeyInitialized(event.target.checked)}
                      className="mt-1 h-4 w-4 border border-border bg-background"
                      disabled={!providerKeyReady || !providerRepoReady}
                    />
                    <span>I ran init for this key (or confirmed it already existed) and the key is funded for link request.</span>
                  </label>

                  <div className="grid gap-3 border border-border bg-background/40 p-4 text-sm text-muted-foreground md:grid-cols-3">
                    <div className="flex items-center justify-between gap-3 md:block">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Operator address</div>
                      <div className="mt-1 font-mono-data text-foreground">{nilAddress || 'required from Step 1'}</div>
                    </div>
                    <div className="flex items-center justify-between gap-3 md:block">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider key</div>
                      <div className="mt-1 font-mono-data text-foreground">{providerKeyLabel || 'required in this step'}</div>
                    </div>
                    <div className="flex items-center justify-between gap-3 md:block">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pairing status</div>
                      <div className="mt-1 font-mono-data text-foreground">{pairingConfirmed ? 'approved' : pairingLinked ? 'pending browser approval' : 'not requested'}</div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-foreground">2. Provider-host link request</div>
                      <CopyButton label="Copy" onClick={() => void handleCopy('Link command', pairCommand)} />
                    </div>
                    <pre className="overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{pairCommand}</pre>
                    <p className="text-xs text-muted-foreground">
                      Run this on the provider host, then refresh until a pending link appears in the browser approval card.
                    </p>
                  </div>

                  {!providerRepoReady ? (
                    <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                      Finish Step 2 first so the provider host can run init and link commands from a local checkout.
                    </div>
                  ) : !providerKeyReady ? (
                    <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                      Set the local provider key name above before running init on the provider host.
                    </div>
                  ) : !providerKeyInitialized ? (
                    <div className="border border-border bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                      Run init and ensure key funding, then check the confirmation box to continue.
                    </div>
                  ) : !hasOperatorAddress ? (
                    <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                      Finish Step 1 first so this page has the operator wallet Nil address.
                    </div>
                  ) : pairingConfirmed ? (
                    <div className="border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
                      Provider link approved. Continue to Step 4 for public endpoint and shared auth.
                    </div>
                  ) : pairingLinked ? (
                    <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                      Pending provider link request is open. Approve it from the browser wallet card in this step.
                    </div>
                  ) : (
                    <div className="border border-border bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                      No pending provider link was found yet. Use the link command above, then refresh this page state.
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="border border-border bg-background/40 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-foreground">3. Browser approval</div>
                        <div className="mt-1 text-sm text-muted-foreground">
                          Once the provider host opens the pending link, approve it from this wallet.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void refreshLiveState()}
                        className="inline-flex items-center gap-2 border border-border bg-background/60 px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                      >
                        <RefreshCw className={`h-4 w-4 ${loadingLiveState ? 'animate-spin' : ''}`} /> Refresh
                      </button>
                    </div>

                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                      <div className="border border-border bg-background/40 p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Latest height</div>
                        <div className="mt-2 font-mono-data text-foreground">{latestHeight ?? '—'}</div>
                      </div>
                      <div className="border border-border bg-background/40 p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pending provider</div>
                        <div className="mt-2 break-all font-mono-data text-foreground">{pendingLink?.provider || activeProviderAddress || '—'}</div>
                      </div>
                      <div className="border border-border bg-background/40 p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Requested height</div>
                        <div className="mt-2 font-mono-data text-foreground">{pendingLink?.requested_height || '—'}</div>
                      </div>
                      <div className="border border-border bg-background/40 p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Approval tx</div>
                        <div className="mt-2 break-all font-mono-data text-foreground">{linkTxHash || '—'}</div>
                      </div>
                    </div>

                    <div className="mt-4">
                      {pairingConfirmed ? (
                        <div className="border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent">
                          Provider link is approved on-chain. Public access and bootstrap can proceed.
                        </div>
                      ) : pendingLink ? (
                        <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                          Pending provider link found on-chain. Approve it from this wallet now.
                        </div>
                      ) : (
                        <div className="border border-border bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                          No pending provider link is open for this operator yet. Run the provider-host link request first, then refresh.
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-3 border border-border bg-background/40 p-4">
                    <button
                      type="button"
                      onClick={() => void handleApproveLink()}
                      disabled={!canApproveLink || approvingLink}
                      className="inline-flex w-full items-center justify-center gap-2 bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {approvingLink ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
                      {pairingConfirmed ? 'Approve Again' : 'Approve Link'}
                    </button>
                    <div className="text-xs text-muted-foreground">
                      Draft state is saved locally in this browser. The shared auth token stays only in this browser session and is not written into the long-lived draft.
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section id="step-public-access" className="glass-panel industrial-border scroll-mt-28 p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">4. Configure public access</div>
                  <h2 className="text-2xl font-semibold text-foreground">Describe public access and add the shared hub auth token</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    This step tells NilStore how browsers should reach the provider and adds the shared token that the hub uses when talking to the provider-daemon.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Done when: <span className="font-semibold text-foreground">public endpoint is defined and the shared provider auth token is present</span>.
                  </p>
                </div>
                <StatusPill
                  label={endpointPlan && hasAuthToken ? 'Ready' : endpointPlan || hasAuthToken ? 'In progress' : 'Action needed'}
                  state={publicAccessState}
                />
              </div>

              <div className="mt-6 space-y-5">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Where is this provider running?</div>
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
                  <p className="mt-2 text-sm text-muted-foreground">
                    {hostMode === 'home-tunnel'
                      ? 'Use this when the provider-daemon is on a home server behind a tunnel or reverse proxy.'
                      : 'Use this when the provider-daemon is already exposed from a public host.'}
                  </p>
                </div>

                {hostMode === 'home-tunnel' ? (
                  <div className="space-y-4 border border-primary/30 bg-primary/5 p-4">
                    <div className="space-y-1">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Cloudflare tunnel setup</div>
                      <div className="text-sm text-muted-foreground">
                        Easy mode generates one run-ready command that logs in, creates/routes the tunnel, writes config, and starts <span className="font-mono">cloudflared</span>.
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setTunnelSetupMode('easy')}
                        className={`border px-3 py-2 text-sm font-semibold ${tunnelSetupMode === 'easy' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/60 text-foreground hover:bg-secondary/40'}`}
                      >
                        Easy automatic
                      </button>
                      <button
                        type="button"
                        onClick={() => setTunnelSetupMode('manual')}
                        className={`border px-3 py-2 text-sm font-semibold ${tunnelSetupMode === 'manual' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background/60 text-foreground hover:bg-secondary/40'}`}
                      >
                        Manual commands
                      </button>
                    </div>

                    <label className="block max-w-md space-y-2 text-sm">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Tunnel name</span>
                      <input
                        value={tunnelName}
                        onChange={(event) => setTunnelName(event.target.value)}
                        placeholder="nilstore-sp"
                        className="w-full border border-border bg-background/60 px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                      />
                    </label>

                    {endpointMode !== 'domain' ? (
                      <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                        Switch endpoint input to <span className="font-semibold">Hostname</span> to use Cloudflare tunnel bootstrap commands.
                      </div>
                    ) : tunnelSetupMode === 'easy' ? (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-foreground">Cloudflare bootstrap command</div>
                          <CopyButton label="Copy" onClick={() => void handleCopy('Cloudflare bootstrap command', cloudflareTunnelCommand)} />
                        </div>
                        <pre className="overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{cloudflareTunnelCommand}</pre>
                        <p className="text-xs text-muted-foreground">
                          This command opens Cloudflare login on first run and starts <span className="font-mono">cloudflared</span> in the foreground. Keep it running, or convert to a system service once verified.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-foreground">Cloudflare manual commands</div>
                          <CopyButton label="Copy" onClick={() => void handleCopy('Cloudflare manual commands', cloudflareTunnelManualCommands)} />
                        </div>
                        <pre className="overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{cloudflareTunnelManualCommands}</pre>
                        <p className="text-xs text-muted-foreground">
                          Manual mode matches the docs flow when you want to run each Cloudflare command separately.
                        </p>
                      </div>
                    )}
                  </div>
                ) : null}

                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">How will browsers reach it?</div>
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
                  <p className="mt-2 text-sm text-muted-foreground">
                    {endpointMode === 'multiaddr'
                      ? 'Paste the full on-chain endpoint when you already know the exact advertised multiaddr.'
                      : endpointMode === 'ipv4'
                        ? 'Use a direct public IPv4 only when the provider is intentionally exposed without a hostname.'
                        : 'Use the public hostname that operators and browsers should actually hit, for example sp.example.com.'}
                  </p>
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
                </div>

                <div className="grid gap-2 border border-border bg-background/40 p-4 text-sm text-muted-foreground sm:grid-cols-2">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Derived provider endpoint</div>
                    <div className="mt-2 break-all font-mono-data text-foreground">{endpointPlan?.providerEndpoint || '—'}</div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Public health URL</div>
                    <div className="mt-2 break-all font-mono-data text-foreground">{endpointPlan?.publicHealthUrl || '—'}</div>
                  </div>
                </div>

                <label className="block max-w-xl space-y-2 text-sm">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Shared auth token from hub</span>
                  <input
                    data-testid="provider-auth-token"
                    value={authToken}
                    onChange={(event) => setAuthToken(event.target.value)}
                    placeholder="Paste token for provider host commands"
                    type="password"
                    className="w-full border border-border bg-background/60 px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </label>

                <div className="grid gap-3 border border-border bg-background/40 p-4 text-sm text-muted-foreground md:grid-cols-2">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Bootstrap gate</div>
                    <div className="mt-2 space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <span>Pairing approved</span>
                        <span className="font-mono-data text-foreground">{pairingConfirmed ? 'yes' : 'no'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Repo cloned on host</span>
                        <span className="font-mono-data text-foreground">{providerRepoReady ? 'yes' : 'no'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Provider key prepared</span>
                        <span className="font-mono-data text-foreground">{providerKeyReady && providerKeyInitialized ? 'yes' : 'no'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Endpoint defined</span>
                        <span className="font-mono-data text-foreground">{endpointPlan ? 'yes' : 'no'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Shared auth token</span>
                        <span className="font-mono-data text-foreground">{hasAuthToken ? 'yes' : 'no'}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Command rail ready</span>
                        <span className="font-mono-data text-foreground">{flow.commandReady ? 'yes' : 'no'}</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Session handling</div>
                    <p className="mt-2">
                      This token is kept only in this browser session so refreshes can resume onboarding, but it is not saved into the long-lived onboarding draft.
                    </p>
                    <div className="mt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Local health target</div>
                    <div className="mt-2 break-all font-mono-data text-foreground">{LOCAL_HEALTH_URL}</div>
                  </div>
                </div>

                {!hasAuthToken ? (
                  <div className="border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                    If you do not already have this token, stop here and ask the hub operator for <span className="font-mono">NIL_GATEWAY_SP_AUTH</span>. The website cannot generate a usable bootstrap command without it.
                  </div>
                ) : null}

                {!flow.commandReady ? (
                  <div className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                    {!providerRepoReady
                      ? 'Finish Step 2 by cloning nil-store on the provider host.'
                      : !providerKeyReady
                        ? 'Finish Step 3 by setting the local provider key name used by provider host commands.'
                      : !providerKeyInitialized
                        ? 'Finish Step 3 by running provider key init and funding before unlock.'
                      : !pairingConfirmed
                        ? 'Finish Step 3 by opening and approving the provider link before bootstrap.'
                      : !endpointPlan
                        ? 'Describe the public endpoint so the website can derive the provider endpoint and health URL.'
                      : !hasOperatorAddress
                        ? 'Finish Step 1 so the website can capture the connected operator wallet nil address.'
                        : 'Add the shared auth token from the hub operator to unlock run-ready provider host commands.'}
                  </div>
                ) : null}
              </div>
            </section>

            <section id="step-bootstrap" className="glass-panel industrial-border scroll-mt-28 p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">5. Bootstrap and verify</div>
                  <h2 className="text-2xl font-semibold text-foreground">Run bootstrap, then watch registration and health converge</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Once the provider host runs bootstrap from the command rail, this page should move from approved pairing to on-chain registration and finally to healthy daemon-reported public reachability. The direct browser <span className="font-mono">/health</span> probe is only advisory.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Done when: <span className="font-semibold text-foreground">bootstrap is run and registration plus health both report healthy</span>.
                  </p>
                </div>
                <StatusPill label={publicHealthReady ? 'Healthy' : providerState === 'pending' ? 'In progress' : 'Waiting'} state={providerState} />
              </div>

              <div className="mt-6 space-y-4 text-sm">
                  <div className="border border-border bg-background/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider link approval</div>
                      <div className="mt-1 text-foreground">
                        {confirmedPairing
                          ? `Approved for provider ${confirmedPairing.provider}`
                          : pairingLinked
                            ? 'Waiting for operator wallet to approve the pending provider link'
                            : 'No pending provider link found yet; finish Step 3 first'}
                      </div>
                    </div>
                    <StatusPill label={confirmedPairing ? 'Approved' : pairingLinked ? 'Waiting' : 'Idle'} state={confirmedPairing ? 'ready' : pairingLinked ? 'pending' : 'idle'} />
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
                            ? 'Provider link approved. Waiting for bootstrap to register or update endpoints.'
                            : 'Website registration tracking starts after link approval.'}
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
                  <div className="font-semibold text-foreground">When link approval is still pending</div>
                  <div className="mt-2">
                    The operator wallet has not approved the pending provider link yet. Rerun <span className="font-mono">./scripts/run_devnet_provider.sh link</span> if the host needs to reopen the request, or rerun <span className="font-mono">./scripts/run_devnet_provider.sh bootstrap</span> on the provider host once the key is funded.
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
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Step 5 command rail</div>
                    <h2 className="mt-2 text-2xl font-semibold text-foreground">Provider host runbook</h2>
                  </div>
                <StatusPill label={flow.commandReady ? 'Command ready' : 'Waiting'} state={flow.commandReady ? 'ready' : 'pending'} />
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                  This panel becomes run-ready after the operator wallet is connected, the host checkout and provider key are ready, pairing is approved, and public access plus shared auth are both set.
              </p>
              </div>

              <div className="space-y-5 px-6 py-5">
                {!hasAuthToken ? (
                  <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                    Add the shared provider auth token from the hub operator before copying provider host commands.
                  </div>
                ) : null}
                {!pairingConfirmed ? (
                  <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                    Finish Step 3 first. The happy-path bootstrap command is gated on an approved provider link.
                  </div>
                ) : null}
                <div className="grid gap-3 border-b border-border/60 pb-5 text-sm text-muted-foreground">
                  <div className="flex items-center justify-between gap-3">
                    <span>Pending provider</span>
                    <span className="font-mono-data text-foreground">{pendingLink?.provider || activeProviderAddress || 'required'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Operator address</span>
                    <span className="font-mono-data text-foreground">{nilAddress || 'required'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Provider endpoint</span>
                    <span className="max-w-[240px] break-all text-right font-mono-data text-foreground">{endpointPlan?.providerEndpoint || '—'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Provider key</span>
                    <span className="max-w-[240px] break-all text-right font-mono-data text-foreground">{providerKeyLabel || 'required'}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span>Shared auth</span>
                    <span className="max-w-[240px] break-all text-right font-mono-data text-foreground">{hasAuthToken ? 'present' : 'required'}</span>
                  </div>
                </div>

                {flow.commandReady ? (
                  <>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-foreground">Happy-path bootstrap command</div>
                        <CopyButton label="Copy" onClick={() => void handleCopy('Provider host commands', bootstrapCommand)} />
                      </div>
                      <pre data-testid="provider-host-commands" className="overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{bootstrapCommand}</pre>
                    </div>

                    {pairingLinked ? (
                      <div className="space-y-3 border-t border-border/60 pt-5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-foreground">Link-only repair</div>
                          <CopyButton label="Copy" onClick={() => void handleCopy('Link-only repair', pairCommand)} />
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
                    {!providerRepoReady
                      ? 'Complete Step 2 by cloning nil-store on the provider host before generating bootstrap commands.'
                      : !providerKeyReady
                        ? 'Set the provider key name in Step 3 before generating bootstrap commands.'
                      : !providerKeyInitialized
                        ? 'Run provider key init + funding in Step 3 before generating bootstrap commands.'
                      : !pairingConfirmed
                        ? 'Approve the provider link in Step 3 before generating the happy-path bootstrap command.'
                      : !endpointPlan
                        ? 'Describe the public endpoint in Step 4 to generate the provider host runbook.'
                      : !hasOperatorAddress
                        ? 'Connect the operator wallet in Step 1 so this page can populate OPERATOR_ADDRESS.'
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
