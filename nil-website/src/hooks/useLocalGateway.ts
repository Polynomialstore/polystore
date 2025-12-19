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
  const pollIntervalRef = useRef<number>(pollInterval); // Use ref for stable poll interval

  useEffect(() => {
    if (appConfig.gatewayDisabled) {
      setStatus('disconnected');
      setError('Gateway disabled');
      setDetails(null);
      return;
    }
    const checkGatewayStatus = async () => {
      setStatus('connecting');
      setError(null); // Clear previous errors
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
            setDetails(payload as LocalGatewayDetails);
          } else {
            setDetails(null);
          }
          setStatus('connected');
          return;
        }

        if (response.status !== 404) {
          setStatus('disconnected');
          setError(`Gateway responded with status: ${response.status}`);
          setDetails(null);
          return;
        }

        const healthRes = await fetch(`${baseUrl}${GATEWAY_HEALTH_ENDPOINT}`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        });
        if (healthRes.ok) {
          setStatus('connected');
          setDetails(null);
        } else {
          setStatus('disconnected');
          setError(`Gateway responded with status: ${healthRes.status}`);
          setDetails(null);
        }
      } catch (e: unknown) {
        setStatus('disconnected');
        const err = e as Error;
        if (err.name === 'AbortError') {
            setError('Connection timed out');
        } else if (err.message && err.message.includes('Failed to fetch')) { // Common error for connection refused/unreachable
            setError('Could not connect to local gateway');
        } else {
            setError(err.message || 'Unknown error during connection');
        }
        setDetails(null);
      }
    };

    // Initial check
    checkGatewayStatus();

    // Set up polling
    const intervalId = setInterval(checkGatewayStatus, pollIntervalRef.current);

    // Cleanup
    return () => clearInterval(intervalId);
  }, [pollIntervalRef]); // Dependency array to re-run effect if pollInterval changes

  return { status, url: appConfig.gatewayBase, error, details };
}
