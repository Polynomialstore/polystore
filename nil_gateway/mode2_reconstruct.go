package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
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

var mode2ReconstructStats struct {
	localShardHits            uint64
	assignedProviderAttempts  uint64
	assignedProviderFailures  uint64
	fallbackProviderAttempts  uint64
	fallbackProviderSuccesses uint64
	fallbackProviderFailures  uint64
	notEnoughShardsFailures   uint64
}

func mode2ReconstructSnapshotForStatus() map[string]string {
	return map[string]string{
		"mode2_reconstruct_local_shard_hits":            strconv.FormatUint(atomic.LoadUint64(&mode2ReconstructStats.localShardHits), 10),
		"mode2_reconstruct_assigned_provider_attempts":  strconv.FormatUint(atomic.LoadUint64(&mode2ReconstructStats.assignedProviderAttempts), 10),
		"mode2_reconstruct_assigned_provider_failures":  strconv.FormatUint(atomic.LoadUint64(&mode2ReconstructStats.assignedProviderFailures), 10),
		"mode2_reconstruct_fallback_provider_attempts":  strconv.FormatUint(atomic.LoadUint64(&mode2ReconstructStats.fallbackProviderAttempts), 10),
		"mode2_reconstruct_fallback_provider_successes": strconv.FormatUint(atomic.LoadUint64(&mode2ReconstructStats.fallbackProviderSuccesses), 10),
		"mode2_reconstruct_fallback_provider_failures":  strconv.FormatUint(atomic.LoadUint64(&mode2ReconstructStats.fallbackProviderFailures), 10),
		"mode2_reconstruct_not_enough_shards_failures":  strconv.FormatUint(atomic.LoadUint64(&mode2ReconstructStats.notEnoughShardsFailures), 10),
	}
}

func resetMode2ReconstructStatsForTest() {
	atomic.StoreUint64(&mode2ReconstructStats.localShardHits, 0)
	atomic.StoreUint64(&mode2ReconstructStats.assignedProviderAttempts, 0)
	atomic.StoreUint64(&mode2ReconstructStats.assignedProviderFailures, 0)
	atomic.StoreUint64(&mode2ReconstructStats.fallbackProviderAttempts, 0)
	atomic.StoreUint64(&mode2ReconstructStats.fallbackProviderSuccesses, 0)
	atomic.StoreUint64(&mode2ReconstructStats.fallbackProviderFailures, 0)
	atomic.StoreUint64(&mode2ReconstructStats.notEnoughShardsFailures, 0)
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

	allKnownProviders := mode2FallbackProviders(slots)
	if legacyProviders, lerr := fetchDealProvidersFromLCD(ctx, dealID); lerr == nil {
		seen := make(map[string]struct{}, len(allKnownProviders))
		for _, p := range allKnownProviders {
			seen[p] = struct{}{}
		}
		for _, p := range legacyProviders {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			if _, ok := seen[p]; ok {
				continue
			}
			seen[p] = struct{}{}
			allKnownProviders = append(allKnownProviders, p)
		}
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
			atomic.AddUint64(&mode2ReconstructStats.localShardHits, 1)
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
		tried := make(map[string]struct{}, len(providers)+len(allKnownProviders))
		usedFallbackProvider := false

		tryProvider := func(provider string, fallback bool) {
			provider = strings.TrimSpace(provider)
			if provider == "" {
				return
			}
			if _, ok := tried[provider]; ok {
				return
			}
			tried[provider] = struct{}{}
			if fallback {
				atomic.AddUint64(&mode2ReconstructStats.fallbackProviderAttempts, 1)
			} else {
				atomic.AddUint64(&mode2ReconstructStats.assignedProviderAttempts, 1)
			}
			base, err := resolveProviderHTTPBaseURL(ctx, provider)
			if err != nil {
				lastErr = err
				if fallback {
					atomic.AddUint64(&mode2ReconstructStats.fallbackProviderFailures, 1)
				} else {
					atomic.AddUint64(&mode2ReconstructStats.assignedProviderFailures, 1)
				}
				return
			}
			shardBytes, err = fetchShardFromProvider(ctx, base, dealID, manifestRoot.Canonical, mduIndex, slot, sessionID)
			if err != nil {
				lastErr = err
				shardBytes = nil
				if fallback {
					atomic.AddUint64(&mode2ReconstructStats.fallbackProviderFailures, 1)
				} else {
					atomic.AddUint64(&mode2ReconstructStats.assignedProviderFailures, 1)
				}
				return
			}
			if uint64(len(shardBytes)) != expectedShardSize {
				lastErr = fmt.Errorf("shard %d has invalid size: %d", slot, len(shardBytes))
				shardBytes = nil
				if fallback {
					atomic.AddUint64(&mode2ReconstructStats.fallbackProviderFailures, 1)
				} else {
					atomic.AddUint64(&mode2ReconstructStats.assignedProviderFailures, 1)
				}
				return
			}
			if fallback {
				atomic.AddUint64(&mode2ReconstructStats.fallbackProviderSuccesses, 1)
				usedFallbackProvider = true
			}
		}

		for _, provider := range providers {
			tryProvider(provider, false)
			if shardBytes != nil {
				break
			}
		}

		// Recovery fallback: during repairing/migration windows, shard placement can lag
		// the current slot assignment. Probe all known deal providers before failing.
		if shardBytes == nil {
			for _, provider := range allKnownProviders {
				tryProvider(provider, true)
				if shardBytes != nil {
					break
				}
			}
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
		if usedFallbackProvider {
			log.Printf("mode2 reconstruct fallback: deal=%d mdu=%d slot=%d used_non_assigned_provider=true", dealID, mduIndex, slot)
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
		atomic.AddUint64(&mode2ReconstructStats.notEnoughShardsFailures, 1)
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
	req.Header.Set(gatewayAuthHeader, gatewayToProviderAuthToken())
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

func mode2FallbackProviders(slots []mode2SlotAssignment) []string {
	out := make([]string, 0, len(slots)*2)
	seen := make(map[string]struct{}, len(slots)*2)
	appendProvider := func(provider string) {
		provider = strings.TrimSpace(provider)
		if provider == "" {
			return
		}
		if _, ok := seen[provider]; ok {
			return
		}
		seen[provider] = struct{}{}
		out = append(out, provider)
	}

	for _, slot := range slots {
		if slot.Status == 2 {
			appendProvider(slot.PendingProvider)
			appendProvider(slot.Provider)
			continue
		}
		appendProvider(slot.Provider)
		appendProvider(slot.PendingProvider)
	}
	return out
}
