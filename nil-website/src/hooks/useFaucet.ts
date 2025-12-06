import { useState } from 'react'
import { ethToNil } from '../lib/address'
import { appConfig } from '../config'

export function useFaucet() {
  const [loading, setLoading] = useState(false)

  async function requestFunds(address: string | undefined) {
    if (!address) return

    setLoading(true)
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
        
        return true
    } catch (e) {
        console.error(e)
        throw e
    } finally {
        setLoading(false)
    }
  }

  return { requestFunds, loading }
}
