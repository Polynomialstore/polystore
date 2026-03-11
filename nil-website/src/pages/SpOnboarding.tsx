import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Copy, Download, ExternalLink, Globe, HardDrive, Rocket, Server, Shield, Terminal } from "lucide-react";
import { DashboardCta } from "../components/DashboardCta";

type OnboardingTrack = "local_demo" | "desktop_local" | "remote_headless";

type Step = {
  id: string;
  title: string;
  detail: string;
  successSignal: string;
};

const repoRootUrl = "https://github.com/Nil-Store/nil-store";
const gatewayDesktopReleaseUrl = "https://github.com/Nil-Store/nil-store/releases/latest";
const devnetPlaybookUrl = "https://github.com/Nil-Store/nil-store/blob/main/DEVNET_MULTI_PROVIDER.md";

const localDemoSteps: Step[] = [
  {
    id: "demo-stack",
    title: "Start the local demo stack",
    detail: "Start chain + faucet + demo providers + trusted user-gateway + web UI on one machine (no systemd).",
    successSignal: "Terminal prints “=== Stack ready ===” and the dashboard loads at http://localhost:5173/#/dashboard.",
  },
  {
    id: "demo-providers",
    title: "Confirm providers are available",
    detail: "Mode 2 deals require K+M providers. The dashboard must see providers before it can create a deal.",
    successSignal: "Status bar shows Providers: OK and the deal form does not warn about missing providers.",
  },
  {
    id: "demo-upload",
    title: "Create a deal + upload",
    detail: "Create a deal in the dashboard, then upload a file through the local user-gateway.",
    successSignal: "Upload completes and the file appears in the deal file table.",
  },
  {
    id: "demo-retrieve",
    title: "Retrieve via gateway (default)",
    detail: "Download using Auto source. When the local user-gateway is healthy, downloads should route through it by default.",
    successSignal: "Download succeeds with gateway routing and no provider/session errors.",
  },
];

const desktopLocalSteps: Step[] = [
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
    title: "Prepare provider key + public hostname",
    detail: "Create or import the provider key, then decide whether this machine will publish through Cloudflare Tunnel or direct public ingress.",
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
    title: "Run remote bootstrap + service install",
    detail: "Apply the generated environment, start the provider gateway, and move it under a persistent service manager on the remote machine.",
    successSignal: "Remote provider process is listening and responding on /health.",
  },
  {
    id: "remote-health",
    title: "Continuous health verification",
    detail: "Run provider health checks and repair issues (auth mismatch, endpoint drift, chain mismatch).",
    successSignal: "Checks report healthy/degraded with no critical blockers.",
  },
];

const localDemoScript = `# Local demo SP onboarding (single machine; no systemd)
# From repo root:
./scripts/ensure_stack_local.sh

# Stop everything started by the stack script:
./scripts/run_local_stack.sh stop

# Optional: force 3 demo providers (default is 3)
NIL_LOCAL_PROVIDER_COUNT=3 ./scripts/ensure_stack_local.sh`;

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

# Home-server / Cloudflare Tunnel example
PROVIDER_KEY=provider1 \\
CHAIN_ID=20260211 \\
HUB_LCD=https://lcd.<domain> \\
HUB_NODE=https://rpc.<domain> \\
PROVIDER_ENDPOINT=/dns4/sp.<domain>/tcp/443/https \\
./scripts/run_devnet_provider.sh register

# Start provider service
PROVIDER_KEY=provider1 \\
NIL_GATEWAY_SP_AUTH=<shared-auth-token> \\
NIL_LCD_BASE=https://lcd.<domain> \\
NIL_NODE=https://rpc.<domain> \\
NIL_CHAIN_ID=20260211 \\
PROVIDER_LISTEN=:8091 \\
./scripts/run_devnet_provider.sh start`;

const healthCheckScript = `# Provider and chain health checks
scripts/devnet_healthcheck.sh provider --provider http://127.0.0.1:8091 --hub-lcd https://lcd.<domain>
curl -sf https://lcd.<domain>/nilchain/nilchain/v1/providers | jq '.providers | length'
curl -sf https://sp.<domain>/health

# Gateway download path verification
# Dashboard -> Deal -> Download via gateway
# Expect gateway path + successful receipt pipeline`;

const agentBrief = `You are setting up this machine as a NilStore alpha Storage Provider.

Context:
- The repo is already cloned locally.
- Preferred mode: home server behind NAT with Cloudflare Tunnel.
- Use docs/REMOTE_SP_JOIN_QUICKSTART.md and docs/networking/PROVIDER_ENDPOINTS.md.

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import the provider key.
3. Configure the public endpoint and local listener.
4. Register the provider on-chain.
5. Start the provider service and verify /health locally.
6. Verify public reachability and on-chain visibility.
7. If anything fails, inspect logs, repair, and retry until healthy.

At the end, print:
- provider address
- registered endpoint
- local health URL
- public health URL
- exact commands or files changed`;

function CopyButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-none border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary/40"
    >
      <span className="inline-flex items-center gap-2">
        <Copy className="h-3.5 w-3.5" /> Copy
      </span>
    </button>
  );
}

function PrimaryLinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 rounded-none bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
    >
      {children}
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

export function SpOnboarding() {
  const [track, setTrack] = useState<OnboardingTrack>("remote_headless");
  const [checkedSteps, setCheckedSteps] = useState<Record<string, boolean>>({});
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const activeSteps =
    track === "local_demo"
      ? localDemoSteps
      : track === "desktop_local"
        ? desktopLocalSteps
        : remoteTrackSteps;
  const checkedCount = useMemo(() => activeSteps.filter((step) => checkedSteps[step.id]).length, [activeSteps, checkedSteps]);
  const completionPercent = activeSteps.length === 0 ? 0 : Math.round((checkedCount / activeSteps.length) * 100);
  const activeScript = track === "local_demo" ? localDemoScript : track === "desktop_local" ? localBootstrapScript : remoteBootstrapScript;

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
      <section className="relative overflow-hidden industrial-border border border-border bg-card p-8 shadow-[4px_4px_0px_0px_rgba(0,0,0,0.08)] dark:shadow-[0_0_35px_hsl(var(--primary)_/_0.06)]">
        <div className="absolute -top-24 -right-24 h-72 w-72 bg-primary/20 blur-3xl" />
        <div className="absolute -bottom-24 -left-24 h-72 w-72 bg-accent/20 blur-3xl" />
        <div className="relative space-y-4">
          <div className="inline-flex items-center gap-2 rounded-none border border-primary/30 bg-primary/10 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.2em] font-mono-data text-primary">
            <Server className="h-4 w-4" />
            Alpha Provider Onboarding
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-foreground">Become A Storage Provider</h1>
          <p className="max-w-3xl text-muted-foreground">
            The primary alpha operator path is a remote provider machine, ideally a home server behind Cloudflare Tunnel or a public VPS. Local demo onboarding still exists, but it is not the recommended launch path.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <PrimaryLinkButton href={repoRootUrl}>
              <Terminal className="h-4 w-4" />
              Open Repo
            </PrimaryLinkButton>
            <Link
              to="/alpha/provider"
              className="inline-flex items-center gap-2 rounded-none border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <Rocket className="h-4 w-4" />
              Alpha Provider Path
            </Link>
            <a
              href={devnetPlaybookUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-none border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <Globe className="h-4 w-4" />
              Operator Playbook
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="rounded-none border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-foreground">Guided onboarding flow</h2>
            <div className="text-sm font-medium text-muted-foreground">{checkedCount}/{activeSteps.length} complete ({completionPercent}%)</div>
          </div>

          <div className="mt-4 flex rounded-none border border-border bg-secondary/20 p-1">
            <button
              type="button"
              onClick={() => setTrack("remote_headless")}
              className={`flex-1 rounded-none px-3 py-2 text-sm font-semibold transition-colors ${
                track === "remote_headless" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Home server + tunnel
            </button>
            <button
              type="button"
              onClick={() => setTrack("desktop_local")}
              className={`flex-1 rounded-none px-3 py-2 text-sm font-semibold transition-colors ${
                track === "desktop_local" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Public host / managed
            </button>
            <button
              type="button"
              onClick={() => setTrack("local_demo")}
              className={`flex-1 rounded-none px-3 py-2 text-sm font-semibold transition-colors ${
                track === "local_demo" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Local demo (legacy)
            </button>
          </div>
          <div className="mt-3 rounded-none border border-border bg-card p-3 text-xs text-muted-foreground">
            <div className="font-semibold text-foreground">Scope</div>
            <div className="mt-1">
              This page now targets <span className="font-mono text-foreground">remote/headless alpha provider onboarding</span> first. Local demo remains available for development and smoke testing.
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {activeSteps.map((step, index) => {
              const checked = Boolean(checkedSteps[step.id]);
              return (
                <div
                  key={step.id}
                  className={`rounded-none border p-4 transition-colors ${
                    checked ? "border-accent/40 bg-accent/5" : "border-border bg-card"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => toggleStep(step.id)}
                        className={`mt-0.5 inline-flex h-6 w-6 items-center justify-center border ${
                          checked
                            ? "border-accent/50 bg-accent/20 text-accent"
                            : "border-border bg-card text-muted-foreground"
                        }`}
                    >
                      {checked ? <CheckCircle2 className="h-4 w-4" /> : <span className="text-xs font-bold">{index + 1}</span>}
                    </button>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-foreground">{step.title}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">{step.detail}</p>
                      <p className="mt-2 text-xs font-medium text-accent">
                        Success: {step.successSignal}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-none border border-border bg-card p-6">
          <h2 className="text-xl font-semibold text-foreground">Download + assets</h2>
          <div className="mt-4 space-y-3 text-sm">
            <a
              href={gatewayDesktopReleaseUrl}
              target="_blank"
              rel="noreferrer"
              className="block rounded-none border border-border bg-card p-4 hover:border-primary/50"
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
              className="block rounded-none border border-border bg-card p-4 hover:border-primary/50"
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
              className="block rounded-none border border-border bg-card p-4 hover:border-primary/50"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-foreground">Devnet multi-provider guide</div>
                <ExternalLink className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-1 text-muted-foreground">Canonical operator playbook and environment details.</p>
            </a>
          </div>

          <div className="mt-6 rounded-none border border-primary/30 bg-primary/10 p-4 text-sm text-primary">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4" />
              <div>
                Recommended launch posture: <span className="font-mono">home server + Cloudflare Tunnel</span>. Use local demo only for development, not as the main onboarding path for alpha providers.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-none border border-border bg-card p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-foreground">Bootstrap commands</h2>
            <CopyButton onClick={() => void copyText("Bootstrap script", activeScript)} />
          </div>
          <pre className="mt-4 overflow-x-auto rounded-none border border-border bg-secondary/20 p-4 text-xs text-muted-foreground">
            {activeScript}
          </pre>
        </div>

        <div className="rounded-none border border-border bg-card p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-foreground">Health + download verification</h2>
            <CopyButton onClick={() => void copyText("Health script", healthCheckScript)} />
          </div>
          <pre className="mt-4 overflow-x-auto rounded-none border border-border bg-secondary/20 p-4 text-xs text-muted-foreground">
            {healthCheckScript}
          </pre>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <DashboardCta className="inline-flex justify-center" label="Dashboard" to="/dashboard" />
            <Link
              to="/devnet"
              className="rounded-none border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              Open Devnet Join
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-8 rounded-none border border-border bg-card p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-foreground">Agent bootstrap brief</h2>
          <CopyButton onClick={() => void copyText("Agent bootstrap brief", agentBrief)} />
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          If the operator has Codex or Claude Code on the provider machine, this is the recommended starting prompt. Later PRs will replace this generic brief with generated host-specific prompts and bundles.
        </p>
        <pre className="mt-4 overflow-x-auto rounded-none border border-border bg-secondary/20 p-4 text-xs text-muted-foreground">
          {agentBrief}
        </pre>
      </section>

      <section className="mt-8 rounded-none border border-border bg-card p-6">
        <h2 className="text-xl font-semibold text-foreground">Operational UX model</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="rounded-none border border-border bg-card p-4">
            <div className="flex items-center gap-2 font-semibold text-foreground"><Shield className="h-4 w-4 text-accent" /> Healthy</div>
            <p className="mt-2 text-sm text-muted-foreground">All critical checks pass: chain connectivity, service availability, endpoint reachability, auth compatibility.</p>
          </div>
          <div className="rounded-none border border-border bg-card p-4">
            <div className="flex items-center gap-2 font-semibold text-foreground"><Server className="h-4 w-4 text-primary" /> Degraded</div>
            <p className="mt-2 text-sm text-muted-foreground">Provider is reachable but drift or partial check failures exist. Review remediation actions before serving production traffic.</p>
          </div>
          <div className="rounded-none border border-border bg-card p-4">
            <div className="flex items-center gap-2 font-semibold text-foreground"><HardDrive className="h-4 w-4 text-destructive" /> Critical</div>
            <p className="mt-2 text-sm text-muted-foreground">Service down, chain mismatch, auth mismatch, or endpoint failure. Upload/download reliability is blocked until fixed.</p>
          </div>
        </div>
      </section>

      {copyStatus ? (
        <div className="mt-5 rounded-none border border-accent/40 bg-accent/10 px-4 py-2 text-sm text-accent">
          {copyStatus}
        </div>
      ) : null}
    </div>
  );
}
