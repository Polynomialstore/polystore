import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { injectedWallet } from '@rainbow-me/rainbowkit/wallets'
import { http } from 'wagmi'
import { defineChain } from 'viem'
import { appConfig } from '../config'
import { installE2eWallet } from './e2eWallet'

// Define the local NilChain network
export const nilChain = defineChain({
  id: appConfig.chainId,
  name: 'PolyStore Devnet',
  nativeCurrency: {
    decimals: 18,
    name: 'NIL',
    symbol: 'NIL',
  },
  rpcUrls: {
    default: { http: [appConfig.evmRpc] },
  },
  blockExplorers: {
    default: { name: 'PolyStore Explorer', url: appConfig.explorerBase },
  },
})

installE2eWallet()

const walletConnectProjectId = appConfig.walletConnectProjectId || '00000000000000000000000000000000'

export const config = getDefaultConfig({
  appName: 'PolyStore',
  projectId: walletConnectProjectId,
  chains: [nilChain],
  wallets: [
    {
      groupName: 'Wallets',
      wallets: [injectedWallet],
    },
  ],
  transports: {
    [nilChain.id]: http(appConfig.evmRpc),
  },
})
