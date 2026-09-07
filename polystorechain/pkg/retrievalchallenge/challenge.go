// Package retrievalchallenge defines inactive v2 challenge transcripts and bounded
// derivation. It does not authenticate actors, anchors, setup files or chain state,
// verify KZG proofs, or activate a protocol version. See the challenge RFC.
package retrievalchallenge

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"math/big"
	"strings"
	"unicode/utf8"
)

const (
	Version = uint32(2)
	Session = uint8(1)
	Audit   = uint8(2)
	Replica = uint8(1)
	Stripe  = uint8(2)
	// MaxSamples is an inactive v2 hard ceiling, not a quota or deployment profile.
	MaxSamples  = uint64(4096)
	maxAttempts = uint32(256)
	maxMDUs     = uint64(65537) // Root table addresses nonzero MDU indices 1..65536.
)

// Window is inclusive. Snapshot state must be committed before Anchor is known.
// In epoch 1, Snapshot=0 means the committed genesis state.
type Window struct{ Snapshot, Anchor, First, Deadline uint64 }

func (w Window) Contains(height uint64) bool {
	return w.Snapshot <= math.MaxInt64-2 && w.Anchor == w.Snapshot+1 && w.First == w.Anchor+1 &&
		w.First <= w.Deadline && w.Deadline <= math.MaxInt64 && height >= w.First && height <= w.Deadline
}

// SessionWindow preserves expiry at the deal end itself. New opens must precede
// the deal end and leave at least the H+2 response height before expiry.
func SessionWindow(open, expiry, dealEnd uint64) (Window, error) {
	if open == 0 || open > math.MaxInt64-2 || dealEnd == 0 || dealEnd > math.MaxInt64 || open >= dealEnd || expiry > dealEnd || expiry < open+2 {
		return Window{}, errors.New("invalid session response window")
	}
	return Window{open, open + 1, open + 2, expiry}, nil
}

// AuditWindow freezes at S-1, anchors at S and permits responses at S+1..E,
// truncated at dealEnd-1. An empty interval issues no obligation (issued=false),
// hence cannot justify an audit reward or a provider failure.
func AuditWindow(epoch, length, dealEnd uint64) (w Window, issued bool, err error) {
	if epoch == 0 || length < 2 || length > math.MaxInt64 || dealEnd == 0 || dealEnd > math.MaxInt64 || epoch > math.MaxInt64/length {
		return Window{}, false, errors.New("invalid epoch response window")
	}
	end := epoch * length
	start := end - length + 1
	deadline := min(end, dealEnd-1)
	if deadline < start+1 {
		return Window{}, false, nil
	}
	return Window{start - 1, start, start + 1, deadline}, true, nil
}

// Context contains canonical values frozen by an authenticated open or epoch
// snapshot. Addresses are decoded raw account bytes, never display strings.
// SetupDigest identifies the externally authenticated exact setup artifact.
// Audit ID and session-only fields are zero; session epoch fields are zero.
type Context struct {
	Version                           uint32
	ChainID                           string
	SetupDigest                       [32]byte
	Kind                              uint8
	ID                                [32]byte
	DealID, Generation                uint64
	Root                              [32]byte
	Assigned, Payee                   [20]byte
	Layout                            uint8
	K, M, Slot                        uint32
	MetadataMDUs, UserMDUs            uint64
	StartMDU                          uint64
	StartLeaf                         uint32
	BlobCount                         uint64
	EpochID, EpochLength, SampleCount uint64
	Window                            Window
	DealEnd                           uint64
}

func (c Context) dimensions() (rows, population uint64, err error) {
	if c.Version != Version || len(c.ChainID) == 0 || len(c.ChainID) > 50 || !utf8.ValidString(c.ChainID) || strings.ContainsRune(c.ChainID, 0) {
		return 0, 0, errors.New("invalid version or chain ID")
	}
	switch c.Layout {
	case Replica:
		if c.K != 1 || c.M != 0 || c.Slot != 0 {
			return 0, 0, errors.New("noncanonical replica layout")
		}
		rows = 64
	case Stripe:
		if c.K == 0 || c.K > 64 || 64%c.K != 0 || c.M == 0 || uint64(c.K)+uint64(c.M) > 256 || uint64(c.Slot) >= uint64(c.K)+uint64(c.M) {
			return 0, 0, errors.New("invalid stripe layout")
		}
		rows = 64 / uint64(c.K)
	default:
		return 0, 0, errors.New("unknown layout")
	}
	if c.MetadataMDUs == 0 || c.MetadataMDUs > maxMDUs || c.UserMDUs > maxMDUs-c.MetadataMDUs {
		return 0, 0, errors.New("MDU range exceeds PolyFS root table")
	}
	// The root-table bound above also proves that this product cannot overflow.
	population = c.UserMDUs * rows
	switch c.Kind {
	case Session:
		if c.EpochID != 0 || c.EpochLength != 0 || c.SampleCount != 0 {
			return 0, 0, errors.New("session contains audit fields")
		}
		expected, e := SessionWindow(c.Window.Snapshot, c.Window.Deadline, c.DealEnd)
		if e != nil || c.Window != expected {
			return 0, 0, errors.New("noncanonical session window")
		}
		if c.StartMDU < c.MetadataMDUs || c.StartMDU-c.MetadataMDUs >= c.UserMDUs || c.BlobCount == 0 || c.BlobCount > MaxSamples {
			return 0, 0, errors.New("invalid session MDU or proof count")
		}
		firstLeaf := uint64(c.Slot) * rows
		if uint64(c.StartLeaf) < firstLeaf || uint64(c.StartLeaf)-firstLeaf >= rows {
			return 0, 0, errors.New("session leaf outside assignment")
		}
		row := uint64(c.StartLeaf) - firstLeaf
		start := (c.StartMDU-c.MetadataMDUs)*rows + row
		if c.BlobCount > population-start || c.BlobCount > rows-row {
			return 0, 0, errors.New("session range exceeds allocation or slot")
		}
	case Audit:
		if c.ID != [32]byte{} || c.Payee != c.Assigned || c.StartMDU != 0 || c.StartLeaf != 0 || c.BlobCount != 0 {
			return 0, 0, errors.New("noncanonical audit authority or session fields")
		}
		expected, issued, e := AuditWindow(c.EpochID, c.EpochLength, c.DealEnd)
		if e != nil || !issued || c.Window != expected {
			return 0, 0, errors.New("unissued or noncanonical audit window")
		}
		if c.SampleCount == 0 || c.SampleCount > population || c.SampleCount > MaxSamples {
			return 0, 0, errors.New("invalid audit sample count")
		}
	default:
		return 0, 0, errors.New("unknown challenge kind")
	}
	return rows, population, nil
}

func appendLP(b []byte, s string) []byte {
	b = binary.BigEndian.AppendUint32(b, uint32(len(s)))
	return append(b, s...)
}

// Bytes returns the single canonical transcript. Only bounded, already decoded
// fields enter it; it is not a protobuf/ABI decoder or an authorization check.
func (c Context) Bytes() ([]byte, error) {
	if _, _, err := c.dimensions(); err != nil {
		return nil, err
	}
	b := make([]byte, 0, 512)
	b = appendLP(b, "polystore/challenge-context/v2")
	b = binary.BigEndian.AppendUint32(b, c.Version)
	b = appendLP(b, c.ChainID)
	b = append(b, c.SetupDigest[:]...)
	b = append(b, c.Kind)
	b = append(b, c.ID[:]...)
	b = binary.BigEndian.AppendUint64(b, c.DealID)
	b = binary.BigEndian.AppendUint64(b, c.Generation)
	b = append(b, c.Root[:]...)
	b = append(b, c.Assigned[:]...)
	b = append(b, c.Payee[:]...)
	b = append(b, c.Layout)
	for _, v := range []uint32{c.K, c.M, c.Slot} {
		b = binary.BigEndian.AppendUint32(b, v)
	}
	for _, v := range []uint64{c.MetadataMDUs, c.UserMDUs, c.StartMDU} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	b = binary.BigEndian.AppendUint32(b, c.StartLeaf)
	for _, v := range []uint64{c.BlobCount, c.EpochID, c.EpochLength, c.SampleCount, c.Window.Snapshot, c.Window.Anchor, c.Window.First, c.Window.Deadline, c.DealEnd} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	return b, nil
}

func (c Context) Hash() ([32]byte, error) {
	b, err := c.Bytes()
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(b), nil
}

// Challenge is an expected statement, not proof acceptance or coverage credit.
// PopulationIndex is selected p_i; Ordinal is i, including in the z transcript.
type Challenge struct {
	Ordinal, PopulationIndex, MDUIndex uint64
	LeafIndex                          uint32
	Z                                  [32]byte
}

// Challenges derives the complete ordered list once. Callers compare exact
// expected tuples/z before FFI and account accepted obligations once in state.
func (c Context) Challenges(seed []byte) ([]Challenge, error) {
	if len(seed) != 32 {
		return nil, errors.New("seed must be exactly 32 bytes")
	}
	rows, population, err := c.dimensions()
	if err != nil {
		return nil, err
	}
	hash, err := c.Hash()
	if err != nil {
		return nil, err
	}
	var positions []uint64
	if c.Kind == Audit {
		positions, err = Sample(hash, seed, population, c.SampleCount)
		if err != nil {
			return nil, err
		}
	} else {
		positions = make([]uint64, c.BlobCount)
		start := (c.StartMDU-c.MetadataMDUs)*rows + uint64(c.StartLeaf) - uint64(c.Slot)*rows
		for i := range positions {
			positions[i] = start + uint64(i)
		}
	}
	out := make([]Challenge, len(positions))
	transcript := appendLP(make([]byte, 0, 128), "polystore/blob-challenge/v2")
	transcript = append(transcript, hash[:]...)
	transcript = append(transcript, seed...)
	prefix := len(transcript)
	for i, p := range positions {
		v := Challenge{Ordinal: uint64(i), PopulationIndex: p, MDUIndex: c.MetadataMDUs + p/rows, LeafIndex: uint32(uint64(c.Slot)*rows + p%rows)}
		transcript = transcript[:prefix]
		transcript = binary.BigEndian.AppendUint64(transcript, v.Ordinal)
		transcript = binary.BigEndian.AppendUint64(transcript, v.MDUIndex)
		transcript = binary.BigEndian.AppendUint32(transcript, v.LeafIndex)
		transcript = binary.BigEndian.AppendUint32(transcript, 0)
		v.Z, err = hashToPoint(transcript, sha256.Sum256)
		if err != nil {
			return nil, err
		}
		out[i] = v
	}
	return out, nil
}

var (
	fieldModulus      = mustFieldModulus()
	fieldModulusBytes = [32]byte(fieldModulus.FillBytes(make([]byte, 32)))
	domainOrder       = big.NewInt(4096)
	one               = big.NewInt(1)
)

func mustFieldModulus() *big.Int {
	v, ok := new(big.Int).SetString("73eda753299d7d483339d80809a1d80553bda402fffe5bfeffffffff00000001", 16)
	if !ok {
		panic("invalid compiled field modulus")
	}
	return v
}
func validPoint(v [32]byte) bool {
	z := new(big.Int).SetBytes(v[:])
	return z.Sign() > 0 && z.Cmp(fieldModulus) < 0 && new(big.Int).Exp(z, domainOrder, fieldModulus).Cmp(one) != 0
}
func hashToPoint(transcript []byte, hash func([]byte) [32]byte) ([32]byte, error) {
	for counter := uint32(0); counter < maxAttempts; counter++ {
		binary.BigEndian.PutUint32(transcript[len(transcript)-4:], counter)
		z := hash(transcript)
		if validPoint(z) {
			return z, nil
		}
	}
	return [32]byte{}, errors.New("field challenge rejection exhausted: protocol failure")
}

// Sample draws distinct assignment-relative positions using the exact sparse
// tail-swap Fisher-Yates variant in the RFC. It allocates O(count), never O(U).
// The caller must authenticate hash/seed and freeze U/count before seed reveal.
func Sample(hash [32]byte, seed []byte, population, count uint64) ([]uint64, error) {
	if len(seed) != 32 || count > population || count > MaxSamples {
		return nil, errors.New("invalid seed, population or bounded sample count")
	}
	positions := make([]uint64, count)
	swaps := make(map[uint64]uint64, count)
	transcript := appendLP(make([]byte, 0, 128), "polystore/audit-position/v2")
	transcript = append(transcript, hash[:]...)
	transcript = append(transcript, seed...)
	transcript = append(transcript, make([]byte, 12)...)
	for i := uint64(0); i < count; i++ {
		binary.BigEndian.PutUint64(transcript[len(transcript)-12:], i)
		n := population - i
		r, err := draw(n, func(counter uint32) [32]byte {
			binary.BigEndian.PutUint32(transcript[len(transcript)-4:], counter)
			return sha256.Sum256(transcript)
		})
		if err != nil {
			return nil, err
		}
		p, ok := swaps[r]
		if !ok {
			p = r
		}
		tail, ok := swaps[n-1]
		if !ok {
			tail = n - 1
		}
		positions[i] = p
		swaps[r] = tail
		delete(swaps, n-1)
	}
	return positions, nil
}

func draw(n uint64, hash func(uint32) [32]byte) (uint64, error) {
	if n == 0 {
		return 0, errors.New("empty draw range")
	}
	if n == 1 {
		return 0, nil
	}
	// Reject the incomplete upper residue class; modulus reduction alone is biased.
	modulus := new(big.Int).SetUint64(n)
	limit := new(big.Int).Lsh(big.NewInt(1), 256)
	remainder := new(big.Int).Mod(limit, modulus)
	limit.Sub(limit, remainder)
	x := new(big.Int)
	for counter := uint32(0); counter < maxAttempts; counter++ {
		digest := hash(counter)
		x.SetBytes(digest[:])
		if x.Cmp(limit) < 0 {
			return x.Mod(x, modulus).Uint64(), nil
		}
	}
	return 0, errors.New("sample rejection exhausted: protocol failure")
}
