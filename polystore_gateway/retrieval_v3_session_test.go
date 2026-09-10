package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	cosmosmath "cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	bolt "go.etcd.io/bbolt"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func frozenSessionV3Fixture(t testing.TB, rangeLength, userMDUs uint64) (*types.QueryGetRetrievalSessionV3Response, uint64) {
	return frozenSessionV3FixtureRange(t, 0, rangeLength, userMDUs)
}

func frozenSessionV3FixtureRange(t testing.TB, rangeStart, rangeLength, userMDUs uint64) (*types.QueryGetRetrievalSessionV3Response, uint64) {
	t.Helper()
	oldChain := chainID
	chainID = "polystore-test-1"
	t.Cleanup(func() { chainID = oldChain })
	setup, err := hex.DecodeString(types.RetrievalSetupDigest)
	if err != nil {
		t.Fatal(err)
	}
	ownerRaw := [20]byte{19: 99}
	owner := sdk.AccAddress(ownerRaw[:]).String()
	var providers [8][20]byte
	for i := range providers {
		providers[i][19] = byte(i + 1)
	}
	fileLength := rangeStart + rangeLength
	rng, err := retrievalchallenge.CheckedRangeV3(0, fileLength, rangeStart, rangeLength, userMDUs)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := retrievalchallenge.BuildPlanV3(rng, providers)
	if err != nil {
		t.Fatal(err)
	}
	planHash, err := plan.Hash()
	if err != nil {
		t.Fatal(err)
	}
	id, err := (retrievalchallenge.SessionBindingV3{ChainID: chainID, Owner: ownerRaw, DealID: 0, Generation: 1, FileRecordIndex: 3, RangeStart: rangeStart, RangeLength: rangeLength, PlanHash: planHash, Nonce: 7}).ID()
	if err != nil {
		t.Fatal(err)
	}
	window, err := retrievalchallenge.SessionWindow(10, 20, 100)
	if err != nil {
		t.Fatal(err)
	}
	var setup32 [32]byte
	copy(setup32[:], setup)
	c := retrievalchallenge.ContextV3{
		ChainID: chainID, SetupDigest: setup32, SessionID: id, SessionOwner: ownerRaw,
		DealID: 0, Generation: 1, FileRecordIndex: 3, FileLength: fileLength, RangeStart: rangeStart, RangeLength: rangeLength,
		MetadataMDUs: 4, UserMDUs: userMDUs, PlanHash: planHash, Population: rng.Population,
		SampleCount: min(rng.Population, retrievalchallenge.MaxLargeSessionSamples), Nonce: 7,
		PriceDenom: "stake", PricePerBlob: "1", BaseFee: "0",
		FundingKind: retrievalchallenge.FundingRequester, FundingPayer: ownerRaw, Window: window, DealEnd: 100,
	}
	hash, err := c.Hash()
	if err != nil {
		t.Fatal(err)
	}
	s := types.RetrievalSessionV3{
		SessionId: id[:], ContextHash: hash[:], DealId: 0, Generation: 1, Owner: owner, Payer: owner,
		PolyfsRoot: c.PolyFSRoot[:], IntegrityRoot: c.IntegrityRoot[:], SetupDigest: setup,
		FileRecordIndex: 3, FileLength: fileLength, RangeStart: rangeStart, RangeLength: rangeLength, MetadataMdus: 4, UserMdus: userMDUs,
		PlanHash: planHash[:], FirstBlob: rng.First, LastBlob: rng.Last, Population: rng.Population,
		SampleCount: c.SampleCount, Nonce: 7, PriceDenom: "stake", PricePerBlob: cosmosmath.OneInt(), BaseFee: cosmosmath.ZeroInt(),
		Funding:        types.RetrievalSessionFunding_RETRIEVAL_SESSION_FUNDING_REQUESTER,
		SnapshotHeight: window.Snapshot, AnchorHeight: window.Anchor, FirstResponseHeight: window.First, DeadlineHeight: window.Deadline, DealEndHeight: 100,
		AcceptedSampleBitmap: make([]byte, v3SampleBitmapBytes), LockedFee: cosmosmath.NewIntFromUint64(rng.Population),
		OpenedHeight: 10, UpdatedHeight: 10, ChainId: chainID,
	}
	for _, o := range plan.Obligations {
		address := sdk.AccAddress(o.Assigned[:]).String()
		s.Obligations = append(s.Obligations, types.RetrievalObligationV3{Slot: o.Slot, AssignedProvider: address, Payee: address, BlobCount: o.BlobCount, LockedFee: cosmosmath.NewIntFromUint64(o.BlobCount)})
	}
	anchor := make([]byte, 32)
	anchor[0] = 42
	return &types.QueryGetRetrievalSessionV3Response{Session: s, AnchorSeed: anchor}, window.First
}

func TestFreezeRetrievalSessionV3ResponseDerivesGlobalPartition(t *testing.T) {
	r, height := frozenSessionV3Fixture(t, 1<<30, 133)
	frozen, err := freezeRetrievalSessionV3Response(r, height)
	if err != nil {
		t.Fatal(err)
	}
	if len(frozen.Challenges) != int(retrievalchallenge.MaxLargeSessionSamples) {
		t.Fatalf("challenge count %d", len(frozen.Challenges))
	}
	counts := map[uint32]uint64{}
	rng, err := retrievalchallenge.CheckedRangeV3(frozen.Context.FileStartOffset, frozen.Context.FileLength, frozen.Context.RangeStart, frozen.Context.RangeLength, frozen.Context.UserMDUs)
	if err != nil {
		t.Fatal(err)
	}
	for ordinal, challenge := range frozen.Challenges {
		if challenge.Ordinal != uint64(ordinal) || challenge.T != rng.First+challenge.Position {
			t.Fatalf("challenge %d ordinal or population mapping mismatch", ordinal)
		}
		mdu, leaf, slot, err := retrievalchallenge.SystematicCoordinateV3(challenge.T, frozen.Context.MetadataMDUs, frozen.Context.UserMDUs)
		if err != nil || challenge.MDUIndex != mdu || challenge.LeafIndex != leaf || challenge.Slot != slot {
			t.Fatalf("challenge %d coordinate mismatch", ordinal)
		}
		counts[slot]++
	}
	for _, obligation := range frozen.Session.Obligations {
		if counts[obligation.Slot] == 0 {
			t.Fatalf("fixture unexpectedly omitted represented slot %d", obligation.Slot)
		}
	}
	r.Session.ContextHash[0] ^= 1
	if _, err := freezeRetrievalSessionV3Response(r, height); err == nil {
		t.Fatal("accepted rebound v3 context hash")
	}
}

func TestProviderChallengesV3PreservesGlobalOrdinalsAndBoundsEnvelope(t *testing.T) {
	r, height := frozenSessionV3Fixture(t, 1<<30, 133)
	frozen, err := freezeRetrievalSessionV3Response(r, height)
	if err != nil {
		t.Fatal(err)
	}
	obligation := frozen.Session.Obligations[0]
	frozen.Challenges = make([]retrievalchallenge.ChallengeV3, 66)
	for i := range frozen.Challenges {
		frozen.Challenges[i] = retrievalchallenge.ChallengeV3{Ordinal: uint64(i), Slot: obligation.Slot}
	}
	// Accepted samples remain keyed by their global ordinal across envelopes.
	frozen.Session.AcceptedSampleBitmap[3/8] |= 1 << (3 % 8)
	slot, selected, remaining, err := providerChallengesV3(frozen, obligation.AssignedProvider, 64)
	if err != nil {
		t.Fatal(err)
	}
	if slot != obligation.Slot || len(selected) != 64 || remaining != 1 {
		t.Fatalf("unexpected partition slot=%d selected=%d remaining=%d", slot, len(selected), remaining)
	}
	for _, challenge := range selected {
		if challenge.Ordinal == 3 {
			t.Fatal("reselected accepted global ordinal")
		}
	}
	outsider := sdk.AccAddress(bytes.Repeat([]byte{99}, 20)).String()
	if _, _, _, err := providerChallengesV3(frozen, outsider, 64); err == nil {
		t.Fatal("accepted a signer outside the frozen provider vector")
	}
}

func TestFreezeRetrievalSessionV3ResponseRejectsMalformedEconomics(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*types.QueryGetRetrievalSessionV3Response)
	}{
		{"funding aliases after uint8 conversion", func(r *types.QueryGetRetrievalSessionV3Response) {
			r.Session.Funding = types.RetrievalSessionFunding(257)
		}},
		{"obligation fee mismatch", func(r *types.QueryGetRetrievalSessionV3Response) {
			r.Session.Obligations[0].LockedFee = r.Session.Obligations[0].LockedFee.AddRaw(1)
		}},
		{"remaining lock mismatch", func(r *types.QueryGetRetrievalSessionV3Response) { r.Session.LockedFee = r.Session.LockedFee.AddRaw(1) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, height := frozenSessionV3Fixture(t, 1<<20, 1)
			tc.mutate(r)
			if _, err := freezeRetrievalSessionV3Response(r, height); err == nil || !strings.Contains(err.Error(), "v3") {
				t.Fatalf("accepted malformed economics: %v", err)
			}
		})
	}
}

func TestRetrievalProofOperationV3TracksExactGlobalOrdinals(t *testing.T) {
	id := bytes.Repeat([]byte{7}, 32)
	idHex := hex.EncodeToString(id)
	proofs := []types.RetrievalSampleProofV3{{Ordinal: 4}, {Ordinal: 129}}
	op := retrievalProofOperationV3(id, proofs)
	if op.Kind != "retrieval-v3" || len(op.IDs) != 2 || !strings.HasSuffix(op.IDs[0], ":4") || !strings.HasSuffix(op.IDs[1], ":129") {
		t.Fatalf("unexpected durable proof identity: %+v", op)
	}
	s := types.RetrievalSessionV3{SessionId: bytes.Clone(id), SampleCount: 132, AcceptedSampleBitmap: make([]byte, v3SampleBitmapBytes)}
	for _, ordinal := range []uint64{4, 129} {
		s.AcceptedSampleBitmap[ordinal/8] |= 1 << (ordinal % 8)
	}
	if !pendingRetrievalProofsAcceptedV3(&op, s) {
		t.Fatal("exact accepted proof ordinals did not reconcile")
	}
	s.SessionId[0] ^= 1
	if pendingRetrievalProofsAcceptedV3(&op, s) {
		t.Fatal("reconciled proof marker against another session")
	}
	bad := pendingSignerOperation{Kind: "retrieval-v3", IDs: []string{idHex + ":132"}}
	s.SessionId = bytes.Clone(id)
	s.SampleCount = ^uint64(0)
	if pendingRetrievalProofsAcceptedV3(&bad, s) {
		t.Fatal("accepted proof ordinal outside the canonical v3 bitmap")
	}
	recorded, ordinals, ok := parseRetrievalProofOperationV3(&op)
	if !ok || recorded != idHex {
		t.Fatalf("lost recorded session identity: %q %t", recorded, ok)
	}
	if len(ordinals) != 2 || ordinals[0] != 4 || ordinals[1] != 129 {
		t.Fatalf("lost recorded ordinals: %v", ordinals)
	}
	for _, malformed := range []string{idHex + ":junk", strings.ToUpper(strings.Repeat("ab", 32)) + ":4", idHex + ":04", idHex + ":132", idHex + ":4:5"} {
		bad := pendingSignerOperation{Kind: "retrieval-v3", IDs: []string{malformed}, TxHash: strings.Repeat("A", 64)}
		if _, _, ok := parseRetrievalProofOperationV3(&bad); ok {
			t.Fatalf("accepted malformed committed proof marker %q", malformed)
		}
	}
}

func TestRetrievalV3RecoveryOutcomeDoesNotAttributeRequestedSession(t *testing.T) {
	w := httptest.NewRecorder()
	recorded := strings.Repeat("ab", 32)
	writeRetrievalV3RecoveryOutcome(w, "reconciled", recorded, strings.Repeat("C", 64), 2, "complete", nil)
	body := w.Body.String()
	for _, want := range []string{`"recorded_session_id":"` + recorded + `"`, `"retry_required":true`} {
		if !strings.Contains(body, want) {
			t.Fatalf("missing %s in %s", want, body)
		}
	}
	if strings.Contains(body, `"session_id"`) || strings.Contains(body, `"remaining"`) || strings.Contains(body, `"slot"`) {
		t.Fatalf("recovery response claimed unqueried current-session state: %s", body)
	}
}

func buildProviderV3ArtifactFixture(t testing.TB) (*frozenRetrievalSessionV3, retrievalGenerationKey, string) {
	return buildProviderV3ArtifactFixtureSize(t, 1024)
}

func buildProviderV3ArtifactFixtureSize(t testing.TB, size uint64) (*frozenRetrievalSessionV3, retrievalGenerationKey, string) {
	t.Helper()
	useTempUploadDir(t)
	initCryptoForTest(t)
	const dealID = uint64(0)
	payload := filepath.Join(t.TempDir(), "payload.bin")
	f, err := os.OpenFile(payload, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(int64(size)); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{0x5a}, 0); err != nil {
		_ = f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	result, newDir, err := mode2BuildArtifactsWithOptions(context.Background(), payload, dealID, "General:rs=8+4", "payload.bin", 0, mode2BuildOptions{fatVersion: 3})
	if err != nil {
		t.Fatal(err)
	}
	metadataMDUs := uint64(1 + result.witnessMdus)
	root := result.manifestRoot
	integrity := result.integrityRoot
	r, height := frozenSessionV3Fixture(t, size, result.userMdus)
	r.Session.PolyfsRoot = bytes.Clone(root.Bytes[:])
	r.Session.IntegrityRoot = integrity[:]
	r.Session.MetadataMdus = metadataMDUs
	c, err := contextV3FromSession(r.Session)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := c.Hash()
	if err != nil {
		t.Fatal(err)
	}
	r.Session.ContextHash = hash[:]
	frozen, err := freezeRetrievalSessionV3Response(r, height)
	if err != nil {
		t.Fatal(err)
	}
	key := retrievalGenerationKey{Chain: c.ChainID, Setup: c.SetupDigest, Root: c.PolyFSRoot, Integrity: c.IntegrityRoot, Deal: c.DealID, Generation: c.Generation, Metadata: c.MetadataMDUs, Users: c.UserMDUs, Layout: retrievalchallenge.StripeK8M4, K: 8, M: 4, Version: 3}
	return frozen, key, newDir
}

func authenticatedRetrievalMetadataForWithResources(ctx context.Context, dir string, key retrievalGenerationKey, prepare func(context.Context, string, retrievalGenerationKey) (*authenticatedGeneration, error), held chan<- struct{}) (*authenticatedGeneration, error) {
	ctx, releaseResponse, err := admitRetrievalResponse(ctx)
	if err != nil {
		return nil, err
	}
	defer releaseResponse()
	releaseGeneration, err := leaseGenerationPaths(dir)
	if err != nil {
		return nil, err
	}
	defer releaseGeneration()
	if held != nil {
		close(held)
	}
	return authenticatedRetrievalMetadataForWith(ctx, dir, key, prepare)
}

func TestAuthenticatedRetrievalMetadataConcurrentCancellationOwnership(t *testing.T) {
	cleanup := func(chain string) {
		retrievalMetadataCache.Lock()
		defer retrievalMetadataCache.Unlock()
		for cached := range retrievalMetadataCache.entries {
			if cached.Chain == chain {
				delete(retrievalMetadataCache.entries, cached)
			}
		}
	}

	t.Run("v2 canceled waiter promptly releases resources", func(t *testing.T) {
		dir := t.TempDir()
		key := retrievalGenerationKey{Chain: "metadata-waiter-cancellation", Root: [32]byte{1}, Generation: 1, Version: 2}
		t.Cleanup(func() { cleanup(key.Chain) })
		started, finish := make(chan struct{}), make(chan struct{})
		workerCtx, cancelWorkers := context.WithCancel(t.Context())
		var workers sync.WaitGroup
		var finishOnce sync.Once
		defer func() {
			cancelWorkers()
			finishOnce.Do(func() { close(finish) })
			workers.Wait()
		}()
		var calls atomic.Int32
		prepare := func(ctx context.Context, _ string, _ retrievalGenerationKey) (*authenticatedGeneration, error) {
			if calls.Add(1) != 1 {
				return nil, errors.New("concurrent waiter started duplicate metadata preparation")
			}
			close(started)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-finish:
				return &authenticatedGeneration{}, nil
			}
		}
		baselineResponses := len(retrievalResponses)
		leaderResult := make(chan error, 1)
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := authenticatedRetrievalMetadataForWithResources(workerCtx, dir, key, prepare, nil)
			leaderResult <- err
		}()
		waitIntegrityIndexV3Signal(t, started, "metadata leader")

		waiterBase, cancelWaiter := context.WithCancel(workerCtx)
		waiterObserved := make(chan struct{})
		waiterCtx := &observedDoneContextV3{Context: waiterBase, observed: waiterObserved}
		waiterHeld, waiterResult := make(chan struct{}), make(chan error, 1)
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := authenticatedRetrievalMetadataForWithResources(waiterCtx, dir, key, prepare, waiterHeld)
			waiterResult <- err
		}()
		waitIntegrityIndexV3Signal(t, waiterHeld, "metadata waiter resources")
		waitIntegrityIndexV3Signal(t, waiterObserved, "metadata waiter gate entry")
		if refs := generationRefsV3Test(t, dir); refs != 2 || len(retrievalResponses) != baselineResponses+2 {
			t.Fatalf("metadata requests did not hold independent resources: refs=%d responses=%d", refs, len(retrievalResponses)-baselineResponses)
		}
		cancelWaiter()
		if err := waitIntegrityIndexV3Result(t, waiterResult, "metadata waiter cancellation"); !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled metadata waiter returned %v", err)
		}
		if refs := generationRefsV3Test(t, dir); refs != 1 || len(retrievalResponses) != baselineResponses+1 || calls.Load() != 1 {
			t.Fatalf("canceled metadata waiter retained resources or duplicated work: refs=%d responses=%d calls=%d", refs, len(retrievalResponses)-baselineResponses, calls.Load())
		}
		finishOnce.Do(func() { close(finish) })
		if err := waitIntegrityIndexV3Result(t, leaderResult, "metadata leader completion"); err != nil {
			t.Fatal(err)
		}
		if refs := generationRefsV3Test(t, dir); refs != 0 || len(retrievalResponses) != baselineResponses {
			t.Fatalf("metadata leader retained resources: refs=%d responses=%d", refs, len(retrievalResponses)-baselineResponses)
		}
	})

	t.Run("v3 live waiter retries canceled leader", func(t *testing.T) {
		dir := t.TempDir()
		key := retrievalGenerationKey{Chain: "metadata-leader-cancellation", Root: [32]byte{2}, Generation: 1, Version: 3}
		t.Cleanup(func() { cleanup(key.Chain) })
		leaderStarted := make(chan struct{})
		workerCtx, cancelWorkers := context.WithCancel(t.Context())
		var workers sync.WaitGroup
		defer func() {
			cancelWorkers()
			workers.Wait()
		}()
		prepared := &authenticatedGeneration{}
		var calls atomic.Int32
		prepare := func(ctx context.Context, _ string, _ retrievalGenerationKey) (*authenticatedGeneration, error) {
			if calls.Add(1) == 1 {
				close(leaderStarted)
				<-ctx.Done()
				return nil, ctx.Err()
			}
			return prepared, nil
		}
		leaderCtx, cancelLeader := context.WithCancel(workerCtx)
		leaderResult := make(chan error, 1)
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := authenticatedRetrievalMetadataForWithResources(leaderCtx, dir, key, prepare, nil)
			leaderResult <- err
		}()
		waitIntegrityIndexV3Signal(t, leaderStarted, "metadata leader")

		waiterObserved := make(chan struct{})
		waiterCtx := &observedDoneContextV3{Context: workerCtx, observed: waiterObserved}
		waiterHeld := make(chan struct{})
		waiterResult := make(chan struct {
			value *authenticatedGeneration
			err   error
		}, 1)
		workers.Add(1)
		go func() {
			defer workers.Done()
			value, err := authenticatedRetrievalMetadataForWithResources(waiterCtx, dir, key, prepare, waiterHeld)
			waiterResult <- struct {
				value *authenticatedGeneration
				err   error
			}{value, err}
		}()
		waitIntegrityIndexV3Signal(t, waiterHeld, "metadata waiter resources")
		waitIntegrityIndexV3Signal(t, waiterObserved, "metadata waiter gate entry")
		cancelLeader()
		if err := waitIntegrityIndexV3Result(t, leaderResult, "metadata leader cancellation"); !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled metadata leader returned %v", err)
		}
		select {
		case result := <-waiterResult:
			if result.err != nil || result.value != prepared {
				t.Fatalf("live metadata waiter did not retry: value=%p err=%v", result.value, result.err)
			}
		case <-time.After(time.Second):
			t.Fatal("live metadata waiter did not retry")
		}
		if calls.Load() != 2 || generationRefsV3Test(t, dir) != 0 {
			t.Fatalf("unexpected metadata retry state: calls=%d refs=%d", calls.Load(), generationRefsV3Test(t, dir))
		}
	})

	t.Run("concurrent authentication error is prepared once", func(t *testing.T) {
		dir := t.TempDir()
		key := retrievalGenerationKey{Chain: "metadata-authentication-error", Root: [32]byte{3}, Generation: 1, Version: 3}
		t.Cleanup(func() { cleanup(key.Chain) })
		corrupt := errors.New("corrupt authenticated metadata")
		started, failPreparation := make(chan struct{}), make(chan struct{})
		workerCtx, cancelWorkers := context.WithCancel(t.Context())
		var workers sync.WaitGroup
		var failOnce sync.Once
		defer func() {
			cancelWorkers()
			failOnce.Do(func() { close(failPreparation) })
			workers.Wait()
		}()
		var calls atomic.Int32
		prepare := func(ctx context.Context, _ string, _ retrievalGenerationKey) (*authenticatedGeneration, error) {
			if calls.Add(1) == 1 {
				close(started)
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-failPreparation:
				return nil, corrupt
			}
		}
		baselineResponses := len(retrievalResponses)
		results := make(chan error, maxRetrievalResponses)
		workers.Add(1)
		go func() {
			defer workers.Done()
			_, err := authenticatedRetrievalMetadataForWithResources(workerCtx, dir, key, prepare, nil)
			results <- err
		}()
		waitIntegrityIndexV3Signal(t, started, "failed metadata owner")

		for i := 1; i < maxRetrievalResponses; i++ {
			observed := make(chan struct{})
			held := make(chan struct{})
			waiterCtx := &observedDoneContextV3{Context: workerCtx, observed: observed}
			workers.Add(1)
			go func() {
				defer workers.Done()
				_, err := authenticatedRetrievalMetadataForWithResources(waiterCtx, dir, key, prepare, held)
				results <- err
			}()
			waitIntegrityIndexV3Signal(t, held, "failed metadata waiter resources")
			waitIntegrityIndexV3Signal(t, observed, "failed metadata waiter gate entry")
		}
		if refs := generationRefsV3Test(t, dir); refs != maxRetrievalResponses || len(retrievalResponses) != baselineResponses+maxRetrievalResponses {
			t.Fatalf("failed metadata waiters did not retain independent resources: refs=%d responses=%d", refs, len(retrievalResponses)-baselineResponses)
		}
		failOnce.Do(func() { close(failPreparation) })
		for i := 0; i < maxRetrievalResponses; i++ {
			if err := waitIntegrityIndexV3Result(t, results, "shared metadata failure"); !errors.Is(err, corrupt) {
				t.Fatalf("metadata waiter returned %v", err)
			}
		}
		workers.Wait()
		if calls.Load() != 1 || generationRefsV3Test(t, dir) != 0 || len(retrievalResponses) != baselineResponses {
			t.Fatalf("authentication failure was rebuilt or retained resources: calls=%d refs=%d responses=%d", calls.Load(), generationRefsV3Test(t, dir), len(retrievalResponses)-baselineResponses)
		}
	})
}

func TestBuildProviderProofBatchV3UsesAuthenticatedArtifactsAndRealKZG(t *testing.T) {
	frozen, key, dir := buildProviderV3ArtifactFixture(t)
	signer := frozen.Session.Obligations[0].AssignedProvider
	metadata, err := authenticatedRetrievalMetadataFor(t.Context(), dir, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyIntegrityVectorV3(t.Context(), dir, key, 0, metadata); err != nil {
		t.Fatalf("generation ingest verification failed: %v", err)
	}
	if err := validateIntegrityIndexV3(filepath.Join(dir, integrityIndexV3File), key.Users*retrievalchallenge.IntegrityLeavesPerUserMDU); err != nil {
		t.Fatalf("generation ingest did not publish the verified integrity index: %v", err)
	}
	slot, proofs, remaining, err := buildProviderProofBatchV3(t.Context(), frozen, signer)
	if err != nil {
		t.Fatal(err)
	}
	if slot != 0 || len(proofs) != 1 || proofs[0].Ordinal != 0 || remaining != 0 {
		t.Fatalf("unexpected real proof batch slot=%d proofs=%d ordinal=%d remaining=%d", slot, len(proofs), proofs[0].Ordinal, remaining)
	}
	if _, _, _, err := buildProviderProofBatchV3(t.Context(), frozen, sdk.AccAddress(bytes.Repeat([]byte{99}, 20)).String()); err == nil {
		t.Fatal("generated proof for the wrong provider")
	}
	shardPath := filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_0.bin", key.Metadata))
	shard, err := os.OpenFile(shardPath, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := shard.WriteAt([]byte{0xff}, 17); err != nil {
		t.Fatal(err)
	}
	if err := shard.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := buildProviderProofBatchV3(t.Context(), frozen, signer); err == nil {
		t.Fatal("accepted a proof from corrupted frozen bytes")
	}
}

func TestBuildProviderProofBatchV3FromDirectoryRetainsProductionAuthentication(t *testing.T) {
	frozen, _, dir := buildProviderV3ArtifactFixture(t)
	signer := frozen.Session.Obligations[0].AssignedProvider
	slot, proofs, remaining, err := buildProviderProofBatchV3FromDirectory(t.Context(), frozen, signer, dir)
	if err != nil || slot != 0 || len(proofs) != 1 || remaining != 0 {
		t.Fatalf("unexpected explicit-directory proof batch slot=%d proofs=%d remaining=%d err=%v", slot, len(proofs), remaining, err)
	}
	bad := filepath.Join(t.TempDir(), "generation")
	if err := os.CopyFS(bad, os.DirFS(dir)); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(bad, fmt.Sprintf("mdu_%d_slot_0.bin", frozen.Context.MetadataMDUs))
	f, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{0xff}, 19); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := buildProviderProofBatchV3FromDirectory(t.Context(), frozen, signer, bad); err == nil {
		t.Fatal("explicit-directory builder accepted corrupted authenticated bytes")
	}
}

func TestGenerationAcceptanceV3RejectsUnsampledIntegrityLeaf(t *testing.T) {
	_, key, dir := buildProviderV3ArtifactFixture(t)
	metadata, err := authenticatedRetrievalMetadataFor(t.Context(), dir, key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, integrityLeavesV3File)
	f, err := os.OpenFile(path, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	// Corrupt another slot's leaf. Own-slot verification still authenticates the
	// complete vector root before checking this provider's eight stored blobs.
	if _, err := f.WriteAt([]byte{0xff}, int64(8*32+7)); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := verifyIntegrityVectorV3(t.Context(), dir, key, 0, metadata); err == nil {
		t.Fatal("accepted an altered unsampled integrity leaf")
	}
}

func TestRetrievalV3PendingSignerSurvivesRestartAndSharesAuditLock(t *testing.T) {
	path := submissionTestDB(t)
	signer := sdk.AccAddress(bytes.Repeat([]byte{9}, 20)).String()
	audit := pendingSignerOperation{Kind: "audit", IDs: []string{"audit-context:4"}}
	if err := sessionDB.Update(func(tx *bolt.Tx) error { return claimPendingSigner(tx, signer, audit) }); err != nil {
		t.Fatal(err)
	}
	id := bytes.Repeat([]byte{7}, 32)
	op := retrievalProofOperationV3(id, []types.RetrievalSampleProofV3{{Ordinal: 4}})
	if err := updatePendingSignerV3(signer, op, false); err == nil {
		t.Fatal("v3 retrieval bypassed unresolved audit signer operation")
	}
	got, err := loadPendingSigner(signer)
	if err != nil || got == nil || got.Kind != "audit" {
		t.Fatalf("failed v3 claim altered audit marker: %+v %v", got, err)
	}
	if err := sessionDB.Update(func(tx *bolt.Tx) error { return clearPendingSigner(tx, signer, audit.Kind, audit.IDs) }); err != nil {
		t.Fatal(err)
	}
	op.TxHash = strings.Repeat("A", 64)
	if err := updatePendingSignerV3(signer, op, false); err != nil {
		t.Fatal(err)
	}
	if err := closeSessionDB(); err != nil {
		t.Fatal(err)
	}
	if err := initSessionDB(path); err != nil {
		t.Fatal(err)
	}
	got, err = loadPendingSigner(signer)
	if err != nil || got == nil || got.Kind != op.Kind || got.TxHash != op.TxHash || len(got.IDs) != 1 || got.IDs[0] != op.IDs[0] {
		t.Fatalf("restart lost exact v3 proof quarantine: %+v %v", got, err)
	}
}

func TestRetrievalV3MalformedCommittedMarkerRemainsQuarantined(t *testing.T) {
	submissionTestDB(t)
	lcd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/retrieval-sessions/") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		t.Fatalf("unexpected LCD query after malformed v3 marker: %s", r.URL.Path)
	}))
	t.Cleanup(lcd.Close)
	oldLCD := lcdBase
	lcdBase = lcd.URL
	t.Cleanup(func() { lcdBase = oldLCD })
	signer := sdk.AccAddress(bytes.Repeat([]byte{9}, 20)).String()
	id := strings.Repeat("ab", 32)
	op := pendingSignerOperation{Kind: "retrieval-v3", IDs: []string{id + ":junk"}, TxHash: strings.Repeat("A", 64)}
	if err := updatePendingSignerV3(signer, op, false); err != nil {
		t.Fatal(err)
	}
	setupMockCombinedOutput(t, func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) > 0 && args[0] == "keys" {
			return []byte(signer), nil
		}
		return nil, fmt.Errorf("unexpected command")
	})
	w := invokeSubmission(`{"session_id":"0x` + id + `"}`)
	if w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "invalid v3 proof reconciliation identity") {
		t.Fatalf("malformed marker was not rejected: %d %s", w.Code, w.Body.String())
	}
	got, err := loadPendingSigner(signer)
	if err != nil || got == nil || got.TxHash != op.TxHash || got.IDs[0] != op.IDs[0] {
		t.Fatalf("malformed committed marker was cleared: %+v %v", got, err)
	}
}
