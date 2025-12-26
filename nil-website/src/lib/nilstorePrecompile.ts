import type { Abi } from 'viem'

export const NILSTORE_PRECOMPILE_ABI = [
  {
    type: 'function',
    name: 'createDeal',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'durationBlocks', type: 'uint64' },
      { name: 'serviceHint', type: 'string' },
      { name: 'initialEscrow', type: 'uint256' },
      { name: 'maxMonthlySpend', type: 'uint256' },
    ],
    outputs: [{ name: 'dealId', type: 'uint64' }],
  },
  {
    type: 'function',
    name: 'updateDealContent',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dealId', type: 'uint64' },
      { name: 'manifestRoot', type: 'bytes' },
      { name: 'sizeBytes', type: 'uint64' },
    ],
    outputs: [{ name: 'ok', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'proveRetrievalBatch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dealId', type: 'uint64' },
      { name: 'provider', type: 'string' },
      { name: 'filePath', type: 'string' },
      { name: 'nonce', type: 'uint64' },
      {
        name: 'chunks',
        type: 'tuple[]',
        components: [
          { name: 'rangeStart', type: 'uint64' },
          { name: 'rangeLen', type: 'uint64' },
          {
            name: 'proof',
            type: 'tuple',
            components: [
              { name: 'mduIndex', type: 'uint64' },
              { name: 'mduRootFr', type: 'bytes' },
              { name: 'manifestOpening', type: 'bytes' },
              { name: 'blobCommitment', type: 'bytes' },
              { name: 'merklePath', type: 'bytes[]' },
              { name: 'blobIndex', type: 'uint32' },
              { name: 'zValue', type: 'bytes' },
              { name: 'yValue', type: 'bytes' },
              { name: 'kzgOpeningProof', type: 'bytes' },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: 'ok', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'openRetrievalSession',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dealId', type: 'uint64' },
      { name: 'provider', type: 'string' },
      { name: 'manifestRoot', type: 'bytes' },
      { name: 'startMduIndex', type: 'uint64' },
      { name: 'startBlobIndex', type: 'uint32' },
      { name: 'blobCount', type: 'uint64' },
      { name: 'nonce', type: 'uint64' },
      { name: 'expiresAt', type: 'uint64' },
    ],
    outputs: [{ name: 'sessionId', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'openRetrievalSessions',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'sessions',
        type: 'tuple[]',
        components: [
          { name: 'dealId', type: 'uint64' },
          { name: 'provider', type: 'string' },
          { name: 'manifestRoot', type: 'bytes' },
          { name: 'startMduIndex', type: 'uint64' },
          { name: 'startBlobIndex', type: 'uint32' },
          { name: 'blobCount', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
          { name: 'expiresAt', type: 'uint64' },
        ],
      },
    ],
    outputs: [{ name: 'sessionIds', type: 'bytes32[]' }],
  },
  {
    type: 'function',
    name: 'computeRetrievalSessions',
    stateMutability: 'view',
    inputs: [
      {
        name: 'sessions',
        type: 'tuple[]',
        components: [
          { name: 'dealId', type: 'uint64' },
          { name: 'provider', type: 'string' },
          { name: 'manifestRoot', type: 'bytes' },
          { name: 'startMduIndex', type: 'uint64' },
          { name: 'startBlobIndex', type: 'uint32' },
          { name: 'blobCount', type: 'uint64' },
          { name: 'nonce', type: 'uint64' },
          { name: 'expiresAt', type: 'uint64' },
        ],
      },
    ],
    outputs: [
      {
        name: 'sessions',
        type: 'tuple[]',
        components: [
          { name: 'provider', type: 'string' },
          { name: 'sessionId', type: 'bytes32' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'confirmRetrievalSession',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'sessionId', type: 'bytes32' }],
    outputs: [{ name: 'ok', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'confirmRetrievalSessions',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'sessionIds', type: 'bytes32[]' }],
    outputs: [{ name: 'ok', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'DealCreated',
    inputs: [
      { name: 'dealId', type: 'uint64', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'DealContentUpdated',
    inputs: [
      { name: 'dealId', type: 'uint64', indexed: true },
      { name: 'manifestRoot', type: 'bytes', indexed: false },
      { name: 'sizeBytes', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RetrievalProved',
    inputs: [
      { name: 'dealId', type: 'uint64', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'provider', type: 'string', indexed: false },
      { name: 'filePath', type: 'string', indexed: false },
      { name: 'bytesServed', type: 'uint64', indexed: false },
      { name: 'nonce', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RetrievalSessionOpened',
    inputs: [
      { name: 'dealId', type: 'uint64', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'provider', type: 'string', indexed: false },
      { name: 'sessionId', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RetrievalSessionConfirmed',
    inputs: [
      { name: 'sessionId', type: 'bytes32', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
    ],
  },
] as const satisfies Abi
