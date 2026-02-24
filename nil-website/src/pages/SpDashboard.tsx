import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Copy, ExternalLink, RefreshCw, Server, Terminal } from 'lucide-react'
import { appConfig } from '../config'
import { lcdFetchProviders } from '../api/lcdClient'
import type { LcdProvider } from '../domain/lcd'
import { StatusBar } from '../components/StatusBar'
import { extractProviderHttpBases, isLocalDemoProvider, isLikelyLocalHttpBase } from '../lib/spDashboard'

const LOCAL_DEMO_STACK_CMD = './scripts/ensure_stack_local.sh'
const LOCAL_DEMO_STOP_CMD = './scripts/run_local_stack.sh stop'

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

type HealthProbeState =
  | { status: 'idle' }
  | { status: 'loading'; base: string }
  | { status: 'ok'; base: string; ms: number }
  | { status: 'error'; base: string; error: string }

export function SpDashboard() {
  const [providers, setProviders] = useState<LcdProvider[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [onlyLocal, setOnlyLocal] = useState(true)
  const [search, setSearch] = useState('')
  const [copyStatus, setCopyStatus] = useState<string | null>(null)
  const [probe, setProbe] = useState<HealthProbeState>({ status: 'idle' })

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await lcdFetchProviders(appConfig.lcdBase)
      setProviders(res)
    } catch (e: unknown) {
      setProviders([])
      setError(e instanceof Error ? e.message : 'Failed to load providers')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase()
    return providers.filter((p) => {
      if (onlyLocal && !isLocalDemoProvider(p)) return false
      if (!s) return true
      return String(p.address || '').toLowerCase().includes(s)
    })
  }, [onlyLocal, providers, search])

  const localCount = useMemo(() => providers.filter(isLocalDemoProvider).length, [providers])

  const handleCopy = async (label: string, text: string) => {
    try {
      await copyText(text)
      setCopyStatus(`${label} copied.`)
      window.setTimeout(() => setCopyStatus(null), 1500)
    } catch {
      setCopyStatus(`Could not copy ${label}.`)
      window.setTimeout(() => setCopyStatus(null), 2000)
    }
  }

  const probeHealth = async (base: string) => {
    const started = performance.now()
    setProbe({ status: 'loading', base })
    try {
      const ctrl = new AbortController()
      const t = window.setTimeout(() => ctrl.abort(), 5_000)
      const res = await fetch(`${base}/health`, { signal: ctrl.signal })
      window.clearTimeout(t)
      if (!res.ok) {
        setProbe({ status: 'error', base, error: `HTTP ${res.status}` })
        return
      }
      const ms = Math.round(performance.now() - started)
      setProbe({ status: 'ok', base, ms })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'probe failed'
      setProbe({ status: 'error', base, error: msg })
    }
  }

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-emerald-500/10 via-background to-cyan-500/10 p-8">
        <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="relative space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-emerald-700 dark:text-emerald-300">
            <Server className="h-4 w-4" />
            Provider Console
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground">Storage Provider Dashboard</h1>
          <p className="max-w-3xl text-muted-foreground">
            This is the SP-facing console. It focuses on on-chain provider registration + endpoints, and local demo SP bring-up. The data-client UI lives in the regular Dashboard.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background/80 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <ExternalLink className="h-4 w-4" />
              Open Client Dashboard
            </Link>
            <Link
              to="/sp-onboarding"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background/80 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <ExternalLink className="h-4 w-4" />
              Open SP Onboarding
            </Link>
          </div>
        </div>
      </section>

      <div className="mt-6">
        <StatusBar />
      </div>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-foreground">Local demo stack</h2>
            <button
              type="button"
              onClick={() => void handleCopy('Start command', LOCAL_DEMO_STACK_CMD)}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/40"
            >
              <Copy className="h-3.5 w-3.5" /> Copy start
            </button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Single-machine local dev: chain + faucet + demo providers + trusted <span className="font-mono">user-gateway</span> + web UI.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-secondary/20 p-4 text-xs text-muted-foreground">
            {LOCAL_DEMO_STACK_CMD}
            {'\n'}
            {LOCAL_DEMO_STOP_CMD}
          </pre>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleCopy('Stop command', LOCAL_DEMO_STOP_CMD)}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <Terminal className="h-4 w-4" /> Copy stop
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh providers
            </button>
          </div>
          {copyStatus ? (
            <div className="mt-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
              {copyStatus}
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-xl font-semibold text-foreground">Provider registry (on-chain)</h2>
          <div className="mt-2 text-sm text-muted-foreground">
            Total providers: <span className="font-mono text-foreground">{providers.length}</span> • Local endpoints:{' '}
            <span className="font-mono text-foreground">{localCount}</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={onlyLocal}
                onChange={(e) => setOnlyLocal(Boolean(e.target.checked))}
              />
              Show local only
            </label>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value ?? '')}
              placeholder="Filter by provider address…"
              className="flex-1 min-w-[220px] bg-background border border-border rounded px-3 py-2 text-foreground text-sm focus:outline-none focus:border-primary"
            />
          </div>
          {error ? (
            <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <div className="mt-4 rounded-lg border border-border overflow-hidden">
            <div className="max-h-[360px] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-secondary/40 text-xs text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2">Provider</th>
                    <th className="text-left px-3 py-2">Endpoints</th>
                    <th className="text-left px-3 py-2">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => {
                    const bases = extractProviderHttpBases(p.endpoints)
                    const primary = bases[0]
                    const local = primary ? isLikelyLocalHttpBase(primary) : false
                    const activeProbe = probe.status !== 'idle' && probe.base === primary
                    return (
                      <tr key={p.address} className="border-t border-border">
                        <td className="px-3 py-2 align-top">
                          <div className="font-mono text-xs text-foreground break-all">{p.address}</div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {local ? (
                              <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-emerald-700 dark:text-emerald-300">
                                local
                              </span>
                            ) : (
                              <span className="rounded border border-border bg-background px-2 py-0.5">remote</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 align-top">
                          {bases.length > 0 ? (
                            <div className="space-y-1">
                              {bases.slice(0, 3).map((b) => (
                                <div key={b} className="font-mono text-xs text-foreground break-all">
                                  {b}
                                </div>
                              ))}
                              {bases.length > 3 ? (
                                <div className="text-xs text-muted-foreground">+{bases.length - 3} more</div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground">No HTTP endpoints</div>
                          )}
                        </td>
                        <td className="px-3 py-2 align-top">
                          {primary ? (
                            <div className="space-y-2">
                              <button
                                type="button"
                                onClick={() => void probeHealth(primary)}
                                className="inline-flex items-center gap-2 rounded border border-border bg-background px-2 py-1 text-xs font-semibold text-foreground hover:bg-secondary/40"
                              >
                                <RefreshCw className={`h-3.5 w-3.5 ${activeProbe && probe.status === 'loading' ? 'animate-spin' : ''}`} />
                                Probe /health
                              </button>
                              {activeProbe && probe.status === 'ok' ? (
                                <div className="text-xs text-emerald-700 dark:text-emerald-300">
                                  OK ({probe.ms}ms)
                                </div>
                              ) : null}
                              {activeProbe && probe.status === 'error' ? (
                                <div className="text-xs text-destructive">
                                  {probe.error}
                                </div>
                              ) : null}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground">n/a</div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-3 py-6 text-sm text-muted-foreground">
                        {providers.length === 0 ? 'No providers loaded yet.' : 'No providers match your filters.'}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
          <div className="mt-3 text-xs text-muted-foreground">
            Note: health probes require provider endpoints to allow CORS from <span className="font-mono">http://localhost:5173</span>.
          </div>
        </div>
      </section>
    </div>
  )
}
