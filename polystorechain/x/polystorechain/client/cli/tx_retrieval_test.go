package cli

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
)

func TestDecodeHexBytes(t *testing.T) {
	value := "0x" + strings.Repeat("11", 48)
	out, err := decodeHexBytes(value, 48)
	if err != nil {
		t.Fatalf("decodeHexBytes failed: %v", err)
	}
	if len(out) != 48 {
		t.Fatalf("expected 48 bytes, got %d", len(out))
	}

	_, err = decodeHexBytes("0x"+strings.Repeat("22", 16), 48)
	if err == nil {
		t.Fatal("expected error for invalid length")
	}
}

func TestDecodeSessionID(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	hexStr := hex.EncodeToString(raw)
	for _, input := range []string{hexStr, "0x" + hexStr} {
		out, err := decodeSessionID(input)
		if err != nil {
			t.Fatalf("decodeSessionID hex failed: %v", err)
		}
		if !bytes.Equal(out, raw) {
			t.Fatalf("decodeSessionID hex mismatch")
		}
	}

	for _, input := range []string{
		base64.StdEncoding.EncodeToString(raw),
		base64.RawStdEncoding.EncodeToString(raw),
	} {
		out, err := decodeSessionID(input)
		if err != nil {
			t.Fatalf("decodeSessionID base64 failed: %v", err)
		}
		if !bytes.Equal(out, raw) {
			t.Fatalf("decodeSessionID base64 mismatch")
		}
	}

	_, err := decodeSessionID("0x1234")
	if err == nil {
		t.Fatal("expected error for invalid session id")
	}
}
