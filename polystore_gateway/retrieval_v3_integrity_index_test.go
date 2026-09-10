package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"polystorechain/pkg/retrievalchallenge"
)

type observedDoneContextV3 struct {
	context.Context
	once     sync.Once
	observed chan struct{}
}

func (c *observedDoneContextV3) Done() <-chan struct{} {
	c.once.Do(func() { close(c.observed) })
	return c.Context.Done()
}

func waitIntegrityIndexV3Signal(t *testing.T, signal <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for %s", name)
	}
}

func waitIntegrityIndexV3Result(t *testing.T, result <-chan error, name string) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(time.Second):
		t.Fatalf("timed out waiting for %s", name)
		return nil
	}
}

func ensureIntegrityIndexV3WithResources(ctx context.Context, dir string, key retrievalGenerationKey, build func(context.Context, string, retrievalGenerationKey) (string, error), held chan<- struct{}) (string, error) {
	ctx, releaseResponse, err := admitRetrievalResponse(ctx)
	if err != nil {
		return "", err
	}
	defer releaseResponse()
	releaseGeneration, err := leaseGenerationPaths(dir)
	if err != nil {
		return "", err
	}
	defer releaseGeneration()
	if held != nil {
		close(held)
	}
	return ensureIntegrityIndexV3WithBuilder(ctx, dir, key, build)
}

func generationRefsV3Test(t *testing.T, path string) int {
	t.Helper()
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	generationLifecycle.Lock()
	defer generationLifecycle.Unlock()
	if use := generationLifecycle.uses[abs]; use != nil {
		return use.refs
	}
	return 0
}

func writeIntegrityLeavesFixtureV3(t *testing.T, dir string, count uint64) ([][32]byte, retrievalGenerationKey) {
	t.Helper()
	leaves := make([][32]byte, count)
	wire := make([]byte, count*32)
	for i := range leaves {
		leaves[i] = sha256.Sum256([]byte{byte(i), byte(i >> 8), byte(i >> 16)})
		copy(wire[i*32:], leaves[i][:])
	}
	if err := os.WriteFile(filepath.Join(dir, integrityLeavesV3File), wire, 0600); err != nil {
		t.Fatal(err)
	}
	root, err := retrievalchallenge.IntegrityRootV3(leaves)
	if err != nil {
		t.Fatal(err)
	}
	return leaves, retrievalGenerationKey{Users: count / retrievalchallenge.IntegrityLeavesPerUserMDU, Integrity: root}
}

func TestIntegrityIndexV3BuildsCanonicalPathsAndRejectsCorruption(t *testing.T) {
	dir := t.TempDir()
	leaves, key := writeIntegrityLeavesFixtureV3(t, dir, retrievalchallenge.IntegrityLeavesPerUserMDU)
	index, err := ensureIntegrityIndexV3(t.Context(), dir, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateIntegrityIndexV3(index, uint64(len(leaves))); err != nil {
		t.Fatal(err)
	}
	for position, leaf := range leaves {
		path, err := readIntegrityPathV3(index, filepath.Join(dir, integrityLeavesV3File), uint64(position), uint64(len(leaves)))
		if err != nil || !retrievalchallenge.VerifyIntegrityPathV3(leaf, uint64(position), uint64(len(leaves)), path, key.Integrity) {
			t.Fatalf("position %d has invalid canonical path: %v", position, err)
		}
	}
	f, err := os.OpenFile(index, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt([]byte{0xff}, int64(integrityIndexV3HeaderBytes+32)); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	path, err := readIntegrityPathV3(index, filepath.Join(dir, integrityLeavesV3File), 0, uint64(len(leaves)))
	if err != nil {
		t.Fatal(err)
	}
	if retrievalchallenge.VerifyIntegrityPathV3(leaves[0], 0, uint64(len(leaves)), path, key.Integrity) {
		t.Fatal("accepted a path through a corrupted derived index")
	}
}

func TestIntegrityIndexV3CancellationLeavesNoPublishedArtifact(t *testing.T) {
	dir := t.TempDir()
	_, key := writeIntegrityLeavesFixtureV3(t, dir, retrievalchallenge.IntegrityLeavesPerUserMDU)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := ensureIntegrityIndexV3(ctx, dir, key); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, integrityIndexV3File)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled build published an index: %v", err)
	}
	matches, err := filepath.Glob(filepath.Join(dir, ".integrity-index-v3-*"))
	if err != nil || len(matches) != 0 {
		t.Fatalf("canceled build retained temporary files: %v %v", matches, err)
	}
}

func TestIntegrityIndexV3ConcurrentCancellationOwnership(t *testing.T) {
	t.Run("canceled waiter releases resources while leader completes", func(t *testing.T) {
		dir := t.TempDir()
		_, key := writeIntegrityLeavesFixtureV3(t, dir, retrievalchallenge.IntegrityLeavesPerUserMDU)
		started, finish := make(chan struct{}), make(chan struct{})
		var calls atomic.Int32
		builder := func(ctx context.Context, dir string, key retrievalGenerationKey) (string, error) {
			if calls.Add(1) != 1 {
				return "", errors.New("concurrent waiter started a duplicate build")
			}
			close(started)
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-finish:
				return buildIntegrityIndexV3(ctx, dir, key)
			}
		}
		baselineResponses := len(retrievalResponses)
		leaderResult := make(chan error, 1)
		go func() {
			_, err := ensureIntegrityIndexV3WithResources(t.Context(), dir, key, builder, nil)
			leaderResult <- err
		}()
		waitIntegrityIndexV3Signal(t, started, "leader build")
		waiterBase, cancelWaiter := context.WithCancel(t.Context())
		waiterObserved := make(chan struct{})
		waiterCtx := &observedDoneContextV3{Context: waiterBase, observed: waiterObserved}
		waiterHeld, waiterResult := make(chan struct{}), make(chan error, 1)
		go func() {
			_, err := ensureIntegrityIndexV3WithResources(waiterCtx, dir, key, builder, waiterHeld)
			waiterResult <- err
		}()
		waitIntegrityIndexV3Signal(t, waiterHeld, "waiter resources")
		waitIntegrityIndexV3Signal(t, waiterObserved, "waiter gate entry")
		if refs := generationRefsV3Test(t, dir); refs != 2 || len(retrievalResponses) != baselineResponses+2 {
			t.Fatalf("concurrent requests did not hold their own resources: refs=%d responses=%d", refs, len(retrievalResponses)-baselineResponses)
		}
		cancelWaiter()
		select {
		case err := <-waiterResult:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("canceled waiter returned %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("canceled waiter remained blocked behind leader")
		}
		if refs := generationRefsV3Test(t, dir); refs != 1 || len(retrievalResponses) != baselineResponses+1 || calls.Load() != 1 {
			t.Fatalf("canceled waiter retained resources or duplicated work: refs=%d responses=%d calls=%d", refs, len(retrievalResponses)-baselineResponses, calls.Load())
		}
		close(finish)
		if err := waitIntegrityIndexV3Result(t, leaderResult, "leader publication"); err != nil {
			t.Fatal(err)
		}
		if refs := generationRefsV3Test(t, dir); refs != 0 || len(retrievalResponses) != baselineResponses {
			t.Fatalf("leader retained resources after publication: refs=%d responses=%d", refs, len(retrievalResponses)-baselineResponses)
		}
	})

	t.Run("active waiter retries after leader cancellation", func(t *testing.T) {
		dir := t.TempDir()
		_, key := writeIntegrityLeavesFixtureV3(t, dir, retrievalchallenge.IntegrityLeavesPerUserMDU)
		leaderStarted := make(chan struct{})
		var calls atomic.Int32
		builder := func(ctx context.Context, dir string, key retrievalGenerationKey) (string, error) {
			if calls.Add(1) == 1 {
				close(leaderStarted)
				<-ctx.Done()
				return "", ctx.Err()
			}
			return buildIntegrityIndexV3(ctx, dir, key)
		}
		leaderCtx, cancelLeader := context.WithCancel(t.Context())
		leaderResult := make(chan error, 1)
		go func() {
			_, err := ensureIntegrityIndexV3WithResources(leaderCtx, dir, key, builder, nil)
			leaderResult <- err
		}()
		waitIntegrityIndexV3Signal(t, leaderStarted, "leader build")
		waiterObserved := make(chan struct{})
		waiterCtx := &observedDoneContextV3{Context: t.Context(), observed: waiterObserved}
		waiterHeld := make(chan struct{})
		waiterResult := make(chan error, 1)
		go func() {
			_, err := ensureIntegrityIndexV3WithResources(waiterCtx, dir, key, builder, waiterHeld)
			waiterResult <- err
		}()
		waitIntegrityIndexV3Signal(t, waiterHeld, "waiter resources")
		waitIntegrityIndexV3Signal(t, waiterObserved, "waiter gate entry")
		if refs := generationRefsV3Test(t, dir); refs != 2 {
			t.Fatalf("active waiter did not retain its generation lease: refs=%d", refs)
		}
		cancelLeader()
		if err := waitIntegrityIndexV3Result(t, leaderResult, "leader cancellation"); !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled leader returned %v", err)
		}
		if err := waitIntegrityIndexV3Result(t, waiterResult, "waiter retry"); err != nil {
			t.Fatalf("active waiter did not retry: %v", err)
		}
		if calls.Load() != 2 {
			t.Fatalf("unexpected build count %d", calls.Load())
		}
		if err := validateIntegrityIndexV3(filepath.Join(dir, integrityIndexV3File), retrievalchallenge.IntegrityLeavesPerUserMDU); err != nil {
			t.Fatalf("waiter did not publish a valid index: %v", err)
		}
		if refs := generationRefsV3Test(t, dir); refs != 0 {
			t.Fatalf("completed requests retained generation resources: refs=%d", refs)
		}
	})
}

func TestIntegrityIndexV3RejectsWrongRootAndMalformedIndex(t *testing.T) {
	dir := t.TempDir()
	_, key := writeIntegrityLeavesFixtureV3(t, dir, retrievalchallenge.IntegrityLeavesPerUserMDU)
	wrong := key
	wrong.Integrity[0] ^= 1
	if _, err := ensureIntegrityIndexV3(t.Context(), dir, wrong); err == nil {
		t.Fatal("built an index for a mismatched authenticated root")
	}
	if err := os.WriteFile(filepath.Join(dir, integrityIndexV3File), make([]byte, 16), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ensureIntegrityIndexV3(t.Context(), dir, key); err == nil {
		t.Fatal("replaced a malformed existing index")
	}
}
