package types

import (
	"fmt"
	"strconv"
	"strings"
)

const (
	// EvmCreateDealDomainSeparator is a fixed prefix used when constructing
	// the human-readable message that EVM wallets sign for MsgCreateDealFromEvm.
	// This is intentionally simple and non-EIP-712 for the first iteration so
	// that both the Go keeper and the web client can implement it easily.
	EvmCreateDealDomainSeparator = "NILSTORE_EVM_CREATE_DEAL"
)

// BuildEvmCreateDealMessage constructs the canonical string payload that is
// signed by the EVM wallet for an EvmCreateDealIntent. Both the web client
// (MetaMask) and the on-chain keeper must use this exact encoding.
//
// The format is:
//   "NILSTORE_EVM_CREATE_DEAL|<creator_evm>|<cid>|<size_bytes>|<duration_blocks>|<service_hint>|<initial_escrow>|<max_monthly_spend>|<nonce>|<chain_id>"
//
// All numeric values are encoded in base-10. creator_evm is lowercased and
// normalised to a 0x-prefixed hexadecimal address.
func BuildEvmCreateDealMessage(intent *EvmCreateDealIntent) (string, error) {
	if intent == nil {
		return "", fmt.Errorf("intent is nil")
	}

	creator := strings.TrimSpace(intent.CreatorEvm)
	creator = strings.ToLower(creator)
	if creator != "" && !strings.HasPrefix(creator, "0x") {
		creator = "0x" + creator
	}

	sizeStr := strconv.FormatUint(intent.SizeBytes, 10)
	durationStr := strconv.FormatUint(intent.DurationBlocks, 10)
	nonceStr := strconv.FormatUint(intent.Nonce, 10)

	parts := []string{
		EvmCreateDealDomainSeparator,
		creator,
		strings.TrimSpace(intent.Cid),
		sizeStr,
		durationStr,
		strings.TrimSpace(intent.ServiceHint),
		intent.InitialEscrow.String(),
		intent.MaxMonthlySpend.String(),
		nonceStr,
		strings.TrimSpace(intent.ChainId),
	}

	return strings.Join(parts, "|"), nil
}

