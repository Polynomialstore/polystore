import { useEffect, useMemo, useState } from 'react'
import { fetchStatus, ServiceStatus } from '../lib/status'
import { appConfig } from '../config'
import { useAccount, useChainId } from 'wagmi'
import { useTransportContext } from '../context/TransportContext'
import { useMetaMaskUnlockState } from '../hooks/useMetaMaskUnlockState'
import { useLocalGateway } from '../hooks/useLocalGateway'
import { useWalletNetworkGuard } from '../hooks/useWalletNetworkGuard'
import { 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Copy, 
  Download, 
  RefreshCw 
} from 'lucide-react'

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

function SystemLabel({ label, status, value }: { label: string; status: ServiceStatus; value?: string }) {
  const Icon = status === 'ok' ? CheckCircle2 : status === 'warn' ? AlertTriangle : XCircle
  const colorClass = status === 'ok' ? 'text-accent' : status === 'warn' ? 'text-primary' : 'text-destructive'
  
  return (
    <div className="flex items-center gap-1.5 px-1.5">
      <Icon className={`h-3 w-3 ${colorClass}`} />
      <span className="text-muted-foreground/50 font-medium">{label}</span>
      {value && <span className={`font-bold ${colorClass}`}>{value}</span>}
    </div>
  )
}

export function StatusBar({ noBorder }: { noBorder?: boolean }) {
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
    ? 'ACC'
    : isLocked
      ? 'LOCK'
      : isConnected && chainId
        ? chainId === appConfig.chainId
          ? 'OK'
          : `CH${chainId}`
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
    <div className={noBorder 
      ? "relative px-3 py-2 border-t border-border/40 bg-background/50" 
      : "relative glass-panel industrial-border px-3 py-2 shadow-sm"
    }>
      <div className="relative flex flex-wrap items-center gap-4 text-[10px] font-mono-data text-muted-foreground uppercase tracking-widest font-bold">
        
        {/* SYSTEMS GROUP */}
        <div className="flex items-center divide-x divide-border/20 border border-border/30 bg-background/40">
          <SystemLabel label="LCD" status={summary.lcd} />
          <SystemLabel label="EVM" status={summary.evm} />
          {!appConfig.gatewayDisabled && <SystemLabel label="GW" status={summary.gateway} />}
          {appConfig.faucetEnabled && <SystemLabel label="FAC" status={summary.faucet} />}
          <SystemLabel label="PROV" status={providerStatus} value={String(providerCount ?? '—')} />
          <SystemLabel label="CHAIN" status={summary.chainIdMatch} />
          <SystemLabel label="WAL" status={walletStatus} value={walletValue} />
        </div>

        {/* METRICS */}
        <div className="flex items-center gap-4 px-2">
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground/40">HEIGHT</span>
            <span className="text-foreground font-bold">{height ?? '—'}</span>
          </div>
          {evmChainId !== undefined && (
            <div className="flex items-center gap-1.5 border-l border-border/20 pl-4">
              <span className="text-muted-foreground/40">CHAIN_ID</span>
              <span className="text-foreground font-bold">{evmChainId}</span>
            </div>
          )}
        </div>

        {/* NETWORK */}
        <div className="flex items-center gap-4 border-l border-border/20 pl-4">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground/40">NET</span>
            <span className={routeDegraded ? 'text-primary' : 'text-foreground'}>{lastRoute}{lastReason}</span>
          </div>
          {!appConfig.gatewayDisabled && (
            <div className="flex items-center gap-2 border-l border-border/20 pl-4">
              <span className="text-muted-foreground/40">LCL_GW</span>
              <span className={localGateway.status === 'connected' ? 'text-accent' : 'text-primary font-bold'}>
                {localGateway.status === 'connected' ? 'OK' : 'MISSING'}
              </span>
              <a
                href={GATEWAY_DESKTOP_RELEASE_URL}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-primary transition-colors"
                title="Download desktop gateway"
              >
                <Download className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>

        {/* ACTIONS */}
        <div className="flex items-center gap-2 ml-auto">
          <div className="flex items-center gap-2 bg-background/20 px-2 py-1 border border-border/20">
            <span className="text-muted-foreground/40 text-[9px]">PREF</span>
            <select
              value={preference ?? 'auto'}
              onChange={(e) => setPreference((e.target.value as typeof preference) || 'auto')}
              className="bg-transparent text-foreground outline-none cursor-pointer text-[9px]"
            >
              <option value="auto">AUTO</option>
              <option value="prefer_gateway">GATEWAY</option>
              <option value="prefer_direct_sp">DIRECT</option>
              {appConfig.p2pEnabled && <option value="prefer_p2p">P2P</option>}
            </select>
          </div>

          <button
            type="button"
            onClick={() => void handleCopyDiagnostics()}
            className={`flex items-center gap-1.5 border px-2 py-1 transition-colors ${
              copyState === 'copied'
                ? 'border-accent/40 bg-accent/10 text-accent'
                : copyState === 'error'
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-border/30 bg-background/40 text-foreground hover:bg-secondary'
            }`}
          >
            {copyState === 'copied' ? <CheckCircle2 className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            <span className="text-[9px]">{copyState === 'copied' ? 'COPIED' : 'DIAG'}</span>
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
            className="flex items-center gap-1.5 border border-border/30 bg-background/40 px-2 py-1 text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            <span className="text-[9px]">SYNC</span>
          </button>
        </div>
      </div>
    </div>
  )
}
