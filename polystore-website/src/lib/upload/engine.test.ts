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
    previousManifestRoot: '0xprev',
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
  assert.equal(transport.calls[0].previousManifestRoot, '0xprev')
  assert.equal(transport.calls[1].previousManifestRoot, '0xprev')
  const lastSnapshot = snapshots.length > 0 ? snapshots[snapshots.length - 1] : []
  assert.match(lastSnapshot.join(',') || '', /mdu:complete,manifest:error/)
})

test('upload engine: striped upload interleaves metadata and shard requests', async () => {
  const transport = makeRecordingTransport()
  const engine = createUploadEngine({ transport: transport.transport })

  const result = await engine.uploadStriped({
    dealId: '9',
    manifestRoot: '0xdef',
    previousManifestRoot: '0xbase',
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
  assert.equal(result.steps.length, 0)
  assert.deepEqual(
    transport.calls.map((call) => `${call.target.label}:${call.artifact.kind}:${call.artifact.index ?? 'manifest'}:${call.artifact.slot ?? '-'}`),
    [
      'provider-a:mdu:0:-',
      'provider-b:mdu:0:-',
      'provider-a:shard:2:0',
      'provider-b:shard:2:1',
      'provider-a:mdu:1:-',
      'provider-b:mdu:1:-',
      'provider-a:manifest:manifest:-',
      'provider-b:manifest:manifest:-',
    ],
  )
  assert.equal(transport.calls[0].artifact.fullSize, 8 * 1024 * 1024)
  assert.equal(transport.calls[2].artifact.fullSize, 1024)
  assert.equal(transport.calls[6].artifact.fullSize, 128 * 1024)
  assert.equal(transport.calls[0].previousManifestRoot, '0xbase')
  assert.equal(transport.calls[6].previousManifestRoot, '0xbase')
})

test('upload engine: direct upload overlaps artifact requests with bounded concurrency', async () => {
  const started: string[] = []
  let active = 0
  let peakActive = 0
  const transport = {
    async sendArtifact(request: UploadTransportRequest) {
      started.push(`${request.artifact.kind}:${request.artifact.kind === 'manifest' ? 'manifest' : request.artifact.index}`)
      active += 1
      peakActive = Math.max(peakActive, active)
      await new Promise((resolve) => setTimeout(resolve, 40))
      active -= 1
    },
  }

  const engine = createUploadEngine({
    transport,
    parallelism: { direct: 2 },
  })

  const startedAt = Date.now()
  const result = await engine.uploadDirect({
    dealId: '15',
    manifestRoot: '0x999',
    manifestBlob: new Uint8Array([9, 9, 9]),
    manifestBlobFullSize: 128 * 1024,
    mdus: [
      { index: 0, data: new Uint8Array([1]), fullSize: 8 * 1024 * 1024 },
      { index: 1, data: new Uint8Array([2]), fullSize: 8 * 1024 * 1024 },
      { index: 2, data: new Uint8Array([3]), fullSize: 8 * 1024 * 1024 },
    ],
    target: {
      baseUrl: 'http://provider-a',
      mduPath: '/sp/upload_mdu',
      manifestPath: '/sp/upload_manifest',
      label: 'provider-a',
    },
  })
  const elapsedMs = Date.now() - startedAt

  assert.equal(result.ok, true)
  assert.equal(started.length, 4)
  assert.equal(peakActive, 2)
  assert.ok(elapsedMs < 140, `expected bounded parallel direct upload, got ${elapsedMs}ms`)
})

test('upload engine: direct upload emits task events when requested', async () => {
  const transport = makeRecordingTransport()
  const engine = createUploadEngine({ transport: transport.transport })
  const events: string[] = []

  const result = await engine.uploadDirect({
    dealId: '16',
    manifestRoot: '0x111',
    manifestBlob: new Uint8Array([9, 9]),
    manifestBlobFullSize: 128 * 1024,
    mdus: [{ index: 0, data: new Uint8Array([1]), fullSize: 8 * 1024 * 1024 }],
    target: {
      baseUrl: 'http://provider-a',
      mduPath: '/sp/upload_mdu',
      manifestPath: '/sp/upload_manifest',
      label: 'provider-a',
    },
    onTaskEvent(event) {
      events.push(`${event.phase}:${event.kind}:${event.index ?? 'manifest'}:${event.ok ?? 'na'}`)
    },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(events, [
    'start:mdu:0:na',
    'start:manifest:manifest:na',
    'end:mdu:0:true',
    'end:manifest:manifest:true',
  ])
})

test('upload engine: striped upload overlaps metadata and shard requests with combined bounded concurrency', async () => {
  let activeTotal = 0
  let peakTotal = 0
  let completedMetadata = 0
  let shardStartedBeforeMetadataComplete = false
  const totalMetadataTasks = 6

  const transport = {
    async sendArtifact(request: UploadTransportRequest) {
      const isShard = request.artifact.kind === 'shard'
      if (isShard) {
        if (completedMetadata < totalMetadataTasks) shardStartedBeforeMetadataComplete = true
      }
      activeTotal += 1
      peakTotal = Math.max(peakTotal, activeTotal)

      await new Promise((resolve) => setTimeout(resolve, 40))

      activeTotal -= 1
      if (!isShard) {
        completedMetadata += 1
      }
    },
  }

  const engine = createUploadEngine({
    transport,
    parallelism: { stripedMetadata: 2, stripedShards: 2 },
  })

  const result = await engine.uploadStriped({
    dealId: '17',
    manifestRoot: '0x777',
    manifestBlob: new Uint8Array([5, 4, 3]),
    manifestBlobFullSize: 128 * 1024,
    metadataMdus: [
      { index: 0, data: new Uint8Array([1]), fullSize: 8 * 1024 * 1024 },
      { index: 1, data: new Uint8Array([2]), fullSize: 8 * 1024 * 1024 },
    ],
    shardSets: [
      {
        index: 2,
        shards: [
          { data: new Uint8Array([7]), fullSize: 1024 },
          { data: new Uint8Array([8]), fullSize: 1024 },
          { data: new Uint8Array([9]), fullSize: 1024 },
        ],
      },
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
      {
        baseUrl: 'http://provider-c',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        label: 'provider-c',
      },
    ],
  })

  assert.equal(result.ok, true)
  assert.equal(result.steps.length, 0)
  assert.equal(shardStartedBeforeMetadataComplete, true)
  assert.equal(peakTotal, 4)
})

test('upload engine: striped upload bundles requests per target when transport supports it', async () => {
  const bundleCalls: string[][] = []
  const transport = {
    async sendArtifact() {
      throw new Error('sendArtifact should not be used when bundle transport is available')
    },
    async sendBundle(requests: UploadTransportRequest[]) {
      bundleCalls.push(
        requests.map((request) => `${request.target.label}:${request.artifact.kind}:${request.artifact.index ?? 'manifest'}:${request.artifact.slot ?? '-'}`),
      )
    },
  }

  const engine = createUploadEngine({ transport })
  const result = await engine.uploadStriped({
    dealId: '18',
    manifestRoot: '0xbundle',
    previousManifestRoot: '0xprev',
    manifestBlob: new Uint8Array([5, 4, 3]),
    manifestBlobFullSize: 128 * 1024,
    metadataMdus: [
      { index: 0, data: new Uint8Array([1]), fullSize: 8 * 1024 * 1024 },
      { index: 1, data: new Uint8Array([2]), fullSize: 8 * 1024 * 1024 },
    ],
    shardSets: [
      {
        index: 2,
        shards: [
          { data: new Uint8Array([7]), fullSize: 1024 },
          { data: new Uint8Array([8]), fullSize: 1024 },
        ],
      },
    ],
    metadataTargets: [
      {
        baseUrl: 'http://provider-a',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        bundlePath: '/sp/upload_bundle',
        label: 'provider-a',
      },
      {
        baseUrl: 'http://provider-b',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        bundlePath: '/sp/upload_bundle',
        label: 'provider-b',
      },
    ],
    shardTargets: [
      {
        baseUrl: 'http://provider-a',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        bundlePath: '/sp/upload_bundle',
        label: 'provider-a',
      },
      {
        baseUrl: 'http://provider-b',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        bundlePath: '/sp/upload_bundle',
        label: 'provider-b',
      },
    ],
  })

  assert.equal(result.ok, true)
  assert.deepEqual(bundleCalls, [
    [
      'provider-a:mdu:0:-',
      'provider-a:shard:2:0',
      'provider-a:mdu:1:-',
      'provider-a:manifest:manifest:-',
    ],
    [
      'provider-b:mdu:0:-',
      'provider-b:shard:2:1',
      'provider-b:mdu:1:-',
      'provider-b:manifest:manifest:-',
    ],
  ])
})

test('buildCommitRequest: mode2 derives total mdus from witness + user counts', () => {
  assert.deepEqual(
    buildCommitRequest({
      dealId: '12',
      previousManifestRoot: '0xaaaa',
      manifestRoot: '0x1234',
      isMode2: true,
      fileBytesTotal: 1024,
      totalWitnessMdus: 2,
      totalUserMdus: 5,
      mdus: [],
    }),
    {
      dealId: '12',
      previousManifestRoot: '0xaaaa',
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
      previousManifestRoot: '',
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
      previousManifestRoot: '',
      manifestRoot: '0x99',
      fileSize: 2048,
      totalMdus: 2,
      witnessMdus: 0,
    },
  )
})

test('upload engine: striped upload continues dispatching later slots after one slot fails', async () => {
  const transport = makeRecordingTransport((request) => {
    if (
      request.target.label === 'provider-b' &&
      request.artifact.kind === 'shard' &&
      request.artifact.slot === 1
    ) {
      return 'slot 1 failed'
    }
    return null
  })
  const engine = createUploadEngine({ transport: transport.transport })

  const result = await engine.uploadStriped({
    dealId: '19',
    manifestRoot: '0xcontinue',
    previousManifestRoot: '0xprev',
    manifestBlob: new Uint8Array([1, 2, 3]),
    manifestBlobFullSize: 128 * 1024,
    metadataMdus: [{ index: 0, data: new Uint8Array([9]), fullSize: 8 * 1024 * 1024 }],
    shardSets: [
      {
        index: 2,
        shards: [
          { data: new Uint8Array([7]), fullSize: 1024 },
          { data: new Uint8Array([8]), fullSize: 1024 },
          { data: new Uint8Array([9]), fullSize: 1024 },
        ],
      },
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
      {
        baseUrl: 'http://provider-c',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        label: 'provider-c',
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
      {
        baseUrl: 'http://provider-c',
        mduPath: '/sp/upload_mdu',
        manifestPath: '/sp/upload_manifest',
        shardPath: '/sp/upload_shard',
        label: 'provider-c',
      },
    ],
  })

  assert.equal(result.ok, false)
  assert.equal(result.error, 'slot 1 failed')
  assert.ok(
    transport.calls.some(
      (call) =>
        call.target.label === 'provider-c' &&
        call.artifact.kind === 'shard' &&
        call.artifact.slot === 2,
    ),
  )
  assert.ok(
    transport.calls.some(
      (call) =>
        call.target.label === 'provider-c' &&
        call.artifact.kind === 'manifest',
    ),
  )
})

test('upload engine: striped slot upload only sends the selected slot shards', async () => {
  const transport = makeRecordingTransport()
  const engine = createUploadEngine({ transport: transport.transport })

  const result = await engine.uploadStripedSlot({
    dealId: '20',
    manifestRoot: '0xslot',
    previousManifestRoot: '0xprev',
    manifestBlob: new Uint8Array([1, 2, 3]),
    manifestBlobFullSize: 128 * 1024,
    metadataMdus: [{ index: 0, data: new Uint8Array([9]), fullSize: 8 * 1024 * 1024 }],
    shardSets: [
      {
        index: 2,
        shards: [
          { data: new Uint8Array([7]), fullSize: 1024 },
          { data: new Uint8Array([8]), fullSize: 1024 },
          { data: new Uint8Array([9]), fullSize: 1024 },
        ],
      },
    ],
    slot: 1,
    target: {
      baseUrl: 'http://provider-b',
      mduPath: '/sp/upload_mdu',
      manifestPath: '/sp/upload_manifest',
      shardPath: '/sp/upload_shard',
      label: 'provider-b',
    },
  })

  assert.equal(result.ok, true)
  assert.deepEqual(
    transport.calls.map((call) => `${call.artifact.kind}:${call.artifact.index ?? 'manifest'}:${call.artifact.slot ?? '-'}`),
    ['mdu:0:-', 'manifest:manifest:-', 'shard:2:1'],
  )
})
