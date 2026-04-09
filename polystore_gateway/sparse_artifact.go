package main

import (
	"fmt"
	"os"
	"path/filepath"
)

func sparseArtifactSendSize(payload []byte, fullSize int64) (int64, error) {
	if fullSize < 0 {
		return 0, fmt.Errorf("fullSize must be non-negative")
	}
	if int64(len(payload)) > fullSize {
		return 0, fmt.Errorf("payload exceeds fullSize: %d > %d", len(payload), fullSize)
	}
	if fullSize == 0 {
		return 0, nil
	}
	for i := len(payload) - 1; i >= 0; i-- {
		if payload[i] != 0 {
			return int64(i + 1), nil
		}
	}
	// Match the browser/provider sparse contract: non-empty logical artifacts keep
	// a non-empty body so callers can distinguish intentional zero-filled content
	// from a missing file more easily during debugging and manual inspection.
	return 1, nil
}

func writeSparseArtifactFile(path string, payload []byte, fullSize int64, perm os.FileMode) error {
	sendSize, err := sparseArtifactSendSize(payload, fullSize)
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	base := filepath.Base(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	tmp, err := os.CreateTemp(dir, base+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	committed := false
	defer func() {
		_ = tmp.Close()
		if !committed {
			_ = os.Remove(tmpPath)
		}
	}()

	if err := tmp.Chmod(perm); err != nil {
		return err
	}
	if sendSize > 0 {
		body := payload
		if int64(len(body)) > sendSize {
			body = body[:sendSize]
		}
		if _, err := tmp.Write(body); err != nil {
			return err
		}
	}
	if fullSize > sendSize {
		if err := tmp.Truncate(fullSize); err != nil {
			return err
		}
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return err
	}
	committed = true
	return nil
}
