package main

import (
	"context"
	"testing"
)

func TestResolveKeyNameForAddressAcceptsJSONArray(t *testing.T) {
	oldMock := mockCombinedOutput
	mockCombinedOutput = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if len(args) < 2 || args[0] != "keys" || args[1] != "list" {
			t.Fatalf("unexpected command: %v", args)
		}
		return []byte(`[{"name":"provider12","address":"nil1assigned"}]`), nil
	}
	t.Cleanup(func() { mockCombinedOutput = oldMock })

	got, err := resolveKeyNameForAddress(context.Background(), "nil1assigned")
	if err != nil {
		t.Fatal(err)
	}
	if got != "provider12" {
		t.Fatalf("got key %q, want provider12", got)
	}
}
