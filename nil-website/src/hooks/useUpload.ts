import { useState } from 'react'
import { appConfig } from '../config'
import { ethToNil } from '../lib/address'
import { fetchWithTimeout } from '../lib/http'

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
      const form = new FormData()
      form.append('file', file)
      form.append('owner', owner)
      if (opts?.dealId) {
        form.append('deal_id', String(opts.dealId))
      }
      if (opts?.maxUserMdus) {
        form.append('max_user_mdus', String(opts.maxUserMdus))
      }

      const res = await fetchWithTimeout(
        `${appConfig.gatewayBase}/gateway/upload`,
        { method: 'POST', body: form },
        60_000,
      )
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || 'Upload failed')
      }
      const json = await res.json()
      return {
        cid: json.cid as string,
        sizeBytes: Number(json.size_bytes ?? json.sizeBytes ?? 0),
        fileSizeBytes: Number(json.file_size_bytes ?? json.fileSizeBytes ?? json.size_bytes ?? 0),
        allocatedLength: json.allocated_length !== undefined ? Number(json.allocated_length) : undefined,
        filename: json.filename as string,
      }
    } finally {
      setLoading(false)
    }
  }

  return { upload, loading }
}
