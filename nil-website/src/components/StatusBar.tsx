import { useEffect, useMemo, useState } from 'react'
import { fetchStatus, ServiceStatus } from '../lib/status'
import { appConfig } from '../config'
import { useAccount, useChainId } from 'wagmi'
import { useTransportContext } from '../context/TransportContext'
import { useMetaMaskUnlockState } from '../hooks/useMetaMaskUnlockState'
import { CheckCircle2, Copy, RefreshCw } from 'lucide-react'

const STATUS_POLL_MS = 30_000
const STATUS_HIDDEN_POLL_MS = 120_000
const OPTIONAL_HEALTH_PROBE_EVERY_TICKS = 10

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

function Badge({ label, status }: { label: string; status: ServiceStatus }) {
  const colors =
    status === 'ok'
      ? 'bg-green-500/10 text-green-600 dark:text-green-300 border-green-500/30'
      : status === 'warn'
      ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-300 border-yellow-500/30'
      : 'bg-destructive/10 text-destructive border-destructive/30'
  const text =
    status === 'ok'
      ? 'OK'
      : status === 'warn'
      ? 'WARN'
      : 'ERROR'
  return (
    <span className={`px-2 py-1 text-xs rounded border ${colors} font-medium`}>
      {label}: {text}
    </span>
  )
}

export function StatusBar() {
  const chainId = useChainId()
  const { isConnected } = useAccount()
  const unlockState = useMetaMaskUnlockState({ enabled: isConnected, pollMs: 1500 })
  const isLocked = isConnected && unlockState === 'locked'
  const { preference, setPreference, lastTrace } = useTransportContext()
  const [height, setHeight] = useState<number | undefined>(undefined)
  const [chainName, setChainName] = useState<string | undefined>(undefined)
  const [summary, setSummary] = useState({
    lcd: 'warn' as ServiceStatus,
    evm: 'warn' as ServiceStatus,
    faucet: 'warn' as ServiceStatus,
    gateway: 'warn' as ServiceStatus,
    chainIdMatch: 'warn' as ServiceStatus,
  })
  const [providerCount, setProviderCount] = useState<number | undefined>(undefined)
  const [evmChainId, setEvmChainId] = useState<number | undefined>(undefined)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [copyError, setCopyError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const providerStatus = useMemo<ServiceStatus>(() => {
    if (providerCount === undefined) return 'warn'
    if (providerCount === 0) return 'error'
    return 'ok'
  }, [providerCount])

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    let tick = 0

    const load = async (opts: { manual?: boolean; probeOptionalHealth?: boolean } = {}) => {
      if (opts.manual) setRefreshing(true)
      try {
        const res = await fetchStatus(appConfig.chainId, { probeOptionalHealth: Boolean(opts.probeOptionalHealth) })
        if (cancelled) return
        setSummary({
          lcd: res.lcd,
          evm: res.evm,
          faucet: res.faucet,
          gateway: res.gateway,
          chainIdMatch: res.chainIdMatch,
        })
        setHeight(res.height)
        setChainName(res.networkName)
        setEvmChainId(res.evmChainId)
        setProviderCount(res.providerCount)
      } finally {
        if (!cancelled && opts.manual) setRefreshing(false)
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
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      const pollMs = hidden ? STATUS_HIDDEN_POLL_MS : STATUS_POLL_MS
      const probeOptionalHealth = tick === 0 || tick % OPTIONAL_HEALTH_PROBE_EVERY_TICKS === 0
      await load({ probeOptionalHealth })
      tick += 1
      if (!cancelled) {
        schedule(pollMs)
      }
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

  const walletBadge =
    isLocked
      ? <Badge label="Wallet: Locked" status="warn" />
      : isConnected && chainId
      ? chainId === appConfig.chainId
        ? <Badge label="Wallet: Connected (match)" status="ok" />
        : <Badge label={`Wallet chain ${chainId}`} status="error" />
      : <Badge label="Wallet: Not connected" status="warn" />

  const lastRoute = lastTrace?.chosen?.backend ? lastTrace.chosen.backend.replace('_', ' ') : '—'
  const lastFailure = lastTrace?.attempts.find((a) => !a.ok)
  const lastReason =
    lastTrace?.chosen && lastFailure?.errorMessage ? ` (${lastFailure.errorMessage})` : ''
  const routeShouldUseGateway =
    !appConfig.gatewayDisabled &&
    summary.gateway === 'ok' &&
    (preference === 'auto' || preference === 'prefer_gateway')
  const routeDegraded =
    routeShouldUseGateway &&
    Boolean(lastTrace?.chosen?.backend) &&
    lastTrace?.chosen?.backend !== 'gateway'

  const handleCopyDiagnostics = async () => {
    setCopyState('idle')
    setCopyError(null)
    try {
      const diagnostics = {
        timestamp: new Date().toISOString(),
        location: typeof window !== 'undefined' ? window.location.href : '',
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        appConfig: {
          chainId: appConfig.chainId,
          cosmosChainId: appConfig.cosmosChainId,
          lcdBase: appConfig.lcdBase,
          evmRpc: appConfig.evmRpc,
          gatewayBase: appConfig.gatewayBase,
          spBase: appConfig.spBase,
          apiBase: appConfig.apiBase,
          faucetEnabled: appConfig.faucetEnabled,
          gatewayDisabled: appConfig.gatewayDisabled,
          p2pEnabled: appConfig.p2pEnabled,
          nilstorePrecompile: appConfig.nilstorePrecompile,
        },
        wallet: {
          connected: isConnected,
          locked: isLocked,
          walletChainId: chainId ?? null,
        },
        status: {
          ...summary,
          height: height ?? null,
          lcdChainId: chainName ?? null,
          evmChainId: evmChainId ?? null,
          providerCount: providerCount ?? null,
        },
        transport: {
          preference,
          lastTrace,
        },
      }
      await copyText(JSON.stringify(diagnostics, null, 2))
      setCopyState('copied')
      window.setTimeout(() => setCopyState('idle'), 2500)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setCopyError(msg || 'copy failed')
      setCopyState('error')
      window.setTimeout(() => setCopyState('idle'), 4000)
    }
  }

  return (
    <div className="flex flex-wrap gap-2 items-center bg-muted/50 border border-border rounded-lg px-4 py-2 text-xs text-muted-foreground shadow-sm">
      <Badge label={`LCD`} status={summary.lcd} />
      <Badge label={`EVM`} status={summary.evm} />
      {!appConfig.gatewayDisabled && <Badge label={`Gateway`} status={summary.gateway} />}
      {appConfig.faucetEnabled && <Badge label={`Faucet`} status={summary.faucet} />}
      <Badge label={`Providers ${providerCount ?? '—'}`} status={providerStatus} />
      <Badge label={`Chain ID`} status={summary.chainIdMatch} />
      {walletBadge}
      {height && <span className="opacity-75">Height: {height}</span>}
      {chainName && <span className="opacity-75">LCD Chain: {chainName}</span>}
      {evmChainId !== undefined && (
        <span className="opacity-75">EVM Chain: {evmChainId}</span>
      )}
      <span className={routeDegraded ? 'text-amber-600 dark:text-amber-300' : 'opacity-75'}>
        Route: {lastRoute}{lastReason}
        {routeDegraded ? ' (gateway available)' : ''}
      </span>
      <label className="flex items-center gap-2">
        <span className="opacity-75">Preference</span>
        <select
          value={preference ?? 'auto'}
          onChange={(e) => setPreference((e.target.value as typeof preference) || 'auto')}
          className="bg-background border border-border rounded px-2 py-1 text-xs"
        >
          <option value="auto">Auto</option>
          <option value="prefer_gateway">Prefer gateway</option>
          <option value="prefer_direct_sp">Prefer direct SP</option>
          {appConfig.p2pEnabled && <option value="prefer_p2p">Prefer libp2p</option>}
        </select>
      </label>
      <button
        type="button"
        onClick={() => void handleCopyDiagnostics()}
        className="inline-flex items-center gap-2 rounded border border-border bg-background/60 px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/40 hover:text-foreground transition-colors"
        title={copyError ? `Copy failed: ${copyError}` : 'Copy diagnostics bundle for the devs'}
      >
        {copyState === 'copied' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
        {copyState === 'copied' ? 'Copied' : 'Copy diag'}
      </button>
      <button
        type="button"
        onClick={() => {
          if (refreshing) return
          setRefreshing(true)
          void fetchStatus(appConfig.chainId, { probeOptionalHealth: true })
            .then((res) => {
              setSummary({
                lcd: res.lcd,
                evm: res.evm,
                faucet: res.faucet,
                gateway: res.gateway,
                chainIdMatch: res.chainIdMatch,
              })
              setHeight(res.height)
              setChainName(res.networkName)
              setEvmChainId(res.evmChainId)
              setProviderCount(res.providerCount)
            })
            .finally(() => setRefreshing(false))
        }}
        disabled={refreshing}
        className="inline-flex items-center gap-2 rounded border border-border bg-background/60 px-2 py-1 text-xs text-muted-foreground hover:bg-secondary/40 hover:text-foreground transition-colors disabled:opacity-60"
        title="Refresh status"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </div>
  )
}
