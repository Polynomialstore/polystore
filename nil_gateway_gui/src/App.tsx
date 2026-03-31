import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import logoDark from "./assets/logo-dark.png";
import logoLight from "./assets/logo-light.png";
import { DealSlabPanel } from "./components/DealSlabPanel";
import { SpLaunchpad } from "./components/SpLaunchpad";
import {
  fetchFile,
  gatewayAttach,
  gatewayLocalStorage,
  gatewayStart,
  gatewayStatus,
  gatewayStop,
  listFiles,
  uploadFile,
  type GatewayFileEntry,
  type GatewayStorageSummary,
  type GatewayStatusResponse,
  type GatewayUploadResponse,
} from "./lib/gateway";

type GatewayPhase =
  | "booting"
  | "checking"
  | "starting"
  | "online"
  | "offline"
  | "stopping"
  | "error";

type ReadinessState = "ready" | "pending" | "blocked";

const LOG_BUFFER_LIMIT = 400;
const STATUS_POLL_MS = 8_000;
const STORAGE_POLL_MS = 18_000;
const STARTUP_PROBE_ATTEMPTS = 20;
const STARTUP_PROBE_DELAY_MS = 250;
const RECOVERY_FAILURE_THRESHOLD = 2;
const RECOVERY_COOLDOWN_MS = 20_000;
const RECENT_DEAL_LIMIT = 6;
const RECENT_FILE_LIMIT = 8;
const RECENT_ACTIVITY_LIMIT = 5;
const TECHNOLOGY_MDU_PRIMER_URL = "https://nil.store/#/technology?section=mdu-primer";

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

function normalizeListenAddr(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function formatUnixTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return "n/a";
  return new Date(unixSeconds * 1000).toLocaleString();
}

function toFileUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `file://${encodeURI(normalized)}`;
}

function hostFromBaseUrl(value: string): string {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}

function normalizePersonaValue(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function statusHasGatewayRouteFamily(status: GatewayStatusResponse): boolean {
  const families = Array.isArray(status.allowed_route_families)
    ? status.allowed_route_families
    : [];
  if (families.length === 0) return true;
  return families.some((family) =>
    String(family ?? "").toLowerCase().includes("gateway"),
  );
}

function gatewayStatusBoundaryError(
  status: GatewayStatusResponse,
  baseUrl: string,
): string | null {
  const persona = normalizePersonaValue(status.persona);
  if (persona === "provider-daemon" || persona === "provider_daemon") {
    return `Endpoint ${baseUrl} reports provider-daemon persona. Trusted local user-gateway on :8080 is required.`;
  }
  if (!statusHasGatewayRouteFamily(status)) {
    return `Endpoint ${baseUrl} does not expose gateway routes. Trusted local user-gateway on :8080 is required.`;
  }
  return null;
}

function statusBadgeClass(phase: GatewayPhase): string {
  if (phase === "online") return "border-accent/40 bg-accent/5 text-accent";
  if (phase === "starting" || phase === "checking" || phase === "booting") {
    return "border-primary/40 bg-primary/5 text-primary";
  }
  if (phase === "error") return "border-destructive/40 bg-destructive/10 text-destructive";
  return "border-border bg-muted/10 text-muted-foreground";
}

function statusLabel(phase: GatewayPhase): string {
  switch (phase) {
    case "booting":
      return "[STATUS: BOOT]";
    case "checking":
      return "[STATUS: PROBE]";
    case "starting":
      return "[STATUS: START]";
    case "online":
      return "[STATUS: READY]";
    case "stopping":
      return "[STATUS: STOP]";
    case "error":
      return "[STATUS: FAULT]";
    default:
      return "[STATUS: OFFLINE]";
  }
}

function readinessBadgeClass(state: ReadinessState): string {
  if (state === "ready") return "border-accent/40 text-accent";
  if (state === "pending") return "border-primary/40 text-primary";
  return "border-destructive/40 text-destructive";
}

function readinessLabel(state: ReadinessState): string {
  if (state === "ready") return "Ready";
  if (state === "pending") return "In progress";
  return "Needs attention";
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

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (localStorage.getItem('theme') as 'light' | 'dark') || 'dark');

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    localStorage.setItem('theme', theme);
  }, [theme]);

  const [gatewayBaseUrl, setGatewayBaseUrl] = useState("http://127.0.0.1:8080");
  const [gateway, setGateway] = useState<GatewayStatusResponse | null>(null);
  const [gatewayManaged, setGatewayManaged] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<GatewayPhase>("booting");
  const [phaseMessage, setPhaseMessage] = useState("Starting local Gateway...");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [lastStatusAt, setLastStatusAt] = useState<number | null>(null);
  const [diagCopyBusy, setDiagCopyBusy] = useState(false);
  const [diagCopyMessage, setDiagCopyMessage] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoStartEnabled, setAutoStartEnabled] = useState(true);

  const [uploadDealId, setUploadDealId] = useState("");
  const [uploadOwner, setUploadOwner] = useState("");
  const [uploadFilePath, setUploadFilePath] = useState("hello.txt");
  const [localFilePath, setLocalFilePath] = useState<string | null>(null);
  const [uploadResponse, setUploadResponse] =
    useState<GatewayUploadResponse | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [listManifestRoot, setListManifestRoot] = useState("");
  const [listDealId, setListDealId] = useState("");
  const [listOwner, setListOwner] = useState("");
  const [files, setFiles] = useState<GatewayFileEntry[]>([]);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [storageSummary, setStorageSummary] = useState<GatewayStorageSummary | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storageLastAt, setStorageLastAt] = useState<number | null>(null);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageDealFilter, setStorageDealFilter] = useState<string>("all");
  const [storageFileQuery, setStorageFileQuery] = useState("");
  const [activePanel, setActivePanel] = useState<"overview" | "storage" | "diagnostics">("overview");
  const [workspace, setWorkspace] = useState<"gateway" | "sp">("gateway");

  const baseHost = useMemo(() => hostFromBaseUrl(gatewayBaseUrl), [gatewayBaseUrl]);
  const baseIsLoopback = useMemo(() => isLoopbackHost(baseHost), [baseHost]);
  const recoveryInFlightRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);
  const lastRecoveryAttemptRef = useRef(0);
  const externalGatewayNoticeRef = useRef(false);

  const addLog = useCallback((line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const stamped = `[${new Date().toLocaleTimeString()}] ${trimmed}`;
    setLogs((prev) => {
      const next = [...prev, stamped];
      if (next.length <= LOG_BUFFER_LIMIT) return next;
      return next.slice(next.length - LOG_BUFFER_LIMIT);
    });
  }, []);

  const refreshLocalStorage = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent ?? false;
      if (!silent) {
        setStorageBusy(true);
      }
      try {
        const summary = await gatewayLocalStorage();
        setStorageSummary(summary);
        setStorageError(null);
        setStorageLastAt(Date.now());
      } catch (err) {
        setStorageError(errorMessage(err, "Could not read local storage state."));
      } finally {
        if (!silent) {
          setStorageBusy(false);
        }
      }
    },
    [],
  );

  const applyOnlineStatus = useCallback((status: GatewayStatusResponse) => {
    setGateway(status);
    const managed = status.managed ?? null;
    setGatewayManaged(managed);
    setPhase("online");
    setPhaseMessage(`Listening on ${status.listening_addr}`);
    setStatusDetail(null);
    setLastStatusAt(Date.now());
    consecutiveFailuresRef.current = 0;

    if (managed === false && isLoopbackHost(hostFromBaseUrl(gatewayBaseUrl))) {
      if (!externalGatewayNoticeRef.current) {
        externalGatewayNoticeRef.current = true;
        addLog(
          "Connected to an external Gateway endpoint. This GUI cannot stream detailed upload lifecycle logs from it.",
        );
      }
    } else {
      externalGatewayNoticeRef.current = false;
    }
  }, [addLog, gatewayBaseUrl]);

  const probeStatus = useCallback(async () => {
    const status = await gatewayStatus();
    const boundaryError = gatewayStatusBoundaryError(status, gatewayBaseUrl);
    if (boundaryError) {
      throw new Error(boundaryError);
    }
    applyOnlineStatus(status);
    return status;
  }, [applyOnlineStatus, gatewayBaseUrl]);

  const attachAndProbe = useCallback(
    async (baseUrl: string) => {
      await gatewayAttach(baseUrl);
      return probeStatus();
    },
    [probeStatus],
  );

  const probeAfterStart = useCallback(
    async () => {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < STARTUP_PROBE_ATTEMPTS; attempt += 1) {
        try {
          return await probeStatus();
        } catch (err) {
          lastErr = err;
          if (attempt < STARTUP_PROBE_ATTEMPTS - 1) {
            await new Promise((resolve) => window.setTimeout(resolve, STARTUP_PROBE_DELAY_MS));
          }
        }
      }
      throw lastErr ?? new Error("Gateway did not become ready after startup.");
    },
    [probeStatus],
  );

  const startLocalGateway = useCallback(
    async (baseUrl: string) => {
      if (!isLoopbackHost(hostFromBaseUrl(baseUrl))) {
        throw new Error(
          "Gateway auto-start is only supported for localhost endpoints (127.0.0.1 / localhost).",
        );
      }

      await gatewayStart({
        listen_addr: normalizeListenAddr(baseUrl),
      });
      await probeAfterStart();
      addLog("Local Gateway started successfully.");
    },
    [addLog, probeAfterStart],
  );

  const recoverFromStatusFailure = useCallback(
    async (err: unknown, opts?: { forceStart?: boolean }) => {
      const forceStart = opts?.forceStart ?? false;
      const msg = errorMessage(err, "Gateway status unavailable");

      setGateway(null);
      setStatusDetail(msg);
      setLastStatusAt(Date.now());
      setGatewayManaged(null);
      consecutiveFailuresRef.current += 1;

      if (!autoStartEnabled && !forceStart) {
        setPhase("offline");
        setPhaseMessage("Local Gateway is stopped. Press Start gateway to run it.");
        return;
      }

      if (!isLoopbackHost(hostFromBaseUrl(gatewayBaseUrl)) && !forceStart) {
        setPhase("offline");
        setPhaseMessage("Remote Gateway endpoint unreachable. Press Connect to retry.");
        return;
      }

      if (consecutiveFailuresRef.current < RECOVERY_FAILURE_THRESHOLD && !forceStart) {
        setPhase("checking");
        setPhaseMessage("Reconnecting to local Gateway...");
        return;
      }

      if (recoveryInFlightRef.current) return;
      const now = Date.now();
      if (!forceStart && now - lastRecoveryAttemptRef.current < RECOVERY_COOLDOWN_MS) {
        setPhase("checking");
        setPhaseMessage("Retrying local Gateway in the background...");
        return;
      }

      recoveryInFlightRef.current = true;
      lastRecoveryAttemptRef.current = now;
      const normalizedBase = gatewayBaseUrl.trim().replace(/\/$/, "");

      setPhase("starting");
      setPhaseMessage("Starting local Gateway...");
      try {
        await startLocalGateway(normalizedBase);
        setStatusDetail(null);
      } catch (startErr) {
        const startMsg = errorMessage(startErr, "Failed to start local Gateway");
        setPhase("error");
        setPhaseMessage("Gateway needs attention. Check logs and try Start gateway.");
        setStatusDetail(startMsg);
        addLog(`Gateway recovery failed: ${startMsg}`);
      } finally {
        recoveryInFlightRef.current = false;
      }
    },
    [addLog, autoStartEnabled, gatewayBaseUrl, startLocalGateway],
  );

  const ensureGateway = useCallback(
    async (opts?: { startIfOffline?: boolean }) => {
      const startIfOffline = opts?.startIfOffline ?? true;
      const normalizedBase = gatewayBaseUrl.trim().replace(/\/$/, "");

      setPhase("checking");
      setPhaseMessage(`Checking ${normalizedBase}/status...`);
      setStatusDetail(null);
      try {
        if (startIfOffline) {
          await startLocalGateway(normalizedBase);
          return;
        }

        await attachAndProbe(normalizedBase);
        return;
      } catch (firstErr) {
        if (!startIfOffline) {
          const msg = errorMessage(firstErr, "Gateway not reachable");
          setGateway(null);
          setPhase("offline");
          setPhaseMessage("Local Gateway not reachable.");
          setStatusDetail(msg);
          addLog(`Status probe failed: ${msg}`);
          return;
        }

        setAutoStartEnabled(true);
        await recoverFromStatusFailure(firstErr, { forceStart: true });
      }
    },
    [addLog, attachAndProbe, gatewayBaseUrl, recoverFromStatusFailure, startLocalGateway],
  );

  useEffect(() => {
    void ensureGateway({ startIfOffline: true });
  }, [ensureGateway]);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      !("__TAURI_INTERNALS__" in window) ||
      !(window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    ) {
      return;
    }

    let active = true;
    let dispose: (() => void) | null = null;
    let cancelled = false;

    void listen<string>("gateway_log", (event) => {
      if (!active) return;
      const payload = typeof event.payload === "string" ? event.payload : "";
      addLog(payload);
    }).then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      dispose = unlisten;
    });

    return () => {
      cancelled = true;
      active = false;
      if (dispose) dispose();
    };
  }, [addLog]);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        await probeStatus();
      } catch (err) {
        if (cancelled) return;
        await recoverFromStatusFailure(err);
      }
    };

    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [probeStatus, recoverFromStatusFailure]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await refreshLocalStorage({ silent: true });
    };
    void tick();
    const timer = window.setInterval(() => {
      void tick();
    }, STORAGE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshLocalStorage]);

  const handleAttach = async () => {
    setActionBusy(true);
    try {
      await ensureGateway({ startIfOffline: false });
    } finally {
      setActionBusy(false);
    }
  };

  const handleStart = async () => {
    setActionBusy(true);
    setAutoStartEnabled(true);
    try {
      await ensureGateway({ startIfOffline: true });
    } finally {
      setActionBusy(false);
    }
  };

  const handleStop = async () => {
    setActionBusy(true);
    setAutoStartEnabled(false);
    setPhase("stopping");
    setPhaseMessage("Stopping local Gateway...");
    setStatusDetail(null);
    try {
      await gatewayStop();
      setGateway(null);
      consecutiveFailuresRef.current = 0;
      setPhase("offline");
      setPhaseMessage("Local Gateway stopped. Press Start gateway to run it again.");
      addLog("Local Gateway stopped.");
    } catch (err) {
      const msg = errorMessage(err, "Failed to stop gateway");
      setPhase("error");
      setPhaseMessage("Could not stop local Gateway cleanly.");
      setStatusDetail(msg);
      addLog(`Gateway stop failed: ${msg}`);
    } finally {
      setActionBusy(false);
    }
  };

  const handleOpenDashboard = async () => {
    await openUrl("https://nilstore.org/#/dashboard");
  };

  const handleOpenEndpoint = async (suffix: string) => {
    const base = gatewayBaseUrl.trim().replace(/\/$/, "");
    await openUrl(`${base}${suffix}`);
  };

  const handleOpenCacheDir = async () => {
    if (!storageSummary?.uploads_dir) return;
    try {
      await openPath(storageSummary.uploads_dir);
      addLog(`Opened cache folder: ${storageSummary.uploads_dir}`);
      return;
    } catch (err) {
      const firstError = errorMessage(err, "openPath failed");
      addLog(`Open cache folder failed (path): ${firstError}`);
      try {
        await openUrl(toFileUrl(storageSummary.uploads_dir));
        addLog(`Opened cache folder via file URL: ${storageSummary.uploads_dir}`);
        return;
      } catch (fallbackErr) {
        const secondError = errorMessage(fallbackErr, "openUrl fallback failed");
        setStatusDetail(`Could not open cache folder: ${secondError}`);
        addLog(`Open cache folder failed (url): ${secondError}`);
      }
    }
  };

  const handlePickFile = async () => {
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected === "string") {
      setLocalFilePath(selected);
    }
  };

  const handleUpload = async () => {
    if (!gateway) {
      setUploadError("Gateway is offline. Start the local Gateway first.");
      return;
    }
    if (!localFilePath) {
      setUploadError("Select a local file.");
      return;
    }
    if (!uploadDealId || !uploadOwner) {
      setUploadError("Provide deal ID and owner address.");
      return;
    }

    addLog(
      `Starting upload for "${uploadFilePath}" to deal ${uploadDealId} (owner ${uploadOwner})`,
    );
    if (gatewayManaged === false && isLoopbackHost(hostFromBaseUrl(gatewayBaseUrl))) {
      addLog(
        "Upload is being handled by an external Gateway endpoint; GUI-managed upload lifecycle logs are not available.",
      );
    }
    setUploadBusy(true);
    setUploadError(null);
    setUploadResponse(null);
    try {
      const response = await uploadFile({
        deal_id: Number(uploadDealId),
        owner: uploadOwner,
        file_path: uploadFilePath,
        local_path: localFilePath,
      });
      setUploadResponse(response);
      setListManifestRoot(response.manifest_root);
      if (!listDealId) setListDealId(uploadDealId);
      if (!listOwner) setListOwner(uploadOwner);
      const shortUploadId =
        response.upload_id && response.upload_id.trim().length > 0
          ? response.upload_id
          : "n/a";
      addLog(
        `Upload request accepted: ${response.filename} -> ${response.manifest_root.slice(0, 18)}... (id=${shortUploadId})`,
      );
      void refreshLocalStorage({ silent: true });
    } catch (err) {
      const msg = errorMessage(err, "Upload failed");
      setUploadError(msg);
      addLog(`Upload failed: ${msg}`);
    } finally {
      setUploadBusy(false);
    }
  };

  const handleListFiles = async () => {
    if (!gateway) {
      setListError("Gateway is offline. Start the local Gateway first.");
      return;
    }
    if (!listManifestRoot || !listDealId || !listOwner) {
      setListError("Provide manifest root, deal ID, and owner.");
      return;
    }

    setListBusy(true);
    setListError(null);
    setFiles([]);
    try {
      const response = await listFiles({
        manifest_root: listManifestRoot,
        deal_id: Number(listDealId),
        owner: listOwner,
      });
      setFiles(response.files ?? []);
      addLog(`Listed ${response.files?.length ?? 0} files from deal ${listDealId}.`);
    } catch (err) {
      const msg = errorMessage(err, "List files failed");
      setListError(msg);
      addLog(`List files failed: ${msg}`);
    } finally {
      setListBusy(false);
    }
  };

  const handleDownload = async (entry: GatewayFileEntry) => {
    if (!gateway) {
      setDownloadError("Gateway is offline. Start the local Gateway first.");
      return;
    }
    if (!listManifestRoot || !listDealId || !listOwner) {
      setDownloadError("Provide manifest root, deal ID, and owner.");
      return;
    }

    const outputPath = await save({
      defaultPath: entry.path.split("/").pop() ?? "download.bin",
    });
    if (!outputPath) return;

    setDownloadBusy(entry.path);
    setDownloadError(null);
    try {
      await fetchFile({
        manifest_root: listManifestRoot,
        deal_id: Number(listDealId),
        owner: listOwner,
        file_path: entry.path,
        output_path: outputPath,
      });
      addLog(`Downloaded ${entry.path}`);
      void refreshLocalStorage({ silent: true });
    } catch (err) {
      const msg = errorMessage(err, "Download failed");
      setDownloadError(msg);
      addLog(`Download failed: ${msg}`);
    } finally {
      setDownloadBusy(null);
    }
  };

  const depsSummary = useMemo(() => {
    if (!gateway?.deps) return "No dependency data";
    const entries = Object.entries(gateway.deps);
    if (entries.length === 0) return "No dependency data";
    return entries
      .map(([name, ok]) => `${name}:${ok ? "ok" : "fail"}`)
      .join("  |  ");
  }, [gateway]);

  const capabilitiesSummary = useMemo(() => {
    if (!gateway?.capabilities) return "No capabilities reported";
    const enabled = Object.entries(gateway.capabilities)
      .filter(([, enabled]) => enabled)
      .map(([name]) => name);
    return enabled.length > 0 ? enabled.join(", ") : "None enabled";
  }, [gateway]);

  const storageDealEntries = useMemo(
    () => (storageSummary?.deal_entries ?? []).slice(0, RECENT_DEAL_LIMIT),
    [storageSummary],
  );

  const storageRecentFiles = useMemo(
    () => (storageSummary?.recent_files ?? []).slice(0, RECENT_FILE_LIMIT),
    [storageSummary],
  );

  const filteredStorageDealEntries = useMemo(
    () =>
      storageDealFilter === "all"
        ? storageDealEntries
        : storageDealEntries.filter((deal) => deal.deal_id === storageDealFilter),
    [storageDealEntries, storageDealFilter],
  );

  const filteredStorageRecentFiles = useMemo(() => {
    const query = storageFileQuery.trim().toLowerCase();
    return storageRecentFiles.filter((file) => {
      if (storageDealFilter !== "all" && file.deal_id !== storageDealFilter) {
        return false;
      }
      if (!query) return true;
      return file.relative_path.toLowerCase().includes(query);
    });
  }, [storageDealFilter, storageFileQuery, storageRecentFiles]);

  const dependencyIssues = useMemo(() => {
    const issues: string[] = [];
    if (gateway?.deps?.lcd_reachable === false) {
      issues.push("LCD unreachable: chain queries and deal checks may fail.");
    }
    if (gateway?.deps?.sp_reachable === false) {
      issues.push("Storage provider unreachable: uploads/retrieval may route to browser fallback.");
    }
    return issues;
  }, [gateway?.deps]);

  const readinessItems = useMemo(
    () =>
      [
        {
          key: "gateway",
          title: "Gateway process",
          state:
            phase === "online"
              ? "ready"
              : phase === "booting" || phase === "starting" || phase === "checking"
                ? "pending"
                : "blocked",
          detail:
            phase === "online"
              ? gatewayManaged === false
                ? "External endpoint connected"
                : "GUI-managed local process"
              : "Start or reconnect the local Gateway process",
        },
        {
          key: "chain",
          title: "Chain connectivity",
          state:
            gateway?.deps?.lcd_reachable === true
              ? "ready"
              : gateway?.deps?.lcd_reachable === false
                ? "blocked"
                : phase === "online"
                  ? "pending"
                  : "blocked",
          detail:
            gateway?.deps?.lcd_reachable === true
              ? "LCD reachable"
              : "Gateway cannot reach LCD endpoint",
        },
        {
          key: "providers",
          title: "Storage providers",
          state:
            gateway?.deps?.sp_reachable === true
              ? "ready"
              : gateway?.deps?.sp_reachable === false
                ? "blocked"
                : phase === "online"
                  ? "pending"
                  : "blocked",
          detail:
            gateway?.deps?.sp_reachable === true
              ? "Provider paths reachable"
              : "Provider path check failed",
        },
      ] as Array<{ key: string; title: string; state: ReadinessState; detail: string }>,
    [gateway?.deps?.lcd_reachable, gateway?.deps?.sp_reachable, gatewayManaged, phase],
  );

  const readinessCounts = useMemo(
    () => ({
      ready: readinessItems.filter((item) => item.state === "ready").length,
      pending: readinessItems.filter((item) => item.state === "pending").length,
      blocked: readinessItems.filter((item) => item.state === "blocked").length,
    }),
    [readinessItems],
  );

  const gatewayLogMessage = useMemo(() => {
    if (gatewayManaged === true) {
      return "Waiting for user-gateway logs. Start a local upload now to stream upload activity.";
    }
    if (gatewayManaged === false) {
      return "Connected to an external user-gateway endpoint; GUI log streaming is unavailable.";
    }
    return "Start the local user-gateway to begin managed log streaming.";
  }, [gatewayManaged]);

  const recentActivity = useMemo(() => logs.slice(-RECENT_ACTIVITY_LIMIT).reverse(), [logs]);

  const formFieldClass =
    "font-mono-data w-full rounded-none border border-border bg-card/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] focus:outline-none focus:ring-2 focus:ring-orange-500/30";

  const handleCopyDiagnostics = useCallback(async () => {
    setDiagCopyBusy(true);
    try {
      const payload = {
        generated_at: new Date().toISOString(),
        ui: {
          phase,
          phase_message: phaseMessage,
          status_detail: statusDetail,
          auto_start: autoStartEnabled,
          gateway_managed: gatewayManaged,
          gateway_base_url: gatewayBaseUrl,
          last_status_at: lastStatusAt,
          storage_last_at: storageLastAt,
        },
        readiness: readinessItems,
        gateway_status: gateway,
        storage_summary: storageSummary,
        tail_logs: logs.slice(-40),
      };
      await copyToClipboard(JSON.stringify(payload, null, 2));
      setDiagCopyMessage("SYNCED ✓");
      addLog("Copied diagnostics snapshot to clipboard.");
    } catch (err) {
      const msg = errorMessage(err, "Failed to copy diagnostics.");
      setDiagCopyMessage(`ERR ✕ ${msg}`);
      addLog(`Diagnostics copy failed: ${msg}`);
    } finally {
      setDiagCopyBusy(false);
      window.setTimeout(() => setDiagCopyMessage(null), 3000);
    }
  }, [
    addLog,
    autoStartEnabled,
    gateway,
    gatewayManaged,
    gatewayBaseUrl,
    lastStatusAt,
    logs,
    phase,
    phaseMessage,
    readinessItems,
    statusDetail,
    storageLastAt,
    storageSummary,
  ]);

  const isConnecting =
    phase === "booting" || phase === "checking" || phase === "starting" || phase === "stopping";

  const tabButtonClass = (panel: "overview" | "storage" | "diagnostics") =>
    [
      "panel-tab",
      activePanel === panel ? "panel-tab-active" : "",
    ].join(" ");

  if (workspace === "sp") {
    return (
      <div className="gateway-app min-h-screen">
        <div className="mx-auto max-w-6xl space-y-5 px-5 py-6">
          <SpLaunchpad onBack={() => setWorkspace("gateway")} />
        </div>
      </div>
    );
  }

  return (
    <div className="gateway-app min-h-screen">
      <div className="mx-auto max-w-6xl space-y-3 px-5 py-6">
        <header className="glass-panel industrial-border p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <img
                src={theme === "dark" ? logoDark : logoLight}
                alt="NilStore"
                className="h-8 w-8 rounded-none border border-border bg-card p-1.5"
              />
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold tracking-tight text-foreground uppercase">Local Gateway</h1>
                <span className={`status-pill border px-2 py-1 font-mono-data h-7 text-[10px] ${statusBadgeClass(phase)}`}>
                  <span className={`status-dot ${phase === "online" ? "status-dot-live" : ""}`} />
                  {statusLabel(phase)}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="control-btn control-btn-primary h-8 px-3"
                onClick={() => {
                  if (phase === "online") {
                    void handleOpenDashboard();
                    return;
                  }
                  void handleStart();
                }}
                disabled={actionBusy || isConnecting}
              >
                {phase === "online"
                  ? "OPEN DASHBOARD"
                  : isConnecting
                    ? "CONNECTING..."
                    : "START GATEWAY"}
              </button>
              <button
                type="button"
                className="control-btn flex items-center justify-center h-8 w-8 p-0 text-foreground"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                aria-label="Toggle theme"
              >
                {theme === "dark" ? (
                  <Sun size={16} strokeWidth={2.5} />
                ) : (
                  <Moon size={16} strokeWidth={2.5} />
                )}
              </button>
              <button
                type="button"
                className="control-btn h-8 px-3"
                onClick={() => setActivePanel("diagnostics")}
              >
                DIAGNOSTICS
              </button>
              <button
                type="button"
                className="control-btn h-8 px-3"
                onClick={() => setWorkspace("sp")}
              >
                PROVIDER TOOLS
              </button>
            </div>
          </div>
        </header>

        <div className={["glass-panel industrial-border px-4 py-1.5 flex flex-wrap items-center justify-between gap-4 bg-muted/5", isConnecting ? "animate-scan" : ""].join(" ")}>
          <div className="flex items-center gap-4">
            <p className="text-[11px] font-bold text-foreground font-mono-data flex items-center gap-2">
              <span className={`w-1.5 h-1.5 ${phase === 'online' ? 'bg-primary animate-pulse' : 'bg-muted-foreground'}`} />
              {phaseMessage.toUpperCase()}
            </p>
            <p className="text-[10px] text-muted-foreground font-mono-data uppercase tracking-wider">
              {readinessCounts.ready}/3 checks ready
              {readinessCounts.blocked > 0
                ? ` · ${readinessCounts.blocked} needs attention`
                : readinessCounts.pending > 0
                  ? ` · ${readinessCounts.pending} in progress`
                  : " · system healthy"}
              {lastStatusAt ? ` · sync: ${new Date(lastStatusAt).toLocaleTimeString()}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <span className="text-[9px] font-mono-data uppercase tracking-wider text-muted-foreground/80">
              <strong className="text-muted-foreground/40 mr-1">Endpoint</strong> {gatewayBaseUrl}
            </span>
            <span className="text-[9px] font-mono-data uppercase tracking-wider text-muted-foreground/80">
              <strong className="text-muted-foreground/40 mr-1">Mode</strong> {gateway?.mode || "standalone"}
            </span>
            <span className="text-[9px] font-mono-data uppercase tracking-wider text-muted-foreground/80">
              <strong className="text-muted-foreground/40 mr-1">Source</strong> {gatewayManaged ? "Managed" : "Attached"}
            </span>
          </div>
        </div>

        {statusDetail ? (
          <div className="border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[10px] text-rose-200 font-mono-data uppercase tracking-wider">
            Fault: {statusDetail}
          </div>
        ) : null}

        {!baseIsLoopback ? (
          <div className="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[10px] text-amber-200 font-mono-data uppercase tracking-wider">
            Non-local endpoint configured. Use `http://127.0.0.1:8080` for normal local Gateway flows.
          </div>
        ) : null}


        <section className="glass-panel industrial-border p-4">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-border/40 pb-4">
            <button
              type="button"
              className={tabButtonClass("overview")}
              onClick={() => setActivePanel("overview")}
            >
              OVERVIEW
            </button>
            <button
              type="button"
              className={tabButtonClass("storage")}
              onClick={() => setActivePanel("storage")}
            >
              STORAGE
            </button>
            <button
              type="button"
              className={tabButtonClass("diagnostics")}
              onClick={() => setActivePanel("diagnostics")}
            >
              DIAGNOSTICS
            </button>
          </div>

          {activePanel === "overview" ? (
            <div className="mt-4 space-y-4">
              <div className="grid gap-3 md:grid-cols-3">
                {readinessItems.map((item) => (
                  <div key={item.key} className="metric-card industrial-border px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                          {item.title}
                        </p>
                        <div className="mt-2 flex items-center gap-2">
                          <span
                            className={[
                              item.state === "ready"
                                ? "text-accent"
                                : item.state === "pending"
                                  ? "text-primary"
                                  : "text-destructive",
                            ].join(" ")}
                          >
                            <span
                              className={[
                                "status-dot",
                                item.key === "gateway" && item.state === "ready" ? "status-dot-live" : "",
                              ].join(" ")}
                            />
                          </span>
                          <p
                            className={[
                              "font-mono-data text-lg leading-none",
                              item.state === "ready"
                                ? "text-accent"
                                : item.state === "pending"
                                  ? "text-primary"
                                  : "text-destructive",
                            ].join(" ")}
                          >
                            {readinessLabel(item.state).toUpperCase()}
                          </p>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                      </div>

                      <span
                        className={[
                          "font-mono-data border px-2 py-0.5 text-[10px] font-bold tracking-[0.18em]",
                          readinessBadgeClass(item.state),
                        ].join(" ")}
                      >
                        {item.key === "gateway"
                          ? "GW"
                          : item.key === "chain"
                            ? "LCD"
                            : "SP"}
                        :
                        {item.state === "ready"
                          ? "OK"
                          : item.state === "pending"
                            ? "WAIT"
                            : "ERR"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {dependencyIssues.length > 0 ? (
                <div className="border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 font-mono-data">
                  {dependencyIssues.map((issue) => (
                    <p key={issue}>{issue}</p>
                  ))}
                </div>
              ) : null}

              <div className="metric-card industrial-border">
                <div className="border-b subtle-divider px-3 py-2 soft-label">
                  Recent activity
                </div>
                {recentActivity.length === 0 ? (
                  <p className="px-3 py-3 text-sm text-muted-foreground">
                    No recent activity yet.
                  </p>
                ) : (
                  <ul className="space-y-1.5 px-3 py-3">
                    {recentActivity.map((line, index) => (
                      <li
                        key={`activity-${index}-${line}`}
                        className="list-disc pl-1 text-xs text-muted-foreground/90 marker:text-muted-foreground/50"
                      >
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <DealSlabPanel
                gatewayOnline={phase === "online"}
                listBusy={listBusy}
                listError={listError}
                downloadBusyPath={downloadBusy}
                downloadError={downloadError}
                dealId={listDealId}
                owner={listOwner}
                manifestRoot={listManifestRoot}
                files={files}
                uploadResponse={uploadResponse}
                onChangeDealId={setListDealId}
                onChangeOwner={setListOwner}
                onChangeManifestRoot={setListManifestRoot}
                onLoadFiles={() => void handleListFiles()}
                onDownload={(entry) => void handleDownload(entry)}
                onLearnMdus={() => void openUrl(TECHNOLOGY_MDU_PRIMER_URL)}
              />

              <details className="metric-card industrial-border p-3">
                <summary className="cursor-pointer text-sm font-semibold text-foreground/90">
                  Connection controls
                </summary>
                <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                  <label className="text-xs font-semibold text-muted-foreground">
                    Gateway URL
                    <input
                      className={`mt-1 ${formFieldClass}`}
                      value={gatewayBaseUrl}
                      onChange={(event) => setGatewayBaseUrl(event.target.value)}
                    />
                  </label>
                  <div className="flex items-end gap-2">
                    <button
                      type="button"
                      className="control-btn control-btn-inline"
                      onClick={() => void ensureGateway({ startIfOffline: false })}
                      disabled={actionBusy}
                    >
                      Refresh status
                    </button>
                    <button
                      type="button"
                      className="control-btn control-btn-inline"
                      onClick={handleAttach}
                      disabled={actionBusy}
                    >
                      Reconnect
                    </button>
                    <button
                      type="button"
                      className="control-btn control-btn-inline"
                      onClick={handleStop}
                      disabled={
                        actionBusy ||
                        phase === "offline" ||
                        phase === "booting" ||
                        phase === "stopping" ||
                        gatewayManaged === false
                      }
                    >
                      Stop
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-xs text-muted-foreground font-mono-data">
                  Auto-start: {autoStartEnabled ? "enabled" : "paused"}
                </p>
              </details>
            </div>
          ) : null}

          {activePanel === "storage" ? (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="metric-card industrial-border px-3 py-2">
                    <p className="soft-label">Deals</p>
                    <p className="font-mono-data text-lg font-semibold text-foreground tabular-nums">
                      {storageSummary?.deal_count ?? 0}
                    </p>
                  </div>
                  <div className="metric-card industrial-border px-3 py-2">
                    <p className="soft-label">Manifests</p>
                    <p className="font-mono-data text-lg font-semibold text-foreground tabular-nums">
                      {storageSummary?.manifest_count ?? 0}
                    </p>
                  </div>
                  <div className="metric-card industrial-border px-3 py-2">
                    <p className="soft-label">Files</p>
                    <p className="font-mono-data text-lg font-semibold text-foreground tabular-nums">
                      {storageSummary?.total_files ?? 0}
                    </p>
                  </div>
                  <div className="metric-card industrial-border px-3 py-2">
                    <p className="soft-label">Disk</p>
                    <p className="font-mono-data text-lg font-semibold text-foreground tabular-nums">
                      {formatBytes(storageSummary?.total_bytes ?? 0)}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="control-btn control-btn-inline"
                    onClick={() => {
                      void refreshLocalStorage();
                    }}
                    disabled={storageBusy}
                  >
                    {storageBusy ? "Refreshing..." : "Refresh cache"}
                  </button>
                  <button
                    type="button"
                    className="control-btn control-btn-inline"
                    onClick={() => {
                      void handleOpenCacheDir();
                    }}
                    disabled={!storageSummary?.uploads_dir}
                  >
                    Open cache folder
                  </button>
                </div>
              </div>

              <div className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)]">
                <label className="text-xs font-semibold text-muted-foreground">
                  Deal filter
                  <select
                    className="font-mono-data mt-1 w-full rounded-none border border-border bg-card/30 px-2 py-2 text-sm text-foreground"
                    value={storageDealFilter}
                    onChange={(event) => setStorageDealFilter(event.target.value)}
                  >
                    <option value="all">All deals</option>
                    {storageDealEntries.map((deal) => (
                      <option key={deal.deal_id} value={deal.deal_id}>
                        Deal {deal.deal_id}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs font-semibold text-muted-foreground">
                  File search
                  <input
                    className="font-mono-data mt-1 w-full rounded-none border border-border bg-card/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50"
                    placeholder="Filter cached files by path..."
                    value={storageFileQuery}
                    onChange={(event) => setStorageFileQuery(event.target.value)}
                  />
                </label>
              </div>

              {(storageDealFilter !== "all" || storageFileQuery.trim() !== "") ? (
                <button
                  type="button"
                  className="control-btn control-btn-inline"
                  onClick={() => {
                    setStorageDealFilter("all");
                    setStorageFileQuery("");
                  }}
                >
                  Reset filters
                </button>
              ) : null}

              {storageError ? (
                <p className="text-xs text-rose-300 font-mono-data">{storageError}</p>
              ) : null}

              <div className="metric-card industrial-border px-3 py-2 text-xs text-muted-foreground/90 font-mono-data">
                <p className="break-all">
                  <span className="font-semibold text-muted-foreground">Uploads dir:</span>{" "}
                  {storageSummary?.uploads_dir || "n/a"}
                </p>
                <p className="break-all">
                  <span className="font-semibold text-muted-foreground">Session DB:</span>{" "}
                  {storageSummary?.session_db_path || "n/a"}{" "}
                  {storageSummary?.session_db_exists ? "(present)" : "(not created yet)"}
                </p>
                <p>
                  <span className="font-semibold text-muted-foreground">Last cache scan:</span>{" "}
                  {storageLastAt ? new Date(storageLastAt).toLocaleTimeString() : "n/a"}
                </p>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div className="metric-card industrial-border">
                  <div className="border-b subtle-divider px-3 py-2 soft-label">
                    Cached deals
                  </div>
                  {filteredStorageDealEntries.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      {storageDealEntries.length === 0
                        ? "No deal cache folders yet."
                        : "No deals match the current filter."}
                    </div>
                  ) : (
                    filteredStorageDealEntries.map((deal) => (
                      <div
                        key={deal.deal_id}
                        className="grid grid-cols-[0.7fr_0.7fr_0.7fr_0.7fr_auto] gap-2 border-b border-border/50 px-3 py-2 text-xs text-foreground/90 last:border-b-0"
                      >
                        <span className="font-mono-data font-semibold text-foreground">{deal.deal_id}</span>
                        <span>{formatBytes(deal.total_bytes)}</span>
                        <span>{deal.file_count} files</span>
                        <span>{deal.manifest_count} manifests</span>
                        <button
                          type="button"
                          className="control-btn control-btn-inline px-2 py-1 text-[10px]"
                          onClick={() => setStorageDealFilter(deal.deal_id)}
                        >
                          Focus
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="metric-card industrial-border">
                  <div className="border-b subtle-divider px-3 py-2 soft-label">
                    Recent cached files
                  </div>
                  {filteredStorageRecentFiles.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-muted-foreground">
                      {storageRecentFiles.length === 0 && storageDealFilter === "all" && !storageFileQuery
                        ? "No cached files yet."
                        : "No cached files match this filter/search."}
                    </div>
                  ) : (
                    filteredStorageRecentFiles.map((file) => (
                      <div
                        key={`${file.relative_path}-${file.modified_unix}`}
                        className="border-b border-border/50 px-3 py-2 text-xs text-foreground/90 last:border-b-0"
                      >
                        <p className="truncate font-mono-data font-medium text-foreground">
                          {file.relative_path}
                        </p>
                        <p className="mt-0.5 text-muted-foreground font-mono-data">
                          {formatBytes(file.size_bytes)} · deal {file.deal_id} · {formatUnixTime(file.modified_unix)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {activePanel === "diagnostics" ? (
            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
              <div className="metric-card industrial-border p-3">
                <div className="flex items-center justify-between">
                  <h2 className="soft-label">Live gateway logs</h2>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground font-mono-data">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={autoScrollLogs}
                        onChange={(event) => setAutoScrollLogs(event.target.checked)}
                      />
                      Auto-scroll
                    </label>
                    <button
                      type="button"
                      className="control-btn control-btn-inline px-2 py-1"
                      onClick={() => setLogs([])}
                    >
                      Clear
                    </button>
                  </div>
                </div>
                  <div
                    className={[
                      "log-panel mt-3 h-[340px] overflow-auto p-3 font-mono-data text-xs leading-relaxed text-emerald-200",
                      isConnecting ? "animate-scan" : "",
                    ].join(" ")}
                  ref={(node) => {
                    if (node && autoScrollLogs) {
                      node.scrollTop = node.scrollHeight;
                    }
                  }}
                  >
                    {logs.length === 0 ? (
                      <p className="text-emerald-100/70">{gatewayLogMessage}</p>
                    ) : (
                      logs.map((line, index) => {
                        const match = line.match(/^(\[[^\]]+\])\s*(.*)$/);
                        return (
                          <p key={`${index}-${line}`} className="break-words">
                            {match ? (
                              <>
                                <span className="text-emerald-300/40">{match[1]}</span>{" "}
                                <span className="text-emerald-200">{match[2]}</span>
                              </>
                            ) : (
                              line
                            )}
                          </p>
                        );
                      })
                    )}
                  </div>
              </div>

              <div className="space-y-3">
                <div className="metric-card industrial-border p-3">
                  <p className="soft-label">Gateway internals</p>
                  <div className="mt-2 space-y-1 text-xs text-muted-foreground/90 font-mono-data">
                    <p>
                      <span className="font-semibold text-muted-foreground">Listening:</span>{" "}
                      {gateway?.listening_addr || "—"}
                    </p>
                    <p>
                      <span className="font-semibold text-muted-foreground">Mode:</span> {gateway?.mode || "—"}
                    </p>
                    <p className="break-all">
                      <span className="font-semibold text-muted-foreground">Dependencies:</span> {depsSummary}
                    </p>
                    <p className="break-all">
                      <span className="font-semibold text-muted-foreground">Capabilities:</span> {capabilitiesSummary}
                    </p>
                    <p className="break-all">
                      <span className="font-semibold text-muted-foreground">Provider base:</span>{" "}
                      {gateway?.provider_base || "Not reported"}
                    </p>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="control-btn control-btn-inline"
                      onClick={() => void handleOpenEndpoint("/health")}
                    >
                      Open /health
                    </button>
                    <button
                      type="button"
                      className="control-btn control-btn-inline"
                      onClick={() => void handleOpenEndpoint("/status")}
                    >
                      Open /status
                    </button>
                    <button
                      type="button"
                      className="control-btn control-btn-inline"
                      onClick={() => {
                        void handleCopyDiagnostics();
                      }}
                      disabled={diagCopyBusy}
                    >
                      {diagCopyBusy
                        ? "COPYING..."
                        : diagCopyMessage?.startsWith("SYNCED")
                          ? "SYNCED ✓"
                          : "COPY DIAG"}
                    </button>
                  </div>
                  {diagCopyMessage ? (
                    <p
                      className={[
                        "mt-2 text-[10px] font-mono-data font-bold tracking-[0.18em]",
                        diagCopyMessage.startsWith("SYNCED") ? "text-emerald-200" : "text-rose-200",
                      ].join(" ")}
                    >
                      {diagCopyMessage}
                    </p>
                  ) : null}
                </div>

              </div>

              <details className="metric-card industrial-border p-3 lg:col-span-2" open={showAdvanced}>
                <summary
                  className="cursor-pointer text-sm font-semibold text-foreground/90"
                  onClick={(e) => {
                    e.preventDefault();
                    setShowAdvanced((prev) => !prev);
                  }}
                >
                  Advanced API smoke actions
                </summary>
                {showAdvanced ? (
                  <div className="mt-3 space-y-6 border-t subtle-divider pt-3">
                    <div>
                      <p className="text-xs font-semibold text-muted-foreground font-mono-data">
                        Upload (`/gateway/upload`)
                      </p>
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <label className="text-sm text-muted-foreground/90">
                          Deal ID
                          <input
                            className={formFieldClass}
                            value={uploadDealId}
                            onChange={(event) => setUploadDealId(event.target.value)}
                          />
                        </label>
                        <label className="text-sm text-muted-foreground/90">
                          Owner
                          <input
                            className={formFieldClass}
                            value={uploadOwner}
                            onChange={(event) => setUploadOwner(event.target.value)}
                            placeholder="nil1..."
                          />
                        </label>
                        <label className="text-sm text-muted-foreground/90">
                          NilFS path
                          <input
                            className={formFieldClass}
                            value={uploadFilePath}
                            onChange={(event) => setUploadFilePath(event.target.value)}
                          />
                        </label>
                        <div className="text-sm text-muted-foreground/90">
                          Local file
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="control-btn control-btn-inline"
                              onClick={handlePickFile}
                            >
                              Choose file
                            </button>
                            <span className="text-xs text-muted-foreground break-all font-mono-data">
                              {localFilePath || "No file selected"}
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="control-btn control-btn-primary control-btn-inline"
                          onClick={handleUpload}
                          disabled={uploadBusy || phase !== "online"}
                        >
                          {uploadBusy ? "Uploading..." : "Upload file"}
                        </button>
                        {uploadError ? (
                          <span className="text-xs text-rose-300 font-mono-data">{uploadError}</span>
                        ) : null}
                      </div>
                      {uploadResponse ? (
                        <div className="mt-3 border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 font-mono-data">
                          Manifest root: <span className="break-all">{uploadResponse.manifest_root}</span>
                        </div>
                      ) : null}
                    </div>

                    <div className="border-t subtle-divider pt-5 text-xs text-muted-foreground/90">
                      List/download and slab ranges are now first-class on the Overview panel:{" "}
                      <span className="font-semibold text-foreground">
                        Deal storage layout (Slab / MDUs)
                      </span>
                      .
                    </div>

                    {gateway ? (
                      <details className="metric-card industrial-border p-3">
                        <summary className="cursor-pointer text-xs font-semibold text-muted-foreground/90">
                          Raw /status payload
                        </summary>
                        <pre className="mt-2 overflow-auto text-[11px] text-foreground/90 font-mono-data">
                          {JSON.stringify(gateway, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </details>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
