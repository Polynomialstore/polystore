import { bech32 } from 'bech32'
import { BLOB_SIZE_BYTES, RAW_MDU_CAPACITY_BYTES } from '../domain/polyfsLayout'

export const U64_MAX = (1n << 64n) - 1n
export const RETRIEVAL_SETUP = 'd39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7'
export const RAW_BLOB_BYTES = 126976
const RAW_MDU = BigInt(RAW_MDU_CAPACITY_BYTES)
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object')
  return value as Record<string, unknown>
}
export function u64(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) throw new Error('expected canonical uint64 string')
  const n = BigInt(value)
  if (n > U64_MAX) throw new Error('uint64 overflow')
  return n
}
export function uint(value: unknown, max = 0xffff_ffff): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('invalid bounded integer')
  return value
}
export function base64(value: unknown, length: number): Uint8Array {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(length / 3)) throw new Error('invalid base64 length')
  let decoded: string
  try { decoded = atob(value) } catch { throw new Error('invalid base64') }
  if (decoded.length !== length || btoa(decoded) !== value) throw new Error('noncanonical base64')
  return Uint8Array.from(decoded, (c) => c.charCodeAt(0))
}
export function hex(bytes: Uint8Array): `0x${string}` { return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` }
export function unhex(value: unknown, length: number): Uint8Array {
  if (typeof value !== 'string' || value.length !== 2 + length * 2 || !/^0x[0-9a-f]+$/.test(value)) throw new Error('invalid canonical hex')
  return Uint8Array.from(value.slice(2).match(/../g)!, (b) => parseInt(b, 16))
}
export function equal(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((v, i) => v === b[i]) }
export function account(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid account')
  const decoded = bech32.decode(value)
  if (decoded.prefix !== 'nil' || bech32.fromWords(decoded.words).length !== 20 || bech32.encode(decoded.prefix, decoded.words) !== value) throw new Error('noncanonical account')
  return value
}
function protoU64(value: unknown): bigint { return value === undefined ? 0n : u64(value) }
function protoUint(value: unknown, max = 0xffff_ffff): number { return value === undefined ? 0 : uint(value, max) }
function enumeration(value: unknown, names: string[]): number {
  if (typeof value === 'string') { const i = names.indexOf(value); if (i >= 0) return i }
  return protoUint(value, names.length - 1)
}

export interface PinnedGeneration {
  chainId: string; height: bigint; dealId: bigint; generation: bigint; root: `0x${string}`; owner: string
  endHeight: bigint; layout: 1 | 2; k: number; m: number; rows: number; leafCount: number
  metadataMdus: bigint; userMdus: bigint; totalMdus: bigint
  assignments: readonly { provider: string; active: boolean }[]
}
export function parsePinnedGeneration(payload: unknown, chainId: string, height: bigint, dealId: bigint): PinnedGeneration {
  if (!chainId || new TextEncoder().encode(chainId).length > 50 || chainId.includes('\0') || height < 1n) throw new Error('invalid committed chain identity')
  const d = record(record(payload).deal)
  if (protoU64(d.id) !== dealId) throw new Error('wrong deal')
  const layout = protoUint(d.redundancy_mode, 2)
  if (layout !== 1 && layout !== 2) throw new Error('unsupported layout')
  const profile = layout === 2 ? record(d.mode2_profile) : { k: 1, m: 0 }
  const k = uint(profile.k, 64), m = uint(profile.m, 255)
  if (!k || 64 % k || (layout === 2 && (!m || k + m > 256))) throw new Error('invalid stripe geometry')
  const totalMdus = protoU64(d.total_mdus), metadataMdus = 1n + protoU64(d.witness_mdus)
  if (metadataMdus > totalMdus || totalMdus > 65537n) throw new Error('invalid MDU bounds')
  const endHeight = protoU64(d.end_block)
  if (height >= endHeight) throw new Error('deal expired')
  let assignments: { provider: string; active: boolean }[]
  if (layout === 2) {
    if (!Array.isArray(d.mode2_slots) || d.mode2_slots.length !== k + m) throw new Error('incomplete assignments')
    assignments = d.mode2_slots.map((raw, slot) => {
      const s = record(raw)
      if (protoUint(s.slot, 255) !== slot) throw new Error('unordered assignments')
      const status = enumeration(s.status, ['SLOT_STATUS_UNSPECIFIED', 'SLOT_STATUS_ACTIVE', 'SLOT_STATUS_REPAIRING'])
      if (!status) throw new Error('unknown assignment status')
      return { provider: account(s.provider), active: status === 1 }
    })
  } else {
    if (!Array.isArray(d.providers) || !d.providers.length || d.providers.length > 256) throw new Error('invalid replica assignments')
    assignments = d.providers.map((p) => ({ provider: account(p), active: true }))
    if (new Set(assignments.map((a) => a.provider)).size !== assignments.length) throw new Error('duplicate replica assignment')
  }
  return { chainId, height, dealId, generation: protoU64(d.current_gen), root: hex(base64(d.manifest_root, 32)), owner: account(d.owner),
    endHeight, layout, k, m, rows: 64 / k, leafCount: 64 / k * (k + m), metadataMdus, userMdus: totalMdus - metadataMdus, totalMdus, assignments }
}

// Whole-response cap also covers chunked bodies. Cancel the reader on rejection.
export async function readBoundedResponse(response: Response, max: number, signal?: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length) > BigInt(max))) { await response.body?.cancel(); throw new Error('response exceeds limit') }
  if (!response.body) throw new Error('missing response body')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      size += value.length
      if (size > max) throw new Error('response exceeds limit')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    return bytes
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock() }
}
async function committedQuery(lcd: string, path: string, height: bigint | undefined, signal: AbortSignal | undefined, fetchFn: typeof fetch) {
  const res = await fetchFn(`${lcd.replace(/\/$/, '')}${path}`, { signal, headers: height === undefined ? undefined : { 'x-cosmos-block-height': height.toString() } })
  if (!res.ok) { await res.body?.cancel(); throw new Error(`chain query failed (${res.status})`) }
  let actual: bigint
  try { actual = u64(res.headers.get('x-cosmos-block-height')) } catch { await res.body?.cancel(); throw new Error('missing or malformed committed height') }
  if (!actual || (height !== undefined && actual !== height)) { await res.body?.cancel(); throw new Error('missing or mismatched committed height') }
  const payload: unknown = JSON.parse(textDecoder.decode(await readBoundedResponse(res, 256 * 1024, signal)))
  return { payload, height: actual }
}
export async function fetchPinnedGeneration(lcd: string, chainId: string, dealId: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<PinnedGeneration> {
  const id = u64(dealId)
  const result = await committedQuery(lcd, `/polystorechain/polystorechain/v1/deals/${id}`, undefined, signal, fetchFn)
  return parsePinnedGeneration(result.payload, chainId, result.height, id)
}

export async function fetchRetrievalAvailability(lcd: string, height?: bigint, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<string | null> {
  const result = await committedQuery(lcd, '/polystorechain/polystorechain/v1/params', height, signal, fetchFn)
  const activation = protoU64(record(record(result.payload).params).retrieval_v2_activation_height)
  // BeginBlock must activate at this height before it can commit; afterwards
  // SetParams prevents changing the activation height or disabling v2.
  if (!activation) return 'Verified downloads are unavailable until this network activates secured retrieval.'
  if (activation > result.height) return `Verified downloads become available at block ${activation} (current block ${result.height}).`
  return null
}

export async function fetchActiveRetrievalGeneration(lcd: string, chainId: string, dealId: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<PinnedGeneration> {
  const pin = await fetchPinnedGeneration(lcd, chainId, dealId, signal, fetchFn)
  const unavailable = await fetchRetrievalAvailability(lcd, pin.height, signal, fetchFn)
  if (unavailable) throw new Error(unavailable)
  return pin
}

export interface RetrievalFile { path: string; start_offset: bigint; size_bytes: bigint; flags: number }
export interface RetrievalWindow {
  mduIndex: bigint; slot: number; provider: string; startBlobIndex: number; blobCount: number
  slices: { encodedBlobIndex: number; rawOffset: number; length: number; outputOffset: bigint }[]
}
// The iterator retains one MDU's <=64 slices, independent of the file size.
export function* planRetrievalWindows(pin: PinnedGeneration, file: RetrievalFile, rangeStart: bigint, rangeLength: bigint, allowInactive = false): Generator<RetrievalWindow> {
  if (file.flags !== 0) throw new Error('transformed/encrypted retrieval requires a supported bounded decoder before payment')
  if (file.start_offset < 0n || file.size_bytes < 0n || file.start_offset + file.size_bytes > pin.userMdus * RAW_MDU ||
    rangeStart < 0n || rangeLength <= 0n || rangeStart + rangeLength > file.size_bytes) throw new Error('invalid file range')
  const first = file.start_offset + rangeStart, end = first + rangeLength
  let cursor = first
  while (cursor < end) {
    const ordinal = cursor / RAW_MDU
    const mduEnd = (ordinal + 1n) * RAW_MDU
    const groups = new Map<number, RetrievalWindow>()
    while (cursor < end && cursor < mduEnd) {
      const inMdu = Number(cursor % RAW_MDU), blob = Math.floor(inMdu / RAW_BLOB_BYTES)
      const slot = pin.layout === 2 ? blob % pin.k : 0
      const row = pin.layout === 2 ? Math.floor(blob / pin.k) : blob
      const assignment = pin.assignments[slot]
      if (!assignment || (!assignment.active && !allowInactive)) throw new Error('required assignment unavailable; deputy or parity must be explicitly authorized before payment')
      const leaf = slot * pin.rows + row
      const next = cursor + BigInt(RAW_BLOB_BYTES - inMdu % RAW_BLOB_BYTES)
      const stop = next < end ? next : end
      let group = groups.get(slot)
      if (!group) { group = { mduIndex: pin.metadataMdus + ordinal, slot, provider: assignment.provider, startBlobIndex: leaf, blobCount: 0, slices: [] }; groups.set(slot, group) }
      if (leaf !== group.startBlobIndex + group.blobCount) throw new Error('noncontiguous slot range')
      group.slices.push({ encodedBlobIndex: blob, rawOffset: inMdu % RAW_BLOB_BYTES, length: Number(stop - cursor), outputOffset: cursor - first })
      group.blobCount++
      cursor = stop
    }
    yield* groups.values()
  }
}

export interface FrozenSession {
  browserTransactionKey?: string
  sessionId: `0x${string}`; pin: PinnedGeneration; window: RetrievalWindow; owner: string; payee: string
  height: bigint; openedHeight: bigint; expiry: bigint; status: number; funding: number
  context: Uint8Array; contextHash: Uint8Array; seed: Uint8Array | null
}
function scalarBytes(value: bigint | number, size: 4 | 8): Uint8Array {
  const out = new Uint8Array(size), view = new DataView(out.buffer)
  if (size === 4) view.setUint32(0, Number(value)); else view.setBigUint64(0, BigInt(value))
  return out
}
function concat(parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const p of parts) { out.set(p, offset); offset += p.length } return out }
function lp(s: string): Uint8Array { const b = new TextEncoder().encode(s); return concat([scalarBytes(b.length, 4), b]) }
export function parseFrozenSession(payload: unknown, height: bigint, expected: { sessionId: string; pin: PinnedGeneration; window: RetrievalWindow; owner: string; payee?: string; funding: 1 | 2 }): FrozenSession {
  const response = record(payload), s = record(response.session), x = record(s.challenge_snapshot)
  const { pin, window } = expected
  const sessionId = hex(base64(s.session_id, 32)), root = base64(s.manifest_root, 32), setup = base64(x.setup_digest, 32)
  const owner = account(s.owner), assigned = account(s.provider), payee = account(s.authorized_proof_provider)
  const openedHeight = protoU64(s.opened_height), expiry = protoU64(s.expires_at)
  const status = enumeration(s.status, ['RETRIEVAL_SESSION_STATUS_UNSPECIFIED', 'RETRIEVAL_SESSION_STATUS_OPEN', 'RETRIEVAL_SESSION_STATUS_PROOF_SUBMITTED', 'RETRIEVAL_SESSION_STATUS_USER_CONFIRMED', 'RETRIEVAL_SESSION_STATUS_COMPLETED', 'RETRIEVAL_SESSION_STATUS_EXPIRED', 'RETRIEVAL_SESSION_STATUS_CANCELED'])
  const funding = enumeration(s.funding, ['RETRIEVAL_SESSION_FUNDING_UNSPECIFIED', 'RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW', 'RETRIEVAL_SESSION_FUNDING_REQUESTER', 'RETRIEVAL_SESSION_FUNDING_PROTOCOL'])
  const purpose = enumeration(s.purpose, ['RETRIEVAL_SESSION_PURPOSE_UNSPECIFIED', 'RETRIEVAL_SESSION_PURPOSE_USER', 'RETRIEVAL_SESSION_PURPOSE_PROTOCOL_AUDIT', 'RETRIEVAL_SESSION_PURPOSE_PROTOCOL_REPAIR'])
  if (protoUint(s.challenge_version) !== 2 || sessionId !== expected.sessionId || hex(root) !== pin.root || protoU64(s.deal_id) !== pin.dealId ||
    owner !== expected.owner || assigned !== window.provider || payee !== (expected.payee || assigned) || funding !== expected.funding || purpose !== 1 ||
    x.chain_id !== pin.chainId || hex(setup) !== `0x${RETRIEVAL_SETUP}` || protoU64(x.generation) !== pin.generation ||
    protoUint(x.layout) !== pin.layout || protoUint(x.k) !== pin.k || protoUint(x.m) !== pin.m || protoUint(x.slot) !== window.slot ||
    protoU64(x.metadata_mdus) !== pin.metadataMdus || protoU64(x.user_mdus) !== pin.userMdus || protoU64(x.deal_end) !== pin.endHeight ||
    protoU64(s.start_mdu_index) !== window.mduIndex || protoUint(s.start_blob_index) !== window.startBlobIndex || protoU64(s.blob_count) !== BigInt(window.blobCount) ||
    protoU64(s.total_bytes) !== BigInt(window.blobCount * BLOB_SIZE_BYTES) || !openedHeight || openedHeight < pin.height || openedHeight + 2n > expiry ||
    expiry > pin.endHeight || expiry > (1n << 63n) - 1n || height < openedHeight || height > expiry || status < 1 || status > 4) throw new Error('session does not match authorized request')
  protoU64(s.nonce); protoU64(s.updated_height)
  if (typeof s.locked_fee !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(s.locked_fee) || BigInt(s.locked_fee) >= (1n << 256n) || (funding === 2 ? account(s.payer) !== owner : s.payer !== undefined && s.payer !== '')) throw new Error('invalid session funding')
  const addressBytes = (v: string) => Uint8Array.from(bech32.fromWords(bech32.decode(v).words))
  const context = concat([lp('polystore/challenge-context/v2'), scalarBytes(2, 4), lp(pin.chainId), setup, new Uint8Array([1]), unhex(sessionId, 32),
    scalarBytes(pin.dealId, 8), scalarBytes(pin.generation, 8), root, addressBytes(assigned), addressBytes(payee), new Uint8Array([pin.layout]),
    ...[pin.k, pin.m, window.slot].map((v) => scalarBytes(v, 4)), ...[pin.metadataMdus, pin.userMdus, window.mduIndex].map((v) => scalarBytes(v, 8)),
    scalarBytes(window.startBlobIndex, 4), ...[BigInt(window.blobCount), 0n, 0n, 0n, openedHeight, openedHeight + 1n, openedHeight + 2n, expiry, pin.endHeight].map((v) => scalarBytes(v, 8))])
  if (!equal(context, base64(response.challenge_context, context.length))) throw new Error('nonmatching canonical challenge context')
  return { sessionId, pin, window, owner, payee, height, openedHeight, expiry, status, funding, context,
    // LCD emits null for nil protobuf bytes before the future anchor commits.
    contextHash: base64(response.challenge_context_hash, 32), seed: (response.challenge_seed == null || response.challenge_seed === '') ? null : base64(response.challenge_seed, 32) }
}
export async function fetchFrozenSession(lcd: string, expected: Parameters<typeof parseFrozenSession>[2], signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<FrozenSession> {
  // The generated LCD path decodes protobuf bytes as base64, not hex. Use
  // URL-safe base64 so IDs containing '/' remain one path segment.
  const id = btoa(String.fromCharCode(...unhex(expected.sessionId, 32))).replace(/\+/g, '-').replace(/\//g, '_')
  const result = await committedQuery(lcd, `/polystorechain/polystorechain/v1/retrieval-sessions/${encodeURIComponent(id)}`, undefined, signal, fetchFn)
  return parseFrozenSession(result.payload, result.height, expected)
}
