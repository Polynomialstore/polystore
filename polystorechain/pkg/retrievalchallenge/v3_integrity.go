package retrievalchallenge

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"hash"
)

const (
	FATV3HeaderBytes          = 128
	IntegrityLeavesPerUserMDU = uint64(96)
	MaxIntegrityLeaves        = uint64(65536 * 96)
)

type FATV3Header struct {
	RecordCount   uint32
	LeafCount     uint64
	IntegrityRoot [32]byte
}

func (h FATV3Header) Bytes() ([FATV3HeaderBytes]byte, error) {
	var b [FATV3HeaderBytes]byte
	if h.LeafCount == 0 || h.LeafCount > MaxIntegrityLeaves || h.LeafCount%IntegrityLeavesPerUserMDU != 0 {
		return b, errors.New("invalid FAT v3 integrity leaf count")
	}
	copy(b[:4], "NILF")
	binary.LittleEndian.PutUint16(b[4:6], 3)
	binary.LittleEndian.PutUint16(b[6:8], 256)
	binary.LittleEndian.PutUint32(b[8:12], h.RecordCount)
	b[12] = 1
	b[13] = 1
	binary.LittleEndian.PutUint32(b[16:20], uint32(EncodedBlobBytes))
	binary.LittleEndian.PutUint64(b[20:28], h.LeafCount)
	copy(b[28:60], h.IntegrityRoot[:])
	return b, nil
}

func ParseFATV3Header(b []byte) (FATV3Header, error) {
	var h FATV3Header
	if len(b) != FATV3HeaderBytes || string(b[:4]) != "NILF" || binary.LittleEndian.Uint16(b[4:6]) != 3 || binary.LittleEndian.Uint16(b[6:8]) != 256 || b[12] != 1 || b[13] != 1 || b[14] != 0 || b[15] != 0 || binary.LittleEndian.Uint32(b[16:20]) != uint32(EncodedBlobBytes) {
		return h, errors.New("invalid FAT v3 header")
	}
	for _, v := range b[60:] {
		if v != 0 {
			return h, errors.New("nonzero FAT v3 reserved bytes")
		}
	}
	h.RecordCount = binary.LittleEndian.Uint32(b[8:12])
	h.LeafCount = binary.LittleEndian.Uint64(b[20:28])
	copy(h.IntegrityRoot[:], b[28:60])
	if h.LeafCount == 0 || h.LeafCount > MaxIntegrityLeaves || h.LeafCount%IntegrityLeavesPerUserMDU != 0 {
		return FATV3Header{}, errors.New("invalid FAT v3 integrity leaf count")
	}
	return h, nil
}

func IntegrityLeafV3(mdu uint64, leaf uint32, blob []byte) ([32]byte, error) {
	if mdu == 0 || mdu > 65536 || leaf >= 96 || len(blob) != int(EncodedBlobBytes) {
		return [32]byte{}, errors.New("invalid v3 integrity coordinate or blob length")
	}
	h := sha256.New()
	writeLPHash(h, "polystore/integrity-leaf/v3")
	var fixed [16]byte
	binary.BigEndian.PutUint64(fixed[:8], mdu)
	binary.BigEndian.PutUint32(fixed[8:12], leaf)
	binary.BigEndian.PutUint32(fixed[12:], uint32(EncodedBlobBytes))
	h.Write(fixed[:])
	h.Write(blob)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out, nil
}
func writeLPHash(h hash.Hash, value string) {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(value)))
	h.Write(n[:])
	h.Write([]byte(value))
}
func integrityParentV3(left, right [32]byte) [32]byte {
	h := sha256.New()
	writeLPHash(h, "polystore/integrity-node/v3")
	h.Write(left[:])
	h.Write(right[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func IntegrityRootV3(leaves [][32]byte) ([32]byte, error) {
	if len(leaves) == 0 || uint64(len(leaves)) > MaxIntegrityLeaves {
		return [32]byte{}, errors.New("invalid integrity leaf count")
	}
	level := append([][32]byte(nil), leaves...)
	for len(level) > 1 {
		write := 0
		for read := 0; read < len(level); read += 2 {
			right := level[read]
			if read+1 < len(level) {
				right = level[read+1]
			}
			level[write] = integrityParentV3(level[read], right)
			write++
		}
		level = level[:write]
	}
	return level[0], nil
}

func VerifyIntegrityPathV3(value [32]byte, position, leafCount uint64, siblings [][32]byte, expected [32]byte) bool {
	if leafCount == 0 || leafCount > MaxIntegrityLeaves || position >= leafCount {
		return false
	}
	current, width, used := value, leafCount, 0
	for width > 1 {
		if used >= len(siblings) {
			return false
		}
		s := siblings[used]
		if width%2 == 1 && position == width-1 && s != current {
			return false
		}
		if position%2 == 1 {
			current = integrityParentV3(s, current)
		} else {
			current = integrityParentV3(current, s)
		}
		position /= 2
		width = (width + 1) / 2
		used++
	}
	return used == len(siblings) && current == expected
}
