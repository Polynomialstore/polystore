package keeper_test

import (
	"encoding/binary"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/crypto/blake2s"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

// buildMode2LeafProof constructs Hop2+Hop3 proof material for a Mode 2 (StripeReplica) leaf.
//
// - witnessFlat is slot-major commitments (48 bytes each), length = leafCount*48.
// - leafIndex is in [0, leafCount), where leafCount=(k+m)*(64/k).
// - mduBytes is the original 8 MiB user MDU bytes.
//
// For data slots (slot < k), Hop3 uses the corresponding blob bytes from mduBytes.
// For parity slots (slot >= k), Hop3 uses the RS shard blob bytes returned by ExpandMduRs.
func buildMode2LeafProof(
	t *testing.T,
	mduBytes []byte,
	k uint64,
	m uint64,
	witnessFlat []byte,
	shards [][]byte,
	leafIndex uint64,
	zHint uint64,
) (mduRoot []byte, blobCommitment []byte, merklePath [][]byte, z []byte, y []byte, kzgProof []byte) {
	t.Helper()

	require.Equal(t, types.MDU_SIZE, len(mduBytes), "mduBytes must be exactly one encoded MDU (8 MiB)")
	require.True(t, k > 0 && m > 0, "invalid rs params")
	require.Equal(t, uint64(0), 64%k, "k must divide 64")

	rows := uint64(64) / k
	leafCount := (k + m) * rows
	require.Equal(t, int(leafCount*48), len(witnessFlat), "witnessFlat length mismatch")
	require.True(t, leafIndex < leafCount, "leafIndex out of range")
	require.Len(t, shards, int(k+m), "shards length mismatch")

	// Hop 2: Merkle root/path over witness commitments.
	rootFFI, err := crypto_ffi.ComputeMduRootFromWitnessFlat(witnessFlat)
	require.NoError(t, err)

	rootGo, path := rsMerkleRootAndPathFromWitnessFlat(t, witnessFlat, leafIndex)
	require.Equal(t, rootFFI, rootGo, "Go witness merkle root should match FFI root")

	commitmentOff := int(leafIndex) * 48
	blobCommitment = make([]byte, 48)
	copy(blobCommitment, witnessFlat[commitmentOff:commitmentOff+48])

	// Hop 3: KZG proof for blob bytes corresponding to this leaf.
	slot := leafIndex / rows
	row := leafIndex % rows
	blobBytes := mode2BlobBytesForLeaf(t, mduBytes, shards, k, m, slot, row)

	z = make([]byte, 32)
	// z is arbitrary; it only needs to be consistent between proof generation and verification.
	z[0] = 42
	z[1] = byte(slot & 0xFF)
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], zHint)
	copy(z[2:10], b[:])

	kzgProof, y, err = crypto_ffi.ComputeBlobProof(blobBytes, z)
	require.NoError(t, err)

	return rootFFI, blobCommitment, path, z, y, kzgProof
}

func mode2BlobBytesForLeaf(t *testing.T, mduBytes []byte, shards [][]byte, k uint64, m uint64, slot uint64, row uint64) []byte {
	t.Helper()

	require.True(t, k > 0 && m > 0, "invalid rs params")
	require.Equal(t, uint64(0), 64%k, "k must divide 64")
	rows := uint64(64) / k
	require.True(t, row < rows, "row out of range")
	require.Len(t, shards, int(k+m), "shards length mismatch")

	// Data slots map directly back to original MDU blobs.
	if slot < k {
		blobIndex := row*k + slot
		off := int(blobIndex) * types.BLOB_SIZE
		end := off + types.BLOB_SIZE
		require.True(t, end <= len(mduBytes), "blob slice out of range")
		blob := make([]byte, types.BLOB_SIZE)
		copy(blob, mduBytes[off:end])
		return blob
	}

	// Parity slots come from RS expansion shards.
	require.True(t, slot < k+m, fmt.Sprintf("slot out of range: %d", slot))
	shard := shards[slot]
	require.Len(t, shard, int(rows)*types.BLOB_SIZE, "shard length mismatch")
	off := int(row) * types.BLOB_SIZE
	end := off + types.BLOB_SIZE
	blob := make([]byte, types.BLOB_SIZE)
	copy(blob, shard[off:end])
	return blob
}

func rsMerkleRootAndPathFromWitnessFlat(t *testing.T, witnessFlat []byte, leafIndex uint64) ([]byte, [][]byte) {
	t.Helper()

	require.True(t, len(witnessFlat) > 0 && len(witnessFlat)%48 == 0, "witnessFlat must be a non-empty multiple of 48 bytes")
	leafCount := len(witnessFlat) / 48
	require.True(t, int(leafIndex) >= 0 && int(leafIndex) < leafCount, "leafIndex out of range")

	leaves := make([][32]byte, 0, leafCount)
	for i := 0; i < len(witnessFlat); i += 48 {
		leaves = append(leaves, blake2s.Sum256(witnessFlat[i:i+48]))
	}

	level := make([][32]byte, len(leaves))
	copy(level, leaves)
	idx := int(leafIndex)

	path := make([][]byte, 0, 10)
	for len(level) > 1 {
		if idx%2 == 0 {
			if idx+1 < len(level) {
				h := make([]byte, 32)
				copy(h, level[idx+1][:])
				path = append(path, h)
			}
		} else {
			h := make([]byte, 32)
			copy(h, level[idx-1][:])
			path = append(path, h)
		}

		next := make([][32]byte, 0, (len(level)+1)/2)
		for i := 0; i < len(level); i += 2 {
			left := level[i]
			if i+1 < len(level) {
				right := level[i+1]
				var pair [64]byte
				copy(pair[:32], left[:])
				copy(pair[32:], right[:])
				next = append(next, blake2s.Sum256(pair[:]))
				continue
			}
			// rs_merkle propagates the left node when no sibling exists.
			next = append(next, left)
		}
		level = next
		idx /= 2
	}

	root := make([]byte, 32)
	copy(root, level[0][:])
	return root, path
}
