package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

func ensureMode2MduOnDisk(ctx context.Context, dealID uint64, manifestRoot ManifestRoot, mduIndex uint64, dealDir string, stripe stripeParams) (string, error) {
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

	providers, err := fetchDealProvidersFromLCD(ctx, dealID)
	if err != nil {
		return "", err
	}
	if stripe.slotCount == 0 {
		return "", fmt.Errorf("invalid stripe params")
	}
	if len(providers) < int(stripe.slotCount) {
		return "", fmt.Errorf("not enough providers for Mode 2 (need %d, got %d)", stripe.slotCount, len(providers))
	}

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

		base, err := resolveProviderHTTPBaseURL(ctx, providers[slot])
		if err != nil {
			return err
		}
		shardBytes, err := fetchShardFromProvider(ctx, base, dealID, manifestRoot.Canonical, mduIndex, slot)
		if err != nil {
			return err
		}
		if uint64(len(shardBytes)) != expectedShardSize {
			return fmt.Errorf("shard %d has invalid size: %d", slot, len(shardBytes))
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
	for slot := uint64(0); slot < stripe.slotCount && presentCount < stripe.k; slot++ {
		_ = tryLoadSlot(slot)
	}
	if presentCount < stripe.k {
		// Second pass: try all slots to pick up parity shards if earlier ones were missing.
		for slot := uint64(0); slot < stripe.slotCount && presentCount < stripe.k; slot++ {
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

func fetchShardFromProvider(ctx context.Context, baseURL string, dealID uint64, manifestRoot string, mduIndex uint64, slot uint64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/sp/shard", nil)
	if err != nil {
		return nil, err
	}
	q := req.URL.Query()
	q.Set("deal_id", strconv.FormatUint(dealID, 10))
	q.Set("manifest_root", manifestRoot)
	q.Set("mdu_index", strconv.FormatUint(mduIndex, 10))
	q.Set("slot", strconv.FormatUint(slot, 10))
	req.URL.RawQuery = q.Encode()

	resp, err := http.DefaultClient.Do(req)
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
