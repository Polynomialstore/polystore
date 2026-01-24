package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

var mode2ShardHTTPClient = &http.Client{
	Transport: &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   3 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   3 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 8 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          128,
		MaxIdleConnsPerHost:   16,
	},
	Timeout: 30 * time.Second,
}

func ensureMode2MduOnDisk(ctx context.Context, dealID uint64, manifestRoot ManifestRoot, mduIndex uint64, dealDir string, stripe stripeParams, sessionID string) (string, error) {
	path := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", mduIndex))
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	if stripe.mode != 2 {
		return "", os.ErrNotExist
	}
	if stripe.k == 0 || stripe.rows == 0 {
		return "", fmt.Errorf("invalid stripe params")
	}

	if stripe.slotCount == 0 {
		return "", fmt.Errorf("invalid stripe params")
	}
	slots, err := resolveDealMode2Slots(ctx, dealID)
	if err != nil {
		return "", err
	}
	if len(slots) < int(stripe.slotCount) {
		return "", fmt.Errorf("not enough slot assignments for Mode 2 (need %d, got %d)", stripe.slotCount, len(slots))
	}

	activeSlots := make([]uint64, 0, stripe.slotCount)
	unknownSlots := make([]uint64, 0, stripe.slotCount)
	repairingSlots := make([]uint64, 0, stripe.slotCount)
	for slot := uint64(0); slot < stripe.slotCount; slot++ {
		switch slots[slot].Status {
		case 1:
			activeSlots = append(activeSlots, slot)
		case 2:
			repairingSlots = append(repairingSlots, slot)
		default:
			unknownSlots = append(unknownSlots, slot)
		}
	}
	orderedSlots := make([]uint64, 0, stripe.slotCount)
	orderedSlots = append(orderedSlots, activeSlots...)
	orderedSlots = append(orderedSlots, unknownSlots...)
	orderedSlots = append(orderedSlots, repairingSlots...)

	shards := make([][]byte, stripe.slotCount)
	present := make([]bool, stripe.slotCount)
	presentCount := uint64(0)
	expectedShardSize := stripe.rows * uint64(types.BLOB_SIZE)

	tryLoadSlot := func(slot uint64) error {
		localPath := filepath.Join(dealDir, fmt.Sprintf("mdu_%d_slot_%d.bin", mduIndex, slot))
		if localBytes, err := os.ReadFile(localPath); err == nil && uint64(len(localBytes)) == expectedShardSize {
			shards[slot] = localBytes
			if !present[slot] {
				present[slot] = true
				presentCount++
			}
			return nil
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}

		assign := slots[slot]
		providers := make([]string, 0, 2)
		if assign.Status == 2 {
			// Route reads around repairing slots: prefer the pending provider, and only fall
			// back to the outgoing provider when necessary.
			if p := strings.TrimSpace(assign.PendingProvider); p != "" {
				providers = append(providers, p)
			}
		}
		if p := strings.TrimSpace(assign.Provider); p != "" {
			providers = append(providers, p)
		}
		if len(providers) == 0 {
			return fmt.Errorf("slot %d has no provider assignments", slot)
		}

		var shardBytes []byte
		var lastErr error
		for _, provider := range providers {
			base, err := resolveProviderHTTPBaseURL(ctx, provider)
			if err != nil {
				lastErr = err
				continue
			}
			shardBytes, err = fetchShardFromProvider(ctx, base, dealID, manifestRoot.Canonical, mduIndex, slot, sessionID)
			if err != nil {
				lastErr = err
				continue
			}
			if uint64(len(shardBytes)) != expectedShardSize {
				lastErr = fmt.Errorf("shard %d has invalid size: %d", slot, len(shardBytes))
				shardBytes = nil
				continue
			}
			break
		}
		if shardBytes == nil {
			if lastErr != nil {
				return lastErr
			}
			return fmt.Errorf("shard fetch failed for slot %d", slot)
		}
		shards[slot] = shardBytes
		if !present[slot] {
			present[slot] = true
			presentCount++
		}
		_ = os.WriteFile(localPath, shardBytes, 0o644)
		return nil
	}

	// Prefer local shards first. Fetch remote shards until we have >=K present.
	for _, slot := range orderedSlots {
		if presentCount >= stripe.k {
			break
		}
		_ = tryLoadSlot(slot)
	}
	if presentCount < stripe.k {
		// Second pass: try all slots to pick up parity shards if earlier ones were missing.
		for _, slot := range orderedSlots {
			if presentCount >= stripe.k {
				break
			}
			if present[slot] {
				continue
			}
			_ = tryLoadSlot(slot)
		}
	}
	if presentCount < stripe.k {
		return "", fmt.Errorf("not enough shards available for reconstruction (need %d, got %d)", stripe.k, presentCount)
	}

	mduBytes, err := crypto_ffi.ReconstructMduRs(shards, present, stripe.k, stripe.m)
	if err != nil {
		return "", err
	}

	tmp, err := os.CreateTemp(dealDir, fmt.Sprintf("mdu_%d_*.bin", mduIndex))
	if err != nil {
		return "", err
	}
	if _, err := tmp.Write(mduBytes); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", err
	}
	return path, nil
}

func fetchShardFromProvider(ctx context.Context, baseURL string, dealID uint64, manifestRoot string, mduIndex uint64, slot uint64, sessionID string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/sp/shard", nil)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(sessionID) != "" {
		req.Header.Set("X-Nil-Session-Id", sessionID)
	}
	q := req.URL.Query()
	q.Set("deal_id", strconv.FormatUint(dealID, 10))
	q.Set("manifest_root", manifestRoot)
	q.Set("mdu_index", strconv.FormatUint(mduIndex, 10))
	q.Set("slot", strconv.FormatUint(slot, 10))
	req.URL.RawQuery = q.Encode()

	resp, err := mode2ShardHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("shard fetch failed: %s", string(body))
	}
	return io.ReadAll(resp.Body)
}

func reconstructMduFromDataShards(shards [][]byte, dataShards uint64, rows uint64) ([]byte, error) {
	if dataShards == 0 || rows == 0 {
		return nil, fmt.Errorf("invalid stripe params")
	}
	expectedShardSize := rows * uint64(types.BLOB_SIZE)
	for i, shard := range shards {
		if uint64(len(shard)) != expectedShardSize {
			return nil, fmt.Errorf("shard %d has invalid size: %d", i, len(shard))
		}
	}

	mdu := make([]byte, types.MDU_SIZE)
	for row := uint64(0); row < rows; row++ {
		rowOffset := row * uint64(types.BLOB_SIZE)
		for slot := uint64(0); slot < dataShards; slot++ {
			blobIndex := row*dataShards + slot
			dst := blobIndex * uint64(types.BLOB_SIZE)
			copy(mdu[dst:dst+uint64(types.BLOB_SIZE)], shards[slot][rowOffset:rowOffset+uint64(types.BLOB_SIZE)])
		}
	}
	return mdu, nil
}
