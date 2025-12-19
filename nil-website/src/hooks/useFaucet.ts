import { useState } from 'react'
import { ethToNil } from '../lib/address'
import { appConfig } from '../config'

export function useFaucet() {
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)
  const [txStatus, setTxStatus] = useState<'idle' | 'pending' | 'confirmed' | 'failed'>('idle')
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  async function requestFunds(address: string | undefined) {
    if (!address) return

    setLoading(true)
    setLastTx(null)
    setTxStatus('idle')
    try {
        // Convert to Bech32 if it's an 0x address
        const targetAddress = address.startsWith('0x') ? ethToNil(address) : address

        const maxAttempts = 5
        let lastError: Error | null = null

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const response = await fetch(`${appConfig.apiBase}/faucet`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: targetAddress })
            })

            if (response.ok) {
                const json = await response.json().catch(() => ({}))
                if (json.tx_hash) {
                    setLastTx(json.tx_hash)
                    setTxStatus('pending')
                    const lcd = appConfig.lcdBase
                    if (/localhost|127\.0\.0\.1/i.test(lcd)) {
                        setTimeout(() => setTxStatus('confirmed'), 1500)
                    } else {
                        pollTx(json.tx_hash)
                    }
                }
                return json
            }

            const errText = await response.text().catch(() => '')
            if (response.status === 429) {
                const retryAfter = response.headers.get('retry-after')
                const retrySeconds = retryAfter ? Number.parseFloat(retryAfter) : NaN
                const waitMs = Number.isFinite(retrySeconds)
                  ? Math.max(1000, retrySeconds * 1000)
                  : Math.min(2000 * Math.pow(2, attempt), 30000)
                await delay(waitMs)
                lastError = new Error(errText || 'Faucet rate limit exceeded')
                continue
            }

            throw new Error(errText || 'Faucet request failed')
        }

        if (lastError) throw lastError
        throw new Error('Faucet request failed')
    } catch (e) {
        console.error(e)
        setTxStatus('failed')
        throw e
    } finally {
        setLoading(false)
    }
  }

  async function pollTx(txHash: string) {
    const normalized = String(txHash || '').replace(/^0x/i, '')
    for (let i = 0; i < 30; i++) {
        try {
            const res = await fetch(`${appConfig.lcdBase}/cosmos/tx/v1beta1/txs/${normalized}`)
            if (res.ok) {
                const json = await res.json()
                const code = json?.tx_response?.code
                if (code === 0) {
                    setTxStatus('confirmed')
                    return 'confirmed'
                }
                if (typeof code === 'number' && code !== 0) {
                    setTxStatus('failed')
                    return 'failed'
                }
            }
        } catch (e) {
            console.error('pollTx error', e)
        }
        await new Promise((r) => setTimeout(r, 1000))
    }
    setTxStatus('pending')
    return 'pending'
  }

  return { requestFunds, loading, lastTx, txStatus }
}
