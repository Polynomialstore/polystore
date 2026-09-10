package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
)

var errTxPending = errors.New("transaction outcome unknown")
var errTxRejected = errors.New("transaction rejected before inclusion")
var errTxFailed = errors.New("committed transaction failed")
var errTxNotSubmitted = errors.New("transaction failed before broadcast")

const maxCommittedTxResponseBytes = 4 << 20
const maxSubmissionPhaseBytes = 1024

type submissionPhaseTiming struct {
	Schema            string `json:"schema"`
	PreBroadcastNS    uint64 `json:"pre_broadcast_ns"`
	BroadcastTxSyncNS uint64 `json:"broadcast_tx_sync_ns"`
}

type submissionAttemptTiming struct {
	Attempt           int    `json:"attempt"`
	PreBroadcastNS    uint64 `json:"pre_broadcast_ns"`
	BroadcastTxSyncNS uint64 `json:"broadcast_tx_sync_ns"`
	CheckTxCode       uint32 `json:"check_tx_code"`
}

type txSubmissionTiming struct {
	Attempts            []submissionAttemptTiming
	CommitObservationNS uint64
	Complete            bool
}

func parseSubmissionPhaseTiming(value []byte) (submissionPhaseTiming, error) {
	if err := validateJSONObject(value); err != nil {
		return submissionPhaseTiming{}, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(value, &fields); err != nil || len(fields) != 3 {
		return submissionPhaseTiming{}, fmt.Errorf("invalid submission timing object")
	}
	var schema string
	if err := json.Unmarshal(fields["schema"], &schema); err != nil || schema != "polystore-submission-timing-v1" {
		return submissionPhaseTiming{}, fmt.Errorf("invalid submission timing schema")
	}
	parseDuration := func(name string) (uint64, error) {
		raw, ok := fields[name]
		if !ok {
			return 0, fmt.Errorf("missing %s", name)
		}
		value, err := strconv.ParseUint(string(raw), 10, 64)
		if err != nil || strconv.FormatUint(value, 10) != string(raw) || value > uint64(90*time.Second) {
			return 0, fmt.Errorf("invalid %s", name)
		}
		return value, nil
	}
	preBroadcast, err := parseDuration("pre_broadcast_ns")
	if err != nil {
		return submissionPhaseTiming{}, err
	}
	broadcast, err := parseDuration("broadcast_tx_sync_ns")
	if err != nil {
		return submissionPhaseTiming{}, err
	}
	return submissionPhaseTiming{Schema: schema, PreBroadcastNS: preBroadcast, BroadcastTxSyncNS: broadcast}, nil
}

// Only these CLI commands implement the explicit phase contract. Each attempt
// gets its own empty private file, so retry can never reuse an earlier marker.
func execTrackedSubmission(ctx context.Context, args ...string) ([]byte, error) {
	out, _, _, err := execTrackedSubmissionTiming(ctx, args...)
	return out, err
}

func execTrackedSubmissionTiming(ctx context.Context, args ...string) ([]byte, submissionPhaseTiming, bool, error) {
	if len(args) < 3 || args[0] != "tx" || (args[2] != "submit-retrieval-proof" && args[2] != "prove-liveness-system" && args[2] != "accept-deal-generation-v3" && args[2] != "retrieval-session-v3") {
		out, err := execPolystorechaind(ctx, args...)
		return out, submissionPhaseTiming{}, false, err
	}
	file, err := os.CreateTemp("", "polystore-submission-phase-*")
	if err != nil {
		return nil, submissionPhaseTiming{}, false, fmt.Errorf("%w: %w", errTxNotSubmitted, err)
	}
	defer os.Remove(file.Name())
	if err := file.Close(); err != nil {
		return nil, submissionPhaseTiming{}, false, fmt.Errorf("%w: %w", errTxNotSubmitted, err)
	}
	command := append(append([]string(nil), args...), "--submission-phase-file", file.Name())
	out, err := execPolystorechaind(ctx, command...)
	phase, readErr := os.Open(file.Name())
	if readErr != nil {
		return out, submissionPhaseTiming{}, false, err
	}
	value, readErr := io.ReadAll(io.LimitReader(phase, maxSubmissionPhaseBytes+1))
	_ = phase.Close()
	if err != nil && readErr == nil && string(value) == "polystore-submission-v1:not-broadcast\n" {
		return out, submissionPhaseTiming{}, false, fmt.Errorf("%w: %w", errTxNotSubmitted, err)
	}
	timing, timingErr := parseSubmissionPhaseTiming(value)
	valid := readErr == nil && len(value) <= maxSubmissionPhaseBytes && timingErr == nil
	return out, timing, valid, err
}

func normalizeTxHash(raw string) (string, error) {
	s := strings.TrimPrefix(strings.TrimSpace(raw), "0x")
	if len(s) != 64 {
		return "", fmt.Errorf("transaction hash must be 32 bytes")
	}
	if _, err := hex.DecodeString(s); err != nil {
		return "", err
	}
	return strings.ToUpper(s), nil
}

// The code must be explicitly present as an unsigned JSON integer. Null,
// strings, fractions and absent fields cannot default to successful code zero.
func explicitTxCode(raw json.RawMessage) (uint32, error) {
	code, err := strconv.ParseUint(string(raw), 10, 32)
	if err != nil || strconv.FormatUint(code, 10) != string(raw) {
		return 0, fmt.Errorf("invalid transaction code")
	}
	return uint32(code), nil
}

func committedTxResult(body []byte, expected string) error {
	if err := validateJSONObject(body); err != nil {
		return err
	}
	var envelope struct {
		Response json.RawMessage `json:"tx_response"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return err
	}
	if err := validateJSONObject(envelope.Response); err != nil {
		return fmt.Errorf("invalid tx_response: %w", err)
	}
	var response struct {
		Hash   string          `json:"txhash"`
		Height string          `json:"height"`
		Code   json.RawMessage `json:"code"`
		RawLog string          `json:"raw_log"`
	}
	if err := json.Unmarshal(envelope.Response, &response); err != nil {
		return err
	}
	hash, err := normalizeTxHash(response.Hash)
	if err != nil || hash != expected {
		return fmt.Errorf("committed transaction hash mismatch")
	}
	height, err := strconv.ParseUint(response.Height, 10, 64)
	if err != nil || height == 0 || height > math.MaxInt64 || strconv.FormatUint(height, 10) != response.Height {
		return fmt.Errorf("invalid committed transaction height")
	}
	code, err := explicitTxCode(response.Code)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("%w: code %d: %.4096s", errTxFailed, code, response.RawLog)
	}
	return nil
}

// A bounded, caller-driven observation. The caller retains the returned hash on
// every unknown or failed outcome and never interprets HTTP status as settlement.
func waitForCommittedTx(ctx context.Context, rawHash string) (resultHash string, resultErr error) {
	hash, _, err := waitForCommittedTxTiming(ctx, rawHash)
	return hash, err
}

func waitForCommittedTxTiming(ctx context.Context, rawHash string) (resultHash string, elapsedNS uint64, resultErr error) {
	hash, err := normalizeTxHash(rawHash)
	if err != nil {
		return "", 0, err
	}
	started := time.Now()
	defer func() {
		elapsedNS = uint64(time.Since(started))
		log.Printf("transaction timing tx=%s inclusion_observation_ms=%.3f success=%t", hash, float64(elapsedNS)/float64(time.Millisecond), resultErr == nil)
	}()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 2 * time.Second}
	for {
		if err := ctx.Err(); err != nil {
			return hash, 0, fmt.Errorf("%w: %w", errTxPending, err)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(lcdBase, "/")+"/cosmos/tx/v1beta1/txs/"+hash, nil)
		if err != nil {
			return hash, 0, fmt.Errorf("%w: %w", errTxPending, err)
		}
		resp, err := client.Do(req)
		if err == nil {
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxCommittedTxResponseBytes+1))
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				if readErr != nil || len(body) > maxCommittedTxResponseBytes {
					return hash, 0, fmt.Errorf("%w: transaction response incomplete or exceeds limit", errTxPending)
				}
				err = committedTxResult(body, hash)
				if err == nil || errors.Is(err, errTxFailed) {
					return hash, 0, err
				}
				return hash, 0, fmt.Errorf("%w: %w", errTxPending, err)
			}
		}
		if err := waitTxRetry(ctx, 500*time.Millisecond); err != nil {
			return hash, 0, fmt.Errorf("%w: %w", errTxPending, err)
		}
	}
}

func waitTxRetry(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func submitTxAndWait(ctx context.Context, args ...string) (string, error) {
	return submitTxAndRecord(ctx, nil, args...)
}

// record runs immediately after a broadcast hash is observed, before polling.
// Durable callers also mark their submission intent before invoking the CLI so
// a crash before the hash is recorded remains explicitly pending after restart.
func submitTxAndRecord(ctx context.Context, record func(string) error, args ...string) (string, error) {
	hash, _, err := submitTxAndRecordTiming(ctx, record, args...)
	return hash, err
}

func submitTxAndRecordTiming(ctx context.Context, record func(string) error, args ...string) (string, txSubmissionTiming, error) {
	started := time.Now()
	out, attempts, timingComplete, submitErr := runTxWithRetryTiming(ctx, args...)
	timing := txSubmissionTiming{Attempts: attempts, Complete: timingComplete}
	submissionMs := float64(time.Since(started)) / float64(time.Millisecond)
	body := extractJSONBody(out)
	var response struct {
		Hash      string          `json:"txhash"`
		Code      json.RawMessage `json:"code"`
		RawLog    string          `json:"raw_log"`
		Codespace string          `json:"codespace"`
	}
	decodeErr := validateJSONObject(body)
	if decodeErr == nil {
		decodeErr = json.Unmarshal(body, &response)
	}
	hash, hashErr := normalizeTxHash(response.Hash)
	if hashErr != nil {
		hash, _ = normalizeTxHash(extractTxHash(string(out)))
	}
	// Only the normalized public hash is logged; CLI arguments and output can contain secrets.
	log.Printf("transaction timing tx=%s cli_submission_ms=%.3f cli_success=%t", hash, submissionMs, submitErr == nil)
	code, codeErr := explicitTxCode(response.Code)
	// Cosmos can synthesize this response after the RPC reports an existing
	// mempool transaction. It is still pending, not a rejection authorizing retry.
	mempoolPending := response.Codespace == sdkerrors.RootCodespace && code == sdkerrors.ErrTxInMempoolCache.ABCICode()
	if decodeErr == nil && codeErr == nil && code != 0 && !mempoolPending {
		return hash, timing, fmt.Errorf("%w: code %d: %.4096s", errTxRejected, code, response.RawLog)
	}
	if hash != "" && record != nil {
		if err := record(hash); err != nil {
			return hash, timing, fmt.Errorf("%w: could not persist broadcast hash: %w", errTxPending, err)
		}
	}
	if mempoolPending {
		return hash, timing, fmt.Errorf("%w: transaction already in mempool", errTxPending)
	}
	if hash == "" && errors.Is(submitErr, errTxNotSubmitted) {
		return "", timing, submitErr
	}
	if hash != "" && errors.Is(submitErr, errTxNotSubmitted) {
		// Observed broadcast evidence wins over a contradictory phase report.
		// Do not unwrap the local classification: callers must retain this intent.
		return hash, timing, fmt.Errorf("%w: conflicting CLI phase: %v", errTxPending, submitErr)
	}
	if submitErr != nil {
		return hash, timing, fmt.Errorf("%w: CLI submission: %w", errTxPending, submitErr)
	}
	if decodeErr != nil || codeErr != nil || hash == "" {
		return hash, timing, fmt.Errorf("%w: malformed broadcast response", errTxPending)
	}
	resultHash, elapsed, err := waitForCommittedTxTiming(ctx, hash)
	timing.CommitObservationNS = elapsed
	return resultHash, timing, err
}
