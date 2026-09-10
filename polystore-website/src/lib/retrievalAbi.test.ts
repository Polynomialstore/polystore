import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { encodeFunctionData, type Abi, type Hex } from 'viem'
import { POLYSTORE_PRECOMPILE_ABI, encodeRetrievalV2Data, type RetrievalSessionV2Input, type SponsoredRetrievalSessionInput } from './polystorePrecompile'

async function chainABI(): Promise<Abi> {
  const source = await readFile(new URL('../../../polystorechain/precompiles/polystore/polystore.go', import.meta.url), 'utf8')
  const start = source.indexOf('const polystoreABIJSON = `') + 'const polystoreABIJSON = `'.length
  return JSON.parse(source.slice(start, source.indexOf('`', start))) as Abi
}

test('secured browser encoders match the actual chain v2 overloads including frozen payee', async () => {
  const abi = await chainABI()
  const session: RetrievalSessionV2Input & SponsoredRetrievalSessionInput = {
    dealId: 9007199254740993n, provider: 'nil-assigned', authorizedProofProvider: 'nil-deputy',
    startMduIndex: 65536n, startBlobIndex: 8, blobCount: 2n, expiresAt: 9007199254740993n, nonce: 9007199254740995n,
    manifestRoot: `0x${'ab'.repeat(32)}`, maxTotalFee: 123n, authType: 0, allowlistMerklePath: [], allowlistLeafIndex: 0,
    voucherRedeemer: '', voucherProvider: '', voucherExpiresAt: 0n, voucherNonce: 0n, voucherSignature: '0x',
  }
  for (const method of ['computeRetrievalSessionIds', 'openRetrievalSessions', 'openRetrievalSessionsSponsored'] as const) {
    const selected = abi.filter((entry) => entry.type === 'function' && entry.name === method && 'components' in entry.inputs[0] && entry.inputs[0].components.some((c) => c.name === 'authorizedProofProvider'))
    assert.equal(selected.length, 1)
    assert.equal(encodeRetrievalV2Data(method, [session]), encodeFunctionData({ abi: selected, functionName: method, args: [[session]] }))
  }
})

test('browser mirrors every native v3 method and opening receipt exactly', async () => {
  const names = new Set([
    'proposeDealGenerationV3', 'acceptDealGenerationV3', 'finalizeDealGenerationV3',
    'openRetrievalSessionV3', 'openRetrievalSessionV3Sponsored', 'submitRetrievalSessionProofV3',
    'acknowledgeRetrievalObligationV3', 'refundRetrievalSessionV3', 'RetrievalSessionV3Opened',
  ])
  const select = (abi: Abi) => abi.filter((entry) => 'name' in entry && names.has(entry.name))
  assert.deepEqual(select(POLYSTORE_PRECOMPILE_ABI), select(await chainABI()))

  const proof = {
    ordinal: 0n,
    proof: {
      mduIndex: 2n, mduRootFr: '0x01', manifestOpening: '0x02', rootTableDuCommitment: '0x03',
      rootTableDuMerklePath: ['0x04'], blobCommitment: '0x05', merklePath: ['0x06'],
      blobIndex: 0, zValue: '0x07', yValue: '0x08', kzgOpeningProof: '0x09',
    },
  } as const
  const chain = await chainABI()
  const sessionId = `0x${'11'.repeat(32)}` as Hex
  assert.equal(
    encodeFunctionData({ abi: POLYSTORE_PRECOMPILE_ABI, functionName: 'submitRetrievalSessionProofV3', args: [sessionId, 0, [proof]] }),
    encodeFunctionData({ abi: chain, functionName: 'submitRetrievalSessionProofV3', args: [sessionId, 0, [proof]] }),
  )
})
