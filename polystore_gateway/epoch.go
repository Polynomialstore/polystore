package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	epochCacheMu          sync.Mutex
	epochCacheLCDBase     string
	epochLenBlocksCached  uint64
	epochLenBlocksFetched time.Time
	latestHeightCached    uint64
	latestHeightFetched   time.Time
)

func currentEpochID(ctx context.Context) uint64 {
	epochLen, err := cachedEpochLenBlocks(ctx)
	if err != nil || epochLen == 0 {
		return 1
	}

	height, err := cachedLatestHeight(ctx)
	if err != nil || height == 0 {
		return 1
	}

	// 1-indexed: height=1 => epoch 1.
	return ((height - 1) / epochLen) + 1
}

func cachedEpochLenBlocks(ctx context.Context) (uint64, error) {
	const ttl = 30 * time.Second
	base := strings.TrimRight(strings.TrimSpace(lcdBase), "/")
	if base == "" {
		return 0, fmt.Errorf("lcd base is empty")
	}

	epochCacheMu.Lock()
	resetEpochCacheLocked(base)
	if epochLenBlocksCached != 0 && time.Since(epochLenBlocksFetched) < ttl {
		val := epochLenBlocksCached
		epochCacheMu.Unlock()
		return val, nil
	}
	epochCacheMu.Unlock()

	val, err := fetchEpochLenBlocks(ctx, base)
	if err != nil {
		return 0, err
	}

	epochCacheMu.Lock()
	resetEpochCacheLocked(base)
	epochLenBlocksCached = val
	epochLenBlocksFetched = time.Now()
	epochCacheMu.Unlock()
	return val, nil
}

func cachedLatestHeight(ctx context.Context) (uint64, error) {
	const ttl = 2 * time.Second
	base := strings.TrimRight(strings.TrimSpace(lcdBase), "/")
	if base == "" {
		return 0, fmt.Errorf("lcd base is empty")
	}

	epochCacheMu.Lock()
	resetEpochCacheLocked(base)
	if latestHeightCached != 0 && time.Since(latestHeightFetched) < ttl {
		val := latestHeightCached
		epochCacheMu.Unlock()
		return val, nil
	}
	epochCacheMu.Unlock()

	val, err := fetchLatestHeight(ctx, base)
	if err != nil {
		return 0, err
	}

	epochCacheMu.Lock()
	resetEpochCacheLocked(base)
	latestHeightCached = val
	latestHeightFetched = time.Now()
	epochCacheMu.Unlock()
	return val, nil
}

func resetEpochCacheLocked(base string) {
	if epochCacheLCDBase == base {
		return
	}
	epochCacheLCDBase = base
	epochLenBlocksCached = 0
	epochLenBlocksFetched = time.Time{}
	latestHeightCached = 0
	latestHeightFetched = time.Time{}
}

func fetchEpochLenBlocks(ctx context.Context, base string) (uint64, error) {
	url := base + "/polystorechain/polystorechain/v1/params"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("LCD returned %d for params", resp.StatusCode)
	}

	var payload struct {
		Params struct {
			EpochLenBlocks json.RawMessage `json:"epoch_len_blocks"`
		} `json:"params"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, err
	}
	if len(payload.Params.EpochLenBlocks) == 0 {
		return 0, fmt.Errorf("params missing epoch_len_blocks")
	}
	return parseUint64Raw(payload.Params.EpochLenBlocks)
}

func fetchLatestHeight(ctx context.Context, base string) (uint64, error) {
	url := base + "/cosmos/base/tendermint/v1beta1/blocks/latest"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("LCD returned %d for latest block", resp.StatusCode)
	}

	var payload struct {
		Block struct {
			Header struct {
				Height string `json:"height"`
			} `json:"header"`
		} `json:"block"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, err
	}
	heightStr := strings.TrimSpace(payload.Block.Header.Height)
	if heightStr == "" {
		return 0, fmt.Errorf("latest block missing height")
	}
	height, err := strconv.ParseUint(heightStr, 10, 64)
	if err != nil {
		return 0, err
	}
	return height, nil
}

func parseUint64Raw(raw json.RawMessage) (uint64, error) {
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		asString = strings.TrimSpace(asString)
		if asString == "" {
			return 0, fmt.Errorf("empty string")
		}
		return strconv.ParseUint(asString, 10, 64)
	}

	var asUint uint64
	if err := json.Unmarshal(raw, &asUint); err == nil {
		return asUint, nil
	}

	var asFloat float64
	if err := json.Unmarshal(raw, &asFloat); err == nil {
		if asFloat < 0 {
			return 0, fmt.Errorf("negative value")
		}
		return uint64(asFloat), nil
	}

	return 0, fmt.Errorf("invalid uint64")
}
