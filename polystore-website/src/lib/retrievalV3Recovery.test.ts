import test from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from 'bech32'
import { recoverRetrievalV3Checkpoint } from './retrievalV3Recovery'
import { RETRIEVAL_V3_SETUP, type FrozenGenerationV3, type FrozenSessionV3 } from './retrievalV3'
import type { RetrievalV3CheckpointState } from './retrievalV3Checkpoint'

const address = (n: number) => bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(n)))
const authority = (generation: bigint): FrozenGenerationV3 => ({ chainId: 'test-1', height: 9n, dealId: 7n, generation,
  owner: address(1), dealEnd: 100n, setupDigest: RETRIEVAL_V3_SETUP, providers: Array.from({ length: 12 }, (_, i) => address(i + 2)),
  totalMdus: 4n, witnessMdus: 1n, metadataMdus: 2n, userMdus: 2n, integrityLeafCount: 192n,
  polyfsRoot: `0x${'11'.repeat(32)}`, integrityRoot: `0x${'22'.repeat(32)}`, retrievalPolicyMode: 5 })
const file = { path: 'old.bin', start_offset: 0n, size_bytes: 1024n, flags: 0 }
function session(frozen = authority(2n)): FrozenSessionV3 {
  return { authority: frozen, height: 101n, sessionId: `0x${'33'.repeat(32)}`, contextHash: new Uint8Array(32), planHash: new Uint8Array(32),
    owner: frozen.owner, payer: frozen.owner, fileRecordIndex: 3, file, rangeStart: 0n, rangeLength: 1024n, first: 0n, last: 0n,
    population: 1n, sampleCount: 1n, nonce: 1n, priceDenom: 'stake', pricePerBlob: 1n, baseFee: 1n, completionBurnBps: 0,
    funding: 1, snapshot: 10n, anchor: 11n, firstResponse: 12n, deadline: 90n, dealEnd: 100n,
    obligations: [{ slot: 0, assigned: frozen.providers[0], payee: frozen.providers[0], blobCount: 1n, sampleCount: 1n, lockedFee: 2n }],
    acceptedBitmap: new Uint8Array(1), ackedMask: 0, settledMask: 0, refundedMask: 0, lockedFee: 2n, expired: true,
    context: new Uint8Array() }
}
function checkpoint(bound: boolean): RetrievalV3CheckpointState {
  const frozen = authority(2n)
  return { version: 3, id: 'output', length: 1024n, authority: frozen, fileRecordIndex: 3, file, rangeStart: 0n,
    rangeLength: 1024n, requestRangeStart: null, requestRangeLength: null, requester: frozen.owner,
    session: bound ? session(frozen) : undefined, cursors: {} }
}

test('unbound uncertain open resumes the frozen request before considering a newer generation', async () => {
  const saved = checkpoint(false), newer = authority(3n), calls: string[] = []
  const recovered = await recoverRetrievalV3Checkpoint(saved, {
    open: async (state) => { calls.push(`open:${state.authority.generation}:${state.file.path}`); assert.notDeepEqual(state.authority, newer); return session(state.authority) },
    observe: async () => { throw new Error('must not observe before recovering the open journal') },
    ready: async (value) => value,
    refund: async (value) => ({ ...value, lockedFee: 0n, refundedMask: 1 }),
    persist: (_value, bind) => calls.push(bind ? 'bind' : 'refresh'),
  })
  assert.deepEqual(calls, ['open:2:old.bin', 'bind', 'refresh', 'refresh'])
  assert.equal(recovered.session.lockedFee, 0n)
})

test('expired paid recovery refunds from frozen chain state without metadata or another open', async () => {
  const saved = checkpoint(true), calls: string[] = []
  await recoverRetrievalV3Checkpoint(saved, {
    open: async () => { throw new Error('must not open again') },
    observe: async (value) => { calls.push('observe'); return value },
    ready: async (value) => value,
    refund: async (value) => { calls.push('refund'); return { ...value, lockedFee: 0n, refundedMask: 1 } },
    persist: () => {},
  })
  assert.deepEqual(calls, ['observe', 'refund'])
})
