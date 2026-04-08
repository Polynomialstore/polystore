import { useCallback, useMemo, useState } from "react";
import {
  spBalanceCheck,
  spGenerateRemoteBundle,
  spHealthSnapshot,
  spKeyCreate,
  spNetworkDefaults,
  spRegisterProvider,
  spStartProviderLocal,
  spStopProviderLocal,
  spValidateEndpoint,
  type SpBalanceCheckResponse,
  type SpCommandResponse,
  type SpDeploymentMode,
  type SpEndpointMode,
  type SpHealthSnapshot,
  type SpRemoteBundleResponse,
} from "../lib/gateway";

type LaunchpadTab = "onboarding" | "operations";
type StepState = "idle" | "running" | "done" | "error";
type StepId =
  | "defaults"
  | "identity"
  | "funding"
  | "endpoint"
  | "register"
  | "service"
  | "health";

type StepMeta = {
  id: StepId;
  label: string;
};

type StepStatusRecord = Record<StepId, { state: StepState; detail: string }>;

const steps: StepMeta[] = [
  { id: "defaults", label: "Load network defaults" },
  { id: "identity", label: "Create provider identity" },
  { id: "funding", label: "Check gas funding" },
  { id: "endpoint", label: "Validate endpoint" },
  { id: "register", label: "Register on chain" },
  { id: "service", label: "Start service / generate runbook" },
  { id: "health", label: "Confirm healthy operations" },
];

const initialStepStatus: StepStatusRecord = {
  defaults: { state: "idle", detail: "Not started" },
  identity: { state: "idle", detail: "Not started" },
  funding: { state: "idle", detail: "Not started" },
  endpoint: { state: "idle", detail: "Not started" },
  register: { state: "idle", detail: "Not started" },
  service: { state: "idle", detail: "Not started" },
  health: { state: "idle", detail: "Not started" },
};

function stepBadgeClass(state: StepState): string {
  switch (state) {
    case "done":
      return "sp-badge sp-badge-success";
    case "running":
      return "sp-badge sp-badge-pending";
    case "error":
      return "sp-badge sp-badge-error";
    default:
      return "sp-badge sp-badge-idle";
  }
}

function statusBadgeClass(status: SpHealthSnapshot["status"] | "unknown"): string {
  if (status === "healthy") return "sp-badge sp-badge-success";
  if (status === "degraded") return "sp-badge sp-badge-pending";
  if (status === "critical") return "sp-badge sp-badge-error";
  return "sp-badge sp-badge-idle";
}

function statusLabel(status: SpHealthSnapshot["status"] | "unknown"): string {
  if (status === "healthy") return "Healthy";
  if (status === "degraded") return "Degraded";
  if (status === "critical") return "Critical";
  return "Unknown";
}

function stepActionLabel(stepId: StepId, deploymentMode: SpDeploymentMode): string {
  if (stepId === "defaults") return "Load defaults";
  if (stepId === "identity") return "Create key";
  if (stepId === "funding") return "Check funding";
  if (stepId === "endpoint") return "Validate endpoint";
  if (stepId === "register") return "Register on chain";
  if (stepId === "service") return deploymentMode === "local" ? "Start provider" : "Generate runbook";
  return "Run health check";
}

async function copyToClipboard(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.position = "fixed";
  textArea.style.top = "-9999px";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("copy command returned false");
    }
  } finally {
    document.body.removeChild(textArea);
  }
}

function renderCommandResult(result: SpCommandResponse | null): string {
  if (!result) return "";
  return [
    `ok=${result.ok}`,
    `action=${result.action}`,
    `exit_code=${result.exit_code}`,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function SpLaunchpad({ onBack }: { onBack?: () => void }) {
  const [tab, setTab] = useState<LaunchpadTab>("onboarding");
  const [deploymentMode, setDeploymentMode] = useState<SpDeploymentMode>("local");
  const [endpointMode, setEndpointMode] = useState<SpEndpointMode>("direct");

  const [chainId, setChainId] = useState("20260211");
  const [hubLcd, setHubLcd] = useState("http://127.0.0.1:1317");
  const [hubNode, setHubNode] = useState("tcp://127.0.0.1:26657");
  const [providerKey, setProviderKey] = useState("provider1");
  const [providerAddress, setProviderAddress] = useState("");
  const [providerEndpoint, setProviderEndpoint] = useState("/ip4/127.0.0.1/tcp/8091/http");
  const [providerListen, setProviderListen] = useState(":8091");
  const [providerBaseUrl, setProviderBaseUrl] = useState("http://127.0.0.1:8091");
  const [providerCapabilities, setProviderCapabilities] = useState("General");
  const [providerTotalStorage, setProviderTotalStorage] = useState("1099511627776");
  const [sharedAuth, setSharedAuth] = useState("");

  const [stepStatus, setStepStatus] = useState<StepStatusRecord>(initialStepStatus);
  const [statusMessage, setStatusMessage] = useState(
    "Website-first onboarding is recommended. Use these local tools when you need a desktop-managed provider-daemon for demos, testing, or diagnostics.",
  );
  const [busy, setBusy] = useState(false);

  const [balanceCheck, setBalanceCheck] = useState<SpBalanceCheckResponse | null>(null);
  const [endpointValidationText, setEndpointValidationText] = useState("");
  const [registerResult, setRegisterResult] = useState<SpCommandResponse | null>(null);
  const [serviceResult, setServiceResult] = useState<SpCommandResponse | null>(null);
  const [remoteBundle, setRemoteBundle] = useState<SpRemoteBundleResponse | null>(null);
  const [health, setHealth] = useState<SpHealthSnapshot | null>(null);

  const [launchpadLogs, setLaunchpadLogs] = useState<string[]>([]);

  const addLog = useCallback((line: string) => {
    const payload = line.trim();
    if (!payload) return;
    const stamped = `[${new Date().toLocaleTimeString()}] ${payload}`;
    setLaunchpadLogs((prev) => {
      const next = [...prev, stamped];
      return next.slice(-220);
    });
  }, []);

  const setStep = useCallback((id: StepId, state: StepState, detail: string) => {
    setStepStatus((prev) => ({
      ...prev,
      [id]: { state, detail },
    }));
  }, []);

  const onboardingSnapshot = useMemo(() => {
    const completedSteps = Object.values(stepStatus).filter(
      (step) => step.state === "done",
    ).length;
    const nextStep = steps.find((step) => stepStatus[step.id].state !== "done") ?? null;
    const progressPercent = Math.round((completedSteps / steps.length) * 100);
    return { completedSteps, nextStep, progressPercent };
  }, [stepStatus]);

  const onboardingProgress = `${onboardingSnapshot.completedSteps}/${steps.length}`;
  const healthStatus = health?.status ?? "unknown";
  const issueCount = health?.issues.length ?? 0;

  const handleLoadDefaults = useCallback(async () => {
    setBusy(true);
    setStep("defaults", "running", "Loading trusted devnet defaults...");
    try {
      const defaults = await spNetworkDefaults();
      setChainId(defaults.chain_id);
      setHubLcd(defaults.hub_lcd);
      setHubNode(defaults.hub_node);
      setProviderListen(defaults.provider_listen);
      setProviderBaseUrl(defaults.provider_base_url);
      setProviderCapabilities(defaults.provider_capabilities);
      setProviderTotalStorage(defaults.provider_total_storage);
      setEndpointMode(defaults.endpoint_mode_default);
      setStatusMessage("Defaults loaded. Create provider identity next.");
      setStep("defaults", "done", "Trusted devnet profile loaded.");
      addLog("sp.onboarding.defaults: loaded trusted profile");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Failed to load defaults: ${detail}`);
      setStep("defaults", "error", detail);
      addLog(`sp.onboarding.defaults.failed: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [addLog, setStep]);

  const handleCreateIdentity = useCallback(async () => {
    setBusy(true);
    setStep("identity", "running", "Creating provider key...");
    try {
      const info = await spKeyCreate(providerKey);
      if (!info.ok) {
        throw new Error(info.stderr || info.stdout || "provider key init failed");
      }
      setProviderAddress(info.address || providerAddress);
      setStatusMessage("Provider identity ready. Check funding next.");
      setStep(
        "identity",
        "done",
        info.address ? `Address: ${info.address}` : "Provider key ready",
      );
      addLog(`sp.onboarding.identity: key ${providerKey} ready ${info.address || ""}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Provider identity step failed: ${detail}`);
      setStep("identity", "error", detail);
      addLog(`sp.onboarding.identity.failed: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [addLog, providerAddress, providerKey, setStep]);

  const handleCheckFunding = useCallback(async () => {
    if (!providerAddress) {
      setStep("funding", "error", "Provider address is required before funding check.");
      setStatusMessage("Create identity first so the provider address is known.");
      return;
    }

    setBusy(true);
    setStep("funding", "running", "Checking provider gas balance...");
    try {
      const response = await spBalanceCheck({
        hub_lcd: hubLcd,
        address: providerAddress,
        denom: "aatom",
        min_recommended: "1000000",
      });
      setBalanceCheck(response);
      if (!response.sufficient) {
        setStep("funding", "error", `Insufficient gas: ${response.amount} ${response.denom}`);
        setStatusMessage(
          `Insufficient gas for registration. Fund ${providerAddress} via faucet, then retry funding check.`,
        );
        addLog("sp.onboarding.funding.failed: insufficient gas");
      } else {
        setStep("funding", "done", `Balance OK: ${response.amount} ${response.denom}`);
        setStatusMessage("Funding check passed. Validate endpoint next.");
        addLog("sp.onboarding.funding: balance sufficient");
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setStep("funding", "error", detail);
      setStatusMessage(`Funding check failed: ${detail}`);
      addLog(`sp.onboarding.funding.failed: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [addLog, hubLcd, providerAddress, setStep]);

  const handleValidateEndpoint = useCallback(async () => {
    setBusy(true);
    setStep("endpoint", "running", "Validating provider endpoint...");
    try {
      const response = await spValidateEndpoint({
        endpoint: providerEndpoint,
        mode: endpointMode,
        provider_base_url: providerBaseUrl,
      });
      const lines = response.checks.map(
        (check) => `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`,
      );
      setEndpointValidationText(lines.join("\n"));
      if (!response.valid) {
        setStep("endpoint", "error", "Endpoint checks failed.");
        setStatusMessage("Endpoint validation failed. Fix endpoint config and retry.");
        addLog("sp.onboarding.endpoint.failed");
      } else {
        setStep("endpoint", "done", response.normalized_endpoint);
        setStatusMessage("Endpoint valid. Register provider on-chain.");
        addLog(`sp.onboarding.endpoint: valid ${response.normalized_endpoint}`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setStep("endpoint", "error", detail);
      setStatusMessage(`Endpoint validation failed: ${detail}`);
      addLog(`sp.onboarding.endpoint.failed: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [addLog, endpointMode, providerBaseUrl, providerEndpoint, setStep]);

  const handleRegister = useCallback(async () => {
    setBusy(true);
    setStep("register", "running", "Submitting register-provider tx...");
    try {
      const response = await spRegisterProvider({
        provider_key: providerKey,
        chain_id: chainId,
        hub_lcd: hubLcd,
        hub_node: hubNode,
        provider_endpoint: providerEndpoint,
        provider_capabilities: providerCapabilities,
        provider_total_storage: providerTotalStorage,
      });
      setRegisterResult(response);
      if (!response.ok) {
        throw new Error(response.stderr || response.stdout || "register-provider failed");
      }
      setStep("register", "done", "Provider registration accepted");
      setStatusMessage("Registration submitted. Start service (or generate remote runbook).");
      addLog("sp.onboarding.register: provider registered");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setStep("register", "error", detail);
      setStatusMessage(`Register step failed: ${detail}`);
      addLog(`sp.onboarding.register.failed: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [
    addLog,
    chainId,
    hubLcd,
    hubNode,
    providerCapabilities,
    providerEndpoint,
    providerKey,
    providerTotalStorage,
    setStep,
  ]);

  const handleServiceStep = useCallback(async () => {
    setBusy(true);
    setStep(
      "service",
      "running",
      deploymentMode === "local"
        ? "Starting local provider..."
        : "Generating remote runbook...",
    );
    try {
      if (deploymentMode === "local") {
        const response = await spStartProviderLocal({
          provider_key: providerKey,
          chain_id: chainId,
          hub_lcd: hubLcd,
          hub_node: hubNode,
          provider_listen: providerListen,
          shared_auth: sharedAuth,
        });
        setServiceResult(response);
        if (!response.ok) {
          throw new Error(response.stderr || response.stdout || "provider start failed");
        }
        setStep("service", "done", "Local provider-daemon started.");
        setStatusMessage("Provider started. Run health confirmation next.");
        addLog("sp.onboarding.service: local provider started");
      } else {
        const bundle = await spGenerateRemoteBundle({
          provider_key: providerKey,
          chain_id: chainId,
          hub_lcd: hubLcd,
          hub_node: hubNode,
          provider_endpoint: providerEndpoint,
          provider_listen: providerListen,
          shared_auth: sharedAuth,
        });
        setRemoteBundle(bundle);
        setServiceResult(null);
        setStep("service", "done", "Remote runbook generated.");
        setStatusMessage("Run remote runbook on server, then run health confirmation.");
        addLog("sp.onboarding.service: remote runbook generated");
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setStep("service", "error", detail);
      setStatusMessage(`Service step failed: ${detail}`);
      addLog(`sp.onboarding.service.failed: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [
    addLog,
    chainId,
    deploymentMode,
    hubLcd,
    hubNode,
    providerEndpoint,
    providerKey,
    providerListen,
    setStep,
    sharedAuth,
  ]);

  const handleHealthCheck = useCallback(async () => {
    setBusy(true);
    setStep("health", "running", "Collecting SP health snapshot...");
    try {
      const snapshot = await spHealthSnapshot({
        chain_id: chainId,
        hub_lcd: hubLcd,
        provider_base_url: providerBaseUrl,
        provider_addr: providerAddress || undefined,
        provider_key: providerKey,
        shared_auth_present: sharedAuth.trim().length > 0,
      });
      setHealth(snapshot);
      if (snapshot.status === "healthy") {
        setStep("health", "done", "Provider is healthy.");
        setStatusMessage("First Healthy achieved. You can now operate from the SP dashboard.");
        addLog("sp.health.snapshot: healthy");
      } else {
        setStep("health", "error", `Status=${snapshot.status}`);
        setStatusMessage(
          `SP health is ${snapshot.status}. Use issues and remediation in Operations to fix blockers.`,
        );
        addLog(`sp.health.snapshot: ${snapshot.status}`);
      }
      setTab("operations");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setStep("health", "error", detail);
      setStatusMessage(`Health check failed: ${detail}`);
      addLog(`sp.health.snapshot.failed: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [
    addLog,
    chainId,
    hubLcd,
    providerAddress,
    providerBaseUrl,
    providerKey,
    setStep,
    sharedAuth,
  ]);

  const handleStopProvider = useCallback(async () => {
    if (deploymentMode !== "local") {
      setStatusMessage("Stop action is local-mode only.");
      return;
    }

    setBusy(true);
    try {
      const response = await spStopProviderLocal({ provider_key: providerKey });
      setServiceResult(response);
      setStatusMessage(response.ok ? "Provider stopped." : "Provider stop reported an error.");
      addLog(
        response.ok
          ? "sp.operations.stop: provider stopped"
          : "sp.operations.stop: provider stop failed",
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setStatusMessage(`Stop provider failed: ${detail}`);
      addLog(`sp.operations.stop.failed: ${detail}`);
    } finally {
      setBusy(false);
    }
  }, [addLog, deploymentMode, providerKey]);

  const handleCopyDiagnostics = useCallback(async () => {
    const payload = {
      generated_at: new Date().toISOString(),
      deployment_mode: deploymentMode,
      network: {
        chain_id: chainId,
        hub_lcd: hubLcd,
        hub_node: hubNode,
      },
      provider: {
        key: providerKey,
        address: providerAddress,
        endpoint: providerEndpoint,
        provider_base_url: providerBaseUrl,
        listen: providerListen,
        endpoint_mode: endpointMode,
      },
      onboarding_steps: stepStatus,
      balance: balanceCheck,
      health,
      register_result: registerResult,
      service_result: serviceResult,
      recent_logs: launchpadLogs.slice(-80),
    };

    await copyToClipboard(JSON.stringify(payload, null, 2));
    setStatusMessage("Diagnostics copied to clipboard.");
    addLog("sp.operations.diagnostics: copied");
  }, [
    addLog,
    balanceCheck,
    chainId,
    deploymentMode,
    endpointMode,
    health,
    hubLcd,
    hubNode,
    launchpadLogs,
    providerAddress,
    providerBaseUrl,
    providerEndpoint,
    providerKey,
    providerListen,
    registerResult,
    serviceResult,
    stepStatus,
  ]);

  const runStepById = useCallback(
    async (stepId: StepId) => {
      if (stepId === "defaults") return handleLoadDefaults();
      if (stepId === "identity") return handleCreateIdentity();
      if (stepId === "funding") return handleCheckFunding();
      if (stepId === "endpoint") return handleValidateEndpoint();
      if (stepId === "register") return handleRegister();
      if (stepId === "service") return handleServiceStep();
      return handleHealthCheck();
    },
    [
      handleCheckFunding,
      handleCreateIdentity,
      handleHealthCheck,
      handleLoadDefaults,
      handleRegister,
      handleServiceStep,
      handleValidateEndpoint,
    ],
  );

  const handleRunNextStep = useCallback(async () => {
    if (busy || !onboardingSnapshot.nextStep) return;
    await runStepById(onboardingSnapshot.nextStep.id);
  }, [busy, onboardingSnapshot.nextStep, runStepById]);

  return (
    <div className="glass-panel industrial-border p-5">
      <div className="sp-topbar">
        <div>
          <p className="soft-label">Advanced Local Ops</p>
          <h2 className="text-2xl font-semibold text-foreground">Provider Tools</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Advanced local onboarding and diagnostics for PolyStore provider-daemons. The primary operator path lives on the website.
          </p>
        </div>
        <div className="sp-topbar-actions">
          {onBack ? (
            <button
              type="button"
              className="control-btn control-btn-inline"
              onClick={onBack}
            >
              Back to user-gateway
            </button>
          ) : null}
          <span className={statusBadgeClass(healthStatus)}>
            Status: {statusLabel(healthStatus)}
          </span>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={["panel-tab", tab === "onboarding" ? "panel-tab-active" : ""].join(" ")}
          onClick={() => setTab("onboarding")}
        >
          Local setup
        </button>
        <button
          type="button"
          className={["panel-tab", tab === "operations" ? "panel-tab-active" : ""].join(" ")}
          onClick={() => setTab("operations")}
        >
          Operations
        </button>
        <span className="meta-chip">
          <strong>Progress</strong> {onboardingProgress}
        </span>
        <span className="meta-chip">
          <strong>Mode</strong> {deploymentMode === "local" ? "Local" : "Remote"}
        </span>
      </div>

      <div className="mt-4 rounded-none border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        {statusMessage}
      </div>

      {tab === "onboarding" ? (
        <div className="mt-4 space-y-4">
          <div className="sp-overview-grid">
            <div className="metric-card p-4">
              <p className="soft-label">Guided onboarding</p>
              <h3 className="mt-2 text-lg font-semibold text-foreground">
                {onboardingSnapshot.nextStep
                  ? `Next step: ${onboardingSnapshot.nextStep.label}`
                  : "Setup complete"}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {onboardingSnapshot.nextStep
                  ? "Run the next step, review result, then continue."
                  : "All onboarding steps are complete. Use Operations for ongoing management."}
              </p>
              <div className="sp-progress-track mt-3 bg-muted/40">
                <div
                  className="sp-progress-fill bg-primary"
                  style={{ width: `${onboardingSnapshot.progressPercent}%` }}
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground/60">
                {onboardingSnapshot.progressPercent}% complete ({onboardingProgress})
              </p>
              <div className="sp-actions mt-3">
                <button
                  type="button"
                  className="control-btn control-btn-inline control-btn-primary"
                  onClick={() => void handleRunNextStep()}
                  disabled={busy || !onboardingSnapshot.nextStep}
                >
                  {busy
                    ? "Running..."
                    : onboardingSnapshot.nextStep
                      ? "Run next step"
                      : "All steps complete"}
                </button>
                <button
                  type="button"
                  className="control-btn control-btn-inline"
                  onClick={() => void handleHealthCheck()}
                  disabled={busy}
                >
                  Quick health check
                </button>
              </div>
            </div>

            <div className="metric-card p-4">
              <p className="soft-label">Current configuration</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="sp-summary-cell border-border/40">
                  <span className="text-muted-foreground">Deployment</span>
                  <strong className="text-foreground">{deploymentMode === "local" ? "Local provider-daemon" : "Remote provider-daemon"}</strong>
                </div>
                <div className="sp-summary-cell border-border/40">
                  <span className="text-muted-foreground">Endpoint mode</span>
                  <strong className="text-foreground">
                    {endpointMode === "direct" ? "Direct" : "Cloudflare tunnel"}
                  </strong>
                </div>
                <div className="sp-summary-cell border-border/40">
                  <span className="text-muted-foreground">Chain ID</span>
                  <strong className="text-foreground">{chainId}</strong>
                </div>
                <div className="sp-summary-cell border-border/40">
                  <span className="text-muted-foreground">Provider route</span>
                  <strong className="text-foreground">{providerBaseUrl}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="metric-card p-4">
            <p className="soft-label">Step-by-step checklist</p>
            <ol className="sp-step-list mt-3">
              {steps.map((step, index) => {
                const status = stepStatus[step.id];
                const isNext = onboardingSnapshot.nextStep?.id === step.id;
                const actionLabel =
                  status.state === "done"
                    ? "Run again"
                    : stepActionLabel(step.id, deploymentMode);

                return (
                  <li
                    key={step.id}
                    className={["sp-step-card border-border/40", isNext ? "sp-step-card-next border-primary/40 bg-primary/5" : ""].join(" ")}
                  >
                    <div className="sp-step-main">
                      <span className="sp-step-index bg-muted text-muted-foreground">{index + 1}</span>
                      <div>
                        <p className="text-sm font-semibold text-foreground">{step.label}</p>
                        <p className="text-xs text-muted-foreground">{status.detail}</p>
                      </div>
                    </div>
                    <div className="sp-step-tail">
                      <span className={stepBadgeClass(status.state)}>{status.state}</span>
                      <button
                        type="button"
                        className="control-btn control-btn-inline"
                        onClick={() => void runStepById(step.id)}
                        disabled={busy}
                      >
                        {busy && status.state === "running" ? "Running..." : actionLabel}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          <details className="sp-collapsible group">
            <summary className="bg-muted/20 hover:bg-muted/40 text-foreground font-semibold">Network + identity settings</summary>
            <div className="sp-collapsible-body border-border/40">
              <div className="mb-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={[
                    "control-btn control-btn-inline",
                    deploymentMode === "local" ? "control-btn-primary" : "",
                  ].join(" ")}
                  onClick={() => setDeploymentMode("local")}
                  disabled={busy}
                >
                  Local provider-daemon
                </button>
                <button
                  type="button"
                  className={[
                    "control-btn control-btn-inline",
                    deploymentMode === "remote" ? "control-btn-primary" : "",
                  ].join(" ")}
                  onClick={() => setDeploymentMode("remote")}
                  disabled={busy}
                >
                  Remote provider-daemon
                </button>
                <button
                  type="button"
                  className={[
                    "control-btn control-btn-inline",
                    endpointMode === "direct" ? "control-btn-primary" : "",
                  ].join(" ")}
                  onClick={() => setEndpointMode("direct")}
                  disabled={busy}
                >
                  Direct endpoint
                </button>
                <button
                  type="button"
                  className={[
                    "control-btn control-btn-inline",
                    endpointMode === "cloudflare_tunnel" ? "control-btn-primary" : "",
                  ].join(" ")}
                  onClick={() => setEndpointMode("cloudflare_tunnel")}
                  disabled={busy}
                >
                  Cloudflare tunnel
                </button>
              </div>
              <div className="sp-form-grid">
                <label className="sp-field text-muted-foreground">
                  Chain ID
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={chainId}
                    onChange={(event) => setChainId(event.target.value)}
                  />
                </label>
                <label className="sp-field text-muted-foreground">
                  Hub LCD
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={hubLcd}
                    onChange={(event) => setHubLcd(event.target.value)}
                  />
                </label>
                <label className="sp-field text-muted-foreground">
                  Hub RPC
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={hubNode}
                    onChange={(event) => setHubNode(event.target.value)}
                  />
                </label>
                <div className="sp-field text-muted-foreground">
                  Action
                  <button
                    type="button"
                    className="control-btn control-btn-inline"
                    onClick={() => void handleLoadDefaults()}
                    disabled={busy}
                  >
                    {busy && stepStatus.defaults.state === "running"
                      ? "Loading..."
                      : "Load defaults"}
                  </button>
                </div>
                <label className="sp-field text-muted-foreground">
                  Provider key alias
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={providerKey}
                    onChange={(event) => setProviderKey(event.target.value)}
                  />
                </label>
                <label className="sp-field text-muted-foreground">
                  Provider address
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={providerAddress}
                    onChange={(event) => setProviderAddress(event.target.value)}
                    placeholder="nil1..."
                  />
                </label>
                <label className="sp-field text-muted-foreground">
                  Provider endpoint (multiaddr)
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={providerEndpoint}
                    onChange={(event) => setProviderEndpoint(event.target.value)}
                  />
                </label>
                <label className="sp-field text-muted-foreground">
                  Provider base URL
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={providerBaseUrl}
                    onChange={(event) => setProviderBaseUrl(event.target.value)}
                  />
                </label>
                <label className="sp-field text-muted-foreground">
                  Listen address
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={providerListen}
                    onChange={(event) => setProviderListen(event.target.value)}
                  />
                </label>
                <label className="sp-field text-muted-foreground">
                  Shared auth token
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={sharedAuth}
                    onChange={(event) => setSharedAuth(event.target.value)}
                    placeholder="NIL_GATEWAY_SP_AUTH"
                  />
                </label>
              </div>
            </div>
          </details>

          <details className="sp-collapsible group">
            <summary className="bg-muted/20 hover:bg-muted/40 text-foreground font-semibold">Registration settings + step outputs</summary>
            <div className="sp-collapsible-body border-border/40">
              <div className="sp-form-grid">
                <label className="sp-field text-muted-foreground">
                  Capabilities
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={providerCapabilities}
                    onChange={(event) => setProviderCapabilities(event.target.value)}
                  />
                </label>
                <label className="sp-field text-muted-foreground">
                  Total storage (bytes)
                  <input
                    className="sp-input rounded-none border-border bg-background"
                    value={providerTotalStorage}
                    onChange={(event) => setProviderTotalStorage(event.target.value)}
                  />
                </label>
              </div>
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <div className="metric-card p-3">
                  <p className="soft-label">Funding result</p>
                  {balanceCheck ? (
                    <p className="mt-2 text-xs text-foreground font-mono-data">
                      {balanceCheck.amount} {balanceCheck.denom} · minimum{" "}
                      {balanceCheck.min_recommended} ·{" "}
                      {balanceCheck.sufficient ? "sufficient" : "insufficient"}
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Run Check funding to populate this step.
                    </p>
                  )}
                </div>

                <div className="metric-card p-3">
                  <p className="soft-label">Endpoint checks</p>
                  {endpointValidationText ? (
                    <pre className="sp-pre mt-2 bg-background border-border/40 text-muted-foreground">{endpointValidationText}</pre>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Run Validate endpoint to populate this step.
                    </p>
                  )}
                </div>
              </div>
            </div>
          </details>
        </div>
      ) : null}

      {tab === "operations" ? (
        <div className="mt-4 space-y-4">
          <div className="sp-overview-grid">
            <div className="metric-card p-4">
              <p className="soft-label">Operations summary</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="sp-summary-cell border-border/40">
                  <span className="text-muted-foreground">Health</span>
                  <strong className="text-foreground">{statusLabel(healthStatus)}</strong>
                </div>
                <div className="sp-summary-cell border-border/40">
                  <span className="text-muted-foreground">Issues</span>
                  <strong className="text-foreground">{issueCount}</strong>
                </div>
                <div className="sp-summary-cell border-border/40">
                  <span className="text-muted-foreground">Provider</span>
                  <strong className="text-foreground">{providerAddress || "unknown"}</strong>
                </div>
                <div className="sp-summary-cell border-border/40">
                  <span className="text-muted-foreground">Route</span>
                  <strong className="text-foreground">{providerBaseUrl}</strong>
                </div>
              </div>
              <div className="sp-actions mt-3">
                <button
                  type="button"
                  className="control-btn control-btn-inline"
                  onClick={() => void handleHealthCheck()}
                  disabled={busy}
                >
                  Re-check health
                </button>
                <button
                  type="button"
                  className="control-btn control-btn-inline"
                  onClick={() => void handleRegister()}
                  disabled={busy}
                >
                  Re-register provider
                </button>
                <button
                  type="button"
                  className="control-btn control-btn-inline"
                  onClick={() => void handleServiceStep()}
                  disabled={busy}
                >
                  {deploymentMode === "local" ? "Restart provider" : "Refresh runbook"}
                </button>
                <button
                  type="button"
                  className="control-btn control-btn-inline"
                  onClick={() => void handleStopProvider()}
                  disabled={busy || deploymentMode !== "local"}
                >
                  Stop provider
                </button>
                <button
                  type="button"
                  className="control-btn control-btn-inline"
                  onClick={() => void handleCopyDiagnostics()}
                >
                  Copy diagnostics
                </button>
              </div>
            </div>

            <div className="metric-card p-4">
              <p className="soft-label">Recent activity</p>
              {launchpadLogs.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No SP actions yet.</p>
              ) : (
                <div className="sp-log-lite mt-2">
                  {launchpadLogs
                    .slice()
                    .reverse()
                    .slice(0, 12)
                    .map((line, index) => (
                      <p key={`${index}-${line}`} className="text-xs text-muted-foreground">
                        {line}
                      </p>
                    ))}
                </div>
              )}
            </div>
          </div>

          <div className="sp-grid-operations">
            <div className="metric-card p-3">
              <p className="soft-label">Issues and remediation</p>
              {!health || health.issues.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">No current issues detected.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {health.issues.map((issue) => (
                    <li
                      key={`${issue.code}-${issue.message}`}
                      className="sp-issue-row border-border/40"
                    >
                      <div>
                        <p className="text-sm font-semibold text-foreground">{issue.code}</p>
                        <p className="text-xs text-muted-foreground">{issue.message}</p>
                        <p className="text-xs text-muted-foreground/60">
                          Fix: {issue.recommended_action}
                        </p>
                      </div>
                      <span
                        className={statusBadgeClass(
                          issue.severity === "critical" ? "critical" : "degraded",
                        )}
                      >
                        {issue.severity}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="metric-card p-3">
              <p className="soft-label">Health checks</p>
              {!health ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Run health check to populate checks.
                </p>
              ) : (
                <div className="mt-2 space-y-1.5">
                  {health.checks.map((check) => (
                    <div key={`${check.name}-${check.detail}`} className="sp-check-row border-border/20">
                      <span className={check.ok ? "text-accent" : "text-destructive"}>
                        {check.ok ? "OK" : "FAIL"}
                      </span>
                      <span className="font-semibold text-foreground">{check.name}</span>
                      <span className="text-muted-foreground">{check.detail}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {remoteBundle ? (
            <details className="sp-collapsible group" open>
              <summary className="bg-muted/20 hover:bg-muted/40 text-foreground font-semibold">Remote runbook</summary>
              <div className="sp-collapsible-body border-border/40">
                <p className="mb-2 text-xs text-muted-foreground">
                  Use this on the remote provider host. It includes environment bootstrap,
                  registration/start commands, and health checks.
                </p>
                <div className="space-y-2">
                  <label className="sp-field text-muted-foreground">
                    Environment
                    <textarea className="sp-textarea rounded-none border-border bg-background font-mono-data" value={remoteBundle.env_block} readOnly />
                  </label>
                  <label className="sp-field text-muted-foreground">
                    Start command
                    <textarea
                      className="sp-textarea rounded-none border-border bg-background font-mono-data"
                      value={remoteBundle.start_command}
                      readOnly
                    />
                  </label>
                  <label className="sp-field text-muted-foreground">
                    Healthcheck command
                    <textarea
                      className="sp-textarea rounded-none border-border bg-background font-mono-data"
                      value={remoteBundle.healthcheck_command}
                      readOnly
                    />
                  </label>
                </div>
              </div>
            </details>
          ) : null}

          <details className="sp-collapsible group">
            <summary className="bg-muted/20 hover:bg-muted/40 text-foreground font-semibold">Raw command output</summary>
            <div className="sp-collapsible-body border-border/40">
              <div className="grid gap-2 lg:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold text-foreground">Register result</p>
                  <pre className="sp-pre mt-1 bg-background border-border/40 text-muted-foreground">
                    {renderCommandResult(registerResult) || "No register action yet."}
                  </pre>
                </div>
                <div>
                  <p className="text-xs font-semibold text-foreground">Service result</p>
                  <pre className="sp-pre mt-1 bg-background border-border/40 text-muted-foreground">
                    {renderCommandResult(serviceResult) || "No service action yet."}
                  </pre>
                </div>
              </div>
            </div>
          </details>

          <div className="metric-card p-3">
            <p className="soft-label">Full SP activity log</p>
            {launchpadLogs.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No SP actions yet.</p>
            ) : (
              <div className="sp-log-panel mt-2 bg-muted/20 border border-border/40 rounded-none p-3 max-h-[400px] overflow-y-auto">
                {launchpadLogs.slice().reverse().map((line, index) => (
                  <p key={`${index}-${line}`} className="text-xs text-primary/80 font-mono-data">
                    {line}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <div className="mt-4 rounded-none border border-border bg-card p-3 text-xs text-muted-foreground">
        Target onboarding window: time-to-first-healthy SP under 10 minutes on trusted devnet.
      </div>
    </div>
  );
}
