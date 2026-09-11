import { RAW_MDU_CAPACITY_BYTES } from '../domain/polyfsLayout'
import { BLOB_SIZE_BYTES, MDU_SIZE_BYTES, parsePolyfsRecordsFromAuthenticatedMdu0, parsePolyfsRecordsFromMdu0, readPolyfsFatRange } from './polyfsLocal'
import { base64, equal, hex, readBoundedResponse, record, u64, uint, unhex, type FrozenSession, type PinnedGeneration } from './retrieval'

export const RETRIEVAL_METADATA_LIMIT = 128 * 1024
export const RETRIEVAL_FRAMING_LIMIT = 16 * 1024
export const RETRIEVAL_ACCEPT = 'multipart/form-data; version=2'
export const RETRIEVAL_V3_ACCEPT = 'multipart/form-data; version=3'
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export interface RetrievalCrypto {
  commit_received_blob(bytes: Uint8Array): Uint8Array
  compute_mdu_root(commitments: Uint8Array): unknown
  verify_polyfs_session_batch(bytes: Uint8Array): boolean
}
export interface ChallengeCrypto {
  challenge_context_hash(context: Uint8Array): Uint8Array
  derive_challenges(context: Uint8Array, seed: Uint8Array): Uint8Array
}
export interface WindowProof {
  mdu: bigint; blob: number; root: Uint8Array; rootCommitment: Uint8Array; rootOpening: Uint8Array
  commitment: Uint8Array; z: Uint8Array; y: Uint8Array; opening: Uint8Array
  rootPath: Uint8Array[]; blobPath: Uint8Array[]
}
export interface RetrievalEnvelope { bytes: Uint8Array; proofs: WindowProof[] }
export interface RetrievalV3Crypto extends RetrievalCrypto {
  verify_fat_v3_header(bytes: Uint8Array, integrityRoot: Uint8Array, leafCount: bigint): number
  verify_integrity_v3_blob(mduIndex: bigint, leafIndex: number, position: bigint, leafCount: bigint,
    blob: Uint8Array, path: Uint8Array, integrityRoot: Uint8Array): boolean
}
export interface RetrievalV3GenerationAuthority {
  polyfsRoot: `0x${string}`; integrityRoot: `0x${string}`; integrityLeafCount: bigint; metadataMdus: bigint; userMdus: bigint
}
export interface RetrievalV3EntryAuthority {
  t: bigint; mduIndex: bigint; leafIndex: number; integrityPosition: bigint
}
export interface RetrievalV3ChunkAuthority extends RetrievalV3GenerationAuthority {
  sessionId: `0x${string}`; contextHash: Uint8Array; slot: number; mduIndex: bigint; startBlobIndex: number
  entries: readonly RetrievalV3EntryAuthority[]
}
export interface RetrievalV3Envelope {
  bytes: Uint8Array
  entries: (RetrievalV3EntryAuthority & { integrityPath: Uint8Array[] })[]
}

function validateV3ChunkAuthority(authority: RetrievalV3ChunkAuthority): void {
  validateV3GenerationAuthority(authority)
  unhex(authority.sessionId, 32)
  if (!authority.entries.length || authority.entries.length > 8 || uint(authority.slot, 7) !== authority.slot || uint(authority.startBlobIndex, 95) !== authority.startBlobIndex ||
    !(authority.contextHash instanceof Uint8Array) || authority.contextHash.length !== 32 || authority.entries.some((entry, i) => entry.mduIndex !== authority.mduIndex || entry.leafIndex !== authority.startBlobIndex + i)) {
    throw new Error('invalid frozen v3 authority')
  }
}

function exactKeys(object: Record<string, unknown>, keys: string[]) {
  if (Object.keys(object).some((key) => !keys.includes(key))) throw new Error('unknown response field')
}
function pathDepth(index: number, count: number): number {
  let depth = 0
  while (count > 1) { if ((index ^ 1) < count) depth++; index = Math.floor(index / 2); count = Math.ceil(count / 2) }
  return depth
}
export function parseWindowProof(value: unknown, leafCount: number): WindowProof {
  const p = record(value)
  exactKeys(p, ['mdu_index', 'blob_index', 'mdu_root_fr', 'root_table_du_commitment', 'manifest_opening', 'blob_commitment', 'z_value', 'y_value', 'kzg_opening_proof', 'root_table_du_merkle_path', 'merkle_path'])
  const mdu = uint(p.mdu_index, 65536), blob = uint(p.blob_index === undefined ? 0 : p.blob_index, leafCount - 1)
  if (!mdu) throw new Error('invalid proof MDU')
  const path = (value: unknown, length: number) => {
    if (!Array.isArray(value) || value.length !== length) throw new Error('invalid Merkle path length')
    return value.map((v) => base64(v, 32))
  }
  return { mdu: BigInt(mdu), blob, root: base64(p.mdu_root_fr, 32), rootCommitment: base64(p.root_table_du_commitment, 48),
    rootOpening: base64(p.manifest_opening, 48), commitment: base64(p.blob_commitment, 48), z: base64(p.z_value, 32),
    y: base64(p.y_value, 32), opening: base64(p.kzg_opening_proof, 48), rootPath: path(p.root_table_du_merkle_path, 6), blobPath: path(p.merkle_path, pathDepth(blob, leafCount)) }
}

// Bound bytes before using the platform multipart parser. Exactly two ordered
// parts are allowed; preambles, epilogues and additional delimiters are rejected.
async function parseMultipartRetrieval(response: Response, version: 2 | 3, expectedBytes: number, signal?: AbortSignal): Promise<{ metadata: unknown; bytes: Uint8Array }> {
  if (!response.ok || !Number.isSafeInteger(expectedBytes) || expectedBytes < BLOB_SIZE_BYTES || expectedBytes > 8 * 1024 * 1024) {
    await response.body?.cancel(); throw new Error('invalid retrieval response')
  }
  const contentType = response.headers.get('content-type') || ''
  const fields = contentType.split(';').map((v) => v.trim())
  const boundaryField = fields.find((v) => v.startsWith('boundary='))
  const boundary = boundaryField?.slice(9).replace(/^"([^"\\]+)"$/, '$1')
  if (fields.length !== 3 || fields[0].toLowerCase() !== 'multipart/form-data' || !fields.includes(`version=${version}`) || !boundary || !/^[A-Za-z0-9'()+_,\-./:=?]{1,70}$/.test(boundary)) {
    await response.body?.cancel(); throw new Error('unsupported secured retrieval content type')
  }
  const body = await readBoundedResponse(response, expectedBytes + RETRIEVAL_METADATA_LIMIT + RETRIEVAL_FRAMING_LIMIT, signal)
  const find = (needle: Uint8Array, start: number) => {
    outer: for (let i = start; i <= body.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (body[i + j] !== needle[j]) continue outer
      return i
    }
    return -1
  }
  const encode = (text: string) => new TextEncoder().encode(text)
  const first = encode(`--${boundary}\r\n`), middle = encode(`\r\n--${boundary}\r\n`), last = encode(`\r\n--${boundary}--`), headerEnd = encode('\r\n\r\n')
  const split = find(middle, first.length), close = find(last, first.length)
  if (!equal(body.subarray(0, first.length), first) || split < 0 || close < split || find(middle, split + middle.length) >= 0 ||
    !(close + last.length === body.length || (close + last.length + 2 === body.length && body[body.length - 2] === 13 && body[body.length - 1] === 10))) throw new Error('invalid multipart framing')
  const h1 = find(headerEnd, first.length), h2 = find(headerEnd, split + middle.length)
  if (h1 < first.length || h1 - first.length > 4096 || h1 >= split || h2 < split + middle.length || h2 - split - middle.length > 4096 || h2 >= close ||
    split - h1 - 4 > RETRIEVAL_METADATA_LIMIT || close - h2 - 4 !== expectedBytes) throw new Error('invalid multipart part size')
  const form = await new Response(body.slice().buffer, { headers: { 'content-type': contentType } }).formData()
  const entries = [...form.entries()]
  if (entries.length !== 2 || entries[0][0] !== 'metadata' || entries[1][0] !== 'bytes' || typeof entries[0][1] !== 'string' || typeof entries[1][1] === 'string' || entries[1][1].type !== 'application/octet-stream') throw new Error('invalid multipart parts')
  // Parse original bytes with fatal UTF-8: FormData's string decoding is lossy.
  const metadataHeader = decoder.decode(body.subarray(first.length, h1)).toLowerCase().split('\r\n')
  if (metadataHeader.filter((v) => v === 'content-type: application/json').length !== 1) throw new Error('invalid metadata content type')
  const metadata: unknown = JSON.parse(decoder.decode(body.subarray(h1 + 4, split)))
  signal?.throwIfAborted()
  return { metadata, bytes: body.slice(h2 + 4, close) }
}

export async function parseRetrievalEnvelope(response: Response, session: FrozenSession, signal?: AbortSignal): Promise<RetrievalEnvelope> {
  const expectedBytes = session.window.blobCount * BLOB_SIZE_BYTES
  const parsed = await parseMultipartRetrieval(response, 2, expectedBytes, signal)
  const raw = parsed.metadata
  const m = record(raw)
  exactKeys(m, ['version', 'session_id', 'context_hash', 'manifest_root', 'start_mdu_index', 'start_blob_index', 'blob_count', 'total_bytes', 'proofs'])
  if (uint(m.version) !== 2 || m.session_id !== session.sessionId || m.context_hash !== hex(session.contextHash) || m.manifest_root !== session.pin.root ||
    u64(m.start_mdu_index) !== session.window.mduIndex || uint(m.start_blob_index) !== session.window.startBlobIndex ||
    u64(m.blob_count) !== BigInt(session.window.blobCount) || u64(m.total_bytes) !== BigInt(expectedBytes) ||
    !Array.isArray(m.proofs) || m.proofs.length !== session.window.blobCount) throw new Error('response does not match frozen session')
  return { bytes: parsed.bytes, proofs: m.proofs.map((p) => parseWindowProof(p, session.pin.leafCount)) }
}

function parseIntegrityPath(value: unknown): Uint8Array[] {
  if (!Array.isArray(value) || value.length > 23) throw new Error('invalid v3 integrity path')
  return value.map((sibling) => unhex(sibling, 32))
}

export async function parseRetrievalEnvelopeV3(response: Response, authority: RetrievalV3ChunkAuthority, signal?: AbortSignal): Promise<RetrievalV3Envelope> {
  validateV3ChunkAuthority(authority)
  const expectedBytes = authority.entries.length * BLOB_SIZE_BYTES
  const parsed = await parseMultipartRetrieval(response, 3, expectedBytes, signal)
  const m = record(parsed.metadata)
  exactKeys(m, ['version', 'session_id', 'context_hash', 'polyfs_root', 'integrity_root', 'slot', 'mdu_index', 'start_blob_index', 'blob_count', 'total_bytes', 'entries'])
  if (uint(m.version) !== 3 || m.session_id !== authority.sessionId || !equal(unhex(m.context_hash, 32), authority.contextHash) ||
    m.polyfs_root !== authority.polyfsRoot || m.integrity_root !== authority.integrityRoot || uint(m.slot, 7) !== authority.slot ||
    u64(m.mdu_index) !== authority.mduIndex || uint(m.start_blob_index, 95) !== authority.startBlobIndex ||
    u64(m.blob_count) !== BigInt(authority.entries.length) || u64(m.total_bytes) !== BigInt(expectedBytes) || !Array.isArray(m.entries) || m.entries.length !== authority.entries.length) {
    throw new Error('response does not match frozen v3 authority')
  }
  const entries = m.entries.map((raw, i) => {
    const entry = record(raw), expected = authority.entries[i]
    exactKeys(entry, ['t', 'mdu_index', 'leaf_index', 'integrity_position', 'integrity_path'])
    if (u64(entry.t) !== expected.t || u64(entry.mdu_index) !== expected.mduIndex || uint(entry.leaf_index, 95) !== expected.leafIndex ||
      u64(entry.integrity_position) !== expected.integrityPosition) throw new Error('v3 entry does not match frozen authority')
    return { ...expected, integrityPath: parseIntegrityPath(entry.integrity_path) }
  })
  return { bytes: parsed.bytes, entries }
}

export function encodeSessionBatch(proofs: WindowProof[], root: Uint8Array, contextHash: Uint8Array, seed: Uint8Array, leafCount: number): Uint8Array {
  if (!proofs.length || proofs.length > 64 || root.length !== 32 || contextHash.length !== 32 || seed.length !== 32 || leafCount < 64 || leafCount > 16384) throw new Error('invalid batch shape')
  const size = 106 + proofs.reduce((n, p) => n + 304 + 32 * (p.rootPath.length + p.blobPath.length), 0)
  if (size > 60522) throw new Error('batch exceeds limit')
  const out = new Uint8Array(size), view = new DataView(out.buffer)
  let offset = 0
  const bytes = (v: Uint8Array) => { out.set(v, offset); offset += v.length }
  const num = (v: number | bigint, n: number) => { if (n === 8) view.setBigUint64(offset, BigInt(v)); else if (n === 4) view.setUint32(offset, Number(v)); else view.setUint16(offset, Number(v)); offset += n }
  bytes(new TextEncoder().encode('PSB1')); num(proofs.length, 2); num(leafCount, 4); bytes(root); bytes(contextHash); bytes(seed)
  for (const p of proofs) {
    num(p.mdu, 8); num(p.blob, 4); bytes(p.root); bytes(p.rootCommitment); bytes(p.rootOpening); bytes(p.commitment); bytes(p.z); bytes(p.y); bytes(p.opening)
    num(p.rootPath.length, 2); num(p.blobPath.length, 2)
    for (const sibling of [...p.rootPath, ...p.blobPath]) bytes(sibling)
  }
  if (offset !== out.length) throw new Error('inconsistent batch encoding')
  return out
}

export function verifyRetrievalWindow(session: FrozenSession, envelope: RetrievalEnvelope, crypto: RetrievalCrypto, challenge: ChallengeCrypto): Uint8Array {
  const { window, seed, context, contextHash } = session
  if (!seed || session.height < session.openedHeight + 2n || session.height > session.expiry || envelope.proofs.length !== window.blobCount || envelope.bytes.length !== window.blobCount * BLOB_SIZE_BYTES ||
    !equal(challenge.challenge_context_hash(context), contextHash)) throw new Error('challenge not ready or mismatched')
  const selected = challenge.derive_challenges(context, seed)
  if (selected.length !== window.blobCount * 60) throw new Error('incomplete challenge coverage')
  const view = new DataView(selected.buffer, selected.byteOffset, selected.byteLength)
  envelope.proofs.forEach((p, i) => {
    const offset = i * 60
    if (view.getBigUint64(offset) !== BigInt(i) || view.getBigUint64(offset + 16) !== p.mdu || view.getUint32(offset + 24) !== p.blob ||
      p.mdu !== window.mduIndex || p.blob !== window.startBlobIndex + i || !equal(selected.subarray(offset + 28, offset + 60), p.z)) throw new Error('proof does not match selected challenge')
  })
  if (!crypto.verify_polyfs_session_batch(encodeSessionBatch(envelope.proofs, unhex(session.pin.root, 32), contextHash, seed, session.pin.leafCount))) throw new Error('invalid retrieval proof')
  envelope.proofs.forEach((p, i) => {
    if (!equal(crypto.commit_received_blob(envelope.bytes.subarray(i * BLOB_SIZE_BYTES, (i + 1) * BLOB_SIZE_BYTES)), p.commitment)) throw new Error('received bytes do not match proof')
  })
  return envelope.bytes
}

export type RetrievalMetadataGeneration = Pick<PinnedGeneration, 'root' | 'userMdus'>

export function verifyRetrievalMetadata(bytes: Uint8Array, pin: RetrievalMetadataGeneration, crypto: RetrievalCrypto) {
  const records = parsePolyfsRecordsFromMdu0(bytes)
  const commitments = new Uint8Array(64 * 48)
  for (let i = 0; i < 64; i++) commitments.set(crypto.commit_received_blob(bytes.subarray(i * BLOB_SIZE_BYTES, (i + 1) * BLOB_SIZE_BYTES)), i * 48)
  const result = crypto.compute_mdu_root(commitments)
  const root = result instanceof Uint8Array ? result : new Uint8Array(result as ArrayLike<number>)
  if (hex(root) !== pin.root) throw new Error('metadata does not match pinned generation')
  const capacity = pin.userMdus * BigInt(RAW_MDU_CAPACITY_BYTES)
  if (records.some((r) => r.start_offset + r.size_bytes > capacity)) throw new Error('file extent exceeds pinned generation')
  return records
}

function validateV3GenerationAuthority(authority: RetrievalV3GenerationAuthority): { polyfsRoot: Uint8Array; integrityRoot: Uint8Array } {
  const polyfsRoot = unhex(authority.polyfsRoot, 32), integrityRoot = unhex(authority.integrityRoot, 32)
  if (authority.metadataMdus < 2n || authority.metadataMdus > 65536n || authority.userMdus < 1n ||
    authority.userMdus > 65537n - authority.metadataMdus || authority.integrityLeafCount !== authority.userMdus * 96n) {
    throw new Error('invalid frozen v3 generation authority')
  }
  return { polyfsRoot, integrityRoot }
}

export function verifyRetrievalMetadataV3(bytes: Uint8Array, authority: RetrievalV3GenerationAuthority, crypto: RetrievalV3Crypto) {
  const roots = validateV3GenerationAuthority(authority)
  if (bytes.byteLength !== MDU_SIZE_BYTES) throw new Error('invalid MDU0 size')
  const commitments = new Uint8Array(64 * 48)
  for (let i = 0; i < 64; i++) commitments.set(crypto.commit_received_blob(bytes.subarray(i * BLOB_SIZE_BYTES, (i + 1) * BLOB_SIZE_BYTES)), i * 48)
  const result = crypto.compute_mdu_root(commitments)
  const root = result instanceof Uint8Array ? result : new Uint8Array(result as ArrayLike<number>)
  if (!equal(root, roots.polyfsRoot)) throw new Error('metadata does not match frozen v3 generation')
  // Only bytes authenticated by the frozen PolyFS root reach the FAT parser.
  const count = crypto.verify_fat_v3_header(readPolyfsFatRange(bytes, 0, 128), roots.integrityRoot, authority.integrityLeafCount)
  const records = parsePolyfsRecordsFromAuthenticatedMdu0(bytes, count)
  const capacity = authority.userMdus * BigInt(RAW_MDU_CAPACITY_BYTES)
  if (records.some((record) => record.start_offset + record.size_bytes > capacity)) throw new Error('file extent exceeds frozen v3 generation')
  return records
}

export function verifyRetrievalDataV3(authority: RetrievalV3ChunkAuthority, envelope: RetrievalV3Envelope, crypto: RetrievalV3Crypto): Uint8Array {
  validateV3ChunkAuthority(authority)
  const integrityRoot = unhex(authority.integrityRoot, 32)
  if (envelope.entries.length !== authority.entries.length || envelope.bytes.byteLength !== authority.entries.length * BLOB_SIZE_BYTES) throw new Error('incomplete v3 retrieval bytes')
  envelope.entries.forEach((entry, i) => {
    if (entry.integrityPath.length > 23) throw new Error('retrieval v3 integrity path exceeds protocol depth')
    const expected = authority.entries[i]
    const tOffset = expected.t % 64n
    const mdu = authority.metadataMdus + expected.t / 64n
    const slot = Number(tOffset % 8n)
    const leaf = slot * 8 + Number(tOffset / 8n)
    const position = (mdu - authority.metadataMdus) * 96n + BigInt(leaf)
    if (expected.mduIndex !== authority.mduIndex || expected.mduIndex !== mdu || expected.leafIndex !== leaf || slot !== authority.slot ||
      expected.leafIndex !== authority.startBlobIndex + i || expected.integrityPosition !== position || position >= authority.integrityLeafCount ||
      entry.t !== expected.t || entry.mduIndex !== expected.mduIndex || entry.leafIndex !== expected.leafIndex || entry.integrityPosition !== expected.integrityPosition) {
      throw new Error('noncanonical frozen v3 coordinate')
    }
    const path = new Uint8Array(entry.integrityPath.length * 32)
    entry.integrityPath.forEach((sibling, j) => {
      if (sibling.byteLength !== 32) throw new Error('invalid v3 integrity path')
      path.set(sibling, j * 32)
    })
    const blob = envelope.bytes.subarray(i * BLOB_SIZE_BYTES, (i + 1) * BLOB_SIZE_BYTES)
    if (!crypto.verify_integrity_v3_blob(mdu, leaf, position, authority.integrityLeafCount, blob, path, integrityRoot)) {
      throw new Error('v3 retrieval bytes failed integrity verification')
    }
  })
  return envelope.bytes
}
