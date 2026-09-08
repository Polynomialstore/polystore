package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/cosmos/gogoproto/jsonpb"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func TestFrozenSessionProofBindsReceivedBytesAndFreshChallenge(t *testing.T) {
	useTempUploadDir(t)
	if err := crypto_ffi.Init(trustedSetup); err != nil {
		t.Fatal(err)
	}
	payload := make([]byte, 12*126976)
	for i := range payload {
		payload[i] = byte(i*37 + i/97)
	}
	source := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(source, payload, 0600); err != nil {
		t.Fatal(err)
	}
	result, _, err := mode2BuildArtifacts(context.Background(), source, 9007199254740993, "General:rs=8+4", "payload.bin", 0)
	if err != nil {
		t.Fatal(err)
	}
	dir := dealScopedDir(9007199254740993, result.manifestRoot)
	r := testFrozenSession(t)
	r.Session.ManifestRoot = bytes.Clone(result.manifestRoot.Bytes[:])
	r.Session.StartMduIndex = 1 + result.witnessMdus
	r.Session.ChallengeSnapshot.MetadataMdus = 1 + result.witnessMdus
	r.Session.ChallengeSnapshot.UserMdus = result.userMdus
	c, err := types.RetrievalChallengeContext(r.Session)
	if err != nil {
		t.Fatal(err)
	}
	h, _ := c.Hash()
	r.ChallengeContext, _ = c.Bytes()
	r.ChallengeContextHash = h[:]
	f := &frozenRetrievalSession{Session: r.Session, Context: c, Hash: h, Seed: [32]byte(r.ChallengeSeed), Height: 12}
	proofs, window, err := generateFrozenSessionProof(context.Background(), dir, f)
	if err != nil {
		t.Fatal(err)
	}
	if len(proofs) != 2 || len(window) != 2*types.BLOB_SIZE {
		t.Fatalf("wrong coverage: %d %d", len(proofs), len(window))
	}
	exerciseFrozenSessionDelivery(t, r, window)
	metadata, err := authenticatedRetrievalMetadata(context.Background(), dir, c)
	if err != nil {
		t.Fatal(err)
	}
	oldMetadata, oldUser := metadata, metadata.lastProof
	f.Context.ID[0]++
	f.Hash, _ = f.Context.Hash()
	fresh, _, err := generateFrozenSessionProof(context.Background(), dir, f)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(proofs[0].ZValue, fresh[0].ZValue) || bytes.Equal(proofs[0].KzgOpeningProof, fresh[0].KzgOpeningProof) {
		t.Fatal("reused challenge-dependent proof")
	}
	metadata, _ = authenticatedRetrievalMetadata(context.Background(), dir, c)
	if metadata != oldMetadata || metadata.lastProof != oldUser {
		t.Fatal("warm session recomputed static metadata")
	}
	valid, err := crypto_ffi.VerifyPolyFSSessionProofBatch(c.Root[:], f.Hash[:], f.Seed[:], 96, proofs)
	if err == nil && valid {
		t.Fatal("accepted old opening under another session")
	}
	shardPath := filepath.Join(dir, "mdu_2_slot_1.bin")
	shard, err := os.OpenFile(shardPath, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := shard.WriteAt([]byte{window[31] ^ 1}, 31); err != nil {
		t.Fatal(err)
	}
	if err := shard.Close(); err != nil {
		t.Fatal(err)
	}
	if _, _, err := generateFrozenSessionProof(context.Background(), dir, f); err == nil {
		t.Fatal("accepted corrupted stored bytes with cached metadata")
	}
	if export := os.Getenv("POLYSTORE_TEST_EXPORT_RETRIEVAL_FIXTURE"); export != "" {
		if err := os.MkdirAll(export, 0700); err != nil {
			t.Fatal(err)
		}
		r.ChallengeContext, _ = c.Bytes()
		r.ChallengeContextHash = h[:]
		query, err := (&jsonpb.Marshaler{OrigName: true}).MarshalToString(&r)
		if err != nil {
			t.Fatal(err)
		}
		meta := map[string]interface{}{"version": 2, "session_id": "0x" + hex.EncodeToString(r.Session.SessionId), "context_hash": "0x" + hex.EncodeToString(h[:]), "manifest_root": result.manifestRoot.Canonical, "start_mdu_index": "2", "start_blob_index": 8, "blob_count": "2", "total_bytes": "262144", "proofs": proofs}
		encoded, err := json.Marshal(meta)
		if err != nil {
			t.Fatal(err)
		}
		for name, data := range map[string][]byte{"session.json": []byte(query), "metadata.json": encoded, "window.bin": window, "payload.bin": payload} {
			if err := os.WriteFile(filepath.Join(export, name), data, 0600); err != nil {
				t.Fatal(err)
			}
		}
		mdu0, err := os.ReadFile(filepath.Join(dir, "mdu_0.bin"))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(export, "mdu_0.bin"), mdu0, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPreparedMerklePathsMatchLegacyOddTree(t *testing.T) {
	for _, count := range []int{1, 3, 64, 96, 16384} {
		leaves := make([][32]byte, count)
		for i := range leaves {
			leaves[i][0], leaves[i][1] = byte(i), byte(i>>8)
		}
		tree := buildProofMerkleTree(leaves)
		for _, i := range []int{0, count / 2, count - 1} {
			root, path := merkleRootAndPath(leaves, i)
			flat, _ := flattenMerkleProof32(path)
			prepared, _ := flattenMerkleProof32(proofMerklePath(tree, i))
			if !bytes.Equal(root, tree[len(tree)-1][0][:]) || !bytes.Equal(flat, prepared) {
				t.Fatalf("tree mismatch %d/%d", count, i)
			}
		}
	}
}
