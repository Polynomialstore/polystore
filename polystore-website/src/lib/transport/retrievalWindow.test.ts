import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeRetrievalWindowRequest, parseRetrievalWindowFrame } from './libp2pClient'
import { RETRIEVAL_FRAMING_LIMIT, RETRIEVAL_METADATA_LIMIT } from '../retrievalWire'
import type { FrozenSession } from '../retrieval'

function frame(body: Uint8Array, changes: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ status: 200, body_len: body.length, headers: { 'content-type': 'application/octet-stream' }, ...changes }))
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length)
  return Buffer.concat([size, header, body])
}
test('secured P2P uses exact decimal identifiers and permits a complete 8MiB window', async () => {
  const session = { pin: { root: `0x${'ab'.repeat(32)}`, dealId: 9007199254740993n }, window: { mduIndex: 65536n, startBlobIndex: 0, blobCount: 64 }, owner: 'nil-owner', sessionId: `0x${'cd'.repeat(32)}` } as FrozenSession
  assert.deepEqual(JSON.parse(new TextDecoder().decode(encodeRetrievalWindowRequest(session))), {
    kind: 'retrieval_window_v2', manifest_root: session.pin.root, deal_id: '9007199254740993', mdu_index: '65536',
    start_blob_index: 0, blob_count: '64', owner: session.owner, session_id: session.sessionId,
  })
  const body = new Uint8Array(8388608); body[0] = 17; body[body.length - 1] = 29
  const result = await parseRetrievalWindowFrame(frame(body), body.length + RETRIEVAL_METADATA_LIMIT + RETRIEVAL_FRAMING_LIMIT).arrayBuffer()
  assert.deepEqual(new Uint8Array(result), body)
})
test('secured P2P rejects oversized, malformed, truncated and trailing frame bytes', () => {
  const body = new Uint8Array(16)
  for (const changes of [{ body_len: 17 }, { body_len: '16' }, { body_len: -1 }, { status: 99 }, { headers: { invalid: 7 } }]) assert.throws(() => parseRetrievalWindowFrame(frame(body, changes), 16))
  assert.throws(() => parseRetrievalWindowFrame(frame(body), 15))
  assert.throws(() => parseRetrievalWindowFrame(frame(body).subarray(0, -1), 16))
  assert.throws(() => parseRetrievalWindowFrame(Buffer.concat([frame(body), Buffer.from([0])]), 16))
  const header = Buffer.alloc(4); header.writeUInt32BE(RETRIEVAL_FRAMING_LIMIT + 1)
  assert.throws(() => parseRetrievalWindowFrame(Buffer.concat([header, Buffer.alloc(RETRIEVAL_FRAMING_LIMIT + 1)]), 16))
})
