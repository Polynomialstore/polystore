package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"nil_s3/pkg/builder"
	"nil_s3/pkg/layout"
)

const RawMduCapacity = 8126464 // Capacity of 8MB Encoded MDU for Raw Data
// Note: nil_cli with 31-byte scalars: 8388608 bytes encoded <= 8126464 bytes raw.
// But wait, if I pad to 8MB (8388608) Raw in the slab, nil_cli will overflow 1 MDU.
// I must pad to `RawMduCapacity`!
// If I write `RawMduCapacity` bytes, nil_cli produces exactly 8MB Encoded.
// So my "Slab" should be chunks of `RawMduCapacity`.

// IngestNewDeal creates a new Deal Slab.
func IngestNewDeal(filePath string, maxUserMdus uint64) (*builder.Mdu0Builder, string, uint64, error) {
	// 1. Shard User File (first pass to get size/structure)
	// We actually just need to know the size to plan.
	info, err := os.Stat(filePath)
	if err != nil {
		return nil, "", 0, err
	}
	fileSize := uint64(info.Size())
	
	// Calculate User MDUs needed
	userMduCount := (fileSize + RawMduCapacity - 1) / RawMduCapacity
	if userMduCount == 0 && fileSize > 0 { userMduCount = 1 } // At least 1 if size > 0?
	if fileSize == 0 { userMduCount = 0 }

	// 2. Initialize Builder (MDU #0)
	b, err := builder.NewMdu0Builder(maxUserMdus)
	if err != nil {
		return nil, "", 0, err
	}

	// 3. Prepare Slab Construction
	// We will write MDU #0, Witness MDUs, and User MDUs to a slab file.
	// We need to fill MDU #0 with roots LATER. 
	// But `nil_cli` needs the data NOW to compute roots.
	// Circular Dependency: MDU #0 needs Roots of Data. Manifest needs Root of MDU #0.
	
	// Solution: 
	// A. Generate User MDUs. Shard them. Get Roots.
	// B. Generate Witness MDUs (from user blob commitments? No, we don't have them yet).
	// Wait, `nil_cli` generates commitments.
	// To get Witness Data, we must shard User Data first.
	
	// Step 1: Shard User Data ONLY.
	// Create `user_slab.bin` (padded chunks).
	// Actually, just pass user file to `shardFile`?
	// `shardFile` splits it.
	
	userShardOut, err := shardFile(filePath, false, "")
	if err != nil {
		return nil, "", 0, fmt.Errorf("shard user file failed: %w", err)
	}
	
	// Step 2: Build Witness Data
	witnessBuf := new(bytes.Buffer)
	for _, mdu := range userShardOut.Mdus {
		for _, blobHex := range mdu.Blobs {
			blobBytes, err := decodeHex(blobHex)
			if err != nil { return nil, "", 0, err }
			witnessBuf.Write(blobBytes)
		}
	}
	witnessData := witnessBuf.Bytes()
	
	// Step 3: Populate MDU #0 with Witness Roots?
	// We need to shard Witness Data to get roots.
	// Create `witness_slab.bin` (chunks of RawMduCapacity).
	witnessSlabPath := filepath.Join(uploadDir, "temp_witness_slab.bin")
	wSlabFile, err := os.Create(witnessSlabPath)
	if err != nil { return nil, "", 0, err }
	
	witnessMduCount := b.WitnessMduCount
	// Write Witness chunks
	for i := uint64(0); i < witnessMduCount; i++ {
		start := int(i) * RawMduCapacity
		end := start + RawMduCapacity
		var chunk []byte
		if start >= len(witnessData) {
			chunk = []byte{0} // trigger padding
		} else {
			if end > len(witnessData) { end = len(witnessData) }
			chunk = witnessData[start:end]
		}
		
		// Write chunk
		wSlabFile.Write(chunk)
		// Pad to RawMduCapacity
		padding := RawMduCapacity - len(chunk)
		if padding > 0 {
			pad := make([]byte, padding)
			wSlabFile.Write(pad)
		}
	}
	wSlabFile.Close()
	defer os.Remove(witnessSlabPath)
	
	// Shard Witness Slab
	wShardOut, err := shardFile(witnessSlabPath, false, "")
	if err != nil {
		return nil, "", 0, fmt.Errorf("shard witness slab failed: %w", err)
	}
	
	// Populate MDU #0
	// Set Witness Roots
	for i, mdu := range wShardOut.Mdus {
		rootBytes, _ := decodeHex(mdu.RootHex)
		var root [32]byte
		copy(root[:], rootBytes)
		b.SetRoot(uint64(i), root) // Witness starts at 0 in RootTable? 
		// Spec: "MDU #0 stores Roots... RootTable[0] refers to MDU #1"
		// MDU #1 IS the first Witness MDU.
		// So RootTable[0] -> First Witness Root. Correct.
	}
	
	// Set User Roots
	baseIdx := witnessMduCount
	for i, mdu := range userShardOut.Mdus {
		rootBytes, _ := decodeHex(mdu.RootHex)
		var root [32]byte
		copy(root[:], rootBytes)
		b.SetRoot(baseIdx + uint64(i), root)
	}
	
	// Add File Record
	rec := layout.FileRecordV1{
		StartOffset: 0,
		LengthAndFlags: layout.PackLengthAndFlags(fileSize, 0),
		Timestamp: 0,
	}
	baseName := filepath.Base(filePath)
	if len(baseName) > 40 { baseName = baseName[:40] }
	copy(rec.Path[:], baseName)
	b.AppendFileRecord(rec)
	
	// Step 4: Construct Final Slab for Manifest Generation
	// Slab = [MDU 0] [Witness MDUs] [User MDUs]
	// All padded to RawMduCapacity.
	
	finalSlabPath := filepath.Join(uploadDir, "temp_final_slab.bin")
	fSlab, err := os.Create(finalSlabPath)
	if err != nil { return nil, "", 0, err }
	
	// Write MDU 0
	mdu0Bytes := b.Bytes()
	fSlab.Write(mdu0Bytes)
	// Pad MDU 0
	if len(mdu0Bytes) < RawMduCapacity {
		pad := make([]byte, RawMduCapacity - len(mdu0Bytes))
		fSlab.Write(pad)
	}
	
	// Write Witness Slab (Already padded)
	wBytes, _ := os.ReadFile(witnessSlabPath)
	fSlab.Write(wBytes)
	
	// Write User Slab? We need to pad user file chunks.
	uFile, _ := os.Open(filePath)
	uBuf := make([]byte, RawMduCapacity)
	for {
		n, err := io.ReadFull(uFile, uBuf)
		if n > 0 {
			fSlab.Write(uBuf[:n])
			if n < RawMduCapacity {
				fSlab.Write(make([]byte, RawMduCapacity - n))
			}
		}
		if err != nil { break }
	}
	uFile.Close()
	fSlab.Close()
	defer os.Remove(finalSlabPath)
	
	// Step 5: Shard Final Slab -> Manifest
	finalOut, err := shardFile(finalSlabPath, false, "")
	if err != nil {
		return nil, "", 0, fmt.Errorf("shard final slab failed: %w", err)
	}
	
	manifestRoot := finalOut.ManifestRootHex
	
	// Step 6: Commit to Storage
	dealDir := filepath.Join(uploadDir, manifestRoot)
	os.MkdirAll(dealDir, 0755)
	
	// Store Manifest Blob (for Hop 1)
	// It's in finalOut.ManifestBlobHex
	manifestBlob, _ := decodeHex(finalOut.ManifestBlobHex)
	// We name it "mdu_0.bin" because MDU 0 IS the Manifest? NO.
	// MDU 0 is the FAT.
	// Manifest is the "Super Root".
	// Store Manifest as `manifest.bin`
	os.WriteFile(filepath.Join(dealDir, "manifest.bin"), manifestBlob, 0644)
	
	// Store MDU 0 (Raw)
	os.WriteFile(filepath.Join(dealDir, "mdu_0.bin"), mdu0Bytes, 0644)
	
	// Store Witness MDUs (Raw)
	// Re-read from witnessSlabPath chunks
	wReader := bytes.NewReader(wBytes)
	for i := uint64(0); i < witnessMduCount; i++ {
		chunk := make([]byte, RawMduCapacity)
		wReader.Read(chunk)
		// Trim padding? No, store padded raw.
		// Actually, standard is to store raw data.
		// If we store padded, file size is 8MB approx.
		os.WriteFile(filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", 1+i)), chunk, 0644)
	}
	
	// Store User MDUs (Raw)
	uFile, _ = os.Open(filePath)
	for i := uint64(0); i < uint64(len(userShardOut.Mdus)); i++ {
		chunk := make([]byte, RawMduCapacity)
		_, _ = io.ReadFull(uFile, chunk)
		// We can store trimmed or padded. 
		// ResolveFileByPath expects streaming. Padded is fine if LimitReader is used.
		// Store padded to match MDU indices.
		os.WriteFile(filepath.Join(dealDir, fmt.Sprintf("mdu_%d.bin", 1+witnessMduCount+i)), chunk, 0644) // Store padded to ensure Proof alignment
		// Wait, if we store unpadded, random access math must account for it?
		// `mduPath = fmt.Sprintf("mdu_%d.bin", slabIdx)`
		// `ResolveFileByPath` logic: `remaining -= toRead`. `currentMduRelIdx++`.
		// It assumes 1 file per MDU. Size doesn't matter.
		// So unpadded is fine.
	}
	uFile.Close()
	
	allocatedLength := 1 + witnessMduCount + uint64(len(userShardOut.Mdus))
	return b, manifestRoot, allocatedLength, nil
}