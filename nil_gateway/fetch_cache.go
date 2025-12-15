package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"nil_gateway/pkg/builder"
	"nil_gateway/pkg/layout"
)

type slabFileInfo struct {
	StartOffset uint64
	Length      uint64
}

type slabIndexEntry struct {
	mdu0ModTime  int64
	witnessCount uint64
	files        map[string]slabFileInfo
}

var slabIndexCache sync.Map // map[string]*slabIndexEntry (key: dealDir)

func loadSlabIndex(dealDir string) (*slabIndexEntry, error) {
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")
	st, err := os.Stat(mdu0Path)
	if err != nil {
		return nil, err
	}
	mod := st.ModTime().UnixNano()

	if cachedAny, ok := slabIndexCache.Load(dealDir); ok {
		cached := cachedAny.(*slabIndexEntry)
		if cached.mdu0ModTime == mod {
			return cached, nil
		}
	}

	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		return nil, err
	}

	b, err := builder.LoadMdu0Builder(mdu0Data, 1)
	if err != nil {
		return nil, err
	}

	files := make(map[string]slabFileInfo, b.Header.RecordCount)
	for i := uint32(0); i < b.Header.RecordCount; i++ {
		rec := b.GetFileRecord(i)
		if rec.Path[0] == 0 {
			continue
		}
		name := string(bytes.TrimRight(rec.Path[:], "\x00"))
		length, _ := layout.UnpackLengthAndFlags(rec.LengthAndFlags)
		files[name] = slabFileInfo{
			StartOffset: rec.StartOffset,
			Length:      length,
		}
	}

	witnessCount, err := inferWitnessCount(dealDir, b)
	if err != nil {
		return nil, err
	}

	entry := &slabIndexEntry{
		mdu0ModTime:  mod,
		witnessCount: witnessCount,
		files:        files,
	}
	slabIndexCache.Store(dealDir, entry)
	return entry, nil
}

// resolveNilfsFileForFetch resolves the NilFS file record once and returns:
// - a streaming reader for the decoded file bytes
// - the MDU index/path for the first user-data MDU that contains the file
// - the file length
func resolveNilfsFileForFetch(dealDir string, filePath string) (io.ReadCloser, uint64, string, uint64, error) {
	entry, err := loadSlabIndex(dealDir)
	if err != nil {
		return nil, 0, "", 0, err
	}

	info, ok := entry.files[filePath]
	if !ok {
		return nil, 0, "", 0, os.ErrNotExist
	}

	slabStartIdx := 1 + entry.witnessCount
	reader, err := newNilfsDecodedReader(dealDir, slabStartIdx, info.StartOffset, info.Length)
	if err != nil {
		return nil, 0, "", 0, err
	}

	mduIdx := 1 + entry.witnessCount + (info.StartOffset / RawMduCapacity)
	mduPath := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", mduIdx))
	return reader, mduIdx, mduPath, info.Length, nil
}

// resolveNilfsFileSegmentForFetch resolves a NilFS file and returns a reader for a subrange.
// If rangeLen is 0, it returns bytes from rangeStart to EOF (of the file record).
func resolveNilfsFileSegmentForFetch(dealDir string, filePath string, rangeStart uint64, rangeLen uint64) (io.ReadCloser, uint64, string, uint64, uint64, uint64, error) {
	entry, err := loadSlabIndex(dealDir)
	if err != nil {
		return nil, 0, "", 0, 0, 0, err
	}

	info, ok := entry.files[filePath]
	if !ok {
		return nil, 0, "", 0, 0, 0, os.ErrNotExist
	}

	fileLen := info.Length
	if rangeStart >= fileLen {
		return nil, 0, "", 0, fileLen, 0, fmt.Errorf("rangeStart beyond EOF")
	}
	remaining := fileLen - rangeStart
	segmentLen := remaining
	if rangeLen != 0 && rangeLen < segmentLen {
		segmentLen = rangeLen
	}

	slabStartIdx := 1 + entry.witnessCount
	reader, err := newNilfsDecodedReader(dealDir, slabStartIdx, info.StartOffset+rangeStart, segmentLen)
	if err != nil {
		return nil, 0, "", 0, fileLen, 0, err
	}

	absOffset := info.StartOffset + rangeStart
	mduIdx := 1 + entry.witnessCount + (absOffset / RawMduCapacity)
	mduPath := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", mduIdx))
	return reader, mduIdx, mduPath, absOffset, segmentLen, fileLen, nil
}

var (
	providerAddrMu          sync.Mutex
	providerAddrCached      string
	providerAddrLastAttempt time.Time
)

func cachedProviderAddress(ctx context.Context) string {
	if override := strings.TrimSpace(os.Getenv("NIL_PROVIDER_ADDRESS")); override != "" {
		return override
	}

	providerKeyName := envDefault("NIL_PROVIDER_KEY", "faucet")

	providerAddrMu.Lock()
	if providerAddrCached != "" {
		addr := providerAddrCached
		providerAddrMu.Unlock()
		return addr
	}
	if !providerAddrLastAttempt.IsZero() && time.Since(providerAddrLastAttempt) < 5*time.Second {
		providerAddrMu.Unlock()
		return ""
	}
	providerAddrLastAttempt = time.Now()
	providerAddrMu.Unlock()

	addr, err := resolveKeyAddress(ctx, providerKeyName)
	if err != nil {
		return ""
	}

	providerAddrMu.Lock()
	providerAddrCached = addr
	providerAddrMu.Unlock()
	return addr
}
