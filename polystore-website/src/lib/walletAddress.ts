import type { Hex } from 'viem'

interface ResolveActiveEvmAddressInput {
  connectedAddress?: string
  creator?: string
}

export function resolveActiveEvmAddress(input: ResolveActiveEvmAddressInput): Hex {
  const connected = String(input.connectedAddress || '').trim()
  const creator = String(input.creator || '').trim()
  const active = connected || creator

  if (!active.startsWith('0x')) {
    throw new Error('EVM address required')
  }
  if (connected && creator && connected.toLowerCase() !== creator.toLowerCase()) {
    throw new Error('Connected wallet changed. Retry with the active account.')
  }

  return active as Hex
}

