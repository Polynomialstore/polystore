import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, CheckCircle2, Database, Globe, Server, TriangleAlert, XCircle } from "lucide-react";
import { AlphaHero } from "../components/marketing/AlphaHero";
import { TrackCard } from "../components/marketing/TrackCard";
import { StatusBar } from "../components/StatusBar";
import { PrimaryCtaLink } from "../components/PrimaryCta";
import { fetchStatus, type ServiceStatus } from "../lib/status";
import { appConfig } from "../config";
import { lcdFetchProviders } from "../api/lcdClient";
import type { LcdProvider } from "../domain/lcd";
import { multiaddrToHttpUrl } from "../lib/multiaddr";

const STATUS_POLL_MS = 30_000;

type StatusState = {
  summary: Awaited<ReturnType<typeof fetchStatus>> | null;
  providers: LcdProvider[];
  loading: boolean;
  error: string | null;
};

function statusTone(status: ServiceStatus): string {
  switch (status) {
    case "ok":
      return "text-accent";
    case "error":
      return "text-destructive";
    default:
      return "text-primary";
  }
}

function StatusIcon({ status }: { status: ServiceStatus }) {
  if (status === "ok") return <CheckCircle2 className={`h-4 w-4 ${statusTone(status)}`} />;
  if (status === "error") return <XCircle className={`h-4 w-4 ${statusTone(status)}`} />;
  return <TriangleAlert className={`h-4 w-4 ${statusTone(status)}`} />;
}

export function AlphaStatus() {
  const [state, setState] = useState<StatusState>({
    summary: null,
    providers: [],
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [summary, providers] = await Promise.all([
          fetchStatus(appConfig.chainId, { probeOptionalHealth: true }),
          lcdFetchProviders(appConfig.lcdBase),
        ]);

        if (cancelled) return;
        setState({
          summary,
          providers,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        setState((current) => ({
          summary: current.summary,
          providers: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }

    void load();
    const interval = window.setInterval(load, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const summary = state.summary;

  const headlineStatus = useMemo<ServiceStatus>(() => {
    if (!summary) return "warn";
    if (summary.lcd === "error" || summary.evm === "error") return "error";
    if ((summary.providerCount ?? 0) === 0) return "warn";
    return "ok";
  }, [summary]);

  const providerRows = useMemo(() => {
    return state.providers.map((provider) => {
      const endpoints = Array.isArray(provider.endpoints) ? provider.endpoints : [];
      const httpEndpoints = endpoints.map(multiaddrToHttpUrl).filter(Boolean) as string[];
      return {
        address: provider.address,
        status: provider.status || "UNKNOWN",
        endpointMultiaddr: endpoints[0] || "—",
        endpointHttp: httpEndpoints[0] || "—",
      };
    });
  }, [state.providers]);

  const knownIssues = useMemo(() => {
    const items: string[] = [];
    if (!summary) {
      items.push("Live network status is still loading.");
      return items;
    }
    if (summary.lcd !== "ok") items.push("LCD is degraded or unreachable.");
    if (summary.evm !== "ok") items.push("EVM RPC is degraded or returning the wrong chain ID.");
    if (summary.faucet === "warn") items.push("Faucet health is degraded or disabled for this deployment.");
    if ((summary.providerCount ?? 0) === 0) items.push("No providers are currently visible on-chain.");
    if (items.length === 0) items.push("No critical network issues detected from the website status probes.");
    return items;
  }, [summary]);

  return (
    <div className="px-4 pb-12 pt-24">
      <div className="container mx-auto max-w-6xl">
        <AlphaHero
          badge="/alpha/status"
          logo={
            <div className="flex h-full w-full items-center justify-center">
              <Activity className="h-14 w-14 text-primary" />
            </div>
          }
          title={<h1 className="text-4xl font-extrabold tracking-tight sm:text-6xl">Testnet Status</h1>}
          description="This is the shared operational view for storage users and provider operators. It consolidates chain reachability, provider visibility, and the public endpoints the testnet depends on."
          actions={
            <>
              <PrimaryCtaLink to="/alpha/storage">Start Storing</PrimaryCtaLink>
              <Link
                to="/alpha/provider"
                className="inline-flex items-center justify-center rounded-none border border-border bg-card px-6 py-3 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-foreground transition-colors hover:bg-secondary"
              >
                Become A Provider
              </Link>
            </>
          }
        />

        <div className="mt-6">
          <StatusBar />
        </div>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          <TrackCard
            icon={<Database className="h-6 w-6 text-accent" />}
            title="Storage Signal"
            description="Storage users can check wallet-facing chain health, faucet availability, and provider count before debugging browser or deal flow issues."
          />
          <TrackCard
            icon={<Server className="h-6 w-6 text-primary" />}
            title="Provider Signal"
            description="Provider operators can quickly tell whether the network sees active providers and which public endpoints are expected to answer."
          />
          <TrackCard
            icon={<Globe className="h-6 w-6 text-primary" />}
            title="Public Surface"
            description="The page keeps the testnet surface area explicit: RPC, LCD, EVM, faucet, website, and the currently visible provider endpoints."
          />
        </div>

        <section className="mt-12 grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="glass-panel industrial-border p-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
              /alpha/status/overview
            </div>
            <div className="mt-3 flex items-center gap-3">
              <StatusIcon status={headlineStatus} />
              <h2 className="text-2xl font-bold text-foreground">Network overview</h2>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {state.loading
                ? "Refreshing live network probes."
                : summary
                  ? "The website is polling the public chain and provider surfaces directly."
                  : "No live summary has been loaded yet."}
            </p>

            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <MetricCard label="LCD" value={summary?.lcd?.toUpperCase() || "—"} status={summary?.lcd || "warn"} />
              <MetricCard label="EVM RPC" value={summary?.evm?.toUpperCase() || "—"} status={summary?.evm || "warn"} />
              <MetricCard
                label="Providers"
                value={summary?.providerCount !== undefined ? String(summary.providerCount) : "—"}
                status={(summary?.providerCount ?? 0) > 0 ? "ok" : "warn"}
              />
              <MetricCard
                label="Wallet Chain"
                value={summary?.chainIdMatch?.toUpperCase() || "—"}
                status={summary?.chainIdMatch || "warn"}
              />
            </div>

            <div className="mt-6 rounded-none border border-border bg-background/60 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Known issues</div>
              <div className="mt-3 space-y-3">
                {knownIssues.map((item) => (
                  <div key={item} className="flex items-start gap-3 text-sm leading-relaxed text-muted-foreground">
                    <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="glass-panel industrial-border p-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
              /alpha/status/endpoints
            </div>
            <h2 className="mt-3 text-2xl font-bold text-foreground">Public endpoints</h2>
            <div className="mt-5 space-y-3">
              <EndpointRow label="Website" value={appConfig.explorerBase} />
              <EndpointRow label="EVM RPC" value={appConfig.evmRpc} />
              <EndpointRow label="LCD" value={appConfig.lcdBase} />
              <EndpointRow label="Gateway" value={appConfig.gatewayBase} />
              <EndpointRow label="Faucet" value={appConfig.apiBase} />
            </div>

            {state.error ? (
              <div className="mt-6 rounded-none border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                Failed to refresh full status: {state.error}
              </div>
            ) : null}
          </div>
        </section>

        <section className="mt-12 glass-panel industrial-border p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">
                /alpha/status/providers
              </div>
              <h2 className="mt-3 text-2xl font-bold text-foreground">Visible providers</h2>
            </div>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {state.loading ? "Refreshing" : `${providerRows.length} visible`}
            </div>
          </div>

          <div className="mt-6 overflow-x-auto rounded-none border border-border">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-background/80">
                <tr>
                  <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Address</th>
                  <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">Endpoint</th>
                  <th className="px-4 py-3 text-left text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">HTTP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-background/40">
                {providerRows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-6 text-muted-foreground" colSpan={4}>
                      No providers are visible yet. If the network should already have providers, check the LCD endpoint and provider registration flow.
                    </td>
                  </tr>
                ) : (
                  providerRows.map((provider) => (
                    <tr key={provider.address}>
                      <td className="px-4 py-3 font-mono text-xs text-primary">{provider.address}</td>
                      <td className="px-4 py-3 text-foreground">{provider.status}</td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{provider.endpointMultiaddr}</td>
                      <td className="px-4 py-3 font-mono text-xs text-foreground">{provider.endpointHttp}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: ServiceStatus;
}) {
  return (
    <div className="rounded-none border border-border bg-background/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">{label}</div>
        <StatusIcon status={status} />
      </div>
      <div className={`mt-3 text-2xl font-bold ${statusTone(status)}`}>{value}</div>
    </div>
  );
}

function EndpointRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-none border border-border bg-background/70 p-4">
      <div className="text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-muted-foreground">{label}</div>
      <div className="mt-2 break-all font-mono text-sm text-foreground">{value}</div>
    </div>
  );
}
