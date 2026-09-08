package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/blake2s"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func boundarySessionContext(t *testing.T) retrievalchallenge.Context {
	t.Helper()
	c, err := types.RetrievalChallengeContext(testFrozenSession(t).Session)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func writeNativeWitnessFixture(t *testing.T, dir string, index int, payload []byte) []byte {
	t.Helper()
	encoded, err := crypto_ffi.EncodePayloadToMdu(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("mdu_%d.bin", index)), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestFrozenWitnessSpanCrossesNativePackedMDUs(t *testing.T) {
	initCryptoForTest(t)
	const leaves, span, users = 96, 96 * 48, 1764
	// These commitments occupy two witness MDUs. The last user's span contains
	// 2,560 bytes in the first and 2,048 in the second, whose final scalar uses
	// only two bytes. Keep the producer's fixed total, not each read's endpoint.
	payload := make([]byte, users*span)
	for i := range payload {
		payload[i] = byte(i*37 + i/97 + 1)
	}
	payload[len(payload)-2], payload[len(payload)-1] = 0xa7, 0x5c
	dir := t.TempDir()
	first := writeNativeWitnessFixture(t, dir, 1, payload[:RawMduCapacity])
	second := writeNativeWitnessFixture(t, dir, 2, payload[RawMduCapacity:])
	if !bytes.Equal(second[66*32:67*32], append(make([]byte, 30), 0xa7, 0x5c)) {
		t.Fatal("native fixture did not right-align its two-byte final scalar")
	}
	c := boundarySessionContext(t)
	c.MetadataMDUs, c.UserMDUs = 3, users
	for _, user := range []int{0, users - 2, users - 1} {
		t.Run(fmt.Sprintf("user_%d", user), func(t *testing.T) {
			c.StartMDU = c.MetadataMDUs + uint64(user)
			got, err := readFrozenWitnessCommitments(dir, c, c.StartMDU, leaves)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got, payload[user*span:(user+1)*span]) {
				t.Fatal("span differs from the native producer's original bytes")
			}
		})
	}
	c.StartMDU = c.MetadataMDUs + users - 1
	for _, tc := range []struct {
		name  string
		index int
		wire  []byte
		edit  func([]byte) []byte
	}{
		{"first_truncated", 1, first, func(b []byte) []byte { return b[:len(b)-1] }},
		{"second_truncated", 2, second, func(b []byte) []byte { return b[:len(b)-1] }},
		{"first_scalar_prefix", 1, first, func(b []byte) []byte { b[(users-1)*span/31*32] = 1; return b }},
		{"second_scalar_prefix", 2, second, func(b []byte) []byte { b[0] = 1; return b }},
		{"final_scalar_padding", 2, second, func(b []byte) []byte { b[66*32+29] = 1; return b }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, fmt.Sprintf("mdu_%d.bin", tc.index))
			if err := os.WriteFile(path, tc.edit(bytes.Clone(tc.wire)), 0600); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.WriteFile(path, tc.wire, 0600); err != nil {
					t.Error(err)
				}
			})
			if _, err := readFrozenWitnessCommitments(dir, c, c.StartMDU, leaves); err == nil {
				t.Fatal("accepted malformed witness span")
			}
		})
	}
}

func TestAuthenticatedUserMDURootTableBoundaries(t *testing.T) {
	initCryptoForTest(t)
	// Explicit positions span both sides of the root-table blob boundary and
	// its final address. Only witness MDUs 3 and 38 exist on disk; no large deal
	// or intervening user data is materialized. MDU 1 is metadata, so it is
	// checked through the native Hop 1 API below, not an invalid user session.
	targets := []struct {
		mdu, du, cell, witness, offset int
		commitments                    []byte
		root                           []byte
	}{
		{mdu: 1, du: 0, cell: 0, root: bytes.Repeat([]byte{0xff}, 32)},
		{mdu: 4096, du: 0, cell: 4095, witness: 3, offset: 2441728},
		{mdu: 4097, du: 1, cell: 0, witness: 3, offset: 2446336},
		{mdu: 65536, du: 15, cell: 4095, witness: 38, offset: 1131008},
	}
	zeroCommitment, err := crypto_ffi.CommitReceivedBlob(make([]byte, types.BLOB_SIZE))
	if err != nil {
		t.Fatal(err)
	}
	nonzeroBlob := make([]byte, types.BLOB_SIZE)
	nonzeroBlob[31] = 1
	nonzeroCommitment, err := crypto_ffi.CommitReceivedBlob(nonzeroBlob)
	if err != nil {
		t.Fatal(err)
	}
	witnessPayloads := map[int][]byte{3: make([]byte, RawMduCapacity), 38: make([]byte, 1135616)}
	for i := 1; i < len(targets); i++ {
		target := &targets[i]
		leaves := make([][32]byte, 96)
		for j := range leaves {
			commitment := zeroCommitment
			if j%(i+1) == 0 {
				commitment = nonzeroCommitment
			}
			target.commitments = append(target.commitments, commitment...)
			leaves[j] = blake2s.Sum256(commitment)
		}
		// Use the existing independent path builder as the expected root oracle.
		target.root, _ = merkleRootAndPath(leaves, 0)
		copy(witnessPayloads[target.witness][target.offset:], target.commitments)
	}
	dir := t.TempDir()
	for index, payload := range witnessPayloads {
		writeNativeWitnessFixture(t, dir, index, payload)
	}
	mdu0 := make([]byte, types.MDU_SIZE)
	commitments := make([][]byte, 64)
	for i := range commitments {
		commitments[i] = zeroCommitment
	}
	for _, du := range []int{0, 1, 15} {
		roots := make([][]byte, 4096)
		for i := range roots {
			roots[i] = make([]byte, 32)
		}
		for _, target := range targets {
			if target.du == du {
				roots[target.cell] = target.root
			}
		}
		commitment, blob, err := crypto_ffi.ComputeManifestCommitment(roots)
		if err != nil {
			t.Fatal(err)
		}
		commitments[du] = commitment
		copy(mdu0[du*types.BLOB_SIZE:], blob)
	}
	manifestRoot, err := crypto_ffi.ComputeMduMerkleRoot(mdu0)
	if err != nil {
		t.Fatal(err)
	}
	leaves := make([][32]byte, 64)
	for i, commitment := range commitments {
		leaves[i] = blake2s.Sum256(commitment)
	}
	tree := buildProofMerkleTree(leaves)
	c := boundarySessionContext(t)
	c.MetadataMDUs, c.UserMDUs = 39, 65498
	copy(c.Root[:], manifestRoot)
	for _, target := range targets {
		t.Run(fmt.Sprintf("mdu_%d", target.mdu), func(t *testing.T) {
			nativeCommitment, path, opening, _, err := crypto_ffi.ComputeMdu0RootTableProof(mdu0, uint64(target.mdu), target.root)
			if err != nil {
				t.Fatal(err)
			}
			valid, err := crypto_ffi.VerifyMdu0RootTableProof(manifestRoot, uint64(target.mdu), target.root, nativeCommitment, path, opening)
			if err != nil || !valid {
				t.Fatalf("native boundary proof: valid=%v err=%v", valid, err)
			}
			if !bytes.Equal(nativeCommitment, commitments[target.du]) {
				t.Fatal("native proof selected the wrong root-table blob")
			}
			if target.mdu == 1 {
				return
			}
			c.StartMDU = uint64(target.mdu)
			g := &authenticatedGeneration{rootTable: mdu0[:16*types.BLOB_SIZE], commitments: commitments, tree: tree}
			got, err := g.userMDU(context.Background(), dir, c, c.StartMDU)
			if err != nil {
				t.Fatal(err)
			}
			flatPath, err := flattenMerkleProof32(got.rootPath)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(got.commitments, target.commitments) || !bytes.Equal(got.rootCommitment, nativeCommitment) ||
				!bytes.Equal(got.rootOpening, opening) || !bytes.Equal(flatPath, path) {
				t.Fatal("authenticated user MDU differs from the native boundary proof or witness bytes")
			}
		})
	}
	// Authenticate a changed commitment list against the unchanged root table.
	// Start with an uncached generation so this exercises admission, not the
	// separate immutable-generation cache contract.
	witnessPayloads[3][2441728+17] ^= 1
	writeNativeWitnessFixture(t, dir, 3, witnessPayloads[3])
	c.StartMDU = 4096
	g := &authenticatedGeneration{rootTable: mdu0[:16*types.BLOB_SIZE], commitments: commitments, tree: tree}
	if _, err := g.userMDU(context.Background(), dir, c, c.StartMDU); err == nil {
		t.Fatal("accepted changed witness commitments under the frozen root table")
	}
}
