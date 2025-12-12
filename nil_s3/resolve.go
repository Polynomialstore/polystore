package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"nil_s3/pkg/builder"
	"nil_s3/pkg/layout"
)

// ResolveFileByPath locates a file within a deal's slab and returns a reader for its content.
// It assumes MDUs are stored at `uploads/<manifest_root>/mdu_X.bin`.
func ResolveFileByPath(manifestRoot string, filePath string) (io.ReadCloser, uint64, error) {
	// 1. Load MDU #0
	// We assume MDU #0 is stored as "mdu_0.bin" in the deal's directory.
	// But `GatewayUpload` stores temp files?
	// We need a stable storage convention.
	// Let's assume `uploads/<manifest_root>/mdu_0.bin`.

	dealDir := filepath.Join(uploadDir, manifestRoot)
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")

	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to read MDU #0: %w", err)
	}

	// 2. Parse MDU #0
	// We need MaxUserMdus to Init. Store it? Or guess?
	// LoadMdu0Builder calculates W based on MaxUserMdus.
	// If we don't know MaxUserMdus, we can't verify W.
	// But to read FileRecord, we just need to read FileTable region.
	// We can use a simpler parser that just reads records.

	// Use builder to parse file records. MaxUserMdus is not needed for FileTable parsing here,
	// so we pass a small placeholder; Witness count is inferred from on-disk slab.
	b, err := builder.LoadMdu0Builder(mdu0Data, 1)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to parse MDU #0: %w", err)
	}

	// 3. Find Record
	var targetRec *layout.FileRecordV1
	targetPath := strings.TrimPrefix(filePath, "/")

	for i := uint32(0); i < b.Header.RecordCount; i++ {
		rec := b.GetFileRecord(i)
		// Decode path
		name := string(bytes.TrimRight(rec.Path[:], "\x00"))
		if name == targetPath {
			targetRec = &rec
			break
		}
	}

	if targetRec == nil {
		return nil, 0, os.ErrNotExist
	}

	length, _ := layout.UnpackLengthAndFlags(targetRec.LengthAndFlags)
	startOffset := targetRec.StartOffset

	// 4. Construct MultiReader from MDUs
	// User Data starts at MDU # (W + 1)
	// Offset 0 in User Data = Start of MDU #(W+1).

	witnessCount, err := inferWitnessCount(manifestRoot, mdu0Data, b)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to infer witness count: %w", err)
	}

	slabStartIdx := 1 + witnessCount

	// Start MDU for file
	fileStartMdu := startOffset / builder.MduSize
	fileOffsetInMdu := startOffset % builder.MduSize

	// We need to chain readers.
	readers := []io.Reader{}
	closers := []io.Closer{}
	remaining := length
	currentMduRelIdx := fileStartMdu
	currentOffset := fileOffsetInMdu

	for remaining > 0 {
		slabIdx := slabStartIdx + currentMduRelIdx
		mduPath := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", slabIdx))

		f, err := os.Open(mduPath)
		if err != nil {
			// Close previous?
			return nil, 0, fmt.Errorf("failed to open MDU %d: %w", slabIdx, err)
		}
		closers = append(closers, f)

		// We can't easily close these if we return a MultiReader.
		// We need a custom ReadCloser that closes all files.
		// For now, let's just ReadAll into memory? No, large files.

		// Let's implement a lazy reader or assume OS handles it? No.
		// Simple approach: One file at a time.

		// Calculate bytes to read from this MDU
		available := builder.MduSize - currentOffset
		toRead := available
		if remaining < toRead {
			toRead = remaining
		}

		// Seek
		f.Seek(int64(currentOffset), 0)

		// LimitReader
		lr := io.LimitReader(f, int64(toRead))
		readers = append(readers, lr)

		remaining -= toRead
		currentMduRelIdx++
		currentOffset = 0

		// Leak: 'f' is never closed!
		// Solution: use a composite ReadCloser.
	}

	return &MultiReadCloser{readers: readers, closers: closers}, length, nil
}

// GetFileLocation returns the MDU index and physical path for the start of a file.
func GetFileLocation(manifestRoot, filePath string) (mduIndex uint64, mduPath string, length uint64, err error) {
	dealDir := filepath.Join(uploadDir, manifestRoot)
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")

	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		return 0, "", 0, fmt.Errorf("failed to read MDU #0: %w", err)
	}

	b, err := builder.LoadMdu0Builder(mdu0Data, 1)
	if err != nil {
		return 0, "", 0, fmt.Errorf("failed to parse MDU #0: %w", err)
	}

	targetPath := strings.TrimPrefix(filePath, "/")
	var targetRec *layout.FileRecordV1
	for i := uint32(0); i < b.Header.RecordCount; i++ {
		rec := b.GetFileRecord(i)
		name := string(bytes.TrimRight(rec.Path[:], "\x00"))
		if name == targetPath {
			targetRec = &rec
			break
		}
	}

	if targetRec == nil {
		return 0, "", 0, os.ErrNotExist
	}

	length, _ = layout.UnpackLengthAndFlags(targetRec.LengthAndFlags)
	startOffset := targetRec.StartOffset

	witnessCount, err := inferWitnessCount(manifestRoot, mdu0Data, b)
	if err != nil {
		return 0, "", 0, fmt.Errorf("failed to infer witness count: %w", err)
	}

	// Slab Index = 1 + WitnessCount + (StartOffset / 8MB)
	mduIdx := 1 + witnessCount + (startOffset / builder.MduSize)

	mduPath = filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", mduIdx))
	return mduIdx, mduPath, length, nil
}

// inferWitnessCount derives W for a slab by counting on-disk MDUs and
// computing the current user-data high water mark from FileRecords.
func inferWitnessCount(manifestRoot string, mdu0Data []byte, b *builder.Mdu0Builder) (uint64, error) {
	dealDir := filepath.Join(uploadDir, manifestRoot)

	// Compute user-data MDU count from FileRecords (ceil(maxEnd / 8MiB)).
	var maxEnd uint64
	for i := uint32(0); i < b.Header.RecordCount; i++ {
		rec := b.GetFileRecord(i)
		length, _ := layout.UnpackLengthAndFlags(rec.LengthAndFlags)
		end := rec.StartOffset + length
		if end > maxEnd {
			maxEnd = end
		}
	}
	userCount := uint64(0)
	if maxEnd > 0 {
		userCount = (maxEnd + builder.MduSize - 1) / builder.MduSize
	}

	entries, err := os.ReadDir(dealDir)
	if err != nil {
		return 0, err
	}
	totalMdus := 0
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, "mdu_") || !strings.HasSuffix(name, ".bin") {
			continue
		}
		idxStr := strings.TrimSuffix(strings.TrimPrefix(name, "mdu_"), ".bin")
		if _, err := strconv.Atoi(idxStr); err != nil {
			continue
		}
		totalMdus++
	}
	if totalMdus == 0 {
		return 0, fmt.Errorf("no MDUs found in slab")
	}
	if uint64(totalMdus-1) < userCount {
		return 0, fmt.Errorf("invalid slab layout: mdus=%d userCount=%d", totalMdus, userCount)
	}
	return uint64(totalMdus-1) - userCount, nil
}

type MultiReadCloser struct {
	readers []io.Reader
	closers []io.Closer
}

func (m *MultiReadCloser) Read(p []byte) (n int, err error) {
	return io.MultiReader(m.readers...).Read(p)
}

func (m *MultiReadCloser) Close() error {
	var firstErr error
	for _, c := range m.closers {
		if err := c.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
