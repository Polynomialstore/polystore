package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

type keyringListItem struct {
	Name    string `json:"name"`
	Address string `json:"address"`
}

// resolveKeyNameForAddress maps a bech32 address to a local key name in the test keyring.
// If addrOrName already looks like a key name, it is returned unchanged.
func resolveKeyNameForAddress(ctx context.Context, addrOrName string) (string, error) {
	signer := strings.TrimSpace(addrOrName)
	if signer == "" {
		return "", fmt.Errorf("empty signer")
	}
	// If it doesn't look like a nil bech32 address, assume it's already a key name.
	if !strings.HasPrefix(signer, "nil1") {
		return signer, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}

	cctx, cancel := context.WithTimeout(ctx, cmdTimeout)
	defer cancel()

	out, err := execNilchaind(
		cctx,
		"keys", "list",
		"--home", homeDir,
		"--keyring-backend", "test",
		"--output", "json",
	)
	if errors.Is(cctx.Err(), context.DeadlineExceeded) {
		return "", fmt.Errorf("keys list timed out after %s", cmdTimeout)
	}
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			combined := append(out, ee.Stderr...)
			return "", fmt.Errorf("keys list failed: %v (%s)", err, strings.TrimSpace(string(combined)))
		}
		return "", fmt.Errorf("keys list failed: %v (%s)", err, strings.TrimSpace(string(out)))
	}

	clean := extractJSONBody(out)
	if len(clean) == 0 {
		clean = out
	}

	var items []keyringListItem
	if uerr := json.Unmarshal(clean, &items); uerr != nil {
		// Some keyring outputs wrap the list.
		var wrapped struct {
			Keys []keyringListItem `json:"keys"`
		}
		if uerr2 := json.Unmarshal(clean, &wrapped); uerr2 != nil {
			return "", fmt.Errorf("keys list returned non-json (%v): %s", uerr, strings.TrimSpace(string(out)))
		}
		items = wrapped.Keys
	}

	for _, item := range items {
		if strings.TrimSpace(item.Address) == signer && strings.TrimSpace(item.Name) != "" {
			return strings.TrimSpace(item.Name), nil
		}
	}

	// Keep the error actionable for e2e runs.
	names := make([]string, 0, len(items))
	for _, item := range items {
		if item.Name != "" {
			names = append(names, item.Name)
		}
		if len(names) >= 10 {
			break
		}
	}
	return "", fmt.Errorf("no local key for address %s (available: %s)", signer, strings.Join(names, ", "))
}
