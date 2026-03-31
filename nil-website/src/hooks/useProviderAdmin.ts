import { useState } from 'react'
import { useAccount, useWalletClient } from 'wagmi'
import type { Hex } from 'viem'

import { appConfig } from '../config'
import {
  providerAdminRefreshStatus,
  providerAdminRotateEndpoint,
  providerAdminRunDoctor,
  type ProviderAdminResponse,
} from '../api/providerClient'
import {
  buildProviderAdminRequestEnvelope,
  buildProviderAdminTypedData,
  createProviderAdminExpiry,
  createProviderAdminNonce,
  type ProviderAdminActionName,
} from '../lib/providerAdmin'
import { resolveActiveEvmAddress } from '../lib/walletAddress'
import { classifyWalletError } from '../lib/walletErrors'

interface ProviderAdminInput {
  providerBase: string
  provider: string
  endpoint?: string | null
  creator?: string
}

export function useProviderAdmin() {
  const { address: connectedAddress } = useAccount()
  const { data: walletClient } = useWalletClient()
  const [pendingAction, setPendingAction] = useState<ProviderAdminActionName | null>(null)

  async function signRequest(
    action: ProviderAdminActionName,
    input: ProviderAdminInput,
  ) {
    if (!walletClient) {
      throw new Error('Wallet not connected')
    }
    const provider = String(input.provider || '').trim()
    if (!provider) {
      throw new Error('provider is required')
    }

    const endpoint = String(input.endpoint || '').trim()
    const nonce = createProviderAdminNonce()
    const expiresAt = createProviderAdminExpiry()
    const typedData = buildProviderAdminTypedData({
      provider,
      action,
      endpoint,
      nonce,
      expiresAt,
      chainId: appConfig.chainId,
    }) as {
      domain: {
        name: string
        version: string
        chainId: number
        verifyingContract: Hex
      }
      types: Record<string, readonly { name: string; type: string }[]>
      primaryType: 'ProviderAdminAction'
      message: Record<string, unknown>
    }
    const account = resolveActiveEvmAddress({ connectedAddress, creator: input.creator })
    const signature = await walletClient.signTypedData({
      account: account as Hex,
      domain: {
        ...typedData.domain,
        chainId: BigInt(typedData.domain.chainId),
      },
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    })

    return buildProviderAdminRequestEnvelope({
      provider,
      action,
      endpoint,
      nonce,
      expiresAt,
      signature,
    })
  }

  async function execute<T extends ProviderAdminResponse>(
    action: ProviderAdminActionName,
    input: ProviderAdminInput,
    runner: (providerBase: string, body: ReturnType<typeof buildProviderAdminRequestEnvelope>) => Promise<T>,
  ): Promise<T> {
    setPendingAction(action)
    try {
      const providerBase = String(input.providerBase || '').trim().replace(/\/$/, '')
      if (!providerBase) {
        throw new Error('providerBase is required')
      }
      const body = await signRequest(action, input)
      return await runner(providerBase, body)
    } catch (error) {
      const walletError = classifyWalletError(error)
      if (walletError.reconnectSuggested) {
        throw new Error(walletError.message)
      }
      throw error
    } finally {
      setPendingAction(null)
    }
  }

  return {
    pendingAction,
    refreshStatus(input: ProviderAdminInput) {
      return execute('status_refresh', input, providerAdminRefreshStatus)
    },
    runDoctor(input: ProviderAdminInput) {
      return execute('run_doctor', input, providerAdminRunDoctor)
    },
    rotateEndpoint(input: ProviderAdminInput) {
      return execute('rotate_endpoint', input, providerAdminRotateEndpoint)
    },
  }
}
