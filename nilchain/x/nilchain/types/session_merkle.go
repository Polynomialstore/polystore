package types

import (
	"encoding/binary"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// HashSessionLeaf computes leaf_hash := keccak256(uint64_be(range_start) || uint64_be(range_len) || proof_hash).
func HashSessionLeaf(rangeStart uint64, rangeLen uint64, proofHash common.Hash) common.Hash {
	var b [16]byte
	binary.BigEndian.PutUint64(b[0:8], rangeStart)
	binary.BigEndian.PutUint64(b[8:16], rangeLen)
	return crypto.Keccak256Hash(b[:], proofHash.Bytes())
}

// VerifyKeccakMerklePath verifies a Merkle membership proof using keccak256(left||right) internal hashing.
// leafIndex is the 0-based index of the leaf in the tree. Path siblings must be 32-byte nodes.
func VerifyKeccakMerklePath(root common.Hash, leaf common.Hash, leafIndex uint32, merklePath [][]byte) bool {
	h := leaf.Bytes()
	idx := leafIndex
	for _, sib := range merklePath {
		if len(sib) != 32 {
			return false
		}
		if idx%2 == 0 {
			h = crypto.Keccak256(h, sib)
		} else {
			h = crypto.Keccak256(sib, h)
		}
		idx /= 2
	}
	return common.BytesToHash(h) == root
}
