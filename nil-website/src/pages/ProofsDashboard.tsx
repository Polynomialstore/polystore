import { useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle2, XCircle, BarChart2, HardDrive, Users } from 'lucide-react'
import type { LcdDeal, LcdProvider } from '../domain/lcd'
import { lcdFetchDeals, lcdFetchProviders } from '../api/lcdClient'
import { appConfig } from '../config'
import { toHexFromBase64OrHex } from '../domain/hex'
import { useProofs } from '../hooks/useProofs'

type RetrievalSessionStatusKey =
  | 'OPEN'
  | 'PROOF_SUBMITTED'
  | 'USER_CONFIRMED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'CANCELED'
  | 'UNSPECIFIED'
  | 'UNKNOWN'

type RetrievalSessionRow = {
  sessionIdHex: string | null
  dealId: string
  owner: string
  provider: string
  statusLabel: string
  statusKey: RetrievalSessionStatusKey
  openedHeight: number | null
  updatedHeight: number | null
  totalBytes: bigint | null
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = unitIndex === 0 ? 0 : unitIndex >= 3 ? 2 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

function formatBytesU64(v: unknown): string {
  const b = parseUint64(v)
  if (b <= BigInt(Number.MAX_SAFE_INTEGER)) return formatBytes(Number(b))
  return `${b.toString()} B`
}

function formatSessionStatus(v: unknown): { label: string; key: RetrievalSessionStatusKey } {
  if (typeof v === 'number') {
    const map: Record<number, { label: string; key: RetrievalSessionStatusKey }> = {
      0: { label: 'UNSPECIFIED', key: 'UNSPECIFIED' },
      1: { label: 'OPEN', key: 'OPEN' },
      2: { label: 'PROOF_SUBMITTED', key: 'PROOF_SUBMITTED' },
      3: { label: 'USER_CONFIRMED', key: 'USER_CONFIRMED' },
      4: { label: 'COMPLETED', key: 'COMPLETED' },
      5: { label: 'EXPIRED', key: 'EXPIRED' },
      6: { label: 'CANCELED', key: 'CANCELED' },
    }
    return map[v] || { label: String(v), key: 'UNKNOWN' }
  }
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (!trimmed) return { label: '—', key: 'UNKNOWN' }
    const label = trimmed.replace('RETRIEVAL_SESSION_STATUS_', '')
    const key =
      label === 'OPEN' ||
      label === 'PROOF_SUBMITTED' ||
      label === 'USER_CONFIRMED' ||
      label === 'COMPLETED' ||
      label === 'EXPIRED' ||
      label === 'CANCELED' ||
      label === 'UNSPECIFIED'
        ? (label as RetrievalSessionStatusKey)
        : ('UNKNOWN' as const)
    return { label, key }
  }
  return { label: '—', key: 'UNKNOWN' }
}

function parseSessionRow(raw: Record<string, unknown>): RetrievalSessionRow {
  const dealId = String(raw['deal_id'] ?? '')
  const owner = String(raw['owner'] ?? '')
  const provider = String(raw['provider'] ?? '')
  const status = formatSessionStatus(raw['status'])
  const sessionIdHex = toHexFromBase64OrHex(raw['session_id'], { expectedBytes: [32] })
  const openedHeightRaw = Number(raw['opened_height'] ?? NaN)
  const updatedHeightRaw = Number(raw['updated_height'] ?? NaN)
  const totalBytes = parseUint64(raw['total_bytes'])

  return {
    sessionIdHex,
    dealId,
    owner,
    provider,
    statusLabel: status.label,
    statusKey: status.key,
    openedHeight: Number.isFinite(openedHeightRaw) ? openedHeightRaw : null,
    updatedHeight: Number.isFinite(updatedHeightRaw) ? updatedHeightRaw : null,
    totalBytes,
  }
}

async function fetchRetrievalSessionsByProvider(
  provider: string,
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, unknown>[]> {
  const url = `${appConfig.lcdBase}/nilchain/nilchain/v1/retrieval-sessions/by-provider/${encodeURIComponent(
    provider,
  )}?pagination.limit=1000`
  const res = await fetchFn(url)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `LCD sessions returned ${res.status}`)
  }
  const json = (await res.json().catch(() => null)) as { sessions?: unknown[] } | null
  const sessions = Array.isArray(json?.sessions) ? json!.sessions : []
  return sessions as Record<string, unknown>[]
}

export const ProofsDashboard = () => {
  const { proofs: legacyProofs, loading: legacyProofsLoading } = useProofs(15000)

  const [deals, setDeals] = useState<LcdDeal[]>([])
  const [providers, setProviders] = useState<LcdProvider[]>([])
  const [sessions, setSessions] = useState<Record<string, unknown>[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      if (cancelled) return
      setLoading(true)
      try {
        const [nextDeals, nextProviders] = await Promise.all([
          lcdFetchDeals(appConfig.lcdBase),
          lcdFetchProviders(appConfig.lcdBase),
        ])

        if (cancelled) return
        setDeals(nextDeals)
        setProviders(nextProviders)

        const results = await Promise.allSettled(
          nextProviders.map((p) => fetchRetrievalSessionsByProvider(p.address)),
        )
        const nextSessions: Record<string, unknown>[] = []
        const failures: string[] = []
        for (const r of results) {
          if (r.status === 'fulfilled') nextSessions.push(...r.value)
          else failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason))
        }

        if (cancelled) return
        setSessions(nextSessions)
        setError(failures.length > 0 ? `${failures.length} provider session queries failed (showing partial data).` : null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load network activity')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    refresh()
    const interval = window.setInterval(refresh, 6000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  const {
    totalDeals,
    activeDeals,
    totalProviders,
    activeProviders,
    totalSessions,
    statusCounts,
    topDealsBySessions,
    topProvidersBySessions,
    recentSessions,
    uniqueDealsInSessions,
    uniqueProvidersInSessions,
    totalSessionBytes,
  } = useMemo(() => {
    const totalDeals = deals.length
    const activeDeals = deals.filter((d) => String(d.cid || '').trim()).length

    const totalProviders = providers.length
    const activeProviders = providers.filter((p) => String(p.status || '').trim().toLowerCase() === 'active').length

    const parsedSessions = sessions.map(parseSessionRow)

    const statusCounts: Record<RetrievalSessionStatusKey, number> = {
      OPEN: 0,
      PROOF_SUBMITTED: 0,
      USER_CONFIRMED: 0,
      COMPLETED: 0,
      EXPIRED: 0,
      CANCELED: 0,
      UNSPECIFIED: 0,
      UNKNOWN: 0,
    }

    const byDeal: Record<string, { dealId: string; count: number }> = {}
    const byProvider: Record<string, { provider: string; count: number }> = {}

    let totalBytes = 0n

    for (const s of parsedSessions) {
      statusCounts[s.statusKey] = (statusCounts[s.statusKey] ?? 0) + 1
      if (s.dealId) {
        const d = (byDeal[s.dealId] ||= { dealId: s.dealId, count: 0 })
        d.count += 1
      }
      if (s.provider) {
        const p = (byProvider[s.provider] ||= { provider: s.provider, count: 0 })
        p.count += 1
      }
      if (s.totalBytes !== null) totalBytes += s.totalBytes
    }

    const topDealsBySessions = Object.values(byDeal)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    const topProvidersBySessions = Object.values(byProvider)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    const recentSessions = parsedSessions
      .slice()
      .sort((a, b) => (b.updatedHeight ?? 0) - (a.updatedHeight ?? 0))
      .slice(0, 50)

    const uniqueDealsInSessions = new Set(parsedSessions.map((s) => s.dealId).filter(Boolean)).size
    const uniqueProvidersInSessions = new Set(parsedSessions.map((s) => s.provider).filter(Boolean)).size

    return {
      totalDeals,
      activeDeals,
      totalProviders,
      activeProviders,
      totalSessions: parsedSessions.length,
      statusCounts,
      topDealsBySessions,
      topProvidersBySessions,
      recentSessions,
      uniqueDealsInSessions,
      uniqueProvidersInSessions,
      totalSessionBytes: totalBytes,
    }
  }, [deals, providers, sessions])

  const totalForStatusChart = Object.values(statusCounts).reduce((sum, v) => sum + v, 0) || 1

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      {/* Header */}
      <div className="mb-10 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="max-w-2xl">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10">
              <Activity className="w-6 h-6 text-indigo-400" />
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-foreground">Retrieval Observatory</h1>
          </div>
          <p className="text-sm md:text-base text-muted-foreground">
            Live view of on-chain retrieval sessions (and related liveness signals) flowing through the NilStore
            network. On this devnet, retrieval activity is tracked via <span className="font-semibold">sessions</span>{' '}
            and heat counters; the legacy <span className="font-mono">/proofs</span> store may be empty.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {loading ? 'Syncing network activity…' : `Loaded ${totalSessions} sessions from LCD`}
        </div>
      </div>

      {/* Summary metrics */}
      <div className="grid md:grid-cols-4 gap-4 mb-10">
        <SummaryCard
          icon={<BarChart2 className="w-5 h-5 text-cyan-400" />}
          title="Retrieval Sessions"
          value={totalSessions}
          sub="On-chain session objects"
        />
        <SummaryCard
          icon={<CheckCircle2 className="w-5 h-5 text-emerald-400" />}
          title="Completed"
          value={statusCounts.COMPLETED}
          sub="Fully confirmed sessions"
        />
        <SummaryCard
          icon={<XCircle className="w-5 h-5 text-red-400" />}
          title="Canceled / Expired"
          value={statusCounts.CANCELED + statusCounts.EXPIRED}
          sub="Did not complete"
        />
        <SummaryCard
          icon={<HardDrive className="w-5 h-5 text-yellow-400" />}
          title="Deals & Providers"
          value={`${activeDeals}/${totalDeals} deals · ${activeProviders || totalProviders} SPs`}
          sub="Active/total on-chain"
        />
      </div>

      {error ? (
        <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {/* Status distribution + Top tables */}
      <div className="grid lg:grid-cols-2 gap-6 mb-10">
        {/* Status distribution bar chart */}
        <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <BarChart2 className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-card-foreground">Session Status</h3>
                <p className="text-xs text-muted-foreground">Lifecycle distribution of retrieval sessions.</p>
              </div>
            </div>
          </div>
          <div className="space-y-3 mt-2">
            {[
              { label: 'Completed', value: statusCounts.COMPLETED, color: 'bg-emerald-500' },
              { label: 'Open', value: statusCounts.OPEN, color: 'bg-cyan-500' },
              { label: 'Proof submitted', value: statusCounts.PROOF_SUBMITTED, color: 'bg-indigo-500' },
              { label: 'User confirmed', value: statusCounts.USER_CONFIRMED, color: 'bg-blue-500' },
              { label: 'Canceled', value: statusCounts.CANCELED, color: 'bg-slate-500' },
              { label: 'Expired', value: statusCounts.EXPIRED, color: 'bg-red-500' },
            ].map((row) => {
              const pct = (row.value / totalForStatusChart) * 100
              return (
                <div key={row.label}>
                  <div className="flex items-center justify-between mb-1 text-xs">
                    <span className="font-medium text-foreground">{row.label}</span>
                    <span className="text-muted-foreground">
                      {row.value} session{row.value === 1 ? '' : 's'} ({pct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className={`h-full ${row.color}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
          <div className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            {totalSessions === 0 ? (
              <span>
                No sessions yet. Open a retrieval session from the dashboard to see activity here.
              </span>
            ) : (
              <span>
                Total bytes requested in sessions: <span className="font-mono text-foreground">{formatBytesU64(totalSessionBytes)}</span>
              </span>
            )}
          </div>
        </div>

        {/* Top deals & providers */}
        <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                <HardDrive className="w-4 h-4 text-blue-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-card-foreground">Top Deals & Providers</h3>
                <p className="text-xs text-muted-foreground">Where retrieval sessions are concentrating today.</p>
              </div>
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-4 text-xs">
            <div>
              <div className="flex items-center gap-1 mb-2 text-muted-foreground">
                <HardDrive className="w-3 h-3" />
                <span className="font-semibold text-foreground">Deals</span>
              </div>
              <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                {topDealsBySessions.length === 0 ? (
                  <div className="text-muted-foreground text-xs">No sessions yet.</div>
                ) : (
                  topDealsBySessions.map((d) => (
                    <div
                      key={d.dealId}
                      className="flex items-center justify-between bg-muted/40 rounded-lg px-2 py-1.5 border border-border/50"
                    >
                      <div>
                        <div className="text-foreground font-medium">Deal #{d.dealId}</div>
                        <div className="text-[10px] text-muted-foreground">{d.count} sessions</div>
                      </div>
                      <div className="text-xs font-semibold text-primary">{d.count}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1 mb-2 text-muted-foreground">
                <Users className="w-3 h-3" />
                <span className="font-semibold text-foreground">Providers</span>
              </div>
              <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
                {topProvidersBySessions.length === 0 ? (
                  <div className="text-muted-foreground text-xs">No sessions yet.</div>
                ) : (
                  topProvidersBySessions.map((p) => (
                    <div
                      key={p.provider}
                      className="flex items-center justify-between bg-muted/40 rounded-lg px-2 py-1.5 border border-border/50"
                    >
                      <div>
                        <div className="font-mono text-[10px] text-indigo-300">
                          {p.provider.slice(0, 10)}...{p.provider.slice(-4)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">{p.count} sessions</div>
                      </div>
                      <div className="text-xs font-semibold text-primary">{p.count}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
          <div className="mt-4 text-xs text-muted-foreground">
            Unique IDs in sessions: <span className="font-mono text-foreground">{uniqueDealsInSessions}</span> deals ·{' '}
            <span className="font-mono text-foreground">{uniqueProvidersInSessions}</span> providers
          </div>
        </div>
      </div>

      {/* Recent sessions table */}
      <section className="bg-card rounded-xl border border-border p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Activity className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-card-foreground">Recent Retrieval Sessions</h3>
              <p className="text-xs text-muted-foreground">
                The last {recentSessions.length} sessions updated on-chain (most recent first).
              </p>
            </div>
          </div>
          <div className="text-[11px] text-muted-foreground">
            {legacyProofsLoading ? 'Legacy proofs: syncing…' : `Legacy proofs: ${legacyProofs.length}`}
          </div>
        </div>

        <div className="overflow-x-auto max-h-80">
          <table className="min-w-full text-xs text-left">
            <thead className="sticky top-0 z-10 bg-muted/70 backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-medium text-muted-foreground">Session</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Deal</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Provider</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Status</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Updated</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Total Bytes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {recentSessions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">
                    No sessions recorded yet. Open a retrieval session from the dashboard to see live activity here.
                  </td>
                </tr>
              ) : (
                recentSessions.map((s) => {
                  const sessionHex = s.sessionIdHex
                  const shortSession = sessionHex ? `${sessionHex.slice(0, 12)}…${sessionHex.slice(-6)}` : '—'
                  return (
                    <tr
                      key={`${s.dealId}-${s.provider}-${s.updatedHeight ?? ''}-${shortSession}`}
                      className="hover:bg-muted/50 transition-colors"
                    >
                      <td className="px-3 py-2 font-mono text-[10px] text-primary" title={sessionHex || undefined}>
                        {shortSession}
                      </td>
                      <td className="px-3 py-2 text-foreground">{s.dealId ? `#${s.dealId}` : '—'}</td>
                      <td className="px-3 py-2 font-mono text-[10px] text-indigo-300" title={s.provider || undefined}>
                        {s.provider ? `${s.provider.slice(0, 10)}...${s.provider.slice(-4)}` : '—'}
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] text-muted-foreground">
                          {s.statusLabel}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{s.updatedHeight ?? '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground">{formatBytesU64(s.totalBytes)}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

interface SummaryCardProps {
  title: string
  value: string | number
  sub: string
  icon: React.ReactNode
}

const SummaryCard = ({ title, value, sub, icon }: SummaryCardProps) => (
  <div className="bg-card rounded-xl border border-border p-4 flex items-center justify-between shadow-sm">
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{title}</div>
      <div className="text-xl font-bold text-card-foreground">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-1">{sub}</div>
    </div>
    <div className="p-2 rounded-lg bg-secondary/40 flex items-center justify-center">{icon}</div>
  </div>
)
