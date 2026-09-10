import type { Hex } from 'viem'
import { BLOB_SIZE_BYTES, RAW_MDU_CAPACITY_BYTES } from '../domain/polyfsLayout'
import { account, accountBytes, base64, committedQuery, enumeration, equal, hex, parsePinnedGeneration, protoU64, protoUint, record, u64, unhex, type PinnedGeneration, type RetrievalFile } from './retrieval'
import type { RetrievalV3ChunkAuthority, RetrievalV3GenerationAuthority } from './retrievalWire'

export const RETRIEVAL_V3_SETUP = '0xd39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7' as const
const MAX_MDUS = 65_537n

export interface FrozenGenerationV3 extends RetrievalV3GenerationAuthority {
  chainId: string; height: bigint; dealId: bigint; generation: bigint; owner: string; dealEnd: bigint
  setupDigest: Hex; providers: readonly string[]; totalMdus: bigint; witnessMdus: bigint
  retrievalPolicyMode: 1 | 2 | 3 | 4 | 5
}
export interface RetrievalRangeV3 { first: bigint; last: bigint; population: bigint }
export interface RetrievalObligationV3 { slot: number; assigned: string; payee: string; blobCount: bigint; sampleCount: bigint; lockedFee: bigint }
export interface FrozenSessionV3 {
  authority: FrozenGenerationV3; height: bigint; sessionId: Hex; contextHash: Uint8Array; planHash: Uint8Array
  owner: string; payer: string; fileRecordIndex: number; file: RetrievalFile; rangeStart: bigint; rangeLength: bigint
  first: bigint; last: bigint; population: bigint; sampleCount: bigint; nonce: bigint
  priceDenom: string; pricePerBlob: bigint; baseFee: bigint; completionBurnBps: number; funding: 1 | 2
  snapshot: bigint; anchor: bigint; firstResponse: bigint; deadline: bigint; dealEnd: bigint
  obligations: readonly RetrievalObligationV3[]; acceptedBitmap: Uint8Array; ackedMask: number; settledMask: number; refundedMask: number
  lockedFee: bigint; expired: boolean; context: Uint8Array
  anchorSeed?: Uint8Array
  browserTransactionKey?: string
}

function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('invalid v3 amount')
  const n = BigInt(value)
  if (n >= (1n << 256n)) throw new Error('v3 amount overflow')
  return n
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { out.set(part, offset); offset += part.length }
  return out
}
function be(value: bigint | number, bytes: 1 | 4 | 8): Uint8Array {
  const out = new Uint8Array(bytes), view = new DataView(out.buffer)
  if (bytes === 1) out[0] = Number(value)
  else if (bytes === 4) view.setUint32(0, Number(value))
  else view.setBigUint64(0, BigInt(value))
  return out
}
function lp(value: string): Uint8Array {
  const encoded = new TextEncoder().encode(value)
  return concat([be(encoded.length, 4), encoded])
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()))
}
function protoBytes(value: unknown, length: number): Uint8Array { return base64(value, length) }

function parseGeneration(payload: unknown, chainId: string, height: bigint, dealId: bigint, dealPayload: unknown): FrozenGenerationV3 | null {
  const response = record(payload)
  if (response.admitted == null) return null
  const g = record(response.admitted)
  const deal = parsePinnedGeneration(dealPayload, chainId, height, dealId)
  const policy = record(record(record(dealPayload).deal).retrieval_policy)
  const retrievalPolicyMode = enumeration(policy.mode, ['RETRIEVAL_POLICY_MODE_UNSPECIFIED', 'RETRIEVAL_POLICY_MODE_OWNER_ONLY',
    'RETRIEVAL_POLICY_MODE_ALLOWLIST', 'RETRIEVAL_POLICY_MODE_VOUCHER', 'RETRIEVAL_POLICY_MODE_ALLOWLIST_OR_VOUCHER', 'RETRIEVAL_POLICY_MODE_PUBLIC'])
  const generation = protoU64(g.generation), polyfsRoot = hex(protoBytes(g.polyfs_root, 32)), integrityRoot = hex(protoBytes(g.integrity_root, 32))
  const setupDigest = hex(protoBytes(g.setup_digest, 32)), totalMdus = protoU64(g.total_mdus), witnessMdus = protoU64(g.witness_mdus)
  const metadataMdus = protoU64(g.metadata_mdus), userMdus = protoU64(g.user_mdus), integrityLeafCount = protoU64(g.integrity_leaf_count)
  if (protoU64(g.deal_id) !== dealId || account(g.owner) !== deal.owner || g.chain_id !== chainId || generation !== deal.generation ||
    polyfsRoot !== deal.root || setupDigest !== RETRIEVAL_V3_SETUP || totalMdus !== metadataMdus + userMdus || metadataMdus !== witnessMdus + 1n ||
    !metadataMdus || !userMdus || totalMdus > MAX_MDUS || integrityLeafCount !== userMdus * 96n || protoU64(g.size) > userMdus * BigInt(RAW_MDU_CAPACITY_BYTES) ||
    protoUint(g.accepted_slots_mask, 0xfff) !== 0xfff || protoU64(g.proposed_height) < 1n || protoU64(g.proposed_height) > height ||
    !Array.isArray(g.providers) || g.providers.length !== 12) throw new Error('invalid admitted v3 generation')
  const providers = g.providers.map(account)
  if (new Set(providers).size !== 12 || deal.layout !== 2 || deal.k !== 8 || deal.m !== 4 || deal.metadataMdus !== metadataMdus || deal.userMdus !== userMdus ||
    deal.assignments.some((assignment, slot) => !assignment.active || assignment.provider !== providers[slot])) throw new Error('v3 generation does not match active deal')
  if (retrievalPolicyMode < 1 || retrievalPolicyMode > 5) throw new Error('invalid v3 retrieval policy')
  return { chainId, height, dealId, generation, owner: deal.owner, dealEnd: deal.endHeight, polyfsRoot, integrityRoot, setupDigest,
    retrievalPolicyMode: retrievalPolicyMode as 1 | 2 | 3 | 4 | 5,
    integrityLeafCount, metadataMdus, userMdus, totalMdus, witnessMdus, providers }
}

export async function fetchActiveGenerationV3(lcd: string, chainId: string, dealIdRaw: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<FrozenGenerationV3 | null> {
  const dealId = u64(dealIdRaw)
  const generation = await committedQuery(lcd, `/polystorechain/polystorechain/v1/deals/${dealId}/generation-v3`, undefined, signal, fetchFn)
  const params = await committedQuery(lcd, '/polystorechain/polystorechain/v1/params', generation.height, signal, fetchFn)
  const activation = protoU64(record(record(params.payload).params).retrieval_v3_activation_height)
  if (!activation || activation > generation.height) return null
  const deal = await committedQuery(lcd, `/polystorechain/polystorechain/v1/deals/${dealId}`, generation.height, signal, fetchFn)
  return parseGeneration(generation.payload, chainId, generation.height, dealId, deal.payload)
}

export async function fetchOptionalActiveGenerationV3(lcd: string, chainId: string, dealIdRaw: string,
  signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<FrozenGenerationV3 | null> {
  try { return await fetchActiveGenerationV3(lcd, chainId, dealIdRaw, signal, fetchFn) }
  catch (error) {
    if (error instanceof Error && error.message === 'chain query failed (404)') return null
    throw error
  }
}

export function generationAsPinnedV2Shape(g: FrozenGenerationV3): PinnedGeneration {
  return { chainId: g.chainId, height: g.height, dealId: g.dealId, generation: g.generation, root: g.polyfsRoot, owner: g.owner,
    endHeight: g.dealEnd, layout: 2, k: 8, m: 4, rows: 8, leafCount: 96, metadataMdus: g.metadataMdus,
    userMdus: g.userMdus, totalMdus: g.totalMdus, assignments: g.providers.map((provider) => ({ provider, active: true })) }
}

export function sameFrozenGenerationV3(a: FrozenGenerationV3, b: FrozenGenerationV3): boolean {
  return a.chainId === b.chainId && a.dealId === b.dealId && a.generation === b.generation && a.owner === b.owner &&
    a.dealEnd === b.dealEnd && a.polyfsRoot === b.polyfsRoot && a.integrityRoot === b.integrityRoot &&
    a.setupDigest === b.setupDigest && a.integrityLeafCount === b.integrityLeafCount && a.metadataMdus === b.metadataMdus &&
    a.userMdus === b.userMdus && a.totalMdus === b.totalMdus && a.witnessMdus === b.witnessMdus &&
    a.retrievalPolicyMode === b.retrievalPolicyMode && a.providers.length === b.providers.length &&
    a.providers.every((provider, index) => provider === b.providers[index])
}

export function sameFrozenRetrievalRequestV3(a: { authority: FrozenGenerationV3; recordIndex: number; file: RetrievalFile; rangeStart: bigint; rangeLength: bigint },
  b: { authority: FrozenGenerationV3; recordIndex: number; file: RetrievalFile; rangeStart: bigint; rangeLength: bigint }): boolean {
  return sameFrozenGenerationV3(a.authority, b.authority) && a.recordIndex === b.recordIndex && a.file.path === b.file.path &&
    a.file.start_offset === b.file.start_offset && a.file.size_bytes === b.file.size_bytes && a.file.flags === b.file.flags &&
    a.rangeStart === b.rangeStart && a.rangeLength === b.rangeLength
}

export function preserveV3BrowserTransactionKey(previous: FrozenSessionV3, current: FrozenSessionV3): FrozenSessionV3 {
  return previous.browserTransactionKey ? { ...current, browserTransactionKey: previous.browserTransactionKey } : current
}

export function assertSponsoredPolicyV3(authority: FrozenGenerationV3, requester: string,
  authType: 'none' | 'allowlist' | 'voucher'): void {
  if (requester === authority.owner) return
  const mode = authority.retrievalPolicyMode
  if ((authType === 'none' && mode !== 5) ||
    (authType === 'allowlist' && mode !== 2 && mode !== 4) ||
    (authType === 'voucher' && mode !== 3 && mode !== 4)) {
    throw new Error('the committed deal retrieval policy does not authorize this sponsored request')
  }
}

export function decodeRangeV3(bytes: Uint8Array): RetrievalRangeV3 {
  if (bytes.length !== 24) throw new Error('invalid v3 range result')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const range = { first: view.getBigUint64(0), last: view.getBigUint64(8), population: view.getBigUint64(16) }
  if (!range.population || range.last - range.first + 1n !== range.population) throw new Error('invalid v3 range result')
  return range
}
export function expectedObligationsV3(range: RetrievalRangeV3, providers: readonly string[]): RetrievalObligationV3[] {
  if (providers.length < 8) throw new Error('missing systematic providers')
  const out: RetrievalObligationV3[] = []
  for (let slot = 0; slot < 8; slot++) {
    const first = range.first <= BigInt(slot) ? BigInt(slot) : range.first + ((BigInt(slot) - range.first % 8n + 8n) % 8n)
    if (first > range.last) continue
    out.push({ slot, assigned: providers[slot], payee: providers[slot], blobCount: (range.last - first) / 8n + 1n, sampleCount: 0n, lockedFee: 0n })
  }
  return out
}

export async function prepareV3Binding(cryptoWorker: {
  retrievalV3Range(a: bigint, b: bigint, c: bigint, d: bigint, e: bigint): Promise<Uint8Array>
  retrievalV3Plan(a: bigint, b: bigint, c: bigint, d: Uint8Array): Promise<Uint8Array>
  retrievalV3SessionId(a: string, b: Uint8Array, c: bigint, d: bigint, e: number, f: bigint, g: bigint, h: Uint8Array, i: bigint): Promise<Uint8Array>
}, authority: FrozenGenerationV3, owner: string, recordIndex: number, file: RetrievalFile, rangeStart: bigint, rangeLength: bigint, nonce: bigint) {
  const range = decodeRangeV3(await cryptoWorker.retrievalV3Range(file.start_offset, file.size_bytes, rangeStart, rangeLength, authority.userMdus))
  const providers = concat(authority.providers.slice(0, 8).map(accountBytes))
  const plan = await cryptoWorker.retrievalV3Plan(range.first, range.last, range.population, providers)
  const planHash = await sha256(plan)
  const sessionId = await cryptoWorker.retrievalV3SessionId(authority.chainId, accountBytes(owner), authority.dealId, authority.generation, recordIndex, rangeStart, rangeLength, planHash, nonce)
  return { range, plan, planHash, sessionId: hex(sessionId), obligations: expectedObligationsV3(range, authority.providers) }
}

export function *planV3Chunks(session: Pick<FrozenSessionV3, 'authority' | 'sessionId' | 'contextHash' | 'first' | 'last'>, onlySlot?: number): Generator<RetrievalV3ChunkAuthority> {
  if (onlySlot !== undefined && (!Number.isSafeInteger(onlySlot) || onlySlot < 0 || onlySlot > 7)) throw new Error('invalid v3 chunk slot')
  for (let slot = 0; slot < 8; slot++) {
    if (onlySlot !== undefined && slot !== onlySlot) continue
    for (let userMdu = session.first / 64n; userMdu <= session.last / 64n; userMdu++) {
      const low = userMdu * 64n > session.first ? userMdu * 64n : session.first
      const high = userMdu * 64n + 63n < session.last ? userMdu * 64n + 63n : session.last
      const first = low + ((BigInt(slot) - low % 8n + 8n) % 8n)
      if (first > high) continue
      const entries = []
      for (let t = first; t <= high; t += 8n) {
        const leafIndex = slot * 8 + Number((t % 64n) / 8n)
        entries.push({ t, mduIndex: session.authority.metadataMdus + t / 64n, leafIndex,
          integrityPosition: (t / 64n) * 96n + BigInt(leafIndex) })
      }
      yield { ...session.authority, sessionId: session.sessionId, contextHash: session.contextHash, slot,
        mduIndex: session.authority.metadataMdus + userMdu, startBlobIndex: entries[0].leafIndex, entries }
    }
  }
}

function encodeContextV3(s: Omit<FrozenSessionV3, 'context'>): Uint8Array {
  return concat([lp('polystore/challenge-context/v3'), be(3, 4), lp(s.authority.chainId), unhex(s.authority.setupDigest, 32), unhex(s.sessionId, 32),
    accountBytes(s.owner), be(s.authority.dealId, 8), be(s.authority.generation, 8), unhex(s.authority.polyfsRoot, 32), unhex(s.authority.integrityRoot, 32),
    be(s.fileRecordIndex, 4), be(s.file.start_offset, 8), be(s.file.size_bytes, 8), be(s.rangeStart, 8), be(s.rangeLength, 8),
    new Uint8Array([2]), be(8, 4), be(4, 4), be(s.authority.metadataMdus, 8), be(s.authority.userMdus, 8), s.planHash,
    be(s.population, 8), be(s.sampleCount, 8), be(s.nonce, 8), lp(s.priceDenom), lp(s.pricePerBlob.toString()), lp(s.baseFee.toString()),
    be(s.completionBurnBps, 4), be(s.funding, 1), accountBytes(s.payer), be(s.snapshot, 8), be(s.anchor, 8), be(s.firstResponse, 8), be(s.deadline, 8), be(s.dealEnd, 8)])
}

export async function parseFrozenSessionV3(payload: unknown, height: bigint, authority: FrozenGenerationV3, expected: {
  sessionId: Hex; owner: string; recordIndex: number; file: RetrievalFile; rangeStart: bigint; rangeLength: bigint; nonce: bigint; planHash: Uint8Array
  frozenContextHash?: Uint8Array; deadline?: bigint; funding?: 1 | 2
  range(fileStart: bigint, fileLength: bigint, rangeStart: bigint, rangeLength: bigint, userMdus: bigint): Promise<Uint8Array>
  contextHash(context: Uint8Array): Promise<Uint8Array>
  seed(context: Uint8Array, anchor: Uint8Array): Promise<Uint8Array>
  challenges(context: Uint8Array, seed: Uint8Array): Promise<Uint8Array>
}): Promise<FrozenSessionV3> {
  const response = record(payload), raw = record(response.session)
  const sessionId = hex(protoBytes(raw.session_id, 32)), contextHash = protoBytes(raw.context_hash, 32), planHash = protoBytes(raw.plan_hash, 32)
  const owner = account(raw.owner), payer = account(raw.payer), funding = enumeration(raw.funding, ['RETRIEVAL_SESSION_FUNDING_UNSPECIFIED', 'RETRIEVAL_SESSION_FUNDING_DEAL_ESCROW', 'RETRIEVAL_SESSION_FUNDING_REQUESTER'])
  const obligationsRaw = raw.obligations
  if (!Array.isArray(obligationsRaw) || !obligationsRaw.length || obligationsRaw.length > 8) throw new Error('invalid v3 obligations')
  const obligations = obligationsRaw.map((value) => { const o = record(value); return { slot: protoUint(o.slot, 7), assigned: account(o.assigned_provider), payee: account(o.payee), blobCount: protoU64(o.blob_count), sampleCount: protoU64(o.sample_count), lockedFee: amount(o.locked_fee) } })
  const out: Omit<FrozenSessionV3, 'context'> = { authority, height, sessionId, contextHash, planHash, owner, payer,
    fileRecordIndex: protoUint(raw.file_record_index), file: expected.file, rangeStart: protoU64(raw.range_start), rangeLength: protoU64(raw.range_length),
    first: protoU64(raw.first_blob), last: protoU64(raw.last_blob), population: protoU64(raw.population), sampleCount: protoU64(raw.sample_count), nonce: protoU64(raw.nonce),
    priceDenom: typeof raw.price_denom === 'string' ? raw.price_denom : '', pricePerBlob: amount(raw.price_per_blob), baseFee: amount(raw.base_fee), completionBurnBps: protoUint(raw.completion_burn_bps, 10_000), funding: funding as 1 | 2,
    snapshot: protoU64(raw.snapshot_height), anchor: protoU64(raw.anchor_height), firstResponse: protoU64(raw.first_response_height), deadline: protoU64(raw.deadline_height), dealEnd: protoU64(raw.deal_end_height),
    obligations, acceptedBitmap: protoBytes(raw.accepted_sample_bitmap, 17), ackedMask: protoUint(raw.acked_slots_mask, 0xff), settledMask: protoUint(raw.settled_slots_mask, 0xff), refundedMask: protoUint(raw.refunded_slots_mask, 0xff),
    lockedFee: amount(raw.locked_fee), expired: raw.expired === true }
  const openedHeight = protoU64(raw.opened_height), updatedHeight = protoU64(raw.updated_height)
  if (sessionId !== expected.sessionId || owner !== expected.owner || payer !== owner || out.fileRecordIndex !== expected.recordIndex || protoU64(raw.deal_id) !== authority.dealId || protoU64(raw.generation) !== authority.generation ||
    hex(protoBytes(raw.polyfs_root, 32)) !== authority.polyfsRoot || hex(protoBytes(raw.integrity_root, 32)) !== authority.integrityRoot || hex(protoBytes(raw.setup_digest, 32)) !== authority.setupDigest ||
    protoU64(raw.file_start_offset) !== expected.file.start_offset || protoU64(raw.file_length) !== expected.file.size_bytes || out.rangeStart !== expected.rangeStart || out.rangeLength !== expected.rangeLength ||
    protoU64(raw.metadata_mdus) !== authority.metadataMdus || protoU64(raw.user_mdus) !== authority.userMdus || !equal(planHash, expected.planHash) || out.nonce !== expected.nonce || raw.chain_id !== authority.chainId ||
    funding !== 1 && funding !== 2 || (expected.funding !== undefined && funding !== expected.funding) ||
    (expected.deadline !== undefined && out.deadline !== expected.deadline) || !out.priceDenom || out.snapshot < authority.height || out.anchor !== out.snapshot + 1n || out.firstResponse !== out.snapshot + 2n || out.firstResponse > out.deadline || out.deadline > out.dealEnd || out.dealEnd !== authority.dealEnd || height < out.snapshot ||
    openedHeight !== out.snapshot || updatedHeight < openedHeight || updatedHeight > height || (out.acceptedBitmap[16] & 0xf0) !== 0) throw new Error('session does not match frozen v3 request')
  const checkedRange = decodeRangeV3(await expected.range(expected.file.start_offset, expected.file.size_bytes, expected.rangeStart, expected.rangeLength, authority.userMdus))
  if (out.first !== checkedRange.first || out.last !== checkedRange.last || out.population !== checkedRange.population) throw new Error('session has noncanonical v3 range')
  const expectedObligations = expectedObligationsV3(checkedRange, authority.providers)
  const represented = obligations.reduce((mask, o) => mask | (1 << o.slot), 0)
  let remaining = 0n, storedSamples = 0n
  for (const o of obligations) {
    if (o.lockedFee !== out.pricePerBlob * o.blobCount) throw new Error('session has noncanonical v3 obligation fee')
    storedSamples += o.sampleCount
    const bit = 1 << o.slot
    if (!(out.settledMask & bit) && !(out.refundedMask & bit)) remaining += o.lockedFee
  }
  const acceptedPastSamples = out.acceptedBitmap.some((byte, i) => {
    const first = BigInt(i * 8)
    if (first >= out.sampleCount) return byte !== 0
    const remaining = out.sampleCount - first
    return remaining < 8n && (byte & ~((1 << Number(remaining)) - 1)) !== 0
  })
  const stateMaterialized = out.acceptedBitmap.some(Boolean) || out.ackedMask !== 0 || out.settledMask !== 0
  if (out.sampleCount !== (out.population < 132n ? out.population : 132n) || obligations.length !== expectedObligations.length ||
    obligations.some((o, i) => o.slot !== expectedObligations[i].slot || o.assigned !== expectedObligations[i].assigned || o.payee !== o.assigned || o.blobCount !== expectedObligations[i].blobCount) ||
    ((out.ackedMask | out.settledMask | out.refundedMask) & ~represented) !== 0 || (out.settledMask & out.refundedMask) !== 0 ||
    (out.settledMask & ~out.ackedMask) !== 0 || remaining !== out.lockedFee || acceptedPastSamples ||
    (storedSamples !== 0n && storedSamples !== out.sampleCount) || (stateMaterialized && storedSamples === 0n)) throw new Error('session has noncanonical v3 plan')
  const context = encodeContextV3(out), computed = await expected.contextHash(context.slice())
  if (!equal(computed, contextHash) || (expected.frozenContextHash && !equal(contextHash, expected.frozenContextHash))) throw new Error('session context does not match frozen v3 authority')
  const anchor = rawAnchorSeed(response)
  if (anchor) {
    const seed = await expected.seed(context.slice(), anchor)
    const challenges = await expected.challenges(context.slice(), seed)
    if (challenges.byteLength !== Number(out.sampleCount) * 72) throw new Error('invalid v3 challenge partition')
    const counts = new Array<bigint>(8).fill(0n), view = new DataView(challenges.buffer, challenges.byteOffset, challenges.byteLength)
    for (let offset = 0; offset < challenges.byteLength; offset += 72) counts[view.getUint32(offset + 36)]++
    if (storedSamples !== 0n && obligations.some((o) => o.sampleCount !== counts[o.slot])) throw new Error('session sample partition does not match anchor')
  }
  return { ...out, context, ...(anchor ? { anchorSeed: anchor } : {}) }
}

function rawAnchorSeed(response: Record<string, unknown>): Uint8Array | null {
  if (response.anchor_seed == null || response.anchor_seed === '') return null
  return protoBytes(response.anchor_seed, 32)
}

function lcdSessionID(sessionId: Hex): string {
  return btoa(String.fromCharCode(...unhex(sessionId, 32))).replace(/\+/g, '-').replace(/\//g, '_')
}
export async function fetchSessionV3(lcd: string, authority: FrozenGenerationV3, expected: Parameters<typeof parseFrozenSessionV3>[3], signal?: AbortSignal, fetchFn: typeof fetch = fetch) {
  const result = await committedQuery(lcd, `/polystorechain/polystorechain/v1/retrieval-sessions-v3/${encodeURIComponent(lcdSessionID(expected.sessionId))}`, undefined, signal, fetchFn)
  return parseFrozenSessionV3(result.payload, result.height, authority, expected)
}
export async function fetchLatestNonceV3(lcd: string, owner: string, dealId: bigint, signal?: AbortSignal, fetchFn: typeof fetch = fetch) {
  const result = await committedQuery(lcd, `/polystorechain/polystorechain/v1/retrieval-sessions-v3/by-owner/${encodeURIComponent(account(owner))}/deals/${dealId}/nonce`, undefined, signal, fetchFn)
  const value = record(result.payload)
  if (value.found !== true && value.found !== false && value.found !== undefined) throw new Error('invalid v3 nonce response')
  const found = value.found === true
  const nonce = protoU64(value.nonce)
  if (!found && nonce !== 0n) throw new Error('invalid empty v3 nonce response')
  return { found, nonce, height: result.height }
}
export async function fetchSessionIDByNonceV3(lcd: string, owner: string, dealId: bigint, nonce: bigint, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<Hex | null> {
  try {
    const result = await committedQuery(lcd, `/polystorechain/polystorechain/v1/retrieval-sessions-v3/by-owner/${encodeURIComponent(account(owner))}/deals/${dealId}/nonces/${nonce}`, undefined, signal, fetchFn)
    return hex(protoBytes(record(result.payload).session_id, 32))
  } catch (error) {
    if (error instanceof Error && error.message === 'chain query failed (404)') return null
    throw error
  }
}

export const v3EncodedBlobBytes = BigInt(BLOB_SIZE_BYTES)
