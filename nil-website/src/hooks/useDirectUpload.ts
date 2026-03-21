import { useState, useCallback } from 'react';
import { postSparseArtifact } from '../lib/upload/sparseTransport';

interface DirectUploadOptions {
  dealId: string;
  manifestRoot: string; // The canonical 0x-prefixed hex string
  manifestBlob?: Uint8Array | null; // 128 KiB manifest blob (manifest.bin)
  providerBaseUrl: string; // Base URL of the Storage Provider (e.g., http://localhost:8080)
}

interface UploadProgress {
  kind: 'mdu' | 'manifest';
  label: string;
  mduIndex?: number;
  totalSteps: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

interface DirectUploadResult {
  uploadProgress: UploadProgress[];
  isUploading: boolean;
  uploadMdus: (mdus: { index: number; data: Uint8Array }[]) => Promise<boolean>;
  reset: () => void;
}

export function useDirectUpload(options: DirectUploadOptions): DirectUploadResult {
  const { dealId, manifestRoot, manifestBlob, providerBaseUrl } = options;
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const reset = useCallback(() => {
    setUploadProgress([]);
    setIsUploading(false);
  }, []);

  const uploadMdus = useCallback(async (mdus: { index: number; data: Uint8Array }[]): Promise<boolean> => {
    setIsUploading(true);
    const steps: UploadProgress[] = mdus.map((mdu) => ({
      kind: 'mdu',
      label: `MDU #${mdu.index}`,
      mduIndex: mdu.index,
      totalSteps: mdus.length + 1,
      status: 'pending',
    }))
    steps.push({
      kind: 'manifest',
      label: 'manifest.bin',
      totalSteps: mdus.length + 1,
      status: 'pending',
    })
    setUploadProgress(steps);

    let allSuccessful = true;

    for (const mdu of mdus) {
      setUploadProgress((prev) =>
        prev.map((p) =>
          p.kind === 'mdu' && p.mduIndex === mdu.index ? { ...p, status: 'uploading' } : p,
        ),
      );

      const url = `${providerBaseUrl}/sp/upload_mdu`;

      try {
        const response = await postSparseArtifact({
          url,
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Mdu-Index': String(mdu.index),
            'X-Nil-Manifest-Root': manifestRoot,
            'Content-Type': 'application/octet-stream',
          },
          artifact: {
            kind: 'mdu',
            index: mdu.index,
            bytes: mdu.data,
          },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Upload failed: ${response.status} ${errorText}`);
        }

        setUploadProgress((prev) =>
          prev.map((p) =>
            p.kind === 'mdu' && p.mduIndex === mdu.index ? { ...p, status: 'complete' } : p,
          ),
        );
      } catch (e: unknown) {
        allSuccessful = false;
        const message = e instanceof Error ? e.message : String(e);
        setUploadProgress((prev) =>
          prev.map((p) =>
            p.kind === 'mdu' && p.mduIndex === mdu.index ? { ...p, status: 'error', error: message } : p,
          ),
        );
        console.error(`Error uploading MDU ${mdu.index}:`, e);
      }
    }

    // Upload manifest.bin (required for /gateway/fetch proof generation).
    if (allSuccessful) {
      setUploadProgress((prev) =>
        prev.map((p) => (p.kind === 'manifest' ? { ...p, status: 'uploading' } : p)),
      )

      try {
        if (!manifestBlob || manifestBlob.byteLength === 0) {
          throw new Error('manifest blob missing (re-shard to regenerate)')
        }

        const url = `${providerBaseUrl}/sp/upload_manifest`
        const response = await postSparseArtifact({
          url,
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Manifest-Root': manifestRoot,
            'Content-Type': 'application/octet-stream',
          },
          artifact: {
            kind: 'manifest',
            bytes: manifestBlob,
          },
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(`Upload failed: ${response.status} ${errorText}`)
        }

        setUploadProgress((prev) => prev.map((p) => (p.kind === 'manifest' ? { ...p, status: 'complete' } : p)))
      } catch (e: unknown) {
        allSuccessful = false
        const message = e instanceof Error ? e.message : String(e)
        setUploadProgress((prev) =>
          prev.map((p) => (p.kind === 'manifest' ? { ...p, status: 'error', error: message } : p)),
        )
        console.error('Error uploading manifest.bin:', e)
      }
    }

    setIsUploading(false);
    return allSuccessful;
  }, [dealId, manifestBlob, manifestRoot, providerBaseUrl]);

  return { uploadProgress, isUploading, uploadMdus, reset };
}
