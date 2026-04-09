import type { UploadTaskEvent } from './engine'

export interface Mode2SlotFailure {
  slot: number
  provider: string
  baseUrl: string
  target: string
  reason: string
  kind: UploadTaskEvent['kind']
  index?: number
}

function normalizeTarget(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '')
}

export function collectMode2SlotFailures(params: {
  events: UploadTaskEvent[]
  slotBases: string[]
  slotProviders: string[]
}): Mode2SlotFailure[] {
  const bySlot = new Map<number, Mode2SlotFailure>()
  const slotByTarget = new Map<string, number>()
  for (let slot = 0; slot < params.slotBases.length; slot += 1) {
    const key = normalizeTarget(params.slotBases[slot] || '')
    if (!key) continue
    slotByTarget.set(key, slot)
  }

  for (const event of params.events) {
    if (event.phase !== 'end' || event.ok !== false) continue
    const slot =
      typeof event.slot === 'number' && Number.isFinite(event.slot)
        ? event.slot
        : slotByTarget.get(normalizeTarget(event.target))
    if (slot == null || slot < 0 || slot >= params.slotProviders.length) continue
    if (bySlot.has(slot)) continue
    bySlot.set(slot, {
      slot,
      provider: String(params.slotProviders[slot] || '').trim(),
      baseUrl: String(params.slotBases[slot] || '').trim(),
      target: String(event.target || '').trim(),
      reason: String(event.error || `${event.kind} upload failed`).trim(),
      kind: event.kind,
      index: event.index,
    })
  }

  return Array.from(bySlot.values()).sort((a, b) => a.slot - b.slot)
}
