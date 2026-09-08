import { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Web3Provider } from '../../src/context/Web3Provider'
import { TransportProvider } from '../../src/context/TransportContext'
import { useFetch, type FetchInput } from '../../src/hooks/useFetch'

// Test driver for the existing explicit deputy API; all wallet, chain, worker,
// provider and settlement operations still use the production hook.
export async function retrieveWithDeputy(input: FetchInput): Promise<{ bytes: number; sha256: string }> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    return await new Promise((resolve, reject) => {
      function Retrieval() {
        const { fetchFile, unavailableReason } = useFetch()
        const started = useRef(false)
        useEffect(() => {
          if (started.current || unavailableReason) return
          started.current = true
          void fetchFile(input).then(async ({ blob }) => {
            const bytes = await blob.arrayBuffer()
            const digest = await crypto.subtle.digest('SHA-256', bytes)
            resolve({ bytes: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('') })
          }).catch(reject)
        }, [fetchFile, unavailableReason])
        return null
      }
      root.render(<Web3Provider><TransportProvider><Retrieval /></TransportProvider></Web3Provider>)
    })
  } finally {
    root.unmount()
    element.remove()
  }
}
