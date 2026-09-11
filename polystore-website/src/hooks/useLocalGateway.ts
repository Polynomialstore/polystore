// polystore-website/src/hooks/useLocalGateway.ts
import { useState, useEffect, useRef } from 'react';
import { appConfig } from '../config';
import { isTrustedLocalGatewayBase } from '../lib/transport/mode';
import { persistLocalGatewayConnection, persistLocalGatewayLiveness } from '../lib/retrievalMode';

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

function parsePaymentEligibleStatus(payload: unknown): LocalGatewayDetails | null {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const details = payload as LocalGatewayDetails;
  if (details.persona !== 'user-gateway') return null;
  if (!Array.isArray(details.allowed_route_families) || !details.allowed_route_families.includes('gateway')) return null;
  return details;
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
      persistLocalGatewayConnection();
      return;
    }

    // Reset to disconnected on each hook initialization; a successful probe flips this back to connected.
    persistLocalGatewayConnection();

    const updateStatus = (next: GatewayStatus) => {
      if (statusRef.current === next) return;
      statusRef.current = next;
      setStatus(next);
      if (next !== 'connected') persistLocalGatewayConnection();
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
    let disposed = false;
    let probeController: AbortController | null = null;
    let timer: number | null = null;
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
      probeController = new AbortController();
      if (statusRef.current !== 'connected') {
        updateStatus('connecting');
      }
      updateError(null); // Clear previous errors
      let lastHttpStatus: number | null = null;
      let lastErr: unknown = null;
      let lastQualificationError: string | null = null;
      let healthOnlyBase: string | null = null;

      try {
        const preferred = normalizeGatewaySeed(activeUrlRef.current || appConfig.gatewayBase || DEFAULT_LOCAL_GATEWAY_BASE);
        const baseCandidates = buildGatewayBaseCandidates(preferred);
        for (const baseUrl of baseCandidates) {
          try {
            const response = await fetch(`${baseUrl}${GATEWAY_STATUS_ENDPOINT}`, {
              method: 'GET',
              redirect: 'error',
              signal: AbortSignal.any([probeController.signal, AbortSignal.timeout(3000)]),
            });
            if (disposed) return;

            if (response.ok) {
              const payload = await response.json().catch(() => null);
              if (disposed) return;
              const parsed = parsePaymentEligibleStatus(payload);
              if (!parsed) {
                lastQualificationError = 'Endpoint does not identify a user-gateway with gateway routes';
                continue;
              }
              updateDetails(parsed);
              updateActiveUrl(baseUrl);
              persistLocalGatewayConnection(baseUrl);
              updateStatus('connected');
              return;
            }

            if (response.status !== 404) {
              lastHttpStatus = response.status;
              continue;
            }

            const healthRes = await fetch(`${baseUrl}${GATEWAY_HEALTH_ENDPOINT}`, {
              method: 'GET',
              redirect: 'error',
              signal: AbortSignal.any([probeController.signal, AbortSignal.timeout(3000)]),
            });
            if (disposed) return;
            if (healthRes.ok) {
              healthOnlyBase ||= baseUrl;
              continue;
            }

            if (healthRes.status !== 404) {
              lastHttpStatus = healthRes.status;
            }
          } catch (candidateErr: unknown) {
            lastErr = candidateErr;
            continue;
          }
        }

        if (disposed) return;
        if (healthOnlyBase) {
          persistLocalGatewayLiveness();
          updateActiveUrl(healthOnlyBase);
          updateStatus('connected');
          updateDetails(null);
          return;
        }
        persistLocalGatewayConnection();
        updateStatus('disconnected');
        updateDetails(null);
        if (lastHttpStatus !== null) {
          updateError(`Gateway responded with status: ${lastHttpStatus}`);
          return;
        }
        if (lastQualificationError) {
          updateError(lastQualificationError);
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
        probeController = null;
        if (!disposed) {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            schedule(HIDDEN_POLL_INTERVAL_MS);
          } else {
            schedule(pollInterval);
          }
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
      disposed = true;
      probeController?.abort();
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
