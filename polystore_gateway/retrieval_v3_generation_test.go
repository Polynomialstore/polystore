package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/gogoproto/jsonpb"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func TestGenerationVerificationV3UsesBoundedWorkScaledDeadline(t *testing.T) {
	maxUsers := retrievalchallenge.MaxIntegrityLeaves / retrievalchallenge.IntegrityLeavesPerUserMDU
	for _, tc := range []struct {
		users uint64
		want  time.Duration
	}{
		{1, generationVerificationBaseTimeoutV3 + generationVerificationPerUserMDUV3},
		{maxUsers, generationVerificationBaseTimeoutV3 + time.Duration(maxUsers)*generationVerificationPerUserMDUV3},
	} {
		got, err := generationVerificationTimeoutV3(tc.users)
		if err != nil || got != tc.want {
			t.Fatalf("timeout(%d)=%s,%v want %s", tc.users, got, err, tc.want)
		}
	}
	for _, users := range []uint64{0, maxUsers + 1} {
		if _, err := generationVerificationTimeoutV3(users); err == nil {
			t.Fatalf("accepted invalid user MDU count %d", users)
		}
	}
}

func TestGenerationVerificationV3BoundsScansWithoutHoldingSigner(t *testing.T) {
	signer := sdk.AccAddress(bytes.Repeat([]byte{7}, 20)).String()
	release, err := claimGenerationVerificationV3(701, signer)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	if other, err := claimGenerationVerificationV3(702, signer); err == nil {
		other()
		t.Fatal("same provider started a second generation scan")
	}
	otherSigner := sdk.AccAddress(bytes.Repeat([]byte{8}, 20)).String()
	if other, err := claimGenerationVerificationV3(701, otherSigner); err == nil {
		other()
		t.Fatal("same generation started a second scan")
	}
	sign, err := claimRetrievalOperations(nil, signer)
	if err != nil {
		t.Fatalf("generation scan held shared signer lock: %v", err)
	}
	sign()
}

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

func providerGenerationCandidateV3(t *testing.T, key retrievalGenerationKey, signer string) *types.DealGenerationAdmissionV3 {
	t.Helper()
	providers := make([]string, 12)
	providers[0] = signer
	for i := 1; i < 12; i++ {
		raw := make([]byte, 20)
		raw[19] = byte(i + 1)
		providers[i] = sdk.AccAddress(raw).String()
	}
	return &types.DealGenerationAdmissionV3{
		DealId: key.Deal, Generation: key.Generation, PolyfsRoot: bytes.Clone(key.Root[:]), IntegrityRoot: bytes.Clone(key.Integrity[:]),
		SetupDigest: bytes.Clone(key.Setup[:]), WitnessMdus: key.Metadata - 1, MetadataMdus: key.Metadata, UserMdus: key.Users,
		TotalMdus: key.Metadata + key.Users, IntegrityLeafCount: key.Users * retrievalchallenge.IntegrityLeavesPerUserMDU,
		Providers: providers, ProposedHeight: 10, ChainId: key.Chain,
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

func TestGenerationAcceptanceV3ReconcilesPersistedHashBeforeReplacementQuery(t *testing.T) {
	path := submissionTestDB(t)
	signer := sdk.AccAddress(bytes.Repeat([]byte{9}, 20)).String()
	hash := strings.Repeat("A", 64)
	op := pendingSignerOperation{Kind: "generation-v3", IDs: []string{strings.Repeat("b", 64)}, TxHash: hash}
	if err := updatePendingSignerV3(signer, op, false); err != nil {
		t.Fatal(err)
	}
	if err := closeSessionDB(); err != nil {
		t.Fatal(err)
	}
	if err := initSessionDB(path); err != nil {
		t.Fatal(err)
	}
	queriedCandidate := false
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/cosmos/tx/v1beta1/txs/") {
			fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"12","code":0}}`, hash)
			return
		}
		queriedCandidate = true
		http.Error(w, "replacement proposal must not affect old reconciliation", http.StatusInternalServerError)
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	defer func() { lcdBase = oldLCD }()
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "keys" {
			return []byte(signer), nil
		}
		return nil, fmt.Errorf("unexpected command")
	})
	req := httptest.NewRequest(http.MethodPost, "/sp/generation-v3/accept", strings.NewReader(`{"deal_id":99,"provider":`+fmt.Sprintf("%q", signer)+`}`))
	req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())
	w := httptest.NewRecorder()
	SpAcceptDealGenerationV3(w, req)
	if w.Code != http.StatusOK || queriedCandidate || !strings.Contains(w.Body.String(), `"status":"reconciled"`) {
		t.Fatalf("persisted acceptance was not reconciled independently: code=%d query=%t body=%s", w.Code, queriedCandidate, w.Body.String())
	}
	if marker, err := loadPendingSigner(signer); err != nil || marker != nil {
		t.Fatalf("committed acceptance retained signer quarantine: %+v %v", marker, err)
	}
}

func TestGenerationAcceptanceV3ClearsMatchingAcceptedNoHashMarker(t *testing.T) {
	submissionTestDB(t)
	oldChain := chainID
	chainID = "polystore-test-1"
	t.Cleanup(func() { chainID = oldChain })
	signerRaw := bytes.Repeat([]byte{9}, 20)
	signer := sdk.AccAddress(signerRaw).String()
	setup, err := hex.DecodeString(types.RetrievalSetupDigest)
	if err != nil {
		t.Fatal(err)
	}
	providers := make([]string, 12)
	providers[0] = signer
	for i := 1; i < 12; i++ {
		raw := make([]byte, 20)
		raw[19] = byte(i + 1)
		providers[i] = sdk.AccAddress(raw).String()
	}
	candidate := &types.DealGenerationAdmissionV3{
		DealId: 77, Generation: 3, PolyfsRoot: bytes.Repeat([]byte{1}, 32), IntegrityRoot: bytes.Repeat([]byte{2}, 32),
		SetupDigest: setup, WitnessMdus: 1, MetadataMdus: 2, UserMdus: 1, TotalMdus: 3,
		IntegrityLeafCount: 96, Providers: providers, ProposedHeight: 10, ChainId: chainID, AcceptedSlotsMask: 1,
	}
	body, err := (&jsonpb.Marshaler{OrigName: true}).MarshalToString(&types.QueryGetDealGenerationV3Response{Pending: candidate})
	if err != nil {
		t.Fatal(err)
	}
	generation, _, err := validateGenerationAdmissionV3(candidate, candidate.DealId)
	if err != nil {
		t.Fatal(err)
	}
	var provider [20]byte
	copy(provider[:], signerRaw)
	digest, err := generationAcceptanceDigestV3(generation, 0, provider)
	if err != nil {
		t.Fatal(err)
	}
	op := pendingSignerOperation{Kind: "generation-v3", IDs: []string{hex.EncodeToString(digest[:])}}
	if err := updatePendingSignerV3(signer, op, false); err != nil {
		t.Fatal(err)
	}
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "/deals/77/generation-v3") {
			t.Fatalf("unexpected LCD request %s", r.URL.Path)
		}
		w.Header().Set(committedHeightHeader, "12")
		_, _ = w.Write([]byte(body))
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	t.Cleanup(func() { lcdBase = oldLCD })
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "keys" {
			return []byte(signer), nil
		}
		return nil, fmt.Errorf("unexpected command")
	})
	req := httptest.NewRequest(http.MethodPost, "/sp/generation-v3/accept", strings.NewReader(`{"deal_id":77,"provider":`+fmt.Sprintf("%q", signer)+`}`))
	req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())
	w := httptest.NewRecorder()
	SpAcceptDealGenerationV3(w, req)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"status":"already_accepted"`) {
		t.Fatalf("matching accepted marker did not reconcile: code=%d body=%s", w.Code, w.Body.String())
	}
	if marker, err := loadPendingSigner(signer); err != nil || marker != nil {
		t.Fatalf("matching accepted marker remained: %+v %v", marker, err)
	}
	mismatch := pendingSignerOperation{Kind: "generation-v3", IDs: []string{strings.Repeat("f", 64)}}
	if err := updatePendingSignerV3(signer, mismatch, false); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodPost, "/sp/generation-v3/accept", strings.NewReader(`{"deal_id":77,"provider":`+fmt.Sprintf("%q", signer)+`}`))
	req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())
	w = httptest.NewRecorder()
	SpAcceptDealGenerationV3(w, req)
	if w.Code != http.StatusConflict {
		t.Fatalf("mismatched accepted marker was not quarantined: code=%d body=%s", w.Code, w.Body.String())
	}
	if marker, err := loadPendingSigner(signer); err != nil || marker == nil || !reflect.DeepEqual(marker.IDs, mismatch.IDs) {
		t.Fatalf("mismatched accepted marker changed: %+v %v", marker, err)
	}
}

func TestGenerationAcceptanceV3RevalidatesAfterScanBeforeSigning(t *testing.T) {
	for _, tc := range []struct {
		name         string
		injectMarker bool
	}{
		{name: "candidate_changed"},
		{name: "pending_signer_appeared", injectMarker: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			submissionTestDB(t)
			frozen, key, _ := buildProviderV3ArtifactFixture(t)
			signer := frozen.Session.Obligations[0].AssignedProvider
			t.Setenv("POLYSTORE_PROVIDER_KEY", "faucet")
			t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
			candidate := providerGenerationCandidateV3(t, key, signer)
			changed := *candidate
			changed.Generation++
			firstBody, err := (&jsonpb.Marshaler{OrigName: true}).MarshalToString(&types.QueryGetDealGenerationV3Response{Pending: candidate})
			if err != nil {
				t.Fatal(err)
			}
			changedBody, err := (&jsonpb.Marshaler{OrigName: true}).MarshalToString(&types.QueryGetDealGenerationV3Response{Pending: &changed})
			if err != nil {
				t.Fatal(err)
			}
			injected := pendingSignerOperation{Kind: "audit", IDs: []string{"epoch:77"}}
			queries := 0
			lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, "/generation-v3") {
					t.Fatalf("unexpected LCD request %s", r.URL.Path)
				}
				queries++
				w.Header().Set(committedHeightHeader, "13")
				if queries == 1 {
					_, _ = w.Write([]byte(firstBody))
					if tc.injectMarker {
						if err := updatePendingSignerV3(signer, injected, false); err != nil {
							t.Errorf("inject pending signer marker: %v", err)
						}
					}
					return
				}
				_, _ = w.Write([]byte(changedBody))
			}))
			defer lcd.Close()
			oldLCD := lcdBase
			lcdBase = lcd.URL
			t.Cleanup(func() { lcdBase = oldLCD })
			txCalls := 0
			setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if len(args) > 0 && args[0] == "keys" {
					return []byte(signer), nil
				}
				txCalls++
				return nil, fmt.Errorf("unexpected transaction")
			})
			req := httptest.NewRequest(http.MethodPost, "/sp/generation-v3/accept", strings.NewReader(`{"deal_id":0,"provider":`+fmt.Sprintf("%q", signer)+`}`))
			req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())
			w := httptest.NewRecorder()
			SpAcceptDealGenerationV3(w, req)
			if w.Code != http.StatusConflict || txCalls != 0 {
				t.Fatalf("changed state reached signing: code=%d tx=%d body=%s", w.Code, txCalls, w.Body.String())
			}
			marker, err := loadPendingSigner(signer)
			if tc.injectMarker {
				if queries != 1 || !strings.Contains(w.Body.String(), "provider signer has unresolved operation") {
					t.Fatalf("concurrent marker did not stop before fresh query: queries=%d body=%s", queries, w.Body.String())
				}
				if err != nil || marker == nil || marker.Kind != injected.Kind || !reflect.DeepEqual(marker.IDs, injected.IDs) {
					t.Fatalf("concurrent marker changed: %+v %v", marker, err)
				}
			} else {
				if queries != 2 || !strings.Contains(w.Body.String(), "candidate changed during verification") {
					t.Fatalf("candidate change did not reach fresh revalidation: queries=%d body=%s", queries, w.Body.String())
				}
				if err != nil || marker != nil {
					t.Fatalf("candidate change created marker: %+v %v", marker, err)
				}
			}
		})
	}
}

func TestGenerationAcceptanceV3OutcomeStatusCodes(t *testing.T) {
	for _, tc := range []struct {
		status string
		code   int
	}{
		{status: "success", code: http.StatusOK},
		{status: "pending", code: http.StatusAccepted},
		{status: "failed", code: http.StatusConflict},
	} {
		t.Run(tc.status, func(t *testing.T) {
			w := httptest.NewRecorder()
			writeGenerationAcceptanceV3Outcome(w, tc.status, strings.Repeat("A", 64), 0, "complete", nil)
			if w.Code != tc.code || !strings.Contains(w.Body.String(), `"status":"`+tc.status+`"`) {
				t.Fatalf("unexpected outcome code=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestProviderV3FreshHandlersSubmitTrackedNativeTransactions(t *testing.T) {
	submissionTestDB(t)
	frozen, key, _ := buildProviderV3ArtifactFixture(t)
	signer := frozen.Session.Obligations[0].AssignedProvider
	t.Setenv("POLYSTORE_PROVIDER_KEY", "faucet")
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")

	providers := make([]string, 12)
	for i := range providers {
		raw := make([]byte, 20)
		raw[19] = byte(i + 1)
		providers[i] = sdk.AccAddress(raw).String()
	}
	candidate := &types.DealGenerationAdmissionV3{
		DealId: key.Deal, Generation: key.Generation, PolyfsRoot: bytes.Clone(key.Root[:]), IntegrityRoot: bytes.Clone(key.Integrity[:]),
		SetupDigest: bytes.Clone(key.Setup[:]), WitnessMdus: key.Metadata - 1, MetadataMdus: key.Metadata, UserMdus: key.Users,
		TotalMdus: key.Metadata + key.Users, IntegrityLeafCount: key.Users * retrievalchallenge.IntegrityLeavesPerUserMDU,
		Providers: providers, ProposedHeight: 10, ChainId: key.Chain,
	}
	generationBody, err := (&jsonpb.Marshaler{OrigName: true}).MarshalToString(&types.QueryGetDealGenerationV3Response{Pending: candidate})
	if err != nil {
		t.Fatal(err)
	}
	anchor := make([]byte, 32)
	anchor[0] = 42
	sessionBody, err := (&jsonpb.Marshaler{OrigName: true}).MarshalToString(&types.QueryGetRetrievalSessionV3Response{Session: frozen.Session, AnchorSeed: anchor})
	if err != nil {
		t.Fatal(err)
	}

	const generationHash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	const proofHash = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/deals/0/generation-v3"):
			w.Header().Set(committedHeightHeader, "13")
			_, _ = w.Write([]byte(generationBody))
		case strings.Contains(r.URL.Path, "/retrieval-sessions-v3/"):
			w.Header().Set(committedHeightHeader, strconv.FormatUint(frozen.Height, 10))
			_, _ = w.Write([]byte(sessionBody))
		case strings.Contains(r.URL.Path, "/retrieval-sessions/"):
			http.NotFound(w, r)
		case strings.Contains(r.URL.Path, "/cosmos/tx/v1beta1/txs/"):
			hash := generationHash
			if strings.HasSuffix(r.URL.Path, proofHash) {
				hash = proofHash
			}
			fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":0}}`, hash)
		default:
			t.Fatalf("unexpected LCD request %s", r.URL.Path)
		}
	}))
	defer lcd.Close()
	oldLCD := lcdBase
	lcdBase = lcd.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	providerRaw, err := rawProviderV3(signer)
	if err != nil {
		t.Fatal(err)
	}
	digest, err := generationAcceptanceDigestV3(key, 0, providerRaw)
	if err != nil {
		t.Fatal(err)
	}
	wantGeneration := []string{"tx", "polystorechain", "accept-deal-generation-v3", "--deal-id", "0", "--slot", "0", "--acceptance-digest", hex.EncodeToString(digest[:]), "--from", "faucet", "--chain-id", chainID, "--home", homeDir, "--keyring-backend", "test", "--yes", "--gas", "auto", "--gas-adjustment", "1.6", "--gas-prices", gasPrices, "--broadcast-mode", "sync", "--output", "json"}
	_, proofs, _, err := buildProviderProofBatchV3(t.Context(), frozen, signer)
	if err != nil {
		t.Fatal(err)
	}
	wantProof := &types.MsgSubmitRetrievalSessionProofV3{Creator: signer, SessionId: bytes.Clone(frozen.Session.SessionId), Slot: 0, Proofs: proofs}
	wantProofJSON, err := (&jsonpb.Marshaler{OrigName: true}).MarshalToString(wantProof)
	if err != nil {
		t.Fatal(err)
	}
	txCalls := 0
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "keys" {
			return []byte(signer), nil
		}
		txCalls++
		if len(args) < 4 || args[len(args)-4] != "--submission-phase-file" || args[len(args)-2] != "--node" || args[len(args)-1] != nodeAddr {
			t.Fatalf("submission phase flag missing from %q", args)
		}
		phase, err := os.ReadFile(args[len(args)-3])
		if err != nil || len(phase) != 0 {
			t.Fatalf("invalid fresh submission phase file: %q %v", phase, err)
		}
		switch txCalls {
		case 1:
			if !reflect.DeepEqual(args[:len(args)-4], wantGeneration) {
				t.Fatalf("generation CLI args mismatch\n got: %q\nwant: %q", args[:len(args)-4], wantGeneration)
			}
			return []byte(`{"txhash":"` + generationHash + `","code":0}`), nil
		case 2:
			got := args[:len(args)-4]
			if len(got) < 5 || !reflect.DeepEqual(got[:4], []string{"tx", "polystorechain", "retrieval-session-v3", "prove"}) || !reflect.DeepEqual(got[5:], []string{"--from", "faucet", "--chain-id", chainID, "--home", homeDir, "--keyring-backend", "test", "--yes", "--gas", "auto", "--gas-adjustment", "1.6", "--gas-prices", gasPrices, "--broadcast-mode", "sync", "--output", "json"}) {
				t.Fatalf("proof CLI args mismatch: %q", got)
			}
			proofJSON, err := os.ReadFile(got[4])
			if err != nil || strings.TrimSpace(string(proofJSON)) != strings.TrimSpace(wantProofJSON) {
				t.Fatalf("proof input mismatch\n got: %s\nwant: %s\nerr: %v", proofJSON, wantProofJSON, err)
			}
			return []byte(`{"txhash":"` + proofHash + `","code":0}`), nil
		default:
			t.Fatalf("unexpected tx call %d: %q", txCalls, args)
			return nil, nil
		}
	})

	req := httptest.NewRequest(http.MethodPost, "/sp/generation-v3/accept", strings.NewReader(`{"deal_id":0,"provider":`+fmt.Sprintf("%q", signer)+`}`))
	req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())
	generationResult := httptest.NewRecorder()
	SpAcceptDealGenerationV3(generationResult, req)
	if generationResult.Code != http.StatusOK || !strings.Contains(generationResult.Body.String(), `"status":"success"`) {
		t.Fatalf("fresh generation acceptance failed: code=%d body=%s", generationResult.Code, generationResult.Body.String())
	}
	if marker, err := loadPendingSigner(signer); err != nil || marker != nil {
		t.Fatalf("generation acceptance retained marker: %+v %v", marker, err)
	}

	proofResult := invokeSubmission(`{"session_id":"0x` + hex.EncodeToString(frozen.Session.SessionId) + `"}`)
	if proofResult.Code != http.StatusOK || !strings.Contains(proofResult.Body.String(), `"status":"success"`) {
		t.Fatalf("fresh proof submission failed: code=%d body=%s", proofResult.Code, proofResult.Body.String())
	}
	if marker, err := loadPendingSigner(signer); err != nil || marker != nil {
		t.Fatalf("proof submission retained marker: %+v %v", marker, err)
	}
	if txCalls != 2 {
		t.Fatalf("submitted %d transactions, want 2", txCalls)
	}
}
