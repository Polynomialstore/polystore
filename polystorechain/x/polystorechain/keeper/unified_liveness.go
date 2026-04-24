package keeper

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"strings"

	"cosmossdk.io/collections"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"

	"polystorechain/x/polystorechain/types"
)

var (
	epochSeedTag     = []byte("polystore/epoch/v1")
	challengeSeedTag = []byte("polystore/chal/v1")
	creditSeenTag    = []byte("polystore/credit/v1")
	syntheticSeenTag = []byte("polystore/synth/v1")
	deputySeenTag    = []byte("polystore/deputy/v1")
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
	if err != nil {
		if !errors.Is(err, collections.ErrNotFound) {
			return err
		}

		seed := deriveEpochSeed(ctx.ChainID(), epochID, ctx.HeaderHash())
		if err := k.EpochSeeds.Set(goCtx, epochID, seed[:]); err != nil {
			return err
		}
		ctx.Logger().Debug("epoch seed set", "epoch_id", epochID, "height", height)
	}

	// Epoch start hooks:
	// - Update dynamic pricing parameters (devnet-only; optional, bounded).
	// - Mint deterministic protocol audit budget (with carryover cap).
	// - Derive deterministic audit tasks (bounded by what the budget can afford).
	if err := k.updateDynamicPricingAtEpochStart(ctx, epochID); err != nil {
		return err
	}
	if _, _, err := k.mintProtocolAuditBudget(ctx); err != nil {
		return err
	}
	if err := k.deriveAuditTasks(ctx, epochID); err != nil {
		return err
	}
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
		return sha256.Sum256([]byte("polystore/epoch/zero"))
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

func deputySeenKey(epochID uint64, dealID uint64, assignment []byte, mduIndex uint64, blobIndex uint64) []byte {
	buf := make([]byte, 0, len(deputySeenTag)+8+8+len(assignment)+8+8)
	buf = append(buf, deputySeenTag...)
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

func (k Keeper) recordCreditMode2(ctx sdk.Context, epochID uint64, dealID uint64, slot uint32, key collections.Pair[collections.Pair[uint64, uint32], uint64], mduIndex uint64, blobIndex uint64) (bool, error) {
	if epochID == 0 {
		return false, nil
	}
	assignment := assignmentBytesMode2(slot)
	seenKey := creditSeenKey(epochID, dealID, assignment, mduIndex, blobIndex)
	_, err := k.CreditSeen.Get(ctx, seenKey)
	if err == nil {
		return false, nil
	}
	if !errors.Is(err, collections.ErrNotFound) {
		return false, err
	}
	if err := k.CreditSeen.Set(ctx, seenKey, true); err != nil {
		return false, err
	}
	current, err := k.Mode2EpochCredits.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return false, err
	}
	return true, k.Mode2EpochCredits.Set(ctx, key, current+1)
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

func (k Keeper) epochSeed(ctx sdk.Context, epochID uint64) ([32]byte, error) {
	var seed [32]byte
	if epochID == 0 {
		return seed, nil
	}

	seedBytes, err := k.EpochSeeds.Get(ctx, epochID)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return seed, err
	}

	if errors.Is(err, collections.ErrNotFound) || len(seedBytes) != 32 {
		sum := deriveEpochSeed(ctx.ChainID(), epochID, ctx.HeaderHash())
		if err := k.EpochSeeds.Set(ctx, epochID, sum[:]); err != nil {
			return seed, err
		}
		seedBytes = sum[:]
	}
	copy(seed[:], seedBytes)
	return seed, nil
}

func (k Keeper) recordCreditForProof(ctx sdk.Context, epochID uint64, deal types.Deal, stripe stripeParams, provider string, mduIndex uint64, blobIndex uint32) error {
	if epochID == 0 {
		return nil
	}

	if stripe.mode == 2 {
		slot, err := leafSlotIndex(uint64(blobIndex), stripe.rows)
		if err != nil {
			return err
		}

		slotU := uint32(slot)
		activeProvider, pendingProvider := mode2SlotProviders(deal, slotU)
		creator := strings.TrimSpace(provider)
		active := strings.TrimSpace(activeProvider)
		pending := strings.TrimSpace(pendingProvider)

		// Only count credits toward the slot if the proof was submitted by the slot's
		// active provider (or the pending provider while repairing). Deputy proofs
		// should not reduce the synthetic quota for a missing slot.
		allowed := false
		if creator != "" && creator == active {
			allowed = true
		}
		if !allowed && creator != "" && pending != "" && creator == pending {
			allowed = true
		}
		if !allowed {
			// Best-effort evidence: the slot was served by someone else (deputy).
			if active != "" {
				extra := make([]byte, 0, 4+8+4+len(creator))
				extra = binary.BigEndian.AppendUint32(extra, slotU)
				extra = binary.BigEndian.AppendUint64(extra, mduIndex)
				extra = binary.BigEndian.AppendUint32(extra, blobIndex)
				extra = append(extra, []byte(creator)...)
				eid := deriveEvidenceID("deputy_served", deal.Id, epochID, extra)
				if err := k.recordEvidenceSummary(ctx, deal.Id, active, "deputy_served", eid[:], "chain", false); err != nil {
					ctx.Logger().Error("failed to record deputy evidence summary", "error", err)
				}

				// Audit debt: track deputy-served leaf proofs so epoch-end enforcement
				// can start repairs even if synthetic fill meets quota.
				assignment := assignmentBytesMode2(slotU)
				seenKey := deputySeenKey(epochID, deal.Id, assignment, mduIndex, uint64(blobIndex))
				_, err := k.DeputySeen.Get(ctx, seenKey)
				if err == nil {
					return nil
				}
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return err
				}
				if err := k.DeputySeen.Set(ctx, seenKey, true); err != nil {
					return err
				}

				deputyKey := collections.Join(collections.Join(deal.Id, slotU), epochID)
				current, err := k.Mode2EpochDeputyServed.Get(ctx, deputyKey)
				if err != nil && !errors.Is(err, collections.ErrNotFound) {
					return err
				}
				if err := k.Mode2EpochDeputyServed.Set(ctx, deputyKey, current+1); err != nil {
					return err
				}
			}
			return nil
		}

		key := collections.Join(collections.Join(deal.Id, slotU), epochID)
		counted, err := k.recordCreditMode2(ctx, epochID, deal.Id, slotU, key, mduIndex, uint64(blobIndex))
		if err != nil {
			return err
		}
		if counted && pending != "" && creator == pending {
			return k.markMode2RepairReady(ctx, deal, slotU, creator, epochID)
		}
		return nil
	}

	assignment, err := assignmentBytesMode1(provider)
	if err != nil {
		return err
	}
	key := collections.Join(collections.Join(deal.Id, provider), epochID)
	return k.recordCredit(ctx, epochID, deal.Id, assignment, key, mduIndex, uint64(blobIndex))
}

func (k Keeper) validateAndRecordSystemProof(ctx sdk.Context, epochID uint64, seed [32]byte, params types.Params, deal types.Deal, stripe stripeParams, provider string, mduIndex uint64, blobIndex uint32) error {
	if epochID == 0 {
		return nil
	}

	in, hasSlab := slabInputs(deal)
	if !hasSlab || in.userMdus == 0 {
		return nil
	}

	var quotaBlobs uint64
	switch stripe.mode {
	case 2:
		quotaBlobs = requiredBlobsMode2(params, deal, stripe, in)
	default:
		quotaBlobs = requiredBlobsMode1(params, deal, in)
	}

	creditCap := creditCapBlobs(params, quotaBlobs)

	if stripe.mode == 2 {
		slot, err := leafSlotIndex(uint64(blobIndex), stripe.rows)
		if err != nil {
			return err
		}

		slotU := uint32(slot)
		activeProvider, pendingProvider := mode2SlotProviders(deal, slotU)
		creator := strings.TrimSpace(provider)
		active := strings.TrimSpace(activeProvider)
		pending := strings.TrimSpace(pendingProvider)
		allowed := false
		if creator != "" && creator == active {
			allowed = true
		}
		if !allowed && creator != "" && pending != "" && creator == pending {
			allowed = true
		}
		if !allowed {
			return sdkerrors.ErrInvalidRequest.Wrapf("system proof from unauthorized provider for slot %d", slot)
		}

		creditKey := collections.Join(collections.Join(deal.Id, slotU), epochID)
		credits, err := k.Mode2EpochCredits.Get(ctx, creditKey)
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return err
		}
		if creditCap > 0 && credits > creditCap {
			credits = creditCap
		}

		syntheticRequired := uint64(0)
		if quotaBlobs > credits {
			syntheticRequired = quotaBlobs - credits
		}
		if syntheticRequired == 0 {
			return sdkerrors.ErrInvalidRequest.Wrap("no synthetic proofs required for this epoch")
		}

		synth, err := k.Mode2EpochSynthetic.Get(ctx, creditKey)
		if err != nil && !errors.Is(err, collections.ErrNotFound) {
			return err
		}
		if synth >= syntheticRequired {
			return sdkerrors.ErrInvalidRequest.Wrap("synthetic quota already satisfied for this epoch")
		}

		slotU64 := uint64(slotU)
		found := false
		for i := uint64(0); i < syntheticRequired; i++ {
			expMdu, expBlob := deriveMode2Challenge(seed, deal.Id, deal.CurrentGen, slotU64, i, in, stripe)
			if expMdu == mduIndex && expBlob == blobIndex {
				found = true
				break
			}
		}
		if !found {
			return sdkerrors.ErrInvalidRequest.Wrap("system proof does not match any required synthetic challenge")
		}

		counted, err := k.recordSyntheticMode2(ctx, epochID, deal.Id, slotU, creditKey, mduIndex, uint64(blobIndex))
		if err != nil {
			return err
		}
		if !counted {
			return sdkerrors.ErrInvalidRequest.Wrap("duplicate synthetic challenge proof")
		}
		if pending != "" && creator == pending {
			return k.markMode2RepairReady(ctx, deal, slotU, creator, epochID)
		}
		return nil
	}

	assignment, err := assignmentBytesMode1(provider)
	if err != nil {
		return err
	}
	key := collections.Join(collections.Join(deal.Id, provider), epochID)

	credits, err := k.Mode1EpochCredits.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if creditCap > 0 && credits > creditCap {
		credits = creditCap
	}

	syntheticRequired := uint64(0)
	if quotaBlobs > credits {
		syntheticRequired = quotaBlobs - credits
	}
	if syntheticRequired == 0 {
		return sdkerrors.ErrInvalidRequest.Wrap("no synthetic proofs required for this epoch")
	}

	synth, err := k.Mode1EpochSynthetic.Get(ctx, key)
	if err != nil && !errors.Is(err, collections.ErrNotFound) {
		return err
	}
	if synth >= syntheticRequired {
		return sdkerrors.ErrInvalidRequest.Wrap("synthetic quota already satisfied for this epoch")
	}

	found := false
	for i := uint64(0); i < syntheticRequired; i++ {
		expMdu, expBlob := deriveMode1Challenge(seed, deal.Id, deal.CurrentGen, assignment, i, in)
		if expMdu == mduIndex && expBlob == blobIndex {
			found = true
			break
		}
	}
	if !found {
		return sdkerrors.ErrInvalidRequest.Wrap("system proof does not match any required synthetic challenge")
	}

	counted, err := k.recordSynthetic(ctx, epochID, deal.Id, assignment, key, mduIndex, uint64(blobIndex))
	if err != nil {
		return err
	}
	if !counted {
		return sdkerrors.ErrInvalidRequest.Wrap("duplicate synthetic challenge proof")
	}
	return nil
}

func mode2SlotProviders(deal types.Deal, slot uint32) (active string, pending string) {
	if deal.RedundancyMode == 2 && deal.Mode2Profile != nil && len(deal.Mode2Slots) > 0 && int(slot) < len(deal.Mode2Slots) {
		entry := deal.Mode2Slots[int(slot)]
		if entry == nil {
			return "", ""
		}
		active = strings.TrimSpace(entry.Provider)
		if entry.Status == types.SlotStatus_SLOT_STATUS_REPAIRING {
			pending = strings.TrimSpace(entry.PendingProvider)
		}
		return active, pending
	}
	if int(slot) >= 0 && int(slot) < len(deal.Providers) {
		active = strings.TrimSpace(deal.Providers[int(slot)])
	}
	return active, ""
}
