import assert from 'node:assert/strict'
import { test } from 'node:test'
import { retrievalFailureEvidence } from '../tests/utils/retrievalFailureEvidence'

const hash = '0x' + '11'.repeat(32), blockHash = '0x' + '22'.repeat(32)
const transaction = { hash, blockHash, blockNumber: '0x80', from: '0x' + '33'.repeat(20),
  to: '0x' + '44'.repeat(20), input: '0x12345678', gas: '0x10000', value: '0x0' }
const receipt = { transactionHash: hash, blockHash, blockNumber: '0x80', status: '0x0', gasUsed: '0x10000' }
const block = { hash: blockHash, number: '0x80', gasLimit: '0x1c9c380' }

function mockRpc(replies: Record<string, unknown>) {
  const calls: Array<{ method: string; params: any[] }> = []
  const request: typeof fetch = async (_url, init) => {
    assert.ok(init?.signal)
    assert.equal(init.method, 'POST')
    const body = JSON.parse(String(init.body))
    calls.push(body)
    const response = body.method === 'eth_call' ? { error: { code: 3, message: 'execution reverted', data: '0xdeadbeef' } } : { result: replies[body.method] }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...response }))
  }
  return { request, calls }
}
const replies = { eth_getTransactionByHash: transaction, eth_getTransactionReceipt: receipt, eth_getBlockByHash: block }

test('retains matching reverted transaction and bounded historical/current calls, never broadcasts', async () => {
  const { request, calls } = mockRpc(replies)
  const result = await retrievalFailureEvidence(hash, 'http://example.invalid', request)
  assert.deepEqual(result.transaction?.result, transaction)
  assert.deepEqual(result.receipt?.result, receipt)
  assert.deepEqual(result.block?.result, block)
  assert.equal(result.calls.length, 4)
  const replay = calls.filter(c => c.method === 'eth_call')
  assert.deepEqual(replay.map(c => c.params[1]), ['0x7f', '0x80', 'latest', '0x80'])
  assert.deepEqual(replay.map(c => c.params[0].gas), ['0x10000', '0x10000', '0x10000', '0x20000'])
  assert.ok(replay.every(c => c.params[0].data === transaction.input && c.params[0].from === transaction.from))
  assert.deepEqual((result.calls[0] as { error: unknown }).error, { code: 3, message: 'execution reverted', data: '0xdeadbeef' })
  assert.ok(calls.every(c => ['eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_getBlockByHash', 'eth_call'].includes(c.method)))
})

test('missing or mismatched receipt and excessive gas never trigger speculative calls', async () => {
  for (const wrong of [null, { ...receipt, transactionHash: '0x' + '55'.repeat(32) }, { ...receipt, blockNumber: '0x81' }]) {
    const { request, calls } = mockRpc({ ...replies, eth_getTransactionReceipt: wrong })
    assert.equal((await retrievalFailureEvidence(hash, 'http://example.invalid', request)).calls.length, 0)
    assert.equal(calls.length, 2)
  }
  const { request, calls } = mockRpc({ ...replies, eth_getTransactionByHash: { ...transaction, gas: '0xffffffff' } })
  assert.equal((await retrievalFailureEvidence(hash, 'http://example.invalid', request)).calls.length, 0)
  assert.equal(calls.length, 3)
})

test('transport, oversized and malformed responses retain bounded errors without credentials', async () => {
  for (const request of [
    async () => { throw new Error('http://user:secret@example.invalid') },
    async () => new Response('x'.repeat(1024 * 1024 + 1)),
    async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 999, result: transaction })),
  ]) {
    const result = await retrievalFailureEvidence(hash, 'http://example.invalid', request)
    assert.ok(result.transaction?.error)
    assert.equal(result.calls.length, 0)
    assert.ok(!JSON.stringify(result).includes('secret'))
  }
})
