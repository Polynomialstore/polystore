import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, Cell } from 'recharts'
import { ProofRow } from '../hooks/useProofs'

interface Props {
  proofs: ProofRow[];
}

const tierMap: Record<string, number> = {
  'Platinum': 3,
  'Gold': 2,
  'Silver': 1,
  'Fail': 0,
}

const chartTickColor = 'hsl(var(--muted-foreground))'
const chartAxisColor = 'hsl(var(--border))'
const chartGridColor = 'hsl(var(--border) / 0.35)'

function tierFillColor(entry: { tierLabel?: string; valid?: boolean }): string {
  const isValid = Boolean(entry.valid)
  const tier = String(entry.tierLabel || '').trim()
  if (!isValid) return 'hsl(var(--destructive))'
  if (tier === 'Platinum') return 'hsl(var(--accent))'
  if (tier === 'Gold') return 'hsl(var(--primary))'
  if (tier === 'Silver') return 'hsl(var(--muted-foreground))'
  return 'hsl(var(--destructive) / 0.7)'
}

export function DealLivenessHeatmap({ proofs }: Props) {
  // Sort proofs by block height (descending)
  const sortedProofs = [...proofs].sort((a, b) => b.blockHeight - a.blockHeight)
  
  // Transform for ScatterChart
  const data = sortedProofs.map(p => ({
    block: p.blockHeight,
    tierValue: tierMap[p.tier || 'Fail'] ?? 0,
    tierLabel: p.tier || 'Unknown',
    valid: p.valid,
    creator: p.creator,
    id: p.id,
  }))

  if (data.length === 0) {
      return (
          <div className="relative h-32 overflow-hidden glass-panel industrial-border flex items-center justify-center">
            <div className="absolute inset-0 cyber-grid opacity-25 pointer-events-none" />
            <div className="relative text-[10px] font-mono-data text-muted-foreground uppercase tracking-[0.2em] font-bold">
              No proofs recorded yet.
            </div>
          </div>
      )
  }

  return (
    <div className="relative h-64 w-full overflow-hidden glass-panel industrial-border p-4 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_30px_hsl(var(--primary)_/_0.06)]">
        <div className="absolute inset-0 cyber-grid opacity-25 pointer-events-none" />

        <div className="relative mb-2">
          <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">
            /mnt/liveness_history
          </div>
          <h4 className="mt-1 text-xs font-semibold text-foreground uppercase tracking-[0.2em] font-mono-data">
            Liveness History
          </h4>
        </div>

        <div className="relative h-[calc(100%-2.5rem)]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
                <XAxis 
                    type="number" 
                    dataKey="block" 
                    name="Block Height" 
                    domain={['auto', 'auto']}
                    tick={{ fill: chartTickColor, fontSize: 10 }}
                    tickLine={false}
                    axisLine={{ stroke: chartAxisColor }}
                />
                <YAxis 
                    type="number" 
                    dataKey="tierValue" 
                    name="Tier" 
                    domain={[0, 3]}
                    ticks={[0, 1, 2, 3]}
                    tickFormatter={(val) => {
                        const keys = Object.keys(tierMap)
                        return keys.find(k => tierMap[k] === val) || ''
                    }}
                    tick={{ fill: chartTickColor, fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                    width={60}
                />
                <ZAxis type="number" range={[50, 50]} />
                <Tooltip 
                    cursor={{ strokeDasharray: '3 3', stroke: chartGridColor }}
                    content={({ active, payload }) => {
                        if (active && payload && payload.length) {
                            const d = payload[0].payload
                            return (
                                <div className="glass-panel industrial-border p-3 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.10)] dark:shadow-[0_0_24px_hsl(var(--primary)_/_0.10)]">
                                  <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">
                                    Block
                                  </div>
                                  <div className="mt-1 text-[11px] font-mono-data text-foreground">
                                    {d.block}
                                  </div>

                                  <div className="mt-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data">
                                    <span className={`h-1.5 w-1.5 rounded-none ${d.valid ? 'bg-success pulse-status' : 'bg-destructive'}`} />
                                    <span className={d.valid ? 'text-success' : 'text-destructive'}>
                                      {d.valid ? 'VALID' : 'INVALID'}
                                    </span>
                                  </div>

                                  <div className="mt-2 text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">
                                    Tier
                                  </div>
                                  <div className="mt-1 text-[11px] font-mono-data text-foreground">
                                    {d.tierLabel}
                                  </div>

                                  <div className="mt-2 text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">
                                    Provider
                                  </div>
                                  <div className="mt-1 max-w-[220px] truncate text-[11px] font-mono-data text-muted-foreground">
                                    {d.creator}
                                  </div>
                                </div>
                            )
                        }
                        return null
                    }}
                />
                <Scatter name="Proofs" data={data}>
                    {data.map((entry, index) => (
                        <Cell 
                            key={`cell-${index}`} 
                            fill={tierFillColor(entry)}
                        />
                    ))}
                </Scatter>
            </ScatterChart>
        </ResponsiveContainer>
        </div>
    </div>
  )
}
