import { normalizeManifestRoot } from '../cacheFreshness'

export interface ExistingUserMdu {
  index: number
  data: Uint8Array
}

export interface ExpandedBootstrapStripe {
  witness_flat: Uint8Array | number[]
  mdu_root: Uint8Array | number[]
  shards: Array<Uint8Array | number[]>
}

export interface CommittedMduResult {
  witness_flat?: Uint8Array | number[]
  mdu_root: Uint8Array | number[]
}

export interface MaterializedBootstrapGeneration {
  manifestRoot: string
  manifestBlob: Uint8Array
  mdu0Bytes: Uint8Array
  witnessCount: number
  witnessMdus: Array<{ index: number; data: Uint8Array }>
  userMdus: ExistingUserMdu[]
  shardSets: Array<{ index: number; shards: Array<{ data: Uint8Array; fullSize?: number }> }>
}

export interface MaterializeBootstrapGenerationInput {
  baseMdu0Bytes: Uint8Array
  existingUserMdus: ExistingUserMdu[]
  expectedManifestRoot: string
  rsK: number
  rsM: number
  rawMduCapacity: number
  encodeToMdu: (rawData: Uint8Array) => Uint8Array
  loadMdu0Builder: (data: Uint8Array, maxUserMdus: number, commitmentsPerMdu: number) => Promise<unknown>
  setMdu0Root: (index: number, root: Uint8Array) => Promise<unknown>
  getMdu0Bytes: () => Promise<Uint8Array>
  expandMduRs: (data: Uint8Array, k: number, m: number) => Promise<ExpandedBootstrapStripe>
  shardFile: (data: Uint8Array) => Promise<CommittedMduResult>
  computeManifest: (roots: Uint8Array) => Promise<{ root: Uint8Array; blob: Uint8Array }>
}

function toU8(value: Uint8Array | number[]): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

export async function materializeBootstrapGeneration(
  input: MaterializeBootstrapGenerationInput,
): Promise<MaterializedBootstrapGeneration> {
  const rsK = Math.floor(Number(input.rsK))
  const rsM = Math.floor(Number(input.rsM))
  const rawMduCapacity = Math.floor(Number(input.rawMduCapacity))
  if (rsK <= 0 || rsM <= 0) throw new Error('Mode 2 RS params must be positive')
  if (rawMduCapacity <= 0) throw new Error('rawMduCapacity must be positive')
  if (64 % rsK !== 0) throw new Error('rsK must divide 64')

  const userMdus = [...input.existingUserMdus].sort((a, b) => a.index - b.index)
  if (userMdus.length <= 0) {
    throw new Error('at least one user MDU is required to materialize a generation')
  }

  const userRoots: Uint8Array[] = []
  const shardSets: Array<{ index: number; shards: Array<{ data: Uint8Array; fullSize?: number }> }> = []
  const witnessDataBlobs: Uint8Array[] = []

  for (const userMdu of userMdus) {
    const expanded = await input.expandMduRs(new Uint8Array(userMdu.data), rsK, rsM)
    userRoots.push(toU8(expanded.mdu_root))
    witnessDataBlobs.push(toU8(expanded.witness_flat))
    shardSets.push({
      index: userMdu.index,
      shards: expanded.shards.map((shard) => ({ data: toU8(shard) })),
    })
  }

  const totalWitnessBytes = witnessDataBlobs.reduce((sum, blob) => sum + blob.byteLength, 0)
  const fullWitnessData = new Uint8Array(totalWitnessBytes)
  let witnessOffset = 0
  for (const blob of witnessDataBlobs) {
    fullWitnessData.set(blob, witnessOffset)
    witnessOffset += blob.byteLength
  }

  const witnessCount = Math.ceil(fullWitnessData.byteLength / rawMduCapacity)
  const witnessRoots: Uint8Array[] = []
  const witnessMdus: Array<{ index: number; data: Uint8Array }> = []
  for (let i = 0; i < witnessCount; i += 1) {
    const start = i * rawMduCapacity
    const end = Math.min(start + rawMduCapacity, fullWitnessData.byteLength)
    const witnessMduBytes = input.encodeToMdu(fullWitnessData.subarray(start, end))
    const committed = await input.shardFile(new Uint8Array(witnessMduBytes))
    witnessRoots.push(toU8(committed.mdu_root))
    witnessMdus.push({ index: 1 + i, data: witnessMduBytes })
  }

  const commitmentsPerMdu = (rsK + rsM) * (64 / rsK)
  await input.loadMdu0Builder(new Uint8Array(input.baseMdu0Bytes), userMdus.length, commitmentsPerMdu)
  for (let i = 0; i < witnessRoots.length; i += 1) {
    await input.setMdu0Root(i, witnessRoots[i])
  }
  for (let i = 0; i < userRoots.length; i += 1) {
    await input.setMdu0Root(witnessCount + i, userRoots[i])
  }

  const mdu0Bytes = await input.getMdu0Bytes()
  const mdu0Committed = await input.shardFile(new Uint8Array(mdu0Bytes))
  const mdu0Root = toU8(mdu0Committed.mdu_root)

  const allRoots = new Uint8Array(32 * (1 + witnessRoots.length + userRoots.length))
  allRoots.set(mdu0Root, 0)
  let rootOffset = 32
  for (const root of witnessRoots) {
    allRoots.set(root, rootOffset)
    rootOffset += 32
  }
  for (const root of userRoots) {
    allRoots.set(root, rootOffset)
    rootOffset += 32
  }

  const manifest = await input.computeManifest(allRoots)
  const manifestRoot = normalizeManifestRoot(
    `0x${Array.from(manifest.root).map((b) => b.toString(16).padStart(2, '0')).join('')}`,
  )
  const expectedManifestRoot = normalizeManifestRoot(input.expectedManifestRoot)
  if (manifestRoot !== expectedManifestRoot) {
    throw new Error(`bootstrap manifest root mismatch: got ${manifestRoot}, want ${expectedManifestRoot}`)
  }

  return {
    manifestRoot,
    manifestBlob: new Uint8Array(manifest.blob),
    mdu0Bytes,
    witnessCount,
    witnessMdus,
    userMdus,
    shardSets,
  }
}
