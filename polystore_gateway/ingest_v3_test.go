package main

import (
	"bytes"
	"encoding/hex"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func TestMode2BuildArtifactsV3ProducesCanonicalIntegrityMetadata(t *testing.T) {
	useTempUploadDir(t)
	initCryptoForTest(t)
	payload := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(payload, bytes.Repeat([]byte{0x5a}, RawMduCapacity+4097), 0o600); err != nil {
		t.Fatal(err)
	}

	result, dir, err := mode2BuildArtifactsWithOptions(t.Context(), payload, 0, "General:rs=8+4", "payload.bin", 0, mode2BuildOptions{fatVersion: 3})
	if err != nil {
		t.Fatal(err)
	}
	if result.userMdus != 2 || result.integrityLeaves != 192 {
		t.Fatalf("unexpected v3 geometry: users=%d leaves=%d", result.userMdus, result.integrityLeaves)
	}

	mdu0, err := os.ReadFile(filepath.Join(dir, "mdu_0.bin"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := fatV3HeaderFromEncodedMDU0(mdu0)
	if err != nil {
		t.Fatal(err)
	}
	header, err := retrievalchallenge.ParseFATV3Header(raw[:])
	if err != nil {
		t.Fatal(err)
	}
	if header.RecordCount != 1 || header.LeafCount != 192 || header.IntegrityRoot != result.integrityRoot {
		t.Fatalf("unexpected FAT v3 header: %+v", header)
	}
	root, err := crypto_ffi.ComputeMduMerkleRoot(mdu0)
	if err != nil {
		t.Fatal(err)
	}
	if got := "0x" + hex.EncodeToString(root); got != result.manifestRoot.Canonical {
		t.Fatalf("MDU0 root mismatch: got %s want %s", got, result.manifestRoot.Canonical)
	}

	vector, err := os.ReadFile(filepath.Join(dir, integrityLeavesV3File))
	if err != nil {
		t.Fatal(err)
	}
	if len(vector) != 192*32 {
		t.Fatalf("integrity vector length=%d", len(vector))
	}
	for user := uint64(0); user < result.userMdus; user++ {
		slabIndex := uint64(1) + result.witnessMdus + user
		for slot := uint64(0); slot < 12; slot++ {
			shard, err := os.ReadFile(filepath.Join(dir, "mdu_"+strconv.FormatUint(slabIndex, 10)+"_slot_"+strconv.FormatUint(slot, 10)+".bin"))
			if err != nil {
				t.Fatal(err)
			}
			if len(shard) != 8*types.BLOB_SIZE {
				t.Fatalf("user %d slot %d shard length=%d", user, slot, len(shard))
			}
			for row := uint64(0); row < 8; row++ {
				leaf := slot*8 + row
				want, err := retrievalchallenge.IntegrityLeafV3(slabIndex, uint32(leaf), shard[row*types.BLOB_SIZE:(row+1)*types.BLOB_SIZE])
				if err != nil {
					t.Fatal(err)
				}
				position := user*retrievalchallenge.IntegrityLeavesPerUserMDU + leaf
				if !bytes.Equal(vector[position*32:(position+1)*32], want[:]) {
					t.Fatalf("integrity leaf mismatch at %d", position)
				}
			}
		}
	}
	if got, err := retrievalchallenge.IntegrityRootV3Reader(bytes.NewReader(vector), 192); err != nil || got != header.IntegrityRoot {
		t.Fatalf("integrity root mismatch: got=%x err=%v", got, err)
	}
}
