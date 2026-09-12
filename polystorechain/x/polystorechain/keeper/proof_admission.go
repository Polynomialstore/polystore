package keeper

import (
	"fmt"
	"math"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"polystorechain/x/polystorechain/types"
)

// Consensus limits, changed only by a coordinated binary upgrade. A transaction
// may contain several messages; outer transaction/block limits apply separately.
const (
	MaxProofsPerMessage   = 64
	MaxProofLeafCount     = 256 * types.BlobsPerMdu
	MaxProofEnvelopeBytes = 128 * 1024
	MaxReceiptPathBytes   = 4096
	// ProofCryptoGas prices routes that verify each proof independently. The
	// PSB2 cross-session route has one shared verification plus bounded marginal
	// work and uses AggregateProofCryptoGas instead.
	ProofCryptoGas            = uint64(1_200_000)
	AggregateProofBaseGas     = uint64(1_000_000)
	AggregateProofMarginalGas = uint64(100_000)
	LegacyProofPayloadBytes   = uint64(types.BLOB_SIZE / 32 * 31)
)

// MerkleSiblingCount matches rs_merkle's promotion of an unpaired final node.
// In particular the last leaf in a five-leaf tree consumes one sibling, not three.
func MerkleSiblingCount(leaves, index uint64) (int, error) {
	if leaves == 0 || index >= leaves || leaves > MaxProofLeafCount {
		return 0, fmt.Errorf("invalid Merkle leaf count/index")
	}
	count := 0
	for leaves > 1 {
		if index^1 < leaves {
			count++
		}
		index /= 2
		leaves = leaves/2 + leaves%2
	}
	return count, nil
}

func validateMerklePath(path [][]byte, leaves, index uint64) error {
	count, err := MerkleSiblingCount(leaves, index)
	if err != nil {
		return err
	}
	if len(path) != count {
		return fmt.Errorf("Merkle path must contain exactly %d consumed siblings", count)
	}
	for _, node := range path {
		if len(node) != 32 {
			return fmt.Errorf("Merkle sibling must be 32 bytes")
		}
	}
	return nil
}

// ValidateChainedProofShape does no flattening or native parsing. Call it for the
// entire admitted list before prepaying crypto and entering either FFI verifier.
func ValidateChainedProofShape(root []byte, p *types.ChainedProof, leafCount uint64) error {
	if p == nil {
		return fmt.Errorf("proof is required")
	}
	if len(root) != types.POLYFS_ROOT_SIZE || len(p.MduRootFr) != 32 ||
		len(p.ManifestOpening) != 48 || len(p.RootTableDuCommitment) != 48 ||
		len(p.BlobCommitment) != 48 || len(p.ZValue) != 32 || len(p.YValue) != 32 || len(p.KzgOpeningProof) != 48 {
		return fmt.Errorf("invalid chained proof field length")
	}
	if p.MduIndex == 0 || p.MduIndex > polyfsRootTableCapacityMdus {
		return fmt.Errorf("proof MDU exceeds root table")
	}
	if err := validateMerklePath(p.RootTableDuMerklePath, types.BlobsPerMdu, (p.MduIndex-1)/4096); err != nil {
		return fmt.Errorf("root table: %w", err)
	}
	if err := validateMerklePath(p.MerklePath, leafCount, uint64(p.BlobIndex)); err != nil {
		return fmt.Errorf("blob: %w", err)
	}
	return nil
}

func ValidateProofTarget(deal types.Deal, p *types.ChainedProof) error {
	if deal.TotalMdus == 0 {
		return fmt.Errorf("legacy deal has no total_mdus; commit an explicit valid content layout before proving")
	}
	if p == nil || !isPolyFSUserDataMduTarget(deal, p.MduIndex) {
		return fmt.Errorf("proof must target an allocated user data MDU")
	}
	return nil
}

func ValidateProofCount(count uint64) error {
	if count == 0 || count > MaxProofsPerMessage {
		return fmt.Errorf("proof count must be 1..%d", MaxProofsPerMessage)
	}
	return nil
}

func PrepayProofCrypto(ctx sdk.Context, count uint64) error {
	if err := ValidateProofCount(count); err != nil {
		return err
	}
	if count > math.MaxUint64/ProofCryptoGas {
		return fmt.Errorf("proof crypto charge overflow")
	}
	ctx.GasMeter().ConsumeGas(count*ProofCryptoGas, "retrieval proof crypto")
	return nil
}

func AggregateProofCryptoGas(count uint64) (uint64, error) {
	if err := ValidateProofCount(count); err != nil {
		return 0, err
	}
	if count-1 > (math.MaxUint64-AggregateProofBaseGas)/AggregateProofMarginalGas {
		return 0, fmt.Errorf("aggregate proof crypto charge overflow")
	}
	return AggregateProofBaseGas + (count-1)*AggregateProofMarginalGas, nil
}

func PrepayAggregateProofCrypto(ctx sdk.Context, count uint64) error {
	gas, err := AggregateProofCryptoGas(count)
	if err != nil {
		return err
	}
	ctx.GasMeter().ConsumeGas(gas, "aggregate retrieval proof crypto")
	return nil
}

// Legacy receipts sign file-relative ranges but contain no authenticated file
// offset/table. These checks reject impossible claims; they cannot prove that a
// particular file range maps to the committed blob. V2 uses exact blob sessions.
func ValidateLegacyProofRange(deal types.Deal, p *types.ChainedProof, start, length uint64) error {
	if err := ValidateProofTarget(deal, p); err != nil {
		return err
	}
	if length == 0 || length > LegacyProofPayloadBytes {
		return fmt.Errorf("one proof range must be 1..%d payload bytes", LegacyProofPayloadBytes)
	}
	if start > math.MaxUint64-length || start+length > deal.Size_ {
		return fmt.Errorf("receipt range exceeds committed content")
	}
	return nil
}

// Legacy receipt pricing remains ceil(bytes/1024), without overflowing bytes+1023.
func LegacyReceiptUnits(bytes uint64) uint64 {
	units := bytes / 1024
	if bytes%1024 != 0 {
		units++
	}
	return units
}

func validateLivenessProofAdmission(deal types.Deal, leafCount uint64, msg *types.MsgProveLiveness) (uint64, error) {
	var count, total uint64
	addBytes := func(n int) error {
		if n < 0 || uint64(n) > MaxProofEnvelopeBytes-total {
			return fmt.Errorf("proof envelope exceeds %d bytes", MaxProofEnvelopeBytes)
		}
		total += uint64(n)
		return nil
	}
	proof := func(p *types.ChainedProof) error {
		count++
		if err := ValidateProofCount(count); err != nil {
			return err
		}
		if err := ValidateProofTarget(deal, p); err != nil {
			return err
		}
		if err := ValidateChainedProofShape(deal.ManifestRoot, p, leafCount); err != nil {
			return err
		}
		return addBytes(348 + 32*(len(p.MerklePath)+len(p.RootTableDuMerklePath)))
	}
	path := func(s string) error {
		if len(s) == 0 || len(s) > MaxReceiptPathBytes {
			return fmt.Errorf("receipt file path must be 1..%d bytes", MaxReceiptPathBytes)
		}
		return addBytes(len(s))
	}
	receipt := func(r *types.RetrievalReceipt) error {
		if r == nil {
			return fmt.Errorf("receipt is required")
		}
		if r.DealId != msg.DealId || r.EpochId != msg.EpochId || r.Provider != msg.Creator {
			return fmt.Errorf("receipt envelope mismatch")
		}
		if len(r.UserSignature) > 128 {
			return fmt.Errorf("receipt signature too long")
		}
		if err := path(r.FilePath); err != nil {
			return err
		}
		if r.BytesServed != r.RangeLen {
			return fmt.Errorf("receipt bytes_served must equal range_len")
		}
		if err := ValidateLegacyProofRange(deal, &r.ProofDetails, r.RangeStart, r.RangeLen); err != nil {
			return err
		}
		if err := addBytes(len(r.UserSignature) + len(r.Provider) + 64); err != nil {
			return err
		}
		return proof(&r.ProofDetails)
	}
	switch pt := msg.ProofType.(type) {
	case *types.MsgProveLiveness_SystemProof:
		if err := proof(pt.SystemProof); err != nil {
			// Preserve the legacy system-proof failure/evidence response. The
			// shared verifier rejects this shape without flattening or FFI.
			return 0, nil
		}
	case *types.MsgProveLiveness_UserReceipt:
		if err := receipt(pt.UserReceipt); err != nil {
			return 0, err
		}
	case *types.MsgProveLiveness_UserReceiptBatch:
		if pt.UserReceiptBatch == nil {
			return 0, fmt.Errorf("receipt batch is required")
		}
		if err := ValidateProofCount(uint64(len(pt.UserReceiptBatch.Receipts))); err != nil {
			return 0, err
		}
		for i := range pt.UserReceiptBatch.Receipts {
			if err := receipt(&pt.UserReceiptBatch.Receipts[i]); err != nil {
				return 0, err
			}
		}
	case *types.MsgProveLiveness_SessionProof:
		if pt.SessionProof == nil {
			return 0, fmt.Errorf("session proof is required")
		}
		r := &pt.SessionProof.SessionReceipt
		if r.DealId != msg.DealId || r.EpochId != msg.EpochId || r.Provider != msg.Creator {
			return 0, fmt.Errorf("session receipt envelope mismatch")
		}
		if err := ValidateProofCount(r.ChunkCount); err != nil {
			return 0, err
		}
		if uint64(len(pt.SessionProof.Chunks)) != r.ChunkCount || len(r.ChunkLeafRoot) != 32 || len(r.UserSignature) != 65 {
			return 0, fmt.Errorf("invalid session receipt shape")
		}
		if err := path(r.FilePath); err != nil {
			return 0, err
		}
		if err := addBytes(len(r.Provider) + len(r.UserSignature) + 96); err != nil {
			return 0, err
		}
		var bytes uint64
		var seen uint64
		// Download receipts use duplicated odd leaves, unlike the rs_merkle paths.
		depth := 0
		for n := r.ChunkCount; n > 1; n = n/2 + n%2 {
			depth++
		}
		for i := range pt.SessionProof.Chunks {
			c := &pt.SessionProof.Chunks[i]
			if uint64(c.LeafIndex) >= r.ChunkCount || seen&(uint64(1)<<c.LeafIndex) != 0 {
				return 0, fmt.Errorf("invalid or duplicate chunk leaf index")
			}
			seen |= uint64(1) << c.LeafIndex
			if len(c.MerklePath) != depth {
				return 0, fmt.Errorf("invalid chunk Merkle depth")
			}
			for _, node := range c.MerklePath {
				if len(node) != 32 {
					return 0, fmt.Errorf("invalid chunk Merkle sibling")
				}
			}
			if err := ValidateLegacyProofRange(deal, &c.ProofDetails, c.RangeStart, c.RangeLen); err != nil {
				return 0, err
			}
			if err := addBytes(24 + 32*len(c.MerklePath)); err != nil {
				return 0, err
			}
			if err := proof(&c.ProofDetails); err != nil {
				return 0, err
			}
			bytes += c.RangeLen // count and per-proof payload caps bound the sum.
		}
		if bytes != r.TotalBytes {
			return 0, fmt.Errorf("session proof total_bytes mismatch")
		}
	default:
		return 0, fmt.Errorf("invalid proof type")
	}
	return count, nil
}
