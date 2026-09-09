package main

import (
	"bytes"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func writePackedFATHeaderV3(t *testing.T, wire []byte, header retrievalchallenge.FATV3Header) {
	t.Helper()
	raw, err := header.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	start := 16 * types.BLOB_SIZE
	for i, value := range raw {
		wire[start+(i/31)*32] = 0
		wire[start+(i/31)*32+1+i%31] = value
	}
}

func TestValidateFATV3MetadataUsesPackedAuthenticatedBytes(t *testing.T) {
	initCryptoForTest(t)
	builder := crypto_ffi.NewMdu0Builder(1)
	if builder == nil {
		t.Fatal("builder unavailable")
	}
	defer builder.Free()
	wire, err := builder.Bytes()
	if err != nil {
		t.Fatal(err)
	}
	integrity := [32]byte{1, 2, 3}
	writePackedFATHeaderV3(t, wire, retrievalchallenge.FATV3Header{LeafCount: 96, IntegrityRoot: integrity})
	key := retrievalGenerationKey{Users: 1, Integrity: integrity}
	if err := validateFATV3Metadata(wire, key, true); err != nil {
		t.Fatal(err)
	}
	if err := validateFATV3Metadata(wire, key, false); err != nil {
		t.Fatalf("legacy audit rejected authenticated FAT v3 generation: %v", err)
	}
	badRoot := key
	badRoot.Integrity[0] ^= 1
	if err := validateFATV3Metadata(wire, badRoot, true); err == nil {
		t.Fatal("accepted mismatched integrity root")
	}
	malformed := bytes.Clone(wire)
	malformed[16*types.BLOB_SIZE] = 1
	if err := validateFATV3Metadata(malformed, key, true); err == nil {
		t.Fatal("accepted nonzero FAT scalar prefix")
	}
	malformed = bytes.Clone(wire)
	malformed[16*types.BLOB_SIZE+5*32+1] = 1
	if err := validateFATV3Metadata(malformed, key, true); err == nil {
		t.Fatal("accepted nonzero FAT header reserved byte")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "mdu_0.bin"), malformed, 0o600); err != nil {
		t.Fatal(err)
	}
	key.Version = 3
	if _, err := prepareRetrievalMetadata(t.Context(), dir, key); err == nil || !strings.Contains(err.Error(), "frozen manifest root") {
		t.Fatalf("parsed unauthenticated v3 header before rejecting root: %v", err)
	}
}

func TestGenerationAcceptanceOperationIdentityBindsTranscript(t *testing.T) {
	g := retrievalGenerationKey{Chain: "polystore-test-1", Deal: 0, Generation: 1, Metadata: 2, Users: 1}
	g.Setup[0], g.Root[0], g.Integrity[0] = 1, 2, 3
	provider := [20]byte{19: 4}
	want, err := generationAcceptanceDigestV3(g, 0, provider)
	if err != nil {
		t.Fatal(err)
	}
	mutations := []func(){
		func() { g.Chain = "polystore-test-2" },
		func() { g.Setup[0] ^= 1 },
		func() { g.Root[0] ^= 1 },
		func() { provider[0] ^= 1 },
	}
	for i, mutate := range mutations {
		originalG, originalProvider := g, provider
		mutate()
		got, err := generationAcceptanceDigestV3(g, 0, provider)
		if err != nil || got == want {
			t.Fatalf("mutation %d did not change durable acceptance identity: %x %v", i, got, err)
		}
		g, provider = originalG, originalProvider
	}
}

func TestValidateGenerationAdmissionV3BoundsAndProviderIdentity(t *testing.T) {
	oldChain := chainID
	chainID = "polystore-test-1"
	t.Cleanup(func() { chainID = oldChain })
	setup, err := hex.DecodeString(types.RetrievalSetupDigest)
	if err != nil {
		t.Fatal(err)
	}
	a := &types.DealGenerationAdmissionV3{
		DealId: 0, Generation: 1, PolyfsRoot: make([]byte, 32), IntegrityRoot: make([]byte, 32),
		SetupDigest: setup, WitnessMdus: 1, MetadataMdus: 2, UserMdus: 1, TotalMdus: 3,
		IntegrityLeafCount: 96, ProposedHeight: 1, ChainId: chainID,
	}
	for i := 0; i < 12; i++ {
		raw := make([]byte, 20)
		raw[19] = byte(i + 1)
		a.Providers = append(a.Providers, sdk.AccAddress(raw).String())
	}
	if _, _, err := validateGenerationAdmissionV3(a, 0); err != nil {
		t.Fatalf("first deal rejected: %v", err)
	}
	if _, _, err := validateGenerationAdmissionV3(a, 1); err == nil {
		t.Fatal("accepted generation for a different requested deal")
	}
	a.Providers[11] = a.Providers[10]
	if _, _, err := validateGenerationAdmissionV3(a, 0); err == nil {
		t.Fatal("accepted duplicate provider assignment")
	}
	a.Providers[11] = sdk.AccAddress(append(make([]byte, 19), 12)).String()
	a.SetupDigest[0] ^= 1
	if _, _, err := validateGenerationAdmissionV3(a, 0); err == nil {
		t.Fatal("accepted mismatched setup digest")
	}
}
