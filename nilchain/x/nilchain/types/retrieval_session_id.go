package types

import (
	"encoding/binary"
	"errors"

	gethCrypto "github.com/ethereum/go-ethereum/crypto"
)

const (
	BlobSizeBytes = uint64(128 * 1024)
	BlobsPerMdu   = uint64(64)
)

// HashRetrievalSessionID computes a deterministic 32-byte session id from fixed-size fields.
//
// Canonical encoding (bytes concatenation, big-endian integers):
//   owner(20) || deal_id(8) || provider(20) || manifest_root(48) ||
//   start_mdu_index(8) || start_blob_index(4) || blob_count(8) ||
//   nonce(8) || expires_at(8)
func HashRetrievalSessionID(
	owner20 []byte,
	dealID uint64,
	provider20 []byte,
	manifestRoot48 []byte,
	startMduIndex uint64,
	startBlobIndex uint32,
	blobCount uint64,
	nonce uint64,
	expiresAt uint64,
) ([]byte, error) {
	if len(owner20) != 20 {
		return nil, errors.New("owner must be 20 bytes")
	}
	if len(provider20) != 20 {
		return nil, errors.New("provider must be 20 bytes")
	}
	if len(manifestRoot48) != 48 {
		return nil, errors.New("manifest_root must be 48 bytes")
	}

	buf := make([]byte, 0, 132)
	buf = append(buf, owner20...)
	var tmp8 [8]byte
	binary.BigEndian.PutUint64(tmp8[:], dealID)
	buf = append(buf, tmp8[:]...)
	buf = append(buf, provider20...)
	buf = append(buf, manifestRoot48...)
	binary.BigEndian.PutUint64(tmp8[:], startMduIndex)
	buf = append(buf, tmp8[:]...)
	var tmp4 [4]byte
	binary.BigEndian.PutUint32(tmp4[:], startBlobIndex)
	buf = append(buf, tmp4[:]...)
	binary.BigEndian.PutUint64(tmp8[:], blobCount)
	buf = append(buf, tmp8[:]...)
	binary.BigEndian.PutUint64(tmp8[:], nonce)
	buf = append(buf, tmp8[:]...)
	binary.BigEndian.PutUint64(tmp8[:], expiresAt)
	buf = append(buf, tmp8[:]...)

	h := gethCrypto.Keccak256(buf)
	return h, nil
}

