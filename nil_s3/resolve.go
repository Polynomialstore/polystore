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

const (
	nilfsScalarBytes        = 32
	nilfsScalarPayloadBytes = 31
	nilfsScalarsPerMdu      = builder.MduSize / nilfsScalarBytes
)

type nilfsDecodedReader struct {
	dealDir         string
	slabStartIdx    uint64
	remaining       uint64
	currentUserMdu  uint64
	currentScalar   uint64
	file            *os.File
	scalarBuf       [nilfsScalarBytes]byte
	payloadOffset   int
	payloadBuf      []byte
	payloadBufIndex int
}

func newNilfsDecodedReader(dealDir string, slabStartIdx uint64, startOffset uint64, length uint64) (*nilfsDecodedReader, error) {
	if length == 0 {
		return &nilfsDecodedReader{
			dealDir:      dealDir,
			slabStartIdx: slabStartIdx,
			remaining:    0,
			payloadBuf:   nil,
		}, nil
	}

	userMduIdx := startOffset / RawMduCapacity
	offsetInMdu := startOffset % RawMduCapacity
	scalarIdx := offsetInMdu / nilfsScalarPayloadBytes
	payloadOffset := int(offsetInMdu % nilfsScalarPayloadBytes)
	if scalarIdx >= uint64(nilfsScalarsPerMdu) {
		return nil, fmt.Errorf("start_offset out of bounds for MDU: %d", startOffset)
	}

	r := &nilfsDecodedReader{
		dealDir:        dealDir,
		slabStartIdx:   slabStartIdx,
		remaining:      length,
		currentUserMdu: userMduIdx,
		currentScalar:  scalarIdx,
		payloadOffset:  payloadOffset,
		payloadBuf:     nil,
	}

	if err := r.openCurrent(); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *nilfsDecodedReader) openCurrent() error {
	if r.file != nil {
		_ = r.file.Close()
		r.file = nil
	}
	slabIdx := r.slabStartIdx + r.currentUserMdu
	path := filepath.Join(r.dealDir, fmt.Sprintf("mdu_%d.bin", slabIdx))
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	r.file = f

	if _, err := r.file.Seek(int64(r.currentScalar*nilfsScalarBytes), io.SeekStart); err != nil {
		_ = r.file.Close()
		r.file = nil
		return err
	}
	r.payloadBuf = nil
	r.payloadBufIndex = 0
	return nil
}

func (r *nilfsDecodedReader) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	if len(p) == 0 {
		return 0, nil
	}

	written := 0
	for written < len(p) && r.remaining > 0 {
		if r.payloadBufIndex < len(r.payloadBuf) {
			n := len(p) - written
			if n > len(r.payloadBuf)-r.payloadBufIndex {
				n = len(r.payloadBuf) - r.payloadBufIndex
			}
			if n > int(r.remaining) {
				n = int(r.remaining)
			}
			copy(p[written:written+n], r.payloadBuf[r.payloadBufIndex:r.payloadBufIndex+n])
			r.payloadBufIndex += n
			r.remaining -= uint64(n)
			written += n
			continue
		}

		if r.file == nil {
			return written, io.ErrClosedPipe
		}

		if r.currentScalar >= uint64(nilfsScalarsPerMdu) {
			r.currentUserMdu++
			r.currentScalar = 0
			r.payloadOffset = 0
			if err := r.openCurrent(); err != nil {
				if written > 0 {
					return written, nil
				}
				return 0, err
			}
			continue
		}

		if _, err := io.ReadFull(r.file, r.scalarBuf[:]); err != nil {
			if written > 0 {
				return written, nil
			}
			return 0, err
		}
		r.currentScalar++

		if r.remaining >= nilfsScalarPayloadBytes {
			r.payloadBuf = r.scalarBuf[1:]
			r.payloadBufIndex = r.payloadOffset
			r.payloadOffset = 0
			continue
		}

		need := int(r.remaining)
		if r.payloadOffset != 0 {
			if r.payloadOffset >= nilfsScalarPayloadBytes {
				return written, fmt.Errorf("invalid payload offset %d", r.payloadOffset)
			}
			if need > nilfsScalarPayloadBytes-r.payloadOffset {
				need = nilfsScalarPayloadBytes - r.payloadOffset
			}
			start := 1 + r.payloadOffset
			r.payloadBuf = r.scalarBuf[start : start+need]
			r.payloadBufIndex = 0
			r.payloadOffset = 0
			continue
		}

		// Final scalar of the file: nil_cli encodes partial chunks right-aligned.
		r.payloadBuf = r.scalarBuf[nilfsScalarBytes-need:]
		r.payloadBufIndex = 0
	}

	if written == 0 && r.remaining == 0 {
		return 0, io.EOF
	}
	return written, nil
}

func (r *nilfsDecodedReader) Close() error {
	r.remaining = 0
	r.payloadBuf = nil
	r.payloadBufIndex = 0
	r.payloadOffset = 0
	file := r.file
	r.file = nil
	if file == nil {
		return nil
	}
	return file.Close()
}

// ResolveFileByPath locates a file within a deal's slab and returns a reader for its content.
// It assumes MDUs are stored at `uploads/<manifest_root>/mdu_X.bin`.
func ResolveFileByPath(dealDir string, filePath string) (io.ReadCloser, uint64, error) {
	// 1. Load MDU #0
	// We assume MDU #0 is stored as "mdu_0.bin" in the deal's directory.
	// But `GatewayUpload` stores temp files?
	// We need a stable storage convention.
	// Let's assume `uploads/<manifest_root>/mdu_0.bin`.

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
	targetPath := filePath

	for i := uint32(0); i < b.Header.RecordCount; i++ {
		rec := b.GetFileRecord(i)
		// Decode path
		if rec.Path[0] == 0 {
			continue
		}
		name := string(bytes.TrimRight(rec.Path[:], "\x00"))
		if name == targetPath {
			targetRec = &rec
		}
	}

	if targetRec == nil {
		return nil, 0, os.ErrNotExist
	}

	length, _ := layout.UnpackLengthAndFlags(targetRec.LengthAndFlags)
	startOffset := targetRec.StartOffset

	witnessCount, err := inferWitnessCount(dealDir, b)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to infer witness count: %w", err)
	}

	slabStartIdx := 1 + witnessCount

	reader, err := newNilfsDecodedReader(dealDir, slabStartIdx, startOffset, length)
	if err != nil {
		return nil, 0, err
	}
	return reader, length, nil
}

// GetFileLocation returns the MDU index and physical path for the start of a file.
func GetFileLocation(dealDir, filePath string) (mduIndex uint64, mduPath string, length uint64, err error) {
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")

	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		return 0, "", 0, fmt.Errorf("failed to read MDU #0: %w", err)
	}

	b, err := builder.LoadMdu0Builder(mdu0Data, 1)
	if err != nil {
		return 0, "", 0, fmt.Errorf("failed to parse MDU #0: %w", err)
	}

	targetPath := filePath
	var targetRec *layout.FileRecordV1
	for i := uint32(0); i < b.Header.RecordCount; i++ {
		rec := b.GetFileRecord(i)
		if rec.Path[0] == 0 {
			continue
		}
		name := string(bytes.TrimRight(rec.Path[:], "\x00"))
		if name == targetPath {
			targetRec = &rec
		}
	}

	if targetRec == nil {
		return 0, "", 0, os.ErrNotExist
	}

	length, _ = layout.UnpackLengthAndFlags(targetRec.LengthAndFlags)
	startOffset := targetRec.StartOffset

	witnessCount, err := inferWitnessCount(dealDir, b)
	if err != nil {
		return 0, "", 0, fmt.Errorf("failed to infer witness count: %w", err)
	}

	// Slab Index = 1 + WitnessCount + (StartOffset / RawMduCapacity)
	mduIdx := 1 + witnessCount + (startOffset / RawMduCapacity)

	mduPath = filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", mduIdx))
	return mduIdx, mduPath, length, nil
}

// inferWitnessCount derives W for a slab by counting on-disk MDUs and
// computing the current user-data high water mark from FileRecords.
func inferWitnessCount(dealDir string, b *builder.Mdu0Builder) (uint64, error) {
	// Compute user-data MDU count from FileRecords (ceil(maxEnd / 8MiB)).
	var maxEnd uint64
	for i := uint32(0); i < b.Header.RecordCount; i++ {
		rec := b.GetFileRecord(i)
		if rec.Path[0] == 0 {
			continue
		}
		length, _ := layout.UnpackLengthAndFlags(rec.LengthAndFlags)
		end := rec.StartOffset + length
		if end > maxEnd {
			maxEnd = end
		}
	}
	userCount := uint64(0)
	if maxEnd > 0 {
		userCount = (maxEnd + RawMduCapacity - 1) / RawMduCapacity
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
