package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strconv"
	"strings"
	"testing"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/gogoproto/jsonpb"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func TestProviderV3AggregateFreshSubmissionRecovery(t *testing.T) {
	frozen, _, _ := buildProviderV3ArtifactFixture(t)
	artifactUploadDir := uploadDir
	signer := frozen.Session.Obligations[0].AssignedProvider
	_, proofs, _, err := buildProviderProofBatchV3(t.Context(), frozen, signer)
	if err != nil {
		t.Fatal(err)
	}
	id := "0x" + hex.EncodeToString(frozen.Session.SessionId)
	hash := strings.Repeat("A", 64)
	t.Setenv("POLYSTORE_PROVIDER_KEY", "faucet")
	t.Setenv("POLYSTORE_PROVIDER_ADDRESS", "")
	for _, tc := range []struct {
		name, output, phase, status string
		code                        int
		retained, zero, wrongSigner bool
	}{
		{name: "committed", output: `{"txhash":"` + hash + `","code":0}`, code: 200, status: "success"},
		{name: "hashless ambiguous", output: `{"code":0}`, code: 202, status: "pending", retained: true},
		{name: "known mempool", output: `{"txhash":"` + hash + `","code":19,"codespace":"sdk"}`, code: 202, status: "pending", retained: true},
		{name: "known rejection", output: `{"code":12}`, code: 409, status: "failed"},
		{name: "proven not broadcast", phase: "polystore-submission-v1:not-broadcast\n", code: 409, status: "failed"},
		{name: "nothing unaccepted", zero: true, code: 200, status: "reconciled"},
		{name: "actual signing account changed", wrongSigner: true, code: 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			submissionTestDB(t)
			journalUploadDir := uploadDir
			uploadDir = artifactUploadDir
			t.Cleanup(func() { uploadDir = journalUploadDir })
			originalBitmap := frozen.Session.AcceptedSampleBitmap
			frozen.Session.AcceptedSampleBitmap = bytes.Clone(originalBitmap)
			t.Cleanup(func() { frozen.Session.AcceptedSampleBitmap = originalBitmap })
			if tc.zero {
				for _, proof := range proofs {
					frozen.Session.AcceptedSampleBitmap[proof.Ordinal/8] |= 1 << (proof.Ordinal % 8)
				}
			}
			lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.Contains(r.URL.Path, "/retrieval-sessions-v3/"):
					w.Header().Set(committedHeightHeader, strconv.FormatUint(frozen.Height, 10))
					anchor := make([]byte, 32)
					anchor[0] = 42
					_ = (&jsonpb.Marshaler{OrigName: true}).Marshal(w, &types.QueryGetRetrievalSessionV3Response{Session: frozen.Session, AnchorSeed: anchor})
				case strings.Contains(r.URL.Path, "/cosmos/tx/v1beta1/txs/"):
					fmt.Fprintf(w, `{"tx_response":{"txhash":%q,"height":"13","code":0}}`, hash)
				default:
					http.NotFound(w, r)
				}
			}))
			defer lcd.Close()
			oldLCD := lcdBase
			lcdBase = lcd.URL
			t.Cleanup(func() { lcdBase = oldLCD })
			actualSigner := signer
			if tc.wrongSigner {
				actualSigner = sdk.AccAddress(bytes.Repeat([]byte{99}, 20)).String()
			}
			calls, proofPath := 0, ""
			setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if args[0] == "keys" {
					return []byte(actualSigner), nil
				}
				calls++
				if len(args) < 5 || args[3] != "prove-batch" {
					t.Fatalf("not an aggregate provider submission: %q", args)
				}
				proofPath = args[4]
				input, err := os.ReadFile(proofPath)
				if err != nil {
					t.Fatal(err)
				}
				var msg types.MsgSubmitRetrievalSessionProofBatchV3
				if err := jsonpb.Unmarshal(bytes.NewReader(input), &msg); err != nil || len(msg.Sessions) != 1 || msg.Creator != signer || !reflect.DeepEqual(msg.Sessions[0].Proofs, proofs) || !bytes.Equal(msg.Sessions[0].SessionId, frozen.Session.SessionId) || msg.Sessions[0].Slot != 0 {
					t.Fatalf("aggregate changed the frozen obligation: %+v %v", msg, err)
				}
				marker, err := loadPendingSigner(signer)
				want := retrievalProofOperationV3(frozen.Session.SessionId, proofs)
				if err != nil || marker == nil || !reflect.DeepEqual(*marker, want) {
					t.Fatalf("exact hashless intent was not durable before broadcast: %+v %v", marker, err)
				}
				if tc.phase != "" {
					writeSubmissionPhase(t, args, tc.phase)
					return nil, errors.New("local simulation failed")
				}
				return []byte(tc.output), nil
			})
			result := invokeSubmission(`{"session_id":"` + id + `"}`)
			if result.Code != tc.code || tc.status != "" && !strings.Contains(result.Body.String(), `"status":"`+tc.status+`"`) {
				t.Fatalf("unexpected fresh outcome: %d %s", result.Code, result.Body.String())
			}
			marker, err := loadPendingSigner(signer)
			if err != nil || (marker != nil) != tc.retained {
				t.Fatalf("unexpected journal retention: %+v %v", marker, err)
			}
			if tc.retained {
				wantHash := ""
				if strings.Contains(tc.output, hash) {
					wantHash = hash
				}
				if marker.TxHash != wantHash {
					t.Fatalf("observed hash not durable before pending response: %+v", marker)
				}
				actualSigner = sdk.AccAddress(bytes.Repeat([]byte{99}, 20)).String()
				changedAccount := invokeSubmission(`{"session_id":"` + id + `"}`)
				if changedAccount.Code != 409 || calls != 1 {
					t.Fatalf("changed account reused the original signer intent: %d %s", changedAccount.Code, changedAccount.Body.String())
				}
				if retained, err := loadPendingSigner(signer); err != nil || retained == nil || !reflect.DeepEqual(*retained, *marker) {
					t.Fatalf("changed account altered original signer quarantine: %+v %v", retained, err)
				}
				actualSigner = signer
				retry := invokeSubmission(`{"session_id":"` + id + `"}`)
				var recovery map[string]json.RawMessage
				if err := json.Unmarshal(retry.Body.Bytes(), &recovery); err != nil || recovery["recorded_session_id"] == nil || recovery["session_id"] != nil || calls != 1 {
					t.Fatalf("retry rebroadcast or changed recovery identity: calls=%d body=%s err=%v", calls, retry.Body.String(), err)
				}
				if wantHash == "" {
					if retry.Code != 202 {
						t.Fatalf("hashless unknown did not remain quarantined: %d %s", retry.Code, retry.Body.String())
					}
					for _, proof := range proofs {
						frozen.Session.AcceptedSampleBitmap[proof.Ordinal/8] |= 1 << (proof.Ordinal % 8)
					}
					retry = invokeSubmission(`{"session_id":"` + id + `"}`)
				}
				if retry.Code != 200 || calls != 1 {
					t.Fatalf("exact committed evidence did not reconcile: %d %s calls=%d", retry.Code, retry.Body.String(), calls)
				}
				if marker, err := loadPendingSigner(signer); err != nil || marker != nil {
					t.Fatalf("conclusive recovery retained journal: %+v %v", marker, err)
				}
			}
			if proofPath != "" {
				if _, err := os.Stat(proofPath); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("temporary proof envelope survived request: %v", err)
				}
			}
			wantCalls := 1
			if tc.zero || tc.wrongSigner {
				wantCalls = 0
			}
			if calls != wantCalls {
				t.Fatalf("submitted %d transactions, want %d", calls, wantCalls)
			}
		})
	}
}

func TestProviderV3AggregateEnvelopePartitionBoundaries(t *testing.T) {
	r, height := frozenSessionV3Fixture(t, 1<<30, 133)
	frozen, err := freezeRetrievalSessionV3Response(r, height)
	if err != nil {
		t.Fatal(err)
	}
	obligation := frozen.Session.Obligations[0]
	// Deliberately synthetic global partitions exercise admission boundaries;
	// they are not normal 132-sample/eight-provider performance fixtures.
	for _, count := range []int{0, 1, 2, 8, 16, 32, 64, 65, 132} {
		t.Run(strconv.Itoa(count), func(t *testing.T) {
			frozen.Challenges = make([]retrievalchallenge.ChallengeV3, count)
			for i := range frozen.Challenges {
				frozen.Challenges[i] = retrievalchallenge.ChallengeV3{Ordinal: uint64(i), Slot: obligation.Slot}
			}
			_, selected, remaining, err := providerChallengesV3(frozen, obligation.AssignedProvider, 64)
			if err != nil || len(selected) != min(count, 64) || remaining != max(count-64, 0) {
				t.Fatalf("count=%d selected=%d remaining=%d err=%v", count, len(selected), remaining, err)
			}
			for _, challenge := range selected {
				frozen.Session.AcceptedSampleBitmap[challenge.Ordinal/8] |= 1 << (challenge.Ordinal % 8)
			}
			_, next, after, err := providerChallengesV3(frozen, obligation.AssignedProvider, 64)
			if err != nil || len(next) != min(remaining, 64) || after != max(remaining-64, 0) {
				t.Fatalf("continuation changed remaining ordinals: next=%d remaining=%d err=%v", len(next), after, err)
			}
			for _, challenge := range next {
				if challenge.Ordinal < 64 {
					t.Fatalf("continuation reselected accepted ordinal %d", challenge.Ordinal)
				}
			}
			clear(frozen.Session.AcceptedSampleBitmap)
		})
	}
}
