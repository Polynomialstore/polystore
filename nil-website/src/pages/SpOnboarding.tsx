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
  DEVNET_SHARED_GATEWAY_AUTH_TOKEN,
  buildProviderAgentPrompt,
  buildProviderBootstrapCommand,
  buildCloudflareTunnelBootstrapCommand,
  buildProviderEndpointPlan,
  buildProviderHealthCommands,
  buildProviderPairCommand,
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
  const [cloneMethod, setCloneMethod] = useState<CloneMethod>('https')
  const [providerAddress, setProviderAddress] = useState(storedDraft.providerAddress)
  const [linkTxHash, setLinkTxHash] = useState(storedDraft.linkTxHash)
  const [authToken, setAuthToken] = useState(loadSessionAuthToken)
  const [cloudflareModalOpen, setCloudflareModalOpen] = useState(false)
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
      providerAddress,
      linkTxHash,
    }
    window.localStorage.setItem(PROVIDER_DRAFT_KEY, JSON.stringify(payload))
  }, [endpointMode, endpointValue, hostMode, linkTxHash, providerAddress, providerKey, providerRepoReady, publicPort, tunnelName])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (authToken.trim()) {
      window.sessionStorage.setItem(PROVIDER_AUTH_SESSION_KEY, authToken)
    } else {
      window.sessionStorage.removeItem(PROVIDER_AUTH_SESSION_KEY)
    }
  }, [authToken])

  useEffect(() => {
    if (!cloudflareModalOpen || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCloudflareModalOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [cloudflareModalOpen])

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
  const authTokenOverride = String(authToken || '').trim()
  const hasCustomAuthToken = Boolean(authTokenOverride)
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
        pairingLinked,
        pairingConfirmed,
        endpointReady: Boolean(endpointPlan),
        providerRegistered,
        publicHealthReady,
      }),
    [
      funded,
      hasOperatorAddress,
      pairingConfirmed,
      pairingLinked,
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
        authToken: authTokenOverride,
      }),
    [authTokenOverride, endpointMode, endpointValue, hostMode, nilAddress, providerKey, publicPort],
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
    () => buildProviderPairCommand(providerKey, nilAddress || ''),
    [nilAddress, providerKey],
  )
  const linkRepairCommand = useMemo(
    () => buildProviderLinkCommand(providerKey, nilAddress || ''),
    [nilAddress, providerKey],
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
      setNotice('Provider link approved on-chain. Continue with endpoint, bootstrap, and health checks.')
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
    : !providerRepoReady || !providerKeyReady || !hasOperatorAddress
      ? 'action'
      : pairingLinked
        ? 'pending'
        : 'action'
  const publicAccessState: 'ready' | 'pending' | 'action' | 'idle' = endpointPlan ? 'ready' : 'action'
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
                      : !providerKeyReady
                        ? 'Set key name'
                      : pairingConfirmed
                        ? 'Confirmed'
                        : pairingLinked
                          ? 'Awaiting browser approval'
                          : 'Run pair command'
                  }
                  state={pairingState}
                />
              </div>
            </div>
            <div className="space-y-1">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Public access</div>
              <div className="flex items-center gap-2 text-sm text-foreground">
                <StatusPill
                  label={endpointPlan ? 'Ready' : 'Configure'}
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
                  <h2 className="text-2xl font-semibold text-foreground">Run one host command, then approve the link here</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    This step combines the provider-host and browser sides of pairing: choose the provider key, run one provider-host command that creates the key if needed and opens the link request, then approve it from this wallet.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Done when: <span className="font-semibold text-foreground">provider key name is set and the provider link is approved on-chain</span>.
                  </p>
                </div>
                <StatusPill
                  label={
                    !providerKeyReady
                      ? 'Missing key name'
                      : !hasOperatorAddress
                        ? 'Connect wallet first'
                        : pairingConfirmed
                          ? 'Approved'
                          : pairingLinked
                            ? 'Approve in browser'
                            : 'Run pair command'
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
                      <div className="text-sm font-semibold text-foreground">Provider-host pair command</div>
                      <CopyButton label="Copy" onClick={() => void handleCopy('Provider pair command', pairCommand)} />
                    </div>
                    <pre data-testid="provider-pair-command" className="overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-4 text-xs text-muted-foreground">{pairCommand}</pre>
                    <div className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                      Run this once on the provider host. It creates the key if it is missing, auto-requests faucet funds when available, and opens the provider link request. If gas funding is still missing, the same command prints the provider <span className="font-mono">nil1...</span> address; fund it and rerun this exact command.
                    </div>
                  </div>

                  <div className="grid gap-3 border border-border bg-background p-4 text-sm text-muted-foreground md:grid-cols-3">
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Operator address</div>
                      <div className="mt-1 break-all font-mono-data text-foreground">{nilAddress || 'required from Step 1'}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider key</div>
                      <div className="mt-1 break-all font-mono-data text-foreground">{providerKeyLabel || 'required in this step'}</div>
                    </div>
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pairing status</div>
                      <div className="mt-1 break-words font-mono-data text-foreground">{pairingConfirmed ? 'approved' : pairingLinked ? 'pending browser approval' : 'not requested'}</div>
                    </div>
                  </div>

                  {!providerRepoReady ? (
                    <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                      Finish Step 2 first so the provider host can run the pair command from a local checkout.
                    </div>
                  ) : !providerKeyReady ? (
                    <div className="border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                      Set the local provider key name above before running the pair command on the provider host.
                    </div>
                  ) : !hasOperatorAddress ? (
                    <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                      Finish Step 1 first so this page has the operator wallet Nil address.
                    </div>
                  ) : pairingConfirmed ? (
                    <div className="border border-accent/40 bg-background px-4 py-3 text-sm text-accent">
                      Provider link approved. Continue to Step 4 to define public endpoint.
                    </div>
                  ) : pairingLinked ? (
                    <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                      Pending provider link request is open. Approve it from the browser wallet card in this step.
                    </div>
                  ) : (
                    <div className="border border-border bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                      No pending provider link was found yet. Run the pair command above, then refresh this page state.
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
                        <div className="border border-accent/40 bg-background px-4 py-3 text-sm text-accent">
                          Provider link is approved on-chain. Public access and bootstrap can proceed.
                        </div>
                      ) : pendingLink ? (
                        <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                          Pending provider link found on-chain. Approve it from this wallet now.
                        </div>
                      ) : (
                        <div className="border border-border bg-background/40 px-4 py-3 text-sm text-muted-foreground">
                          No pending provider link is open for this operator yet. Run the provider-host pair command first, then refresh.
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
                      Draft state is saved locally in this browser. Optional gateway auth override stays in this browser session only.
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section id="step-public-access" className="glass-panel industrial-border scroll-mt-28 p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">4. Configure public access</div>
                  <h2 className="text-2xl font-semibold text-foreground">Set the public provider endpoint</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Keep this simple: choose how browsers should reach your provider, then confirm the derived endpoint and health URL.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Done when: <span className="font-semibold text-foreground">public endpoint is defined</span>.
                  </p>
                </div>
                <StatusPill
                  label={endpointPlan ? 'Ready' : 'Action needed'}
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
                  <div className="border border-border bg-background p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="text-sm text-muted-foreground">
                        Tunnel mode selected. Use the Cloudflare helper if you want one-click tunnel commands.
                      </div>
                      <button
                        type="button"
                        onClick={() => setCloudflareModalOpen(true)}
                        className="inline-flex items-center gap-2 border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                      >
                        Cloudflare helper
                      </button>
                    </div>
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

                <details className="border border-border bg-background p-4">
                  <summary className="cursor-pointer text-sm font-semibold text-foreground">Advanced: gateway auth override</summary>
                  <div className="mt-3 space-y-4 text-sm text-muted-foreground">
                    <p>
                      Bootstrap commands include <span className="font-mono">NIL_GATEWAY_SP_AUTH</span> automatically using the devnet default value.
                      Only override it if your hub operator gave you a custom secret.
                    </p>
                    <label className="block max-w-xl space-y-2 text-sm">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Gateway auth override (optional)</span>
                      <input
                        data-testid="provider-auth-token"
                        value={authToken}
                        onChange={(event) => setAuthToken(event.target.value)}
                        placeholder="Leave blank to use devnet default"
                        type="password"
                        className="w-full border border-border bg-background px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                      />
                    </label>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="border border-border bg-background p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Gateway auth source</div>
                        <div className="mt-2 break-all font-mono-data text-foreground">
                          {hasCustomAuthToken ? 'custom override' : `devnet default (${DEVNET_SHARED_GATEWAY_AUTH_TOKEN})`}
                        </div>
                      </div>
                      <div className="border border-border bg-background p-3">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Local health target</div>
                        <div className="mt-2 break-all font-mono-data text-foreground">{LOCAL_HEALTH_URL}</div>
                      </div>
                    </div>
                  </div>
                </details>

                {!flow.commandReady ? (
                  <div className="border border-border bg-background p-4 text-sm text-muted-foreground">
                    {!providerRepoReady
                      ? 'Finish Step 2 by cloning nil-store on the provider host.'
                      : !providerKeyReady
                        ? 'Finish Step 3 by setting the local provider key name used by provider host commands.'
                      : !pairingConfirmed
                        ? 'Finish Step 3 by running the pair command and approving the provider link before bootstrap.'
                      : !hasOperatorAddress
                        ? 'Finish Step 1 so the website can capture the connected operator wallet nil address.'
                        : !endpointPlan
                        ? 'Describe the public endpoint so the website can derive the provider endpoint and health URL.'
                        : 'Step 4 is complete. Continue to bootstrap and verification.'}
                  </div>
                ) : null}
              </div>
            </section>

            {cloudflareModalOpen ? (
              <div
                className="fixed inset-0 z-[140]"
                onClick={(event) => {
                  if (event.target === event.currentTarget) setCloudflareModalOpen(false)
                }}
              >
                <div className="absolute inset-0 bg-black/45" />
                <div className="absolute inset-0 overflow-y-auto">
                  <div className="flex min-h-full items-center justify-center px-4 py-8">
                    <div role="dialog" aria-modal="true" className="w-full max-w-4xl">
                      <div className="industrial-border border border-border bg-background p-6 shadow-lg">
                        <div className="flex flex-wrap items-start justify-between gap-4">
                          <div className="min-w-0 space-y-2">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Cloudflare helper</div>
                            <h3 className="text-xl font-semibold text-foreground">Tunnel bootstrap commands</h3>
                            <p className="text-sm text-muted-foreground">
                              Keep Cloudflare details here so Step 4 stays clean. Choose easy or manual commands, then copy and run on the provider host.
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setCloudflareModalOpen(false)}
                            className="inline-flex items-center gap-2 border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                          >
                            Close
                          </button>
                        </div>

                        <div className="mt-5 space-y-4">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => setTunnelSetupMode('easy')}
                              className={`border px-3 py-2 text-sm font-semibold ${tunnelSetupMode === 'easy' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-foreground hover:bg-secondary/40'}`}
                            >
                              Easy automatic
                            </button>
                            <button
                              type="button"
                              onClick={() => setTunnelSetupMode('manual')}
                              className={`border px-3 py-2 text-sm font-semibold ${tunnelSetupMode === 'manual' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-background text-foreground hover:bg-secondary/40'}`}
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
                              className="w-full border border-border bg-background px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                            />
                          </label>

                          {endpointMode !== 'domain' ? (
                            <div className="border border-destructive/40 bg-background px-4 py-3 text-sm text-destructive">
                              Use <span className="font-semibold">Hostname</span> endpoint mode for Cloudflare tunnel commands.
                            </div>
                          ) : tunnelSetupMode === 'easy' ? (
                            <div className="space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-sm font-semibold text-foreground">Cloudflare bootstrap command</div>
                                <CopyButton label="Copy" onClick={() => void handleCopy('Cloudflare bootstrap command', cloudflareTunnelCommand)} />
                              </div>
                              <pre className="overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-4 text-xs text-muted-foreground">{cloudflareTunnelCommand}</pre>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-sm font-semibold text-foreground">Cloudflare manual commands</div>
                                <CopyButton label="Copy" onClick={() => void handleCopy('Cloudflare manual commands', cloudflareTunnelManualCommands)} />
                              </div>
                              <pre className="overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-4 text-xs text-muted-foreground">{cloudflareTunnelManualCommands}</pre>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

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

              <div className="mt-6 grid gap-4 lg:grid-cols-3">
                <div className="border border-border bg-background p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pairing</div>
                    <StatusPill label={confirmedPairing ? 'Approved' : pairingLinked ? 'Waiting' : 'Idle'} state={confirmedPairing ? 'ready' : pairingLinked ? 'pending' : 'idle'} />
                  </div>
                  <div className="mt-2 break-all text-foreground">
                    {confirmedPairing
                      ? `Approved for provider ${confirmedPairing.provider}`
                      : pairingLinked
                        ? 'Pending link exists. Approve it from Step 3.'
                        : 'No pending link yet. Run the pair command in Step 3.'}
                  </div>
                </div>

                <div data-testid="provider-status-card" className="border border-border bg-background p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">On-chain registration</div>
                    <StatusPill label={providerRecord ? 'Visible' : confirmedPairing ? 'Waiting' : 'Idle'} state={providerRecord ? 'ready' : confirmedPairing ? 'pending' : 'idle'} />
                  </div>
                  <div className="mt-2 break-all text-foreground">
                    {providerRecord
                      ? providerRecord.endpoints?.join(', ') || 'Provider exists without endpoints'
                      : confirmedPairing
                        ? 'Waiting for bootstrap to register or update endpoints.'
                        : 'Registration starts after link approval.'}
                  </div>
                </div>

                <div data-testid="provider-daemon-status-card" className="border border-border bg-background p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider-daemon health</div>
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
                  </div>
                  <div className="mt-2 break-all text-foreground">
                    {providerDaemonStatusReady
                      ? providerStatusDetail?.public_health_ok
                        ? `${providerStatusDetail.public_health_url || `${authoritativePublicBase || effectivePublicBase}/health`} is reachable from the provider host`
                        : `${providerStatusDetail?.public_health_url || `${authoritativePublicBase || effectivePublicBase || 'public base unavailable'}/health`} is not reachable from the provider host`
                      : authoritativePublicBase
                        ? loadingPublicStatus
                          ? `Polling ${authoritativePublicBase}/status`
                          : publicStatusError
                            ? `/status failed at ${authoritativePublicBase}: ${publicStatusError}`
                            : `Waiting for ${authoritativePublicBase}/status to identify provider-daemon`
                        : 'Waiting for a public base URL from your endpoint draft or on-chain registration'}
                  </div>
                  {authoritativePublicBase ? (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => void refreshPublicStatus(authoritativePublicBase)}
                        className="inline-flex items-center gap-2 border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                      >
                        <RefreshCw className={`h-4 w-4 ${loadingPublicStatus ? 'animate-spin' : ''}`} /> Refresh
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>

              <div data-testid="provider-browser-health-card" className="mt-4 border border-border bg-background p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Direct browser health probe (optional)</div>
                  <div className="flex items-center gap-2">
                    <StatusPill
                      label={healthProbe.status === 'ok' ? 'Healthy' : healthProbe.status === 'error' ? 'Failed' : 'Idle'}
                      state={healthProbe.status === 'ok' ? 'ready' : healthProbe.status === 'error' ? 'action' : 'idle'}
                    />
                    {effectivePublicBase ? (
                      <button
                        type="button"
                        onClick={() => void probePublicHealth(effectivePublicBase)}
                        className="inline-flex items-center gap-2 border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                      >
                        <RefreshCw className={`h-4 w-4 ${healthProbe.status === 'loading' ? 'animate-spin' : ''}`} /> Probe
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="mt-2 break-all text-foreground">
                  {healthProbe.status === 'ok'
                    ? `${healthProbe.base}/health responded in ${healthProbe.ms}ms`
                    : healthProbe.status === 'error'
                      ? `${healthProbe.base}/health failed: ${healthProbe.error}`
                      : effectivePublicBase
                        ? `Waiting to probe ${effectivePublicBase}/health`
                        : 'Waiting for a public base URL from your endpoint draft or on-chain registration'}
                </div>
              </div>

              {publicStatus?.issues?.length ? (
                <div className="mt-4 border border-destructive/40 bg-background p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-destructive">Provider-daemon issues</div>
                  <div className="mt-3 space-y-2 text-sm text-destructive">
                    {publicStatus.issues.map((issue) => (
                      <div key={issue}>{issue}</div>
                    ))}
                  </div>
                </div>
              ) : null}

              <details className="mt-5 border-t border-border/60 pt-4 text-sm text-muted-foreground">
                <summary className="cursor-pointer font-semibold text-foreground">If verification is stuck</summary>
                <div className="mt-3 space-y-2">
                  <div>
                    If pairing is pending, rerun <span className="font-mono">./scripts/run_devnet_provider.sh pair</span>, then approve from Step 3.
                  </div>
                  <div>
                    If health is failing, trust provider-side checks first: <span className="font-mono">doctor</span>, <span className="font-mono">verify</span>, and local <span className="font-mono">curl</span> from the command rail.
                  </div>
                </div>
              </details>
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
                  This panel becomes run-ready after wallet, host prep, pairing approval, and public endpoint setup are complete.
              </p>
              </div>

              <div className="space-y-5 px-6 py-5">
                {!pairingConfirmed ? (
                  <div className="border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
                    Finish Step 3 first. The happy-path bootstrap command is gated on an approved provider link.
                  </div>
                ) : null}
                <div className="grid gap-3 border-b border-border/60 pb-5 text-sm text-muted-foreground">
                  <div className="min-w-0">
                    <span>Pending provider</span>
                    <div className="mt-1 break-all font-mono-data text-foreground">{pendingLink?.provider || activeProviderAddress || 'required'}</div>
                  </div>
                  <div className="min-w-0">
                    <span>Operator address</span>
                    <div className="mt-1 break-all font-mono-data text-foreground">{nilAddress || 'required'}</div>
                  </div>
                  <div className="min-w-0">
                    <span>Provider endpoint</span>
                    <div className="mt-1 break-all font-mono-data text-foreground">{endpointPlan?.providerEndpoint || '—'}</div>
                  </div>
                  <div className="min-w-0">
                    <span>Provider key</span>
                    <div className="mt-1 break-all font-mono-data text-foreground">{providerKeyLabel || 'required'}</div>
                  </div>
                  <div className="min-w-0">
                    <span>Gateway auth</span>
                    <div className="mt-1 break-all font-mono-data text-foreground">
                      {hasCustomAuthToken ? 'custom override' : `devnet default (${DEVNET_SHARED_GATEWAY_AUTH_TOKEN})`}
                    </div>
                  </div>
                </div>

                {flow.commandReady ? (
                  <>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-foreground">Happy-path bootstrap command</div>
                        <CopyButton label="Copy" onClick={() => void handleCopy('Provider host commands', bootstrapCommand)} />
                      </div>
                      <pre data-testid="provider-host-commands" className="overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-4 text-xs text-muted-foreground">{bootstrapCommand}</pre>
                    </div>

                    {pairingLinked ? (
                      <div className="space-y-3 border-t border-border/60 pt-5">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-semibold text-foreground">Link-only repair</div>
                          <CopyButton label="Copy" onClick={() => void handleCopy('Link-only repair', linkRepairCommand)} />
                        </div>
                        <pre className="overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-4 text-xs text-muted-foreground">{linkRepairCommand}</pre>
                      </div>
                    ) : null}

                    <div className="space-y-3 border-t border-border/60 pt-5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-sm font-semibold text-foreground">Verification commands</div>
                        <CopyButton label="Copy" onClick={() => void handleCopy('Verification commands', healthCommands)} />
                      </div>
                      <pre className="overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-4 text-xs text-muted-foreground">{healthCommands}</pre>
                    </div>

                    <details className="border-t border-border/60 pt-5">
                      <summary className="cursor-pointer text-sm font-semibold text-foreground">Agent prompt</summary>
                      <p className="mt-2 text-sm text-muted-foreground">
                        Use this when a coding agent is running on the provider host and you want it to execute the bootstrap and repair loop directly.
                      </p>
                      <div className="mt-3 flex justify-end">
                        <CopyButton label="Copy" onClick={() => void handleCopy('Agent prompt', agentPrompt)} />
                      </div>
                      <pre className="mt-3 overflow-auto whitespace-pre-wrap break-words border border-border bg-background p-4 text-xs text-muted-foreground">{agentPrompt}</pre>
                    </details>
                  </>
                ) : (
                  <div className="border border-border bg-background p-4 text-sm text-muted-foreground">
                    {!providerRepoReady
                      ? 'Complete Step 2 by cloning nil-store on the provider host before generating bootstrap commands.'
                      : !providerKeyReady
                        ? 'Set the provider key name in Step 3 before generating bootstrap commands.'
                      : !pairingConfirmed
                        ? 'Run the pair command and approve the provider link in Step 3 before generating the happy-path bootstrap command.'
                      : !hasOperatorAddress
                        ? 'Connect the operator wallet in Step 1 so this page can populate OPERATOR_ADDRESS.'
                      : !endpointPlan
                        ? 'Describe the public endpoint in Step 4 to generate the provider host runbook.'
                        : 'Runbook is ready.'}
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
              <div className="border border-accent/50 bg-background px-4 py-3 text-sm text-accent">{copyStatus}</div>
            ) : null}
          </aside>
        </div>
      </div>
    </div>
  )
}
