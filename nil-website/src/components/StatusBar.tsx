import { useEffect, useMemo, useState } from 'react'
import { fetchStatus, ServiceStatus } from '../lib/status'
import { appConfig } from '../config'
import { useAccount, useChainId } from 'wagmi'
import { useTransportContext } from '../context/TransportContext'
import { useMetaMaskUnlockState } from '../hooks/useMetaMaskUnlockState'
import { useLocalGateway } from '../hooks/useLocalGateway'
import { useWalletNetworkGuard } from '../hooks/useWalletNetworkGuard'
import { CheckCircle2, Copy, Download, ExternalLink, RefreshCw } from 'lucide-react'

const STATUS_POLL_MS = 60_000
const STATUS_HIDDEN_POLL_MS = 300_000
const OPTIONAL_HEALTH_PROBE_EVERY_TICKS = 20
const GATEWAY_DESKTOP_RELEASE_URL = 'https://github.com/Nil-Store/nil-store/releases/latest'

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

function Badge({ label, status, value }: { label: string; status: ServiceStatus; value?: string }) {
  const resolvedValue = value ?? (status === 'ok' ? 'OK' : status === 'warn' ? 'WARN' : 'ERR')
  const borderClass =
    status === 'ok'
      ? 'border-accent/40'
      : status === 'warn'
        ? 'border-primary/40'
        : 'border-destructive/40'
  const dotClass =
    status === 'ok'
      ? 'bg-accent pulse-status dark:shadow-[0_0_16px_hsl(var(--accent)_/_0.25)]'
      : status === 'warn'
        ? 'bg-primary dark:shadow-[0_0_16px_hsl(var(--primary)_/_0.2)]'
        : 'bg-destructive dark:shadow-[0_0_16px_hsl(var(--destructive)_/_0.22)]'
  const statusTextClass = status === 'ok' ? 'text-accent' : status === 'warn' ? 'text-primary' : 'text-destructive'
  return (
    <span
      className={`inline-flex items-center gap-2 border ${borderClass} bg-transparent px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
      <span className="text-muted-foreground">{label}:</span>
      <span className={statusTextClass}>{resolvedValue}</span>
    </span>
  )
}

export function StatusBar() {
  const chainId = useChainId()
  const { isConnected } = useAccount()
  const unlockState = useMetaMaskUnlockState({ enabled: isConnected, pollMs: 15_000 })
  const { accountPermissionMismatch } = useWalletNetworkGuard({ enabled: isConnected, pollMs: 15_000 })
  const isLocked = isConnected && unlockState === 'locked'
  const { preference, setPreference, lastTrace } = useTransportContext()
  const localGateway = useLocalGateway(60_000)
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

  const walletStatus = accountPermissionMismatch
    ? ('warn' as const)
    : isLocked
      ? ('warn' as const)
      : isConnected && chainId
        ? chainId === appConfig.chainId
          ? ('ok' as const)
          : ('error' as const)
        : ('warn' as const)
  const walletValue = accountPermissionMismatch
    ? 'ACCESS'
    : isLocked
      ? 'LOCK'
      : isConnected && chainId
        ? chainId === appConfig.chainId
          ? 'OK'
          : `CHAIN${chainId}`
        : 'MISS'

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
          accessMismatch: accountPermissionMismatch,
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
    <div className="relative overflow-hidden glass-panel industrial-border px-4 py-3 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_30px_hsl(var(--primary)_/_0.06)]">
      <div className="absolute inset-0 cyber-grid opacity-30 pointer-events-none" />
      <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-40" />

      <div className="relative flex flex-wrap items-center gap-2 text-[10px] font-mono-data text-muted-foreground">
        <span className="inline-flex items-center border border-border/50 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
          /sys/diag
        </span>

        <Badge label="LCD" status={summary.lcd} />
        <Badge label="EVM" status={summary.evm} />
        {!appConfig.gatewayDisabled && <Badge label="GW" status={summary.gateway} />}
        {appConfig.faucetEnabled && <Badge label="FAC" status={summary.faucet} />}
        <Badge label="PROV" status={providerStatus} value={String(providerCount ?? '—')} />
        <Badge label="CHAIN" status={summary.chainIdMatch} />
        <Badge label="WAL" status={walletStatus} value={walletValue} />

        <span className="mx-1 h-3 w-[1px] bg-border/40" aria-hidden="true" />

        <span className="inline-flex items-center gap-2 border border-border/40 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data">
          <span className="text-muted-foreground">H:</span>
          <span className="text-foreground">{height ?? '—'}</span>
        </span>

        {evmChainId !== undefined && (
          <span className="inline-flex items-center gap-2 border border-border/40 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data">
            <span className="text-muted-foreground">EVM:</span>
            <span className="text-foreground">{evmChainId}</span>
          </span>
        )}

        <span
          className={`inline-flex items-center gap-2 border px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data ${
            routeDegraded ? 'border-primary/40' : 'border-border/40'
          }`}
        >
          <span className="text-muted-foreground">ROUTE:</span>
          <span className={routeDegraded ? 'text-primary' : 'text-foreground'}>{lastRoute}{lastReason}</span>
          {routeDegraded ? <span className="text-muted-foreground">(DEGRADED)</span> : null}
        </span>

        {!appConfig.gatewayDisabled ? (
          <span className="inline-flex items-center gap-2 border border-border/40 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data">
            <span className="text-muted-foreground">LCL_GW:</span>
            <span className={localGateway.status === 'connected' ? 'text-accent' : 'text-primary'}>
              {localGateway.status === 'connected' ? 'OK' : 'MISS'}
            </span>
            <a
              href={GATEWAY_DESKTOP_RELEASE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 border border-border/50 bg-background/40 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-foreground hover:bg-muted/40 transition-colors"
              title="Download the desktop gateway app"
            >
              <Download className="h-3.5 w-3.5" />
              GET_APP
              <ExternalLink className="h-3 w-3" />
            </a>
          </span>
        ) : null}

        <label className="inline-flex items-center gap-2 border border-border/40 bg-background/30 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data">
          <span className="text-muted-foreground">PREF</span>
          <select
            value={preference ?? 'auto'}
            onChange={(e) => setPreference((e.target.value as typeof preference) || 'auto')}
            className="bg-transparent text-foreground outline-none"
          >
            <option value="auto">AUTO</option>
            <option value="prefer_gateway">PREFER_LOCAL_GW</option>
            <option value="prefer_direct_sp">PREFER_DIRECT_SP</option>
            {appConfig.p2pEnabled && <option value="prefer_p2p">PREFER_LIBP2P</option>}
          </select>
        </label>

        <button
          type="button"
          onClick={() => void handleCopyDiagnostics()}
          className={`inline-flex items-center gap-2 border px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data transition-colors ${
            copyState === 'copied'
              ? 'border-accent/40 bg-accent/10 text-accent'
              : copyState === 'error'
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-border/50 bg-background/40 text-foreground hover:bg-muted/40'
          }`}
          title={copyError ? `Copy failed: ${copyError}` : 'Copy diagnostics bundle for the devs'}
        >
          {copyState === 'copied' ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copyState === 'copied' ? 'SYNCED' : 'COPY_DIAG'}
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
          className="inline-flex items-center gap-2 border border-border/50 bg-background/40 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground hover:bg-muted/40 transition-colors disabled:opacity-60"
          title="Refresh status"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          RESCAN
        </button>
      </div>
    </div>
  )
}
