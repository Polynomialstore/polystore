import { useState, useCallback } from 'react';

interface DirectUploadOptions {
  dealId: string;
  manifestRoot: string; // The canonical 0x-prefixed hex string
  providerBaseUrl: string; // Base URL of the Storage Provider (e.g., http://localhost:8080)
}

interface UploadProgress {
  mduIndex: number;
  totalMdus: number;
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
  const { dealId, manifestRoot, providerBaseUrl } = options;
  const [uploadProgress, setUploadProgress] = useState<UploadProgress[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const reset = useCallback(() => {
    setUploadProgress([]);
    setIsUploading(false);
  }, []);

  const uploadMdus = useCallback(async (mdus: { index: number; data: Uint8Array }[]): Promise<boolean> => {
    setIsUploading(true);
    setUploadProgress(
      mdus.map((mdu) => ({
        mduIndex: mdu.index,
        totalMdus: mdus.length,
        status: 'pending',
      })),
    );

    let allSuccessful = true;

    for (const mdu of mdus) {
      setUploadProgress((prev) =>
        prev.map((p) =>
          p.mduIndex === mdu.index ? { ...p, status: 'uploading' } : p,
        ),
      );

      const url = `${providerBaseUrl}/sp/upload_mdu`;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'X-Nil-Deal-ID': dealId,
            'X-Nil-Mdu-Index': String(mdu.index),
            'X-Nil-Manifest-Root': manifestRoot,
            'Content-Type': 'application/octet-stream', // Important for raw binary body
          },
          body: mdu.data,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Upload failed: ${response.status} ${errorText}`);
        }

        setUploadProgress((prev) =>
          prev.map((p) =>
            p.mduIndex === mdu.index ? { ...p, status: 'complete' } : p,
          ),
        );
      } catch (e: unknown) {
        allSuccessful = false;
        const message = e instanceof Error ? e.message : String(e);
        setUploadProgress((prev) =>
          prev.map((p) =>
            p.mduIndex === mdu.index ? { ...p, status: 'error', error: message } : p,
          ),
        );
        console.error(`Error uploading MDU ${mdu.index}:`, e);
      }
    }

    setIsUploading(false);
    return allSuccessful;
  }, [dealId, manifestRoot, providerBaseUrl]);

  return { uploadProgress, isUploading, uploadMdus, reset };
}
