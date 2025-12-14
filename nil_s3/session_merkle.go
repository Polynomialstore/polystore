package main

import (
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// keccakMerkleRootAndPaths computes a keccak256 Merkle root and per-leaf paths.
//
// Tree rules:
// - leaves are ordered as provided
// - if a level has odd length, duplicate the last element
// - internal node hash: keccak256(left || right)
//
// Returned paths[i] is a slice of sibling nodes (32-byte) from leaf → root.
func keccakMerkleRootAndPaths(leaves []common.Hash) (common.Hash, [][][]byte) {
	if len(leaves) == 0 {
		return common.Hash{}, nil
	}
	if len(leaves) == 1 {
		leaf := leaves[0]
		root := crypto.Keccak256Hash(leaf.Bytes(), leaf.Bytes())
		return root, [][][]byte{{leaf.Bytes()}}
	}

	paths := make([][][]byte, len(leaves))
	indices := make([]int, len(leaves))
	level := make([]common.Hash, len(leaves))
	for i := range leaves {
		indices[i] = i
		level[i] = leaves[i]
	}

	for len(level) > 1 {
		if len(level)%2 == 1 {
			level = append(level, level[len(level)-1])
		}

		for i := range paths {
			idx := indices[i]
			sibling := level[idx^1]
			paths[i] = append(paths[i], sibling.Bytes())
			indices[i] = idx / 2
		}

		next := make([]common.Hash, len(level)/2)
		for i := 0; i < len(level); i += 2 {
			next[i/2] = crypto.Keccak256Hash(level[i].Bytes(), level[i+1].Bytes())
		}
		level = next
	}

	return level[0], paths
}
