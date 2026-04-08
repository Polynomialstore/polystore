export const nilBridgeAbi = [
  {
    type: 'function',
    name: 'latestBlockHeight',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'latestStateRoot',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'updateStateRoot',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'blockHeight', type: 'uint256' },
      { name: 'stateRoot', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const;
