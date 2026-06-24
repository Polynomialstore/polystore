package main

import (
	"encoding/hex"
	"fmt"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

func decodeMduRootHex(label, rootHex string) ([]byte, error) {
	rootBytes, err := decodeHex(rootHex)
	if err != nil {
		return nil, fmt.Errorf("invalid %s root %q: %w", label, rootHex, err)
	}
	if len(rootBytes) != types.POLYFS_ROOT_SIZE {
		return nil, fmt.Errorf("invalid %s root length: got %d want %d", label, len(rootBytes), types.POLYFS_ROOT_SIZE)
	}
	return rootBytes, nil
}

// computePolyfsManifestArtifacts materializes the MDU #0 root-table bytes,
// computes the canonical PolyFS root from the resulting MDU #0 Merkle root, and
// returns the legacy manifest blob used by compatibility/debug proof paths.
//
// mdu0Bytes is mutated in-place and must be written after this function returns.
func computePolyfsManifestArtifacts(mdu0Bytes []byte, rootsByMduIndex map[uint64][]byte, orderedSlabRoots [][]byte) (ManifestRoot, []byte, error) {
	if err := materializeMdu0RootTable(mdu0Bytes, rootsByMduIndex); err != nil {
		return ManifestRoot{}, nil, fmt.Errorf("materialize MDU #0 root table: %w", err)
	}

	mdu0Root, err := crypto_ffi.ComputeMduMerkleRoot(mdu0Bytes)
	if err != nil {
		return ManifestRoot{}, nil, fmt.Errorf("compute MDU #0 root: %w", err)
	}

	roots := make([][]byte, 0, 1+len(orderedSlabRoots))
	roots = append(roots, mdu0Root)
	for i, root := range orderedSlabRoots {
		if len(root) != types.POLYFS_ROOT_SIZE {
			return ManifestRoot{}, nil, fmt.Errorf("manifest root[%d] length: got %d want %d", i+1, len(root), types.POLYFS_ROOT_SIZE)
		}
		roots = append(roots, root)
	}

	_, manifestBlob, err := crypto_ffi.ComputeManifestCommitment(roots)
	if err != nil {
		return ManifestRoot{}, nil, fmt.Errorf("compute manifest commitment: %w", err)
	}

	parsedRoot, err := parseManifestRoot("0x" + hex.EncodeToString(mdu0Root))
	if err != nil {
		return ManifestRoot{}, nil, err
	}
	return parsedRoot, manifestBlob, nil
}
