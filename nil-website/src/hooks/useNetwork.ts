import { useSwitchChain } from 'wagmi'
import { appConfig } from '../config'

export function useNetwork() {
  const { switchChainAsync } = useSwitchChain()

  const switchNetwork = async () => {
    try {
      await switchChainAsync({ chainId: appConfig.chainId })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      console.error('Failed to switch network:', e)
      
      // Error code 4902 means the chain has not been added to MetaMask.
      // -32603 is an Internal Error that sometimes wraps 4902 in some wallet versions.
      if (e.code === 4902 || e.message?.includes('Unrecognized chain ID') || e.code === -32603) {
         try {
             // eslint-disable-next-line @typescript-eslint/no-explicit-any
             const ethereum = (window as any).ethereum
             if (!ethereum) throw new Error('No crypto wallet found')

             await ethereum.request({
                 method: 'wallet_addEthereumChain',
                 params: [{
                     chainId: `0x${appConfig.chainId.toString(16)}`,
                     chainName: 'NilChain Local',
                     nativeCurrency: {
                         name: 'AATOM',
                         symbol: 'AATOM',
                         decimals: 18,
                     },
                     rpcUrls: [appConfig.evmRpc],
                     blockExplorerUrls: ['http://localhost:5173'],
                 }],
             })
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
