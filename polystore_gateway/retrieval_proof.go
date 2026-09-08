package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/blake2s"
	"golang.org/x/sync/singleflight"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

// Four admitted responses bound cold preparation, evicted-but-live cache values,
// and encoded response buffers as well as the retained cache itself. Keep the
// admission token until the response has finished writing, including cancellation.
const maxRetrievalResponses = 4

var retrievalResponses = make(chan struct{}, maxRetrievalResponses)

type retrievalAdmissionKey struct{}

func admitRetrievalResponse(ctx context.Context) (context.Context, func(), error) {
	if ctx.Value(retrievalAdmissionKey{}) != nil {
		return ctx, func() {}, nil
	}
	if err := ctx.Err(); err != nil {
		return ctx, nil, err
	}
	select {
	case retrievalResponses <- struct{}{}:
		return context.WithValue(ctx, retrievalAdmissionKey{}, true), func() { <-retrievalResponses }, nil
	default:
		return ctx, nil, fmt.Errorf("retrieval response capacity exhausted")
	}
}

type retrievalGenerationKey struct {
	Chain                             string
	Setup, Root                       [32]byte
	Deal, Generation, Metadata, Users uint64
	Layout                            uint8
	K, M                              uint32
}

func retrievalGeneration(c retrievalchallenge.Context) retrievalGenerationKey {
	return retrievalGenerationKey{c.ChainID, c.SetupDigest, c.Root, c.DealID, c.Generation, c.MetadataMDUs, c.UserMDUs, c.Layout, c.K, c.M}
}

type authenticatedGeneration struct {
	rootTable   []byte // Only the sixteen authenticated root-table blobs are retained.
	commitments [][]byte
	tree        [][][32]byte
	mu          sync.Mutex
	lastMDU     uint64
	lastProof   *authenticatedUserMDU
}
type authenticatedUserMDU struct {
	commitments                 []byte
	tree                        [][][32]byte
	rootCommitment, rootOpening []byte
	rootPath                    [][]byte
}
type generationCacheEntry struct {
	value *authenticatedGeneration
	used  uint64
}

var retrievalMetadataCache = struct {
	sync.Mutex
	entries map[retrievalGenerationKey]generationCacheEntry
	clock   uint64
	group   singleflight.Group
}{entries: make(map[retrievalGenerationKey]generationCacheEntry)}

func authenticatedRetrievalMetadata(ctx context.Context, dir string, c retrievalchallenge.Context) (*authenticatedGeneration, error) {
	key := retrievalGeneration(c)
	retrievalMetadataCache.Lock()
	entry, found := retrievalMetadataCache.entries[key]
	if found {
		retrievalMetadataCache.clock++
		entry.used = retrievalMetadataCache.clock
		retrievalMetadataCache.entries[key] = entry
	}
	retrievalMetadataCache.Unlock()
	if found {
		return entry.value, nil
	}
	// Callers are already admitted. Do (rather than detached work) keeps native
	// preparation inside that admission bound even if the requesting client leaves.
	value, err, _ := retrievalMetadataCache.group.Do(fmt.Sprintf("%#v", key), func() (interface{}, error) {
		retrievalMetadataCache.Lock()
		cached, ok := retrievalMetadataCache.entries[key]
		retrievalMetadataCache.Unlock()
		if ok {
			return cached.value, nil
		}
		prepared, err := prepareRetrievalMetadata(ctx, dir, c)
		if err != nil {
			return nil, err
		}
		retrievalMetadataCache.Lock()
		defer retrievalMetadataCache.Unlock()
		if len(retrievalMetadataCache.entries) >= maxRetrievalResponses {
			var oldest retrievalGenerationKey
			age := ^uint64(0)
			for k, v := range retrievalMetadataCache.entries {
				if v.used < age {
					oldest, age = k, v.used
				}
			}
			delete(retrievalMetadataCache.entries, oldest)
		}
		retrievalMetadataCache.clock++
		retrievalMetadataCache.entries[key] = generationCacheEntry{prepared, retrievalMetadataCache.clock}
		return prepared, nil
	})
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return value.(*authenticatedGeneration), nil
}

func readExactArtifactRange(path string, size, offset, length uint64) ([]byte, error) {
	if size > types.MDU_SIZE || offset > size || length > size-offset {
		return nil, fmt.Errorf("artifact range exceeds bounded size")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() != int64(size) {
		return nil, fmt.Errorf("artifact has invalid type or size")
	}
	data := make([]byte, int(length))
	if _, err := f.ReadAt(data, int64(offset)); err != nil {
		return nil, err
	}
	return data, nil
}

func prepareRetrievalMetadata(ctx context.Context, dir string, c retrievalchallenge.Context) (*authenticatedGeneration, error) {
	if _, err := c.Bytes(); err != nil {
		return nil, err
	}
	wire, err := readExactArtifactRange(filepath.Join(dir, "mdu_0.bin"), types.MDU_SIZE, 0, types.MDU_SIZE)
	if err != nil {
		return nil, err
	}
	builder, err := crypto_ffi.LoadMdu0Builder(wire, c.UserMDUs)
	if err != nil {
		return nil, fmt.Errorf("noncanonical MDU #0: %w", err)
	}
	builder.Free()
	commitments := make([][]byte, 64)
	leaves := make([][32]byte, 64)
	for i := range commitments {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		commitments[i], err = crypto_ffi.CommitReceivedBlob(wire[i*types.BLOB_SIZE : (i+1)*types.BLOB_SIZE])
		if err != nil {
			return nil, err
		}
		leaves[i] = blake2s.Sum256(commitments[i])
	}
	tree := buildProofMerkleTree(leaves)
	if tree[len(tree)-1][0] != c.Root {
		return nil, fmt.Errorf("MDU #0 does not match frozen manifest root")
	}
	return &authenticatedGeneration{rootTable: bytes.Clone(wire[:16*types.BLOB_SIZE]), commitments: commitments, tree: tree}, nil
}

// Authenticate exactly the complete ordered commitment list for this user MDU.
// The enclosing witness packaging is not cached or claimed to be authenticated.
func (g *authenticatedGeneration) userMDU(ctx context.Context, dir string, c retrievalchallenge.Context) (*authenticatedUserMDU, error) {
	// ponytail: one prepared user MDU per generation; a measured working-set miss
	// rate can justify a larger cache, while every caller remains memory-bounded.
	g.mu.Lock()
	defer g.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if g.lastProof != nil && g.lastMDU == c.StartMDU {
		return g.lastProof, nil
	}
	leafCount := uint64(64/c.K) * uint64(c.K+c.M)
	raw, err := readFrozenWitnessCommitments(dir, c, leafCount)
	if err != nil {
		return nil, err
	}
	leaves := make([][32]byte, int(leafCount))
	for i := range leaves {
		leaves[i] = blake2s.Sum256(raw[i*48 : (i+1)*48])
	}
	tree := buildProofMerkleTree(leaves)
	root := tree[len(tree)-1][0]
	// PolyFS roots are full Blake2s digests. Hop 1 reduces that digest into Fr;
	// the canonical root-table cell must never replace the full Hop 2 digest.
	if c.StartMDU == 0 || c.StartMDU > 65536 {
		return nil, fmt.Errorf("root-table index out of range")
	}
	du, cell := (c.StartMDU-1)/4096, (c.StartMDU-1)%4096
	opening, _, err := crypto_ffi.ComputeManifestProof(g.rootTable[du*types.BLOB_SIZE:(du+1)*types.BLOB_SIZE], cell)
	if err != nil {
		return nil, err
	}
	path := proofMerklePath(g.tree, int(du))
	flat, _ := flattenMerkleProof32(path)
	valid, err := crypto_ffi.VerifyMdu0RootTableProof(c.Root[:], c.StartMDU, root[:], g.commitments[du], flat, opening)
	if err != nil {
		return nil, err
	}
	if !valid {
		return nil, fmt.Errorf("witness commitment list does not match frozen root table")
	}
	p := &authenticatedUserMDU{raw, tree, g.commitments[du], opening, path}
	g.lastMDU, g.lastProof = c.StartMDU, p
	return p, nil
}

func readFrozenWitnessCommitments(dir string, c retrievalchallenge.Context, leaves uint64) ([]byte, error) {
	if _, err := c.Bytes(); err != nil {
		return nil, err
	}
	if leaves == 0 || leaves > 16384 || c.MetadataMDUs < 2 {
		return nil, fmt.Errorf("invalid witness geometry")
	}
	span := leaves * 48
	total := c.UserMDUs * span // C2 bounds Users <= 65536 and leaves <= 16384.
	if total > (c.MetadataMDUs-1)*RawMduCapacity {
		return nil, fmt.Errorf("witness allocation is too small")
	}
	start := (c.StartMDU - c.MetadataMDUs) * span
	out := make([]byte, 0, int(span))
	for pos := start; pos < start+span; {
		index, offset := pos/RawMduCapacity, pos%RawMduCapacity
		end := min(start+span, (index+1)*RawMduCapacity)
		firstScalar, lastScalar := offset/31, (end-index*RawMduCapacity-1)/31
		encoded, err := readExactArtifactRange(filepath.Join(dir, fmt.Sprintf("mdu_%d.bin", index+1)), types.MDU_SIZE, firstScalar*32, (lastScalar-firstScalar+1)*32)
		if err != nil {
			return nil, err
		}
		for i := firstScalar; i <= lastScalar; i++ {
			scalar := encoded[(i-firstScalar)*32 : (i-firstScalar+1)*32]
			logical := index*RawMduCapacity + i*31
			payloadLen := min(uint64(31), total-logical)
			base := 32 - payloadLen // Legacy payload packing right-aligns its final scalar.
			for _, b := range scalar[:base] {
				if b != 0 {
					return nil, fmt.Errorf("noncanonical witness scalar prefix or final padding")
				}
			}
			lo, hi := max(pos, logical)-logical, min(end, logical+payloadLen)-logical
			out = append(out, scalar[base+lo:base+hi]...)
		}
		pos = end
	}
	if uint64(len(out)) != span {
		return nil, io.ErrUnexpectedEOF
	}
	return out, nil
}

// buildProofMerkleTree follows rs_merkle: an odd node propagates unchanged.
// Retain levels once so a multi-blob response does not rebuild each sibling path.
func buildProofMerkleTree(leaves [][32]byte) [][][32]byte {
	tree := [][][32]byte{leaves}
	for len(leaves) > 1 {
		next := make([][32]byte, (len(leaves)+1)/2)
		for i := range next {
			next[i] = leaves[2*i]
			if 2*i+1 < len(leaves) {
				var pair [64]byte
				copy(pair[:32], leaves[2*i][:])
				copy(pair[32:], leaves[2*i+1][:])
				next[i] = blake2s.Sum256(pair[:])
			}
		}
		tree = append(tree, next)
		leaves = next
	}
	return tree
}
func proofMerklePath(tree [][][32]byte, index int) [][]byte {
	path := make([][]byte, 0, len(tree)-1)
	for _, level := range tree[:len(tree)-1] {
		sibling := index ^ 1
		if sibling < len(level) {
			path = append(path, bytes.Clone(level[sibling][:]))
		}
		index /= 2
	}
	return path
}

func generateFrozenSessionProof(ctx context.Context, dir string, f *frozenRetrievalSession) ([]types.ChainedProof, []byte, error) {
	c := f.Context
	if c.BlobCount == 0 || c.BlobCount > 64 {
		return nil, nil, fmt.Errorf("session exceeds response limit")
	}
	challenges, err := c.Challenges(f.Seed[:])
	if err != nil {
		return nil, nil, err
	}
	hash, err := c.Hash()
	if err != nil || hash != f.Hash {
		return nil, nil, fmt.Errorf("frozen context hash mismatch")
	}
	if len(challenges) > 64 {
		return nil, nil, fmt.Errorf("session exceeds response limit")
	}
	metadata, err := authenticatedRetrievalMetadata(ctx, dir, c)
	if err != nil {
		return nil, nil, err
	}
	user, err := metadata.userMDU(ctx, dir, c)
	if err != nil {
		return nil, nil, err
	}
	rows := uint64(64 / c.K)
	path := filepath.Join(dir, fmt.Sprintf("mdu_%d.bin", c.StartMDU))
	if c.Layout == retrievalchallenge.Stripe {
		path = filepath.Join(dir, fmt.Sprintf("mdu_%d_slot_%d.bin", c.StartMDU, c.Slot))
	}
	window, err := readExactArtifactRange(path, rows*types.BLOB_SIZE, (uint64(c.StartLeaf)%rows)*types.BLOB_SIZE, c.BlobCount*types.BLOB_SIZE)
	if err != nil {
		return nil, nil, err
	}
	proofs := make([]types.ChainedProof, len(challenges))
	root := user.tree[len(user.tree)-1][0]
	for i, ch := range challenges {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		blob := window[i*types.BLOB_SIZE : (i+1)*types.BLOB_SIZE]
		commitment, err := crypto_ffi.CommitReceivedBlob(blob)
		if err != nil {
			return nil, nil, err
		}
		expected := user.commitments[int(ch.LeafIndex)*48 : (int(ch.LeafIndex)+1)*48]
		if !bytes.Equal(commitment, expected) {
			return nil, nil, fmt.Errorf("stored response blob does not match authenticated commitment")
		}
		opening, y, err := crypto_ffi.ComputeBlobProof(blob, ch.Z[:])
		if err != nil {
			return nil, nil, err
		}
		proofs[i] = types.ChainedProof{MduIndex: ch.MDUIndex, BlobIndex: ch.LeafIndex, MduRootFr: root[:], RootTableDuCommitment: user.rootCommitment, RootTableDuMerklePath: user.rootPath, ManifestOpening: user.rootOpening, BlobCommitment: commitment, MerklePath: proofMerklePath(user.tree, int(ch.LeafIndex)), ZValue: ch.Z[:], YValue: y, KzgOpeningProof: opening}
	}
	valid, err := crypto_ffi.VerifyPolyFSSessionProofBatch(c.Root[:], f.Hash[:], f.Seed[:], rows*uint64(c.K+c.M), proofs)
	if err != nil {
		return nil, nil, err
	}
	if !valid {
		return nil, nil, fmt.Errorf("generated session proof failed batch verification")
	}
	return proofs, window, nil
}
