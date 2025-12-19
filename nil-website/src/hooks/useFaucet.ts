import { useState } from 'react'
import { ethToNil } from '../lib/address'
import { appConfig } from '../config'

export function useFaucet() {
  const [loading, setLoading] = useState(false)
  const [lastTx, setLastTx] = useState<string | null>(null)
  const [txStatus, setTxStatus] = useState<'idle' | 'pending' | 'confirmed' | 'failed'>('idle')

  async function requestFunds(address: string | undefined) {
    if (!address) return

    setLoading(true)
    setLastTx(null)
    setTxStatus('idle')
    try {
        // Convert to Bech32 if it's an 0x address
        const targetAddress = address.startsWith('0x') ? ethToNil(address) : address

        const response = await fetch(`${appConfig.apiBase}/faucet`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: targetAddress })
        })
        
        if (!response.ok) {
            const err = await response.text()
            throw new Error(err || 'Faucet request failed')
        }
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
