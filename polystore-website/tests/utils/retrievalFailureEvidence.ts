// Read-only evidence for one failed transaction. Never resend or replace it.
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_CALL_GAS = 30_000_000n
const quantity = (value: unknown): value is string => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
const hex = (value: bigint) => `0x${value.toString(16)}`

type Reply = { result?: any; error?: unknown }
export async function retrievalFailureEvidence(hash: string, endpoint: string, request: typeof fetch = fetch) {
  const evidence: { hash: string; transaction?: Reply; receipt?: Reply; block?: Reply; calls: unknown[]; limitation: string } = {
    hash, calls: [], limitation: 'Diagnostic calls replay state at the selected block; they do not prove the original revert cause.',
  }
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) return evidence
  const deadline = AbortSignal.timeout(15_000)
  let id = 0
  const rpc = async (method: string, params: unknown[]): Promise<Reply> => {
    const requestId = ++id
    try {
      const response = await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
        signal: AbortSignal.any([deadline, AbortSignal.timeout(3000)]),
      })
      if (!response.ok || !response.body) return { error: { httpStatus: response.status } }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return { error: 'response exceeds 1 MiB' } }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body.jsonrpc !== '2.0' || body.id !== requestId || ('result' in body) === ('error' in body)) return { error: 'malformed JSON-RPC response' }
      return 'error' in body ? { error: body.error } : { result: body.result }
    } catch (error) {
      // Transport errors can contain credential-bearing URLs. Retain only their type.
      return { error: error instanceof Error ? error.name : 'request failed' }
    }
  }
  ;[evidence.transaction, evidence.receipt] = await Promise.all([
    rpc('eth_getTransactionByHash', [hash]), rpc('eth_getTransactionReceipt', [hash]),
  ])
  const tx = evidence.transaction.result, receipt = evidence.receipt.result
  if (tx?.hash?.toLowerCase() !== hash.toLowerCase() || receipt?.transactionHash?.toLowerCase() !== hash.toLowerCase() ||
      !quantity(receipt.blockNumber) || BigInt(receipt.blockNumber) === 0n || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) return evidence
  evidence.block = await rpc('eth_getBlockByHash', [receipt.blockHash, false])
  const block = evidence.block.result
  if (block?.hash !== receipt.blockHash || block?.number !== receipt.blockNumber || !quantity(block.gasLimit) ||
      !quantity(tx.gas) || !quantity(tx.value) || BigInt(tx.gas) > MAX_CALL_GAS ||
      !/^0x[0-9a-f]{40}$/i.test(tx.from) || !/^0x[0-9a-f]{40}$/i.test(tx.to) ||
      typeof tx.input !== 'string' || tx.input.length > 262146 || !/^0x(?:[0-9a-f]{2})*$/i.test(tx.input)) return evidence
  const call = { from: tx.from, to: tx.to, data: tx.input, value: tx.value, gas: tx.gas }
  const largerGas = [BigInt(tx.gas) * 2n, BigInt(block.gasLimit), MAX_CALL_GAS].reduce((a, b) => a < b ? a : b)
  const cases = [
    { blockTag: hex(BigInt(receipt.blockNumber) - 1n), gas: tx.gas },
    { blockTag: receipt.blockNumber, gas: tx.gas },
    { blockTag: 'latest', gas: tx.gas },
    ...(largerGas > BigInt(tx.gas) ? [{ blockTag: receipt.blockNumber, gas: hex(largerGas) }] : []),
  ]
  // Sequential calls avoid piling diagnostic EVM work onto the failed stack.
  for (const row of cases) {
    if (deadline.aborted) break
    evidence.calls.push({ ...row, ...await rpc('eth_call', [{ ...call, gas: row.gas }, row.blockTag]) })
  }
  return evidence
}
