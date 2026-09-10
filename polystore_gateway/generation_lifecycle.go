package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// References cover actual file/stream lifetimes, including unpublished uploads.
// Idle entries disappear. A GC watcher keeps the revision until its query ends,
// so a read or publication that starts AND ends during that query invalidates it.
const maxGenerationReferences = 4096

type generationUse struct {
	refs, watchers int
	revision       uint64
	publishing     bool
}

var generationLifecycle = struct {
	sync.Mutex
	uses map[string]*generationUse
}{uses: make(map[string]*generationUse)}

var generationMaintenance = make(chan struct{}, 1)

var errGenerationConflict = errors.New("generation artifact conflicts with stored bytes")

type generationPublicationLeaseKey struct{}

// The combined build/upload call adopts the destination reference before its
// atomic publication. Standalone builders release it when their build finishes.
func leasePublishedGeneration(ctx context.Context, path string) (func(), error) {
	release, err := leaseGenerationPaths(path)
	if err != nil {
		return release, err
	}
	if owner, ok := ctx.Value(generationPublicationLeaseKey{}).(*func()); ok {
		if *owner != nil {
			release()
			return func() {}, fmt.Errorf("publication lease already adopted")
		}
		*owner = release
		return func() {}, nil
	}
	return release, nil
}

func sameArtifactFiles(a, b string) (bool, error) {
	var digests [2][32]byte
	var size int64 = -1
	for i, path := range []string{a, b} {
		info, err := os.Lstat(path)
		if err != nil {
			return false, err
		}
		if !info.Mode().IsRegular() || (size >= 0 && size != info.Size()) {
			return false, nil
		}
		size = info.Size()
		f, err := os.Open(path)
		if err != nil {
			return false, err
		}
		h := sha256.New()
		_, err = io.Copy(h, f)
		_ = f.Close()
		if err != nil {
			return false, err
		}
		copy(digests[i][:], h.Sum(nil))
	}
	return digests[0] == digests[1], nil
}

// Link publishes a fresh inode without replacing any existing artifact (also
// across processes). An existing file is idempotent only after byte comparison.
// Callers hold the directory lease while producing/consuming the temporary file.
func publishImmutableArtifact(src, dst string) error {
	if src == dst {
		return fmt.Errorf("publication source equals destination")
	}
	info, err := os.Lstat(src)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("publication source is not a regular file")
	}
	generationLifecycle.Lock()
	err = os.Link(src, dst)
	generationLifecycle.Unlock()
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		same, err := sameArtifactFiles(src, dst)
		if err != nil {
			return err
		}
		if !same {
			return fmt.Errorf("%w: %s", errGenerationConflict, filepath.Base(dst))
		}
	}
	return os.Remove(src)
}

// Generation publication is absent-destination rename or a verified duplicate.
// Conflicting and incomplete destinations are preserved for explicit repair.
func publishImmutableGeneration(stage, final string) error {
	stage, err := filepath.Abs(stage)
	if err != nil {
		return err
	}
	release, err := leaseGenerationPaths(stage, final)
	if err != nil {
		return err
	}
	defer release()
	generationLifecycle.Lock()
	use := generationLifecycle.uses[stage]
	if use.refs != 1 {
		generationLifecycle.Unlock()
		return fmt.Errorf("generation publication conflicts with an active staged upload")
	}
	use.publishing = true
	generationLifecycle.Unlock()
	defer func() {
		generationLifecycle.Lock()
		use.publishing = false
		generationLifecycle.Unlock()
	}()
	lockPath := filepath.Join(filepath.Dir(final), "."+filepath.Base(final)+".lock")
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("generation publication lock: %w", err)
	}
	_ = lock.Close()
	defer os.Remove(lockPath)
	generationLifecycle.Lock()
	info, err := os.Lstat(final)
	if errors.Is(err, os.ErrNotExist) {
		err = os.Rename(stage, final)
		generationLifecycle.Unlock()
		return err
	}
	generationLifecycle.Unlock()
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errGenerationConflict
	}
	// Sidecars and completion markers are local hints, not committed data. Only
	// ignore these two known files; every binary artifact must match exactly.
	for _, dir := range []string{stage, final} {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			name := entry.Name()
			if name == slabMetadataFileName || name == mode2SlabCompleteMarker {
				continue
			}
			if entry.IsDir() || !strings.HasSuffix(name, ".bin") {
				return fmt.Errorf("%w: unexpected artifact %s", errGenerationConflict, name)
			}
			same, err := sameArtifactFiles(filepath.Join(stage, name), filepath.Join(final, name))
			if err != nil || !same {
				return fmt.Errorf("%w: %s", errGenerationConflict, name)
			}
		}
	}
	return os.RemoveAll(stage)
}

func releaseGenerationUse(path string, use *generationUse) {
	if use.refs == 0 && use.watchers == 0 {
		delete(generationLifecycle.uses, path)
	}
}

func leaseGenerationPaths(paths ...string) (func(), error) {
	unique := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		if path == "" {
			return func() {}, fmt.Errorf("empty generation path")
		}
		absolute, err := filepath.Abs(path)
		if err != nil {
			return func() {}, err
		}
		unique[absolute] = struct{}{}
	}
	generationLifecycle.Lock()
	missing := 0
	for path := range unique {
		use := generationLifecycle.uses[path]
		if use != nil && use.publishing {
			generationLifecycle.Unlock()
			return func() {}, fmt.Errorf("generation publication is in progress")
		}
		if use == nil {
			missing++
		}
	}
	if len(generationLifecycle.uses)+missing > maxGenerationReferences {
		generationLifecycle.Unlock()
		return func() {}, fmt.Errorf("generation reference capacity exhausted")
	}
	for path := range unique {
		use := generationLifecycle.uses[path]
		if use == nil {
			use = &generationUse{}
			generationLifecycle.uses[path] = use
		}
		use.refs++
		use.revision++
	}
	generationLifecycle.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			generationLifecycle.Lock()
			defer generationLifecycle.Unlock()
			for path := range unique {
				use := generationLifecycle.uses[path]
				use.refs--
				releaseGenerationUse(path, use)
			}
		})
	}, nil
}

func openDealGeneration(dealID uint64, root ManifestRoot, raw string) (string, func(), error) {
	paths := append([]string{dealScopedDir(dealID, root)}, legacyGenerationPaths(root, raw)...)
	release, err := leaseGenerationPaths(paths...)
	if err != nil {
		return "", release, err
	}
	dir, err := resolveDealDirForDeal(dealID, root, raw)
	return dir, release, err
}

func openFrozenGeneration(dealID uint64, root ManifestRoot) (string, func(), error) {
	paths := append([]string{dealScopedDir(dealID, root)}, legacyGenerationPaths(root, root.Canonical)...)
	release, err := leaseGenerationPaths(paths...)
	if err != nil {
		return "", release, err
	}
	// C2 and authenticated bytes supply readiness/layout. A sidecar cannot
	// redirect a secured response or trigger repeated full metadata work.
	dir, err := lookupDealGeneration(dealID, root, root.Canonical)
	if err != nil {
		release()
		return "", func() {}, err
	}
	return dir, release, err
}

func openLegacyGeneration(root ManifestRoot, raw string) (string, func(), error) {
	release, err := leaseGenerationPaths(legacyGenerationPaths(root, raw)...)
	if err != nil {
		return "", release, err
	}
	dir, err := resolveDealDir(root, raw)
	return dir, release, err
}

type generationCandidate struct {
	deal     uint64
	root     ManifestRoot
	path     string
	info     os.FileInfo
	use      *generationUse
	revision uint64
}

func watchGeneration(deal uint64, root ManifestRoot) (*generationCandidate, error) {
	path, err := filepath.Abs(dealScopedDir(deal, root))
	if err != nil {
		return nil, err
	}
	generationLifecycle.Lock()
	defer generationLifecycle.Unlock()
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() {
		return nil, fmt.Errorf("generation is not a directory: %s", path)
	}
	use := generationLifecycle.uses[path]
	if use == nil {
		if len(generationLifecycle.uses) == maxGenerationReferences {
			return nil, fmt.Errorf("generation reference capacity exhausted")
		}
		use = &generationUse{}
		generationLifecycle.uses[path] = use
	}
	use.watchers++
	return &generationCandidate{deal, root, path, info, use, use.revision}, nil
}

func (c *generationCandidate) close() {
	generationLifecycle.Lock()
	defer generationLifecycle.Unlock()
	c.use.watchers--
	releaseGenerationUse(c.path, c.use)
}

// Only a revalidated inode is moved to a private quarantine. Removal happens
// outside the mutex and cannot reach a newly published directory at c.path.
func (c *generationCandidate) remove(snapshot *retentionSnapshot) error {
	if _, keep := snapshot.Keep[retainedRootKey{c.deal, c.root.Bytes}]; keep {
		return nil
	}
	generationLifecycle.Lock()
	if c.use.refs != 0 || c.use.revision != c.revision {
		generationLifecycle.Unlock()
		return nil
	}
	info, err := os.Lstat(c.path)
	if err != nil || !info.IsDir() || !os.SameFile(c.info, info) || !info.ModTime().Equal(c.info.ModTime()) {
		generationLifecycle.Unlock()
		return nil
	}
	// An unexplained lock might belong to a slow or different process. Age is
	// not proof of abandonment, and startup never breaks it.
	lock := filepath.Join(filepath.Dir(c.path), "."+c.root.Key+".lock")
	if _, err := os.Lstat(lock); !errors.Is(err, os.ErrNotExist) {
		generationLifecycle.Unlock()
		return nil
	}
	quarantine, err := os.MkdirTemp(filepath.Dir(c.path), ".gc-")
	if err != nil {
		generationLifecycle.Unlock()
		return err
	}
	err = os.Rename(c.path, filepath.Join(quarantine, "generation"))
	generationLifecycle.Unlock()
	if err != nil {
		_ = os.Remove(quarantine)
		return err
	}
	return os.RemoveAll(quarantine)
}

func reconcileDealGenerations(ctx context.Context, dealIDs []uint64) error {
	select {
	case generationMaintenance <- struct{}{}:
		defer func() { <-generationMaintenance }()
	default:
		return nil // One maintenance pass already owns the bounded query/scan.
	}
	if len(dealIDs) == 0 || len(dealIDs) > maxRetentionDealsPerPass {
		return fmt.Errorf("invalid retention pass size")
	}
	var candidates []*generationCandidate
	defer func() {
		for _, candidate := range candidates {
			candidate.close()
		}
	}()
	for _, deal := range dealIDs {
		dir, err := os.Open(dealScopedBaseDir(deal))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		entries, err := dir.ReadDir(maxGenerationReferences + 1)
		_ = dir.Close()
		if (err != nil && !errors.Is(err, io.EOF)) || len(entries) > maxGenerationReferences {
			return fmt.Errorf("generation directory inventory unavailable or exceeds bound")
		}
		for _, entry := range entries {
			if !entry.IsDir() || !isManifestRootDirName(entry.Name()) {
				continue // Unknown stages/locks are preserved; their owner cleans them.
			}
			root, _ := parseManifestRoot(entry.Name())
			candidate, err := watchGeneration(deal, root)
			if err != nil {
				return err
			}
			candidates = append(candidates, candidate)
		}
	}
	snapshot, err := fetchRetentionSnapshot(ctx, dealIDs)
	if err != nil {
		return err // No mutations, including pointer changes, before full authority.
	}
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return err
		}
		if _, keep := snapshot.Keep[retainedRootKey{candidate.deal, candidate.root.Bytes}]; keep {
			continue
		}
		// Preserve provisional uploads through their grace period. TTL can delay
		// collection, but cannot override current/session/audit retention.
		meta, err := readSlabMetadataFile(candidate.path)
		if err != nil {
			continue // Ambiguous/incomplete data needs repair, not guessed deletion.
		}
		if meta.GenerationState == slabGenerationStateProvisional {
			created, err := time.Parse(time.RFC3339Nano, meta.CreatedAt)
			ttl := configuredProvisionalGenerationRetentionTTL()
			if err != nil || ttl <= 0 || time.Since(created) <= ttl {
				continue
			}
		}
		if err := candidate.remove(snapshot); err != nil {
			log.Printf("Generation retention: deal_id=%d collection failed: %v", candidate.deal, err)
		}
	}
	for deal, current := range snapshot.Current {
		if len(current.ManifestRoot) != 32 {
			continue
		}
		root, _ := parseManifestRoot(fmt.Sprintf("%x", current.ManifestRoot))
		if err := validateDealGenerationReadyStrict(dealScopedDir(deal, root)); err != nil {
			continue
		}
		generationLifecycle.Lock()
		err := writeActiveDealGeneration(deal, root)
		generationLifecycle.Unlock()
		if err != nil {
			return err
		}
	}
	return nil
}
