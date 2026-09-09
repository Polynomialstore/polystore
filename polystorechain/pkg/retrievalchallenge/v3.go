package retrievalchallenge

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math"
	"math/big"
	"regexp"
	"unicode/utf8"
)

const (
	Version3               = uint32(3)
	StripeK8M4             = uint8(2)
	DataBlobPayloadBytes   = uint64(126976)
	EncodedBlobBytes       = uint64(131072)
	MaxLargeRangeBytes     = uint64(1 << 30)
	MaxLargeSessionSamples = uint64(132)
	FundingDealEscrow      = uint8(1)
	FundingRequester       = uint8(2)
	maxV3ContextBytes      = 734 // exact fixed bytes + chain(50), denom(128), and two uint256 decimals(78 each)
)

var denomRE = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$`)

type RangeV3 struct {
	First, Last, Population uint64
}

// CheckedRangeV3 maps an authorized logical range to systematic encoded blobs.
func CheckedRangeV3(fileStart, fileLength, rangeStart, rangeLength, userMDUs uint64) (RangeV3, error) {
	if rangeLength == 0 || rangeLength > MaxLargeRangeBytes || userMDUs == 0 {
		return RangeV3{}, errors.New("invalid v3 range length or allocation")
	}
	rangeEnd, ok := add64(rangeStart, rangeLength)
	if !ok || rangeEnd > fileLength {
		return RangeV3{}, errors.New("v3 range exceeds file")
	}
	abs, ok := add64(fileStart, rangeStart)
	if !ok {
		return RangeV3{}, errors.New("v3 range start overflow")
	}
	end, ok := add64(abs, rangeLength-1)
	if !ok {
		return RangeV3{}, errors.New("v3 range end overflow")
	}
	r := RangeV3{First: abs / DataBlobPayloadBytes, Last: end / DataBlobPayloadBytes}
	r.Population = r.Last - r.First + 1
	if userMDUs > math.MaxUint64/64 || r.Last >= userMDUs*64 {
		return RangeV3{}, errors.New("v3 range exceeds generation")
	}
	return r, nil
}

func add64(a, b uint64) (uint64, bool) {
	if b > math.MaxUint64-a {
		return 0, false
	}
	return a + b, true
}

type ObligationV3 struct {
	Slot            uint32
	Assigned, Payee [20]byte
	BlobCount       uint64
}

type PlanV3 struct {
	RangeV3
	Obligations []ObligationV3
}

// BuildPlanV3 derives its descriptor in O(8), independent of range size.
func BuildPlanV3(r RangeV3, providers [8][20]byte) (PlanV3, error) {
	if r.Last < r.First {
		return PlanV3{}, errors.New("noncanonical v3 range")
	}
	expected, ok := add64(r.Last-r.First, 1)
	if !ok || r.Population == 0 || r.Population != expected {
		return PlanV3{}, errors.New("noncanonical v3 range")
	}
	p := PlanV3{RangeV3: r, Obligations: make([]ObligationV3, 0, 8)}
	for slot := uint32(0); slot < 8; slot++ {
		count := residueCount(r.First, r.Last, uint64(slot), 8)
		if count != 0 {
			p.Obligations = append(p.Obligations, ObligationV3{slot, providers[slot], providers[slot], count})
		}
	}
	return p, nil
}

func residueCount(first, last, residue, modulus uint64) uint64 {
	delta := (residue + modulus - first%modulus) % modulus
	if delta > last-first {
		return 0
	}
	return 1 + (last-first-delta)/modulus
}

func (p PlanV3) validate() error {
	if p.Last < p.First {
		return errors.New("invalid v3 plan range")
	}
	expected, ok := add64(p.Last-p.First, 1)
	if !ok || p.Population == 0 || p.Population != expected || len(p.Obligations) < 1 || len(p.Obligations) > 8 {
		return errors.New("invalid v3 plan range")
	}
	var total uint64
	lastSlot := int64(-1)
	for _, o := range p.Obligations {
		if o.Slot > 7 || int64(o.Slot) <= lastSlot || o.Assigned != o.Payee || o.BlobCount != residueCount(p.First, p.Last, uint64(o.Slot), 8) || o.BlobCount == 0 {
			return errors.New("invalid v3 obligation")
		}
		total += o.BlobCount
		lastSlot = int64(o.Slot)
	}
	if total != p.Population {
		return errors.New("v3 plan count mismatch")
	}
	return nil
}

func (p PlanV3) Bytes() ([]byte, error) {
	if err := p.validate(); err != nil {
		return nil, err
	}
	b := appendLP(nil, "polystore/retrieval-plan/v3")
	for _, v := range []uint64{p.First, p.Last, p.Population} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	b = binary.BigEndian.AppendUint32(b, uint32(len(p.Obligations)))
	for _, o := range p.Obligations {
		b = binary.BigEndian.AppendUint32(b, o.Slot)
		b = append(b, o.Assigned[:]...)
		b = append(b, o.Payee[:]...)
		b = binary.BigEndian.AppendUint64(b, o.BlobCount)
	}
	return b, nil
}
func (p PlanV3) Hash() ([32]byte, error) {
	b, e := p.Bytes()
	if e != nil {
		return [32]byte{}, e
	}
	return sha256.Sum256(b), nil
}

type SessionBindingV3 struct {
	ChainID                 string
	Owner                   [20]byte
	DealID, Generation      uint64
	FileRecordIndex         uint32
	RangeStart, RangeLength uint64
	PlanHash                [32]byte
	Nonce                   uint64
}

func (s SessionBindingV3) Bytes() ([]byte, error) {
	if !validChain(s.ChainID) || s.RangeLength == 0 || s.RangeLength > MaxLargeRangeBytes {
		return nil, errors.New("invalid v3 session binding")
	}
	b := appendLP(nil, "polystore/retrieval-session/v3")
	b = binary.BigEndian.AppendUint32(b, Version3)
	b = appendLP(b, s.ChainID)
	b = append(b, s.Owner[:]...)
	for _, v := range []uint64{s.DealID, s.Generation} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	b = binary.BigEndian.AppendUint32(b, s.FileRecordIndex)
	for _, v := range []uint64{s.RangeStart, s.RangeLength} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	b = append(b, s.PlanHash[:]...)
	b = binary.BigEndian.AppendUint64(b, s.Nonce)
	return b, nil
}
func (s SessionBindingV3) ID() ([32]byte, error) {
	b, e := s.Bytes()
	if e != nil {
		return [32]byte{}, e
	}
	return sha256.Sum256(b), nil
}

type GenerationAcceptanceV3 struct {
	ChainID                   string
	SetupDigest               [32]byte
	DealID, Generation        uint64
	PolyFSRoot, IntegrityRoot [32]byte
	MetadataMDUs, UserMDUs    uint64
	Slot                      uint32
	Provider                  [20]byte
}

func (a GenerationAcceptanceV3) Bytes() ([]byte, error) {
	if !validChain(a.ChainID) || a.MetadataMDUs == 0 || a.MetadataMDUs > maxMDUs || a.UserMDUs == 0 || a.UserMDUs > maxMDUs-a.MetadataMDUs || a.Slot >= 12 {
		return nil, errors.New("invalid v3 generation acceptance")
	}
	b := appendLP(nil, "polystore/generation-acceptance/v3")
	b = appendLP(b, a.ChainID)
	b = append(b, a.SetupDigest[:]...)
	for _, v := range []uint64{a.DealID, a.Generation} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	b = append(b, a.PolyFSRoot[:]...)
	b = append(b, a.IntegrityRoot[:]...)
	b = append(b, StripeK8M4)
	b = binary.BigEndian.AppendUint32(b, 8)
	b = binary.BigEndian.AppendUint32(b, 4)
	b = binary.BigEndian.AppendUint64(b, a.MetadataMDUs)
	b = binary.BigEndian.AppendUint64(b, a.UserMDUs)
	b = binary.BigEndian.AppendUint32(b, a.Slot)
	b = append(b, a.Provider[:]...)
	return b, nil
}
func (a GenerationAcceptanceV3) Hash() ([32]byte, error) {
	b, e := a.Bytes()
	if e != nil {
		return [32]byte{}, e
	}
	return sha256.Sum256(b), nil
}

type ObligationAckV3 struct {
	ChainID                          string
	SessionID, ContextHash, PlanHash [32]byte
	Slot                             uint32
	Assigned, Payee                  [20]byte
	BlobCount, BilledEncodedBytes    uint64
	IntegrityRoot                    [32]byte
}

func (a ObligationAckV3) Bytes() ([]byte, error) {
	want, ok := mul64(a.BlobCount, EncodedBlobBytes)
	if !validChain(a.ChainID) || a.Slot >= 8 || a.Assigned != a.Payee || a.BlobCount == 0 || !ok || a.BilledEncodedBytes != want {
		return nil, errors.New("invalid v3 obligation ACK")
	}
	b := appendLP(nil, "polystore/retrieval-obligation-ack/v3")
	b = appendLP(b, a.ChainID)
	b = append(b, a.SessionID[:]...)
	b = append(b, a.ContextHash[:]...)
	b = append(b, a.PlanHash[:]...)
	b = binary.BigEndian.AppendUint32(b, a.Slot)
	b = append(b, a.Assigned[:]...)
	b = append(b, a.Payee[:]...)
	b = binary.BigEndian.AppendUint64(b, a.BlobCount)
	b = binary.BigEndian.AppendUint64(b, a.BilledEncodedBytes)
	b = append(b, a.IntegrityRoot[:]...)
	return b, nil
}
func (a ObligationAckV3) Hash() ([32]byte, error) {
	b, e := a.Bytes()
	if e != nil {
		return [32]byte{}, e
	}
	return sha256.Sum256(b), nil
}
func mul64(a, b uint64) (uint64, bool) {
	if a != 0 && b > math.MaxUint64/a {
		return 0, false
	}
	return a * b, true
}

type ContextV3 struct {
	ChainID                                              string
	SetupDigest, SessionID                               [32]byte
	SessionOwner                                         [20]byte
	DealID, Generation                                   uint64
	PolyFSRoot, IntegrityRoot                            [32]byte
	FileRecordIndex                                      uint32
	FileStartOffset, FileLength, RangeStart, RangeLength uint64
	MetadataMDUs, UserMDUs                               uint64
	PlanHash                                             [32]byte
	Population, SampleCount, Nonce                       uint64
	PriceDenom, PricePerBlob, BaseFee                    string
	CompletionBurnBPS                                    uint32
	FundingKind                                          uint8
	FundingPayer                                         [20]byte
	Window                                               Window
	DealEnd                                              uint64
}

func (c ContextV3) validate() error {
	if !validChain(c.ChainID) || c.MetadataMDUs == 0 || c.MetadataMDUs > maxMDUs || c.UserMDUs == 0 || c.UserMDUs > maxMDUs-c.MetadataMDUs {
		return errors.New("invalid v3 chain or MDU bounds")
	}
	r, e := CheckedRangeV3(c.FileStartOffset, c.FileLength, c.RangeStart, c.RangeLength, c.UserMDUs)
	if e != nil || r.Population != c.Population {
		return errors.New("invalid v3 frozen range")
	}
	if c.SampleCount != min(c.Population, MaxLargeSessionSamples) {
		return errors.New("invalid v3 sample count")
	}
	if !denomRE.MatchString(c.PriceDenom) || !validUint256Decimal(c.PricePerBlob) || !validUint256Decimal(c.BaseFee) || c.CompletionBurnBPS > 10000 {
		return errors.New("invalid v3 economics")
	}
	if c.FundingKind != FundingDealEscrow && c.FundingKind != FundingRequester {
		return errors.New("invalid v3 funding")
	}
	if c.FundingPayer != c.SessionOwner {
		return errors.New("v3 payer differs from owner")
	}
	sid, e := (SessionBindingV3{c.ChainID, c.SessionOwner, c.DealID, c.Generation, c.FileRecordIndex, c.RangeStart, c.RangeLength, c.PlanHash, c.Nonce}).ID()
	if e != nil || sid != c.SessionID {
		return errors.New("v3 session ID mismatch")
	}
	expected, e := SessionWindow(c.Window.Snapshot, c.Window.Deadline, c.DealEnd)
	if e != nil || expected != c.Window {
		return errors.New("noncanonical v3 window")
	}
	return nil
}
func validChain(s string) bool {
	return len(s) > 0 && len(s) <= 50 && utf8.ValidString(s) && !containsNUL(s)
}
func containsNUL(s string) bool {
	for _, b := range []byte(s) {
		if b == 0 {
			return true
		}
	}
	return false
}
func validUint256Decimal(s string) bool {
	if len(s) == 0 || len(s) > 78 || (len(s) > 1 && s[0] == '0') {
		return false
	}
	for _, b := range []byte(s) {
		if b < '0' || b > '9' {
			return false
		}
	}
	v, ok := new(big.Int).SetString(s, 10)
	return ok && v.BitLen() <= 256
}

func (c ContextV3) Bytes() ([]byte, error) {
	if err := c.validate(); err != nil {
		return nil, err
	}
	b := appendLP(make([]byte, 0, maxV3ContextBytes), "polystore/challenge-context/v3")
	b = binary.BigEndian.AppendUint32(b, Version3)
	b = appendLP(b, c.ChainID)
	b = append(b, c.SetupDigest[:]...)
	b = append(b, c.SessionID[:]...)
	b = append(b, c.SessionOwner[:]...)
	for _, v := range []uint64{c.DealID, c.Generation} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	b = append(b, c.PolyFSRoot[:]...)
	b = append(b, c.IntegrityRoot[:]...)
	b = binary.BigEndian.AppendUint32(b, c.FileRecordIndex)
	for _, v := range []uint64{c.FileStartOffset, c.FileLength, c.RangeStart, c.RangeLength} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	b = append(b, StripeK8M4)
	b = binary.BigEndian.AppendUint32(b, 8)
	b = binary.BigEndian.AppendUint32(b, 4)
	for _, v := range []uint64{c.MetadataMDUs, c.UserMDUs} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	b = append(b, c.PlanHash[:]...)
	for _, v := range []uint64{c.Population, c.SampleCount, c.Nonce} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	b = appendLP(b, c.PriceDenom)
	b = appendLP(b, c.PricePerBlob)
	b = appendLP(b, c.BaseFee)
	b = binary.BigEndian.AppendUint32(b, c.CompletionBurnBPS)
	b = append(b, c.FundingKind)
	b = append(b, c.FundingPayer[:]...)
	for _, v := range []uint64{c.Window.Snapshot, c.Window.Anchor, c.Window.First, c.Window.Deadline, c.DealEnd} {
		b = binary.BigEndian.AppendUint64(b, v)
	}
	if len(b) > maxV3ContextBytes {
		return nil, errors.New("v3 context exceeds derived bound")
	}
	return b, nil
}
func (c ContextV3) Hash() ([32]byte, error) {
	b, e := c.Bytes()
	if e != nil {
		return [32]byte{}, e
	}
	return sha256.Sum256(b), nil
}
func (c ContextV3) Seed(anchor []byte) ([32]byte, error) {
	if len(anchor) != 32 {
		return [32]byte{}, errors.New("anchor must be 32 bytes")
	}
	h, e := c.Hash()
	if e != nil {
		return [32]byte{}, e
	}
	b := appendLP(nil, "polystore/challenge-seed/v3")
	b = append(b, h[:]...)
	b = append(b, anchor...)
	return sha256.Sum256(b), nil
}

type ChallengeV3 struct {
	Ordinal, Position, T, MDUIndex uint64
	LeafIndex, Slot                uint32
	Z                              [32]byte
}

func (c ContextV3) Challenges(seed []byte) ([]ChallengeV3, error) {
	if len(seed) != 32 {
		return nil, errors.New("seed must be 32 bytes")
	}
	h, e := c.Hash()
	if e != nil {
		return nil, e
	}
	positions, e := sampleWithDomain(h, seed, c.Population, c.SampleCount, "polystore/session-position/v3", MaxLargeSessionSamples)
	if e != nil {
		return nil, e
	}
	r, _ := CheckedRangeV3(c.FileStartOffset, c.FileLength, c.RangeStart, c.RangeLength, c.UserMDUs)
	out := make([]ChallengeV3, len(positions))
	for i, p := range positions {
		t := r.First + p
		mdu, leaf, slot := coordinateV3(t, c.MetadataMDUs)
		v := ChallengeV3{uint64(i), p, t, mdu, leaf, slot, [32]byte{}}
		b := appendLP(nil, "polystore/blob-challenge/v3")
		b = append(b, h[:]...)
		b = append(b, seed...)
		for _, x := range []uint64{v.Ordinal, v.T, v.MDUIndex} {
			b = binary.BigEndian.AppendUint64(b, x)
		}
		b = binary.BigEndian.AppendUint32(b, v.LeafIndex)
		b = binary.BigEndian.AppendUint32(b, 0)
		v.Z, e = hashToPoint(b, sha256.Sum256)
		if e != nil {
			return nil, e
		}
		out[i] = v
	}
	return out, nil
}
func coordinateV3(t, metadata uint64) (uint64, uint32, uint32) {
	d := t % 64
	slot := uint32(d % 8)
	row := uint32(d / 8)
	return metadata + t/64, slot*8 + row, slot
}
