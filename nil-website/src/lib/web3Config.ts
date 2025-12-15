import { createConfig, http } from 'wagmi'
import { defineChain } from 'viem'
import { injected } from 'wagmi/connectors'
import { appConfig } from '../config'
import { installE2eWallet } from './e2eWallet'

// Define the local NilChain network
export const nilChain = defineChain({
  id: appConfig.chainId,
  name: 'NilChain Local',
  nativeCurrency: {
    decimals: 18,
    name: 'NIL',
    symbol: 'NIL',
  },
  rpcUrls: {
    default: { http: [appConfig.evmRpc] },
  },
  blockExplorers: {
    default: { name: 'NilExplorer', url: 'http://localhost:5173' },
  },
})

installE2eWallet()

export const injectedConnector = injected()

export const config = createConfig({
  chains: [nilChain],
  connectors: [injectedConnector],
  transports: {
    [nilChain.id]: http(appConfig.evmRpc),
  },
})
