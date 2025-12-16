// nil-website/src/hooks/useLocalGateway.ts
import { useState, useEffect, useRef } from 'react';

type GatewayStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface LocalGatewayInfo {
  status: GatewayStatus;
  url: string;
  error: string | null;
}

const DEFAULT_LOCAL_GATEWAY_URL = 'http://localhost:8080';
const GATEWAY_HEALTH_ENDPOINT = '/health'; // Assuming a /health endpoint exists

export function useLocalGateway(pollInterval: number = 5000): LocalGatewayInfo {
  const [status, setStatus] = useState<GatewayStatus>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef<number>(pollInterval); // Use ref for stable poll interval

  useEffect(() => {
    const checkGatewayStatus = async () => {
      setStatus('connecting');
      setError(null); // Clear previous errors
      try {
        const response = await fetch(`${DEFAULT_LOCAL_GATEWAY_URL}${GATEWAY_HEALTH_ENDPOINT}`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000) // Timeout after 3 seconds
        });

        if (response.ok) {
          setStatus('connected');
        } else {
          setStatus('disconnected');
          setError(`Gateway responded with status: ${response.status}`);
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
      }
    };

    // Initial check
    checkGatewayStatus();

    // Set up polling
    const intervalId = setInterval(checkGatewayStatus, pollIntervalRef.current);

    // Cleanup
    return () => clearInterval(intervalId);
  }, [pollIntervalRef]); // Dependency array to re-run effect if pollInterval changes

  return { status, url: DEFAULT_LOCAL_GATEWAY_URL, error };
}
