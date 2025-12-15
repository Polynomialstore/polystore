import type { Hex } from 'viem'
import { appConfig } from '../config'

type JsonRpcError = { code?: number; message: string; data?: unknown }

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(appConfig.evmRpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = (await res.json().catch(() => null)) as { result?: T; error?: JsonRpcError } | null
  if (!res.ok) {
    throw new Error(`EVM RPC HTTP ${res.status}`)
  }
  if (!json) {
    throw new Error('EVM RPC returned invalid JSON')
  }
  if (json.error) {
    throw new Error(json.error.message || 'EVM RPC error')
  }
  return json.result as T
}

export type TransactionReceipt = {
  transactionHash: Hex
  status?: Hex
  logs?: Array<{ address: Hex; topics: Hex[]; data: Hex }>
}

export async function waitForTransactionReceipt(
  txHash: Hex,
  { timeoutMs = 90_000, pollMs = 750 }: { timeoutMs?: number; pollMs?: number } = {},
): Promise<TransactionReceipt> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const receipt = await rpc<TransactionReceipt | null>('eth_getTransactionReceipt', [txHash])
    if (receipt) {
      const status = String(receipt.status || '').toLowerCase()
      if (status === '0x0') {
        throw new Error('transaction reverted')
      }
      return receipt
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error('Timed out waiting for transaction receipt')
}
