package crypto_ffi

/*
#include <stddef.h>
int polystore_verify_polyfs_session_batch_v1(const unsigned char* input, size_t input_len);
int polystore_commit_received_blob(const unsigned char* input, size_t input_len, unsigned char* commitment);
*/
import "C"

import (
	"encoding/binary"
	"fmt"
	"unsafe"

	"polystorechain/x/polystorechain/types"
)

const polyFSSessionBatchMaxBytes = 60522

// encodePolyFSSessionProofBatch bounds every length before its single allocation.
// PSB1 is an internal complete-session transport, not another public proof type.
// The caller authenticates the context/seed and exact ordered challenge tuples;
// native verification independently checks canonical paths, encodings and z.
func encodePolyFSSessionProofBatch(root, contextHash, seed []byte, leafCount uint64, proofs []types.ChainedProof) ([]byte, error) {
	if len(root) != 32 || len(contextHash) != 32 || len(seed) != 32 || leafCount == 0 || leafCount > 16384 || len(proofs) == 0 || len(proofs) > 64 {
		return nil, fmt.Errorf("invalid PolyFS session batch header")
	}
	size := 106
	for i := range proofs {
		p := &proofs[i]
		if p.MduIndex == 0 || p.MduIndex > 65536 || uint64(p.BlobIndex) >= leafCount ||
			len(p.MduRootFr) != 32 || len(p.RootTableDuCommitment) != 48 || len(p.ManifestOpening) != 48 ||
			len(p.BlobCommitment) != 48 || len(p.ZValue) != 32 || len(p.YValue) != 32 || len(p.KzgOpeningProof) != 48 ||
			len(p.RootTableDuMerklePath) != 6 || len(p.MerklePath) > 14 {
			return nil, fmt.Errorf("invalid PolyFS session batch proof shape")
		}
		for _, path := range [][][]byte{p.RootTableDuMerklePath, p.MerklePath} {
			for _, sibling := range path {
				if len(sibling) != 32 {
					return nil, fmt.Errorf("invalid PolyFS session batch sibling")
				}
			}
		}
		size += 304 + 32*(len(p.RootTableDuMerklePath)+len(p.MerklePath))
	}
	if size > polyFSSessionBatchMaxBytes {
		return nil, fmt.Errorf("PolyFS session batch exceeds transport limit")
	}
	b := make([]byte, 0, size)
	b = append(b, "PSB1"...)
	b = binary.BigEndian.AppendUint16(b, uint16(len(proofs)))
	b = binary.BigEndian.AppendUint32(b, uint32(leafCount))
	b = append(b, root...)
	b = append(b, contextHash...)
	b = append(b, seed...)
	for i := range proofs {
		p := &proofs[i]
		b = binary.BigEndian.AppendUint64(b, p.MduIndex)
		b = binary.BigEndian.AppendUint32(b, p.BlobIndex)
		b = append(b, p.MduRootFr...)
		b = append(b, p.RootTableDuCommitment...)
		b = append(b, p.ManifestOpening...)
		b = append(b, p.BlobCommitment...)
		b = append(b, p.ZValue...)
		b = append(b, p.YValue...)
		b = append(b, p.KzgOpeningProof...)
		b = binary.BigEndian.AppendUint16(b, uint16(len(p.RootTableDuMerklePath)))
		b = binary.BigEndian.AppendUint16(b, uint16(len(p.MerklePath)))
		for _, path := range [][][]byte{p.RootTableDuMerklePath, p.MerklePath} {
			for _, sibling := range path {
				b = append(b, sibling...)
			}
		}
	}
	return b, nil
}

// VerifyPolyFSSessionProofBatch verifies one complete, authenticated v2 session.
// It cannot be used for partial windows, arbitrary audit subsets or legacy z.
// The synchronous native call retains no Go pointers and has no SDK effects.
func VerifyPolyFSSessionProofBatch(root, contextHash, seed []byte, leafCount uint64, proofs []types.ChainedProof) (bool, error) {
	input, err := encodePolyFSSessionProofBatch(root, contextHash, seed, leafCount, proofs)
	if err != nil {
		return false, err
	}
	result := C.polystore_verify_polyfs_session_batch_v1((*C.uchar)(unsafe.Pointer(&input[0])), C.size_t(len(input)))
	switch result {
	case 1:
		return true, nil
	case 0:
		return false, nil
	default:
		return false, fmt.Errorf("native PolyFS session batch rejected input: %d", result)
	}
}

// CommitReceivedBlob rejects noncanonical scalar encodings before commitment.
// Packed payload consumers must also check reserved bytes and deterministic
// padding before decoding. Public-z evaluation alone does not bind these bytes.
func CommitReceivedBlob(blob []byte) ([]byte, error) {
	if len(blob) != types.BLOB_SIZE {
		return nil, fmt.Errorf("received blob must be exactly %d bytes", types.BLOB_SIZE)
	}
	commitment := make([]byte, 48)
	result := C.polystore_commit_received_blob((*C.uchar)(unsafe.Pointer(&blob[0])), C.size_t(len(blob)), (*C.uchar)(unsafe.Pointer(&commitment[0])))
	if result != 0 {
		return nil, fmt.Errorf("native received blob commitment rejected input: %d", result)
	}
	return commitment, nil
}
