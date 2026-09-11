package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cosmos/gogoproto/jsonpb"
	bolt "go.etcd.io/bbolt"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func systemAuditFixture(t *testing.T, kind uint8) (types.StorageAuditView, retrievalchallenge.Context, string) {
	t.Helper()
	s := testFrozenSession(t).Session
	s.ChallengeSnapshot.Slot = 0
	a := types.FrozenStorageAudit{EpochId: 2, Assignment: &types.FrozenStorageAssignment{DealId: s.DealId, Provider: s.Provider, ManifestRoot: s.ManifestRoot, Snapshot: s.ChallengeSnapshot, Kind: uint32(kind)}, SampleCount: 8, Coverage: []byte{0}}
	c, err := types.StorageAuditContext(a, 10)
	if err != nil {
		t.Fatal(err)
	}
	canonical, _ := c.Bytes()
	return types.StorageAuditView{Audit: &a, EpochLength: 10, CanonicalContext: canonical, Seed: bytes.Repeat([]byte{6}, 32)}, c, s.Provider
}

func TestFrozenSystemAuditCommittedQueries(t *testing.T) {
	view, c, signer := systemAuditFixture(t, retrievalchallenge.Audit)
	response := types.QueryListStorageAuditsByProviderResponse{Audits: []types.StorageAuditView{view}}
	height, body := "12", ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(committedHeightHeader) != "12" {
			t.Error("query did not pin committed activation height")
		}
		if height != "" {
			w.Header().Set(committedHeightHeader, height)
		}
		if body != "" {
			fmt.Fprint(w, body)
			return
		}
		if err := (&jsonpb.Marshaler{OrigName: true, EmitDefaults: true}).Marshal(w, &response); err != nil {
			t.Error(err)
		}
	}))
	defer srv.Close()
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })
	got, h, err := queryFrozenSystemAudits(context.Background(), signer, 12)
	if err != nil || h != 12 || len(got) != 1 || got[0].context != c {
		t.Fatal(got, h, err)
	}
	for _, tc := range []struct {
		name   string
		mutate func()
	}{
		{"height_mismatch", func() { height = "13" }}, {"height_missing", func() { height = "" }},
		{"missing_list", func() { body = `{}` }}, {"null_list", func() { body = `{"audits":null}` }},
		{"unknown_field", func() { body = `{"audits":[],"ignored":1}` }},
		{"wrong_seed_size", func() { response.Audits[0].Seed = []byte{1} }},
		{"missing_eligible_seed", func() { response.Audits[0].Seed = nil }},
		{"canonical_context", func() { response.Audits[0].CanonicalContext = []byte{1} }},
		{"coverage_count", func() { response.Audits[0].Audit.AcceptedCount = 1 }},
		{"duplicate", func() { response.Audits = append(response.Audits, response.Audits[0]) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fresh, _, _ := systemAuditFixture(t, retrievalchallenge.Audit)
			response.Audits = []types.StorageAuditView{fresh}
			height = "12"
			body = ""
			tc.mutate()
			if _, _, err := queryFrozenSystemAudits(context.Background(), signer, 12); err == nil {
				t.Fatal("accepted malformed frozen inventory")
			}
		})
	}
	height = "12"
	body = `{"audits":[]}`
	if got, _, err := queryFrozenSystemAudits(context.Background(), signer, 12); err != nil || len(got) != 0 {
		t.Fatal(got, err)
	}
}

func TestSystemAuditActivationNeverFallsBackFromMalformedV2(t *testing.T) {
	height, body := "12", `{"params":{"retrieval_v2_activation_height":"11"}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/polystorechain/polystorechain/v1/params" {
			t.Fatal("unexpected legacy query")
		}
		if height != "" {
			w.Header().Set(committedHeightHeader, height)
		}
		fmt.Fprint(w, body)
	}))
	defer srv.Close()
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })
	active, h, err := systemAuditActivation(context.Background())
	if err != nil || !active || h != 12 {
		t.Fatal(active, h, err)
	}
	for _, bad := range []string{`{}`, `{"params":{}}`, `{"params":{"retrieval_v2_activation_height":null}}`, `{"params":{"retrieval_v2_activation_height":"011"}}`} {
		body = bad
		if _, _, err := systemAuditActivation(context.Background()); err == nil {
			t.Fatal("accepted", bad)
		}
	}
	body = `{"params":{"retrieval_v2_activation_height":"0"}}`
	if active, _, err := systemAuditActivation(context.Background()); err != nil || active {
		t.Fatal(active, err)
	}
	height = ""
	if _, _, err := systemAuditActivation(context.Background()); err == nil {
		t.Fatal("accepted missing height")
	}
}

func TestSystemAuditUnknownSurvivesRestartAndQuarantinesSigner(t *testing.T) {
	path := submissionTestDB(t)
	view, c, signer := systemAuditFixture(t, retrievalchallenge.Audit)
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
	commands := 0
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "keys" {
			return []byte(signer), nil
		}
		commands++
		return []byte(`{}`), nil
	})
	in := &systemAuditIntent{Version: 1, Signer: signer, Context: c, Seed: view.Seed, Ordinal: 3, State: "pending"}
	if err := submitFrozenSystemAudit(context.Background(), "provider", in, &types.ChainedProof{}); !errors.Is(err, errTxPending) {
		t.Fatal(err)
	}
	if err := closeSessionDB(); err != nil {
		t.Fatal(err)
	}
	if err := initSessionDB(path); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(committedHeightHeader, "12")
		response := types.QueryListStorageAuditsByProviderResponse{Audits: []types.StorageAuditView{view}}
		if err := (&jsonpb.Marshaler{OrigName: true, EmitDefaults: true}).Marshal(w, &response); err != nil {
			t.Error(err)
		}
	}))
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })

	var snapshot systemLivenessSnapshot
	if err := runFrozenSystemLiveness(context.Background(), 12, &snapshot); !errors.Is(err, errTxPending) {
		t.Fatal(err)
	}
	if commands != 1 || snapshot.ProofsSubmitted != 0 {
		t.Fatal(commands, snapshot)
	}
	marker, err := loadPendingSigner(signer)
	if err != nil || marker == nil || marker.Kind != "audit" || marker.TxHash != "" {
		t.Fatal(marker, err)
	}
	// Attempting a different original operation cannot seize the quarantined signer.
	replacement := *in
	replacement.Ordinal++
	if err := storeSystemAuditIntent(&replacement); err == nil {
		t.Fatal("replaced unknown audit intent")
	}
}

func TestSystemAuditTerminalOutcomesReleaseSignerWithoutRetry(t *testing.T) {
	for _, mode := range []string{"committed", "committed_failure", "checktx_rejection"} {
		t.Run(mode, func(t *testing.T) {
			submissionTestDB(t)
			view, c, signer := systemAuditFixture(t, retrievalchallenge.Audit)
			t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
			hash := strings.Repeat("A", 64)
			commands := 0
			setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if args[0] == "keys" {
					return []byte(signer), nil
				}
				commands++
				if !strings.Contains(strings.Join(args, " "), "--gas 2000000") {
					t.Error("audit used simulation-dependent gas")
				}
				if mode == "checktx_rejection" {
					return []byte(`{"code":5,"raw_log":"rejected"}`), nil
				}
				return []byte(fmt.Sprintf(`{"code":0,"txhash":%q}`, hash)), nil
			})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/txs/") {
					code := 0
					if mode == "committed_failure" {
						code = 7
					}
					fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"12","code":%d}}`, hash, code)
					return
				}
				w.Header().Set(committedHeightHeader, "12")
				view.Audit.Coverage[0] = 1 << 3
				view.Audit.AcceptedCount = 1
				response := types.QueryListStorageAuditsByProviderResponse{Audits: []types.StorageAuditView{view}}
				if err := (&jsonpb.Marshaler{OrigName: true, EmitDefaults: true}).Marshal(w, &response); err != nil {
					t.Error(err)
				}
			}))
			defer srv.Close()
			old := lcdBase
			lcdBase = srv.URL
			t.Cleanup(func() { lcdBase = old })
			in := &systemAuditIntent{Version: 1, Signer: signer, Context: c, Seed: view.Seed, Ordinal: 3, State: "pending"}
			err := submitFrozenSystemAudit(context.Background(), "provider", in, &types.ChainedProof{})
			if mode == "committed" && err != nil {
				t.Fatal(err)
			}
			if mode == "committed_failure" && !errors.Is(err, errTxFailed) {
				t.Fatal(err)
			}
			if mode == "checktx_rejection" && !errors.Is(err, errTxRejected) {
				t.Fatal(err)
			}
			if marker, err := loadPendingSigner(signer); err != nil || marker != nil {
				t.Fatal(marker, err)
			}
			var snapshot systemLivenessSnapshot
			err = runFrozenSystemLiveness(context.Background(), 12, &snapshot)
			if mode == "committed" {
				if err != nil || snapshot.ProofsSubmitted != 1 {
					t.Fatal(snapshot, err)
				}
			} else {
				if err == nil || snapshot.ProofsSubmitted != 0 {
					t.Fatal(snapshot, err)
				}
			}
			if commands != 1 {
				t.Fatal("rebroadcast terminal transaction", commands)
			}
			retained, err := loadSystemAuditIntent(signer)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "committed" {
				if retained != nil {
					t.Fatal("successful intent not cleaned")
				}
			} else {
				if retained == nil || retained.State != "failed" {
					t.Fatal(retained)
				}
				if accepted, _, err := reconcileSystemAudit(context.Background(), retained, c.Window.Deadline+1); err != nil || accepted {
					t.Fatal(accepted, err)
				}
			}
		})
	}
}

func TestFrozenSystemProofNativeGenerationAndDomains(t *testing.T) {
	useTempUploadDir(t)
	initCryptoForTest(t)
	payloadPath := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(payloadPath, bytes.Repeat([]byte("fresh native audit bytes"), 12000), 0600); err != nil {
		t.Fatal(err)
	}
	result, _, err := mode2BuildArtifacts(context.Background(), payloadPath, 91, "General:rs=8+4", "payload.bin", 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []uint8{retrievalchallenge.Audit, retrievalchallenge.Repair} {
		t.Run(fmt.Sprint(kind), func(t *testing.T) {
			view, _, _ := systemAuditFixture(t, kind)
			a := *view.Audit
			a.Assignment.DealId = 91
			a.Assignment.ManifestRoot = result.manifestRoot.Bytes[:]
			a.Assignment.Snapshot.MetadataMdus = 1 + result.witnessMdus
			c, err := types.StorageAuditContext(a, 10)
			if err != nil {
				t.Fatal(err)
			}
			challenges, err := c.Challenges(view.Seed)
			if err != nil {
				t.Fatal(err)
			}
			var chosen retrievalchallenge.Challenge
			for _, ch := range challenges {
				if ch.LeafIndex == 0 {
					chosen = ch
					break
				}
			}
			if chosen.MDUIndex != c.MetadataMDUs {
				t.Fatal("full slot sample did not contain populated row")
			}
			proof, err := generateFrozenSystemProof(context.Background(), dealScopedDir(91, result.manifestRoot), c, chosen)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Equal(proof.YValue, make([]byte, 32)) {
				t.Fatal("test must prove a nonzero blob")
			}
			requirePolyFSProofVerifies(t, c.Root[:], proof, uint64(64/c.K)*uint64(c.K+c.M))
			other := c
			other.Kind = retrievalchallenge.Audit
			if kind == retrievalchallenge.Audit {
				other.Kind = retrievalchallenge.Repair
			}
			otherChallenges, err := other.Challenges(view.Seed)
			if err != nil {
				t.Fatal(err)
			}
			if bytes.Equal(otherChallenges[chosen.Ordinal].Z[:], chosen.Z[:]) {
				t.Fatal("readiness and ACTIVE challenge domains aliased")
			}
			// A new context's opening cannot pass the old frozen challenge, even though
			// all structural witnesses and the committed data are identical.
			wrong := *proof
			wrong.ZValue = otherChallenges[chosen.Ordinal].Z[:]
			flat, err := flattenMerkleProof32(wrong.MerklePath)
			if err != nil {
				t.Fatal(err)
			}
			valid, err := crypto_ffi.VerifyMduProof(wrong.MduRootFr, wrong.BlobCommitment, flat, wrong.BlobIndex, uint64(64/c.K)*uint64(c.K+c.M), wrong.ZValue, wrong.YValue, wrong.KzgOpeningProof)
			if err != nil || valid {
				t.Fatal("accepted opening at another challenge", valid, err)
			}
		})
	}
}

func TestSystemAuditFATV3SparseProviderArtifacts(t *testing.T) {
	for caseIndex, name := range []string{"valid", "corrupt_metadata", "corrupt_witness", "corrupt_shard"} {
		t.Run(name, func(t *testing.T) {
			submissionTestDB(t)
			initCryptoForTest(t)
			dealID := uint64(1200 + caseIndex)
			payloadPath := filepath.Join(t.TempDir(), "payload.bin")
			if err := os.WriteFile(payloadPath, bytes.Repeat([]byte{byte(0x50 + caseIndex)}, 4096), 0o600); err != nil {
				t.Fatal(err)
			}
			result, dir, err := mode2BuildArtifactsWithOptions(t.Context(), payloadPath, dealID, "General:rs=8+4", "payload.bin", 0, mode2BuildOptions{fatVersion: 3})
			if err != nil {
				t.Fatal(err)
			}
			// A provider bundle carries authenticated metadata and its assigned
			// shards, without the uploader's local slab sidecar or publication marker.
			for _, path := range []string{slabMetadataPathForDealDir(dir), filepath.Join(dir, mode2SlabCompleteMarker), activeDealGenerationPointerPath(dealID)} {
				if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
					t.Fatal(err)
				}
			}
			shards, err := filepath.Glob(filepath.Join(dir, "mdu_*_slot_*.bin"))
			if err != nil {
				t.Fatal(err)
			}
			for _, path := range shards {
				if !strings.HasSuffix(path, "_slot_0.bin") {
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
				}
			}

			view, _, signer := systemAuditFixture(t, retrievalchallenge.Audit)
			view.EpochLength = 2
			view.Audit.EpochId = 6
			view.Audit.Assignment.DealId = dealID
			view.Audit.Assignment.ManifestRoot = bytes.Clone(result.manifestRoot.Bytes[:])
			view.Audit.Assignment.Snapshot.MetadataMdus = 1 + result.witnessMdus
			view.Audit.Assignment.Snapshot.UserMdus = result.userMdus
			c, err := types.StorageAuditContext(*view.Audit, view.EpochLength)
			if err != nil {
				t.Fatal(err)
			}
			view.CanonicalContext, _ = c.Bytes()
			challenges, err := c.Challenges(view.Seed)
			if err != nil {
				t.Fatal(err)
			}
			flip := func(path string, offset int64) {
				t.Helper()
				f, err := os.OpenFile(path, os.O_RDWR, 0)
				if err != nil {
					t.Fatal(err)
				}
				defer f.Close()
				var original [1]byte
				if _, err := f.ReadAt(original[:], offset); err != nil {
					t.Fatal(err)
				}
				original[0] ^= 0xff
				if _, err := f.WriteAt(original[:], offset); err != nil {
					t.Fatal(err)
				}
			}
			switch name {
			case "corrupt_metadata":
				flip(filepath.Join(dir, "mdu_0.bin"), 17)
			case "corrupt_witness":
				flip(filepath.Join(dir, "mdu_1.bin"), 1)
			case "corrupt_shard":
				challenge := challenges[0]
				offset := int64(uint64(challenge.LeafIndex)%uint64(64/c.K)*types.BLOB_SIZE + 17)
				flip(filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_0.bin", challenge.MDUIndex)), offset)
			}

			t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
			committed, commands := false, 0
			hash := strings.Repeat("F", 64)
			setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if args[0] == "keys" {
					return []byte(signer), nil
				}
				commands++
				if name != "valid" {
					t.Fatal("corrupted provider artifact reached broadcast", args)
				}
				raw, err := os.ReadFile(args[5])
				if err != nil {
					t.Fatal(err)
				}
				var proof types.ChainedProof
				if err := json.Unmarshal(raw, &proof); err != nil {
					t.Fatal(err)
				}
				expected, err := c.ChallengeForPosition(view.Seed, proof.MduIndex, proof.BlobIndex)
				if err != nil || !bytes.Equal(expected.Z[:], proof.ZValue) {
					t.Fatal("producer sent wrong fresh challenge", err)
				}
				view.Audit.Coverage[expected.Ordinal/8] |= 1 << (expected.Ordinal % 8)
				view.Audit.AcceptedCount++
				committed = true
				return []byte(fmt.Sprintf(`{"code":0,"txhash":%q}`, hash)), nil
			})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				height := "11"
				if committed {
					height = "12"
				}
				w.Header().Set(committedHeightHeader, height)
				if strings.Contains(r.URL.Path, "/txs/") {
					fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"12","code":0}}`, hash)
					return
				}
				response := types.QueryListStorageAuditsByProviderResponse{Audits: []types.StorageAuditView{view}}
				if err := (&jsonpb.Marshaler{OrigName: true, EmitDefaults: true}).Marshal(w, &response); err != nil {
					t.Error(err)
				}
			}))
			defer srv.Close()
			oldLCD := lcdBase
			lcdBase = srv.URL
			t.Cleanup(func() { lcdBase = oldLCD })
			var snapshot systemLivenessSnapshot
			if err := runFrozenSystemLiveness(context.Background(), 11, &snapshot); err != nil {
				t.Fatal(err)
			}
			if name == "valid" {
				if commands != 1 || snapshot.ProofsSubmitted != 1 || snapshot.ProofGenFailures != 0 {
					t.Fatal(commands, snapshot)
				}
			} else if commands != 0 || snapshot.ProofGenFailures != 1 || snapshot.LastError == "" {
				t.Fatal(commands, snapshot)
			}
		})
	}
}

func TestSystemAuditActivatedDispatchUsesOnlyFrozenInventory(t *testing.T) {
	submissionTestDB(t)
	_, _, signer := systemAuditFixture(t, retrievalchallenge.Audit)
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] != "keys" {
			t.Error("attempted a legacy broadcast", args)
		}
		return []byte(signer), nil
	})
	inventory := `{"audits":[]}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(committedHeightHeader, "12")
		switch r.URL.Path {
		case "/polystorechain/polystorechain/v1/params":
			fmt.Fprint(w, `{"params":{"retrieval_v2_activation_height":"11"}}`)
		case "/polystorechain/polystorechain/v1/storage-audits/by-provider/" + signer:
			if r.Header.Get(committedHeightHeader) != "12" {
				t.Error("frozen inventory not pinned")
			}
			fmt.Fprint(w, inventory)
		default:
			t.Error("v2 fell back to legacy query", r.URL.Path)
			http.Error(w, "unexpected", 500)
		}
	}))
	defer srv.Close()
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })
	if err := runSystemLivenessOnce(context.Background(), 999); err != nil {
		t.Fatal(err)
	}
	inventory = `{}`
	if err := runSystemLivenessOnce(context.Background(), 999); err == nil {
		t.Fatal("malformed v2 inventory accepted")
	}
}

func TestFrozenSystemAuditRefreshesHeightAfterWaitingForSigner(t *testing.T) {
	submissionTestDB(t)
	_, _, signer := systemAuditFixture(t, retrievalchallenge.Audit)
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] != "keys" {
			t.Fatal("unexpected command", args)
		}
		return []byte(signer), nil
	})
	foreground, err := claimRetrievalOperations(nil, signer)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(foreground)
	paramsQueries, auditQueries := 0, 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(committedHeightHeader, "13")
		switch r.URL.Path {
		case "/polystorechain/polystorechain/v1/params":
			paramsQueries++
			fmt.Fprint(w, `{"params":{"retrieval_v2_activation_height":"11"}}`)
		case "/polystorechain/polystorechain/v1/storage-audits/by-provider/" + signer:
			auditQueries++
			if r.Header.Get(committedHeightHeader) != "13" {
				t.Error("audit inventory used pre-wait height", r.Header.Get(committedHeightHeader))
			}
			fmt.Fprint(w, `{"audits":[]}`)
		default:
			t.Error("unexpected LCD query", r.URL.Path)
			http.Error(w, "unexpected", 500)
		}
	}))
	defer srv.Close()
	oldLCD := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = oldLCD })
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- runFrozenSystemLiveness(ctx, 12, &systemLivenessSnapshot{})
	}()
	waitForPrioritySigner(t, signer)
	foreground()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if paramsQueries != 1 || auditQueries != 1 {
		t.Fatal("unexpected refresh queries", paramsQueries, auditQueries)
	}
}

func TestSystemAuditKnownHashReconcilesAfterRestart(t *testing.T) {
	path := submissionTestDB(t)
	view, c, signer := systemAuditFixture(t, retrievalchallenge.Audit)
	hash := strings.Repeat("B", 64)
	commands := 0
	committed := false
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "keys" {
			return []byte(signer), nil
		}
		commands++
		return []byte(fmt.Sprintf(`{"code":0,"txhash":%q}`, hash)), nil
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/txs/") {
			if !committed {
				fmt.Fprint(w, `{}`)
				return
			}
			fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":0}}`, hash)
			return
		}
		w.Header().Set(committedHeightHeader, "13")
		view.Audit.Coverage[0] = 1 << 3
		view.Audit.AcceptedCount = 1
		response := types.QueryListStorageAuditsByProviderResponse{Audits: []types.StorageAuditView{view}}
		if err := (&jsonpb.Marshaler{OrigName: true, EmitDefaults: true}).Marshal(w, &response); err != nil {
			t.Error(err)
		}
	}))
	defer srv.Close()
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })
	in := &systemAuditIntent{Version: 1, Signer: signer, Context: c, Seed: view.Seed, Ordinal: 3, State: "pending"}
	if err := submitFrozenSystemAudit(context.Background(), "provider", in, &types.ChainedProof{}); !errors.Is(err, errTxPending) {
		t.Fatal(err)
	}
	if err := closeSessionDB(); err != nil {
		t.Fatal(err)
	}
	if err := initSessionDB(path); err != nil {
		t.Fatal(err)
	}
	marker, err := loadPendingSigner(signer)
	if err != nil || marker == nil || marker.TxHash != hash {
		t.Fatal(marker, err)
	}
	committed = true
	var snapshot systemLivenessSnapshot
	if err := runFrozenSystemLiveness(context.Background(), 13, &snapshot); err != nil {
		t.Fatal(err)
	}
	if snapshot.ProofsSubmitted != 1 || commands != 1 {
		t.Fatal(snapshot, commands)
	}
	if marker, err := loadPendingSigner(signer); err != nil || marker != nil {
		t.Fatal(marker, err)
	}
}

func TestSystemAuditProducerUsesAnchorAndStopsAtCommittedDeadline(t *testing.T) {
	submissionTestDB(t)
	initCryptoForTest(t)
	payloadPath := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(payloadPath, bytes.Repeat([]byte("audit deadline fixture"), 12000), 0600); err != nil {
		t.Fatal(err)
	}
	result, _, err := mode2BuildArtifacts(context.Background(), payloadPath, 91, "General:rs=8+4", "payload.bin", 0)
	if err != nil {
		t.Fatal(err)
	}
	view, _, signer := systemAuditFixture(t, retrievalchallenge.Audit)
	view.EpochLength = 2
	view.Audit.EpochId = 6
	view.Audit.Assignment.DealId = 91
	view.Audit.Assignment.ManifestRoot = result.manifestRoot.Bytes[:]
	view.Audit.Assignment.Snapshot.MetadataMdus = 1 + result.witnessMdus
	c, err := types.StorageAuditContext(*view.Audit, view.EpochLength)
	if err != nil {
		t.Fatal(err)
	}
	view.CanonicalContext, _ = c.Bytes()
	if c.Window.Anchor != 11 || c.Window.First != 12 || c.Window.Deadline != 12 {
		t.Fatal(c.Window)
	}
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
	committed := false
	commands := 0
	hash := strings.Repeat("C", 64)
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[0] == "keys" {
			return []byte(signer), nil
		}
		commands++
		if len(args) < 6 || args[2] != "prove-liveness-system" || args[3] != "91" || args[4] != "6" {
			t.Fatal("wrong audit command", args)
		}
		raw, err := os.ReadFile(args[5])
		if err != nil {
			t.Fatal(err)
		}
		var proof types.ChainedProof
		if err := json.Unmarshal(raw, &proof); err != nil {
			t.Fatal(err)
		}
		expected, err := c.ChallengeForPosition(view.Seed, proof.MduIndex, proof.BlobIndex)
		if err != nil || !bytes.Equal(expected.Z[:], proof.ZValue) {
			t.Fatal("producer sent wrong fresh challenge", err)
		}
		view.Audit.Coverage[expected.Ordinal/8] |= 1 << (expected.Ordinal % 8)
		view.Audit.AcceptedCount++
		committed = true
		return []byte(fmt.Sprintf(`{"code":0,"txhash":%q}`, hash)), nil
	})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		height := "11"
		if committed {
			height = "12"
		}
		w.Header().Set(committedHeightHeader, height)
		if strings.Contains(r.URL.Path, "/txs/") {
			fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"12","code":0}}`, hash)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/params") {
			fmt.Fprint(w, `{"params":{"retrieval_v2_activation_height":"11"}}`)
			return
		}
		response := types.QueryListStorageAuditsByProviderResponse{Audits: []types.StorageAuditView{view}}
		if err := (&jsonpb.Marshaler{OrigName: true, EmitDefaults: true}).Marshal(w, &response); err != nil {
			t.Error(err)
		}
	}))
	defer srv.Close()
	old := lcdBase
	lcdBase = srv.URL
	t.Cleanup(func() { lcdBase = old })
	var snapshot systemLivenessSnapshot
	if err := runFrozenSystemLiveness(context.Background(), 11, &snapshot); err != nil {
		t.Fatal(err)
	}
	if commands != 1 || snapshot.ProofsSubmitted != 1 || view.Audit.AcceptedCount != 1 {
		t.Fatal(commands, snapshot, view.Audit)
	}
	// Already committed at deadline: no proof can still be included in the window.
	if err := runFrozenSystemLiveness(context.Background(), 12, &snapshot); err != nil {
		t.Fatal(err)
	}
	if commands != 1 {
		t.Fatal("broadcast after the committed deadline", commands)
	}
}

func TestSystemAuditCoverageRecoversUnknownOutcomesAtomically(t *testing.T) {
	for _, name := range []string{
		"lost_hash_covered", "unavailable_hash_covered", "lost_hash_uncovered", "known_hash_uncovered",
		"other_generation", "other_seed", "other_ordinal", "missing_height", "before_response_window", "malformed_inventory",
		"foreign_marker", "other_marker_ordinal", "changed_marker_hash", "missing_marker", "changed_intent_seed",
	} {
		t.Run(name, func(t *testing.T) {
			path := submissionTestDB(t)
			view, c, signer := systemAuditFixture(t, retrievalchallenge.Audit)
			view.Audit.Coverage[0] = 1 << 3
			view.Audit.AcceptedCount = 1
			in := &systemAuditIntent{Version: 1, Signer: signer, Context: c, Seed: bytes.Clone(view.Seed), Ordinal: 3, State: "pending"}
			if name == "unavailable_hash_covered" || name == "known_hash_uncovered" {
				in.TxHash = strings.Repeat("D", 64)
			}
			if err := storeSystemAuditIntent(in); err != nil {
				t.Fatal(err)
			}
			// Exercise the persisted record, not only the in-memory broadcast callback.
			if err := closeSessionDB(); err != nil {
				t.Fatal(err)
			}
			if err := initSessionDB(path); err != nil {
				t.Fatal(err)
			}
			in, err := loadSystemAuditIntent(signer)
			if err != nil {
				t.Fatal(err)
			}
			height := "12"
			body := ""
			switch name {
			case "lost_hash_uncovered", "known_hash_uncovered":
				view.Audit.Coverage[0] = 0
				view.Audit.AcceptedCount = 0
			case "other_generation":
				view.Audit.Assignment.Snapshot.Generation++
				other, err := types.StorageAuditContext(*view.Audit, view.EpochLength)
				if err != nil {
					t.Fatal(err)
				}
				view.CanonicalContext, _ = other.Bytes()
			case "other_seed":
				view.Seed = bytes.Repeat([]byte{7}, 32)
			case "other_ordinal":
				view.Audit.Coverage[0] = 1 << 2
			case "missing_height":
				height = ""
			case "before_response_window":
				height = "11"
			case "malformed_inventory":
				body = `{}`
			case "foreign_marker", "other_marker_ordinal", "changed_marker_hash", "missing_marker", "changed_intent_seed":
				err := sessionDB.Update(func(tx *bolt.Tx) error {
					b := tx.Bucket(onChainSessionProofsBucket)
					if name == "missing_marker" {
						return b.Delete(pendingSignerKey(signer))
					}
					if name == "changed_intent_seed" {
						changed := *in
						changed.Seed = bytes.Repeat([]byte{8}, 32)
						raw, err := json.Marshal(changed)
						if err != nil {
							return err
						}
						return b.Put(auditIntentKey(signer), raw)
					}
					marker := pendingSignerOperation{Kind: "audit", IDs: []string{in.operationID()}, TxHash: in.TxHash}
					switch name {
					case "foreign_marker":
						marker.Kind = "retrieval"
					case "other_marker_ordinal":
						marker.IDs = []string{strings.TrimSuffix(in.operationID(), ":3") + ":4"}
					case "changed_marker_hash":
						marker.TxHash = strings.Repeat("E", 64)
					}
					raw, err := json.Marshal(marker)
					if err != nil {
						return err
					}
					return b.Put(pendingSignerKey(signer), raw)
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			readRecords := func() ([]byte, []byte) {
				t.Helper()
				var intent, marker []byte
				if err := sessionDB.View(func(tx *bolt.Tx) error {
					b := tx.Bucket(onChainSessionProofsBucket)
					intent = bytes.Clone(b.Get(auditIntentKey(signer)))
					marker = bytes.Clone(b.Get(pendingSignerKey(signer)))
					return nil
				}); err != nil {
					t.Fatal(err)
				}
				return intent, marker
			}
			beforeIntent, beforeMarker := readRecords()
			coverageRequests, txRequests := 0, 0
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "/txs/") {
					txRequests++
					if name == "unavailable_hash_covered" {
						http.NotFound(w, r)
						return
					}
					fmt.Fprint(w, `{}`)
					return // Explicitly unknown outcome, without a polling delay.
				}
				if r.URL.Path != "/polystorechain/polystorechain/v1/storage-audits/by-provider/"+signer {
					t.Error("wrong coverage authority", r.URL.Path)
				}
				coverageRequests++
				if height != "" {
					w.Header().Set(committedHeightHeader, height)
				}
				if body != "" {
					fmt.Fprint(w, body)
					return
				}
				response := types.QueryListStorageAuditsByProviderResponse{Audits: []types.StorageAuditView{view}}
				if err := (&jsonpb.Marshaler{OrigName: true, EmitDefaults: true}).Marshal(w, &response); err != nil {
					t.Error(err)
				}
			}))
			defer srv.Close()
			old := lcdBase
			lcdBase = srv.URL
			t.Cleanup(func() { lcdBase = old })
			accepted, committed, err := reconcileSystemAudit(context.Background(), in, 12)
			afterIntent, afterMarker := readRecords()
			recovered := name == "lost_hash_covered" || name == "unavailable_hash_covered"
			if recovered {
				if err != nil || !accepted || committed != 12 || afterIntent != nil || afterMarker != nil {
					t.Fatal("matching coverage did not atomically recover", accepted, committed, err, afterIntent, afterMarker)
				}
			} else {
				if err == nil || accepted || !bytes.Equal(beforeIntent, afterIntent) || !bytes.Equal(beforeMarker, afterMarker) {
					t.Fatal("ambiguous coverage or changed marker released an intent", accepted, err)
				}
			}
			expectedTxRequests := 0
			if name == "known_hash_uncovered" {
				expectedTxRequests = 1
			}
			if coverageRequests != 1 || txRequests != expectedTxRequests {
				t.Fatal("unexpected recovery lookups", coverageRequests, txRequests)
			}
		})
	}
}
