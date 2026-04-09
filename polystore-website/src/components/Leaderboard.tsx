import React, { useEffect, useState } from 'react'
import { appConfig } from '../config'

interface Provider {
  address: string
  total_storage: string
  used_storage: string
  capabilities: string
  status: string
}

export const Leaderboard: React.FC = () => {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const url = `${appConfig.lcdBase}/polystorechain/polystorechain/v1/providers`

    fetch(url, { signal: controller.signal })
      .then((res) => res.json())
      .then(data => {
        setProviders(data.providers || [])
        setLoading(false)
      })
      .catch(err => {
        if (controller.signal.aborted) return
        console.error("Failed to fetch providers:", err)
        setLoading(false)
      })

    return () => controller.abort()
  }, [])

  if (loading) {
    return (
      <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground animate-pulse">
        Loading leaderboard…
      </div>
    )
  }

  return (
    <div className="relative overflow-hidden glass-panel industrial-border p-6 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_30px_hsl(var(--primary)_/_0.06)] mt-8">
      <div className="absolute inset-0 cyber-grid opacity-20 pointer-events-none" />

      <div className="relative mb-4">
        <div className="text-[10px] uppercase tracking-[0.2em] font-bold font-mono-data text-muted-foreground">
          /net/providers
        </div>
        <h2 className="mt-2 text-xl font-bold text-foreground">Storage Providers Leaderboard</h2>
      </div>

      <div className="relative overflow-x-auto">
        <table className="min-w-full text-left text-[11px] text-muted-foreground">
          <thead className="bg-background/40">
            <tr className="uppercase tracking-[0.2em] text-[10px] font-bold font-mono-data">
              <th className="py-3 px-4 text-left">Address</th>
              <th className="py-3 px-4 text-left">Capabilities</th>
              <th className="py-3 px-4 text-right">Total</th>
              <th className="py-3 px-4 text-right">Used</th>
              <th className="py-3 px-4 text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {providers.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 px-4 text-center text-muted-foreground">
                  No providers found.
                </td>
              </tr>
            ) : (
              providers.map((p) => {
                const isActive = String(p.status || '').toLowerCase() === 'active'
                return (
                  <tr key={p.address} className="hover:bg-muted/30 transition-colors">
                    <td className="py-3 px-4 font-mono-data text-foreground whitespace-nowrap">{p.address}</td>
                    <td className="py-3 px-4">{p.capabilities}</td>
                    <td className="py-3 px-4 text-right font-mono-data text-foreground">{p.total_storage}</td>
                    <td className="py-3 px-4 text-right font-mono-data text-foreground">{p.used_storage}</td>
                    <td className="py-3 px-4 text-center">
                      <span
                        className={`inline-flex items-center px-2 py-1 border text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data ${
                          isActive
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-destructive/40 bg-destructive/10 text-destructive'
                        }`}
                      >
                        {isActive ? 'ACTIVE' : String(p.status || 'UNKNOWN').toUpperCase()}
                      </span>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
