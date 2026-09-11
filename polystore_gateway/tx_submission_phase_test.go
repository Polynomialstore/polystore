package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func writeSubmissionPhase(t *testing.T, args []string, marker string) string {
	t.Helper()
	for i, arg := range args {
		if arg == "--submission-phase-file" && i+1 < len(args) {
			if err := os.WriteFile(args[i+1], []byte(marker), 0600); err != nil {
				t.Fatal(err)
			}
			return args[i+1]
		}
	}
	t.Fatal("missing phase path")
	return ""
}

func TestSubmissionPhaseRequiresExplicitFinalEvidence(t *testing.T) {
	hash := strings.Repeat("A", 64)
	for _, tc := range []struct {
		name, marker, output string
		safe                 bool
	}{
		{"local", "polystore-submission-v1:not-broadcast\n", "simulation failed", true},
		{"missing", "", "local build failed; no hash", false},
		{"partial", "polystore-submission-v1:not-broadcast", "", false},
		{"extra", "polystore-submission-v1:not-broadcast\nextra", "", false},
		{"contradictory_hash", "polystore-submission-v1:not-broadcast\n", fmt.Sprintf(`{"txhash":%q,"code":0}`, hash), false},
		{"mempool", "", fmt.Sprintf(`{"txhash":%q,"code":19,"codespace":"sdk"}`, hash), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var path string
			setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
				path = writeSubmissionPhase(t, args, tc.marker)
				if tc.name == "mempool" {
					return []byte(tc.output), nil
				}
				return []byte(tc.output), errors.New("CLI failed")
			})
			recorded := ""
			_, err := submitTxAndRecord(context.Background(), func(h string) error { recorded = h; return nil }, "tx", "polystorechain", "submit-retrieval-proof", "fixture")
			if errors.Is(err, errTxNotSubmitted) != tc.safe || errors.Is(err, errTxPending) == tc.safe {
				t.Fatal(err)
			}
			if strings.Contains(tc.output, hash) && recorded != hash {
				t.Fatal("lost observed hash", recorded)
			}
			if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("phase file survived attempt", err)
			}
		})
	}
}

func TestSubmissionPhaseStartAndCancellationAreProvenLocal(t *testing.T) {
	old := mockCombinedOutput
	mockCombinedOutput = nil
	t.Cleanup(func() { mockCombinedOutput = old })
	_, err := runCommand(context.Background(), filepath.Join(t.TempDir(), "absent-cli"), nil, "")
	if !errors.Is(err, errTxNotSubmitted) {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = submitTxAndRecord(ctx, nil, "tx", "polystorechain", "submit-retrieval-proof", "unused")
	if !errors.Is(err, errTxNotSubmitted) || errors.Is(err, errTxPending) {
		t.Fatal(err)
	}
}

func TestSubmissionPhaseRetryNeverReusesPriorMarker(t *testing.T) {
	var paths []string
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		marker := ""
		if len(paths) == 0 {
			marker = "polystore-submission-v1:not-broadcast\n"
		}
		paths = append(paths, writeSubmissionPhase(t, args, marker))
		return nil, errors.New("same CLI text")
	})
	args := []string{"tx", "polystorechain", "submit-retrieval-proof", "fixture"}
	if _, err := submitTxAndRecord(context.Background(), nil, args...); !errors.Is(err, errTxNotSubmitted) {
		t.Fatal(err)
	}
	if _, err := submitTxAndRecord(context.Background(), nil, args...); !errors.Is(err, errTxPending) {
		t.Fatal(err)
	}
	if paths[0] == paths[1] {
		t.Fatal("reused phase file")
	}
}

func TestSubmissionTimingRetainsExplicitSequenceAttempts(t *testing.T) {
	hash := strings.Repeat("A", 64)
	calls := 0
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		calls++
		writeSubmissionPhase(t, args, fmt.Sprintf(`{"schema":"polystore-submission-timing-v1","pre_broadcast_ns":%d,"broadcast_tx_sync_ns":%d}`+"\n", calls, calls+10))
		code := 32
		if calls == 2 {
			code = 0
		}
		return []byte(fmt.Sprintf(`{"txhash":%q,"code":%d,"codespace":"sdk"}`, hash, code)), nil
	})
	out, timings, complete, err := runTxWithRetryTiming(context.Background(), "tx", "polystorechain", "retrieval-session-v3", "fixture")
	if err != nil || !complete || calls != 2 || len(timings) != 2 || !strings.Contains(string(out), `"code":0`) {
		t.Fatal(err, complete, calls, timings, string(out))
	}
	if timings[0].Attempt != 1 || timings[0].CheckTxCode != 32 || timings[1].Attempt != 2 || timings[1].CheckTxCode != 0 {
		t.Fatal("sequence retry timing lost", timings)
	}
}

func TestSubmissionTimingIsObservationalOnly(t *testing.T) {
	for _, phase := range []string{
		`{"schema":"wrong","pre_broadcast_ns":1,"broadcast_tx_sync_ns":2}`,
		`{"schema":"polystore-submission-timing-v1"}`,
		`{"schema":"polystore-submission-timing-v1","pre_broadcast_ns":null,"broadcast_tx_sync_ns":2}`,
		`{"schema":"polystore-submission-timing-v1","pre_broadcast_ns":"1","broadcast_tx_sync_ns":2}`,
		`{"schema":"polystore-submission-timing-v1","pre_broadcast_ns":1.0,"broadcast_tx_sync_ns":2}`,
		`{"schema":"polystore-submission-timing-v1","pre_broadcast_ns":1,"broadcast_tx_sync_ns":2,"extra":3}`,
		`{"schema":"polystore-submission-timing-v1","pre_broadcast_ns":90000000001,"broadcast_tx_sync_ns":2}`,
		`{`,
		``,
	} {
		t.Run(phase, func(t *testing.T) {
			setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
				writeSubmissionPhase(t, args, phase)
				return []byte(`{"txhash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","code":0}`), nil
			})
			_, timings, complete, err := runTxWithRetryTiming(context.Background(), "tx", "polystorechain", "retrieval-session-v3", "fixture")
			if err != nil || complete || len(timings) != 0 {
				t.Fatal("malformed timing changed transaction semantics", err, complete, timings)
			}
		})
	}
}

func TestSubmissionPhaseCancellationAfterCheckTxRejection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	setupMockCombinedOutput(t, func(context.Context, string, ...string) ([]byte, error) {
		calls++
		cancel()
		return []byte(`{"txhash":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","code":32,"codespace":"sdk"}`), nil
	})
	recorded := false
	_, err := submitTxAndRecord(ctx, func(string) error { recorded = true; return nil }, "tx", "polystorechain", "submit-retrieval-proof", "fixture")
	if !errors.Is(err, errTxRejected) || recorded || calls != 1 {
		t.Fatal("rejected attempt became an unknown broadcast", err, recorded, calls)
	}
}

func TestFrozenSubmissionLocalFailureReleasesDurableIntent(t *testing.T) {
	for _, mode := range []string{"local", "unknown", "start_failure"} {
		t.Run(mode, func(t *testing.T) {
			local := mode != "unknown"
			path := submissionTestDB(t)
			response, frozen, proofs := submissionFixture(t, 1)
			cleanupTestAuthority(t, response, "12", nil)
			if err := storeFrozenSessionProof(frozen, proofs); err != nil {
				t.Fatal(err)
			}
			commands := 0
			absentCLI := filepath.Join(t.TempDir(), "absent-cli")
			setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
				if args[0] == "keys" {
					return []byte(response.Session.AuthorizedProofProvider), nil
				}
				commands++
				if mode == "start_failure" {
					mock := mockCombinedOutput
					mockCombinedOutput = nil
					defer func() { mockCombinedOutput = mock }()
					return runCommand(context.Background(), absentCLI, nil, "")
				}
				if local {
					writeSubmissionPhase(t, args, "polystore-submission-v1:not-broadcast\n")
				}
				return nil, errors.New("simulation failed")
			})
			body := fmt.Sprintf(`{"session_id":%q}`, "0x"+hex.EncodeToString(frozen.Context.ID[:]))
			got := invokeSubmission(body)
			want := 202
			if local {
				want = 409
			}
			if got.Code != want {
				t.Fatal(got.Code, got.Body.String())
			}
			if err := closeSessionDB(); err != nil {
				t.Fatal(err)
			}
			if err := initSessionDB(path); err != nil {
				t.Fatal(err)
			}
			stored, err := loadFrozenSubmission(frozen)
			if err != nil || stored.record.Submitting == local || stored.record.TxHash != "" {
				t.Fatal(stored, err)
			}
			marker, err := loadPendingSigner(response.Session.AuthorizedProofProvider)
			if err != nil || (marker == nil) != local {
				t.Fatal(marker, err)
			}
			got = invokeSubmission(body)
			wantCommands := 1
			if local {
				wantCommands = 2
			}
			if got.Code != want || commands != wantCommands {
				t.Fatal(got.Code, commands)
			}
		})
	}
}

func TestSystemAuditLocalFailureReleasesDurableIntent(t *testing.T) {
	submissionTestDB(t)
	view, c, signer := systemAuditFixture(t, retrievalchallenge.Audit)
	commands := 0
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		commands++
		writeSubmissionPhase(t, args, "polystore-submission-v1:not-broadcast\n")
		return nil, errors.New("local signing failed")
	})
	for i := 0; i < 2; i++ {
		in := &systemAuditIntent{Version: 1, Signer: signer, Context: c, Seed: view.Seed, Ordinal: 3, State: "pending"}
		if err := submitFrozenSystemAudit(context.Background(), "provider", in, &types.ChainedProof{}); !errors.Is(err, errTxNotSubmitted) {
			t.Fatal(err)
		}
		if marker, err := loadPendingSigner(signer); err != nil || marker != nil {
			t.Fatal(marker, err)
		}
		if retained, err := loadSystemAuditIntent(signer); err != nil || retained != nil {
			t.Fatal(retained, err)
		}
	}
	if commands != 2 {
		t.Fatal("local failure was not retryable", commands)
	}
}
