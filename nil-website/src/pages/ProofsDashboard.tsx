import { useMemo } from 'react'
import { useProofs } from '../hooks/useProofs'
import { Activity, CheckCircle2, XCircle, BarChart2, HardDrive, Users } from 'lucide-react'

export const ProofsDashboard = () => {
  const { proofs, loading } = useProofs(10000)

  const {
    totalProofs,
    totalValid,
    totalInvalid,
    uniqueDeals,
    uniqueProviders,
    tierCounts,
    topDeals,
    topProviders,
    recentProofs,
  } = useMemo(() => {
    const tiers: Record<string, number> = {
      Platinum: 0,
      Gold: 0,
      Silver: 0,
      Fail: 0,
      Unknown: 0,
    }
    const byDeal: Record<
      string,
      {
        dealId: string
        count: number
        successes: number
        failures: number
      }
    > = {}
    const byProvider: Record<
      string,
      {
        provider: string
        count: number
        successes: number
        failures: number
      }
    > = {}

    const total = proofs.length
    let valid = 0
    let invalid = 0

    for (const p of proofs) {
      if (p.valid) valid += 1
      else invalid += 1

      const tierKey = (p.tier || 'Unknown').trim()
      tiers[tierKey] = (tiers[tierKey] ?? 0) + 1

      if (p.dealId) {
        const d = (byDeal[p.dealId] ||= {
          dealId: p.dealId,
          count: 0,
          successes: 0,
          failures: 0,
        })
        d.count += 1
        if (p.valid) d.successes += 1
        else d.failures += 1
      }

      if (p.creator) {
        const pr = (byProvider[p.creator] ||= {
          provider: p.creator,
          count: 0,
          successes: 0,
          failures: 0,
        })
        pr.count += 1
        if (p.valid) pr.successes += 1
        else pr.failures += 1
      }
    }

    const topDeals = Object.values(byDeal)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    const topProviders = Object.values(byProvider)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    const recent = proofs
      .slice()
      .sort((a, b) => b.blockHeight - a.blockHeight)
      .slice(0, 25)

    return {
      totalProofs: total,
      totalValid: valid,
      totalInvalid: invalid,
      uniqueDeals: Object.keys(byDeal).length,
      uniqueProviders: Object.keys(byProvider).length,
      tierCounts: tiers,
      topDeals,
      topProviders,
      recentProofs: recent,
    }
  }, [proofs])

  const totalForTierChart =
    tierCounts.Platinum + tierCounts.Gold + tierCounts.Silver + tierCounts.Fail + tierCounts.Unknown || 1

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      {/* Header */}
      <div className="mb-10 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="max-w-2xl">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10">
              <Activity className="w-6 h-6 text-indigo-400" />
            </div>
            <h1 className="text-3xl md:text-4xl font-bold text-foreground">KZG Proofs Observatory</h1>
          </div>
          <p className="text-sm md:text-base text-muted-foreground">
            Live view of retrieval and liveness proofs flowing through the NilStore network. Each proof represents a
            verified KZG opening against a stored MDU, acting as a storage and retrieval audit for an active deal.
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {loading ? 'Syncing proofs…' : `Loaded ${totalProofs} proofs from LCD`}
        </div>
      </div>

      {/* Summary metrics */}
      <div className="grid md:grid-cols-4 gap-4 mb-10">
        <SummaryCard
          icon={<BarChart2 className="w-5 h-5 text-cyan-400" />}
          title="Total Proofs"
          value={totalProofs}
          sub="All recorded KZG verifications"
        />
        <SummaryCard
          icon={<CheckCircle2 className="w-5 h-5 text-emerald-400" />}
          title="Valid Proofs"
          value={totalValid}
          sub="Successful liveness attestations"
        />
        <SummaryCard
          icon={<XCircle className="w-5 h-5 text-red-400" />}
          title="Failed Proofs"
          value={totalInvalid}
          sub="Invalid or slashed attempts"
        />
        <SummaryCard
          icon={<HardDrive className="w-5 h-5 text-yellow-400" />}
          title="Active Deals & Providers"
          value={`${uniqueDeals} deals · ${uniqueProviders} SPs`}
          sub="Unique IDs seen in proofs"
        />
      </div>

      {/* Tier distribution + Top tables */}
      <div className="grid lg:grid-cols-2 gap-6 mb-10">
        {/* Tier distribution bar chart */}
        <div className="bg-card rounded-xl border border-border p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <BarChart2 className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-card-foreground">Tier Distribution</h3>
                <p className="text-xs text-muted-foreground">How proofs are classified by latency tiers.</p>
              </div>
            </div>
          </div>
          <div className="space-y-3 mt-2">
            {[
              { label: 'Platinum', value: tierCounts.Platinum, color: 'bg-emerald-500' },
              { label: 'Gold', value: tierCounts.Gold, color: 'bg-yellow-400' },
              { label: 'Silver', value: tierCounts.Silver, color: 'bg-slate-400' },
              { label: 'Fail', value: tierCounts.Fail, color: 'bg-red-500' },
            ].map((row) => {
              const pct = (row.value / totalForTierChart) * 100
              return (
                <div key={row.label}>
                  <div className="flex items-center justify-between mb-1 text-xs">
                    <span className="font-medium text-foreground">{row.label}</span>
                    <span className="text-muted-foreground">
                      {row.value} proof{row.value === 1 ? '' : 's'} ({pct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div className={`h_full ${row.color}`} style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
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
                <p className="text-xs text-muted-foreground">Where proofs are concentrating today.</p>
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
                {topDeals.length === 0 ? (
                  <div className="text-muted-foreground text-xs">No proofs yet.</div>
                ) : (
                  topDeals.map((d) => (
                    <div
                      key={d.dealId}
                      className="flex items-center justify-between bg-muted/40 rounded-lg px-2 py-1.5 border border-border/50"
                    >
                      <div>
                        <div className="text-foreground font-medium">Deal #{d.dealId}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {d.successes} OK · {d.failures} FAIL
                        </div>
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
                {topProviders.length === 0 ? (
                  <div className="text-muted-foreground text-xs">No proofs yet.</div>
                ) : (
                  topProviders.map((p) => (
                    <div
                      key={p.provider}
                      className="flex items-center justify-between bg-muted/40 rounded-lg px-2 py-1.5 border border-border/50"
                    >
                      <div>
                        <div className="font-mono text-[10px] text-indigo-300">
                          {p.provider.slice(0, 10)}...{p.provider.slice(-4)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {p.successes} OK · {p.failures} FAIL
                        </div>
                      </div>
                      <div className="text-xs font-semibold text-primary">{p.count}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Recent proofs timeline */}
      <section className="bg-card rounded-xl border border-border p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Activity className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-card-foreground">Recent Proof Stream</h3>
              <p className="text-xs text-muted-foreground">
                The last {recentProofs.length} proofs recorded by the chain (most recent first).
              </p>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto max-h-80">
          <table className="min-w-full text-xs text-left">
            <thead className="sticky top-0 z-10 bg-muted/70 backdrop-blur">
              <tr>
                <th className="px-3 py-2 font-medium text-muted-foreground">Deal</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Provider</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Tier</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Block</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Status</th>
                <th className="px-3 py-2 font-medium text-muted-foreground">Commitment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {recentProofs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">
                    No proofs recorded yet. Store a file and retrieve it via the dashboard to see live KZG proofs here.
                  </td>
                </tr>
              ) : (
                recentProofs.map((p) => (
                  <tr key={p.id} className="hover:bg-muted/50 transition-colors">
                    <td className="px-3 py-2 text-foreground">
                      {p.dealId ? `#${p.dealId}` : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-indigo-300">
                      {p.creator ? `${p.creator.slice(0, 10)}...${p.creator.slice(-4)}` : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] text-muted-foreground">
                        {p.tier || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{p.blockHeight || 0}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] ${
                          p.valid
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                            : 'border-red-500/40 bg-red-500/10 text-red-300'
                        }`}
                      >
                        {p.valid ? (
                          <>
                            <CheckCircle2 className="w-3 h-3" /> OK
                          </>
                        ) : (
                          <>
                            <XCircle className="w-3 h-3" /> FAIL
                          </>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[10px] text-muted-foreground">
                      {p.commitment.length > 40
                        ? `${p.commitment.slice(0, 32)}…${p.commitment.slice(-8)}`
                        : p.commitment}
                    </td>
                  </tr>
                ))
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

