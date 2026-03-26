package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"nilchain/x/nilchain/types"
)

const (
	spUploadBundleKindMDU      = "mdu"
	spUploadBundleKindShard    = "shard"
	spUploadBundleKindManifest = "manifest"
)

type spUploadBundleRequest struct {
	DealID               uint64                   `json:"deal_id"`
	ManifestRoot         string                   `json:"manifest_root"`
	PreviousManifestRoot string                   `json:"previous_manifest_root,omitempty"`
	Artifacts            []spUploadBundleArtifact `json:"artifacts"`
}

type spUploadBundleArtifact struct {
	Part     string  `json:"part"`
	Kind     string  `json:"kind"`
	MduIndex *uint64 `json:"mdu_index,omitempty"`
	Slot     *uint64 `json:"slot,omitempty"`
	FullSize int64   `json:"full_size"`
	SendSize int64   `json:"send_size,omitempty"`
}

type spUploadBundleResolvedArtifact struct {
	meta       spUploadBundleArtifact
	filename   string
	fullSize   int64
	sendSize   int64
	maxBodyLen int64
}

func (a spUploadBundleArtifact) resolve() (spUploadBundleResolvedArtifact, error) {
	part := strings.TrimSpace(a.Part)
	if part == "" {
		return spUploadBundleResolvedArtifact{}, fmt.Errorf("artifact part is required")
	}

	kind := strings.TrimSpace(a.Kind)
	if kind == "" {
		return spUploadBundleResolvedArtifact{}, fmt.Errorf("artifact kind is required")
	}

	sendSize := a.SendSize
	if sendSize == 0 {
		sendSize = a.FullSize
	}
	if sendSize < 0 {
		return spUploadBundleResolvedArtifact{}, fmt.Errorf("artifact send_size must be non-negative")
	}

	resolved := spUploadBundleResolvedArtifact{meta: a, sendSize: sendSize}

	switch kind {
	case spUploadBundleKindMDU:
		if a.MduIndex == nil {
			return spUploadBundleResolvedArtifact{}, fmt.Errorf("mdu artifact missing mdu_index")
		}
		if a.FullSize != int64(types.MDU_SIZE) {
			return spUploadBundleResolvedArtifact{}, fmt.Errorf("mdu artifact full_size must be %d", types.MDU_SIZE)
		}
		resolved.filename = fmt.Sprintf("mdu_%d.bin", *a.MduIndex)
		resolved.fullSize = a.FullSize
		resolved.maxBodyLen = a.FullSize
	case spUploadBundleKindShard:
		if a.MduIndex == nil || a.Slot == nil {
			return spUploadBundleResolvedArtifact{}, fmt.Errorf("shard artifact missing mdu_index or slot")
		}
		if a.FullSize <= 0 || a.FullSize > int64(types.MDU_SIZE) {
			return spUploadBundleResolvedArtifact{}, fmt.Errorf("shard artifact full_size must be between 1 and %d", types.MDU_SIZE)
		}
		resolved.filename = fmt.Sprintf("mdu_%d_slot_%d.bin", *a.MduIndex, *a.Slot)
		resolved.fullSize = a.FullSize
		resolved.maxBodyLen = a.FullSize
	case spUploadBundleKindManifest:
		if a.FullSize != int64(types.BLOB_SIZE) {
			return spUploadBundleResolvedArtifact{}, fmt.Errorf("manifest artifact full_size must be %d", types.BLOB_SIZE)
		}
		resolved.filename = "manifest.bin"
		resolved.fullSize = a.FullSize
		resolved.maxBodyLen = a.FullSize
	default:
		return spUploadBundleResolvedArtifact{}, fmt.Errorf("unsupported artifact kind %q", kind)
	}

	if resolved.sendSize <= 0 || resolved.sendSize > resolved.fullSize {
		return spUploadBundleResolvedArtifact{}, fmt.Errorf("artifact send_size must be between 1 and full_size")
	}
	return resolved, nil
}

func copyBundleArtifactPart(tmp *os.File, part *multipart.Part, resolved spUploadBundleResolvedArtifact, profile *mode2UploadProfile) (int64, error) {
	limited := io.LimitReader(part, resolved.sendSize+1)
	copyStarted := time.Now()
	n, err := copyUploadBody(tmp, limited)
	if profile != nil {
		profile.addDuration("body_copy_ms", time.Since(copyStarted))
	}
	if err != nil {
		return n, err
	}
	if n != resolved.sendSize {
		if n > resolved.sendSize {
			return n, fmt.Errorf("artifact %s exceeded declared send_size", resolved.meta.Part)
		}
		return n, fmt.Errorf("artifact %s shorter than declared send_size", resolved.meta.Part)
	}
	return n, nil
}

func SpUploadBundle(w http.ResponseWriter, r *http.Request) {
	uploadStarted := time.Now()
	profile := newMode2UploadProfile()
	statusCode := http.StatusOK
	outcome := "ok"
	storedPath := ""
	var dealID uint64
	defer func() {
		logMode2UploadProfile("SpUploadBundle", uploadStarted, dealID, storedPath, outcome, statusCode, profile)
		releaseMode2UploadProfile(profile)
	}()

	setCORS(w)
	if r.Method == http.MethodOptions {
		statusCode = http.StatusNoContent
		w.WriteHeader(http.StatusNoContent)
		return
	}

	mr, err := r.MultipartReader()
	if err != nil {
		statusCode = http.StatusBadRequest
		outcome = "invalid_multipart"
		http.Error(w, "invalid multipart form", http.StatusBadRequest)
		return
	}

	metaPart, err := mr.NextPart()
	if err != nil {
		statusCode = http.StatusBadRequest
		outcome = "missing_meta"
		http.Error(w, "bundle meta part is required", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(metaPart.FormName()) != "meta" {
		_ = metaPart.Close()
		statusCode = http.StatusBadRequest
		outcome = "invalid_meta_part"
		http.Error(w, "first multipart part must be meta", http.StatusBadRequest)
		return
	}

	metaBytes, err := io.ReadAll(io.LimitReader(metaPart, 1<<20))
	_ = metaPart.Close()
	if err != nil {
		statusCode = http.StatusBadRequest
		outcome = "invalid_meta"
		http.Error(w, "failed to read bundle meta", http.StatusBadRequest)
		return
	}

	var req spUploadBundleRequest
	if err := json.Unmarshal(metaBytes, &req); err != nil {
		statusCode = http.StatusBadRequest
		outcome = "invalid_meta_json"
		http.Error(w, "invalid bundle meta", http.StatusBadRequest)
		return
	}

	dealID = req.DealID
	if dealID == 0 {
		statusCode = http.StatusBadRequest
		outcome = "invalid_deal_id"
		http.Error(w, "invalid deal_id", http.StatusBadRequest)
		return
	}

	clientManifestRoot := strings.TrimSpace(req.ManifestRoot)
	if clientManifestRoot == "" {
		statusCode = http.StatusBadRequest
		outcome = "missing_manifest_root"
		http.Error(w, "manifest_root is required", http.StatusBadRequest)
		return
	}

	if len(req.Artifacts) == 0 {
		statusCode = http.StatusBadRequest
		outcome = "missing_artifacts"
		http.Error(w, "bundle artifacts are required", http.StatusBadRequest)
		return
	}
	profile.setCount("artifact_count", uint64(len(req.Artifacts)))

	parsed, err := parseManifestRoot(clientManifestRoot)
	if err != nil {
		statusCode = http.StatusBadRequest
		outcome = "invalid_manifest_root"
		http.Error(w, "invalid manifest root", http.StatusBadRequest)
		return
	}

	validatePrevStarted := time.Now()
	if err := validateNilfsUploadPreviousManifestRoot(r.Context(), dealID, clientManifestRoot, strings.TrimSpace(req.PreviousManifestRoot)); err != nil {
		profile.addDuration("validate_previous_root_ms", time.Since(validatePrevStarted))
		statusCode = classifyNilfsUploadPreviousManifestRootError(err)
		switch statusCode {
		case http.StatusBadRequest:
			outcome = "validate_previous_root_failed"
			http.Error(w, err.Error(), statusCode)
		case http.StatusNotFound:
			outcome = "deal_not_found"
			http.Error(w, "deal not found", statusCode)
		case http.StatusConflict:
			outcome = "validate_previous_root_failed"
			http.Error(w, err.Error(), statusCode)
		default:
			log.Printf("SpUploadBundle: failed to validate deal %d previous root: %v", dealID, err)
			outcome = "validate_previous_root_failed"
			http.Error(w, "failed to validate deal", statusCode)
		}
		return
	}
	profile.addDuration("validate_previous_root_ms", time.Since(validatePrevStarted))

	rootDir := dealScopedDir(dealID, parsed)
	mkdirStarted := time.Now()
	if err := ensureUploadRootDir(rootDir); err != nil {
		profile.addDuration("mkdir_all_ms", time.Since(mkdirStarted))
		statusCode = http.StatusInternalServerError
		outcome = "mkdir_failed"
		http.Error(w, "failed to create slab directory", http.StatusInternalServerError)
		return
	}
	profile.addDuration("mkdir_all_ms", time.Since(mkdirStarted))

	artifactsByPart := make(map[string]spUploadBundleResolvedArtifact, len(req.Artifacts))
	seenFilenames := make(map[string]struct{}, len(req.Artifacts))
	for _, artifact := range req.Artifacts {
		resolved, err := artifact.resolve()
		if err != nil {
			statusCode = http.StatusBadRequest
			outcome = "invalid_artifact_meta"
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if _, exists := artifactsByPart[resolved.meta.Part]; exists {
			statusCode = http.StatusBadRequest
			outcome = "duplicate_artifact_part"
			http.Error(w, "duplicate bundle artifact part", http.StatusBadRequest)
			return
		}
		if _, exists := seenFilenames[resolved.filename]; exists {
			statusCode = http.StatusBadRequest
			outcome = "duplicate_artifact_target"
			http.Error(w, "duplicate bundle artifact target", http.StatusBadRequest)
			return
		}
		artifactsByPart[resolved.meta.Part] = resolved
		seenFilenames[resolved.filename] = struct{}{}
		switch resolved.meta.Kind {
		case spUploadBundleKindMDU:
			profile.addCount("mdu_artifact_count", 1)
		case spUploadBundleKindShard:
			profile.addCount("shard_artifact_count", 1)
		case spUploadBundleKindManifest:
			profile.addCount("manifest_artifact_count", 1)
		}
	}

	received := make(map[string]struct{}, len(artifactsByPart))
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			statusCode = http.StatusBadRequest
			outcome = "invalid_bundle_part"
			http.Error(w, "invalid multipart form", http.StatusBadRequest)
			return
		}

		partName := strings.TrimSpace(part.FormName())
		if partName == "" {
			_ = part.Close()
			continue
		}

		resolved, ok := artifactsByPart[partName]
		if !ok {
			_ = part.Close()
			statusCode = http.StatusBadRequest
			outcome = "unexpected_artifact_part"
			http.Error(w, "unexpected bundle artifact part", http.StatusBadRequest)
			return
		}
		if _, exists := received[partName]; exists {
			_ = part.Close()
			statusCode = http.StatusBadRequest
			outcome = "duplicate_artifact_part"
			http.Error(w, "duplicate bundle artifact part", http.StatusBadRequest)
			return
		}

		path := filepath.Join(rootDir, resolved.filename)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Size() == resolved.fullSize {
			n, discardErr := io.Copy(io.Discard, io.LimitReader(part, resolved.sendSize+1))
			_ = part.Close()
			if discardErr != nil {
				statusCode = http.StatusInternalServerError
				outcome = "body_copy_failed"
				http.Error(w, "failed to discard existing artifact body", http.StatusInternalServerError)
				return
			}
			if n != resolved.sendSize {
				statusCode = http.StatusBadRequest
				outcome = "artifact_size_mismatch"
				http.Error(w, "bundle artifact size mismatch", http.StatusBadRequest)
				return
			}
			profile.addCount("received_body_bytes", uint64(n))
			profile.addCount("stored_size_bytes", uint64(info.Size()))
			received[partName] = struct{}{}
			storedPath = rootDir
			continue
		}

		tmp, err := createTempInUploadRoot(rootDir, filepath.Base(path)+".tmp-*")
		if err != nil {
			_ = part.Close()
			statusCode = http.StatusInternalServerError
			outcome = "create_temp_failed"
			http.Error(w, "failed to create temp file", http.StatusInternalServerError)
			return
		}
		tmpPath := tmp.Name()
		committed := false
		func() {
			defer func() {
				_ = tmp.Close()
				if !committed {
					_ = os.Remove(tmpPath)
				}
			}()

			n, copyErr := copyBundleArtifactPart(tmp, part, resolved, profile)
			_ = part.Close()
			if copyErr != nil {
				err = copyErr
				return
			}
			profile.addCount("received_body_bytes", uint64(n))

			storedSize := n
			if resolved.fullSize > n {
				truncateStarted := time.Now()
				if truncateErr := tmp.Truncate(resolved.fullSize); truncateErr != nil {
					profile.addDuration("truncate_ms", time.Since(truncateStarted))
					err = truncateErr
					return
				}
				profile.addDuration("truncate_ms", time.Since(truncateStarted))
				storedSize = resolved.fullSize
			}
			profile.addCount("stored_size_bytes", uint64(storedSize))

			closeStarted := time.Now()
			if closeErr := tmp.Close(); closeErr != nil {
				profile.addDuration("close_temp_ms", time.Since(closeStarted))
				err = closeErr
				return
			}
			profile.addDuration("close_temp_ms", time.Since(closeStarted))

			renameStarted := time.Now()
			if renameErr := os.Rename(tmpPath, path); renameErr != nil {
				profile.addDuration("rename_ms", time.Since(renameStarted))
				if info, statErr := os.Stat(path); statErr == nil && info.Mode().IsRegular() && info.Size() == resolved.fullSize {
					received[partName] = struct{}{}
					storedPath = rootDir
					committed = true
					return
				}
				err = renameErr
				return
			}
			profile.addDuration("rename_ms", time.Since(renameStarted))
			received[partName] = struct{}{}
			storedPath = rootDir
			committed = true
		}()
		if err != nil {
			statusCode = http.StatusInternalServerError
			outcome = "artifact_store_failed"
			http.Error(w, "failed to store bundle artifact", http.StatusInternalServerError)
			return
		}
	}

	if len(received) != len(artifactsByPart) {
		statusCode = http.StatusBadRequest
		outcome = "missing_artifact_part"
		http.Error(w, fmt.Sprintf("bundle incomplete: received %d/%d artifacts", len(received), len(artifactsByPart)), http.StatusBadRequest)
		return
	}

	w.WriteHeader(http.StatusOK)
}
