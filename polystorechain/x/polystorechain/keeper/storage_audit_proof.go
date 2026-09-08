package keeper

import (
	"bytes"
	"errors"
	"fmt"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	sdkerrors "github.com/cosmos/cosmos-sdk/types/errors"
	"polystorechain/pkg/retrievalchallenge"
	"polystorechain/x/polystorechain/types"
)

func (k msgServer) proveFrozenStorageAudit(ctx sdk.Context, msg *types.MsgProveLiveness) (*types.MsgProveLivenessResponse, error) {
	creator, err := requireCanonicalProviderCreator(msg.Creator)
	if err != nil {
		return nil, err
	}
	p := msg.GetSystemProof()
	if p == nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("system proof is required")
	}
	epoch, err := k.StorageAuditEpochs.Get(ctx, msg.EpochId)
	if err != nil {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("storage audit epoch not issued or retained")
	}
	if epoch.Params == nil {
		return nil, fmt.Errorf("missing frozen audit policy")
	}
	if epoch.Finalized {
		return nil, sdkerrors.ErrInvalidRequest.Wrap("storage audit epoch finalized")
	}
	audits, err := k.StorageAuditsForEpoch(ctx, msg.EpochId)
	if err != nil {
		return nil, err
	}
	for i, a := range audits {
		if a.Assignment == nil || a.Assignment.DealId != msg.DealId || a.Assignment.Provider != creator {
			continue
		}
		c, err := types.StorageAuditContext(a, epoch.EpochLength)
		if err != nil {
			return nil, err
		}
		rows := uint64(64) / uint64(c.K)
		leafCount := uint64(64)
		if c.Layout == retrievalchallenge.Stripe {
			leafCount = (uint64(c.K) + uint64(c.M)) * rows
		}
		if c.Layout == retrievalchallenge.Stripe && uint64(p.BlobIndex)/rows != uint64(c.Slot) {
			continue
		}
		if ctx.BlockHeight() < 0 || !c.Window.Contains(uint64(ctx.BlockHeight())) {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("outside frozen storage audit response window")
		}
		anchor, err := k.ChallengeAnchors.Get(ctx, c.Window.Anchor)
		if err != nil || len(anchor.Seed) != 32 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("storage audit anchor unavailable")
		}
		if err := ValidateChainedProofShape(c.Root[:], p, leafCount); err != nil {
			return nil, sdkerrors.ErrInvalidRequest.Wrap(err.Error())
		}
		// All candidate-dependent crypto work is prepaid, including derivation and
		// native verification. No cache, invalid-proof or duplicate discount.
		if err := PrepayProofCrypto(ctx, 1); err != nil {
			return nil, err
		}
		ctx.GasMeter().ConsumeGas(c.SampleCount*100, "bounded storage audit sample derivation")
		challenge, err := c.ChallengeForPosition(anchor.Seed, p.MduIndex, p.BlobIndex)
		if err != nil || !bytes.Equal(p.ZValue, challenge.Z[:]) {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("proof does not match exact frozen storage challenge")
		}
		if len(a.Coverage) != int((a.SampleCount+7)/8) || a.AcceptedCount > a.SampleCount {
			return nil, fmt.Errorf("corrupt storage audit coverage")
		}
		mask := byte(1 << (challenge.Ordinal % 8))
		index := challenge.Ordinal / 8
		if a.Coverage[index]&mask != 0 {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("duplicate storage audit challenge")
		}
		valid, err := verifyPolyFSChainedProof(c.Root[:], p, leafCount)
		if err != nil || !valid {
			return nil, sdkerrors.ErrInvalidRequest.Wrap("invalid storage audit proof")
		}
		a.Coverage[index] |= mask
		a.AcceptedCount++
		if err := k.StorageAudits.Set(ctx, collections.Join(msg.EpochId, uint32(i)), a); err != nil {
			return nil, err
		}
		tier, tierName, multiplier := livenessTierForLatency(ctx.BlockHeight() - int64(c.Window.Anchor))
		reward := math.ZeroInt()
		if c.Kind == retrievalchallenge.Repair {
			if a.AcceptedCount == a.SampleCount {
				if err := k.completeFrozenRepairReadiness(ctx, a, epoch); err != nil {
					return nil, err
				}
			}
		} else {
			provider, err := k.Providers.Get(ctx, creator)
			if err != nil && !errors.Is(err, collections.ErrNotFound) {
				return nil, err
			}
			registered := err == nil
			reason, err := k.providerHealthRewardIneligibility(ctx, provider)
			if err != nil {
				return nil, err
			}
			if registered && reason == "" && epoch.Params != nil && epoch.Params.HalvingInterval != 0 {
				decay := uint64(ctx.BlockHeight()) / epoch.Params.HalvingInterval
				if decay < 64 {
					reward = math.LegacyNewDecFromInt(math.NewInt(1000000).Quo(math.NewIntFromUint64(uint64(1) << decay))).Mul(multiplier).TruncateInt()
				}
				if reward.IsPositive() {
					if err := k.addProviderRewardClaims(ctx, creator, reward, math.ZeroInt()); err != nil {
						return nil, err
					}
				}
			}
		}
		ctx.EventManager().EmitEvent(sdk.NewEvent(types.TypeMsgProveLiveness, sdk.NewAttribute(types.AttributeKeyProvider, creator), sdk.NewAttribute(types.AttributeKeyDealID, fmt.Sprint(c.DealID)), sdk.NewAttribute("challenge_kind", fmt.Sprint(c.Kind)), sdk.NewAttribute("challenge_ordinal", fmt.Sprint(challenge.Ordinal)), sdk.NewAttribute(types.AttributeKeyTier, tierName), sdk.NewAttribute(types.AttributeKeyRewardAmount, reward.String())))
		return &types.MsgProveLivenessResponse{Success: true, Tier: tier, RewardAmount: reward.String()}, nil
	}
	return nil, sdkerrors.ErrUnauthorized.Wrap("no frozen obligation for this provider and assignment")
}

func (k Keeper) completeFrozenRepairReadiness(ctx sdk.Context, a types.FrozenStorageAudit, epoch types.FrozenStorageAuditEpoch) error {
	c, err := types.StorageAuditContext(a, epoch.EpochLength)
	if err != nil {
		return err
	}
	d, err := k.Deals.Get(ctx, c.DealID)
	if err != nil {
		return err
	}
	if d.CurrentGen != c.Generation || !bytes.Equal(d.ManifestRoot, c.Root[:]) || int(c.Slot) >= len(d.Mode2Slots) || d.RedundancyMode != 2 || d.Mode2Profile == nil || d.Mode2Profile.K != c.K || d.Mode2Profile.M != c.M || d.WitnessMdus+1 != c.MetadataMDUs || d.TotalMdus != c.MetadataMDUs+c.UserMDUs {
		return nil
	}
	slot := d.Mode2Slots[c.Slot]
	if slot == nil || slot.Status != types.SlotStatus_SLOT_STATUS_REPAIRING || slot.PendingProvider != a.Assignment.Provider || slot.RepairTargetGen != c.Generation {
		return nil
	}
	// Reuse the explicit readiness/evidence transition with exactly the frozen
	// completed count. No partially covered epoch is combined with another epoch.
	params := *epoch.Params
	params.QuotaMinBlobs = a.SampleCount
	params.QuotaMaxBlobs = a.SampleCount
	params.RepairReadinessQuotaBps = 10000
	if err := k.Mode2RepairReadinessProofs.Set(ctx, collections.Join(c.DealID, c.Slot), a.SampleCount-1); err != nil {
		return err
	}
	return k.markMode2RepairReady(ctx, params, d, c.Slot, a.Assignment.Provider, a.EpochId)
}
