// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

contract NilBridge {
    // The latest state root of the NilStore Network (L1)
    bytes32 public latestStateRoot;
    
    // The block height of the latest update
    uint256 public latestBlockHeight;

    // Who is allowed to update the root (simulated validator set / owner for now)
    address public owner;

    event StateRootUpdated(uint256 indexed blockHeight, bytes32 stateRoot);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not authorized");
        _;
    }

    // Validators call this to checkpoint the L1 state to L2/Ethereum
    function updateStateRoot(uint256 blockHeight, bytes32 stateRoot) external onlyOwner {
        require(blockHeight > latestBlockHeight, "Block height must increase");
        
        latestStateRoot = stateRoot;
        latestBlockHeight = blockHeight;
        
        emit StateRootUpdated(blockHeight, stateRoot);
    }

    // Verifiers can check if a specific file root exists in the L1 state
    function verifyInclusion(bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 computedHash = leaf;

        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];

            if (computedHash <= proofElement) {
                // Hash(current computed hash + current element of the proof)
                computedHash = keccak256(abi.encodePacked(computedHash, proofElement));
            } else {
                // Hash(current element of the proof + current computed hash)
                computedHash = keccak256(abi.encodePacked(proofElement, computedHash));
            }
        }

        return computedHash == latestStateRoot;
    }
}
