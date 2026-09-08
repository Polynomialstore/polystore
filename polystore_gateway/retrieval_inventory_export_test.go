package main

// Opt-in offline artifact producer for the owned four-validator harness. This
// adds no runtime endpoint. The harness independently validates committed intent
// and anchor evidence before and after consuming the exported files.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/cosmos/gogoproto/jsonpb"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

type inventoryExportItem struct {
	ArtifactDirectory string          `json:"artifact_directory"`
	OutputPath        string          `json:"output_path"`
	SessionID         string          `json:"session_id"`
	Expected          json.RawMessage `json:"expected"`
	Evidence          struct {
		Height uint64          `json:"height"`
		View   json.RawMessage `json:"view"`
		Anchor struct {
			BlockID struct {
				Hash string `json:"hash"`
			} `json:"block_id"`
			Block struct {
				Header struct {
					Height  string `json:"height"`
					ChainID string `json:"chain_id"`
				} `json:"header"`
			} `json:"block"`
		} `json:"anchor"`
	} `json:"evidence"`
}

type inventoryExportManifest struct {
	ChainID        string                `json:"chain_id"`
	TrustedSetup   string                `json:"trusted_setup"`
	DeadlineUnixMS int64                 `json:"deadline_unix_ms"`
	Sessions       []inventoryExportItem `json:"sessions"`
}

type inventoryExportResult struct {
	SessionID    string  `json:"session_id"`
	ProofPath    string  `json:"proof_path"`
	ProofSHA256  string  `json:"proof_sha256"`
	ContextHash  string  `json:"context_hash"`
	Seed         string  `json:"seed"`
	WindowSHA256 string  `json:"window_sha256"`
	GenerationMS float64 `json:"generation_ms"`
}

func freezeInventoryExport(item inventoryExportItem) (*frozenRetrievalSession, error) {
	var view types.QueryGetRetrievalSessionResponse
	if len(item.Evidence.View) > maxSessionQueryBytes {
		return nil, fmt.Errorf("oversized session view")
	}
	if err := jsonpb.Unmarshal(bytes.NewReader(item.Evidence.View), &view); err != nil {
		return nil, err
	}
	f, err := freezeRetrievalSessionResponse(&view, item.Evidence.Height)
	if err != nil {
		return nil, err
	}
	if item.SessionID != hex.EncodeToString(f.Context.ID[:]) || f.Height > f.Context.Window.Deadline {
		return nil, fmt.Errorf("wrong session identity or expired evidence")
	}
	if view.Session.Status != types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_OPEN && view.Session.Status != types.RetrievalSessionStatus_RETRIEVAL_SESSION_STATUS_USER_CONFIRMED {
		return nil, fmt.Errorf("session is not awaiting proof")
	}
	anchor := item.Evidence.Anchor
	height, err := strconv.ParseUint(anchor.Block.Header.Height, 10, 64)
	seed, seedErr := hex.DecodeString(anchor.BlockID.Hash)
	if err != nil || height != f.Context.Window.Anchor || anchor.Block.Header.ChainID != chainID || seedErr != nil || !bytes.Equal(seed, f.Seed[:]) {
		return nil, fmt.Errorf("seed differs from retained committed anchor")
	}
	return f, nil
}

func writeInventoryExclusive(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if syncErr != nil {
		return syncErr
	}
	return closeErr
}

func TestExportFrozenRetrievalInventory(t *testing.T) {
	manifestPath := os.Getenv("POLYSTORE_RETRIEVAL_EXPORT_MANIFEST")
	if manifestPath == "" {
		t.Skip("explicit owned inventory manifest required")
	}
	if !filepath.IsAbs(manifestPath) {
		t.Fatal("manifest path must be absolute")
	}
	file, err := os.Open(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(io.LimitReader(file, 32*1024*1024+1))
	file.Close()
	if err != nil || len(raw) > 32*1024*1024 {
		t.Fatal("manifest exceeds bound or cannot be read")
	}
	var manifest inventoryExportManifest
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	if decoder.Decode(new(any)) != io.EOF {
		t.Fatal("trailing manifest data")
	}
	deadline := time.UnixMilli(manifest.DeadlineUnixMS)
	if len(manifest.Sessions) < 1 || len(manifest.Sessions) > 1700 || !deadline.After(time.Now()) || time.Until(deadline) > 2*time.Hour || !filepath.IsAbs(manifest.TrustedSetup) || manifest.ChainID == "" {
		t.Fatal("invalid bounded inventory")
	}
	previousChain := chainID
	chainID = manifest.ChainID
	defer func() { chainID = previousChain }()
	if err := crypto_ffi.Init(manifest.TrustedSetup); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	seen := map[string]bool{}
	results := make([]inventoryExportResult, 0, len(manifest.Sessions))
	for _, item := range manifest.Sessions {
		if ctx.Err() != nil {
			t.Fatal(ctx.Err())
		}
		if !filepath.IsAbs(item.ArtifactDirectory) || !filepath.IsAbs(item.OutputPath) || seen[item.SessionID] || seen[item.OutputPath] {
			t.Fatal("invalid or duplicate inventory identity/path")
		}
		seen[item.SessionID], seen[item.OutputPath] = true, true
		f, err := freezeInventoryExport(item)
		if err != nil {
			t.Fatal(err)
		}
		// This measurement reads owned complete artifacts. Missing slots must fail,
		// not trigger network reconstruction inside a proof-only preparation stage.
		shard := filepath.Join(item.ArtifactDirectory, fmt.Sprintf("mdu_%d_slot_%d.bin", f.Context.StartMDU, f.Context.Slot))
		if info, err := os.Stat(shard); err != nil || info.Size() != int64(64/f.Context.K)*types.BLOB_SIZE {
			t.Fatal("missing or wrong-size owned slot artifact")
		}
		started := time.Now()
		proofs, window, err := generateFrozenSessionProof(ctx, item.ArtifactDirectory, f)
		if err != nil {
			t.Fatal(err)
		}
		elapsed := time.Since(started)
		if ctx.Err() != nil {
			t.Fatal(ctx.Err())
		}
		payload := struct {
			SessionID []byte               `json:"session_id"`
			Proofs    []types.ChainedProof `json:"proofs"`
		}{f.Context.ID[:], proofs}
		if err := writeInventoryExclusive(item.OutputPath, payload); err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(payload)
		proofHash, windowHash := sha256.Sum256(encoded), sha256.Sum256(window)
		results = append(results, inventoryExportResult{item.SessionID, item.OutputPath, hex.EncodeToString(proofHash[:]), hex.EncodeToString(f.Hash[:]), hex.EncodeToString(f.Seed[:]), hex.EncodeToString(windowHash[:]), float64(elapsed) / float64(time.Millisecond)})
	}
	if err := writeInventoryExclusive(manifestPath+".result.json", struct {
		Proofs []inventoryExportResult `json:"proofs"`
	}{results}); err != nil {
		t.Fatal(err)
	}
}

func TestInventoryExportRejectsChangedAuthorityAndOverwrite(t *testing.T) {
	r := testFrozenSession(t)
	var encoded bytes.Buffer
	if err := (&jsonpb.Marshaler{}).Marshal(&encoded, &r); err != nil {
		t.Fatal(err)
	}
	item := inventoryExportItem{SessionID: hex.EncodeToString(r.Session.SessionId)}
	item.Evidence.Height = 12
	item.Evidence.View = encoded.Bytes()
	item.Evidence.Anchor.BlockID.Hash = hex.EncodeToString(r.ChallengeSeed)
	item.Evidence.Anchor.Block.Header.Height = strconv.FormatInt(r.Session.OpenedHeight+1, 10)
	item.Evidence.Anchor.Block.Header.ChainID = chainID
	if _, err := freezeInventoryExport(item); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*inventoryExportItem){
		func(i *inventoryExportItem) { i.SessionID = "00" },
		func(i *inventoryExportItem) { i.Evidence.Height = 1 },
		func(i *inventoryExportItem) { i.Evidence.Anchor.BlockID.Hash = "00" },
		func(i *inventoryExportItem) { i.Evidence.Anchor.Block.Header.ChainID = "other" },
		func(i *inventoryExportItem) { i.Evidence.Anchor.Block.Header.Height = "999" },
	} {
		bad := item
		change(&bad)
		if _, err := freezeInventoryExport(bad); err == nil {
			t.Fatal("accepted altered authority")
		}
	}
	path := filepath.Join(t.TempDir(), "proof.json")
	if err := writeInventoryExclusive(path, "first"); err != nil {
		t.Fatal(err)
	}
	if err := writeInventoryExclusive(path, "replacement"); err == nil {
		t.Fatal("overwrote existing proof")
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != `"first"` {
		t.Fatal("changed retained proof")
	}
}
