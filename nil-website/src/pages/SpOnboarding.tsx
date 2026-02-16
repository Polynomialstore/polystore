import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Download, ExternalLink, Globe, HardDrive, Rocket, Server, Shield, Terminal } from "lucide-react";

type OnboardingTrack = "desktop_local" | "remote_headless";

type Step = {
  id: string;
  title: string;
  detail: string;
  successSignal: string;
};

const gatewayDesktopReleaseUrl = "https://github.com/Nil-Store/nil-store/releases/latest";
const repoRootUrl = "https://github.com/Nil-Store/nil-store";
const devnetPlaybookUrl = "https://github.com/Nil-Store/nil-store/blob/main/DEVNET_MULTI_PROVIDER.md";

const localTrackSteps: Step[] = [
  {
    id: "local-download",
    title: "Install Gateway Desktop",
    detail: "Download the latest nil_gateway_gui build and launch the desktop app on the provider machine.",
    successSignal: "Desktop app opens and shows the SP Launchpad workspace.",
  },
  {
    id: "local-identity",
    title: "Create provider identity",
    detail: "In SP Launchpad, create provider key identity (or import an existing key for continuity).",
    successSignal: "Provider address is visible and key step is marked ready.",
  },
  {
    id: "local-funding",
    title: "Fund provider key",
    detail: "Fund the provider account with chain gas/stake and verify balance in the onboarding step.",
    successSignal: "Funding check passes with sufficient balance.",
  },
  {
    id: "local-register",
    title: "Validate endpoint and register",
    detail: "Use the endpoint validator, then register the provider on-chain with the validated endpoint.",
    successSignal: "Registration step succeeds and provider is visible in list-providers.",
  },
  {
    id: "local-health",
    title: "Start service and verify health",
    detail: "Start the provider service and run health snapshot checks until status is healthy.",
    successSignal: "Health snapshot is healthy with no critical issues.",
  },
];

const remoteTrackSteps: Step[] = [
  {
    id: "remote-identity",
    title: "Prepare provider key + endpoint",
    detail: "Create/import provider key and choose a public endpoint (direct or tunnel) for the remote host.",
    successSignal: "Provider address and endpoint are finalized.",
  },
  {
    id: "remote-register",
    title: "Register on-chain",
    detail: "Register provider endpoint and capability settings against the target chain.",
    successSignal: "Provider appears in on-chain provider list.",
  },
  {
    id: "remote-runbook",
    title: "Run remote bootstrap",
    detail: "Apply generated environment and start commands on the remote machine.",
    successSignal: "Remote provider process is listening and responding on /health.",
  },
  {
    id: "remote-health",
    title: "Continuous health verification",
    detail: "Run provider health checks and repair issues (auth mismatch, endpoint drift, chain mismatch).",
    successSignal: "Checks report healthy/degraded with no critical blockers.",
  },
];

const localBootstrapScript = `# 1) Launch Desktop Gateway GUI
cd nil_gateway_gui
npm ci
npm run desktop

# 2) In the app:
#    SP Launchpad -> Onboarding -> Local mode
#    Create key -> Check funding -> Validate endpoint
#    Register provider -> Start service -> Run health check`;

const remoteBootstrapScript = `# Provider host bootstrap
PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh init

# Register endpoint on chain
PROVIDER_KEY=provider1 \\
CHAIN_ID=20260211 \\
HUB_LCD=http://127.0.0.1:1317 \\
HUB_NODE=tcp://127.0.0.1:26657 \\
PROVIDER_ENDPOINT=/ip4/<public-ip>/tcp/8091/http \\
./scripts/run_devnet_provider.sh register

# Start provider service
PROVIDER_KEY=provider1 \\
NIL_GATEWAY_SP_AUTH=<shared-auth-token> \\
PROVIDER_LISTEN=:8091 \\
./scripts/run_devnet_provider.sh start`;

const healthCheckScript = `# Provider and chain health checks
scripts/devnet_healthcheck.sh provider --provider http://127.0.0.1:8091 --hub-lcd http://127.0.0.1:1317
nilchaind query nilchain list-providers --home _artifacts/nilchain_data_devnet_alpha

# Gateway download path verification
# Dashboard -> Deal -> Download via gateway
# Expect gateway path + successful receipt pipeline`;

export function SpOnboarding() {
  const [track, setTrack] = useState<OnboardingTrack>("desktop_local");
  const [checkedSteps, setCheckedSteps] = useState<Record<string, boolean>>({});
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const activeSteps = track === "desktop_local" ? localTrackSteps : remoteTrackSteps;
  const checkedCount = useMemo(() => activeSteps.filter((step) => checkedSteps[step.id]).length, [activeSteps, checkedSteps]);
  const completionPercent = activeSteps.length === 0 ? 0 : Math.round((checkedCount / activeSteps.length) * 100);
  const activeScript = track === "desktop_local" ? localBootstrapScript : remoteBootstrapScript;

  const toggleStep = (id: string) => {
    setCheckedSteps((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const copyText = async (label: string, text: string) => {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        setCopyStatus(`Clipboard not available for ${label}.`);
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopyStatus(`${label} copied.`);
      window.setTimeout(() => setCopyStatus(null), 2000);
    } catch {
      setCopyStatus(`Could not copy ${label}.`);
    }
  };

  return (
    <div className="pt-24 pb-12 px-4 container mx-auto max-w-6xl">
      <section className="relative overflow-hidden rounded-2xl border border-border/70 bg-gradient-to-br from-cyan-500/10 via-background to-blue-500/10 p-8">
        <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-cyan-500/20 blur-3xl" />
        <div className="absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-blue-500/20 blur-3xl" />
        <div className="relative space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-cyan-600 dark:text-cyan-300">
            <Server className="h-4 w-4" />
            Storage Provider Companion
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground">SP Onboarding Companion</h1>
          <p className="max-w-3xl text-muted-foreground">
            This is the finalized web companion for provider onboarding. Use it alongside the desktop SP Launchpad to install, register, health-check, and verify download behavior end-to-end.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <a
              href={gatewayDesktopReleaseUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              <Download className="h-4 w-4" />
              Download Gateway Desktop
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background/80 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <Rocket className="h-4 w-4" />
              Open Dashboard
            </Link>
            <a
              href={devnetPlaybookUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-md border border-border bg-background/80 px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <Globe className="h-4 w-4" />
              Operator Playbook
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-foreground">Guided onboarding flow</h2>
            <div className="text-sm font-medium text-muted-foreground">{checkedCount}/{activeSteps.length} complete ({completionPercent}%)</div>
          </div>

          <div className="mt-4 flex rounded-lg border border-border bg-secondary/20 p-1">
            <button
              type="button"
              onClick={() => setTrack("desktop_local")}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                track === "desktop_local" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Desktop + Local
            </button>
            <button
              type="button"
              onClick={() => setTrack("remote_headless")}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                track === "remote_headless" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Remote + Headless
            </button>
          </div>

          <div className="mt-5 space-y-3">
            {activeSteps.map((step, index) => {
              const checked = Boolean(checkedSteps[step.id]);
              return (
                <div
                  key={step.id}
                  className={`rounded-lg border p-4 transition-colors ${
                    checked ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-background/70"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => toggleStep(step.id)}
                      className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-full border ${
                        checked
                          ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-500"
                          : "border-border bg-background text-muted-foreground"
                      }`}
                    >
                      {checked ? <CheckCircle2 className="h-4 w-4" /> : <span className="text-xs font-bold">{index + 1}</span>}
                    </button>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-foreground">{step.title}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{step.detail}</p>
                      <p className="mt-2 text-xs font-medium text-emerald-600 dark:text-emerald-300">
                        Success: {step.successSignal}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="text-xl font-semibold text-foreground">Download + assets</h2>
          <div className="mt-4 space-y-3 text-sm">
            <a
              href={gatewayDesktopReleaseUrl}
              target="_blank"
              rel="noreferrer"
              className="block rounded-lg border border-border bg-background/70 p-4 hover:border-primary/50"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-foreground">Gateway Desktop GUI</div>
                <Download className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-1 text-muted-foreground">Recommended for local onboarding, health checks, and diagnostics.</p>
            </a>
            <a
              href={repoRootUrl}
              target="_blank"
              rel="noreferrer"
              className="block rounded-lg border border-border bg-background/70 p-4 hover:border-primary/50"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-foreground">Repo source + scripts</div>
                <Terminal className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-1 text-muted-foreground">Use scripts for remote/headless provider bootstrap and automation.</p>
            </a>
            <a
              href={devnetPlaybookUrl}
              target="_blank"
              rel="noreferrer"
              className="block rounded-lg border border-border bg-background/70 p-4 hover:border-primary/50"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-foreground">Devnet multi-provider guide</div>
                <ExternalLink className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-1 text-muted-foreground">Canonical operator playbook and environment details.</p>
            </a>
          </div>

          <div className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4" />
              <div>
                Keep local loopback access enabled (`localhost` + `127.0.0.1`) in your browser when testing dashboard-to-gateway flows.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-foreground">Bootstrap commands</h2>
            <button
              type="button"
              onClick={() => void copyText("Bootstrap script", activeScript)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/40"
            >
              Copy
            </button>
          </div>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-secondary/20 p-4 text-xs text-muted-foreground">
            {activeScript}
          </pre>
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-foreground">Health + download verification</h2>
            <button
              type="button"
              onClick={() => void copyText("Health script", healthCheckScript)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/40"
            >
              Copy
            </button>
          </div>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-secondary/20 p-4 text-xs text-muted-foreground">
            {healthCheckScript}
          </pre>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Link
              to="/dashboard"
              className="rounded-lg border border-border bg-background/70 px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              Open Dashboard
            </Link>
            <Link
              to="/devnet"
              className="rounded-lg border border-border bg-background/70 px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              Open Devnet Join
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-8 rounded-xl border border-border bg-card p-6">
        <h2 className="text-xl font-semibold text-foreground">Operational UX model</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <div className="flex items-center gap-2 font-semibold text-foreground"><Shield className="h-4 w-4 text-emerald-500" /> Healthy</div>
            <p className="mt-2 text-sm text-muted-foreground">All critical checks pass: chain connectivity, service availability, endpoint reachability, auth compatibility.</p>
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <div className="flex items-center gap-2 font-semibold text-foreground"><Server className="h-4 w-4 text-amber-500" /> Degraded</div>
            <p className="mt-2 text-sm text-muted-foreground">Provider is reachable but drift or partial check failures exist. Review remediation actions before serving production traffic.</p>
          </div>
          <div className="rounded-lg border border-border bg-background/70 p-4">
            <div className="flex items-center gap-2 font-semibold text-foreground"><HardDrive className="h-4 w-4 text-red-500" /> Critical</div>
            <p className="mt-2 text-sm text-muted-foreground">Service down, chain mismatch, auth mismatch, or endpoint failure. Upload/download reliability is blocked until fixed.</p>
          </div>
        </div>
      </section>

      {copyStatus ? (
        <div className="mt-5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          {copyStatus}
        </div>
      ) : null}
    </div>
  );
}

