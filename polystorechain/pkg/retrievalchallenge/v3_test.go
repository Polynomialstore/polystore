package retrievalchallenge

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
)

type v3Golden struct {
	FAT struct {
		HeaderHex     string `json:"header_hex"`
		IntegrityRoot string `json:"integrity_root"`
	} `json:"fat_header"`
	Integrity struct {
		LeafHashes []string   `json:"leaf_hashes"`
		Paths      [][]string `json:"paths"`
		Root       string     `json:"root"`
	} `json:"integrity"`
	Small         v3Transcript `json:"small_transcript"`
	Large         v3Transcript `json:"large_transcript"`
	Offset        v3Transcript `json:"offset_transcript"`
	SmallSamples  []v3Sample   `json:"small_samples"`
	OffsetSamples []v3Sample   `json:"offset_samples"`
	LargeSample   struct {
		FirstEight      []uint64 `json:"first_eight"`
		PositionsSHA256 string   `json:"positions_sha256"`
	} `json:"large_sample"`
}
type v3Transcript struct {
	FileStartOffset string `json:"file_start_offset"`
	RangeStart      string `json:"range_start"`
	RangeLength     string `json:"range_length"`
	First           uint64 `json:"first"`
	Last            uint64 `json:"last"`
	Population      uint64 `json:"population"`
	SampleCount     uint64 `json:"sample_count"`
	PlanHex         string `json:"plan_hex"`
	PlanHash        string `json:"plan_hash"`
	SessionHex      string `json:"session_hex"`
	SessionID       string `json:"session_id"`
	ContextHex      string `json:"context_hex"`
	ContextHash     string `json:"context_hash"`
	AnchorHash      string `json:"anchor_hash"`
	Seed            string `json:"seed"`
	AcceptanceHex   string `json:"acceptance_slot0_hex"`
	AcceptanceHash  string `json:"acceptance_slot0_hash"`
	AckHex          string `json:"ack_first_obligation_hex"`
	AckHash         string `json:"ack_first_obligation_hash"`
	Obligations     []struct {
		Slot      uint32 `json:"slot"`
		Assigned  string `json:"assigned_provider"`
		Payee     string `json:"payee"`
		BlobCount uint64 `json:"blob_count"`
	}
}
type v3Sample struct {
	Ordinal   uint64 `json:"ordinal"`
	Position  uint64 `json:"position"`
	T         uint64 `json:"t"`
	MDUIndex  uint64 `json:"mdu_index"`
	LeafIndex uint32 `json:"leaf_index"`
	Slot      uint32 `json:"slot"`
	Z         string `json:"z"`
}

func loadV3Golden(t testing.TB) v3Golden {
	b, err := os.ReadFile("testdata/large-session-v3-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var g v3Golden
	if err = json.Unmarshal(b, &g); err != nil {
		t.Fatal(err)
	}
	return g
}

func fill20(v byte) (out [20]byte) {
	for i := range out {
		out[i] = v
	}
	return
}
func fill32(v byte) (out [32]byte) {
	for i := range out {
		out[i] = v
	}
	return
}
func mustHex32(t testing.TB, s string) (out [32]byte) {
	b, e := hex.DecodeString(s)
	if e != nil || len(b) != 32 {
		t.Fatal(s)
	}
	copy(out[:], b)
	return
}
func makeV3Case(t testing.TB, want v3Transcript) (PlanV3, SessionBindingV3, ContextV3, []byte) {
	parse := func(s string) uint64 {
		v, e := strconv.ParseUint(s, 10, 64)
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	fileStart, rangeStart, length := parse(want.FileStartOffset), parse(want.RangeStart), parse(want.RangeLength)
	user := (want.Last + 64) / 64
	r, e := CheckedRangeV3(fileStart, rangeStart+length, rangeStart, length, user)
	if e != nil {
		t.Fatal(e)
	}
	var providers [8][20]byte
	for i := range providers {
		providers[i] = fill20(byte(0x40 + i))
	}
	p, e := BuildPlanV3(r, providers)
	if e != nil {
		t.Fatal(e)
	}
	ph, _ := p.Hash()
	s := SessionBindingV3{"polystore-test-1", fill20(0x11), 42, 7, 3, rangeStart, length, ph, 9}
	sid, _ := s.ID()
	setup := mustHex32(t, "d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7")
	c := ContextV3{ChainID: "polystore-test-1", SetupDigest: setup, SessionID: sid, SessionOwner: fill20(0x11), DealID: 42, Generation: 7, PolyFSRoot: fill32(0x22), IntegrityRoot: mustHex32(t, "074c4b427382c9ff2e85f0fea1bc39a56bd58a3e3849e737e23faf15a2c67707"), FileRecordIndex: 3, FileStartOffset: fileStart, FileLength: rangeStart + length, RangeStart: rangeStart, RangeLength: length, MetadataMDUs: 2, UserMDUs: user, PlanHash: ph, Population: r.Population, SampleCount: min(r.Population, MaxLargeSessionSamples), Nonce: 9, PriceDenom: "stake", PricePerBlob: "3", BaseFee: "5", CompletionBurnBPS: 250, FundingKind: FundingDealEscrow, FundingPayer: fill20(0x11), Window: Window{100, 101, 102, 200}, DealEnd: 300}
	anchor, _ := hex.DecodeString(want.AnchorHash)
	return p, s, c, anchor
}

func TestV3GoldenTranscriptsAndChallenges(t *testing.T) {
	g := loadV3Golden(t)
	for name, want := range map[string]v3Transcript{"small": g.Small, "large": g.Large, "offset": g.Offset} {
		t.Run(name, func(t *testing.T) {
			p, s, c, anchor := makeV3Case(t, want)
			pb, _ := p.Bytes()
			sb, _ := s.Bytes()
			cb, e := c.Bytes()
			if e != nil {
				t.Fatal(e)
			}
			h, _ := c.Hash()
			seed, _ := c.Seed(anchor)
			for got, w := range map[string]string{hex.EncodeToString(pb): want.PlanHex, hex.EncodeToString(sb): want.SessionHex, hex.EncodeToString(cb): want.ContextHex, hex.EncodeToString(h[:]): want.ContextHash, hex.EncodeToString(seed[:]): want.Seed} {
				if got != w {
					t.Fatalf("transcript mismatch\ngot %s\nwant %s", got, w)
				}
			}
			ch, e := c.Challenges(seed[:])
			if e != nil {
				t.Fatal(e)
			}
			if name == "large" {
				if len(ch) != 132 {
					t.Fatal(len(ch))
				}
				for i, w := range g.LargeSample.FirstEight {
					if ch[i].Position != w {
						t.Fatal(i)
					}
				}
				sum := sha256.New()
				var b [8]byte
				for _, v := range ch {
					binary.BigEndian.PutUint64(b[:], v.Position)
					sum.Write(b[:])
				}
				if hex.EncodeToString(sum.Sum(nil)) != g.LargeSample.PositionsSHA256 {
					t.Fatal("large positions digest")
				}
			}
			accept := GenerationAcceptanceV3{c.ChainID, c.SetupDigest, c.DealID, c.Generation, c.PolyFSRoot, c.IntegrityRoot, c.MetadataMDUs, c.UserMDUs, 0, fill20(0x40)}
			ab, e := accept.Bytes()
			if e != nil {
				t.Fatal(e)
			}
			ah, _ := accept.Hash()
			first := p.Obligations[0]
			ack := ObligationAckV3{c.ChainID, c.SessionID, h, c.PlanHash, first.Slot, first.Assigned, first.Payee, first.BlobCount, first.BlobCount * EncodedBlobBytes, c.IntegrityRoot}
			kb, e := ack.Bytes()
			if e != nil {
				t.Fatal(e)
			}
			kh, _ := ack.Hash()
			if hex.EncodeToString(ab) != want.AcceptanceHex || hex.EncodeToString(ah[:]) != want.AcceptanceHash || hex.EncodeToString(kb) != want.AckHex || hex.EncodeToString(kh[:]) != want.AckHash {
				t.Fatal("acceptance or ACK binding mismatch")
			}
			var samples []v3Sample
			if name == "small" {
				samples = g.SmallSamples
			} else if name == "offset" {
				samples = g.OffsetSamples
			}
			for i, w := range samples {
				v := ch[i]
				if v.Ordinal != w.Ordinal || v.Position != w.Position || v.T != w.T || v.MDUIndex != w.MDUIndex || v.LeafIndex != w.LeafIndex || v.Slot != w.Slot || hex.EncodeToString(v.Z[:]) != w.Z {
					t.Fatalf("challenge %d mismatch: %+v", i, v)
				}
			}
		})
	}
}

func TestV3RejectsRebindingOverflowAndMalformedEconomics(t *testing.T) {
	g := loadV3Golden(t)
	_, _, c, anchor := makeV3Case(t, g.Offset)
	for name, mutate := range map[string]func(*ContextV3){"session": func(x *ContextV3) { x.SessionID[0] ^= 1 }, "file offset": func(x *ContextV3) { x.FileStartOffset = 0 }, "range offset": func(x *ContextV3) { x.RangeStart = 0 }, "sample count": func(x *ContextV3) { x.SampleCount-- }, "denom": func(x *ContextV3) { x.PriceDenom = "x" }, "amount leading zero": func(x *ContextV3) { x.BaseFee = "05" }, "uint256 overflow": func(x *ContextV3) {
		x.BaseFee = "115792089237316195423570985008687907853269984665640564039457584007913129639936"
	}, "funding": func(x *ContextV3) { x.FundingKind = 3 }} {
		t.Run(name, func(t *testing.T) {
			bad := c
			mutate(&bad)
			if _, e := bad.Bytes(); e == nil {
				t.Fatal("accepted rebound context")
			}
		})
	}
	if _, e := c.Seed(anchor[:31]); e == nil {
		t.Fatal("accepted short anchor")
	}
	if _, e := CheckedRangeV3(^uint64(0), 1, 1, 1, 1); e == nil {
		t.Fatal("accepted overflow")
	}
	for _, p := range []PlanV3{{RangeV3{2, 1, 1}, nil}, {RangeV3{0, ^uint64(0), ^uint64(0)}, nil}} {
		if _, e := p.Bytes(); e == nil {
			t.Fatal("accepted malformed public plan")
		}
	}
}

func TestV3MaximumCanonicalContextIs734Bytes(t *testing.T) {
	g := loadV3Golden(t)
	_, _, c, _ := makeV3Case(t, g.Small)
	c.ChainID = strings.Repeat("a", 50)
	c.PriceDenom = "a" + strings.Repeat("z", 127)
	max := "115792089237316195423570985008687907853269984665640564039457584007913129639935"
	c.PricePerBlob = max
	c.BaseFee = max
	s := SessionBindingV3{c.ChainID, c.SessionOwner, c.DealID, c.Generation, c.FileRecordIndex, c.RangeStart, c.RangeLength, c.PlanHash, c.Nonce}
	c.SessionID, _ = s.ID()
	b, e := c.Bytes()
	if e != nil {
		t.Fatal(e)
	}
	if len(b) != maxV3ContextBytes {
		t.Fatalf("got %d, want %d", len(b), maxV3ContextBytes)
	}
}

func pattern(name string) []byte {
	b := make([]byte, EncodedBlobBytes)
	switch name {
	case "valid_incrementing":
		for i := 0; i < 4096; i++ {
			for j := 0; j < 31; j++ {
				b[i*32+1+j] = byte(i + j)
			}
		}
	case "valid_ff":
		for i := 0; i < 4096; i++ {
			for j := 1; j < 32; j++ {
				b[i*32+j] = 0xff
			}
		}
	}
	return b
}
func TestV3FATAndIntegrityGolden(t *testing.T) {
	g := loadV3Golden(t)
	root := mustHex32(t, g.Integrity.Root)
	h := FATV3Header{2, 96, root}
	b, e := h.Bytes()
	if e != nil {
		t.Fatal(e)
	}
	if hex.EncodeToString(b[:]) != g.FAT.HeaderHex {
		t.Fatal("header mismatch")
	}
	if got, e := ParseFATV3Header(b[:]); e != nil || got != h {
		t.Fatalf("parse: %+v %v", got, e)
	}
	maxHeader := FATV3Header{FATV3MaxRecords, 96, root}
	maxBytes, e := maxHeader.Bytes()
	if e != nil {
		t.Fatal("maximum record count rejected", e)
	}
	if got, e := ParseFATV3Header(maxBytes[:]); e != nil || got != maxHeader {
		t.Fatalf("maximum record count parse: %+v %v", got, e)
	}
	tooMany := FATV3Header{FATV3MaxRecords + 1, 96, root}
	if _, e := tooMany.Bytes(); e == nil {
		t.Fatal("record 23808 encoded")
	}
	binary.LittleEndian.PutUint32(maxBytes[8:12], FATV3MaxRecords+1)
	if _, e := ParseFATV3Header(maxBytes[:]); e == nil {
		t.Fatal("record 23808 parsed")
	}
	names := []string{"zero", "valid_incrementing", "valid_ff"}
	leaves := make([][32]byte, 3)
	for i, n := range names {
		leaves[i], e = IntegrityLeafV3(10, uint32(i), pattern(n))
		if e != nil || hex.EncodeToString(leaves[i][:]) != g.Integrity.LeafHashes[i] {
			t.Fatal("leaf", i, e)
		}
	}
	got, _ := IntegrityRootV3(leaves)
	if got != root {
		t.Fatal("root")
	}
	for i, pathHex := range g.Integrity.Paths {
		path := make([][32]byte, len(pathHex))
		for j, s := range pathHex {
			path[j] = mustHex32(t, s)
		}
		if !VerifyIntegrityPathV3(leaves[i], uint64(i), 3, path, root) {
			t.Fatal("path", i)
		}
		if i == 2 {
			bad := append([][32]byte(nil), path...)
			bad[0] = [32]byte{}
			if VerifyIntegrityPathV3(leaves[i], uint64(i), 3, bad, root) {
				t.Fatal("odd duplicate accepted")
			}
		}
	}
	if VerifyIntegrityPathV3(leaves[2], ^uint64(0), 3, nil, root) {
		t.Fatal("negative-equivalent position accepted")
	}
	bad := b
	bad[60] = 1
	if _, e := ParseFATV3Header(bad[:]); e == nil {
		t.Fatal("reserved bytes")
	}
	if _, e := IntegrityLeafV3(10, 0, pattern("zero")[:1]); e == nil {
		t.Fatal("truncated blob")
	}
}

func BenchmarkV3PlanOneKiB(b *testing.B)     { benchmarkPlan(b, 0, 0) }
func BenchmarkV3PlanThreeBlobs(b *testing.B) { benchmarkPlan(b, 63, 65) }
func BenchmarkV3PlanOneGiB(b *testing.B)     { benchmarkPlan(b, 0, 8456) }
func benchmarkPlan(b *testing.B, first, last uint64) {
	var p [8][20]byte
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		if _, e := BuildPlanV3(RangeV3{first, last, last - first + 1}, p); e != nil {
			b.Fatal(e)
		}
	}
}
func BenchmarkV3ChallengesOneKiB(b *testing.B)     { benchmarkChallenges(b, "one_kib") }
func BenchmarkV3ChallengesThreeBlobs(b *testing.B) { benchmarkChallenges(b, "offset") }
func BenchmarkV3ChallengesOneGiB(b *testing.B)     { benchmarkChallenges(b, "large") }
func benchmarkChallenges(b *testing.B, name string) {
	g := loadV3Golden(b)
	var c ContextV3
	var anchor []byte
	switch name {
	case "offset":
		_, _, c, anchor = makeV3Case(b, g.Offset)
	case "large":
		_, _, c, anchor = makeV3Case(b, g.Large)
	default:
		_, _, c, anchor = makeV3Case(b, g.Small)
		r, e := CheckedRangeV3(0, 1024, 0, 1024, 1)
		if e != nil {
			b.Fatal(e)
		}
		var providers [8][20]byte
		for i := range providers {
			providers[i] = fill20(byte(0x40 + i))
		}
		p, e := BuildPlanV3(r, providers)
		if e != nil {
			b.Fatal(e)
		}
		c.FileLength = 1024
		c.RangeLength = 1024
		c.UserMDUs = 1
		c.PlanHash, _ = p.Hash()
		c.Population = 1
		c.SampleCount = 1
		s := SessionBindingV3{c.ChainID, c.SessionOwner, c.DealID, c.Generation, c.FileRecordIndex, 0, 1024, c.PlanHash, c.Nonce}
		c.SessionID, _ = s.ID()
	}
	seed, e := c.Seed(anchor)
	if e != nil {
		b.Fatal(e)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, e := c.Challenges(seed[:]); e != nil {
			b.Fatal(e)
		}
	}
}
