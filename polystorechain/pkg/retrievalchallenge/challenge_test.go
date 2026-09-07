package retrievalchallenge

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"reflect"
	"strconv"
	"testing"
)

func fixtureContext() Context {
	c := Context{Version: 2, ChainID: "polystore-test-1", Kind: Session, DealID: 9007199254740993, Generation: 7,
		Layout: Stripe, K: 8, M: 4, Slot: 3, MetadataMDUs: 2, UserMDUs: 133, StartMDU: 134, StartLeaf: 25, BlobCount: 3,
		Window: Window{Snapshot: 100, Anchor: 101, First: 102, Deadline: 150}, DealEnd: 200}
	for i := range c.SetupDigest {
		c.SetupDigest[i] = byte(i)
		c.ID[i] = byte(i + 32)
		c.Root[i] = byte(i + 64)
	}
	for i := range c.Assigned {
		c.Assigned[i] = byte(i + 96)
		c.Payee[i] = byte(i + 116)
	}
	return c
}
func fixtureSeed() []byte {
	b := make([]byte, 32)
	for i := range b {
		b[i] = byte(i + 136)
	}
	return b
}

func TestWindows(t *testing.T) {
	for _, tt := range []struct {
		open, expiry, end uint64
		ok                bool
	}{{1, 3, 4, true}, {1, 2, 4, false}, {0, 3, 4, false}, {1, 4, 4, true}, {math.MaxInt64 - 2, math.MaxInt64 - 1, math.MaxInt64, false}, {math.MaxUint64, 1, 2, false}, {math.MaxInt64 - 3, math.MaxInt64 - 1, math.MaxInt64, true}} {
		w, err := SessionWindow(tt.open, tt.expiry, tt.end)
		if (err == nil) != tt.ok {
			t.Fatalf("session %+v: %+v %v", tt, w, err)
		}
	}
	for _, tt := range []struct {
		epoch, length, end uint64
		issued, ok         bool
	}{{1, 1, 10, false, false}, {1, 2, 10, true, true}, {2, 2, 4, false, true}, {2, 2, 5, true, true}, {0, 2, 10, false, false}, {math.MaxUint64, 2, 10, false, false}, {1, math.MaxUint64, 10, false, false}} {
		w, issued, err := AuditWindow(tt.epoch, tt.length, tt.end)
		if (err == nil) != tt.ok || issued != tt.issued {
			t.Fatalf("audit %+v: %+v issued=%v err=%v", tt, w, issued, err)
		}
	}
	w, _ := SessionWindow(1, 3, 4)
	for _, h := range []uint64{0, 1, 2, 4, math.MaxUint64} {
		if w.Contains(h) {
			t.Fatal("accepted out of window", h)
		}
	}
	if !w.Contains(3) {
		t.Fatal("inclusive deadline rejected")
	}
}

func TestContextRejectsAmbiguityAndBounds(t *testing.T) {
	mutations := []func(*Context){
		func(c *Context) { c.Version = 1 }, func(c *Context) { c.Kind = 0 }, func(c *Context) { c.ChainID = "" }, func(c *Context) { c.ChainID = string(make([]byte, 51)) }, func(c *Context) { c.ChainID = "a\x00b" }, func(c *Context) { c.ChainID = "\xff" },
		func(c *Context) { c.Layout = 0 }, func(c *Context) { c.K = 3 }, func(c *Context) { c.M = math.MaxUint32 }, func(c *Context) { c.Slot = 12 }, func(c *Context) { c.MetadataMDUs = 0 }, func(c *Context) { c.MetadataMDUs = math.MaxUint64 }, func(c *Context) { c.UserMDUs = math.MaxUint64 },
		func(c *Context) { c.StartMDU = 1 }, func(c *Context) { c.StartMDU = 135 }, func(c *Context) { c.StartLeaf = 23 }, func(c *Context) { c.StartLeaf = 31; c.BlobCount = 2 }, func(c *Context) { c.BlobCount = 0 }, func(c *Context) { c.BlobCount = math.MaxUint64 },
		func(c *Context) { c.EpochID = 1 }, func(c *Context) { c.SampleCount = 1 }, func(c *Context) { c.Window.Anchor++ }, func(c *Context) { c.Window.First++ }, func(c *Context) { c.Window.Deadline = c.DealEnd + 1 },
	}
	for i, mutate := range mutations {
		c := fixtureContext()
		mutate(&c)
		if _, err := c.Bytes(); err == nil {
			t.Errorf("mutation %d accepted", i)
		}
	}
	c := fixtureContext()
	base, _ := c.Hash()
	mutations = []func(*Context){func(c *Context) { c.DealID++ }, func(c *Context) { c.Generation++ }, func(c *Context) { c.Root[0]++ }, func(c *Context) { c.ID[0]++ }, func(c *Context) { c.Payee[0]++ }, func(c *Context) { c.Assigned[0]++ }, func(c *Context) { c.SetupDigest[0]++ }, func(c *Context) { c.ChainID += "x" }, func(c *Context) { c.StartLeaf++ }, func(c *Context) { c.BlobCount-- }, func(c *Context) { c.Window.Deadline-- }}
	for i, mutate := range mutations {
		c := fixtureContext()
		mutate(&c)
		h, err := c.Hash()
		if err != nil || h == base {
			t.Errorf("unbound field %d: %v", i, err)
		}
	}
}

func TestAuditAndReplicaCanonicalBounds(t *testing.T) {
	c := fixtureContext()
	c.Kind = Audit
	c.ID = [32]byte{}
	c.Payee = c.Assigned
	c.StartMDU = 0
	c.StartLeaf = 0
	c.BlobCount = 0
	c.EpochID = 2
	c.EpochLength = 100
	c.SampleCount = 8
	c.Window.Deadline = 199
	mutations := []func(*Context){func(c *Context) { c.ID[0] = 1 }, func(c *Context) { c.Payee[0]++ }, func(c *Context) { c.StartLeaf = 1 }, func(c *Context) { c.StartMDU = 1 }, func(c *Context) { c.BlobCount = 1 }, func(c *Context) { c.EpochLength = 1 }, func(c *Context) { c.EpochID = 0 }, func(c *Context) { c.SampleCount = 0 }, func(c *Context) { c.SampleCount = 1065 }, func(c *Context) { c.UserMDUs = 1000; c.SampleCount = MaxSamples + 1 }, func(c *Context) { c.Window.Deadline++ }, func(c *Context) { c.UserMDUs = 0 }}
	for i, mutate := range mutations {
		bad := c
		mutate(&bad)
		if _, err := bad.Bytes(); err == nil {
			t.Fatalf("audit mutation %d accepted", i)
		}
	}
	c = fixtureContext()
	c.Layout = Replica
	c.K = 1
	c.M = 0
	c.Slot = 0
	c.StartLeaf = 0
	c.BlobCount = 64
	if _, err := c.Challenges(fixtureSeed()); err != nil {
		t.Fatal(err)
	}
	c.StartLeaf = 1
	if _, err := c.Bytes(); err == nil {
		t.Fatal("replica session crossed MDU")
	}
	c.StartLeaf = 0
	c.Slot = 1
	if _, err := c.Bytes(); err == nil {
		t.Fatal("replica nonzero slot accepted")
	}
	c.Slot = 0
	c.UserMDUs = 65535
	c.StartMDU = 65536
	if _, err := c.Bytes(); err != nil {
		t.Fatal("last addressable MDU rejected", err)
	}
	c.UserMDUs++
	if _, err := c.Bytes(); err == nil {
		t.Fatal("root-table overflow accepted")
	}
	for _, w := range []Window{{0, 1, 2, math.MaxUint64}, {1, 2, 2, 3}, {1, 3, 4, 5}, {math.MaxUint64, 0, 1, 2}} {
		if w.Contains(w.First) {
			t.Fatal("malformed window accepted")
		}
	}
}

func TestSamplingAndPointBounds(t *testing.T) {
	seed := fixtureSeed()
	hash := sha256.Sum256([]byte("context"))
	for _, u := range []uint64{0, 1, 2, 8, 132, 1375, 4096, math.MaxUint64} {
		q := min(u, MaxSamples)
		p, err := Sample(hash, seed, u, q)
		if err != nil {
			t.Fatal(err)
		}
		if uint64(len(p)) != q {
			t.Fatal("count")
		}
		seen := map[uint64]bool{}
		for _, v := range p {
			if v >= u || seen[v] {
				t.Fatalf("invalid sample %d of %d", v, u)
			}
			seen[v] = true
		}
		again, _ := Sample(hash, seed, u, q)
		if !reflect.DeepEqual(p, again) {
			t.Fatal("nondeterministic")
		}
	}
	for _, tt := range []struct{ u, q uint64 }{{0, 1}, {1, 2}, {math.MaxUint64, MaxSamples + 1}} {
		if _, err := Sample(hash, seed, tt.u, tt.q); err == nil {
			t.Fatal("unbounded sample accepted")
		}
	}
	for _, n := range []int{0, 31, 33, 48, 64} {
		if _, err := Sample(hash, make([]byte, n), 8, 1); err == nil {
			t.Fatal("bad seed accepted", n)
		}
	}
	c := fixtureContext()
	got, err := c.Challenges(seed)
	if err != nil {
		t.Fatal(err)
	}
	for i, v := range got {
		if v.Ordinal != uint64(i) || v.MDUIndex != 134 || v.LeafIndex != uint32(25+i) {
			t.Fatalf("bad session tuple %+v", v)
		}
		if !validPoint(v.Z) {
			t.Fatal("invalid field point")
		}
	}
	mutated := append([]byte(nil), seed...)
	mutated[0]++
	different, _ := c.Challenges(mutated)
	if reflect.DeepEqual(got, different) {
		t.Fatal("seed unbound")
	}
}

func TestRejectionExhaustionAndDomain(t *testing.T) {
	var zero, one, maximum [32]byte
	one[31] = 1
	for i := range maximum {
		maximum[i] = 255
	}
	for _, v := range [][32]byte{zero, one, maximum, fieldModulusBytes} {
		if validPoint(v) {
			t.Fatal("invalid point accepted")
		}
	}
	minusOne := fieldModulusBytes
	minusOne[31]--
	if validPoint(minusOne) {
		t.Fatal("nontrivial 4096th root of unity accepted")
	}
	valid := [32]byte{}
	valid[31] = 2
	callsToAccept := 0
	z, err := hashToPoint(make([]byte, 4), func(b []byte) [32]byte {
		callsToAccept++
		if callsToAccept == 256 {
			return valid
		}
		return maximum
	})
	if err != nil || z != valid || callsToAccept != 256 {
		t.Fatal("last permitted point attempt failed")
	}

	calls := 0
	_, err = hashToPoint(make([]byte, 4), func([]byte) [32]byte { calls++; return maximum })
	if err == nil || calls != 256 {
		t.Fatalf("exhaustion calls=%d err=%v", calls, err)
	}
	calls = 0
	_, err = draw(3, func(uint32) [32]byte { calls++; return maximum })
	if err == nil || calls != 256 {
		t.Fatalf("draw exhaustion calls=%d err=%v", calls, err)
	}
	if v, err := draw(1, func(uint32) [32]byte { t.Fatal("n=1 hashed"); return zero }); err != nil || v != 0 {
		t.Fatal(v, err)
	}
	maximum[31]--
	if v, err := draw(3, func(uint32) [32]byte { return maximum }); err != nil || v != 2 {
		t.Fatal(v, err)
	}
}

func TestIndependentGolden(t *testing.T) {
	var golden struct {
		Vectors map[string]struct {
			Bytes     string `json:"context_hex"`
			Hash      string `json:"context_hash"`
			Positions []struct {
				Ordinal         uint64 `json:"ordinal"`
				PopulationIndex uint64 `json:"population_index"`
				MDU             uint64 `json:"mdu_index"`
				Leaf            uint32 `json:"leaf_index"`
				Z               string `json:"z"`
			} `json:"samples"`
		} `json:"vectors"`
	}
	data, err := os.ReadFile("testdata/challenge-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &golden); err != nil {
		t.Fatal(err)
	}
	if len(golden.Vectors) != 2 {
		t.Fatal("expected session and audit fixtures")
	}
	for name, f := range golden.Vectors {
		c := fixtureContext()
		if name == "audit" {
			c.Kind = Audit
			c.ID = [32]byte{}
			c.Payee = c.Assigned
			c.StartMDU = 0
			c.StartLeaf = 0
			c.BlobCount = 0
			c.EpochID = 2
			c.EpochLength = 100
			c.SampleCount = 8
			c.Window.Deadline = 199
		} else if name != "session" {
			t.Fatal("unknown vector")
		}
		b, err := c.Bytes()
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(b) != f.Bytes {
			t.Fatal(name, "canonical bytes drift")
		}
		h, _ := c.Hash()
		if hex.EncodeToString(h[:]) != f.Hash {
			t.Fatal(name, "hash drift")
		}
		got, err := c.Challenges(fixtureSeed())
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(f.Positions) {
			t.Fatal("count drift")
		}
		for i, w := range f.Positions {
			v := got[i]
			if v.Ordinal != w.Ordinal || v.PopulationIndex != w.PopulationIndex || v.MDUIndex != w.MDU || v.LeafIndex != w.Leaf || hex.EncodeToString(v.Z[:]) != w.Z {
				t.Fatalf("%s challenge %d drift: %+v expected %+v", name, i, v, w)
			}
		}
	}
}

func BenchmarkContext(b *testing.B) {
	c := fixtureContext()
	b.ReportAllocs()
	for b.Loop() {
		if _, err := c.Hash(); err != nil {
			b.Fatal(err)
		}
	}
}
func BenchmarkSessionChallenges(b *testing.B) {
	c := fixtureContext()
	seed := fixtureSeed()
	b.ReportAllocs()
	for b.Loop() {
		if _, err := c.Challenges(seed); err != nil {
			b.Fatal(err)
		}
	}
}
func BenchmarkAuditSamples(b *testing.B) {
	seed := fixtureSeed()
	hash := sha256.Sum256(seed)
	for _, q := range []uint64{132, 1375} {
		b.Run(strconv.FormatUint(q, 10), func(b *testing.B) {
			b.ReportAllocs()
			for b.Loop() {
				if _, err := Sample(hash, seed, 1000000, q); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
