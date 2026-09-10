import test from 'node:test'
import assert from 'node:assert/strict'
import { bech32 } from 'bech32'
import { readRetrievalV3Checkpoint, type RetrievalV3CheckpointState } from './retrievalV3Checkpoint'
import { RETRIEVAL_V3_SETUP, type FrozenSessionV3 } from './retrievalV3'
import type { RetrievalStore } from './retrievalTransactions'

const address = (n: number) => bech32.encode('nil', bech32.toWords(new Uint8Array(20).fill(n)))
function store(value: RetrievalV3CheckpointState): RetrievalStore {
  return { get: <T>() => structuredClone(value) as T, put() {}, remove() {} }
}
function state(): RetrievalV3CheckpointState {
  const providers = Array.from({ length: 12 }, (_, i) => address(i + 2)), length = 65n * 126_976n
  const authority = { chainId: 'test-1', height: 9n, dealId: 7n, generation: 2n, owner: address(1), dealEnd: 100n,
    setupDigest: RETRIEVAL_V3_SETUP, providers, totalMdus: 4n, witnessMdus: 1n, metadataMdus: 2n, userMdus: 2n,
    integrityLeafCount: 192n, polyfsRoot: `0x${'11'.repeat(32)}` as const, integrityRoot: `0x${'22'.repeat(32)}` as const, retrievalPolicyMode: 5 as const }
  const file = { path: 'file.bin', start_offset: 0n, size_bytes: length, flags: 0 }
  const session = { authority, height: 12n, sessionId: `0x${'33'.repeat(32)}`, contextHash: new Uint8Array(32), planHash: new Uint8Array(32),
    owner: authority.owner, payer: authority.owner, fileRecordIndex: 3, file, rangeStart: 0n, rangeLength: length, first: 0n, last: 64n,
    population: 65n, sampleCount: 65n, nonce: 1n, priceDenom: 'stake', pricePerBlob: 1n, baseFee: 1n, completionBurnBps: 0, funding: 1,
    snapshot: 10n, anchor: 11n, firstResponse: 12n, deadline: 90n, dealEnd: 100n,
    obligations: [{ slot: 0, assigned: providers[0], payee: providers[0], blobCount: 9n, sampleCount: 9n, lockedFee: 9n }],
    acceptedBitmap: new Uint8Array(17), ackedMask: 0, settledMask: 0, refundedMask: 0, lockedFee: 9n, expired: false, context: new Uint8Array() } as FrozenSessionV3
  return { version: 3, id: 'output', length, authority, fileRecordIndex: 3, file, rangeStart: 0n, rangeLength: length, session, cursors: { 0: 64n } }
}

test('v3 checkpoint accepts only exact frozen session and durable chunk boundaries', () => {
  const valid = state()
  assert.equal(readRetrievalV3Checkpoint('key', store(valid))?.cursors[0], 64n)
  for (const mutation of [
    { ...valid, cursors: { 0: 63n } },
    { ...valid, session: undefined, cursors: { 0: 64n } },
    { ...valid, fileRecordIndex: 4 },
    { ...valid, authority: { ...valid.authority, integrityRoot: `0x${'23'.repeat(32)}` as const } },
  ]) assert.throws(() => readRetrievalV3Checkpoint('key', store(mutation as RetrievalV3CheckpointState)), /invalid saved/)
})
