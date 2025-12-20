import { useEffect, useMemo, useState } from 'react'
import { Terminal, Server, Globe, Link as LinkIcon } from 'lucide-react'
import { appConfig } from '../config'
import { multiaddrToHttpUrl } from '../lib/multiaddr'

type Provider = {
  address: string
  capabilities: string
  total_storage: string
  used_storage: string
  status: string
  reputation_score: string
  endpoints?: string[]
}

export function Devnet() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setErr(null)
      try {
        const res = await fetch(`${appConfig.lcdBase}/nilchain/nilchain/v1/providers`)
        if (!res.ok) throw new Error(`LCD returned ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        setProviders(Array.isArray(json.providers) ? (json.providers as Provider[]) : [])
      } catch (e) {
        if (cancelled) return
        setErr(e instanceof Error ? e.message : String(e))
        setProviders([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    const interval = window.setInterval(load, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [])

  const joinSnippet = useMemo(() => {
    return [
      '# On your provider machine (repo checked out):',
      'PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh init',
      '',
      '# Ask the hub operator to fund your nil1 address with stake (gas), then:',
      `HUB_NODE="tcp://<hub-host>:26657" \\`,
      `HUB_LCD="${appConfig.lcdBase}" \\`,
      `CHAIN_ID="${appConfig.cosmosChainId}" \\`,
      'PROVIDER_KEY="provider1" \\',
      'PROVIDER_ENDPOINT="/ip4/<public-ip>/tcp/8091/http" \\',
      './scripts/run_devnet_provider.sh register',
      '',
      '# Start the provider gateway:',
      'NIL_GATEWAY_SP_AUTH="<shared-from-hub>" \\',
      `NIL_LCD_BASE="${appConfig.lcdBase}" \\`,
      'NIL_NODE="tcp://<hub-host>:26657" \\',
      `NIL_CHAIN_ID="${appConfig.cosmosChainId}" \\`,
      'PROVIDER_KEY="provider1" \\',
      'PROVIDER_LISTEN=":8091" \\',
      './scripts/run_devnet_provider.sh start',
    ].join('\n')
  }, [])

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-5xl">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-foreground flex items-center gap-3">
          <Globe className="w-8 h-8 text-cyan-500" />
          Devnet (Multi-Provider)
        </h1>
        <p className="mt-3 text-muted-foreground">
          Join a shared devnet as a Storage Provider (SP), or verify which providers are currently registered on-chain.
          Browser clients can operate without a user gateway, but providers must still run their gateway service.
        </p>
      </div>

      <div className="grid gap-6">
        <section className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-2 text-foreground font-semibold">
            <LinkIcon className="w-5 h-5 text-indigo-500" />
            Hub Endpoints
          </div>
          <div className="mt-4 grid md:grid-cols-2 gap-4 text-sm">
            <div className="bg-secondary/20 border border-border rounded-lg p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Gateway Router (Optional)</div>
              <div className="font-mono text-foreground">{appConfig.gatewayBase}</div>
            </div>
            <div className="bg-secondary/20 border border-border rounded-lg p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">LCD</div>
              <div className="font-mono text-foreground">{appConfig.lcdBase}</div>
            </div>
            <div className="bg-secondary/20 border border-border rounded-lg p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">EVM RPC</div>
              <div className="font-mono text-foreground">{appConfig.evmRpc}</div>
            </div>
            <div className="bg-secondary/20 border border-border rounded-lg p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Chain IDs</div>
              <div className="font-mono text-foreground">
                EVM {appConfig.chainId} · Cosmos {appConfig.cosmosChainId}
              </div>
            </div>
          </div>
        </section>

        <section className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-2 text-foreground font-semibold">
            <Terminal className="w-5 h-5 text-purple-500" />
            Join As A Provider
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Providers must register reachable HTTP endpoints (Multiaddr) and run the provider gateway. The hub operator must
            share a `NIL_GATEWAY_SP_AUTH` token. User gateways are optional; direct-to-provider flows are supported for browser clients.
          </p>
          <pre className="mt-4 text-xs bg-secondary/20 border border-border rounded-lg p-4 overflow-x-auto text-muted-foreground">
            {joinSnippet}
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">
            Full guide: see <span className="font-mono">DEVNET_MULTI_PROVIDER.md</span> in the repo.
          </p>
        </section>

        <section className="bg-card rounded-xl border border-border overflow-hidden">
          <div className="px-6 py-4 border-b border-border bg-muted/30 flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-foreground">
              <Server className="w-5 h-5 text-emerald-500" />
              Providers
            </div>
            <div className="text-xs text-muted-foreground">{loading ? 'Refreshing…' : `${providers.length} registered`}</div>
          </div>
          {err && <div className="px-6 py-4 text-sm text-red-600 dark:text-red-400">Failed to load providers: {err}</div>}
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-xs">
              <thead className="bg-muted/20">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground uppercase tracking-wider">Address</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground uppercase tracking-wider">Capabilities</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground uppercase tracking-wider">Endpoints</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {providers.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-muted-foreground" colSpan={4}>
                      No providers found. If you’re running locally, start the hub and register at least one provider.
                    </td>
                  </tr>
                ) : (
                  providers.map((p) => {
                    const eps = Array.isArray(p.endpoints) ? p.endpoints : []
                    const urls = eps.map(multiaddrToHttpUrl).filter(Boolean) as string[]
                    return (
                      <tr key={p.address} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3 font-mono text-[11px] text-primary">{p.address}</td>
                        <td className="px-4 py-3 text-foreground">{p.status || '—'}</td>
                        <td className="px-4 py-3 text-foreground">{p.capabilities || '—'}</td>
                        <td className="px-4 py-3">
                          {eps.length === 0 ? (
                            <span className="text-muted-foreground italic">No endpoints</span>
                          ) : (
                            <div className="space-y-1">
                              <div className="font-mono text-[11px] text-muted-foreground break-all">{eps.join(', ')}</div>
                              {urls.length > 0 && (
                                <div className="font-mono text-[11px] text-foreground break-all">{urls.join(', ')}</div>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}
