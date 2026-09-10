package retrievalchallenge

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"hash"
	"io"
)

const (
	FATV3HeaderBytes          = 128
	FATV3MaxRecords           = uint32(23807)
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
	if h.RecordCount > FATV3MaxRecords || h.LeafCount == 0 || h.LeafCount > MaxIntegrityLeaves || h.LeafCount%IntegrityLeavesPerUserMDU != 0 {
		return b, errors.New("invalid FAT v3 header bounds")
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
	if h.RecordCount > FATV3MaxRecords || h.LeafCount == 0 || h.LeafCount > MaxIntegrityLeaves || h.LeafCount%IntegrityLeavesPerUserMDU != 0 {
		return FATV3Header{}, errors.New("invalid FAT v3 header bounds")
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

// IntegrityParentV3 derives one canonical internal node. Storage providers use
// it to materialize an untrusted, seekable copy of the integrity tree; callers
// must still verify every resulting path against the authenticated root.
func IntegrityParentV3(left, right [32]byte) [32]byte {
	return integrityParentV3(left, right)
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

// IntegrityRootV3Reader verifies the canonical raw leaf-vector sidecar without
// retaining it in memory. The reader must contain exactly leafCount consecutive
// 32-byte hashes. Odd rightmost subtrees are duplicated at every missing level.
func IntegrityRootV3Reader(r io.Reader, leafCount uint64) ([32]byte, error) {
	if leafCount == 0 || leafCount > MaxIntegrityLeaves {
		return [32]byte{}, errors.New("invalid integrity leaf count")
	}
	var peaks [24][32]byte
	var occupied [24]bool
	for i := uint64(0); i < leafCount; i++ {
		var node [32]byte
		if _, err := io.ReadFull(r, node[:]); err != nil {
			return [32]byte{}, errors.New("truncated integrity leaf vector")
		}
		for level := 0; ; level++ {
			if !occupied[level] {
				peaks[level], occupied[level] = node, true
				break
			}
			node = integrityParentV3(peaks[level], node)
			occupied[level] = false
		}
	}
	var extra [1]byte
	if n, err := r.Read(extra[:]); n != 0 || err != io.EOF {
		return [32]byte{}, errors.New("extended integrity leaf vector")
	}
	highest := len(peaks) - 1
	for !occupied[highest] {
		highest--
	}
	lowest := 0
	for !occupied[lowest] {
		lowest++
	}
	root, rootLevel := peaks[lowest], lowest
	for level := lowest + 1; level <= highest; level++ {
		if !occupied[level] {
			root = integrityParentV3(root, root)
			rootLevel++
			continue
		}
		for rootLevel < level {
			root = integrityParentV3(root, root)
			rootLevel++
		}
		root = integrityParentV3(peaks[level], root)
		rootLevel++
	}
	return root, nil
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
