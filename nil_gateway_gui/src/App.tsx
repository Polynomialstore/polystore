import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import logoDark from "./assets/nilstore-dark.png";
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

const LOG_BUFFER_LIMIT = 400;
const STATUS_POLL_MS = 8_000;
const STORAGE_POLL_MS = 18_000;
const STARTUP_PROBE_ATTEMPTS = 20;
const STARTUP_PROBE_DELAY_MS = 250;
const RECOVERY_FAILURE_THRESHOLD = 2;
const RECOVERY_COOLDOWN_MS = 20_000;
const RECENT_DEAL_LIMIT = 6;
const RECENT_FILE_LIMIT = 8;

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

function normalizeListenAddr(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function parseStatusCounter(extra: Record<string, string> | undefined, key: string): number {
  const raw = extra?.[key];
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
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

function statusBadgeClass(phase: GatewayPhase): string {
  if (phase === "online") return "bg-emerald-100 text-emerald-700";
  if (phase === "starting" || phase === "checking" || phase === "booting") {
    return "bg-amber-100 text-amber-700";
  }
  if (phase === "error") return "bg-rose-100 text-rose-700";
  return "bg-slate-200 text-slate-700";
}

function statusLabel(phase: GatewayPhase): string {
  switch (phase) {
    case "booting":
      return "Booting";
    case "checking":
      return "Checking";
    case "starting":
      return "Starting";
    case "online":
      return "Online";
    case "stopping":
      return "Stopping";
    case "error":
      return "Error";
    default:
      return "Offline";
  }
}

export default function App() {
  const [gatewayBaseUrl, setGatewayBaseUrl] = useState("http://127.0.0.1:8080");
  const [gateway, setGateway] = useState<GatewayStatusResponse | null>(null);
  const [phase, setPhase] = useState<GatewayPhase>("booting");
  const [phaseMessage, setPhaseMessage] = useState("Starting local Gateway...");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [lastStatusAt, setLastStatusAt] = useState<number | null>(null);
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

  const baseHost = useMemo(() => hostFromBaseUrl(gatewayBaseUrl), [gatewayBaseUrl]);
  const baseIsLoopback = useMemo(() => isLoopbackHost(baseHost), [baseHost]);
  const recoveryInFlightRef = useRef(false);
  const consecutiveFailuresRef = useRef(0);
  const lastRecoveryAttemptRef = useRef(0);

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
    setPhase("online");
    setPhaseMessage(`Listening on ${status.listening_addr}`);
    setStatusDetail(null);
    setLastStatusAt(Date.now());
    consecutiveFailuresRef.current = 0;
  }, []);

  const probeStatus = useCallback(async () => {
    const status = await gatewayStatus();
    applyOnlineStatus(status);
    return status;
  }, [applyOnlineStatus]);

  const attachAndProbe = useCallback(
    async (baseUrl: string) => {
      await gatewayAttach(baseUrl);
      return probeStatus();
    },
    [probeStatus],
  );

  const probeAfterStart = useCallback(
    async (baseUrl: string) => {
      let lastErr: unknown = null;
      await gatewayAttach(baseUrl);
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
      await probeAfterStart(baseUrl);
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
    [addLog, attachAndProbe, gatewayBaseUrl, recoverFromStatusFailure],
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
    const normalizedBase = gatewayBaseUrl.trim().replace(/\/$/, "");

    const tick = async () => {
      if (cancelled) return;
      try {
        await attachAndProbe(normalizedBase);
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
  }, [attachAndProbe, gatewayBaseUrl, recoverFromStatusFailure]);

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
      addLog(`Uploaded ${response.filename} -> ${response.manifest_root.slice(0, 18)}...`);
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

  const mode2RepairSummary = useMemo(() => {
    const extra = gateway?.extra;
    const assignedAttempts = parseStatusCounter(extra, "mode2_reconstruct_assigned_provider_attempts");
    const assignedFailures = parseStatusCounter(extra, "mode2_reconstruct_assigned_provider_failures");
    const fallbackAttempts = parseStatusCounter(extra, "mode2_reconstruct_fallback_provider_attempts");
    const fallbackSuccesses = parseStatusCounter(extra, "mode2_reconstruct_fallback_provider_successes");
    const fallbackFailures = parseStatusCounter(extra, "mode2_reconstruct_fallback_provider_failures");
    const localHits = parseStatusCounter(extra, "mode2_reconstruct_local_shard_hits");
    return {
      assignedAttempts,
      assignedFailures,
      fallbackAttempts,
      fallbackSuccesses,
      fallbackFailures,
      localHits,
      hasSignal:
        assignedAttempts > 0 ||
        assignedFailures > 0 ||
        fallbackAttempts > 0 ||
        fallbackSuccesses > 0 ||
        fallbackFailures > 0 ||
        localHits > 0,
    };
  }, [gateway?.extra]);

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

  const formFieldClass =
    "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700";

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-sky-100">
      <div className="mx-auto max-w-7xl space-y-6 p-6">
        <header className="surface-card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <img
                  src={logoDark}
                  alt="NilStore"
                  className="h-10 w-10 rounded-full border border-slate-200 bg-white/80 p-1"
                />
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-400">NilStore</p>
                  <h1 className="text-2xl font-semibold text-slate-900">NilGateway GUI</h1>
                </div>
              </div>
              <p className="mt-2 text-sm text-slate-500">
                Local Gateway manager for `https://nilstore.org/#/dashboard`.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(phase)}`}
              >
                {statusLabel(phase)}
              </span>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                onClick={handleOpenDashboard}
              >
                Open NilStore Dashboard
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                onClick={handleAttach}
                disabled={actionBusy}
              >
                Connect
              </button>
              <button
                type="button"
                className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                onClick={handleStart}
                disabled={actionBusy || phase === "online" || phase === "starting"}
              >
                Start gateway
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                onClick={handleStop}
                disabled={actionBusy || phase === "offline" || phase === "booting" || phase === "stopping"}
              >
                Stop
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
            <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Local Gateway URL
              <input
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm normal-case tracking-normal text-slate-700"
                value={gatewayBaseUrl}
                onChange={(event) => setGatewayBaseUrl(event.target.value)}
              />
            </label>

            <div className="flex items-end">
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                onClick={() => {
                  void ensureGateway({ startIfOffline: false });
                }}
                disabled={actionBusy}
              >
                Refresh status
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
            <p className="font-medium">{phaseMessage}</p>
            {statusDetail ? <p className="mt-1 text-xs text-slate-500">Detail: {statusDetail}</p> : null}
            {lastStatusAt ? (
              <p className="mt-1 text-xs text-slate-500">
                Last status check: {new Date(lastStatusAt).toLocaleTimeString()}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-slate-500">
              Auto-start: {autoStartEnabled ? "enabled" : "paused"}
            </p>
          </div>

          {!baseIsLoopback ? (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Non-local endpoint configured. The website expects local Gateway routing on localhost; use `http://127.0.0.1:8080` unless you are intentionally debugging remote gateway access.
            </div>
          ) : null}
        </header>

        <section className="grid gap-6 lg:grid-cols-[1.3fr_0.7fr]">
          <div className="surface-card p-6">
            <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
              Local Gateway health
            </h2>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Listening</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">
                  {gateway?.listening_addr || "—"}
                </p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Mode</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{gateway?.mode || "—"}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Dependencies</p>
                <p className="mt-1 text-xs text-slate-700 break-all">{depsSummary}</p>
              </div>
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <p className="text-xs uppercase tracking-wide text-slate-500">Capabilities</p>
                <p className="mt-1 text-xs text-slate-700 break-all">{capabilitiesSummary}</p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                onClick={() => void handleOpenEndpoint("/health")}
              >
                Open /health
              </button>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50"
                onClick={() => void handleOpenEndpoint("/status")}
              >
                Open /status
              </button>
            </div>

            {dependencyIssues.length > 0 ? (
              <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {dependencyIssues.map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
              </div>
            ) : null}

            <details className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4" open>
              <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Local storage snapshot
              </summary>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">Deals</p>
                    <p className="text-sm font-semibold text-slate-900">{storageSummary?.deal_count ?? 0}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">Manifests</p>
                    <p className="text-sm font-semibold text-slate-900">{storageSummary?.manifest_count ?? 0}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">Files</p>
                    <p className="text-sm font-semibold text-slate-900">{storageSummary?.total_files ?? 0}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wide text-slate-500">Disk</p>
                    <p className="text-sm font-semibold text-slate-900">{formatBytes(storageSummary?.total_bytes ?? 0)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                    onClick={() => {
                      void refreshLocalStorage();
                    }}
                    disabled={storageBusy}
                  >
                    {storageBusy ? "Refreshing..." : "Refresh cache"}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                    onClick={() => {
                      void handleOpenCacheDir();
                    }}
                    disabled={!storageSummary?.uploads_dir}
                  >
                    Open cache folder
                  </button>
                </div>
              </div>

              {storageError ? (
                <p className="mt-2 text-xs text-rose-600">{storageError}</p>
              ) : null}

              <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
                <p className="break-all">
                  <span className="font-semibold text-slate-700">Uploads dir:</span>{" "}
                  {storageSummary?.uploads_dir || "n/a"}
                </p>
                <p className="break-all">
                  <span className="font-semibold text-slate-700">Session DB:</span>{" "}
                  {storageSummary?.session_db_path || "n/a"}{" "}
                  {storageSummary?.session_db_exists ? "(present)" : "(not created yet)"}
                </p>
                <p>
                  <span className="font-semibold text-slate-700">Last cache scan:</span>{" "}
                  {storageLastAt ? new Date(storageLastAt).toLocaleTimeString() : "n/a"}
                </p>
              </div>

              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white">
                  <div className="border-b border-slate-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Cached deals
                  </div>
                  {storageDealEntries.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-slate-500">
                      No deal cache folders yet.
                    </div>
                  ) : (
                    storageDealEntries.map((deal) => (
                      <div
                        key={deal.deal_id}
                        className="grid grid-cols-[0.8fr_0.8fr_0.7fr_0.7fr] gap-2 border-b border-slate-100 px-3 py-2 text-xs text-slate-700 last:border-b-0"
                      >
                        <span className="font-semibold text-slate-900">{deal.deal_id}</span>
                        <span>{formatBytes(deal.total_bytes)}</span>
                        <span>{deal.file_count} files</span>
                        <span>{deal.manifest_count} manifests</span>
                      </div>
                    ))
                  )}
                </div>

                <div className="rounded-xl border border-slate-200 bg-white">
                  <div className="border-b border-slate-200 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Recent cached files
                  </div>
                  {storageRecentFiles.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-slate-500">
                      No cached files yet.
                    </div>
                  ) : (
                    storageRecentFiles.map((file) => (
                      <div
                        key={`${file.relative_path}-${file.modified_unix}`}
                        className="border-b border-slate-100 px-3 py-2 text-xs text-slate-700 last:border-b-0"
                      >
                        <p className="truncate font-medium text-slate-900">{file.relative_path}</p>
                        <p className="mt-0.5 text-slate-500">
                          {formatBytes(file.size_bytes)} · deal {file.deal_id} · {formatUnixTime(file.modified_unix)}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </details>

            <details className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                Retrieval/repair signal
              </summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Local shard hits</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{mode2RepairSummary.localHits}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Assigned attempts/failures</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {mode2RepairSummary.assignedAttempts} / {mode2RepairSummary.assignedFailures}
                  </p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-3">
                  <p className="text-xs uppercase tracking-wide text-slate-500">Fallback success/fail</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {mode2RepairSummary.fallbackSuccesses} / {mode2RepairSummary.fallbackFailures}
                  </p>
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                {mode2RepairSummary.hasSignal
                  ? `Fallback attempts observed: ${mode2RepairSummary.fallbackAttempts}`
                  : "No reconstruction telemetry yet for this session."}
              </p>
            </details>

            <details className="mt-6 rounded-2xl border border-slate-200 bg-white" open={showAdvanced}>
              <summary
                className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-800"
                onClick={(e) => {
                  e.preventDefault();
                  setShowAdvanced((prev) => !prev);
                }}
              >
                Advanced (experimental): gateway API smoke actions
              </summary>
              {showAdvanced ? (
                <div className="space-y-6 border-t border-slate-100 p-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
                      Upload (gateway/upload)
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <label className="text-sm text-slate-600">
                        Deal ID
                        <input
                          className={formFieldClass}
                          value={uploadDealId}
                          onChange={(event) => setUploadDealId(event.target.value)}
                        />
                      </label>
                      <label className="text-sm text-slate-600">
                        Owner
                        <input
                          className={formFieldClass}
                          value={uploadOwner}
                          onChange={(event) => setUploadOwner(event.target.value)}
                          placeholder="nil1..."
                        />
                      </label>
                      <label className="text-sm text-slate-600">
                        NilFS path
                        <input
                          className={formFieldClass}
                          value={uploadFilePath}
                          onChange={(event) => setUploadFilePath(event.target.value)}
                        />
                      </label>
                      <div className="text-sm text-slate-600">
                        Local file
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700"
                            onClick={handlePickFile}
                          >
                            Choose file
                          </button>
                          <span className="text-xs text-slate-500 break-all">
                            {localFilePath || "No file selected"}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60"
                        onClick={handleUpload}
                        disabled={uploadBusy || phase !== "online"}
                      >
                        {uploadBusy ? "Uploading..." : "Upload file"}
                      </button>
                      {uploadError ? <span className="text-xs text-rose-600">{uploadError}</span> : null}
                    </div>
                    {uploadResponse ? (
                      <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                        Manifest root: {uploadResponse.manifest_root}
                      </div>
                    ) : null}
                  </div>

                  <div className="border-t border-slate-100 pt-5">
                    <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
                      List & download (gateway/list-files + gateway/fetch)
                    </p>
                    <div className="mt-3 grid gap-3 sm:grid-cols-3">
                      <label className="text-sm text-slate-600">
                        Manifest root
                        <input
                          className={formFieldClass}
                          value={listManifestRoot}
                          onChange={(event) => setListManifestRoot(event.target.value)}
                        />
                      </label>
                      <label className="text-sm text-slate-600">
                        Deal ID
                        <input
                          className={formFieldClass}
                          value={listDealId}
                          onChange={(event) => setListDealId(event.target.value)}
                        />
                      </label>
                      <label className="text-sm text-slate-600">
                        Owner
                        <input
                          className={formFieldClass}
                          value={listOwner}
                          onChange={(event) => setListOwner(event.target.value)}
                        />
                      </label>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-60"
                        onClick={handleListFiles}
                        disabled={listBusy || phase !== "online"}
                      >
                        {listBusy ? "Listing..." : "List files"}
                      </button>
                      {listError ? <span className="text-xs text-rose-600">{listError}</span> : null}
                      {downloadError ? (
                        <span className="text-xs text-rose-600">{downloadError}</span>
                      ) : null}
                    </div>

                    <div className="mt-3 rounded-xl border border-slate-200 bg-white">
                      <div className="grid grid-cols-[1.5fr_0.6fr_0.4fr] gap-3 border-b border-slate-200 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-500">
                        <span>Path</span>
                        <span>Bytes</span>
                        <span>Action</span>
                      </div>
                      {files.length === 0 ? (
                        <div className="px-3 py-4 text-sm text-slate-500">No files listed yet.</div>
                      ) : (
                        files.map((entry) => (
                          <div
                            key={entry.path}
                            className="grid grid-cols-[1.5fr_0.6fr_0.4fr] gap-3 border-b border-slate-100 px-3 py-2 text-sm text-slate-700 last:border-b-0"
                          >
                            <span className="truncate">{entry.path}</span>
                            <span>{entry.size_bytes}</span>
                            <button
                              type="button"
                              className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 disabled:opacity-60"
                              onClick={() => void handleDownload(entry)}
                              disabled={downloadBusy === entry.path}
                            >
                              {downloadBusy === entry.path ? "Saving..." : "Download"}
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {gateway ? (
                    <details className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-600">
                        Raw /status payload
                      </summary>
                      <pre className="mt-2 overflow-auto text-[11px] text-slate-700">
                        {JSON.stringify(gateway, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ) : null}
            </details>
          </div>

          <div className="surface-card flex min-h-[380px] flex-col p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                Live gateway logs
              </h2>
              <div className="flex items-center gap-3 text-xs text-slate-500">
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
                  className="rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700"
                  onClick={() => setLogs([])}
                >
                  Clear
                </button>
              </div>
            </div>

            <div
              className="mt-3 h-[360px] overflow-auto rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-xs leading-relaxed text-emerald-200"
              ref={(node) => {
                if (node && autoScrollLogs) {
                  node.scrollTop = node.scrollHeight;
                }
              }}
            >
              {logs.length === 0 ? (
                <p className="text-slate-400">
                  Waiting for gateway logs. Start or connect to the local Gateway to stream output.
                </p>
              ) : (
                logs.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
