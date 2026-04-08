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

	"polystorechain/x/crypto_ffi"
)

type slabFileInfo struct {
	StartOffset uint64
	Length      uint64
}

type slabIndexEntry struct {
	indexModTime int64
	indexSource  string
	metaModTime  int64
	mdu0ModTime  int64
	manifestKey  string
	witnessCount uint64
	files        map[string]slabFileInfo
}

var slabIndexCache sync.Map // map[string]*slabIndexEntry (key: dealDir)

func slabIndexFilesFromMetadata(records []slabMetadataFileRecord) map[string]slabFileInfo {
	files := make(map[string]slabFileInfo, len(records))
	for _, rec := range records {
		if rec.Path == "" {
			continue
		}
		files[rec.Path] = slabFileInfo{
			StartOffset: rec.StartOffset,
			Length:      rec.SizeBytes,
		}
	}
	return files
}

func loadSlabIndex(dealDir string) (*slabIndexEntry, error) {
	metaPath := slabMetadataPathForDealDir(dealDir)
	mdu0Path := filepath.Join(dealDir, "mdu_0.bin")
	st, err := os.Stat(mdu0Path)
	if err != nil {
		return nil, err
	}
	mdu0Mod := st.ModTime().UnixNano()
	metaMod := int64(0)
	if metaInfo, err := os.Stat(metaPath); err == nil {
		metaMod = metaInfo.ModTime().UnixNano()
	}

	expectedManifestKey := ""
	if key, ok := slabMetadataManifestKey(inferManifestRootForDealDir(dealDir)); ok {
		expectedManifestKey = key
	}

	if cachedAny, ok := slabIndexCache.Load(dealDir); ok {
		cached := cachedAny.(*slabIndexEntry)
		if cached.manifestKey == expectedManifestKey &&
			((cached.indexSource == "meta" &&
				cached.indexModTime == metaMod &&
				cached.metaModTime == metaMod &&
				cached.mdu0ModTime == mdu0Mod) ||
				(cached.indexSource == "mdu0" &&
					cached.indexModTime == mdu0Mod &&
					cached.metaModTime == metaMod &&
					cached.mdu0ModTime == mdu0Mod)) {
			return cached, nil
		}
	}

	if metaMod != 0 {
		if meta, err := readSlabMetadataFile(dealDir); err == nil {
			metaFresh := mdu0Mod <= metaMod
			manifestMatches := slabMetadataManifestMatchesDealDir(meta.ManifestRoot, dealDir)
			if metaFresh && manifestMatches {
				entry := &slabIndexEntry{
					indexModTime: metaMod,
					indexSource:  "meta",
					metaModTime:  metaMod,
					mdu0ModTime:  mdu0Mod,
					manifestKey:  expectedManifestKey,
					witnessCount: meta.WitnessMdus,
					files:        slabIndexFilesFromMetadata(meta.FileRecords),
				}
				slabIndexCache.Store(dealDir, entry)
				return entry, nil
			}
		}
	}

	mdu0Data, err := os.ReadFile(mdu0Path)
	if err != nil {
		return nil, err
	}

	b, err := crypto_ffi.LoadMdu0Builder(mdu0Data, 1)
	if err != nil {
		return nil, err
	}
	defer b.Free()

	records := slabMetadataFileRecordsFromBuilder(b)
	files := slabIndexFilesFromMetadata(records)

	witnessCount, err := inferWitnessCount(dealDir, b)
	if err != nil {
		return nil, err
	}

	if fallbackMeta, err := newSlabMetadataDocument(slabMetadataBuildOptions{
		GenerationID: inferGenerationIDForDealDir(dealDir),
		DealID:       inferDealIDFromDealDir(dealDir),
		ManifestRoot: inferManifestRootForDealDir(dealDir),
		Source:       "gateway_fallback_mdu0",
		WitnessMdus:  &witnessCount,
		FileRecords:  records,
	}); err == nil {
		_ = writeSlabMetadataFile(dealDir, fallbackMeta)
	}

	entry := &slabIndexEntry{
		indexModTime: mdu0Mod,
		indexSource:  "mdu0",
		metaModTime:  metaMod,
		mdu0ModTime:  mdu0Mod,
		manifestKey:  expectedManifestKey,
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
	reader, err := newNilfsDecodedReader(dealDir, slabStartIdx, info.StartOffset, info.Length, info.StartOffset, info.Length)
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
	reader, err := newNilfsDecodedReader(dealDir, slabStartIdx, info.StartOffset, info.Length, info.StartOffset+rangeStart, segmentLen)
	if err != nil {
		return nil, 0, "", 0, fileLen, 0, err
	}

	absOffset := info.StartOffset + rangeStart
	mduIdx := 1 + entry.witnessCount + (absOffset / RawMduCapacity)
	mduPath := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", mduIdx))
	return reader, mduIdx, mduPath, absOffset, segmentLen, fileLen, nil
}

// resolveNilfsFileSegmentForFetchDecoded resolves a NilFS file segment by decoding the
// full user MDU payload via the Rust FFI decoder, then slicing the requested range.
// This is slower than streaming, but ensures byte-accurate decoding for Mode 2 reads.
func resolveNilfsFileSegmentForFetchDecoded(dealDir string, filePath string, rangeStart uint64, rangeLen uint64) (io.ReadCloser, uint64, string, uint64, uint64, uint64, error) {
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

	absOffset := info.StartOffset + rangeStart
	mduIdx := 1 + entry.witnessCount + (absOffset / RawMduCapacity)
	mduPath := filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", mduIdx))
	mduBytes, err := os.ReadFile(mduPath)
	if err != nil {
		return nil, 0, "", 0, fileLen, 0, err
	}

	mduBase := (absOffset / RawMduCapacity) * RawMduCapacity
	fileAbsEnd := info.StartOffset + info.Length
	mduPayloadLen := uint64(RawMduCapacity)
	if fileAbsEnd < mduBase+uint64(RawMduCapacity) {
		mduPayloadLen = fileAbsEnd - mduBase
		if mduPayloadLen == 0 {
			return nil, 0, "", 0, fileLen, 0, fmt.Errorf("file payload length is zero for MDU")
		}
	}

	payload, err := crypto_ffi.DecodePayloadFromMdu(mduBytes, mduPayloadLen)
	if err != nil {
		return nil, 0, "", 0, fileLen, 0, err
	}

	offsetInMdu := absOffset % RawMduCapacity
	if offsetInMdu >= uint64(len(payload)) {
		return nil, 0, "", 0, fileLen, 0, fmt.Errorf("decoded payload offset out of bounds")
	}
	end := offsetInMdu + segmentLen
	if end > uint64(len(payload)) {
		end = uint64(len(payload))
		segmentLen = end - offsetInMdu
	}

	segment := payload[offsetInMdu:end]
	reader := io.NopCloser(bytes.NewReader(segment))
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
