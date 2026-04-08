import { useCallback, useEffect, useMemo, useState } from 'react'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  Copy,
  ExternalLink,
  Link2Off,
  LoaderCircle,
  RefreshCw,
  Server,
  Shield,
  Wallet,
} from 'lucide-react'

import { appConfig } from '../config'
import { lcdFetchProviders, lcdFetchProvidersByOperator } from '../api/lcdClient'
import { providerFetchPublicStatus, type ProviderAdminResponse, type ProviderPublicStatusResponse } from '../api/providerClient'
import { StatusBar } from '../components/StatusBar'
import { useNetwork } from '../hooks/useNetwork'
import { useProviderAdmin } from '../hooks/useProviderAdmin'
import { useSessionStatus } from '../hooks/useSessionStatus'
import { useUnpairProvider } from '../hooks/useUnpairProvider'
import {
  buildOperatorProviderRecords,
  buildProviderRegisterCommand,
  findOperatorProviderRecord,
} from '../lib/providerConsole'
import { buildProviderHealthCommands } from '../lib/providerOnboarding'

const PROVIDER_PLAYBOOK_URL = 'https://github.com/Nil-Store/nil-store/blob/main/DEVNET_MULTI_PROVIDER.md'
const LOCAL_DEMO_STACK_CMD = './scripts/ensure_stack_local.sh'
const LOCAL_DEMO_STOP_CMD = './scripts/run_local_stack.sh stop'

type PublicHealthState =
  | { status: 'idle' }
  | { status: 'loading'; base: string }
  | { status: 'ok'; base: string; ms: number }
  | { status: 'error'; base: string; error: string }

type ProviderPublicStatusState = ProviderPublicStatusResponse | null

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

function CopyButton({ label, onClick }: { label: string; onClick: () => void }) {
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

export function SpDashboard() {
  const { openConnectModal } = useConnectModal()
  const { switchNetwork } = useNetwork()
  const { pendingAction, refreshStatus, runDoctor, rotateEndpoint } = useProviderAdmin()
  const { unpairProvider, loading: unpairingProvider } = useUnpairProvider()
  const session = useSessionStatus()
  const {
    nilAddress,
    walletAddressShort,
    isConnected,
    isWrongNetwork,
    genesisMismatch,
    needsReconnect,
    refreshWalletNetwork,
  } = session

  const [pairings, setPairings] = useState<Awaited<ReturnType<typeof lcdFetchProvidersByOperator>>>([])
  const [providers, setProviders] = useState<Awaited<ReturnType<typeof lcdFetchProviders>>>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState('')
  const [rotationProviderKey, setRotationProviderKey] = useState('provider1')
  const [rotationEndpoint, setRotationEndpoint] = useState('')
  const [selectedControlBase, setSelectedControlBase] = useState('')
  const [publicStatus, setPublicStatus] = useState<ProviderPublicStatusState>(null)
  const [publicStatusError, setPublicStatusError] = useState<string | null>(null)
  const [loadingPublicStatus, setLoadingPublicStatus] = useState(false)
  const [healthProbe, setHealthProbe] = useState<PublicHealthState>({ status: 'idle' })
  const [adminError, setAdminError] = useState<string | null>(null)
  const [adminResponse, setAdminResponse] = useState<ProviderAdminResponse | null>(null)

  const load = useCallback(async () => {
    if (!nilAddress) {
      setPairings([])
      setProviders([])
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const [nextPairings, nextProviders] = await Promise.all([
        lcdFetchProvidersByOperator(appConfig.lcdBase, nilAddress),
        lcdFetchProviders(appConfig.lcdBase),
      ])
      setPairings(nextPairings)
      setProviders(nextProviders)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load provider state')
      setPairings([])
      setProviders([])
    } finally {
      setLoading(false)
    }
  }, [nilAddress])

  useEffect(() => {
    if (!nilAddress) {
      setPairings([])
      setProviders([])
      return
    }

    void load()
    const timer = window.setInterval(() => {
      void load()
    }, 10000)
    return () => window.clearInterval(timer)
  }, [load, nilAddress])

  const records = useMemo(() => buildOperatorProviderRecords(pairings, providers), [pairings, providers])
  const selectedRecord = useMemo(
    () => findOperatorProviderRecord(records, selectedProvider),
    [records, selectedProvider],
  )
  const activeRecord = selectedRecord ?? records[0] ?? null
  const providerDaemonStatusReady = String(publicStatus?.persona || '').trim().toLowerCase() === 'provider-daemon'
  const providerStatusDetail = publicStatus?.provider ?? null
  const effectiveControlBase = providerStatusDetail?.public_base || selectedControlBase || activeRecord?.primaryBase || null
  const healthCommands = useMemo(
    () => buildProviderHealthCommands(providerStatusDetail?.public_base || activeRecord?.primaryBase || null, rotationProviderKey),
    [activeRecord?.primaryBase, providerStatusDetail?.public_base, rotationProviderKey],
  )
  const rotationCommand = useMemo(
    () => buildProviderRegisterCommand({ providerKey: rotationProviderKey, providerEndpoint: rotationEndpoint }),
    [rotationEndpoint, rotationProviderKey],
  )

  useEffect(() => {
    if (records.length === 0) {
      setSelectedProvider('')
      return
    }
    if (!findOperatorProviderRecord(records, selectedProvider)) {
      setSelectedProvider(records[0]?.provider ?? '')
    }
  }, [records, selectedProvider])

  useEffect(() => {
    if (!activeRecord) {
      setRotationEndpoint('')
      setSelectedControlBase('')
      setPublicStatus(null)
      setPublicStatusError(null)
      setAdminResponse(null)
      setAdminError(null)
      return
    }
    setRotationEndpoint(activeRecord.endpoints[0] || activeRecord.primaryBase || '')
    setSelectedControlBase(activeRecord.primaryBase || activeRecord.httpBases[0] || '')
    setPublicStatus(null)
    setPublicStatusError(null)
    setAdminResponse(null)
    setAdminError(null)
  }, [activeRecord])

  useEffect(() => {
    const discoveredKeyName = String(adminResponse?.provider?.key_name || providerStatusDetail?.key_name || '').trim()
    if (!discoveredKeyName) return
    setRotationProviderKey((current) => {
      const normalized = String(current || '').trim()
      if (!normalized || normalized === 'provider1') {
        return discoveredKeyName
      }
      return current
    })
  }, [adminResponse?.provider?.key_name, providerStatusDetail?.key_name])

  const probePublicHealth = useCallback(async (baseInput: string | null | undefined) => {
    const base = String(baseInput || '').trim().replace(/\/$/, '')
    if (!base) {
      setHealthProbe({ status: 'idle' })
      return
    }

    const started = performance.now()
    setHealthProbe({ status: 'loading', base })
    try {
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${base}/health`, { signal: controller.signal })
      window.clearTimeout(timeout)
      if (!res.ok) {
        setHealthProbe({ status: 'error', base, error: `HTTP ${res.status}` })
        return
      }
      setHealthProbe({ status: 'ok', base, ms: Math.round(performance.now() - started) })
    } catch (probeError) {
      const message = probeError instanceof Error ? probeError.message : 'probe failed'
      setHealthProbe({ status: 'error', base, error: message })
    }
  }, [])

  const loadPublicStatus = useCallback(async (base: string) => {
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

  useEffect(() => {
    if (!effectiveControlBase) {
      setHealthProbe({ status: 'idle' })
      return
    }

    void probePublicHealth(effectiveControlBase)
    const timer = window.setInterval(() => {
      void probePublicHealth(effectiveControlBase)
    }, 12000)
    return () => window.clearInterval(timer)
  }, [effectiveControlBase, probePublicHealth])

  useEffect(() => {
    if (!effectiveControlBase) {
      setPublicStatus(null)
      setPublicStatusError(null)
      setLoadingPublicStatus(false)
      return
    }

    void loadPublicStatus(effectiveControlBase)
    const timer = window.setInterval(() => {
      void loadPublicStatus(effectiveControlBase)
    }, 12000)
    return () => window.clearInterval(timer)
  }, [effectiveControlBase, loadPublicStatus])

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

  const handleSwitchNetwork = async () => {
    setError(null)
    try {
      await switchNetwork({ forceAdd: genesisMismatch })
      await refreshWalletNetwork()
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : 'Failed to switch network')
    }
  }

  const registeredCount = records.filter((record) => record.registered).length
  const healthyCurrent = providerDaemonStatusReady
    ? Boolean(providerStatusDetail?.public_health_ok)
    : healthProbe.status === 'ok' && healthProbe.base === effectiveControlBase
  const adminStatus = adminResponse?.provider
  const controlPlaneReady = Boolean(isConnected && !needsReconnect && effectiveControlBase)

  const requireActiveProvider = useCallback(() => {
    if (!activeRecord) {
      throw new Error('Select a provider first')
    }
    if (!effectiveControlBase) {
      throw new Error('Selected provider does not expose a public HTTP base yet')
    }
    return { ...activeRecord, primaryBase: effectiveControlBase }
  }, [activeRecord, effectiveControlBase])

  const handleRefreshSnapshot = useCallback(async () => {
    try {
      const record = requireActiveProvider()
      setAdminError(null)
      const response = await refreshStatus({
        providerBase: record.primaryBase!,
        provider: record.provider,
      })
      setAdminResponse(response)
    } catch (actionError) {
      setAdminError(actionError instanceof Error ? actionError.message : 'Failed to refresh provider-daemon status')
    }
  }, [refreshStatus, requireActiveProvider])

  const handleRunDoctor = useCallback(async () => {
    try {
      const record = requireActiveProvider()
      setAdminError(null)
      const response = await runDoctor({
        providerBase: record.primaryBase!,
        provider: record.provider,
      })
      setAdminResponse(response)
    } catch (actionError) {
      setAdminError(actionError instanceof Error ? actionError.message : 'Failed to run provider-daemon doctor')
    }
  }, [requireActiveProvider, runDoctor])

  const handleRotateEndpoint = useCallback(async () => {
    try {
      const record = requireActiveProvider()
      const endpoint = String(rotationEndpoint || '').trim()
      if (!endpoint) {
        throw new Error('Enter a provider endpoint first')
      }
      setAdminError(null)
      const response = await rotateEndpoint({
        providerBase: record.primaryBase!,
        provider: record.provider,
        endpoint,
      })
      setAdminResponse(response)
      await load()
    } catch (actionError) {
      setAdminError(actionError instanceof Error ? actionError.message : 'Failed to rotate provider endpoint')
    }
  }, [load, requireActiveProvider, rotateEndpoint, rotationEndpoint])

  const handleUnpairProvider = useCallback(async () => {
    if (!activeRecord) {
      setAdminError('Select a provider first')
      return
    }
    try {
      setAdminError(null)
      await unpairProvider({ provider: activeRecord.provider })
      setAdminResponse(null)
      setPublicStatus(null)
      setPublicStatusError(null)
      await load()
    } catch (actionError) {
      setAdminError(actionError instanceof Error ? actionError.message : 'Failed to unpair provider')
    }
  }, [activeRecord, load, unpairProvider])

  return (
    <div className="container mx-auto max-w-6xl px-4 pb-12 pt-24">
      <section className="glass-panel industrial-border overflow-hidden p-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-3xl space-y-4">
            <div className="inline-flex items-center gap-2 border border-border bg-background/40 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
              <Server className="h-4 w-4 text-primary" />
              <span className="font-mono-data text-foreground/80">/sp/dashboard</span>
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">My Providers</h1>
            <p className="max-w-2xl text-muted-foreground">
              The operator dashboard is now wallet-driven. Connect the operator wallet used for pairing and the website will load its provider-daemons directly from on-chain pairing state.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              to="/sp-onboarding"
              className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <Shield className="h-4 w-4" />
              Provider Onboarding
            </Link>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
        </div>

        <div className="mt-8 grid gap-4 border-t border-border/60 pt-6 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Operator wallet</div>
            <div className="font-mono-data text-foreground">{isConnected ? walletAddressShort : 'Not connected'}</div>
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Nil operator</div>
            <div className="break-all font-mono-data text-foreground">{nilAddress || '—'}</div>
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Paired providers</div>
            <div className="font-mono-data text-foreground">{records.length}</div>
          </div>
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Registered providers</div>
            <div className="font-mono-data text-foreground">{registeredCount}</div>
          </div>
        </div>
      </section>

      <div className="mt-6">
        <StatusBar />
      </div>

      {error ? (
        <div className="mt-6 border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4" />
            <div>{error}</div>
          </div>
        </div>
      ) : null}

      {adminError ? (
        <div className="mt-6 border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-4 w-4" />
            <div>{adminError}</div>
          </div>
        </div>
      ) : null}

      {!isConnected ? (
        <section className="mt-8 glass-panel industrial-border p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Operator access</div>
              <h2 className="text-2xl font-semibold text-foreground">Connect the operator wallet</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                The dashboard lists providers by operator wallet ownership. Connect the same wallet used to open provider pairing from the onboarding flow.
              </p>
            </div>
            <button
              type="button"
              onClick={() => openConnectModal?.()}
              className="inline-flex items-center gap-2 bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              <Wallet className="h-4 w-4" />
              Connect Wallet
            </button>
          </div>
        </section>
      ) : null}

      {isConnected && (needsReconnect || isWrongNetwork) ? (
        <section className="mt-8 glass-panel industrial-border p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Wallet state</div>
              <h2 className="text-2xl font-semibold text-foreground">Repair the wallet session before operating providers</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {needsReconnect
                  ? 'MetaMask account permissions are stale. Reconnect the wallet used for provider pairing.'
                  : 'Switch MetaMask onto the PolyStore Devnet before relying on the operator view.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleSwitchNetwork()}
              className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-3 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <RefreshCw className="h-4 w-4" />
              {genesisMismatch ? 'Repair Network Entry' : 'Switch To PolyStore Devnet'}
            </button>
          </div>
        </section>
      ) : null}

      {isConnected && records.length === 0 && !loading && !error ? (
        <section className="mt-8 glass-panel industrial-border p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">No paired providers</div>
              <h2 className="text-2xl font-semibold text-foreground">This wallet does not own any provider-daemons yet</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Start in provider onboarding, request provider link from the host, approve it in the browser wallet, then bootstrap the remote provider host. The provider appears here after on-chain link approval.
              </p>
            </div>
            <Link
              to="/sp-onboarding"
              className="inline-flex items-center gap-2 bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              <Shield className="h-4 w-4" />
              Open Provider Onboarding
            </Link>
          </div>
        </section>
      ) : null}

      {records.length > 0 ? (
        <div className="mt-8 grid gap-8 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="space-y-6 lg:sticky lg:top-24 lg:self-start">
            <section className="glass-panel industrial-border overflow-hidden">
              <div className="border-b border-border/60 px-6 py-5">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">My Providers</div>
                    <h2 className="mt-2 text-2xl font-semibold text-foreground">Owned provider-daemons</h2>
                  </div>
                  <StatusPill label={loading ? 'Syncing' : `${records.length} loaded`} state={loading ? 'pending' : 'ready'} />
                </div>
              </div>
              <div className="divide-y divide-border/50">
                {records.map((record) => {
                  const selected = activeRecord?.provider === record.provider
                  return (
                    <button
                      key={record.provider}
                      type="button"
                      onClick={() => setSelectedProvider(record.provider)}
                      className={`block w-full px-6 py-4 text-left transition-colors ${selected ? 'bg-primary/10' : 'bg-transparent hover:bg-background/40'}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-2">
                          <div className="break-all font-mono-data text-xs text-foreground">{record.provider}</div>
                          <div className="text-xs text-muted-foreground">{record.primaryBase || 'No public base yet'}</div>
                        </div>
                        <StatusPill label={record.registered ? 'Registered' : 'Paired'} state={record.registered ? 'ready' : 'pending'} />
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                        <span>linked</span>
                        <span>height {record.pairedHeightRaw || '—'}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </section>

            <section className="glass-panel industrial-border p-5">
              <div className="text-sm font-semibold text-foreground">Local demo stack</div>
              <p className="mt-2 text-sm text-muted-foreground">
                Single-machine local dev still uses the trusted <span className="font-mono">user-gateway</span> plus demo provider-daemons.
              </p>
              <pre className="mt-3 overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{LOCAL_DEMO_STACK_CMD}{'\n'}{LOCAL_DEMO_STOP_CMD}</pre>
              <div className="mt-3 flex flex-wrap gap-2">
                <CopyButton label="Copy start" onClick={() => void handleCopy('Start command', LOCAL_DEMO_STACK_CMD)} />
                <CopyButton label="Copy stop" onClick={() => void handleCopy('Stop command', LOCAL_DEMO_STOP_CMD)} />
              </div>
            </section>
          </aside>

          <div className="space-y-6">
            <section className="glass-panel industrial-border p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Selected provider</div>
                  <h2 className="text-2xl font-semibold text-foreground">{activeRecord?.provider}</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Pairing, registration, and public health are derived directly from the operator wallet and on-chain provider state. Provider keys remain server-side.
                  </p>
                </div>
                <StatusPill label={healthyCurrent ? 'Healthy' : activeRecord?.registered ? 'Registered' : 'Paired'} state={healthyCurrent ? 'ready' : activeRecord?.registered ? 'pending' : 'pending'} />
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="border border-border bg-background/40 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Operator</div>
                  <div className="mt-2 break-all font-mono-data text-foreground">{activeRecord?.operator || '—'}</div>
                </div>
                <div className="border border-border bg-background/40 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider</div>
                  <div className="mt-2 break-all font-mono-data text-foreground">{activeRecord?.provider || '—'}</div>
                </div>
                <div className="border border-border bg-background/40 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Paired height</div>
                  <div className="mt-2 font-mono-data text-foreground">{activeRecord?.pairedHeightRaw || '—'}</div>
                </div>
                <div className="border border-border bg-background/40 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">On-chain status</div>
                  <div className="mt-2 font-mono-data text-foreground">{activeRecord?.registryStatus || (activeRecord?.registered ? 'registered' : 'not registered')}</div>
                </div>
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <div className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                  <div className="font-semibold text-foreground">Selected control base</div>
                  <div className="mt-2 break-all font-mono-data text-foreground">{effectiveControlBase || 'No HTTP base selected yet'}</div>
                </div>
                <div className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                  <div className="font-semibold text-foreground">HTTP bases advertised on-chain</div>
                  {activeRecord?.httpBases?.length ? (
                    <div className="mt-2 space-y-1">
                      {activeRecord.httpBases.map((base) => (
                        <div key={base} className="break-all font-mono-data text-foreground">
                          {base}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-2">No HTTP bases derived from the current on-chain endpoint set.</div>
                  )}
                </div>
              </div>
            </section>

            <section className="glass-panel industrial-border p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Signed control plane</div>
                  <h2 className="text-2xl font-semibold text-foreground">Operate the provider-daemon from the browser</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    These actions are signed by the paired operator wallet and verified by the provider-daemon against on-chain pairing state. The provider key never leaves the server. Health below defaults to the provider-daemon&apos;s own <span className="font-mono">/status</span> view; the browser <span className="font-mono">/health</span> probe stays advisory.
                  </p>
                </div>
                <StatusPill
                  label={controlPlaneReady ? 'Remote actions ready' : 'Public base required'}
                  state={controlPlaneReady ? 'ready' : 'idle'}
                />
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)]">
                <div data-testid="provider-public-status-card" className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                  <div className="font-semibold text-foreground">Provider-daemon public status</div>
                  <div className="mt-2 break-all font-mono-data text-foreground">{effectiveControlBase ? `${effectiveControlBase}/status` : 'No control base selected yet'}</div>
                  <div className="mt-2 text-xs">
                    {providerDaemonStatusReady
                      ? 'Provider-daemon status is live and authoritative for pairing, registration, and public health.'
                      : loadingPublicStatus
                        ? 'Polling provider-daemon status.'
                        : publicStatusError
                          ? `Provider-daemon status is unavailable: ${publicStatusError}`
                          : 'Waiting for a reachable provider-daemon status endpoint.'}
                  </div>
                </div>
                <label className="space-y-2 text-sm">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Control-plane base</span>
                  <input
                    data-testid="provider-control-base"
                    value={selectedControlBase}
                    onChange={(event) => setSelectedControlBase(event.target.value)}
                    placeholder="https://sp.example.com"
                    className="w-full border border-border bg-background/60 px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </label>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void handleRefreshSnapshot()}
                  disabled={!controlPlaneReady || pendingAction !== null}
                  className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-3 text-sm font-semibold text-foreground hover:bg-secondary/40 disabled:opacity-50"
                >
                  {pendingAction === 'status_refresh' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Refresh daemon snapshot
                </button>
                <button
                  type="button"
                  onClick={() => void handleRunDoctor()}
                  disabled={!controlPlaneReady || pendingAction !== null}
                  className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-3 text-sm font-semibold text-foreground hover:bg-secondary/40 disabled:opacity-50"
                >
                  {pendingAction === 'run_doctor' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                  Run doctor
                </button>
                <button
                  type="button"
                  onClick={() => void loadPublicStatus(effectiveControlBase || '')}
                  disabled={!effectiveControlBase || loadingPublicStatus || pendingAction !== null}
                  className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-3 text-sm font-semibold text-foreground hover:bg-secondary/40 disabled:opacity-50"
                >
                  {loadingPublicStatus ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Refresh public status
                </button>
              </div>

              {(providerStatusDetail || adminStatus) ? (
                <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="border border-border bg-background/40 p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Local base</div>
                    <div className="mt-2 break-all font-mono-data text-foreground">{providerStatusDetail?.local_base || adminStatus?.local_base || '—'}</div>
                  </div>
                  <div className="border border-border bg-background/40 p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Public health</div>
                    <div className="mt-2 font-mono-data text-foreground">
                      {(providerStatusDetail?.public_health_ok ?? adminStatus?.public_health_ok) ? 'healthy' : 'unreachable'}
                    </div>
                  </div>
                  <div className="border border-border bg-background/40 p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pairing status</div>
                    <div className="mt-2 font-mono-data text-foreground">{providerStatusDetail?.pairing_status || adminStatus?.pairing_status || '—'}</div>
                  </div>
                  <div className="border border-border bg-background/40 p-4">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Registration status</div>
                    <div className="mt-2 font-mono-data text-foreground">{providerStatusDetail?.registration_status || adminStatus?.registration_status || '—'}</div>
                  </div>
                </div>
              ) : null}

              {(publicStatus?.issues?.length || adminResponse?.issues?.length) ? (
                <div className="mt-5 border border-destructive/30 bg-destructive/5 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-destructive">Active issues</div>
                  <div className="mt-3 space-y-2 text-sm text-destructive">
                    {[...(publicStatus?.issues || []), ...(adminResponse?.issues || [])].map((issue) => (
                      <div key={issue}>{issue}</div>
                    ))}
                  </div>
                </div>
              ) : null}

              {adminResponse?.doctor_output ? (
                <pre className="mt-5 overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">
                  {adminResponse.doctor_output}
                </pre>
              ) : null}
            </section>

            <section className="glass-panel industrial-border p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">On-chain registration</div>
                  <h2 className="text-2xl font-semibold text-foreground">Endpoints and reachability</h2>
                </div>
                <StatusPill label={activeRecord?.registered ? 'Visible on-chain' : 'Waiting for registration'} state={activeRecord?.registered ? 'ready' : 'pending'} />
              </div>

              <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                <div className="space-y-4">
                  <div className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                    <div className="font-semibold text-foreground">Authoritative public base</div>
                    <div className="mt-2 break-all font-mono-data text-foreground">{providerStatusDetail?.public_base || activeRecord?.primaryBase || 'No HTTP base found in on-chain endpoints'}</div>
                  </div>
                  <div className="border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                    <div className="font-semibold text-foreground">Registered endpoints</div>
                    {activeRecord?.endpoints.length ? (
                      <div className="mt-3 space-y-2">
                        {activeRecord.endpoints.map((endpoint) => (
                          <div key={endpoint} className="break-all font-mono-data text-foreground">
                            {endpoint}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2">No on-chain endpoints yet. Run bootstrap or a register/update command on the provider host.</div>
                    )}
                  </div>
                </div>

                <div className="min-w-[220px] space-y-3">
                  <button
                    type="button"
                    onClick={() => void probePublicHealth(effectiveControlBase)}
                    disabled={!effectiveControlBase}
                    className="inline-flex w-full items-center justify-center gap-2 border border-border bg-background/60 px-4 py-3 text-sm font-semibold text-foreground hover:bg-secondary/40 disabled:opacity-50"
                  >
                    {healthProbe.status === 'loading' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Probe /health from browser
                  </button>
                  <CopyButton label="Copy health commands" onClick={() => void handleCopy('Health commands', healthCommands)} />
                </div>
              </div>

                <div data-testid="provider-browser-health-card" className="mt-5 border-t border-border/60 pt-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Direct browser health probe</div>
                    <div className="mt-1 text-sm text-foreground">
                      {healthProbe.status === 'ok'
                        ? `${healthProbe.base}/health responded in ${healthProbe.ms}ms`
                        : healthProbe.status === 'error'
                          ? `${healthProbe.base}/health failed: ${healthProbe.error}`
                          : effectiveControlBase
                            ? `Polling ${effectiveControlBase}/health`
                            : 'No public base available yet'}
                    </div>
                  </div>
                  <StatusPill
                    label={healthProbe.status === 'ok' ? 'Reachable' : healthProbe.status === 'error' ? 'Failed' : 'Idle'}
                    state={healthProbe.status === 'ok' ? 'ready' : healthProbe.status === 'error' ? 'action' : 'idle'}
                  />
                </div>
                <pre className="mt-4 overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{healthCommands}</pre>
                <div className="mt-4 border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                  Use the provider-daemon <span className="font-mono">/status</span> result above as the authoritative public-health signal. This direct browser probe only reflects the current browser network path and CORS conditions.
                </div>
              </div>
            </section>

            <section className="glass-panel industrial-border p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Endpoint rotation</div>
                  <h2 className="text-2xl font-semibold text-foreground">Rotate or repair the public endpoint</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    The register path is now update-aware. Use the signed web action first; keep the generated shell command as the manual fallback if the provider host is unreachable from the browser.
                  </p>
                </div>
                <StatusPill label={controlPlaneReady ? 'Signed action available' : 'Fallback only'} state={controlPlaneReady ? 'ready' : 'idle'} />
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Provider key name (manual fallback only)</span>
                  <input
                    value={rotationProviderKey}
                    onChange={(event) => setRotationProviderKey(event.target.value)}
                    placeholder="provider1"
                    className="w-full border border-border bg-background/60 px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </label>
                <label className="space-y-2 text-sm">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">New provider endpoint</span>
                  <input
                    value={rotationEndpoint}
                    onChange={(event) => setRotationEndpoint(event.target.value)}
                    placeholder="/dns4/sp.example.com/tcp/443/https"
                    className="w-full border border-border bg-background/60 px-3 py-2 text-foreground focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </label>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void handleRotateEndpoint()}
                  disabled={!controlPlaneReady || !rotationEndpoint.trim() || pendingAction !== null}
                  className="inline-flex items-center gap-2 bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {pendingAction === 'rotate_endpoint' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Apply signed rotation
                </button>
                <CopyButton label="Copy rotation command" onClick={() => void handleCopy('Rotation command', rotationCommand)} />
                <a
                  href={PROVIDER_PLAYBOOK_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                >
                  <ExternalLink className="h-4 w-4" />
                  Operator Playbook
                </a>
              </div>

              <pre className="mt-4 overflow-x-auto border border-border bg-background/70 p-4 text-xs text-muted-foreground">{rotationCommand}</pre>
              {adminResponse?.action === 'rotate_endpoint' && adminResponse.tx_output ? (
                <pre className="mt-4 overflow-x-auto border border-accent/40 bg-accent/5 p-4 text-xs text-accent">
                  {adminResponse.tx_output}
                </pre>
              ) : null}
              <div className="mt-4 border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                The signed action targets <span className="font-mono text-foreground">{activeRecord?.provider}</span> over <span className="font-mono text-foreground">{effectiveControlBase || activeRecord?.primaryBase || 'no selected base'}</span>. The key name is only needed for the generated shell fallback.
              </div>
            </section>

            <section className="glass-panel industrial-border p-6">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pairing recovery</div>
                  <h2 className="text-2xl font-semibold text-foreground">Unpair and relink when the provider host is wrong</h2>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Use this when the selected provider-daemon was paired from the wrong machine, the provider key was rotated intentionally, or you need the website to forget this host before relinking a replacement.
                  </p>
                </div>
                <StatusPill label={activeRecord ? 'Available' : 'Select provider'} state={activeRecord ? 'pending' : 'idle'} />
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  type="button"
                  data-testid="unpair-provider"
                  onClick={() => void handleUnpairProvider()}
                  disabled={!activeRecord || unpairingProvider || pendingAction !== null}
                  className="inline-flex items-center gap-2 bg-destructive px-4 py-2 text-sm font-semibold text-destructive-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {unpairingProvider ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Link2Off className="h-4 w-4" />}
                  Unpair provider on-chain
                </button>
                <Link
                  to="/sp-onboarding"
                  className="inline-flex items-center gap-2 border border-border bg-background/60 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                >
                  <Shield className="h-4 w-4" />
                  Open relink flow
                </Link>
              </div>

              <div className="mt-4 border border-border bg-background/40 p-4 text-sm text-muted-foreground">
                Unpairing removes the operator-to-provider link on-chain. It does not delete the provider key or stop the provider-daemon process on the host; it only clears ownership so you can relink cleanly from the website.
              </div>
            </section>
          </div>
        </div>
      ) : null}

      {copyStatus ? (
        <div className="mt-6 border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-accent">{copyStatus}</div>
      ) : null}
    </div>
  )
}
