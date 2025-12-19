import { useState } from 'react'
import { ethToNil } from '../lib/address'
import { useTransportRouter } from './useTransportRouter'

export interface UploadResult {
  cid: string
  sizeBytes: number
  fileSizeBytes: number
  allocatedLength?: number
  filename: string
}

export function useUpload() {
  const [loading, setLoading] = useState(false)
  const transport = useTransportRouter()

  async function upload(
    file: File | null | undefined,
    address: string | undefined,
    opts?: { dealId?: string; maxUserMdus?: number; directBase?: string },
  ): Promise<UploadResult> {
    if (!file) {
      throw new Error('No file selected')
    }
    if (!address) {
      throw new Error('Wallet not connected')
    }

    setLoading(true)
    try {
      const owner = address.startsWith('0x') ? ethToNil(address) : address
      const result = await transport.uploadFile({
        file,
        owner,
        dealId: opts?.dealId,
        maxUserMdus: opts?.maxUserMdus,
        directBase: opts?.directBase,
      })
      return result.data
    } finally {
      setLoading(false)
    }
  }

  return { upload, loading }
}
