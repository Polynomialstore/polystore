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
	
	ctx, cancel := context.WithTimeout(context.Background(), cmdTimeout)
	defer cancel()
	cmd := execNilCli(
		ctx,
		"--trusted-setup", trustedSetup,
		"aggregate",
		"--roots-file", tmpRoots.Name(),
		"--out", tmpOut,
	)
	
	if out, err := cmd.CombinedOutput(); err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return "", "", fmt.Errorf("nil_cli aggregate timed out after %s", cmdTimeout)
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
