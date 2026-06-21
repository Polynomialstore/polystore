package main

import (
	"fmt"

	"polystorechain/x/crypto_ffi"
	"polystorechain/x/polystorechain/types"
)

const (
	mdu0RootTableDUs        = 16
	mdu0RootTableCellsPerDU = types.BLOB_SIZE / 32
)

func materializeMdu0RootTable(mdu0Bytes []byte, rootsByMduIndex map[uint64][]byte) error {
	if len(mdu0Bytes) != types.MDU_SIZE {
		return fmt.Errorf("invalid MDU #0 size: got %d want %d", len(mdu0Bytes), types.MDU_SIZE)
	}
	rootTableBytes := mdu0RootTableDUs * types.BLOB_SIZE
	for i := 0; i < rootTableBytes; i++ {
		mdu0Bytes[i] = 0
	}
	if len(rootsByMduIndex) == 0 {
		return nil
	}

	rootsByDU := make(map[uint64][][]byte)
	for mduIndex, root := range rootsByMduIndex {
		if mduIndex == 0 {
			return fmt.Errorf("mdu_index 0 is MDU #0 and is not represented in its root table")
		}
		if len(root) != 32 {
			return fmt.Errorf("mdu_index %d root length: got %d want 32", mduIndex, len(root))
		}
		rootTableIndex := mduIndex - 1
		du := rootTableIndex / mdu0RootTableCellsPerDU
		cell := rootTableIndex % mdu0RootTableCellsPerDU
		if du >= mdu0RootTableDUs {
			return fmt.Errorf("mdu_index %d exceeds MDU #0 root-table capacity", mduIndex)
		}

		roots := rootsByDU[du]
		for uint64(len(roots)) <= cell {
			roots = append(roots, make([]byte, 32))
		}
		copied := make([]byte, 32)
		copy(copied, root)
		roots[cell] = copied
		rootsByDU[du] = roots
	}

	for du, roots := range rootsByDU {
		_, blob, err := crypto_ffi.ComputeManifestCommitment(roots)
		if err != nil {
			return fmt.Errorf("compute root-table DU %d: %w", du, err)
		}
		start := int(du) * types.BLOB_SIZE
		copy(mdu0Bytes[start:start+types.BLOB_SIZE], blob)
	}
	return nil
}
