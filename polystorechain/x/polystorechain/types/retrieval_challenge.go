package types

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
	"unicode/utf8"

	sdk "github.com/cosmos/cosmos-sdk/types"
	gethCrypto "github.com/ethereum/go-ethereum/crypto"
	"polystorechain/pkg/retrievalchallenge"
)

// RetrievalSetupDigest names the checked-in chain/browser setup artifact. The
// native loader must independently enforce this identity before v2 activation.
const RetrievalSetupDigest = "d39b9f2d047cc9dca2de58f264b6a09448ccd34db967881a6713eacacf0f26b7"

// Session profile ceilings are intentionally independent of audit quotas. Their
// admitted maxima still require the deployment qualification in issue #260.
const (
	// MaxTransactionBytes is shared by consensus admission and client builders.
	// Changes require a coordinated binary upgrade.
	MaxTransactionBytes    = 1 << 20
	// MaxRetrievalV2BlockGas bounds one retrieval transaction's estimated gas.
	MaxRetrievalV2BlockGas = int64(64000000)
	// MaxRetrievalActivationBlockGas permits bounded first-activation throughput
	// qualification above the checked-in canonical consensus profile.
	MaxRetrievalActivationBlockGas        = int64(448000000)
	MaxRetrievalV2BlockBytes              = int64(2 * 1024 * 1024)
	MaxRetrievalSessionOpensPerBlock      = uint64(128)
	MaxRetrievalSessionExpiryRefsPerBlock = uint64(128)
	MaxLiveRetrievalSessionContexts       = uint64(8192)
	MaxRetrievalSessionTTL                = uint64(4096)
	MaxRetrievalSessionGenerationsPerDeal = uint64(8)
	MaxRetrievalSessionGenerations        = uint64(1024)
)

// HashRetrievalSessionIDV2 binds a domain, version, chain and effective payee to
// the existing fixed-width open ID. It cannot collide with a legacy ID without
// a hash collision. Session nonces retain their original assigned-provider scope.
func HashRetrievalSessionIDV2(legacyID []byte, chainID string, payee20 []byte) ([]byte, error) {
	if len(legacyID) != 32 || len(payee20) != 20 || len(chainID) == 0 || len(chainID) > 50 || !utf8.ValidString(chainID) || strings.ContainsRune(chainID, 0) {
		return nil, fmt.Errorf("invalid v2 session ID inputs")
	}
	b := []byte("polystore/retrieval-session/v2\x00")
	b = binary.BigEndian.AppendUint32(b, retrievalchallenge.Version)
	b = binary.BigEndian.AppendUint32(b, uint32(len(chainID)))
	b = append(b, chainID...)
	b = append(b, legacyID...)
	b = append(b, payee20...)
	return gethCrypto.Keccak256(b), nil
}

// RetrievalChallengeContext reconstructs a single statement from durable session
// state, never the mutable current deal or an untrusted proof-provider pin.
func RetrievalChallengeContext(s RetrievalSession) (retrievalchallenge.Context, error) {
	c := retrievalchallenge.Context{}
	x := s.ChallengeSnapshot
	if s.ChallengeVersion != retrievalchallenge.Version || x == nil || len(s.SessionId) != 32 || len(s.ManifestRoot) != 32 || s.OpenedHeight < 1 || x.Layout > 255 {
		return c, fmt.Errorf("missing or malformed versioned session snapshot")
	}
	setup, _ := hex.DecodeString(RetrievalSetupDigest)
	if !bytes.Equal(x.SetupDigest, setup) {
		return c, fmt.Errorf("unsupported session setup identity")
	}
	assigned, err := sdk.AccAddressFromBech32(s.Provider)
	if err != nil || len(assigned) != 20 || assigned.String() != s.Provider {
		return c, fmt.Errorf("invalid assigned provider")
	}
	payee, err := sdk.AccAddressFromBech32(s.AuthorizedProofProvider)
	if err != nil || len(payee) != 20 || payee.String() != s.AuthorizedProofProvider {
		return c, fmt.Errorf("invalid authorized proof provider")
	}
	window, err := retrievalchallenge.SessionWindow(uint64(s.OpenedHeight), s.ExpiresAt, x.DealEnd)
	if err != nil {
		return c, err
	}
	c = retrievalchallenge.Context{
		Version: s.ChallengeVersion, ChainID: x.ChainId, Kind: retrievalchallenge.Session,
		DealID: s.DealId, Generation: x.Generation, Layout: uint8(x.Layout), K: x.K, M: x.M, Slot: x.Slot,
		MetadataMDUs: x.MetadataMdus, UserMDUs: x.UserMdus,
		StartMDU: s.StartMduIndex, StartLeaf: s.StartBlobIndex, BlobCount: s.BlobCount,
		Window: window, DealEnd: x.DealEnd,
	}
	copy(c.ID[:], s.SessionId)
	copy(c.Root[:], s.ManifestRoot)
	copy(c.Assigned[:], assigned)
	copy(c.Payee[:], payee)
	copy(c.SetupDigest[:], setup)
	if _, err := c.Bytes(); err != nil {
		return retrievalchallenge.Context{}, err
	}
	if s.BlobCount > ^uint64(0)/BlobSizeBytes || s.TotalBytes != s.BlobCount*BlobSizeBytes {
		return retrievalchallenge.Context{}, fmt.Errorf("invalid billed encoded coverage")
	}
	return c, nil
}
