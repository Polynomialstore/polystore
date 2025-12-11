package types

import (
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
	VerifyingContract   = "0x0000000000000000000000000000000000000000" 
)

var (
	// Type Hashes
    // NOTE: viem/ethers uses the order defined in the types object, not necessarily sorted by name.
    
	// keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
	EIP712DomainTypeHash = crypto.Keccak256([]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))

	// keccak256("CreateDeal(address creator,uint32 size_tier,uint64 duration,string service_hint,string initial_escrow,string max_monthly_spend,uint64 nonce)")
	CreateDealTypeHash = crypto.Keccak256([]byte("CreateDeal(address creator,uint32 size_tier,uint64 duration,string service_hint,string initial_escrow,string max_monthly_spend,uint64 nonce)"))

	// keccak256("UpdateContent(address creator,uint64 deal_id,string cid,uint64 size,uint64 nonce)")
	UpdateContentTypeHash = crypto.Keccak256([]byte("UpdateContent(address creator,uint64 deal_id,string cid,uint64 size,uint64 nonce)"))
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
// Fields: creator, size_tier, duration, service_hint, initial_escrow, max_monthly_spend, nonce
func HashCreateDeal(intent *EvmCreateDealIntent) (common.Hash, error) {
    creatorAddr := common.HexToAddress(intent.CreatorEvm)
    
    return crypto.Keccak256Hash(
        CreateDealTypeHash,
        pad32(creatorAddr.Bytes()),
        math.PaddedBigBytes(big.NewInt(int64(intent.SizeTier)), 32),
        math.PaddedBigBytes(big.NewInt(int64(intent.DurationBlocks)), 32),
        keccak256String(intent.ServiceHint),
        keccak256String(intent.InitialEscrow.String()), // Hash the string representation of Coin
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
