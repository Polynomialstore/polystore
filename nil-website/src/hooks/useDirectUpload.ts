import { useState, useCallback, useMemo } from 'react';
import { createUploadEngine, type PreparedMdu, type UploadProgressStep } from '../lib/upload/engine';
import { createSparseHttpTransportPort } from '../lib/upload/httpTransport';

interface DirectUploadOptions {
  dealId: string;
  manifestRoot: string; // The canonical 0x-prefixed hex string
  manifestBlob?: Uint8Array | null; // 128 KiB manifest blob (manifest.bin)
  manifestBlobFullSize?: number;
  providerBaseUrl: string; // Base URL of the Storage Provider (e.g., http://localhost:8080)
}

interface UploadProgress {
  kind: 'mdu' | 'manifest' | 'shard';
  label: string;
  mduIndex?: number;
  totalSteps: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

interface DirectUploadResult {
  uploadProgress: UploadProgress[];
  isUploading: boolean;
  uploadMdus: (mdus: PreparedMdu[]) => Promise<boolean>;
  reset: () => void;
}

export function useDirectUpload(options: DirectUploadOptions): DirectUploadResult {
  const { dealId, manifestRoot, manifestBlob, manifestBlobFullSize, providerBaseUrl } = options;
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const uploadEngine = useMemo(
    () => createUploadEngine({ transport: createSparseHttpTransportPort() }),
    [],
  )

  const reset = useCallback(() => {
    setUploadProgress([]);
    setIsUploading(false);
  }, []);

  const handleProgress = useCallback((steps: UploadProgressStep[]) => {
    setUploadProgress(
      steps.map((step) => ({
        kind: step.kind,
        label: step.label,
        mduIndex: step.index,
        totalSteps: step.totalSteps,
        status: step.status,
        error: step.error,
      })),
    )
  }, [])

  const uploadMdus = useCallback(async (mdus: PreparedMdu[]): Promise<boolean> => {
    setIsUploading(true);
    try {
      const result = await uploadEngine.uploadDirect({
        dealId,
        manifestRoot,
        manifestBlob,
        manifestBlobFullSize,
        mdus,
        target: {
          baseUrl: providerBaseUrl,
          mduPath: '/sp/upload_mdu',
          manifestPath: '/sp/upload_manifest',
          label: providerBaseUrl,
        },
        onProgress: handleProgress,
      })
      return result.ok
    } finally {
      setIsUploading(false);
    }
  }, [dealId, handleProgress, manifestBlob, manifestBlobFullSize, manifestRoot, providerBaseUrl, uploadEngine]);

  return { uploadProgress, isUploading, uploadMdus, reset };
}
