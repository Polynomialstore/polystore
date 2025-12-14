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
  const [receiptStatus, setReceiptStatus] = useState<'idle' | 'submitted' | 'failed'>('idle')
  const [receiptError, setReceiptError] = useState<string | null>(null)

  async function fetchFile(input: FetchInput) {
    setLoading(true)
    setDownloadUrl(null)
    setReceiptStatus('idle')
    setReceiptError(null)
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
      const hProofJson = response.headers.get('X-Nil-Proof-JSON')
      const hProofHash = response.headers.get('X-Nil-Proof-Hash')

      const blob = await response.blob()
      
      // If headers are present and wallet is connected, initiate signing flow.
      if (hDealId && hEpoch && hProvider && hBytes && hProofHash && address) {
          // Always derive receipt nonce from chain state to avoid local drift.
          let lastNonce = 0
          try {
              const nonceRes = await fetch(
                  `${appConfig.lcdBase}/nilchain/nilchain/v1/owners/${encodeURIComponent(input.owner)}/receipt-nonce`,
              )
              if (nonceRes.ok) {
                  const json = await nonceRes.json()
                  lastNonce = Number(json.last_nonce || 0) || 0
              }
          } catch (e) {
              console.warn("Failed to fetch receipt nonce, falling back to 0", e)
          }
          const nextNonce = lastNonce + 1
          
          let proofDetails = null
          if (hProofJson) {
              try {
                  const jsonStr = atob(hProofJson)
                  const json = JSON.parse(jsonStr)
                  if (json.proof_details) {
                      proofDetails = json.proof_details
                  }
              } catch (e) {
                  console.warn("Failed to parse proof details", e)
              }
          }
          
          const intent: RetrievalReceiptIntent = {
              deal_id: Number(hDealId),
              epoch_id: Number(hEpoch),
              provider: hProvider,
              bytes_served: Number(hBytes),
              nonce: nextNonce,
              expires_at: 0,
              proof_hash: hProofHash as `0x${string}`,
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
                      proof_details: proofDetails,
                      proof_hash: intent.proof_hash,
                      expires_at: 0
                  }

                  // Async post (fire and forget, or await?)
                  // We await to catch errors, but don't block the UI excessively.
                  const submitRes = await fetch(`${appConfig.gatewayBase}/gateway/receipt`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(receiptPayload)
                  })
                  if (!submitRes.ok) {
                      const text = await submitRes.text()
                      setReceiptStatus('failed')
                      setReceiptError(text || `receipt submission failed (${submitRes.status})`)
                  } else {
                      setReceiptStatus('submitted')
                      setReceiptError(null)
                  }
              } catch (e) {
                  console.error("Failed to sign/submit receipt", e)
                  setReceiptStatus('failed')
                  setReceiptError(String(e))
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

  return { fetchFile, loading, downloadUrl, receiptStatus, receiptError }
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
