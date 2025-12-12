import { createConfig, http, WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { defineChain } from 'viem'
import { injected } from 'wagmi/connectors'
import React from 'react'
import { appConfig } from '../config'

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

export const injectedConnector = injected()

export const config = createConfig({
  chains: [nilChain],
  connectors: [injectedConnector],
  transports: {
    [nilChain.id]: http(appConfig.evmRpc),
  },
})

const queryClient = new QueryClient()

export function Web3Provider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
