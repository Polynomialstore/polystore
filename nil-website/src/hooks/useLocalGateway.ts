// nil-website/src/hooks/useLocalGateway.ts
import { useState, useEffect, useRef } from 'react';
import { appConfig } from '../config';
import { isTrustedLocalGatewayBase } from '../lib/transport/mode';

type GatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface LocalGatewayDetails {
  version?: string;
  git_sha?: string;
  build_time?: string;
  persona?: string;
  mode?: string;
  allowed_route_families?: string[];
  capabilities?: Record<string, boolean>;
  deps?: Record<string, boolean>;
  p2p_addrs?: string[];
}

interface LocalGatewayInfo {
  status: GatewayStatus;
  url: string;
  error: string | null;
  details: LocalGatewayDetails | null;
}

const GATEWAY_STATUS_ENDPOINT = '/status';
const GATEWAY_HEALTH_ENDPOINT = '/health';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const HIDDEN_POLL_INTERVAL_MS = 300_000;
const LOCAL_GATEWAY_CONNECTED_KEY = 'nil_local_gateway_connected';
const DEFAULT_LOCAL_GATEWAY_BASE = 'http://127.0.0.1:8080';

function swapLoopbackHost(baseUrl: string): string | null {
  const raw = String(baseUrl || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost') {
      parsed.hostname = '127.0.0.1';
      return parsed.toString().replace(/\/$/, '');
    }
    if (host === '127.0.0.1') {
      parsed.hostname = 'localhost';
      return parsed.toString().replace(/\/$/, '');
    }
    return null;
  } catch {
    return null;
  }
}

function buildGatewayBaseCandidates(primary: string): string[] {
  const seed = String(primary || '').trim().replace(/\/$/, '');
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    const clean = String(value || '').trim().replace(/\/$/, '');
    if (!clean) return;
    if (!isTrustedLocalGatewayBase(clean)) return;
    if (!candidates.includes(clean)) candidates.push(clean);
  };

  push(seed);
  push('http://127.0.0.1:8080');
  push('http://localhost:8080');
  if (isTrustedLocalGatewayBase(seed)) {
    push(swapLoopbackHost(seed));
  }
  return candidates;
}

function normalizeGatewaySeed(value: string | null | undefined): string {
  const clean = String(value || '').trim().replace(/\/$/, '');
  if (isTrustedLocalGatewayBase(clean)) return clean;
  return DEFAULT_LOCAL_GATEWAY_BASE;
}

function persistLocalGatewayConnected(connected: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_GATEWAY_CONNECTED_KEY, connected ? '1' : '0');
  } catch {
    // best-effort only
  }
}

function parseGatewayPersona(details: LocalGatewayDetails | null): string {
  if (!details) return '';
  return String(details.persona || '').trim().toLowerCase();
}

function hasGatewayRouteFamily(details: LocalGatewayDetails | null): boolean {
  if (!details) return false;
  const families = Array.isArray(details.allowed_route_families) ? details.allowed_route_families : [];
  if (families.length === 0) return true;
  return families.some((family) => String(family || '').toLowerCase().includes('gateway'));
}

export function useLocalGateway(pollInterval: number = DEFAULT_POLL_INTERVAL_MS): LocalGatewayInfo {
  const [status, setStatus] = useState<GatewayStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<LocalGatewayDetails | null>(null);
  const [activeUrl, setActiveUrl] = useState<string>(normalizeGatewaySeed(appConfig.gatewayBase));
  const activeUrlRef = useRef<string>(normalizeGatewaySeed(appConfig.gatewayBase));
  const statusRef = useRef<GatewayStatus>('disconnected');
  const errorRef = useRef<string | null>(null);
  const detailsRef = useRef<LocalGatewayDetails | null>(null);

  useEffect(() => {
    if (appConfig.gatewayDisabled) {
      setStatus('disconnected');
      setError('Gateway disabled');
      setDetails(null);
      setActiveUrl(normalizeGatewaySeed(appConfig.gatewayBase));
      activeUrlRef.current = normalizeGatewaySeed(appConfig.gatewayBase);
      statusRef.current = 'disconnected';
      errorRef.current = 'Gateway disabled';
      detailsRef.current = null;
      persistLocalGatewayConnected(false);
      return;
    }

    // Reset to disconnected on each hook initialization; a successful probe flips this back to connected.
    persistLocalGatewayConnected(false);

    const updateStatus = (next: GatewayStatus) => {
      if (statusRef.current === next) return;
      statusRef.current = next;
      setStatus(next);
      persistLocalGatewayConnected(next === 'connected');
    };
    const updateError = (next: string | null) => {
      if (errorRef.current === next) return;
      errorRef.current = next;
      setError(next);
    };
    const updateDetails = (next: LocalGatewayDetails | null) => {
      const curr = detailsRef.current;
      if (
        (curr === null && next === null) ||
        (curr !== null && next !== null && JSON.stringify(curr) === JSON.stringify(next))
      ) {
        return;
      }
      detailsRef.current = next;
      setDetails(next);
    };
    const updateActiveUrl = (next: string) => {
      const clean = String(next || '').trim().replace(/\/$/, '');
      if (!clean || activeUrlRef.current === clean) return;
      activeUrlRef.current = clean;
      setActiveUrl(clean);
    };

    let inFlight = false;
    let timer: number | null = null;
    let probePath: '/status' | '/health' = '/status';

    const schedule = (delayMs: number) => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        void checkGatewayStatus();
      }, delayMs);
    };

    const checkGatewayStatus = async () => {
      if (inFlight) return;
      inFlight = true;
      if (statusRef.current !== 'connected') {
        updateStatus('connecting');
      }
      updateError(null); // Clear previous errors
      let lastHttpStatus: number | null = null;
      let lastErr: unknown = null;
      let lastPersonaError: string | null = null;

      try {
        const preferred = normalizeGatewaySeed(activeUrlRef.current || appConfig.gatewayBase || DEFAULT_LOCAL_GATEWAY_BASE);
        const baseCandidates = buildGatewayBaseCandidates(preferred);
        for (const baseUrl of baseCandidates) {
          try {
            const response = await fetch(`${baseUrl}${probePath}`, {
              method: 'GET',
              signal: AbortSignal.timeout(3000),
            });

            if (response.ok) {
              const payload = await response.json().catch(() => null);
              if (payload && typeof payload === 'object') {
                const parsed = payload as LocalGatewayDetails;
                const persona = parseGatewayPersona(parsed);
                if (persona === 'provider-daemon' || persona === 'provider_daemon') {
                  lastPersonaError = 'Endpoint on :8080 is provider-daemon; user-gateway required';
                  continue;
                }
                if (!hasGatewayRouteFamily(parsed)) {
                  lastPersonaError = 'Endpoint on :8080 does not expose gateway routes';
                  continue;
                }
                updateDetails(parsed);
              } else {
                updateDetails(null);
              }
              updateActiveUrl(baseUrl);
              updateStatus('connected');
              return;
            }

            if (response.status !== 404) {
              lastHttpStatus = response.status;
              continue;
            }

            const fallbackPath = probePath === GATEWAY_STATUS_ENDPOINT ? GATEWAY_HEALTH_ENDPOINT : GATEWAY_STATUS_ENDPOINT;
            const healthRes = await fetch(`${baseUrl}${fallbackPath}`, {
              method: 'GET',
              signal: AbortSignal.timeout(3000),
            });
            if (healthRes.ok) {
              probePath = fallbackPath;
              updateActiveUrl(baseUrl);
              updateStatus('connected');
              updateDetails(null);
              return;
            }

            if (healthRes.status !== 404) {
              lastHttpStatus = healthRes.status;
            }
          } catch (candidateErr: unknown) {
            lastErr = candidateErr;
            continue;
          }
        }

        updateStatus('disconnected');
        updateDetails(null);
        if (lastHttpStatus !== null) {
          updateError(`Gateway responded with status: ${lastHttpStatus}`);
          return;
        }
        if (lastPersonaError) {
          updateError(lastPersonaError);
          updateActiveUrl(normalizeGatewaySeed(appConfig.gatewayBase));
          return;
        }
        if (lastErr) {
          const err = lastErr as Error;
          if (err.name === 'AbortError') {
            updateError('Connection timed out');
          } else if (err.message && (err.message.includes('Failed to fetch') || err.message.includes('NetworkError'))) {
            updateError('Could not connect to local gateway');
          } else {
            updateError(err.message || 'Unknown error during connection');
          }
          updateActiveUrl(normalizeGatewaySeed(appConfig.gatewayBase));
          return;
        }

        updateError('Could not connect to local gateway');
        updateActiveUrl(normalizeGatewaySeed(appConfig.gatewayBase));
      } finally {
        inFlight = false;
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          schedule(HIDDEN_POLL_INTERVAL_MS);
        } else {
          schedule(pollInterval);
        }
      }
    };

    // Initial check
    void checkGatewayStatus();

    const handleVisibility = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        void checkGatewayStatus();
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibility);
    }

    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibility);
      }
    };
  }, [pollInterval]); // Re-run effect when poll interval changes

  return { status, url: activeUrl, error, details };
}
