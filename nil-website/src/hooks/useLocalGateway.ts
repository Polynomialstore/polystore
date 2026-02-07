// nil-website/src/hooks/useLocalGateway.ts
import { useState, useEffect, useRef } from 'react';
import { appConfig } from '../config';

type GatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface LocalGatewayDetails {
  version?: string;
  git_sha?: string;
  build_time?: string;
  mode?: string;
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
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const HIDDEN_POLL_INTERVAL_MS = 120_000;
const LOCAL_GATEWAY_CONNECTED_KEY = 'nil_local_gateway_connected';

function persistLocalGatewayConnected(connected: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LOCAL_GATEWAY_CONNECTED_KEY, connected ? '1' : '0');
  } catch {
    // best-effort only
  }
}

export function useLocalGateway(pollInterval: number = DEFAULT_POLL_INTERVAL_MS): LocalGatewayInfo {
  const [status, setStatus] = useState<GatewayStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<LocalGatewayDetails | null>(null);
  const statusRef = useRef<GatewayStatus>('disconnected');
  const errorRef = useRef<string | null>(null);
  const detailsRef = useRef<LocalGatewayDetails | null>(null);

  useEffect(() => {
    if (appConfig.gatewayDisabled) {
      setStatus('disconnected');
      setError('Gateway disabled');
      setDetails(null);
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
      try {
        const baseUrl = (appConfig.gatewayBase || 'http://127.0.0.1:8080').replace(/\/$/, '');
        const response = await fetch(`${baseUrl}${probePath}`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });

        if (response.ok) {
          const payload = await response.json().catch(() => null);
          if (payload && typeof payload === 'object') {
            updateDetails(payload as LocalGatewayDetails);
          } else {
            updateDetails(null);
          }
          updateStatus('connected');
          return;
        }

        if (response.status !== 404) {
          updateStatus('disconnected');
          updateError(`Gateway responded with status: ${response.status}`);
          updateDetails(null);
          return;
        }

        const fallbackPath = probePath === GATEWAY_STATUS_ENDPOINT ? GATEWAY_HEALTH_ENDPOINT : GATEWAY_STATUS_ENDPOINT
        const healthRes = await fetch(`${baseUrl}${fallbackPath}`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });
        if (healthRes.ok) {
          probePath = fallbackPath;
          updateStatus('connected');
          updateDetails(null);
        } else {
          updateStatus('disconnected');
          updateError(`Gateway responded with status: ${healthRes.status}`);
          updateDetails(null);
        }
      } catch (e: unknown) {
        updateStatus('disconnected');
        const err = e as Error;
        if (err.name === 'AbortError') {
          updateError('Connection timed out');
        } else if (err.message && err.message.includes('Failed to fetch')) { // Common error for connection refused/unreachable
          updateError('Could not connect to local gateway');
        } else {
          updateError(err.message || 'Unknown error during connection');
        }
        updateDetails(null);
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

  return { status, url: appConfig.gatewayBase, error, details };
}
