import { createConfig, http, WagmiProvider } from 'wagmi'
import { mainnet, sepolia } from 'wagmi/chains'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { defineChain } from 'viem'
import React from 'react'

// Define the local NilChain network
export const nilChain = defineChain({
  id: 262144, // DefaultEVMChainID from nilchaind
  name: 'NilChain Local',
  nativeCurrency: {
    decimals: 18,
    name: 'AATOM',
    symbol: 'AATOM',
  },
  rpcUrls: {
    default: { http: ['http://localhost:8545'] },
  },
  blockExplorers: {
    default: { name: 'NilExplorer', url: 'http://localhost:5173' },
  },
})

export const config = createConfig({
  chains: [nilChain, mainnet, sepolia],
  transports: {
    [nilChain.id]: http('http://localhost:8545'),
    [mainnet.id]: http(),
    [sepolia.id]: http(),
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
