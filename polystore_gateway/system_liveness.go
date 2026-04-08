package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/blake2s"

	"nilchain/x/crypto_ffi"
	"nilchain/x/nilchain/types"
)

var (
	epochSeedTagBytes     = []byte("nilstore/epoch/v1")
	challengeSeedTagBytes = []byte("nilstore/chal/v1")
	kzgZSeedTagBytes      = []byte("nilstore/kzgz/v1")
)

type systemLivenessParams struct {
	epochLenBlocks uint64
	quotaBpsHot    uint64
	quotaBpsCold   uint64
	quotaMinBlobs  uint64
	quotaMaxBlobs  uint64

	fetchedAt time.Time
	lcdBase   string
}

var (
	systemLivenessParamsMu sync.Mutex
	systemLivenessCached   *systemLivenessParams
)

type systemLivenessState struct {
	mu       sync.Mutex
	epoch    uint64
	done     map[systemLivenessKey]struct{}
	failures map[systemLivenessKey]systemLivenessFailure
	snapshot systemLivenessSnapshot
}

type systemLivenessKey struct {
	dealID  uint64
	slot    uint32
	ordinal uint64
}

type systemLivenessFailureReason string

const (
	systemLivenessFailureUnknown          systemLivenessFailureReason = "unknown"
	systemLivenessFailureMissingLocalData systemLivenessFailureReason = "missing_local_data"
	systemLivenessFailureDealExpired      systemLivenessFailureReason = "deal_expired"
	systemLivenessFailureChainRejected    systemLivenessFailureReason = "chain_rejected"
)

type systemLivenessFailure struct {
	attempt    uint32
	nextRetry  time.Time
	reason     systemLivenessFailureReason
	lastErr    string
	lastUpdate time.Time
}

type systemLivenessSnapshot struct {
	LastRun              time.Time
	LastError            string
	DealsScanned         uint64
	DealsExpired         uint64
	ProofsSubmitted      uint64
	ProofsAlreadyDone    uint64
	ProofsBackoffSkipped uint64
	ProofGenFailures     uint64
	TxFailures           uint64
	MissingDataSkips     uint64
}

const (
	systemLivenessDefaultBackoff       = 30 * time.Second
	systemLivenessMissingDataBackoff   = 3 * time.Minute
	systemLivenessExpiredDealBackoff   = 30 * time.Minute
	systemLivenessChainRejectedBackoff = 2 * time.Minute
	systemLivenessMaxBackoff           = 30 * time.Minute
	systemLivenessFailureGCInterval    = 6 * time.Hour
)

var systemProverState systemLivenessState

func shouldRunSystemLiveness() bool {
	if envDefault("NIL_DISABLE_SYSTEM_LIVENESS", "0") == "1" {
		return false
	}
	return envDefault("NIL_SYSTEM_LIVENESS", "1") == "1"
}

func (s *systemLivenessState) ensureEpoch(epochID uint64, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.epoch != epochID {
		s.epoch = epochID
		s.done = make(map[systemLivenessKey]struct{})
	}
	if s.done == nil {
		s.done = make(map[systemLivenessKey]struct{})
	}
	if s.failures == nil {
		s.failures = make(map[systemLivenessKey]systemLivenessFailure)
	}
	s.gcFailuresLocked(now)
}

func (s *systemLivenessState) gcFailuresLocked(now time.Time) {
	for k, st := range s.failures {
		if st.lastUpdate.IsZero() {
			delete(s.failures, k)
			continue
		}
		if now.Sub(st.lastUpdate) > systemLivenessFailureGCInterval {
			delete(s.failures, k)
		}
	}
}

func (s *systemLivenessState) isDone(key systemLivenessKey) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.done[key]
	return ok
}

func (s *systemLivenessState) markDone(key systemLivenessKey) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done == nil {
		s.done = make(map[systemLivenessKey]struct{})
	}
	s.done[key] = struct{}{}
	delete(s.failures, key)
}

func (s *systemLivenessState) shouldBackoff(key systemLivenessKey, now time.Time) (bool, time.Duration, systemLivenessFailureReason) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failures == nil {
		return false, 0, systemLivenessFailureUnknown
	}
	st, ok := s.failures[key]
	if !ok {
		return false, 0, systemLivenessFailureUnknown
	}
	if !st.nextRetry.After(now) {
		return false, 0, st.reason
	}
	return true, st.nextRetry.Sub(now), st.reason
}

func nextSystemLivenessBackoff(base time.Duration, attempt uint32) time.Duration {
	if base <= 0 {
		base = systemLivenessDefaultBackoff
	}
	if attempt == 0 {
		attempt = 1
	}
	delay := base
	for i := uint32(1); i < attempt; i++ {
		if delay >= systemLivenessMaxBackoff/2 {
			delay = systemLivenessMaxBackoff
			break
		}
		delay *= 2
	}
	if delay > systemLivenessMaxBackoff {
		delay = systemLivenessMaxBackoff
	}
	return delay
}

func classifySystemLivenessError(err error) (systemLivenessFailureReason, time.Duration, bool) {
	if err == nil {
		return systemLivenessFailureUnknown, systemLivenessDefaultBackoff, false
	}
	msg := strings.ToLower(strings.TrimSpace(err.Error()))
	switch {
	case errors.Is(err, os.ErrNotExist),
		strings.Contains(msg, "no such file or directory"),
		strings.Contains(msg, "short read"),
		strings.Contains(msg, "nil_compute_blob_proof failed with code: -3"),
		strings.Contains(msg, "invalid witness commitments length"),
		strings.Contains(msg, "invalid mdu index"):
		return systemLivenessFailureMissingLocalData, systemLivenessMissingDataBackoff, true
	case strings.Contains(msg, "expired at end_block="),
		strings.Contains(msg, "deal expired"):
		return systemLivenessFailureDealExpired, systemLivenessExpiredDealBackoff, true
	case strings.Contains(msg, "invalid request"),
		strings.Contains(msg, "failed to execute message"):
		return systemLivenessFailureChainRejected, systemLivenessChainRejectedBackoff, true
	default:
		return systemLivenessFailureUnknown, systemLivenessDefaultBackoff, false
	}
}

func (s *systemLivenessState) recordFailure(key systemLivenessKey, now time.Time, err error) (systemLivenessFailureReason, time.Duration, uint32, bool) {
	reason, base, expected := classifySystemLivenessError(err)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.failures == nil {
		s.failures = make(map[systemLivenessKey]systemLivenessFailure)
	}
	st := s.failures[key]
	st.attempt++
	delay := nextSystemLivenessBackoff(base, st.attempt)
	st.nextRetry = now.Add(delay)
	st.reason = reason
	st.lastErr = strings.TrimSpace(err.Error())
	st.lastUpdate = now
	s.failures[key] = st
	return reason, delay, st.attempt, expected
}

func (s *systemLivenessState) setSnapshot(snapshot systemLivenessSnapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot = snapshot
}

func systemLivenessSnapshotForStatus() map[string]string {
	systemProverState.mu.Lock()
	s := systemProverState.snapshot
	systemProverState.mu.Unlock()

	out := map[string]string{
		"system_liveness_last_run_unix":          strconv.FormatInt(s.LastRun.Unix(), 10),
		"system_liveness_deals_scanned":          strconv.FormatUint(s.DealsScanned, 10),
		"system_liveness_deals_expired_skipped":  strconv.FormatUint(s.DealsExpired, 10),
		"system_liveness_proofs_submitted":       strconv.FormatUint(s.ProofsSubmitted, 10),
		"system_liveness_proofs_already_done":    strconv.FormatUint(s.ProofsAlreadyDone, 10),
		"system_liveness_proofs_backoff_skipped": strconv.FormatUint(s.ProofsBackoffSkipped, 10),
		"system_liveness_proof_gen_failures":     strconv.FormatUint(s.ProofGenFailures, 10),
		"system_liveness_tx_failures":            strconv.FormatUint(s.TxFailures, 10),
		"system_liveness_missing_data_skips":     strconv.FormatUint(s.MissingDataSkips, 10),
	}
	if s.LastRun.IsZero() {
		out["system_liveness_last_run_unix"] = "0"
	}
	if strings.TrimSpace(s.LastError) != "" {
		out["system_liveness_last_error"] = s.LastError
	}
	return out
}

func isDealExpiredAtHeight(endBlock uint64, currentHeight uint64) bool {
	if endBlock == 0 || currentHeight == 0 {
		return false
	}
	// end_block is exclusive on-chain.
	return currentHeight >= endBlock
}

func startSystemLivenessProver() {
	if !shouldRunSystemLiveness() {
		log.Printf("System liveness prover disabled")
		return
	}

	interval := time.Duration(envInt("NIL_SYSTEM_LIVENESS_INTERVAL_SECONDS", 10)) * time.Second
	if interval < 3*time.Second {
		interval = 3 * time.Second
	}

	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()

		for {
			epochID := currentEpochID(context.Background())
			if epochID == 0 {
				epochID = 1
			}

			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			if err := runSystemLivenessOnce(ctx, epochID); err != nil {
				log.Printf("system liveness tick failed: %v", err)
			}
			cancel()

			<-t.C
		}
	}()
}

func runSystemLivenessOnce(ctx context.Context, epochID uint64) (retErr error) {
	now := time.Now()
	snapshot := systemLivenessSnapshot{LastRun: now}
	defer func() {
		if retErr != nil {
			snapshot.LastError = retErr.Error()
		}
		systemProverState.setSnapshot(snapshot)
	}()

	providerAddr := strings.TrimSpace(cachedProviderAddress(ctx))
	if providerAddr == "" {
		return fmt.Errorf("provider address unavailable")
	}

	params, err := cachedSystemLivenessParams(ctx)
	if err != nil {
		return err
	}
	if params.epochLenBlocks == 0 {
		return nil
	}

	epochSeed, err := fetchEpochSeedFromLCD(ctx, chainID, epochID, params.epochLenBlocks)
	if err != nil {
		return fmt.Errorf("fetch epoch seed: %w", err)
	}

	ids, err := fetchDealIDsFromLCD(ctx)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}

	systemProverState.ensureEpoch(epochID, now)

	currentHeight, err := cachedLatestHeight(ctx)
	if err != nil {
		log.Printf("system liveness: latest height unavailable: %v", err)
		currentHeight = 0
	}

dealLoop:
	for _, dealID := range ids {
		deal, err := fetchDealStateForSystemLiveness(ctx, dealID)
		if err != nil {
			if errors.Is(err, ErrDealNotFound) {
				continue
			}
			log.Printf("system liveness: failed to fetch deal %d: %v", dealID, err)
			continue
		}
		snapshot.DealsScanned++
		if isDealExpiredAtHeight(deal.endBlock, currentHeight) {
			snapshot.DealsExpired++
			continue
		}

		if deal.redundancyMode != 2 || deal.manifestRoot.Canonical == "" {
			continue
		}
		if deal.totalMdus == 0 {
			continue
		}

		metaMdus, userMdus, ok := quotaInputsForDeal(deal.totalMdus, deal.witnessMdus)
		if !ok || userMdus == 0 {
			continue
		}

		stripe, err := stripeParamsFromHint(deal.serviceHint)
		if err != nil || stripe.mode != 2 || stripe.rows == 0 || stripe.leafCount == 0 {
			continue
		}

		dealDir := dealScopedDir(deal.dealID, deal.manifestRoot)
		manifestPath := filepath.Join(dealDir, "manifest.bin")
		if _, err := os.Stat(manifestPath); err != nil {
			continue
		}

		for slotIdx, slot := range deal.mode2Slots {
			slotU := uint32(slotIdx)
			if slot.Status == 0 {
				continue
			}

			local := false
			if strings.TrimSpace(slot.Provider) == providerAddr {
				local = true
			}
			if !local && strings.TrimSpace(slot.PendingProvider) == providerAddr {
				local = true
			}
			if !local {
				continue
			}

			quota := requiredBlobsMode2Local(params, deal.serviceHint, stripe, userMdus)
			if quota == 0 {
				continue
			}

			for ordinal := uint64(0); ordinal < quota; ordinal++ {
				key := systemLivenessKey{dealID: deal.dealID, slot: slotU, ordinal: ordinal}
				if systemProverState.isDone(key) {
					snapshot.ProofsAlreadyDone++
					continue
				}
				if blocked, _, reason := systemProverState.shouldBackoff(key, now); blocked {
					snapshot.ProofsBackoffSkipped++
					if reason == systemLivenessFailureMissingLocalData {
						snapshot.MissingDataSkips++
					}
					continue
				}

				mduIndex, blobIndex := deriveMode2ChallengeLocal(epochSeed, deal.dealID, deal.currentGen, uint64(slotU), ordinal, metaMdus, userMdus, stripe.rows)
				proof, err := generateSystemChainedProof(ctx, epochSeed, deal.dealID, dealDir, manifestPath, stripe, mduIndex, blobIndex)
				if err != nil {
					reason, retryIn, attempt, expected := systemProverState.recordFailure(key, now, err)
					snapshot.ProofGenFailures++
					if reason == systemLivenessFailureMissingLocalData {
						snapshot.MissingDataSkips++
					}
					if reason == systemLivenessFailureDealExpired {
						snapshot.DealsExpired++
						continue dealLoop
					}
					if expected {
						log.Printf("system liveness: expected skip deal=%d slot=%d ord=%d reason=%s attempt=%d retry_in=%s: %v", deal.dealID, slotU, ordinal, reason, attempt, retryIn.Round(time.Second), err)
					} else {
						log.Printf("system liveness: proof gen failed deal=%d slot=%d ord=%d attempt=%d retry_in=%s: %v", deal.dealID, slotU, ordinal, attempt, retryIn.Round(time.Second), err)
					}
					continue
				}

				tmp, err := os.CreateTemp(uploadDir, "system-proof-*.json")
				if err != nil {
					return err
				}
				tmpPath := tmp.Name()
				if err := json.NewEncoder(tmp).Encode(proof); err != nil {
					tmp.Close()
					_ = os.Remove(tmpPath)
					return err
				}
				_ = tmp.Close()

				txCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
				_, err = submitTxAndWait(
					txCtx,
					"tx", "nilchain", "prove-liveness-system",
					strconv.FormatUint(deal.dealID, 10),
					strconv.FormatUint(epochID, 10),
					tmpPath,
					"--from", envDefault("NIL_PROVIDER_KEY", "faucet"),
					"--chain-id", chainID,
					"--home", homeDir,
					"--keyring-backend", "test",
					"--yes",
					"--gas", "auto",
					"--gas-adjustment", "1.6",
					"--gas-prices", gasPrices,
				)
				cancel()
				_ = os.Remove(tmpPath)
				if err != nil {
					reason, retryIn, attempt, expected := systemProverState.recordFailure(key, now, err)
					snapshot.TxFailures++
					if reason == systemLivenessFailureDealExpired {
						snapshot.DealsExpired++
						continue dealLoop
					}
					if expected {
						log.Printf("system liveness: expected tx skip deal=%d slot=%d ord=%d reason=%s attempt=%d retry_in=%s: %v", deal.dealID, slotU, ordinal, reason, attempt, retryIn.Round(time.Second), err)
					} else {
						log.Printf("system liveness: tx failed deal=%d slot=%d ord=%d attempt=%d retry_in=%s: %v", deal.dealID, slotU, ordinal, attempt, retryIn.Round(time.Second), err)
					}
					continue
				}

				systemProverState.markDone(key)
				snapshot.ProofsSubmitted++
			}
		}
	}

	return nil
}

func cachedSystemLivenessParams(ctx context.Context) (*systemLivenessParams, error) {
	const ttl = 30 * time.Second
	base := strings.TrimRight(strings.TrimSpace(lcdBase), "/")
	if base == "" {
		return nil, fmt.Errorf("lcd base is empty")
	}

	systemLivenessParamsMu.Lock()
	if systemLivenessCached != nil && systemLivenessCached.lcdBase == base && time.Since(systemLivenessCached.fetchedAt) < ttl {
		cp := *systemLivenessCached
		systemLivenessParamsMu.Unlock()
		return &cp, nil
	}
	systemLivenessParamsMu.Unlock()

	val, err := fetchSystemLivenessParams(ctx, base)
	if err != nil {
		return nil, err
	}

	systemLivenessParamsMu.Lock()
	systemLivenessCached = &val
	systemLivenessParamsMu.Unlock()

	cp := val
	return &cp, nil
}

func fetchSystemLivenessParams(ctx context.Context, base string) (systemLivenessParams, error) {
	url := base + "/nilchain/nilchain/v1/params"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return systemLivenessParams{}, err
	}
	client := http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return systemLivenessParams{}, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return systemLivenessParams{}, fmt.Errorf("LCD returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload struct {
		Params map[string]json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return systemLivenessParams{}, err
	}

	get := func(key string) uint64 {
		raw := payload.Params[key]
		if len(raw) == 0 {
			return 0
		}
		val, err := parseUint64Raw(raw)
		if err != nil {
			return 0
		}
		return val
	}

	return systemLivenessParams{
		epochLenBlocks: get("epoch_len_blocks"),
		quotaBpsHot:    get("quota_bps_per_epoch_hot"),
		quotaBpsCold:   get("quota_bps_per_epoch_cold"),
		quotaMinBlobs:  get("quota_min_blobs"),
		quotaMaxBlobs:  get("quota_max_blobs"),
		fetchedAt:      time.Now(),
		lcdBase:        base,
	}, nil
}

func fetchEpochSeedFromLCD(ctx context.Context, chainID string, epochID uint64, epochLen uint64) ([32]byte, error) {
	var seed [32]byte
	if epochID == 0 || epochLen == 0 {
		return seed, fmt.Errorf("invalid epoch params")
	}

	startHeight := ((epochID - 1) * epochLen) + 1
	url := fmt.Sprintf("%s/cosmos/base/tendermint/v1beta1/blocks/%d", strings.TrimRight(lcdBase, "/"), startHeight)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := lcdHTTPClient.Do(req)
	if err != nil {
		return seed, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return seed, fmt.Errorf("LCD returned %d for block %d: %s", resp.StatusCode, startHeight, strings.TrimSpace(string(body)))
	}

	var payload struct {
		BlockId struct {
			Hash string `json:"hash"`
		} `json:"block_id"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return seed, err
	}

	hashHex := strings.TrimSpace(payload.BlockId.Hash)
	if hashHex == "" {
		return seed, fmt.Errorf("missing block_id.hash")
	}
	hashBytes, err := decodeBlockHashBytes(hashHex)
	if err != nil {
		return seed, fmt.Errorf("invalid block_id.hash: %w", err)
	}

	buf := make([]byte, 0, len(epochSeedTagBytes)+len(chainID)+8+len(hashBytes))
	buf = append(buf, epochSeedTagBytes...)
	buf = append(buf, []byte(chainID)...)
	buf = binary.BigEndian.AppendUint64(buf, epochID)
	buf = append(buf, hashBytes...)
	return sha256.Sum256(buf), nil
}

func decodeBlockHashBytes(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("empty")
	}

	trimmed := strings.TrimPrefix(raw, "0x")
	if decoded, err := base64.StdEncoding.DecodeString(trimmed); err == nil && len(decoded) > 0 {
		return decoded, nil
	}
	if decoded, err := hex.DecodeString(trimmed); err == nil && len(decoded) > 0 {
		return decoded, nil
	}
	return nil, fmt.Errorf("unsupported encoding")
}

type dealStateForSystemLiveness struct {
	dealID          uint64
	manifestRoot    ManifestRoot
	serviceHint     string
	redundancyMode  uint32
	endBlock        uint64
	currentGen      uint64
	totalMdus       uint64
	witnessMdus     uint64
	mode2Slots      []mode2SlotAssignment
	parsedManifests bool
}

func fetchDealStateForSystemLiveness(ctx context.Context, dealID uint64) (*dealStateForSystemLiveness, error) {
	url := fmt.Sprintf("%s/nilchain/nilchain/v1/deals/%d", strings.TrimRight(lcdBase, "/"), dealID)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := lcdHTTPClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrDealNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("LCD returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	type dealSlot struct {
		Slot            json.RawMessage `json:"slot"`
		Provider        string          `json:"provider"`
		PendingProvider string          `json:"pending_provider"`
		Status          json.RawMessage `json:"status"`
	}

	var payload struct {
		Deal struct {
			ServiceHint    string          `json:"service_hint"`
			RedundancyMode json.RawMessage `json:"redundancy_mode"`
			EndBlock       json.RawMessage `json:"end_block"`
			EndBlockAlt    json.RawMessage `json:"endBlock"`
			CurrentGen     json.RawMessage `json:"current_gen"`
			TotalMdus      json.RawMessage `json:"total_mdus"`
			WitnessMdus    json.RawMessage `json:"witness_mdus"`
			ManifestRoot   string          `json:"manifest_root"`
			Slots          []dealSlot      `json:"mode2_slots"`
		} `json:"deal"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}

	out := &dealStateForSystemLiveness{dealID: dealID}
	out.serviceHint = strings.TrimSpace(payload.Deal.ServiceHint)
	out.redundancyMode = uint32(mustParseUint64Raw(payload.Deal.RedundancyMode))
	out.endBlock = mustParseUint64Raw(payload.Deal.EndBlock)
	if out.endBlock == 0 {
		out.endBlock = mustParseUint64Raw(payload.Deal.EndBlockAlt)
	}
	out.currentGen = mustParseUint64Raw(payload.Deal.CurrentGen)
	out.totalMdus = mustParseUint64Raw(payload.Deal.TotalMdus)
	out.witnessMdus = mustParseUint64Raw(payload.Deal.WitnessMdus)

	if strings.TrimSpace(payload.Deal.ManifestRoot) != "" {
		parsed, err := parseManifestRootFromLCD(payload.Deal.ManifestRoot)
		if err == nil {
			out.manifestRoot = parsed
		}
	}

	if len(payload.Deal.Slots) > 0 {
		maxSlot := uint32(0)
		seen := make(map[uint32]struct{}, len(payload.Deal.Slots))
		for _, s := range payload.Deal.Slots {
			slotU := uint32(mustParseUint64Raw(s.Slot))
			if _, ok := seen[slotU]; ok {
				continue
			}
			seen[slotU] = struct{}{}
			if slotU > maxSlot {
				maxSlot = slotU
			}
		}

		mode2 := make([]mode2SlotAssignment, maxSlot+1)
		for _, s := range payload.Deal.Slots {
			slotU := uint32(mustParseUint64Raw(s.Slot))
			mode2[slotU] = mode2SlotAssignment{
				Provider:        strings.TrimSpace(s.Provider),
				PendingProvider: strings.TrimSpace(s.PendingProvider),
				Status:          parseMode2SlotStatus(s.Status),
			}
		}
		out.mode2Slots = mode2
	}

	return out, nil
}

func parseManifestRootFromLCD(raw string) (ManifestRoot, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ManifestRoot{}, ErrInvalidManifestRoot
	}
	if strings.HasPrefix(raw, "0x") {
		return parseManifestRoot(raw)
	}
	if decoded, err := base64.StdEncoding.DecodeString(raw); err == nil && len(decoded) > 0 {
		return parseManifestRoot("0x" + hex.EncodeToString(decoded))
	}
	if _, err := decodeHex(raw); err == nil {
		return parseManifestRoot("0x" + strings.TrimPrefix(raw, "0x"))
	}
	return ManifestRoot{}, ErrInvalidManifestRoot
}

func mustParseUint64Raw(raw json.RawMessage) uint64 {
	raw = bytesTrimSpace(raw)
	if len(raw) == 0 {
		return 0
	}
	v, err := parseUint64Raw(raw)
	if err != nil {
		return 0
	}
	return v
}

func bytesTrimSpace(b []byte) []byte {
	return []byte(strings.TrimSpace(string(b)))
}

func quotaInputsForDeal(totalMdus uint64, witnessMdus uint64) (metaMdus uint64, userMdus uint64, ok bool) {
	meta := uint64(1)
	if witnessMdus > 0 {
		meta += witnessMdus
	}
	if totalMdus == 0 || totalMdus <= meta {
		return 0, 0, false
	}
	return meta, totalMdus - meta, true
}

func requiredBlobsMode2Local(params *systemLivenessParams, serviceHint string, stripe stripeParams, userMdus uint64) uint64 {
	info, err := types.ParseServiceHint(serviceHint)
	quotaBps := uint64(0)
	if err == nil && strings.EqualFold(strings.TrimSpace(info.Base), "Hot") {
		quotaBps = params.quotaBpsHot
	}
	if quotaBps == 0 {
		quotaBps = params.quotaBpsCold
	}
	if quotaBps == 0 {
		return 0
	}

	slotBytes := userMdus * stripe.rows * uint64(types.BLOB_SIZE)
	return requiredBlobsFromSlotBytesLocal(params, quotaBps, slotBytes)
}

func requiredBlobsFromSlotBytesLocal(params *systemLivenessParams, quotaBps uint64, slotBytes uint64) uint64 {
	if slotBytes == 0 || quotaBps == 0 {
		return 0
	}
	targetBytes := mulDivCeilLocal(slotBytes, quotaBps, 10000)
	if targetBytes == 0 {
		targetBytes = 1
	}
	targetBlobs := divCeilLocal(targetBytes, uint64(types.BLOB_SIZE))
	if targetBlobs == 0 {
		targetBlobs = 1
	}

	quota := targetBlobs
	if params.quotaMinBlobs > 0 && quota < params.quotaMinBlobs {
		quota = params.quotaMinBlobs
	}
	if params.quotaMaxBlobs > 0 && quota > params.quotaMaxBlobs {
		quota = params.quotaMaxBlobs
	}
	return quota
}

func mulDivCeilLocal(a uint64, b uint64, denom uint64) uint64 {
	if a == 0 || b == 0 || denom == 0 {
		return 0
	}
	prod, overflow := mulUint64Local(a, b)
	if overflow {
		return ^uint64(0)
	}
	return divCeilLocal(prod, denom)
}

func mulUint64Local(a, b uint64) (uint64, bool) {
	if a == 0 || b == 0 {
		return 0, false
	}
	c := a * b
	if c/b != a {
		return 0, true
	}
	return c, false
}

func divCeilLocal(num uint64, denom uint64) uint64 {
	if denom == 0 {
		return 0
	}
	q := num / denom
	if num%denom == 0 {
		return q
	}
	return q + 1
}

func deriveMode2ChallengeLocal(seed [32]byte, dealID uint64, currentGen uint64, slot uint64, ordinal uint64, metaMdus uint64, userMdus uint64, rows uint64) (uint64, uint32) {
	buf := make([]byte, 0, len(challengeSeedTagBytes)+32+8*4)
	buf = append(buf, challengeSeedTagBytes...)
	buf = append(buf, seed[:]...)
	buf = binary.BigEndian.AppendUint64(buf, dealID)
	buf = binary.BigEndian.AppendUint64(buf, currentGen)
	buf = binary.BigEndian.AppendUint64(buf, slot)
	buf = binary.BigEndian.AppendUint64(buf, ordinal)
	h := sha256.Sum256(buf)

	mduOrdinal := binary.BigEndian.Uint64(h[0:8]) % userMdus
	row := binary.BigEndian.Uint64(h[8:16]) % rows

	mduIndex := metaMdus + mduOrdinal
	leafIndex := slot*rows + row
	return mduIndex, uint32(leafIndex)
}

func deriveKzgZ(seed [32]byte, dealID uint64, mduIndex uint64, blobIndex uint32) []byte {
	buf := make([]byte, 0, len(kzgZSeedTagBytes)+32+8+8+4)
	buf = append(buf, kzgZSeedTagBytes...)
	buf = append(buf, seed[:]...)
	buf = binary.BigEndian.AppendUint64(buf, dealID)
	buf = binary.BigEndian.AppendUint64(buf, mduIndex)
	buf = binary.BigEndian.AppendUint32(buf, blobIndex)
	sum := sha256.Sum256(buf)
	out := make([]byte, 32)
	copy(out, sum[:])
	return out
}

func generateSystemChainedProof(ctx context.Context, epochSeed [32]byte, dealID uint64, dealDir string, manifestPath string, stripe stripeParams, mduIndex uint64, blobIndex uint32) (*types.ChainedProof, error) {
	manifestBlob, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}
	if len(manifestBlob) != types.BLOB_SIZE {
		return nil, fmt.Errorf("invalid manifest size: %d", len(manifestBlob))
	}

	meta, err := loadSlabIndex(dealDir)
	if err != nil {
		return nil, err
	}
	if mduIndex <= meta.witnessCount {
		return nil, fmt.Errorf("invalid mdu index %d for user data (witness=%d)", mduIndex, meta.witnessCount)
	}
	userOrdinal := mduIndex - (1 + meta.witnessCount)

	leafCount := stripe.leafCount
	if leafCount == 0 {
		return nil, fmt.Errorf("leaf_count must be > 0")
	}
	if uint64(blobIndex) >= leafCount {
		return nil, fmt.Errorf("blob_index out of range: %d", blobIndex)
	}

	const commitmentBytes = 48
	commitmentSpan := leafCount * commitmentBytes
	startOffset := userOrdinal * commitmentSpan

	witnessReader, err := newNilfsDecodedReader(dealDir, 1, startOffset, commitmentSpan, startOffset, commitmentSpan)
	if err != nil {
		return nil, err
	}
	witnessRaw, err := io.ReadAll(witnessReader)
	_ = witnessReader.Close()
	if err != nil {
		return nil, err
	}
	if uint64(len(witnessRaw)) != commitmentSpan {
		return nil, fmt.Errorf("invalid witness commitments length: got %d want %d", len(witnessRaw), commitmentSpan)
	}

	commitmentOffset := int(blobIndex) * commitmentBytes
	blobCommitment := witnessRaw[commitmentOffset : commitmentOffset+commitmentBytes]

	leafHashes := make([][32]byte, 0, int(leafCount))
	for i := 0; i < len(witnessRaw); i += commitmentBytes {
		sum := blake2s.Sum256(witnessRaw[i : i+commitmentBytes])
		leafHashes = append(leafHashes, sum)
	}
	root, merklePath := merkleRootAndPath(leafHashes, int(blobIndex))

	if stripe.mode != 2 || stripe.rows == 0 {
		return nil, fmt.Errorf("invalid stripe params for mode2 proof")
	}
	slot := uint64(blobIndex) / stripe.rows
	row := uint64(blobIndex) % stripe.rows
	shardPath := filepath.Join(dealDir, fmt.Sprintf("mdu_%d_slot_%d.bin", mduIndex, slot))
	blobBytes, err := readShardBlob(shardPath, row)
	if err != nil {
		return nil, err
	}

	z := deriveKzgZ(epochSeed, dealID, mduIndex, blobIndex)
	kzgProofBytes, y, err := crypto_ffi.ComputeBlobProof(blobBytes, z)
	if err != nil {
		return nil, err
	}

	manifestProof, _, err := crypto_ffi.ComputeManifestProof(manifestBlob, mduIndex)
	if err != nil {
		return nil, err
	}

	return &types.ChainedProof{
		MduIndex:        mduIndex,
		MduRootFr:       root,
		ManifestOpening: manifestProof,
		BlobCommitment:  blobCommitment,
		MerklePath:      merklePath,
		BlobIndex:       blobIndex,
		ZValue:          z,
		YValue:          y,
		KzgOpeningProof: kzgProofBytes,
	}, nil
}

func readShardBlob(path string, row uint64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	offset := int64(row) * int64(types.BLOB_SIZE)
	buf := make([]byte, types.BLOB_SIZE)
	n, err := f.ReadAt(buf, offset)
	if err != nil && n != len(buf) {
		return nil, err
	}
	if n != len(buf) {
		return nil, fmt.Errorf("short read")
	}
	return buf, nil
}
