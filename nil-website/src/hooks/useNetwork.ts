import { useSwitchChain } from 'wagmi'
import { appConfig } from '../config'

type EthereumProvider = {
  request?: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>
}

type SwitchNetworkOptions = {
  forceAdd?: boolean
}

type ProviderRpcError = {
  code?: number
  message?: string
}

function getEthereumProvider(): EthereumProvider | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ethereum = (window as any).ethereum as EthereumProvider | undefined
  return ethereum ?? null
}

function toChainHex(chainId: number): string {
  return `0x${chainId.toString(16)}`
}

function isUnknownChainError(error: unknown): boolean {
  const e = error as ProviderRpcError | undefined
  if (!e) return false
  if (e.code === 4902 || e.code === -32603) return true
  const message = String(e.message ?? '')
  return message.includes('Unrecognized chain ID') || message.includes('unknown chain')
}

function isAlreadyExistsError(error: unknown): boolean {
  const e = error as ProviderRpcError | undefined
  if (!e) return false
  const message = String(e.message ?? '').toLowerCase()
  return message.includes('already exists') || message.includes('may not specify default chain')
}

export function useNetwork() {
  const { switchChainAsync } = useSwitchChain()

  const addChain = async () => {
    const ethereum = getEthereumProvider()
    if (!ethereum?.request) throw new Error('No crypto wallet found')
    await ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: toChainHex(appConfig.chainId),
        chainName: 'NilStore Devnet',
        nativeCurrency: {
          name: 'NIL',
          symbol: 'NIL',
          decimals: 18,
        },
        rpcUrls: [appConfig.evmRpc],
        blockExplorerUrls: [appConfig.explorerBase],
      }],
    })
  }

  const switchWithProvider = async () => {
    const ethereum = getEthereumProvider()
    if (!ethereum?.request) throw new Error('No crypto wallet found')
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: toChainHex(appConfig.chainId) }],
    })
  }

  const switchNetwork = async (options?: SwitchNetworkOptions) => {
    const forceAdd = Boolean(options?.forceAdd)
    try {
      if (forceAdd) {
        try {
          await addChain()
        } catch (e) {
          if (!isAlreadyExistsError(e)) throw e
        }
      }
      await switchWithProvider()
      // Keep wagmi state synchronized with wallet chain state.
      try {
        await switchChainAsync({ chainId: appConfig.chainId })
      } catch {
        // Non-fatal: wallet may already be on target chain and wagmi can no-op/error.
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      console.error('Failed to switch network:', e)
      
      if (isUnknownChainError(e)) {
         try {
             await addChain()
             await switchWithProvider()
             try {
               await switchChainAsync({ chainId: appConfig.chainId })
             } catch {
               // Non-fatal wagmi sync error.
             }
         } catch (addError) {
             console.error('Failed to add network:', addError)
             throw addError
         }
      } else {
          throw e
      }
    }
  }

  return { switchNetwork }
}
