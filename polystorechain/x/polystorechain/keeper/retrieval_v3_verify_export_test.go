package keeper

import "polystorechain/x/polystorechain/types"

// VerifyPolyFSChainedProofForTest exposes the exact pure V3 per-sample verifier
// to external-package race tests and benchmarks without adding a production API.
func VerifyPolyFSChainedProofForTest(root []byte, proof *types.ChainedProof, leafCount uint64) (bool, error) {
	return verifyPolyFSChainedProof(root, proof, leafCount)
}
