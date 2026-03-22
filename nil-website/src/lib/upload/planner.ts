export const PLANNER_BLOBS_PER_MDU = 64
export const PLANNER_BLOB_BYTES = 128 * 1024
export const PLANNER_SCALAR_PAYLOAD_BYTES = 31
export const PLANNER_SCALAR_BYTES = 32
export const PLANNER_TRIVIAL_BLOB_WEIGHT = 0.1
const WITNESS_COMMITMENT_BYTES = 48

export interface ExistingUploadLayout {
  existingUserMdus?: number
  existingMaxEnd?: number
}

export interface UploadPlannerInput extends ExistingUploadLayout {
  fileBytes: number
  rawMduCapacity: number
  useMode2: boolean
  rsK?: number
  rsM?: number
}

export interface UploadShardItemPlan {
  id: number
  commitments: string[]
  status: 'pending'
}

export interface UploadPlannerResult {
  leafCount: number
  blobsPerMdu: number
  appendStartOffset: number
  newUserMdus: number
  totalUserMdus: number
  totalFileBytes: number
  totalMdus: number
  witnessBytesPerMdu: number
  witnessMduCount: number
  witnessPayloads: number[]
  userPayloads: number[]
  workTotal: number
  blobsTotal: number
  shardItems: UploadShardItemPlan[]
}

function asNonNegativeInteger(value: number | undefined, label: string): number {
  const safe = Number(value ?? 0)
  if (!Number.isFinite(safe) || safe < 0) {
    throw new Error(`${label} must be a non-negative finite number`)
  }
  return Math.floor(safe)
}

export function nonTrivialBlobsForPayload(payloadBytes: number): number {
  if (!Number.isFinite(payloadBytes) || payloadBytes <= 0) return 0
  const scalarsUsed = Math.ceil(payloadBytes / PLANNER_SCALAR_PAYLOAD_BYTES)
  const encodedBytes = scalarsUsed * PLANNER_SCALAR_BYTES
  const blobsUsed = Math.ceil(encodedBytes / PLANNER_BLOB_BYTES)
  return Math.max(0, Math.min(PLANNER_BLOBS_PER_MDU, blobsUsed))
}

export function weightedWorkForMdu(nonTrivialBlobs: number): number {
  const bounded = Math.max(0, Math.min(PLANNER_BLOBS_PER_MDU, Math.floor(nonTrivialBlobs)))
  const trivial = PLANNER_BLOBS_PER_MDU - bounded
  return bounded + trivial * PLANNER_TRIVIAL_BLOB_WEIGHT
}

export function computeLeafCount(useMode2: boolean, rsK = 0, rsM = 0): number {
  if (!useMode2) return PLANNER_BLOBS_PER_MDU
  const safeK = asNonNegativeInteger(rsK, 'rsK')
  const safeM = asNonNegativeInteger(rsM, 'rsM')
  if (safeK <= 0) {
    throw new Error('rsK must be positive when Mode 2 is enabled')
  }
  if (PLANNER_BLOBS_PER_MDU % safeK !== 0) {
    throw new Error(`rsK must divide ${PLANNER_BLOBS_PER_MDU} when Mode 2 is enabled`)
  }
  return (safeK + safeM) * (PLANNER_BLOBS_PER_MDU / safeK)
}

export function buildUploadShardItems(totalUserMdus: number, witnessMduCount: number): UploadShardItemPlan[] {
  const safeUsers = asNonNegativeInteger(totalUserMdus, 'totalUserMdus')
  const safeWitness = asNonNegativeInteger(witnessMduCount, 'witnessMduCount')
  const items: UploadShardItemPlan[] = [{ id: 0, commitments: ['MDU #0'], status: 'pending' }]
  for (let i = 0; i < safeWitness; i++) {
    items.push({ id: 1 + i, commitments: ['Witness'], status: 'pending' })
  }
  for (let i = 0; i < safeUsers; i++) {
    items.push({ id: 1 + safeWitness + i, commitments: ['User Data'], status: 'pending' })
  }
  return items
}

export function buildUploadPlan(input: UploadPlannerInput): UploadPlannerResult {
  const fileBytes = asNonNegativeInteger(input.fileBytes, 'fileBytes')
  const rawMduCapacity = asNonNegativeInteger(input.rawMduCapacity, 'rawMduCapacity')
  if (rawMduCapacity <= 0) {
    throw new Error('rawMduCapacity must be positive')
  }

  const existingUserMdus = asNonNegativeInteger(input.existingUserMdus, 'existingUserMdus')
  const existingMaxEnd = asNonNegativeInteger(input.existingMaxEnd, 'existingMaxEnd')
  const leafCount = computeLeafCount(input.useMode2, input.rsK, input.rsM)
  const blobsPerMdu = input.useMode2 ? leafCount : PLANNER_BLOBS_PER_MDU
  const appendStartOffset = existingUserMdus * rawMduCapacity
  const newUserMdus = Math.ceil(fileBytes / rawMduCapacity)
  const totalUserMdus = existingUserMdus + newUserMdus
  const totalFileBytes = appendStartOffset + fileBytes
  const witnessBytesPerMdu = leafCount * WITNESS_COMMITMENT_BYTES
  const witnessMduCount = Math.max(1, Math.ceil((witnessBytesPerMdu * totalUserMdus) / rawMduCapacity))

  const totalWitnessPayloadBytes = totalUserMdus * witnessBytesPerMdu
  const witnessPayloads: number[] = []
  for (let remaining = totalWitnessPayloadBytes, i = 0; i < witnessMduCount; i++) {
    const take = Math.max(0, Math.min(rawMduCapacity, remaining))
    witnessPayloads.push(take)
    remaining -= take
  }

  const userPayloads: number[] = []
  for (let i = 0; i < existingUserMdus; i++) {
    const start = i * rawMduCapacity
    const end = Math.min(start + rawMduCapacity, existingMaxEnd)
    userPayloads.push(Math.max(0, end - start))
  }
  for (let i = 0; i < newUserMdus; i++) {
    const start = i * rawMduCapacity
    const end = Math.min(start + rawMduCapacity, fileBytes)
    userPayloads.push(Math.max(0, end - start))
  }

  const workTotal =
    weightedWorkForMdu(1) +
    witnessPayloads.reduce((acc, payload) => acc + weightedWorkForMdu(nonTrivialBlobsForPayload(payload)), 0) +
    userPayloads.reduce((acc, payload) => acc + weightedWorkForMdu(nonTrivialBlobsForPayload(payload)), 0)

  return {
    leafCount,
    blobsPerMdu,
    appendStartOffset,
    newUserMdus,
    totalUserMdus,
    totalFileBytes,
    totalMdus: 1 + witnessMduCount + totalUserMdus,
    witnessBytesPerMdu,
    witnessMduCount,
    witnessPayloads,
    userPayloads,
    workTotal,
    blobsTotal: (1 + witnessMduCount + totalUserMdus) * blobsPerMdu,
    shardItems: buildUploadShardItems(totalUserMdus, witnessMduCount),
  }
}
