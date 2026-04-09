import test from 'node:test'
import assert from 'node:assert/strict'

import { collectMode2SlotFailures } from './mode2Recovery'
import type { UploadTaskEvent } from './engine'

test('mode2 recovery: maps shard failures directly from slot events', () => {
  const events: UploadTaskEvent[] = [
    {
      phase: 'end',
      kind: 'shard',
      target: 'https://sp2.polynomialstore.com',
      index: 4,
      slot: 1,
      bytes: 1024,
      ok: false,
      error: 'provider upload failed',
    },
  ]

  const out = collectMode2SlotFailures({
    events,
    slotBases: ['https://sp1.polynomialstore.com', 'https://sp2.polynomialstore.com'],
    slotProviders: ['nil1sp1', 'nil1sp2'],
  })

  assert.deepEqual(out, [
    {
      slot: 1,
      provider: 'nil1sp2',
      baseUrl: 'https://sp2.polynomialstore.com',
      target: 'https://sp2.polynomialstore.com',
      reason: 'provider upload failed',
      kind: 'shard',
      index: 4,
    },
  ])
})

test('mode2 recovery: maps metadata failures by provider target', () => {
  const events: UploadTaskEvent[] = [
    {
      phase: 'end',
      kind: 'mdu',
      target: 'https://sp3.polynomialstore.com/',
      index: 0,
      bytes: 4096,
      ok: false,
      error: 'connection refused',
    },
  ]

  const out = collectMode2SlotFailures({
    events,
    slotBases: ['https://sp1.polynomialstore.com', 'https://sp3.polynomialstore.com'],
    slotProviders: ['nil1sp1', 'nil1sp3'],
  })

  assert.deepEqual(out, [
    {
      slot: 1,
      provider: 'nil1sp3',
      baseUrl: 'https://sp3.polynomialstore.com',
      target: 'https://sp3.polynomialstore.com/',
      reason: 'connection refused',
      kind: 'mdu',
      index: 0,
    },
  ])
})

test('mode2 recovery: de-duplicates multiple failures for the same slot', () => {
  const events: UploadTaskEvent[] = [
    {
      phase: 'end',
      kind: 'mdu',
      target: 'https://sp2.polynomialstore.com',
      index: 0,
      bytes: 4096,
      ok: false,
      error: 'connection refused',
    },
    {
      phase: 'end',
      kind: 'manifest',
      target: 'https://sp2.polynomialstore.com',
      bytes: 1024,
      ok: false,
      error: 'manifest failed',
    },
  ]

  const out = collectMode2SlotFailures({
    events,
    slotBases: ['https://sp1.polynomialstore.com', 'https://sp2.polynomialstore.com'],
    slotProviders: ['nil1sp1', 'nil1sp2'],
  })

  assert.equal(out.length, 1)
  assert.equal(out[0]?.slot, 1)
  assert.equal(out[0]?.reason, 'connection refused')
})
