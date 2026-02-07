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

export function useLocalGateway(pollInterval: number = 5000): LocalGatewayInfo {
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
      return;
    }

    const updateStatus = (next: GatewayStatus) => {
      if (statusRef.current === next) return;
      statusRef.current = next;
      setStatus(next);
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

    const checkGatewayStatus = async () => {
      if (inFlight) return;
      inFlight = true;
      if (statusRef.current !== 'connected') {
        updateStatus('connecting');
      }
      updateError(null); // Clear previous errors
      try {
        const baseUrl = (appConfig.gatewayBase || 'http://localhost:8080').replace(/\/$/, '');
        const statusUrl = `${baseUrl}${GATEWAY_STATUS_ENDPOINT}`;
        const response = await fetch(statusUrl, {
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

        const healthRes = await fetch(`${baseUrl}${GATEWAY_HEALTH_ENDPOINT}`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });
        if (healthRes.ok) {
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
      }
    };

    // Initial check
    checkGatewayStatus();

    // Set up polling
    const intervalId = setInterval(checkGatewayStatus, pollInterval);

    // Cleanup
    return () => clearInterval(intervalId);
  }, [pollInterval]); // Re-run effect when poll interval changes

  return { status, url: appConfig.gatewayBase, error, details };
}
