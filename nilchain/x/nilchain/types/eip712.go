package types

import (
	"encoding/binary"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
)

// Constants for EIP-712
const (
	EIP712DomainName    = "NilStore"
	EIP712DomainVersion = "1"
	// Using a zero address for verifying contract as we validate off-chain (in Cosmos).
	// Note: Some wallets might warn about zero address.
	VerifyingContract = "0x0000000000000000000000000000000000000000"
)

var (
	// Type Hashes
	// NOTE: viem/ethers uses the order defined in the types object, not necessarily sorted by name.

	// keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
	EIP712DomainTypeHash = crypto.Keccak256([]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))

	// keccak256("CreateDeal(address creator,uint64 duration,string service_hint,string initial_escrow,string max_monthly_spend,uint64 nonce)")
	CreateDealTypeHash = crypto.Keccak256([]byte("CreateDeal(address creator,uint64 duration,string service_hint,string initial_escrow,string max_monthly_spend,uint64 nonce)"))

	// keccak256("UpdateContent(address creator,uint64 deal_id,string cid,uint64 size,uint64 nonce)")
	UpdateContentTypeHash = crypto.Keccak256([]byte("UpdateContent(address creator,uint64 deal_id,string cid,uint64 size,uint64 nonce)"))

	// keccak256("RetrievalReceipt(uint64 deal_id,uint64 epoch_id,string provider,uint64 bytes_served,uint64 nonce)")
	RetrievalReceiptTypeHashV1 = crypto.Keccak256([]byte("RetrievalReceipt(uint64 deal_id,uint64 epoch_id,string provider,uint64 bytes_served,uint64 nonce)"))

	// keccak256("RetrievalReceipt(uint64 deal_id,uint64 epoch_id,string provider,uint64 bytes_served,uint64 nonce,uint64 expires_at,bytes32 proof_hash)")
	//
	// v2 binds the user's signature to the exact proof_details via proof_hash and includes expires_at.
	RetrievalReceiptTypeHashV2 = crypto.Keccak256([]byte("RetrievalReceipt(uint64 deal_id,uint64 epoch_id,string provider,uint64 bytes_served,uint64 nonce,uint64 expires_at,bytes32 proof_hash)"))

	// keccak256("RetrievalReceipt(uint64 deal_id,uint64 epoch_id,string provider,string file_path,uint64 range_start,uint64 range_len,uint64 bytes_served,uint64 nonce,uint64 expires_at,bytes32 proof_hash)")
	//
	// v3 adds range binding (file_path + range) while preserving proof_hash binding.
	RetrievalReceiptTypeHashV3 = crypto.Keccak256([]byte("RetrievalReceipt(uint64 deal_id,uint64 epoch_id,string provider,string file_path,uint64 range_start,uint64 range_len,uint64 bytes_served,uint64 nonce,uint64 expires_at,bytes32 proof_hash)"))

	// keccak256("DownloadSessionReceipt(uint64 deal_id,uint64 epoch_id,string provider,string file_path,uint64 total_bytes,uint64 chunk_count,bytes32 chunk_leaf_root,uint64 nonce,uint64 expires_at)")
	//
	// A session-level signature committing to a Merkle root of per-chunk leaf hashes.
	DownloadSessionReceiptTypeHash = crypto.Keccak256([]byte("DownloadSessionReceipt(uint64 deal_id,uint64 epoch_id,string provider,string file_path,uint64 total_bytes,uint64 chunk_count,bytes32 chunk_leaf_root,uint64 nonce,uint64 expires_at)"))

	// keccak256("RetrievalRequest(uint64 deal_id,string file_path,uint64 range_start,uint64 range_len,uint64 nonce,uint64 expires_at)")
	//
	// This is an off-chain authorization signature used by the Gateway to
	// ensure only the Deal Owner can initiate a fetch for a specific file path
	// and byte-range.
	RetrievalRequestTypeHash = crypto.Keccak256([]byte("RetrievalRequest(uint64 deal_id,string file_path,uint64 range_start,uint64 range_len,uint64 nonce,uint64 expires_at)"))
)

// HashDomainSeparator computes the domain separator for a specific chain ID.
// Fields: name, version, chainId, verifyingContract
func HashDomainSeparator(chainID *big.Int) common.Hash {
	return crypto.Keccak256Hash(
		EIP712DomainTypeHash,
		keccak256String(EIP712DomainName),
		keccak256String(EIP712DomainVersion),
		math.PaddedBigBytes(chainID, 32),
		pad32(common.HexToAddress(VerifyingContract).Bytes()),
	)
}

// HashCreateDeal computes the struct hash for a CreateDeal intent.
// Fields: creator, duration, service_hint, initial_escrow, max_monthly_spend, nonce
func HashCreateDeal(intent *EvmCreateDealIntent) (common.Hash, error) {
	creatorAddr := common.HexToAddress(intent.CreatorEvm)

	return crypto.Keccak256Hash(
		CreateDealTypeHash,
		pad32(creatorAddr.Bytes()),
		math.PaddedBigBytes(big.NewInt(int64(intent.DurationBlocks)), 32),
		keccak256String(intent.ServiceHint),
		keccak256String(intent.InitialEscrow.String()),   // Hash the string representation of Coin
		keccak256String(intent.MaxMonthlySpend.String()), // Hash the string representation of Coin
		math.PaddedBigBytes(big.NewInt(int64(intent.Nonce)), 32),
	), nil
}

// HashUpdateContent computes the struct hash for an UpdateContent intent.
// Fields: creator, deal_id, cid, size, nonce
func HashUpdateContent(intent *EvmUpdateContentIntent) (common.Hash, error) {
	creatorAddr := common.HexToAddress(intent.CreatorEvm)

	return crypto.Keccak256Hash(
		UpdateContentTypeHash,
		pad32(creatorAddr.Bytes()),
		math.PaddedBigBytes(big.NewInt(int64(intent.DealId)), 32),
		keccak256String(intent.Cid),
		math.PaddedBigBytes(big.NewInt(int64(intent.SizeBytes)), 32),
		math.PaddedBigBytes(big.NewInt(int64(intent.Nonce)), 32),
	), nil
}

// HashChainedProof computes a stable hash of the proof fields for binding signatures.
// The encoding is deterministic and does not depend on JSON or protobuf serialization.
func HashChainedProof(proof *ChainedProof) (common.Hash, error) {
	if proof == nil {
		return common.Hash{}, nil
	}

	// Conservative length checks to keep hashing stable and avoid panics.
	// The verifier also enforces lengths in the MsgProveLiveness flow.
	if len(proof.MduRootFr) != 32 ||
		len(proof.ManifestOpening) != 48 ||
		len(proof.BlobCommitment) != 48 ||
		len(proof.ZValue) != 32 ||
		len(proof.YValue) != 32 ||
		len(proof.KzgOpeningProof) != 48 {
		return common.Hash{}, nil
	}
	for _, node := range proof.MerklePath {
		if len(node) != 32 {
			return common.Hash{}, nil
		}
	}

	var b [8]byte
	binary.BigEndian.PutUint64(b[:], proof.MduIndex)
	buf := make([]byte, 0, 8+32+48+48+4+len(proof.MerklePath)*32+4+32+32+48)
	buf = append(buf, b[:]...)
	buf = append(buf, proof.MduRootFr...)
	buf = append(buf, proof.ManifestOpening...)
	buf = append(buf, proof.BlobCommitment...)

	var c [4]byte
	binary.BigEndian.PutUint32(c[:], uint32(len(proof.MerklePath)))
	buf = append(buf, c[:]...)
	for _, node := range proof.MerklePath {
		buf = append(buf, node...)
	}

	binary.BigEndian.PutUint32(c[:], proof.BlobIndex)
	buf = append(buf, c[:]...)
	buf = append(buf, proof.ZValue...)
	buf = append(buf, proof.YValue...)
	buf = append(buf, proof.KzgOpeningProof...)
	return crypto.Keccak256Hash(buf), nil
}

// HashRetrievalReceiptV1 computes the legacy struct hash for a RetrievalReceipt.
func HashRetrievalReceiptV1(receipt *RetrievalReceipt) (common.Hash, error) {
	return crypto.Keccak256Hash(
		RetrievalReceiptTypeHashV1,
		math.PaddedBigBytes(big.NewInt(int64(receipt.DealId)), 32),
		math.PaddedBigBytes(big.NewInt(int64(receipt.EpochId)), 32),
		keccak256String(receipt.Provider),
		math.PaddedBigBytes(big.NewInt(int64(receipt.BytesServed)), 32),
		math.PaddedBigBytes(big.NewInt(int64(receipt.Nonce)), 32),
	), nil
}

// HashRetrievalReceiptV2 computes the v2 struct hash for a RetrievalReceipt.
// v2 includes expires_at and proof_hash (derived from proof_details) to bind the user signature.
func HashRetrievalReceiptV2(receipt *RetrievalReceipt) (common.Hash, error) {
	proofHash, err := HashChainedProof(&receipt.ProofDetails)
	if err != nil {
		return common.Hash{}, err
	}

	return crypto.Keccak256Hash(
		RetrievalReceiptTypeHashV2,
		math.PaddedBigBytes(big.NewInt(int64(receipt.DealId)), 32),
		math.PaddedBigBytes(big.NewInt(int64(receipt.EpochId)), 32),
		keccak256String(receipt.Provider),
		math.PaddedBigBytes(big.NewInt(int64(receipt.BytesServed)), 32),
		math.PaddedBigBytes(big.NewInt(int64(receipt.Nonce)), 32),
		math.PaddedBigBytes(big.NewInt(int64(receipt.ExpiresAt)), 32),
		pad32(proofHash.Bytes()),
	), nil
}

// HashRetrievalReceiptV3 computes the v3 struct hash for a RetrievalReceipt.
// v3 adds file_path + range binding and still binds the user signature to proof_details via proof_hash.
func HashRetrievalReceiptV3(receipt *RetrievalReceipt) (common.Hash, error) {
	proofHash, err := HashChainedProof(&receipt.ProofDetails)
	if err != nil {
		return common.Hash{}, err
	}

	deal := new(big.Int).SetUint64(receipt.DealId)
	epoch := new(big.Int).SetUint64(receipt.EpochId)
	rs := new(big.Int).SetUint64(receipt.RangeStart)
	rl := new(big.Int).SetUint64(receipt.RangeLen)
	bs := new(big.Int).SetUint64(receipt.BytesServed)
	nonce := new(big.Int).SetUint64(receipt.Nonce)
	exp := new(big.Int).SetUint64(receipt.ExpiresAt)

	return crypto.Keccak256Hash(
		RetrievalReceiptTypeHashV3,
		math.PaddedBigBytes(deal, 32),
		math.PaddedBigBytes(epoch, 32),
		keccak256String(receipt.Provider),
		keccak256String(receipt.FilePath),
		math.PaddedBigBytes(rs, 32),
		math.PaddedBigBytes(rl, 32),
		math.PaddedBigBytes(bs, 32),
		math.PaddedBigBytes(nonce, 32),
		math.PaddedBigBytes(exp, 32),
		pad32(proofHash.Bytes()),
	), nil
}

// HashDownloadSessionReceipt computes the struct hash for a DownloadSessionReceipt.
func HashDownloadSessionReceipt(receipt *DownloadSessionReceipt) (common.Hash, error) {
	if receipt == nil {
		return common.Hash{}, nil
	}
	if len(receipt.ChunkLeafRoot) != 32 {
		return common.Hash{}, nil
	}

	deal := new(big.Int).SetUint64(receipt.DealId)
	epoch := new(big.Int).SetUint64(receipt.EpochId)
	total := new(big.Int).SetUint64(receipt.TotalBytes)
	chunks := new(big.Int).SetUint64(receipt.ChunkCount)
	nonce := new(big.Int).SetUint64(receipt.Nonce)
	exp := new(big.Int).SetUint64(receipt.ExpiresAt)

	return crypto.Keccak256Hash(
		DownloadSessionReceiptTypeHash,
		math.PaddedBigBytes(deal, 32),
		math.PaddedBigBytes(epoch, 32),
		keccak256String(receipt.Provider),
		keccak256String(receipt.FilePath),
		math.PaddedBigBytes(total, 32),
		math.PaddedBigBytes(chunks, 32),
		pad32(receipt.ChunkLeafRoot),
		math.PaddedBigBytes(nonce, 32),
		math.PaddedBigBytes(exp, 32),
	), nil
}

// HashRetrievalRequest computes the struct hash for an off-chain retrieval request.
// Fields: deal_id, file_path, range_start, range_len, nonce, expires_at
func HashRetrievalRequest(dealID uint64, filePath string, rangeStart uint64, rangeLen uint64, nonce uint64, expiresAt uint64) common.Hash {
	deal := new(big.Int).SetUint64(dealID)
	rs := new(big.Int).SetUint64(rangeStart)
	rl := new(big.Int).SetUint64(rangeLen)
	n := new(big.Int).SetUint64(nonce)
	exp := new(big.Int).SetUint64(expiresAt)

	return crypto.Keccak256Hash(
		RetrievalRequestTypeHash,
		math.PaddedBigBytes(deal, 32),
		keccak256String(filePath),
		math.PaddedBigBytes(rs, 32),
		math.PaddedBigBytes(rl, 32),
		math.PaddedBigBytes(n, 32),
		math.PaddedBigBytes(exp, 32),
	)
}

// ComputeEIP712Digest combines the domain separator and struct hash.
// digest = keccak256("\x19\x01" ‖ domainSeparator ‖ hashStruct(message))
func ComputeEIP712Digest(domainSep common.Hash, structHash common.Hash) []byte {
	return crypto.Keccak256(
		[]byte("\x19\x01"),
		domainSep.Bytes(),
		structHash.Bytes(),
	)
}

// Helpers

func keccak256String(s string) []byte {
	return crypto.Keccak256([]byte(s))
}

func pad32(b []byte) []byte {
	padded := make([]byte, 32)
	copy(padded[32-len(b):], b)
	return padded
}
