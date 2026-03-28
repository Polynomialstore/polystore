import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, CheckCircle2, Copy, Download, ExternalLink, Globe, HardDrive, Rocket, Server, Shield, Terminal } from "lucide-react";
import { DashboardCta } from "../components/DashboardCta";
import { PrimaryCtaAnchor } from "../components/PrimaryCta";

type Step = {
  id: string;
  title: string;
  detail: string;
  successSignal: string;
};

const repoRootUrl = "https://github.com/Nil-Store/nil-store";
const gatewayDesktopReleaseUrl = "https://github.com/Nil-Store/nil-store/releases/latest";
const devnetPlaybookUrl = "https://github.com/Nil-Store/nil-store/blob/main/DEVNET_MULTI_PROVIDER.md";

const providerHappyPathSteps: Step[] = [
  {
    id: "inputs",
    title: "Collect hub inputs",
    detail: "Get your chain ID, hub RPC/LCD, shared provider auth token, and your public hostname from the hub operator.",
    successSignal: "You have CHAIN_ID, HUB_NODE, HUB_LCD, NIL_GATEWAY_SP_AUTH, and a public hostname.",
  },
  {
    id: "clone",
    title: "Clone the repo on the provider host",
    detail: "Run onboarding from the provider machine. The happy path is repo-first: clone, set env vars, run one bootstrap command.",
    successSignal: "You can run ./scripts/run_devnet_provider.sh on the provider host.",
  },
  {
    id: "bootstrap",
    title: "Run the provider bootstrap script",
    detail: "Initialize the provider key (if missing), register your public endpoint on-chain, start the provider gateway, and run a doctor snapshot.",
    successSignal: "Local /health is reachable and the provider is visible in the LCD provider list.",
  },
  {
    id: "verify",
    title: "Verify in the Provider Console",
    detail: "Use the Provider Console to confirm on-chain registration, endpoints, and /health reachability.",
    successSignal: "Your provider shows up and probes OK in /sp-dashboard.",
  },
];

const cloneScript = `git clone ${repoRootUrl}
cd nil-store`;

const bootstrapScript = `# Happy path: initialize key + register + start + doctor
PROVIDER_KEY=provider1 \\
CHAIN_ID=<chain-id> \\
HUB_LCD=https://lcd.<domain> \\
HUB_NODE=https://rpc.<domain> \\
PROVIDER_ENDPOINT=/dns4/sp.<domain>/tcp/443/https \\
NIL_GATEWAY_SP_AUTH=<shared-auth-token> \\
./scripts/run_devnet_provider.sh bootstrap

# Optional: print current config as JSON
PROVIDER_KEY=provider1 ./scripts/run_devnet_provider.sh print-config`;

const healthCheckScript = `# Provider and chain health checks
scripts/devnet_healthcheck.sh provider --provider http://127.0.0.1:8091 --hub-lcd https://lcd.<domain>
curl -sf https://lcd.<domain>/nilchain/nilchain/v1/providers | jq '.providers | length'
curl -sf https://sp.<domain>/health

# Gateway download path verification
# Dashboard -> Deal -> Download via gateway
# Expect gateway path + successful receipt pipeline`;

const agentBrief = `You are setting up this machine as a NilStore testnet Storage Provider.

Repo bootstrap (required unless already inside a fresh nil-store checkout):
1. If repo is missing:
   - git clone https://github.com/Nil-Store/nil-store.git
   - cd nil-store
2. Refresh checkout:
   - git fetch origin --prune
   - git checkout main
   - git pull --ff-only origin main

Context:
- Preferred mode: home server behind NAT with Cloudflare Tunnel.
- Use docs/ALPHA_PROVIDER_QUICKSTART.md, docs/REMOTE_SP_JOIN_QUICKSTART.md, and docs/networking/PROVIDER_ENDPOINTS.md.
- Use hub-supplied values for CHAIN_ID, HUB_NODE, HUB_LCD, NIL_GATEWAY_SP_AUTH, and provider hostname.
- Never print secrets/private keys in full; redact sensitive values (especially NIL_GATEWAY_SP_AUTH).

Your job:
1. Verify toolchains and repo prerequisites.
2. Create or import provider key.
3. Configure the public endpoint and local listener.
4. Register the provider on-chain.
5. Start provider service.
6. Verify:
   - ./scripts/run_devnet_provider.sh doctor
   - local http://127.0.0.1:8091/health
   - public https://sp.<domain>/health
   - LCD provider visibility
7. If anything fails, inspect logs, repair, and retry until healthy.

Final output:
1. JSON summary with:
   - provider_address
   - registered_endpoint
   - local_health_url
   - public_health_url
   - local_health_ok
   - public_health_ok
   - lcd_visible
   - service_status
   - commands_run
   - files_changed
2. A short human-readable summary.`;

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
  const [checkedSteps, setCheckedSteps] = useState<Record<string, boolean>>({});
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  const steps = providerHappyPathSteps;
  const checkedCount = useMemo(() => steps.filter((step) => checkedSteps[step.id]).length, [steps, checkedSteps]);
  const completionPercent = steps.length === 0 ? 0 : Math.round((checkedCount / steps.length) * 100);

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
      <section className="glass-panel industrial-border p-8">
        <div className="relative space-y-4">
          <h1 className="text-4xl font-bold tracking-tight text-foreground">Become A Storage Provider</h1>
          <p className="max-w-3xl text-muted-foreground">
            The recommended testnet setup is a dedicated provider host with a stable public endpoint. Most operators use a home server behind Cloudflare Tunnel or a small VPS with direct HTTPS.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <PrimaryCtaAnchor href="#setup" size="md" leftIcon={<Rocket className="h-4 w-4" />}>
              Start Setup
            </PrimaryCtaAnchor>
            <PrimaryLinkButton href={repoRootUrl}>
              <Terminal className="h-4 w-4" />
              Open Repo
            </PrimaryLinkButton>
            <Link
              to="/alpha/provider"
              className="inline-flex items-center gap-2 rounded-none border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              <Rocket className="h-4 w-4" />
              Testnet Provider Path
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

      <section id="setup" className="mt-8 grid gap-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="glass-panel industrial-border p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-foreground">Guided onboarding flow</h2>
            <div className="text-sm font-medium text-muted-foreground">{checkedCount}/{steps.length} complete ({completionPercent}%)</div>
          </div>

          <div className="mt-3 glass-panel industrial-border p-3 text-xs text-muted-foreground">
            <div className="font-semibold text-foreground">Scope</div>
            <div className="mt-1">
              This page targets <span className="font-mono text-foreground">remote/headless testnet provider onboarding</span>. Cloudflare Tunnel and a public VPS are configuration details of the same flow.
            </div>
          </div>

          <div className="mt-5 space-y-3">
            {steps.map((step, index) => {
              const checked = Boolean(checkedSteps[step.id]);
              return (
                <div
                  key={step.id}
                  className={`glass-panel industrial-border p-4 transition-colors ${checked ? "border-accent/40 bg-accent/5" : ""}`}
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

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <div className="glass-panel industrial-border p-4 text-sm text-muted-foreground">
              <div className="font-semibold text-foreground">Endpoint examples</div>
              <div className="mt-2 space-y-2">
                <details className="border border-border bg-card px-3 py-2">
                  <summary className="cursor-pointer font-semibold text-foreground">Home server + Cloudflare Tunnel</summary>
                  <div className="mt-2 font-mono-data text-xs text-muted-foreground">
                    PROVIDER_ENDPOINT=/dns4/sp.&lt;domain&gt;/tcp/443/https
                  </div>
                </details>
                <details className="border border-border bg-card px-3 py-2">
                  <summary className="cursor-pointer font-semibold text-foreground">Public VPS (direct HTTPS)</summary>
                  <div className="mt-2 font-mono-data text-xs text-muted-foreground">
                    PROVIDER_ENDPOINT=/ip4/&lt;public-ip&gt;/tcp/443/https
                  </div>
                </details>
              </div>
            </div>
            <div className="glass-panel industrial-border p-4 text-sm text-muted-foreground">
              <div className="font-semibold text-foreground">Where to verify</div>
              <div className="mt-2">
                After bootstrap, open the Provider Console to confirm registration and probe your endpoint.
              </div>
              <div className="mt-3">
                <Link
                  to="/sp-dashboard"
                  className="inline-flex items-center gap-2 rounded-none border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open Provider Console
                </Link>
              </div>
            </div>
          </div>
        </div>

        <div className="glass-panel industrial-border p-6">
          <h2 className="text-xl font-semibold text-foreground">Download + assets</h2>
          <div className="mt-4 space-y-3 text-sm">
            <a
              href={gatewayDesktopReleaseUrl}
              target="_blank"
              rel="noreferrer"
              className="block glass-panel industrial-border p-4 hover:border-primary/50"
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
              className="block glass-panel industrial-border p-4 hover:border-primary/50"
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
              className="block glass-panel industrial-border p-4 hover:border-primary/50"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="font-semibold text-foreground">Multi-provider playbook</div>
                <ExternalLink className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-1 text-muted-foreground">Canonical operator playbook and environment details.</p>
            </a>
          </div>

          <div className="mt-6 rounded-none border border-primary/30 bg-primary/10 p-4 text-sm text-primary">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4" />
              <div>
                Recommended launch posture: <span className="font-mono">home server + Cloudflare Tunnel</span>. A public VPS with direct HTTPS works too if you have a stable endpoint.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-6 lg:grid-cols-2">
        <div className="glass-panel industrial-border p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-foreground">Clone + bootstrap</h2>
            <CopyButton onClick={() => void copyText("Clone + bootstrap", `${cloneScript}\n\n${bootstrapScript}`)} />
          </div>
          <pre className="mt-4 overflow-x-auto rounded-none border border-border bg-secondary/20 p-4 text-xs text-muted-foreground">{cloneScript}</pre>
          <pre className="mt-4 overflow-x-auto rounded-none border border-border bg-secondary/20 p-4 text-xs text-muted-foreground">{bootstrapScript}</pre>
        </div>

        <div className="glass-panel industrial-border p-6">
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
              to="/sp-dashboard"
              className="rounded-none border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground hover:bg-secondary/40"
            >
              Open Provider Console
            </Link>
          </div>
        </div>
      </section>

      <section className="mt-8 glass-panel industrial-border p-6">
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

      <section className="mt-8 glass-panel industrial-border p-6">
        <h2 className="text-xl font-semibold text-foreground">Operational UX model</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <div className="glass-panel industrial-border p-4">
            <div className="flex items-center gap-2 font-semibold text-foreground"><Shield className="h-4 w-4 text-accent" /> Healthy</div>
            <p className="mt-2 text-sm text-muted-foreground">All critical checks pass: chain connectivity, service availability, endpoint reachability, auth compatibility.</p>
          </div>
          <div className="glass-panel industrial-border p-4">
            <div className="flex items-center gap-2 font-semibold text-foreground"><Server className="h-4 w-4 text-primary" /> Degraded</div>
            <p className="mt-2 text-sm text-muted-foreground">Provider is reachable but drift or partial check failures exist. Review remediation actions before serving production traffic.</p>
          </div>
          <div className="glass-panel industrial-border p-4">
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
