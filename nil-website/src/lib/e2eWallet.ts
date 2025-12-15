import { numberToHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Hex } from 'viem'

import { appConfig } from '../config'

type Eip1193RequestArgs = {
  method: string
  params?: unknown[] | Record<string, unknown>
}

type Listener = (...args: unknown[]) => void

const DEFAULT_E2E_PK =
  '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113b37a2b2d6f6fcf7e9f59b5f1' as const

export function installE2eWallet() {
  if (typeof window === 'undefined') return
  if (import.meta.env.VITE_E2E !== '1') return

  if (window.ethereum) return

  const privKey = (import.meta.env.VITE_E2E_PK || DEFAULT_E2E_PK) as Hex
  const account = privateKeyToAccount(privKey)
  const chainIdHex = numberToHex(appConfig.chainId)

  const listeners = new Map<string, Set<Listener>>()
  const on = (event: string, listener: Listener) => {
    const set = listeners.get(event) ?? new Set<Listener>()
    set.add(listener)
    listeners.set(event, set)
  }
  const removeListener = (event: string, listener: Listener) => {
    const set = listeners.get(event)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) listeners.delete(event)
  }

  window.ethereum = {
    isMetaMask: true,
    // isNilStoreE2E: true, // Not in interface, might error? It's fine if interface allows excess checks or we cast.
    // The interface I added doesn't have isNilStoreE2E. But TS allows extra props on object literals usually? 
    // No, strictly typed interface. I might need to extend it or cast `window.ethereum` assignment.
    // Or add isNilStoreE2E to vite-env.d.ts?
    // I'll add it to vite-env.d.ts.
    selectedAddress: account.address,

    on,
    removeListener,

    async request(args: Eip1193RequestArgs) {
      const method = args?.method
      const params = args?.params

      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [account.address]

        case 'eth_chainId':
          return chainIdHex

        case 'net_version':
          return String(appConfig.chainId)

        case 'wallet_addEthereumChain':
          return null

        case 'wallet_switchEthereumChain': {
          const requested = (params as Array<{ chainId: string }>)?.[0]?.chainId
          if (!requested || String(requested).toLowerCase() === chainIdHex.toLowerCase()) return null
          const err = new Error(`Unrecognized chain ID ${requested}`) as Error & { code: number }
          err.code = 4902
          throw err
        }

        case 'eth_signTypedData_v4': {
          const [from, typedDataJson] = (params as [string, string]) ?? []
          if (!from || String(from).toLowerCase() !== account.address.toLowerCase()) {
            throw new Error(`unknown signer ${from}`)
          }
          const parsed = JSON.parse(String(typedDataJson))
          const viemTypedData = {
            ...parsed,
            domain: { ...parsed.domain, chainId: BigInt(parsed.domain?.chainId ?? appConfig.chainId) },
          }
          return account.signTypedData(viemTypedData)
        }

        default:
          throw new Error(`E2E wallet does not support method: ${method}`)
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any // Cast to any to bypass exact shape check if needed, or better, match interface.
  // I'll cast to any for assignment to allow extra props like isNilStoreE2E without modifying vite-env again.
}

