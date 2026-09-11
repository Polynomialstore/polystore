package keeper

import (
	"fmt"

	"polystorechain/x/polystorechain/types"
)

// VerifyRetrievalProofsV3ForTest exposes the exact bounded worker path to the
// external-package race tests and benchmarks without adding a production API.
func VerifyRetrievalProofsV3ForTest(root []byte, proofs []*types.ChainedProof, workers int) []error {
	jobs := make([]retrievalProofVerificationV3, len(proofs))
	for i := range proofs {
		jobs[i] = retrievalProofVerificationV3{root: root, proof: proofs[i]}
	}
	verified := verifyRetrievalProofsV3(jobs, workers)
	errs := make([]error, len(verified))
	for i := range verified {
		if verified[i].err != nil {
			errs[i] = verified[i].err
		} else if !verified[i].ok {
			errs[i] = fmt.Errorf("invalid v3 chained proof")
		}
	}
	return errs
}
