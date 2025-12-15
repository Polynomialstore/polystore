/// <reference types="vite/client" />

interface Window {
  ethereum?: {
    isMetaMask?: boolean
    request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>
    on?: (event: string, callback: (...args: unknown[]) => void) => void
    removeListener?: (event: string, callback: (...args: unknown[]) => void) => void
    selectedAddress?: string
  }
}