package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var errTxPending = errors.New("transaction outcome unknown")
var errTxRejected = errors.New("transaction rejected before inclusion")
var errTxFailed = errors.New("committed transaction failed")

const maxCommittedTxResponseBytes = 4 << 20

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
func waitForCommittedTx(ctx context.Context, rawHash string) (string, error) {
	hash, err := normalizeTxHash(rawHash)
	if err != nil {
		return "", err
	}
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
	out, submitErr := runTxWithRetry(ctx, args...)
	body := extractJSONBody(out)
	var response struct {
		Hash   string          `json:"txhash"`
		Code   json.RawMessage `json:"code"`
		RawLog string          `json:"raw_log"`
	}
	decodeErr := validateJSONObject(body)
	if decodeErr == nil {
		decodeErr = json.Unmarshal(body, &response)
	}
	hash, hashErr := normalizeTxHash(response.Hash)
	if hashErr != nil {
		hash, _ = normalizeTxHash(extractTxHash(string(out)))
	}
	code, codeErr := explicitTxCode(response.Code)
	if decodeErr == nil && codeErr == nil && code != 0 {
		return hash, fmt.Errorf("%w: code %d: %.4096s", errTxRejected, code, response.RawLog)
	}
	if hash != "" && record != nil {
		if err := record(hash); err != nil {
			return hash, fmt.Errorf("%w: could not persist broadcast hash: %w", errTxPending, err)
		}
	}
	if submitErr != nil {
		return hash, fmt.Errorf("%w: CLI submission: %w", errTxPending, submitErr)
	}
	if decodeErr != nil || codeErr != nil || hash == "" {
		return hash, fmt.Errorf("%w: malformed broadcast response", errTxPending)
	}
	return waitForCommittedTx(ctx, hash)
}
