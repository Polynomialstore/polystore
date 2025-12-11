import { useState, useEffect, useRef } from 'react';

type WorkerStatus = 'idle' | 'initializing' | 'ready' | 'processing' | 'error';

export function useFileSharder() {
    const [status, setStatus] = useState<WorkerStatus>('idle');
    const [error, setError] = useState<string | null>(null);
    const workerRef = useRef<Worker | null>(null);

    useEffect(() => {
        // Initialize Worker
        const worker = new Worker(new URL('../workers/mduWorker.ts', import.meta.url), {
            type: 'module',
        });

        worker.onmessage = (e) => {
            const { type, payload } = e.data;
            if (type === 'INIT_SUCCESS') {
                setStatus('ready');
            } else if (type === 'ERROR') {
                setStatus('error');
                setError(payload);
            }
        };

        workerRef.current = worker;

        // Cleanup
        return () => worker.terminate();
    }, []);

    const initWasm = async (trustedSetupUrl: string) => {
        if (status !== 'idle') return;
        setStatus('initializing');
        
        try {
            const res = await fetch(trustedSetupUrl);
            if (!res.ok) throw new Error('Failed to fetch trusted setup');
            const buffer = await res.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            
            workerRef.current?.postMessage({ type: 'INIT', payload: bytes });
        } catch (e: any) {
            setStatus('error');
            setError(e.message);
        }
    };

    const expandMdu = (data: Uint8Array): Promise<any> => {
        return new Promise((resolve, reject) => {
            if (status !== 'ready' || !workerRef.current) {
                reject(new Error('Worker not ready'));
                return;
            }

            const handler = (e: MessageEvent) => {
                const { type, payload } = e.data;
                if (type === 'EXPAND_SUCCESS') {
                    setStatus('ready');
                    workerRef.current?.removeEventListener('message', handler);
                    resolve(payload);
                } else if (type === 'ERROR') {
                    setStatus('error');
                    setError(payload);
                    workerRef.current?.removeEventListener('message', handler);
                    reject(new Error(payload));
                }
            };

            setStatus('processing');
            workerRef.current.addEventListener('message', handler);
            workerRef.current.postMessage({ type: 'EXPAND', payload: data });
        });
    };

    return { status, error, initWasm, expandMdu };
}
