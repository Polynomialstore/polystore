import { useState } from 'react'
import { useAccount } from 'wagmi'
import { appConfig } from '../config'
import { buildRetrievalReceiptTypedData, buildRetrievalRequestTypedData, RetrievalReceiptIntent, RetrievalRequestIntent } from '../lib/eip712'
import { planNilfsFileRangeChunks } from '../lib/rangeChunker'

export interface FetchInput {
  dealId: string
  manifestRoot: string
  owner: string
  filePath: string
  rangeStart?: number
  rangeLen?: number
  fileStartOffset?: number
  fileSizeBytes?: number
  mduSizeBytes?: number
  blobSizeBytes?: number
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
      if (!address) {
        throw new Error('Connect a wallet to sign retrieval requests and receipts')
      }
      const ethereum = (window as any).ethereum
      if (!ethereum || typeof ethereum.request !== 'function') {
        throw new Error('Ethereum provider (MetaMask) not available')
      }

      const blobSizeBytes = Number(input.blobSizeBytes || 128 * 1024)
      const wantRangeStart = Number(input.rangeStart || 0)
      const wantRangeLen = Number(input.rangeLen || 0)

      // Always derive receipt nonce from chain state to avoid local drift.
      let lastReceiptNonce = 0
      try {
        const nonceRes = await fetch(
          `${appConfig.lcdBase}/nilchain/nilchain/v1/owners/${encodeURIComponent(input.owner)}/receipt-nonce`,
        )
        if (nonceRes.ok) {
          const json = await nonceRes.json()
          lastReceiptNonce = Number(json.last_nonce || 0) || 0
        }
      } catch (e) {
        console.warn('Failed to fetch receipt nonce, falling back to 0', e)
      }
      let nextReceiptNonce = lastReceiptNonce + 1

      const fetchParams = new URLSearchParams({
        deal_id: input.dealId,
        owner: input.owner,
        file_path: input.filePath,
      })
      const fetchUrl = `${appConfig.gatewayBase}/gateway/fetch/${input.manifestRoot}?${fetchParams.toString()}`

      async function fetchOneRange(rangeStart: number, rangeLen: number): Promise<Uint8Array> {
        // 0) Sign Retrieval Request (authorizes the fetch; does NOT count as receipt)
        const expiresAt = Math.floor(Date.now() / 1000) + 120
        let reqNonce = 0
        try {
          const n = new Uint32Array(1)
          window.crypto.getRandomValues(n)
          reqNonce = Number(n[0] || 0)
        } catch {
          reqNonce = Math.floor(Math.random() * 0xffffffff)
        }
        if (!reqNonce) reqNonce = 1

        const reqIntent: RetrievalRequestIntent = {
          deal_id: Number(input.dealId),
          file_path: input.filePath,
          range_start: Number(rangeStart),
          range_len: Number(rangeLen),
          nonce: reqNonce,
          expires_at: expiresAt,
        }
        const reqTypedData = buildRetrievalRequestTypedData(reqIntent, appConfig.chainId)
        const reqSignature: string = await ethereum.request({
          method: 'eth_signTypedData_v4',
          params: [address, JSON.stringify(reqTypedData)],
        })
        if (typeof reqSignature !== 'string' || !reqSignature.startsWith('0x') || reqSignature.length < 10) {
          throw new Error('wallet returned invalid request signature')
        }

        const reqHeaders: Record<string, string> = {
          'X-Nil-Req-Sig': reqSignature,
          'X-Nil-Req-Nonce': String(reqNonce),
          'X-Nil-Req-Expires-At': String(expiresAt),
          'X-Nil-Req-Range-Start': String(reqIntent.range_start),
          'X-Nil-Req-Range-Len': String(reqIntent.range_len),
        }
        if (reqIntent.range_len > 0) {
          reqHeaders['Range'] = `bytes=${reqIntent.range_start}-${reqIntent.range_start + reqIntent.range_len - 1}`
        }

        const response = await fetch(fetchUrl, { headers: reqHeaders })
        if (!response.ok) {
          const text = await response.text()
          let errMessage = text
          try {
            const json = JSON.parse(text)
            if (json.error) errMessage = json.error
            if (json.hint) errMessage += ` (${json.hint})`
          } catch {}
          throw new Error(errMessage)
        }

        const hDealId = response.headers.get('X-Nil-Deal-ID')
        const hEpoch = response.headers.get('X-Nil-Epoch')
        const hProvider = response.headers.get('X-Nil-Provider')
        const hBytes = response.headers.get('X-Nil-Bytes-Served')
        const hProofJson = response.headers.get('X-Nil-Proof-JSON')
        const hProofHash = response.headers.get('X-Nil-Proof-Hash')
        const hFetchSession = response.headers.get('X-Nil-Fetch-Session')

        const buf = new Uint8Array(await response.arrayBuffer())

        if (!hDealId || !hEpoch || !hProvider || !hBytes || !hProofHash || !hFetchSession) {
          setReceiptStatus('failed')
          setReceiptError('Gateway did not provide receipt headers; cannot submit retrieval receipt.')
          return buf
        }

        let proofDetails: any = null
        if (hProofJson) {
          try {
            const jsonStr = atob(hProofJson)
            const json = JSON.parse(jsonStr)
            if (json.proof_details) {
              proofDetails = json.proof_details
            }
          } catch (e) {
            console.warn('Failed to parse proof details', e)
          }
        }
        if (!proofDetails) {
          setReceiptStatus('failed')
          setReceiptError('Gateway did not provide proof_details; refusing to submit unsigned/unenforced receipt.')
          return buf
        }

        const intent: RetrievalReceiptIntent = {
          deal_id: Number(hDealId),
          epoch_id: Number(hEpoch),
          provider: hProvider,
          bytes_served: Number(hBytes),
          nonce: nextReceiptNonce,
          expires_at: 0,
          proof_hash: hProofHash as `0x${string}`,
        }
        nextReceiptNonce += 1

        const typedData = buildRetrievalReceiptTypedData(intent, appConfig.chainId)
        const signature: string = await ethereum.request({
          method: 'eth_signTypedData_v4',
          params: [address, JSON.stringify(typedData)],
        })
        if (typeof signature !== 'string' || !signature.startsWith('0x') || signature.length < 10) {
          throw new Error('wallet returned invalid signature')
        }
        const sigBytes = hexToBytes(signature)
        if (sigBytes.length !== 65) {
          throw new Error(`wallet returned invalid signature length: ${sigBytes.length}`)
        }
        const sigBase64 = bytesToBase64(sigBytes)

        const receiptPayload = {
          fetch_session: hFetchSession,
          receipt: {
            deal_id: intent.deal_id,
            epoch_id: intent.epoch_id,
            provider: intent.provider,
            bytes_served: intent.bytes_served,
            nonce: intent.nonce,
            user_signature: sigBase64,
            proof_details: proofDetails,
            proof_hash: intent.proof_hash,
            expires_at: 0,
          },
        }

        const submitRes = await fetch(`${appConfig.gatewayBase}/gateway/receipt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(receiptPayload),
        })
        if (!submitRes.ok) {
          const text = await submitRes.text()
          setReceiptStatus('failed')
          setReceiptError(text || `receipt submission failed (${submitRes.status})`)
        } else {
          setReceiptStatus('submitted')
          setReceiptError(null)
        }

        return buf
      }

      // Multi-blob/multi-MDU range fetch: split into multiple signed sub-requests + receipts.
      if (wantRangeLen > 0) {
        const hasMeta =
          typeof input.fileStartOffset === 'number' &&
          typeof input.fileSizeBytes === 'number' &&
          typeof input.mduSizeBytes === 'number' &&
          typeof input.blobSizeBytes === 'number'

        if (!hasMeta && wantRangeLen > blobSizeBytes) {
          throw new Error('range fetch > blob size requires fileStartOffset/fileSizeBytes/mduSizeBytes/blobSizeBytes')
        }

        if (hasMeta) {
          const chunks = planNilfsFileRangeChunks({
            fileStartOffset: input.fileStartOffset!,
            fileSizeBytes: input.fileSizeBytes!,
            rangeStart: wantRangeStart,
            rangeLen: wantRangeLen,
            mduSizeBytes: input.mduSizeBytes!,
            blobSizeBytes: input.blobSizeBytes!,
          })
          if (chunks.length > 1) {
            const parts: Uint8Array[] = []
            for (const c of chunks) {
              parts.push(await fetchOneRange(c.rangeStart, c.rangeLen))
            }
            const full = new Blob(parts, { type: 'application/octet-stream' })
            const url = window.URL.createObjectURL(full)
            setDownloadUrl(url)
            return url
          }
        }
      }

      const blobBytes = await fetchOneRange(wantRangeStart, wantRangeLen)
      const blob = new Blob([blobBytes], { type: 'application/octet-stream' })
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
