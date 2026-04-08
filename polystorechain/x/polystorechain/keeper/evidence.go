package keeper

import (
	"crypto/sha256"
	"encoding/binary"
)

var evidenceSeedTag = []byte("nilstore/evidence/v1")

func deriveEvidenceID(kind string, dealID uint64, epochID uint64, extra []byte) [32]byte {
	buf := make([]byte, 0, len(evidenceSeedTag)+len(kind)+8+8+len(extra))
	buf = append(buf, evidenceSeedTag...)
	buf = append(buf, []byte(kind)...)
	buf = binary.BigEndian.AppendUint64(buf, dealID)
	buf = binary.BigEndian.AppendUint64(buf, epochID)
	buf = append(buf, extra...)
	return sha256.Sum256(buf)
}

