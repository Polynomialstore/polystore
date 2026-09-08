import { RAW_MDU_CAPACITY_BYTES } from '../domain/polyfsLayout'
import { assertPolyfsRootCell } from './polyfsLocal'
import { RAW_BLOB_BYTES, equal, type FrozenSession, type PinnedGeneration, type RetrievalWindow } from './retrieval'
import { decodeRetrievalSlice } from './retrievalFlow'
import type { RetrievalCrypto } from './retrievalWire'

const RAW_MDU = BigInt(RAW_MDU_CAPACITY_BYTES)
export function witnessSpan(pin: PinnedGeneration, ordinal: bigint) {
  if (pin.layout !== 2 || ordinal < 0n || ordinal >= pin.userMdus || pin.leafCount < 64 || pin.leafCount > 16384) throw new Error('invalid recovery geometry')
  const total = pin.userMdus * BigInt(pin.leafCount * 48), start = ordinal * BigInt(pin.leafCount * 48), end = start + BigInt(pin.leafCount * 48)
  if (total > (pin.metadataMdus - 1n) * RAW_MDU) throw new Error('insufficient frozen witness extent')
  const first = start / RAW_MDU, last = (end - 1n) / RAW_MDU
  if (last - first > 1n) throw new Error('witness span exceeds bound')
  return { total, start, end, indices: first === last ? [first + 1n] : [first + 1n, last + 1n] }
}
export function verifyWitnessMdu(bytes: Uint8Array, cell: Uint8Array, crypto: RetrievalCrypto): void {
  if (bytes.length !== 8388608) throw new Error('incomplete witness MDU')
  const commitments = new Uint8Array(64 * 48)
  for (let i = 0; i < 64; i++) commitments.set(crypto.commit_received_blob(bytes.subarray(i * 131072, (i + 1) * 131072)), i * 48)
  assertPolyfsRootCell(new Uint8Array(crypto.compute_mdu_root(commitments) as ArrayLike<number>), cell)
}
export function readUserCommitments(pin: PinnedGeneration, ordinal: bigint, witness: readonly { index: bigint; bytes: Uint8Array }[], userCell: Uint8Array, crypto: RetrievalCrypto): Uint8Array {
  const span = witnessSpan(pin, ordinal)
  if (witness.length !== span.indices.length || witness.some((w, i) => w.index !== span.indices[i] || w.bytes.length !== 8388608)) throw new Error('wrong witness generation span')
  const out = new Uint8Array(pin.leafCount * 48)
  let cursor = span.start
  while (cursor < span.end) {
    const mduOrdinal = cursor / RAW_MDU, inMdu = Number(cursor % RAW_MDU), blob = Math.floor(inMdu / RAW_BLOB_BYTES)
    const blobStart = mduOrdinal * RAW_MDU + BigInt(blob * RAW_BLOB_BYTES)
    const remaining = span.total - blobStart, valid = Number(remaining < BigInt(RAW_BLOB_BYTES) ? remaining : BigInt(RAW_BLOB_BYTES))
    const offset = inMdu % RAW_BLOB_BYTES, count = Number(span.end - cursor < BigInt(valid - offset) ? span.end - cursor : BigInt(valid - offset))
    const source = witness.find((w) => w.index === mduOrdinal + 1n)!
    out.set(decodeRetrievalSlice(source.bytes.subarray(blob * 131072, (blob + 1) * 131072), valid, offset, count), Number(cursor - span.start))
    cursor += BigInt(count)
  }
  assertPolyfsRootCell(new Uint8Array(crypto.compute_mdu_root(out) as ArrayLike<number>), userCell)
  return out
}
export function verifyRecoveredMdu(pin: PinnedGeneration, bytes: Uint8Array, commitments: Uint8Array, crypto: RetrievalCrypto): void {
  if (bytes.length !== 8388608 || commitments.length !== pin.leafCount * 48) throw new Error('incomplete recovered MDU')
  for (let blob = 0; blob < 64; blob++) {
    const leaf = (blob % pin.k) * pin.rows + Math.floor(blob / pin.k)
    if (!equal(crypto.commit_received_blob(bytes.subarray(blob * 131072, (blob + 1) * 131072)), commitments.subarray(leaf * 48, (leaf + 1) * 48))) throw new Error('reconstructed bytes do not match authenticated data commitments')
  }
}
export function recoveryWindows(pin: PinnedGeneration, ordinal: bigint): RetrievalWindow[] {
  witnessSpan(pin, ordinal)
  const windows = pin.assignments.flatMap((assignment, slot) => assignment.active ? [{ mduIndex: pin.metadataMdus + ordinal, slot, provider: assignment.provider, startBlobIndex: slot * pin.rows, blobCount: pin.rows, slices: [] }] : [])
  if (windows.length < pin.k) throw new Error('fewer than K active recovery assignments before payment')
  return windows
}
export interface RecoveryFlow {
  open(windows: readonly RetrievalWindow[]): Promise<readonly FrozenSession[]>
  fetchAndVerify(session: FrozenSession): Promise<Uint8Array>
  reconstructAndVerify(shards: (Uint8Array | null)[]): Promise<Uint8Array>
  consumeAndFlush(bytes: Uint8Array): Promise<void>
  confirm(sessions: readonly FrozenSession[]): Promise<void>
}
// At most K input shards (8MiB), one recovery output and K accepted contexts.
// A failed slot is replaced only by opening another separately funded session.
export async function recoverRetrievalMdu(pin: PinnedGeneration, ordinal: bigint, flow: RecoveryFlow, signal?: AbortSignal): Promise<Uint8Array> {
  const candidates = recoveryWindows(pin, ordinal), shards: (Uint8Array | null)[] = Array(pin.k + pin.m).fill(null), accepted: FrozenSession[] = []
  let next = 0, failure: unknown
  while (accepted.length < pin.k && next < candidates.length) {
    signal?.throwIfAborted()
    const batch = candidates.slice(next, next + pin.k - accepted.length); next += batch.length
    const sessions = await flow.open(batch)
    if (sessions.length !== batch.length || sessions.some((s, i) => s.window.mduIndex !== batch[i].mduIndex || s.window.provider !== batch[i].provider || s.window.startBlobIndex !== batch[i].startBlobIndex || s.window.blobCount !== batch[i].blobCount)) throw new Error('wrong recovery session order')
    for (let i = 0; i < sessions.length; i++) {
      signal?.throwIfAborted()
      try {
        const bytes = await flow.fetchAndVerify(sessions[i]); signal?.throwIfAborted()
        if (bytes.length !== pin.rows * 131072) throw new Error('incomplete recovery slot')
        shards[batch[i].slot] = bytes; accepted.push(sessions[i])
      } catch (error) { signal?.throwIfAborted(); failure = error }
    }
  }
  if (accepted.length !== pin.k) throw failure ?? new Error('insufficient authenticated recovery shards')
  const bytes = await flow.reconstructAndVerify(shards)
  signal?.throwIfAborted()
  await flow.consumeAndFlush(bytes)
  signal?.throwIfAborted()
  await flow.confirm(accepted)
  return bytes
}

export interface RecoveryMetadataReader {
  fetch(index: bigint): Promise<Uint8Array>
  verifyWitness(bytes: Uint8Array, cell: Uint8Array): Promise<Uint8Array>
  readCommitments(pin: PinnedGeneration, ordinal: bigint, witness: { index: bigint; bytes: Uint8Array }[], cell: Uint8Array): Promise<Uint8Array>
}
// Keep only the at-most-two witness MDUs intersecting this user's commitment
// list. Each enclosing MDU and the extracted list have separate root checks.
export async function fetchRecoveryCommitments(pin: PinnedGeneration, ordinal: bigint, mdu0: Uint8Array, reader: RecoveryMetadataReader, signal?: AbortSignal): Promise<Uint8Array> {
  if (mdu0.length !== 8388608) throw new Error('missing authenticated MDU0')
  const cell = (index: bigint) => mdu0.slice(Number(index - 1n) * 32, Number(index) * 32)
  const witness: { index: bigint; bytes: Uint8Array }[] = []
  for (const index of witnessSpan(pin, ordinal).indices) {
    signal?.throwIfAborted()
    witness.push({ index, bytes: await reader.verifyWitness(await reader.fetch(index), cell(index)) })
  }
  signal?.throwIfAborted()
  return reader.readCommitments(pin, ordinal, witness, cell(pin.metadataMdus + ordinal))
}
