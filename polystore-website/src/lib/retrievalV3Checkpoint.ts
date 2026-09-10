import { createRetrievalOutput, removeRetrievalOutput } from './retrievalFlow'
import { planV3Chunks, RETRIEVAL_V3_SETUP, sameFrozenGenerationV3, sameFrozenRetrievalRequestV3, type FrozenGenerationV3, type FrozenSessionV3 } from './retrievalV3'
import { retrievalV3OutputComplete } from './retrievalV3Flow'
import { account, type RetrievalFile } from './retrieval'
import { browserRetrievalStore, retrievalIntentKey, retrievalV3OpenTransactionKey, withRetrievalLock, type BrowserTransaction, type RetrievalStore } from './retrievalTransactions'

const SETTLED_CACHE_KEY = 'output-v3:settled-cache'
export interface SettledRetrievalV3Cache {
  version: 1
  key: string
  id: string
  length: bigint
  dealId: bigint
  filePath: string
}

export interface RetrievalV3CheckpointState {
  version: 3
  id: string
  length: bigint
  authority: FrozenGenerationV3
  fileRecordIndex: number
  file: RetrievalFile
  rangeStart: bigint
  rangeLength: bigint
  requestRangeStart: number | null
  requestRangeLength: number | null
  requester: string
  session?: FrozenSessionV3
  cursors: Partial<Record<number, bigint>>
}

export async function retrievalV3CheckpointKey(intent: unknown): Promise<string> {
  return 'output-v3:' + await retrievalIntentKey(intent)
}

export async function retrievalV3DownloadCheckpointKey(scope: unknown, dealId: string, filePath: string,
  rangeStart: number | undefined, rangeLen: number | undefined, deputy: string | undefined): Promise<string> {
  return retrievalV3CheckpointKey([scope, 'download-v3', dealId, filePath, rangeStart ?? null, rangeLen ?? null, deputy])
}

function validateSettledCache(entry: SettledRetrievalV3Cache): SettledRetrievalV3Cache {
  if (entry.version !== 1 || !/^output-v3:[0-9a-f]{64}$/.test(entry.key) || !/^[0-9a-f-]{36}$/.test(entry.id) ||
    typeof entry.length !== 'bigint' || entry.length < 0n || entry.length > 1n << 30n || typeof entry.dealId !== 'bigint' ||
    entry.dealId < 0n || typeof entry.filePath !== 'string' || !entry.filePath) throw new Error('invalid settled v3 retrieval cache')
  return entry
}

function readSettledCache(store: RetrievalStore): SettledRetrievalV3Cache | undefined {
  const entry = store.get<SettledRetrievalV3Cache>(SETTLED_CACHE_KEY)
  if (!entry) return undefined
  return validateSettledCache(entry)
}

export function hasSettledRetrievalV3Cache(dealId: bigint, filePath: string,
  key?: string, store: RetrievalStore = browserRetrievalStore()): boolean {
  try {
    const entry = readSettledCache(store)
    return entry?.dealId === dealId && entry.filePath === filePath && (key === undefined || entry.key === key)
  } catch { return false }
}

async function withAvailableCheckpointLock<T>(key: string, run: () => Promise<T>): Promise<T | undefined> {
  return navigator.locks.request(key, { ifAvailable: true }, (lock) => lock ? run() : undefined)
}

async function removeSettledCacheEntry(entry: SettledRetrievalV3Cache, store: RetrievalStore,
  removeOutput: (id: string) => Promise<void>): Promise<boolean> {
  return (await withAvailableCheckpointLock(entry.key, async () => {
    const checkpoint = readRetrievalV3Checkpoint(entry.key, store)
    if (!checkpoint || checkpoint.id !== entry.id || checkpoint.length !== entry.length || !checkpoint.session ||
      checkpoint.session.lockedFee !== 0n || !retrievalV3OutputComplete(checkpoint.session, checkpoint.cursors)) {
      throw new Error('settled v3 retrieval cache does not reference a completed output')
    }
    await removeOutput(entry.id)
    store.remove(entry.key)
    return true
  })) ?? false
}

export async function retainSettledRetrievalV3Cache(entry: SettledRetrievalV3Cache,
  store: RetrievalStore = browserRetrievalStore(), removeOutput = removeRetrievalOutput): Promise<boolean> {
  validateSettledCache(entry)
  return withRetrievalLock(SETTLED_CACHE_KEY, async () => {
    const previous = readSettledCache(store)
    if (previous?.key === entry.key && (previous.id !== entry.id || previous.length !== entry.length ||
      previous.dealId !== entry.dealId || previous.filePath !== entry.filePath)) return false
    if (previous && previous.key !== entry.key && !await removeSettledCacheEntry(previous, store, removeOutput)) return false
    store.put(SETTLED_CACHE_KEY, entry)
    return true
  })
}

export async function purgeSettledRetrievalV3Cache(dealId: bigint, filePath: string,
  store: RetrievalStore = browserRetrievalStore(), removeOutput = removeRetrievalOutput): Promise<boolean> {
  return withRetrievalLock(SETTLED_CACHE_KEY, async () => {
    const entry = readSettledCache(store)
    if (!entry || entry.dealId !== dealId || entry.filePath !== filePath) return false
    if (!await removeSettledCacheEntry(entry, store, removeOutput)) return false
    store.remove(SETTLED_CACHE_KEY)
    return true
  })
}

export async function purgeSettledRetrievalV3CacheForKey(dealId: bigint, filePath: string, key: string,
  store: RetrievalStore = browserRetrievalStore(), removeOutput = removeRetrievalOutput): Promise<boolean> {
  return withRetrievalLock(SETTLED_CACHE_KEY, async () => {
    const entry = readSettledCache(store)
    if (!entry || entry.dealId !== dealId || entry.filePath !== filePath || entry.key !== key) return false
    if (!await removeSettledCacheEntry(entry, store, removeOutput)) return false
    store.remove(SETTLED_CACHE_KEY)
    return true
  })
}

export function retrievalV3CheckpointMatchesCurrent(state: RetrievalV3CheckpointState, generation: string | undefined,
  manifestRoot: string, files: readonly { path: string; start_offset: number | bigint; size_bytes: number | bigint }[] | null): boolean {
  return state.authority.generation.toString() === String(generation || '') && state.authority.polyfsRoot === manifestRoot.toLowerCase() &&
    Boolean(files?.some((file) => file.path === state.file.path && BigInt(file.start_offset) === state.file.start_offset &&
      BigInt(file.size_bytes) === state.file.size_bytes))
}

function sameFile(a: RetrievalFile, b: RetrievalFile): boolean {
  return a.path === b.path && a.start_offset === b.start_offset && a.size_bytes === b.size_bytes && a.flags === b.flags
}

type FrozenRetrievalRequestV3 = Parameters<typeof sameFrozenRetrievalRequestV3>[0]
function isFrozenRetrievalRequestV3(value: unknown): value is FrozenRetrievalRequestV3 {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Partial<FrozenRetrievalRequestV3>, authority = request.authority as Partial<FrozenGenerationV3> | undefined
  return Boolean(authority && typeof authority.chainId === 'string' && typeof authority.height === 'bigint' && typeof authority.dealId === 'bigint' &&
    typeof authority.generation === 'bigint' && typeof authority.owner === 'string' && typeof authority.dealEnd === 'bigint' &&
    typeof authority.polyfsRoot === 'string' && typeof authority.integrityRoot === 'string' && typeof authority.setupDigest === 'string' &&
    typeof authority.integrityLeafCount === 'bigint' && typeof authority.metadataMdus === 'bigint' && typeof authority.userMdus === 'bigint' &&
    typeof authority.totalMdus === 'bigint' && typeof authority.witnessMdus === 'bigint' && typeof authority.retrievalPolicyMode === 'number' &&
    Array.isArray(authority.providers) && authority.providers.every((provider) => typeof provider === 'string') &&
    Number.isSafeInteger(request.recordIndex) && request.file && typeof request.file.path === 'string' && typeof request.file.start_offset === 'bigint' &&
    typeof request.file.size_bytes === 'bigint' && Number.isSafeInteger(request.file.flags) && typeof request.rangeStart === 'bigint' && typeof request.rangeLength === 'bigint')
}

function sessionMatchesState(state: RetrievalV3CheckpointState, session: FrozenSessionV3): boolean {
  return sameFrozenGenerationV3(state.authority, session.authority) && state.fileRecordIndex === session.fileRecordIndex &&
    sameFile(state.file, session.file) && state.rangeStart === session.rangeStart && state.rangeLength === session.rangeLength
}

function cursorIsChunkBoundary(session: FrozenSessionV3, slot: number, through: bigint): boolean {
  if (through < 0n || through % 8n !== BigInt(slot)) return false
  for (const chunk of planV3Chunks(session, slot)) if (chunk.entries[chunk.entries.length - 1].t === through) return true
  return false
}

export function readRetrievalV3Checkpoint(key: string, store: RetrievalStore = browserRetrievalStore()): RetrievalV3CheckpointState | undefined {
  const saved = store.get<RetrievalV3CheckpointState>(key)
  if (!saved) return undefined
  if (saved.version !== 3 || typeof saved.id !== 'string' || !saved.id || typeof saved.length !== 'bigint' || saved.length < 0n || saved.length > 1n << 30n ||
    typeof saved.rangeStart !== 'bigint' || typeof saved.rangeLength !== 'bigint' || saved.rangeLength !== saved.length || !saved.authority || !saved.file ||
    (saved.requestRangeStart !== null && (!Number.isSafeInteger(saved.requestRangeStart) || saved.requestRangeStart < 0 || BigInt(saved.requestRangeStart) !== saved.rangeStart)) ||
    (saved.requestRangeLength !== null && (!Number.isSafeInteger(saved.requestRangeLength) || saved.requestRangeLength < 0 ||
      (saved.requestRangeLength !== 0 && BigInt(saved.requestRangeLength) !== saved.rangeLength))) ||
    typeof saved.requester !== 'string' || account(saved.requester) !== saved.requester || (saved.session !== undefined && saved.session.owner !== saved.requester) ||
    !Number.isSafeInteger(saved.fileRecordIndex) || saved.fileRecordIndex < 0 || typeof saved.cursors !== 'object' || saved.cursors === null ||
    (saved.session !== undefined && !sessionMatchesState(saved, saved.session)) ||
    Object.entries(saved.cursors).some(([rawSlot, through]) => {
      if (!/^[0-7]$/.test(rawSlot) || typeof through !== 'bigint' || !saved.session) return true
      return !cursorIsChunkBoundary(saved.session, Number(rawSlot), through)
    })) throw new Error('invalid saved v3 retrieval checkpoint')
  return saved
}

export async function assertRetrievalV3CheckpointScope(key: string, state: RetrievalV3CheckpointState,
  scope: unknown, requester: string, chainId: string): Promise<void> {
  const expected = await retrievalV3DownloadCheckpointKey(scope, state.authority.dealId.toString(), state.file.path,
    state.requestRangeStart ?? undefined, state.requestRangeLength ?? undefined, undefined)
  if (key !== expected || state.requester !== requester || state.authority.chainId !== chainId ||
    state.authority.setupDigest !== RETRIEVAL_V3_SETUP) throw new Error('saved v3 recovery entry belongs to another wallet or network')
}

export function listRetrievalV3Checkpoints(dealId: bigint, requester: string, chainId: string,
  store: RetrievalStore = browserRetrievalStore()): Array<{ key: string; state: RetrievalV3CheckpointState }> {
  const keys = store.keys?.('output-v3:') ?? []
  const result: Array<{ key: string; state: RetrievalV3CheckpointState }> = []
  for (const key of keys) {
    if (key === SETTLED_CACHE_KEY) continue
    try {
      const state = readRetrievalV3Checkpoint(key, store)
      if (state?.authority.dealId === dealId && state.requester === requester && state.authority.chainId === chainId &&
        state.authority.setupDigest === RETRIEVAL_V3_SETUP) result.push({ key, state })
    } catch { /* malformed recovery state stays fail-closed */ }
  }
  return result
}

export async function discardUnboundRetrievalV3Checkpoint(key: string, scope: unknown, requester: string, chainId: string,
  store: RetrievalStore = browserRetrievalStore(), removeOutput = removeRetrievalOutput): Promise<void> {
  if (!navigator.locks) throw new Error('browser retrieval recovery locks are unavailable')
  await navigator.locks.request(key, { ifAvailable: true }, async (checkpointLock) => {
    if (!checkpointLock) throw new Error('this retrieval is already running in another tab')
    const initial = readRetrievalV3Checkpoint(key, store)
    if (!initial) throw new Error('missing frozen v3 retrieval checkpoint')
    const paymentKey = await retrievalV3OpenTransactionKey(scope, requester, initial.authority.dealId)
    await withRetrievalLock(paymentKey, async () => {
      const current = readRetrievalV3Checkpoint(key, store)
      if (!current) throw new Error('missing frozen v3 retrieval checkpoint')
      await assertRetrievalV3CheckpointScope(key, current, scope, requester, chainId)
      if (current.session) throw new Error('paid v3 recovery cannot be discarded')
      const transaction = store.get<BrowserTransaction>(paymentKey)
      let removeTransaction = false
      if (transaction !== undefined) {
        const validData = typeof transaction === 'object' && transaction !== null &&
          typeof transaction.data === 'string' && /^0x[0-9a-f]*$/i.test(transaction.data)
        const safelyUnpaid = validData && (transaction.state === 'prepared' && transaction.hash === undefined ||
          transaction.state === 'reverted' && typeof transaction.hash === 'string' && /^0x[0-9a-f]{64}$/i.test(transaction.hash))
        if (!safelyUnpaid) throw new Error('v3 payment outcome is not safely discardable')
        if (!isFrozenRetrievalRequestV3(transaction.intent)) throw new Error('malformed v3 payment journal')
        removeTransaction = sameFrozenRetrievalRequestV3(transaction.intent, {
          authority: current.authority, recordIndex: current.fileRecordIndex, file: current.file,
          rangeStart: current.rangeStart, rangeLength: current.rangeLength,
        })
      }
      await removeOutput(current.id)
      if (removeTransaction) store.remove(paymentKey)
      store.remove(key)
    })
  })
}

export async function openRetrievalV3Checkpoint(key: string, initial?: Omit<RetrievalV3CheckpointState, 'version' | 'id' | 'cursors'>) {
  if (!navigator.locks) throw new Error('browser retrieval recovery locks are unavailable')
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  await new Promise<void>((resolve, reject) => {
    void navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
      if (!lock) { reject(new Error('this retrieval is already running in another tab')); return }
      resolve(); await held
    }).catch(reject)
  })
  try {
    const store = browserRetrievalStore()
    const saved = readRetrievalV3Checkpoint(key, store)
    if (!saved && !initial) throw new Error('missing frozen v3 retrieval checkpoint')
    if (saved && initial && (saved.length !== initial.length || saved.rangeStart !== initial.rangeStart || saved.rangeLength !== initial.rangeLength ||
      saved.fileRecordIndex !== initial.fileRecordIndex || !sameFile(saved.file, initial.file) || !sameFrozenGenerationV3(saved.authority, initial.authority))) {
      throw new Error('saved v3 retrieval does not match request')
    }
    const source = saved ?? initial!
    const output = await createRetrievalOutput(source.length, saved?.id)
    let state: RetrievalV3CheckpointState = saved ?? { version: 3, id: output.id, ...initial!, cursors: {} }
    const save = (next: RetrievalV3CheckpointState) => { store.put(key, next); state = next }
    try { store.put(key, state) } catch (error) { if (saved) await output.release(); else await output.cleanup(); throw error }
    return {
      key, output, get state() { return state }, get cursors() { return state.cursors },
      bind(session: FrozenSessionV3) {
        if (!sessionMatchesState(state, session) || (state.session && state.session.sessionId !== session.sessionId)) throw new Error('saved v3 retrieval is bound to another request')
        save({ ...state, session })
      },
      advance(slot: number, through: bigint) {
        const current = state.cursors[slot] ?? -1n
        if (!Number.isSafeInteger(slot) || slot < 0 || slot > 7 || through <= current) throw new Error('invalid v3 retrieval cursor')
        save({ ...state, cursors: { ...state.cursors, [slot]: through } })
      },
      refresh(session: FrozenSessionV3) {
        if (!state.session || state.session.sessionId !== session.sessionId || !sessionMatchesState(state, session)) throw new Error('v3 session checkpoint mismatch')
        save({ ...state, session })
      },
      async retain() { try { await output.release() } finally { release() } },
      async handoff() {
        // Unresolved payment recovery is never part of the evictable cache.
        if (!state.session || state.session.lockedFee !== 0n || !retrievalV3OutputComplete(state.session, state.cursors)) {
          try { await output.release() } finally { release() }
          return undefined
        }
        const retained = await retainSettledRetrievalV3Cache({ version: 1, key, id: state.id, length: state.length,
          dealId: state.authority.dealId, filePath: state.file.path }, store).catch(() => false)
        if (retained) {
          await output.release()
          return async () => { release() }
        }
        store.remove(key)
        return async () => { try { await output.cleanup() } finally { release() } }
      },
      async discard() { try { store.remove(key); await output.cleanup() } finally { release() } },
    }
  } catch (error) { release(); throw error }
}
