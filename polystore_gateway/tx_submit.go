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

// Only these CLI commands implement the explicit phase contract. Each attempt
// gets its own empty private file, so retry can never reuse an earlier marker.
func execTrackedSubmission(ctx context.Context, args ...string) ([]byte, error) {
	if len(args) < 3 || args[0] != "tx" || (args[2] != "submit-retrieval-proof" && args[2] != "prove-liveness-system" && args[2] != "accept-deal-generation-v3") {
		return execPolystorechaind(ctx, args...)
	}
	file, err := os.CreateTemp("", "polystore-submission-phase-*")
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errTxNotSubmitted, err)
	}
	defer os.Remove(file.Name())
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("%w: %w", errTxNotSubmitted, err)
	}
	command := append(append([]string(nil), args...), "--submission-phase-file", file.Name())
	out, err := execPolystorechaind(ctx, command...)
	if err != nil {
		phase, openErr := os.Open(file.Name())
		if openErr == nil {
			marker, readErr := io.ReadAll(io.LimitReader(phase, 128))
			_ = phase.Close()
			if readErr == nil && string(marker) == "polystore-submission-v1:not-broadcast\n" {
				return out, fmt.Errorf("%w: %w", errTxNotSubmitted, err)
			}
		}
	}
	return out, err
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
	hash, err := normalizeTxHash(rawHash)
	if err != nil {
		return "", err
	}
	started := time.Now()
	defer func() {
		log.Printf("transaction timing tx=%s inclusion_observation_ms=%.3f success=%t", hash, float64(time.Since(started))/float64(time.Millisecond), resultErr == nil)
	}()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	client := &http.Client{Timeout: 2 * time.Second}
	for {
		if err := ctx.Err(); err != nil {
			return hash, fmt.Errorf("%w: %w", errTxPending, err)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(lcdBase, "/")+"/cosmos/tx/v1beta1/txs/"+hash, nil)
		if err != nil {
			return hash, fmt.Errorf("%w: %w", errTxPending, err)
		}
		resp, err := client.Do(req)
		if err == nil {
			body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxCommittedTxResponseBytes+1))
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				if readErr != nil || len(body) > maxCommittedTxResponseBytes {
					return hash, fmt.Errorf("%w: transaction response incomplete or exceeds limit", errTxPending)
				}
				err = committedTxResult(body, hash)
				if err == nil || errors.Is(err, errTxFailed) {
					return hash, err
				}
				return hash, fmt.Errorf("%w: %w", errTxPending, err)
			}
		}
		if err := waitTxRetry(ctx, 500*time.Millisecond); err != nil {
			return hash, fmt.Errorf("%w: %w", errTxPending, err)
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
	started := time.Now()
	out, submitErr := runTxWithRetry(ctx, args...)
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
		return hash, fmt.Errorf("%w: code %d: %.4096s", errTxRejected, code, response.RawLog)
	}
	if hash != "" && record != nil {
		if err := record(hash); err != nil {
			return hash, fmt.Errorf("%w: could not persist broadcast hash: %w", errTxPending, err)
		}
	}
	if mempoolPending {
		return hash, fmt.Errorf("%w: transaction already in mempool", errTxPending)
	}
	if hash == "" && errors.Is(submitErr, errTxNotSubmitted) {
		return "", submitErr
	}
	if hash != "" && errors.Is(submitErr, errTxNotSubmitted) {
		// Observed broadcast evidence wins over a contradictory phase report.
		// Do not unwrap the local classification: callers must retain this intent.
		return hash, fmt.Errorf("%w: conflicting CLI phase: %v", errTxPending, submitErr)
	}
	if submitErr != nil {
		return hash, fmt.Errorf("%w: CLI submission: %w", errTxPending, submitErr)
	}
	if decodeErr != nil || codeErr != nil || hash == "" {
		return hash, fmt.Errorf("%w: malformed broadcast response", errTxPending)
	}
	return waitForCommittedTx(ctx, hash)
}
