import { useState } from 'react'
import { appConfig } from '../config'
import { ethToNil } from '../lib/address'

export interface UploadResult {
  cid: string
  sizeBytes: number
  filename: string
}

export function useUpload() {
  const [loading, setLoading] = useState(false)

  async function upload(file: File | null | undefined, address: string | undefined): Promise<UploadResult> {
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

      const res = await fetch(`${appConfig.gatewayBase}/gateway/upload`, {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const txt = await res.text()
        throw new Error(txt || 'Upload failed')
      }
      const json = await res.json()
      return {
        cid: json.cid as string,
        sizeBytes: Number(json.size_bytes ?? json.sizeBytes ?? 0),
        filename: json.filename as string,
      }
    } finally {
      setLoading(false)
    }
  }

  return { upload, loading }
}

