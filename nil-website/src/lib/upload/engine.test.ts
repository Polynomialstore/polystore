import test from 'node:test'
import assert from 'node:assert/strict'

import { buildCommitRequest, createUploadEngine, type UploadTransportRequest } from './engine'

function makeRecordingTransport(failAt?: (request: UploadTransportRequest) => string | null) {
  const calls: UploadTransportRequest[] = []
  return {
    calls,
    transport: {
      async sendArtifact(request: UploadTransportRequest) {
        calls.push(request)
        const failure = failAt?.(request)
        if (failure) {
          throw new Error(failure)
        }
      },
    },
  }
}

test('upload engine: direct upload reports progress and stops on manifest errors', async () => {
  const transport = makeRecordingTransport((request) =>
    request.artifact.kind === 'manifest' ? 'manifest missing in provider' : null,
  )
  const engine = createUploadEngine({ transport: transport.transport })
  const snapshots: string[][] = []

  const result = await engine.uploadDirect({
    dealId: '7',
    manifestRoot: '0xabc',
    manifestBlob: new Uint8Array([9, 0, 0]),
    manifestBlobFullSize: 128 * 1024,
    mdus: [{ index: 0, data: new Uint8Array([1, 2, 3]), fullSize: 8 * 1024 * 1024 }],
    target: {
      baseUrl: 'http://provider-a',
      mduPath: '/sp/upload_mdu',
      manifestPath: '/sp/upload_manifest',
      label: 'provider-a',
    },
    onProgress(steps) {
      snapshots.push(steps.map((step) => `${step.kind}:${step.status}`))
    },
  })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'manifest missing in provider')
  assert.deepEqual(
    transport.calls.map((call) => call.artifact.kind),
    ['mdu', 'manifest'],
  )
  assert.equal(transport.calls[0].artifact.fullSize, 8 * 1024 * 1024)
  assert.equal(transport.calls[1].artifact.fullSize, 128 * 1024)
  const lastSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : []
  assert.match(lastSnapshot.join(',') || '', /mdu:complete,manifest:error/)
})

test('upload engine: striped upload sequences metadata per target before shard uploads', async () => {
  const transport = makeRecordingTransport()
  const engine = createUploadEngine({ transport: transport.transport })

  const result = await engine.uploadStriped({
    dealId: '9',
    manifestRoot: '0xdef',
    manifestBlob: new Uint8Array([5, 4, 3]),
    manifestBlobFullSize: 128 * 1024,
    metadataMdus: [
      { index: 0, data: new Uint8Array([1]), fullSize: 8 * 1024 * 1024 },
      { index: 1, data: new Uint8Array([2]), fullSize: 8 * 1024 * 1024 },
    ],
    shardSets: [
      { index: 2, shards: [{ data: new Uint8Array([7]), fullSize: 1024 }, { data: new Uint8Array([8]), fullSize: 1024 }] },
    ],
    metadataTargets: [
      {
        baseUrl: 'http://provider-a',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        label: 'provider-a',
      },
      {
        baseUrl: 'http://provider-b',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        label: 'provider-b',
      },
    ],
    shardTargets: [
      {
        baseUrl: 'http://provider-a',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        label: 'provider-a',
      },
      {
        baseUrl: 'http://provider-b',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        label: 'provider-b',
      },
    ],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(
    transport.calls.map((call) => `${call.target.label}:${call.artifact.kind}:${call.artifact.index ?? 'manifest'}:${call.artifact.slot ?? '-'}`),
    [
      'provider-a:mdu:0:-',
      'provider-a:mdu:1:-',
      'provider-a:manifest:manifest:-',
      'provider-b:mdu:0:-',
      'provider-b:mdu:1:-',
      'provider-b:manifest:manifest:-',
      'provider-a:shard:2:0',
      'provider-b:shard:2:1',
    ],
  )
  assert.equal(transport.calls[0].artifact.fullSize, 8 * 1024 * 1024)
  assert.equal(transport.calls[2].artifact.fullSize, 128 * 1024)
  assert.equal(transport.calls[6].artifact.fullSize, 1024)
})

test('buildCommitRequest: mode2 derives total mdus from witness + user counts', () => {
  assert.deepEqual(
    buildCommitRequest({
      dealId: '12',
      manifestRoot: '0x1234',
      isMode2: true,
      fileBytesTotal: 1024,
      totalWitnessMdus: 2,
      totalUserMdus: 5,
      mdus: [],
    }),
    {
      dealId: '12',
      manifestRoot: '0x1234',
      fileSize: 1024,
      totalMdus: 8,
      witnessMdus: 2,
    },
  )
})

test('buildCommitRequest: mode1 uses concrete MDU count', () => {
  assert.deepEqual(
    buildCommitRequest({
      dealId: '14',
      manifestRoot: '0x99',
      isMode2: false,
      fileBytesTotal: 2048,
      totalWitnessMdus: 0,
      totalUserMdus: 0,
      mdus: [
        { index: 0, data: new Uint8Array([1]) },
        { index: 1, data: new Uint8Array([2]) },
      ],
    }),
    {
      dealId: '14',
      manifestRoot: '0x99',
      fileSize: 2048,
      totalMdus: 2,
      witnessMdus: 0,
    },
  )
})
