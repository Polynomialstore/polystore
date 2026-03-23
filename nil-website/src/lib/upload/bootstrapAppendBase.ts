import type { NilfsFileEntry } from '../../domain/nilfs'

export interface BootstrappedAppendMdu {
  index: number
  data: Uint8Array
  rawData?: Uint8Array
}

export interface BootstrappedAppendBaseResult {
  baseMdu0Bytes: Uint8Array
  existingUserMdus: BootstrappedAppendMdu[]
  existingUserCount: number
  existingMaxEnd: number
  appendStartOffset: number
  files: NilfsFileEntry[]
}

export interface BootstrapAppendBaseInput {
  rawMduCapacity: number
  commitmentsPerMdu: number
  listFiles: () => Promise<NilfsFileEntry[]>
  fetchFileBytes: (file: NilfsFileEntry) => Promise<Uint8Array>
  initMdu0Builder: (userCount: number, commitmentsPerMdu: number) => Promise<unknown>
  appendFileToMdu0: (filePath: string, sizeBytes: number, startOffset: number, flags: number) => Promise<unknown>
  getMdu0Bytes: () => Promise<Uint8Array>
  encodeToMdu: (rawMdu: Uint8Array) => Uint8Array
}

function toSafeNumber(value: unknown): number {
  const parsed = Number(value ?? 0)
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
}

export async function bootstrapAppendBaseFromNetwork(
  input: BootstrapAppendBaseInput,
): Promise<BootstrappedAppendBaseResult | null> {
  const rawMduCapacity = toSafeNumber(input.rawMduCapacity)
  if (rawMduCapacity <= 0) {
    throw new Error('rawMduCapacity must be positive')
  }

  const commitmentsPerMdu = toSafeNumber(input.commitmentsPerMdu)
  if (commitmentsPerMdu <= 0) {
    throw new Error('commitmentsPerMdu must be positive')
  }

  const files = [...(await input.listFiles())]
    .filter((file) => Number.isFinite(Number(file.start_offset)) && Number(file.start_offset) >= 0)
    .sort((a, b) => {
      const startDiff = Number(a.start_offset) - Number(b.start_offset)
      if (startDiff !== 0) return startDiff
      return String(a.path).localeCompare(String(b.path))
    })

  if (!files.length) return null

  let maxEnd = 0
  for (const file of files) {
    const start = toSafeNumber(file.start_offset)
    const size = toSafeNumber(file.size_bytes)
    if (size <= 0) continue
    maxEnd = Math.max(maxEnd, start + size)
  }

  const userCount = maxEnd > 0 ? Math.ceil(maxEnd / rawMduCapacity) : 0
  if (userCount <= 0) {
    throw new Error('committed slab has no user MDUs to bootstrap')
  }

  await input.initMdu0Builder(userCount, commitmentsPerMdu)
  const rawUserMdus = Array.from({ length: userCount }, () => new Uint8Array(rawMduCapacity))

  for (const file of files) {
    const startOffset = toSafeNumber(file.start_offset)
    const sizeBytes = toSafeNumber(file.size_bytes)
    const fileBytes = await input.fetchFileBytes(file)
    if (fileBytes.byteLength !== sizeBytes) {
      throw new Error(`bootstrap retrieval size mismatch for ${file.path}: got ${fileBytes.byteLength}, want ${sizeBytes}`)
    }

    let remaining = fileBytes.byteLength
    let fileOffset = 0
    let cursor = startOffset
    while (remaining > 0) {
      const userMduIdx = Math.floor(cursor / rawMduCapacity)
      const offsetInMdu = cursor % rawMduCapacity
      const take = Math.min(remaining, rawMduCapacity - offsetInMdu)
      rawUserMdus[userMduIdx].set(fileBytes.subarray(fileOffset, fileOffset + take), offsetInMdu)
      fileOffset += take
      cursor += take
      remaining -= take
    }

    await input.appendFileToMdu0(file.path, sizeBytes, startOffset, toSafeNumber(file.flags))
  }

  const baseMdu0Bytes = await input.getMdu0Bytes()
  const existingUserMdus = rawUserMdus.map((rawMdu, index) => ({
    index,
    data: input.encodeToMdu(rawMdu),
    rawData: rawMdu,
  }))

  return {
    baseMdu0Bytes,
    existingUserMdus,
    existingUserCount: userCount,
    existingMaxEnd: maxEnd,
    appendStartOffset: userCount * rawMduCapacity,
    files,
  }
}
