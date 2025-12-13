import { useState } from 'react'
import { appConfig } from '../config'
import { ethToNil } from '../lib/address'
import { gatewayUpload } from '../api/gatewayClient'

export interface UploadResult {
  cid: string
  sizeBytes: number
  fileSizeBytes: number
  allocatedLength?: number
  filename: string
}

export function useUpload() {
  const [loading, setLoading] = useState(false)

  async function upload(
    file: File | null | undefined,
    address: string | undefined,
    opts?: { dealId?: string; maxUserMdus?: number },
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
      return await gatewayUpload(appConfig.gatewayBase, {
        file,
        owner,
        dealId: opts?.dealId,
        maxUserMdus: opts?.maxUserMdus,
      })
    } finally {
      setLoading(false)
    }
  }

  return { upload, loading }
}
