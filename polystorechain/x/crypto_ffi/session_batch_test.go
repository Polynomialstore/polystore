package crypto_ffi

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"testing"

	"github.com/stretchr/testify/require"
	"polystorechain/x/polystorechain/types"
)

func TestSessionBatchTransportBounds(t *testing.T) {
	path := func(n int) [][]byte {
		p := make([][]byte, n)
		for i := range p {
			p[i] = make([]byte, 32)
		}
		return p
	}
	p := types.ChainedProof{MduIndex: 65536, BlobIndex: 16383, MduRootFr: make([]byte, 32), RootTableDuCommitment: make([]byte, 48), ManifestOpening: make([]byte, 48), BlobCommitment: make([]byte, 48), ZValue: make([]byte, 32), YValue: make([]byte, 32), KzgOpeningProof: make([]byte, 48), RootTableDuMerklePath: path(6), MerklePath: path(14)}
	proofs := make([]types.ChainedProof, 64)
	for i := range proofs {
		proofs[i] = p
	}
	header := make([]byte, 32)
	b, err := encodePolyFSSessionProofBatch(header, header, header, 16384, proofs)
	require.NoError(t, err)
	require.Len(t, b, polyFSSessionBatchMaxBytes)
	require.Equal(t, "PSB1", string(b[:4]))
	require.Equal(t, uint16(64), binary.BigEndian.Uint16(b[4:6]))
	require.Equal(t, uint32(16384), binary.BigEndian.Uint32(b[6:10]))
	require.Equal(t, uint64(65536), binary.BigEndian.Uint64(b[106:114]))
	for _, n := range []int{0, 65} {
		_, err = encodePolyFSSessionProofBatch(header, header, header, 16384, make([]types.ChainedProof, n))
		require.Error(t, err)
	}
	for _, mutate := range []func(*types.ChainedProof){
		func(p *types.ChainedProof) { p.MduIndex = 65537 },
		func(p *types.ChainedProof) { p.BlobIndex = 16384 },
		func(p *types.ChainedProof) { p.YValue = make([]byte, 33) },
		func(p *types.ChainedProof) { p.RootTableDuMerklePath = path(7) },
		func(p *types.ChainedProof) { p.MerklePath = path(15) },
		func(p *types.ChainedProof) { p.MerklePath = [][]byte{make([]byte, 31)} },
	} {
		bad := p
		mutate(&bad)
		proofs[63] = bad
		_, err = encodePolyFSSessionProofBatch(header, header, header, 16384, proofs)
		require.Error(t, err, "the last proof must be bounded before native dispatch")
	}
}

func TestCrossSessionBatchTransportBounds(t *testing.T) {
	path := func(n int) [][]byte {
		p := make([][]byte, n)
		for i := range p {
			p[i] = make([]byte, 32)
		}
		return p
	}
	header := make([]byte, 32)
	proof := types.ChainedProof{MduIndex: 65536, BlobIndex: 95, MduRootFr: make([]byte, 32), RootTableDuCommitment: make([]byte, 48), ManifestOpening: make([]byte, 48), BlobCommitment: make([]byte, 48), ZValue: make([]byte, 32), YValue: make([]byte, 32), KzgOpeningProof: make([]byte, 48), RootTableDuMerklePath: path(6), MerklePath: path(7)}
	entries := make([]PolyFSCrossSessionEntry, 64)
	for i := range entries {
		entries[i] = PolyFSCrossSessionEntry{SessionID: header, ContextHash: header, ChallengeSeed: header, Root: header, Slot: uint32(i % 8), Proofs: []PolyFSCrossSessionProof{{Ordinal: uint64(i), T: uint64(100 + i), Proof: proof}}}
	}
	b, err := encodePolyFSCrossSessionProofBatch(entries, polyFSV3LeavesPerMDU)
	require.NoError(t, err)
	require.LessOrEqual(t, len(b), polyFSCrossSessionBatchMaxBytes)
	require.Equal(t, "PSB2", string(b[:4]))
	require.Equal(t, uint16(64), binary.BigEndian.Uint16(b[4:6]))
	require.Equal(t, uint16(64), binary.BigEndian.Uint16(b[6:8]))
	require.Equal(t, uint32(polyFSV3LeavesPerMDU), binary.BigEndian.Uint32(b[8:12]))
	require.Equal(t, uint64(0), binary.BigEndian.Uint64(b[146:154]))
	require.Equal(t, uint64(100), binary.BigEndian.Uint64(b[154:162]))

	_, err = encodePolyFSCrossSessionProofBatch(nil, polyFSV3LeavesPerMDU)
	require.Error(t, err)
	_, err = encodePolyFSCrossSessionProofBatch(entries, 64)
	require.Error(t, err)
	entries[0].Proofs = make([]PolyFSCrossSessionProof, 65)
	_, err = encodePolyFSCrossSessionProofBatch(entries[:1], polyFSV3LeavesPerMDU)
	require.Error(t, err)
}

func TestReceivedBlobCanonicalCommitment(t *testing.T) {
	require.NoError(t, Init("../../trusted_setup.txt"))
	blob := make([]byte, types.BLOB_SIZE)
	for i := 31; i < len(blob); i += 32 {
		blob[i] = byte(1 + (i/32)%251)
	}
	commitment, err := CommitReceivedBlob(blob)
	require.NoError(t, err)
	cells := make([][]byte, 4096)
	for i := range cells {
		cells[i] = blob[32*i : 32*(i+1)]
	}
	producer, encoded, err := ComputeManifestCommitment(cells)
	require.NoError(t, err)
	require.Equal(t, blob, encoded)
	require.Equal(t, producer, commitment, "strict commitment agrees with canonical producer bytes")
	for _, n := range []int{0, types.BLOB_SIZE - 1, types.BLOB_SIZE + 1} {
		_, err := CommitReceivedBlob(make([]byte, n))
		require.Error(t, err)
	}
	modulus, err := hex.DecodeString("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001")
	require.NoError(t, err)
	copy(blob[len(blob)-32:], modulus)
	_, err = CommitReceivedBlob(blob)
	require.Error(t, err, "a noncanonical final scalar must not be reduced")
	copy(blob[len(blob)-32:], bytes.Repeat([]byte{0xff}, 32))
	_, err = CommitReceivedBlob(blob)
	require.Error(t, err)
}
