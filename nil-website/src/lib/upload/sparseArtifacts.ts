export type SparseArtifactKind = 'mdu' | 'manifest' | 'shard'

export interface SparseArtifactInput {
  kind: SparseArtifactKind
  bytes: Uint8Array
  fullSize?: number
  index?: number
  slot?: number
}

export interface SparseArtifact {
  kind: SparseArtifactKind
  bytes: Uint8Array
  fullSize: number
  index?: number
  slot?: number
}

export interface SparsePayloadPlan {
  fullSize: number
  sendSize: number
  sparse: boolean
}

function validateArtifactIdentity(input: SparseArtifactInput): void {
  if (input.kind === 'mdu' && !Number.isInteger(input.index)) {
    throw new Error('MDU artifacts require an integer index')
  }
  if (input.kind === 'shard') {
    if (!Number.isInteger(input.index)) {
      throw new Error('Shard artifacts require an integer index')
    }
    if (!Number.isInteger(input.slot)) {
      throw new Error('Shard artifacts require an integer slot')
    }
  }
}

export function computeSparsePayloadPlan(bytes: Uint8Array, declaredFullSize = bytes.byteLength): SparsePayloadPlan {
  if (!Number.isInteger(declaredFullSize) || declaredFullSize < 0) {
    throw new Error('fullSize must be a non-negative integer')
  }
  if (bytes.byteLength > declaredFullSize) {
    throw new Error(`artifact bytes exceed fullSize: ${bytes.byteLength} > ${declaredFullSize}`)
  }
  if (declaredFullSize === 0) {
    return { fullSize: 0, sendSize: 0, sparse: false }
  }

  for (let i = bytes.byteLength - 1; i >= 0; i -= 1) {
    if (bytes[i] !== 0) {
      const sendSize = i + 1
      return {
        fullSize: declaredFullSize,
        sendSize,
        sparse: sendSize < declaredFullSize,
      }
    }
  }

  // Match the Go uploader semantics: keep a non-empty body for non-empty artifacts.
  return {
    fullSize: declaredFullSize,
    sendSize: 1,
    sparse: declaredFullSize > 1 || bytes.byteLength !== 1,
  }
}

export function makeSparseArtifact(input: SparseArtifactInput): SparseArtifact {
  validateArtifactIdentity(input)

  const fullSize = input.fullSize ?? input.bytes.byteLength
  const plan = computeSparsePayloadPlan(input.bytes, fullSize)

  let bytes: Uint8Array
  if (plan.fullSize === 0) {
    bytes = new Uint8Array(0)
  } else if (plan.sendSize === input.bytes.byteLength) {
    bytes = input.bytes
  } else if (input.bytes.byteLength >= plan.sendSize) {
    bytes = input.bytes.subarray(0, plan.sendSize)
  } else if (plan.sendSize === 1 && input.bytes.byteLength === 0) {
    bytes = new Uint8Array(1)
  } else {
    throw new Error(`artifact bytes shorter than planned send size: ${input.bytes.byteLength} < ${plan.sendSize}`)
  }

  return {
    kind: input.kind,
    index: input.index,
    slot: input.slot,
    fullSize: plan.fullSize,
    bytes,
  }
}

export function expandSparseBytes(bytes: Uint8Array, fullSize: number): Uint8Array {
  if (!Number.isInteger(fullSize) || fullSize < 0) {
    throw new Error('fullSize must be a non-negative integer')
  }
  if (bytes.byteLength > fullSize) {
    throw new Error(`artifact bytes exceed fullSize: ${bytes.byteLength} > ${fullSize}`)
  }

  if (bytes.byteLength === fullSize) {
    return bytes.slice()
  }

  const expanded = new Uint8Array(fullSize)
  expanded.set(bytes, 0)
  return expanded
}
