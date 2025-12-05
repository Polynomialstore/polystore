import { createConfig, http, WagmiProvider } from 'wagmi'
import { mainnet, sepolia } from 'wagmi/chains'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { defineChain } from 'viem'
import React from 'react'

// Define the local NilChain network
export const nilChain = defineChain({
  id: 9000, // Standard Ethermint devnet ID, confirm with 'nild status'
  name: 'NilChain Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'Nil',
    symbol: 'NIL',
  },
  rpcUrls: {
    default: { http: ['http://localhost:8545'] },
  },
  blockExplorers: {
    default: { name: 'NilExplorer', url: 'http://localhost:5173' }, // Self-referential for now
  },
})

export const config = createConfig({
  chains: [nilChain, mainnet, sepolia],
  transports: {
    [nilChain.id]: http(),
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
