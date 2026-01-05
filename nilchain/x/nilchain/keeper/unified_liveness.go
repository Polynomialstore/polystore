package keeper

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"nilchain/x/nilchain/types"
)

var (
	epochSeedTag      = []byte("nilstore/epoch/v1")
	challengeSeedTag  = []byte("nilstore/chal/v1")
	creditSeenTag     = []byte("nilstore/credit/v1")
	syntheticSeenTag  = []byte("nilstore/synth/v1")
)

func (k Keeper) BeginBlock(goCtx context.Context) error {
	ctx := sdk.UnwrapSDKContext(goCtx)
	params := k.GetParams(ctx)
	if params.EpochLenBlocks == 0 {
		return nil
	}

	height := ctx.BlockHeight()
	if !isEpochStart(height, params.EpochLenBlocks) {
		return nil
	}

	epochID := epochIDAtHeight(height, params.EpochLenBlocks)
	if epochID == 0 {
		return nil
	}

	_, err := k.EpochSeeds.Get(goCtx, epochID)
	if err == nil {
		return nil
	}
	if !errors.Is(err, collections.ErrNotFound) {
		return err
	}

	seed := deriveEpochSeed(ctx.ChainID(), epochID, ctx.HeaderHash())
	if err := k.EpochSeeds.Set(goCtx, epochID, seed[:]); err != nil {
		return err
	}
	ctx.Logger().Debug("epoch seed set", "epoch_id", epochID, "height", height)
	return nil
}

func epochIDAtHeight(height int64, epochLen uint64) uint64 {
	if epochLen == 0 {
		return 0
	}
	// Use 1-indexed epochs so the first "real" block (height=1) maps to epoch 1.
	// This avoids referencing a nonexistent height 0 block hash while staying stable
	// across devnet/test environments.
	if height <= 0 {
		return 1
	}
	return uint64((height-1)/int64(epochLen)) + 1
}

func isEpochStart(height int64, epochLen uint64) bool {
	if epochLen == 0 {
		return false
	}
	if height <= 0 {
		return true
	}
	return uint64(height-1)%epochLen == 0
}

func isEpochEnd(height int64, epochLen uint64) bool {
	if epochLen == 0 {
		return false
	}
	if height <= 0 {
		return false
	}
	// Epoch 1 ends at height == epochLen.
	return uint64(height)%epochLen == 0
}

func deriveEpochSeed(chainID string, epochID uint64, headerHash []byte) [32]byte {
	buf := make([]byte, 0, len(epochSeedTag)+len(chainID)+8+len(headerHash))
	buf = append(buf, epochSeedTag...)
	buf = append(buf, []byte(chainID)...)
	buf = binary.BigEndian.AppendUint64(buf, epochID)
	buf = append(buf, headerHash...)
	return sha256.Sum256(buf)
}

func (k Keeper) getEpochSeed(ctx sdk.Context, epochID uint64) [32]byte {
	if epochID == 0 {
		return sha256.Sum256([]byte("nilstore/epoch/zero"))
	}
	seed, err := k.EpochSeeds.Get(ctx, epochID)
	if err == nil && len(seed) == 32 {
		var out [32]byte
		copy(out[:], seed)
		return out
	}
	// Fallback (tests/devnet): seed may not be initialised if BeginBlock wasn't run.
	return deriveEpochSeed(ctx.ChainID(), epochID, nil)
}

type quotaInputs struct {
	metaMdus uint64
	userMdus uint64
}

func slabInputs(deal types.Deal) (quotaInputs, bool) {
	meta := uint64(1)
	if deal.WitnessMdus > 0 {
		meta += deal.WitnessMdus
	}
	if deal.TotalMdus == 0 || deal.TotalMdus <= meta {
		return quotaInputs{}, false
	}
	return quotaInputs{
		metaMdus: meta,
		userMdus: deal.TotalMdus - meta,
	}, true
}

func quotaBpsForDeal(params types.Params, deal types.Deal) uint64 {
	info, err := types.ParseServiceHint(deal.ServiceHint)
	if err == nil && strings.EqualFold(strings.TrimSpace(info.Base), "Hot") {
		return params.QuotaBpsPerEpochHot
	}
	return params.QuotaBpsPerEpochCold
}

func requiredBlobsMode1(params types.Params, deal types.Deal, in quotaInputs) uint64 {
	quotaBps := quotaBpsForDeal(params, deal)
	slotBytes := in.userMdus * uint64(types.MDU_SIZE)
	return requiredBlobsFromSlotBytes(params, quotaBps, slotBytes)
}

func requiredBlobsMode2(params types.Params, deal types.Deal, stripe stripeParams, in quotaInputs) uint64 {
	quotaBps := quotaBpsForDeal(params, deal)
	slotBytes := in.userMdus * stripe.rows * uint64(types.BlobSizeBytes)
	return requiredBlobsFromSlotBytes(params, quotaBps, slotBytes)
}

func requiredBlobsFromSlotBytes(params types.Params, quotaBps uint64, slotBytes uint64) uint64 {
	if slotBytes == 0 {
		return 0
	}
	// target_bytes = ceil(slot_bytes * quota_bps / 10_000)
	targetBytes := mulDivCeil(slotBytes, quotaBps, 10000)
	if targetBytes == 0 {
		targetBytes = 1
	}
	// target_blobs = ceil(target_bytes / BLOB_SIZE)
	targetBlobs := divCeil(targetBytes, uint64(types.BlobSizeBytes))
	if targetBlobs == 0 {
		targetBlobs = 1
	}
	quota := targetBlobs
	if params.QuotaMinBlobs > 0 && quota < params.QuotaMinBlobs {
		quota = params.QuotaMinBlobs
	}
	if params.QuotaMaxBlobs > 0 && quota > params.QuotaMaxBlobs {
		quota = params.QuotaMaxBlobs
	}
	return quota
}

func creditCapBlobs(params types.Params, quotaBlobs uint64) uint64 {
	if quotaBlobs == 0 || params.CreditCapBps == 0 {
		return 0
	}
	return mulDivCeil(quotaBlobs, params.CreditCapBps, 10000)
}

func mulDivCeil(a uint64, b uint64, denom uint64) uint64 {
	if a == 0 || b == 0 {
		return 0
	}
	if denom == 0 {
		return 0
	}
	prod, overflow := mulUint64(a, b)
	if overflow {
		// Fall back to conservative cap on overflow.
		return ^uint64(0)
	}
	return divCeil(prod, denom)
}

func divCeil(num uint64, denom uint64) uint64 {
	if denom == 0 {
		return 0
	}
	q := num / denom
	if num%denom == 0 {
		return q
	}
	return q + 1
}

func mode1EpochKey(dealID uint64, provider string, epochID uint64) collections.Pair[collections.Pair[uint64, string], uint64] {
	return collections.Join(collections.Join(dealID, provider), epochID)
}

func mode2EpochKey(dealID uint64, slot uint32, epochID uint64) collections.Pair[collections.Pair[uint64, uint32], uint64] {
	return collections.Join(collections.Join(dealID, slot), epochID)
}

func creditSeenKey(epochID uint64, dealID uint64, assignment []byte, mduIndex uint64, blobIndex uint64) []byte {
	buf := make([]byte, 0, len(creditSeenTag)+8+8+len(assignment)+8+8)
	buf = append(buf, creditSeenTag...)
	buf = binary.BigEndian.AppendUint64(buf, epochID)
	buf = binary.BigEndian.AppendUint64(buf, dealID)
	buf = append(buf, assignment...)
	buf = binary.BigEndian.AppendUint64(buf, mduIndex)
	buf = binary.BigEndian.AppendUint64(buf, blobIndex)
	sum := sha256.Sum256(buf)
	return sum[:]
}

func syntheticSeenKey(epochID uint64, dealID uint64, assignment []byte, mduIndex uint64, blobIndex uint64) []byte {
	buf := make([]byte, 0, len(syntheticSeenTag)+8+8+len(assignment)+8+8)
	buf = append(buf, syntheticSeenTag...)
	buf = binary.BigEndian.AppendUint64(buf, epochID)
	buf = binary.BigEndian.AppendUint64(buf, dealID)
	buf = append(buf, assignment...)
	buf = binary.BigEndian.AppendUint64(buf, mduIndex)
	buf = binary.BigEndian.AppendUint64(buf, blobIndex)
	sum := sha256.Sum256(buf)
	return sum[:]
}

func assignmentBytesMode1(provider string) ([]byte, error) {
	addr, err := sdk.AccAddressFromBech32(provider)
	if err != nil {
		return nil, err
	}
	return addr.Bytes(), nil
}

func assignmentBytesMode2(slot uint32) []byte {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], slot)
	return b[:]
}

func deriveMode2Challenge(seed [32]byte, dealID uint64, currentGen uint64, slot uint64, ordinal uint64, in quotaInputs, stripe stripeParams) (uint64, uint32) {
	buf := make([]byte, 0, len(challengeSeedTag)+32+8*4)
	buf = append(buf, challengeSeedTag...)
	buf = append(buf, seed[:]...)
	buf = binary.BigEndian.AppendUint64(buf, dealID)
	buf = binary.BigEndian.AppendUint64(buf, currentGen)
	buf = binary.BigEndian.AppendUint64(buf, slot)
	buf = binary.BigEndian.AppendUint64(buf, ordinal)
	h := sha256.Sum256(buf)

	mduOrdinal := binary.BigEndian.Uint64(h[0:8]) % in.userMdus
	row := binary.BigEndian.Uint64(h[8:16]) % stripe.rows

	mduIndex := in.metaMdus + mduOrdinal
	leafIndex := slot*stripe.rows + row
	return mduIndex, uint32(leafIndex)
}

func deriveMode1Challenge(seed [32]byte, dealID uint64, currentGen uint64, provider []byte, ordinal uint64, in quotaInputs) (uint64, uint32) {
	buf := make([]byte, 0, len(challengeSeedTag)+32+8*3+len(provider))
	buf = append(buf, challengeSeedTag...)
	buf = append(buf, seed[:]...)
	buf = binary.BigEndian.AppendUint64(buf, dealID)
	buf = binary.BigEndian.AppendUint64(buf, currentGen)
	buf = append(buf, provider...)
	buf = binary.BigEndian.AppendUint64(buf, ordinal)
	h := sha256.Sum256(buf)

	mduOrdinal := binary.BigEndian.Uint64(h[0:8]) % in.userMdus
	blobIndex := binary.BigEndian.Uint64(h[8:16]) % uint64(types.BlobsPerMdu)
	mduIndex := in.metaMdus + mduOrdinal
	return mduIndex, uint32(blobIndex)
}

func (k Keeper) recordCredit(ctx sdk.Context, epochID uint64, dealID uint64, assignment []byte, key collections.Pair[collections.Pair[uint64, string], uint64], mduIndex uint64, blobIndex uint64) error {
	if epochID == 0 {
		return nil
	}
	seenKey := creditSeenKey(epochID, dealID, assignment, mduIndex, blobIndex)
	_, err := k.CreditSeen.Get(ctx, seenKey)
	if err == nil {
		return nil
	}
	if !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if err := k.CreditSeen.Set(ctx, seenKey, true); err != nil {
		return err
	}
	current, err := k.Mode1EpochCredits.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	return k.Mode1EpochCredits.Set(ctx, key, current+1)
}

func (k Keeper) recordCreditMode2(ctx sdk.Context, epochID uint64, dealID uint64, slot uint32, key collections.Pair[collections.Pair[uint64, uint32], uint64], mduIndex uint64, blobIndex uint64) error {
	if epochID == 0 {
		return nil
	}
	assignment := assignmentBytesMode2(slot)
	seenKey := creditSeenKey(epochID, dealID, assignment, mduIndex, blobIndex)
	_, err := k.CreditSeen.Get(ctx, seenKey)
	if err == nil {
		return nil
	}
	if !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if err := k.CreditSeen.Set(ctx, seenKey, true); err != nil {
		return err
	}
	current, err := k.Mode2EpochCredits.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	return k.Mode2EpochCredits.Set(ctx, key, current+1)
}

func (k Keeper) recordSynthetic(ctx sdk.Context, epochID uint64, dealID uint64, assignment []byte, key collections.Pair[collections.Pair[uint64, string], uint64], mduIndex uint64, blobIndex uint64) (bool, error) {
	if epochID == 0 {
		return false, nil
	}
	seenKey := syntheticSeenKey(epochID, dealID, assignment, mduIndex, blobIndex)
	_, err := k.SyntheticSeen.Get(ctx, seenKey)
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, collections.ErrNotFound) {
		return false, err
	}
	if err := k.SyntheticSeen.Set(ctx, seenKey, true); err != nil {
		return false, err
	}
	current, err := k.Mode1EpochSynthetic.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return false, err
	}
	return true, k.Mode1EpochSynthetic.Set(ctx, key, current+1)
}

func (k Keeper) recordSyntheticMode2(ctx sdk.Context, epochID uint64, dealID uint64, slot uint32, key collections.Pair[collections.Pair[uint64, uint32], uint64], mduIndex uint64, blobIndex uint64) (bool, error) {
	if epochID == 0 {
		return false, nil
	}
	assignment := assignmentBytesMode2(slot)
	seenKey := syntheticSeenKey(epochID, dealID, assignment, mduIndex, blobIndex)
	_, err := k.SyntheticSeen.Get(ctx, seenKey)
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, collections.ErrNotFound) {
		return false, err
	}
	if err := k.SyntheticSeen.Set(ctx, seenKey, true); err != nil {
		return false, err
	}
	current, err := k.Mode2EpochSynthetic.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return false, err
	}
	return true, k.Mode2EpochSynthetic.Set(ctx, key, current+1)
}

func (k Keeper) currentEpoch(ctx sdk.Context) uint64 {
	params := k.GetParams(ctx)
	return epochIDAtHeight(ctx.BlockHeight(), params.EpochLenBlocks)
}
