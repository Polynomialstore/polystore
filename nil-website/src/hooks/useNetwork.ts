import { useSwitchChain } from 'wagmi'
import { appConfig } from '../config'

type EthereumProvider = {
  request?: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>
}

type SwitchNetworkOptions = {
  forceAdd?: boolean
}

function getEthereumProvider(): EthereumProvider | null {
  if (typeof window === 'undefined') return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ethereum = (window as any).ethereum as EthereumProvider | undefined
  return ethereum ?? null
}

export function useNetwork() {
  const { switchChainAsync } = useSwitchChain()

  const addChain = async () => {
    const ethereum = getEthereumProvider()
    if (!ethereum?.request) throw new Error('No crypto wallet found')
    await ethereum.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: `0x${appConfig.chainId.toString(16)}`,
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

  const switchNetwork = async (options?: SwitchNetworkOptions) => {
    const forceAdd = Boolean(options?.forceAdd)
    try {
      if (forceAdd) {
        await addChain()
      }
      await switchChainAsync({ chainId: appConfig.chainId })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      console.error('Failed to switch network:', e)
      
      // Error code 4902 means the chain has not been added to MetaMask.
      // -32603 is an Internal Error that sometimes wraps 4902 in some wallet versions.
      if (e.code === 4902 || e.message?.includes('Unrecognized chain ID') || e.code === -32603) {
         try {
             await addChain()
             // Try switching again after adding
             await switchChainAsync({ chainId: appConfig.chainId })
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
