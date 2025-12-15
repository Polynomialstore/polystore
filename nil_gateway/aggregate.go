package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

type NilCliAggregateOutput struct {
	ManifestRootHex string `json:"manifest_root_hex"`
	ManifestBlobHex string `json:"manifest_blob_hex"`
}

// aggregateRoots calls `nil_cli aggregate --roots <file> --out <out>`.
// roots is a list of hex strings (e.g. "0x...")
func aggregateRoots(roots []string) (string, string, error) {
	return aggregateRootsWithContext(context.Background(), roots)
}

func aggregateRootsWithContext(ctx context.Context, roots []string) (string, string, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	tmpRoots, err := os.CreateTemp(uploadDir, "roots-*.json")
	if err != nil {
		return "", "", err
	}
	defer os.Remove(tmpRoots.Name())

	if err := json.NewEncoder(tmpRoots).Encode(roots); err != nil {
		return "", "", err
	}
	tmpRoots.Close()

	tmpOut := tmpRoots.Name() + ".out.json"
	defer os.Remove(tmpOut)

	execCtx, cancel := context.WithTimeout(ctx, cmdTimeout)
	defer cancel()
	cmd := execNilCli(
		execCtx,
		"--trusted-setup", trustedSetup,
		"aggregate",
		"--roots-file", tmpRoots.Name(),
		"--out", tmpOut,
	)

	if out, err := cmd.CombinedOutput(); err != nil {
		if errors.Is(execCtx.Err(), context.DeadlineExceeded) {
			return "", "", fmt.Errorf("nil_cli aggregate timed out after %s: %w", cmdTimeout, execCtx.Err())
		}
		if errors.Is(execCtx.Err(), context.Canceled) {
			return "", "", execCtx.Err()
		}
		return "", "", fmt.Errorf("aggregate failed: %s: %w", string(out), err)
	}

	data, err := os.ReadFile(tmpOut)
	if err != nil {
		return "", "", err
	}

	var res NilCliAggregateOutput
	if err := json.Unmarshal(data, &res); err != nil {
		return "", "", err
	}

	return res.ManifestRootHex, res.ManifestBlobHex, nil
}
