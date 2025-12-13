import { useState } from 'react'
import { useAccount } from 'wagmi'
import { appConfig } from '../config'
import { buildRetrievalReceiptTypedData, RetrievalReceiptIntent } from '../lib/eip712'

export interface FetchInput {
  dealId: string
  manifestRoot: string
  owner: string
  filePath: string
}

export function useFetch() {
  const { address } = useAccount()
  const [loading, setLoading] = useState(false)
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null)

  async function fetchFile(input: FetchInput) {
    setLoading(true)
    setDownloadUrl(null)
    try {
      // 1. Fetch File (Bytes + Headers)
      // Note: input.filePath must be URL encoded if it contains spaces, but URLSearchParams does that.
      const fetchParams = new URLSearchParams({
        deal_id: input.dealId,
        owner: input.owner,
        file_path: input.filePath,
      })
      const fetchUrl = `${appConfig.gatewayBase}/gateway/fetch/${input.manifestRoot}?${fetchParams.toString()}`
      
      const response = await fetch(fetchUrl)
      if (!response.ok) {
        // Try to parse JSON error
        const text = await response.text()
        let errMessage = text
        try {
            const json = JSON.parse(text)
            if (json.error) errMessage = json.error
            if (json.hint) errMessage += ` (${json.hint})`
        } catch {}
        throw new Error(errMessage)
      }

      // 2. Read Headers for Receipt
      const hDealId = response.headers.get('X-Nil-Deal-ID')
      const hEpoch = response.headers.get('X-Nil-Epoch')
      const hProvider = response.headers.get('X-Nil-Provider')
      const hBytes = response.headers.get('X-Nil-Bytes-Served')

      const blob = await response.blob()
      
      // If headers are present and wallet is connected, initiate signing flow.
      if (hDealId && hEpoch && hProvider && hBytes && address) {
          const nonceKey = `nilstore:receiptNonces:${address.toLowerCase()}`
          const currentNonce = Number(window.localStorage.getItem(nonceKey) || '0') || 0
          const nextNonce = currentNonce + 1
          
          const intent: RetrievalReceiptIntent = {
              deal_id: Number(hDealId),
              epoch_id: Number(hEpoch),
              provider: hProvider,
              bytes_served: Number(hBytes),
              nonce: nextNonce,
          }
          
          const typedData = buildRetrievalReceiptTypedData(intent, appConfig.chainId)
          
          const ethereum = (window as any).ethereum
          if (!ethereum) {
              console.warn("No wallet found, skipping retrieval receipt signature")
          } else {
              try {
                  const signature: string = await ethereum.request({
                      method: 'eth_signTypedData_v4',
                      params: [address, JSON.stringify(typedData)],
                  })
                  
                  // 3. Post Receipt
                  // Convert 0x hex signature to Base64 for Go json decoder
                  const sigBytes = hexToBytes(signature)
                  const sigBase64 = bytesToBase64(sigBytes)

                  const receiptPayload = {
                      deal_id: intent.deal_id,
                      epoch_id: intent.epoch_id,
                      provider: intent.provider,
                      bytes_served: intent.bytes_served,
                      nonce: intent.nonce,
                      user_signature: sigBase64,
                      proof_details: null,
                      expires_at: 0
                  }

                  // Async post (fire and forget, or await?)
                  // We await to catch errors, but don't block the UI excessively.
                  await fetch(`${appConfig.gatewayBase}/gateway/receipt`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(receiptPayload)
                  })
                  
                  window.localStorage.setItem(nonceKey, String(nextNonce))
                  console.log("Retrieval receipt submitted successfully")
              } catch (e) {
                  console.error("Failed to sign/submit receipt", e)
                  // Don't fail the download itself
              }
          }
      }

      const url = window.URL.createObjectURL(blob)
      setDownloadUrl(url)
      return url
    } finally {
      setLoading(false)
    }
  }

  return { fetchFile, loading, downloadUrl }
}

function hexToBytes(hex: string): Uint8Array {
    if (hex.startsWith('0x')) hex = hex.slice(2)
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16)
    }
    return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = ''
    const len = bytes.byteLength
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i])
    }
    return window.btoa(binary)
}