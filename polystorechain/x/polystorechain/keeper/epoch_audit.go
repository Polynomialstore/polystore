package keeper

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"strings"

	"cosmossdk.io/collections"
	"cosmossdk.io/math"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"

	"polystorechain/x/polystorechain/types"
)

const auditTasksMaxPerEpoch = uint64(64)

func (k Keeper) mintProtocolAuditBudget(ctx sdk.Context) (minted math.Int, capMint math.Int, err error) {
	params := k.GetParams(ctx)
	if params.EpochLenBlocks == 0 || params.StoragePrice.IsNil() || params.StoragePrice.IsNegative() {
		return math.ZeroInt(), math.ZeroInt(), nil
	}
	if params.AuditBudgetBps == 0 && params.AuditBudgetCapBps == 0 {
		return math.ZeroInt(), math.ZeroInt(), nil
	}

	totalActiveSlotBytes, err := k.totalActiveSlotBytes(ctx)
	if err != nil {
		return math.ZeroInt(), math.ZeroInt(), err
	}
	if totalActiveSlotBytes == 0 {
		return math.ZeroInt(), math.ZeroInt(), nil
	}

	epochLen := params.EpochLenBlocks
	rentDec := params.StoragePrice.
		MulInt(math.NewIntFromUint64(totalActiveSlotBytes)).
		MulInt(math.NewIntFromUint64(epochLen))

	// ceil(bps/10_000 * rent)
	applyBpsCeil := func(bps uint64) math.Int {
		if bps == 0 {
			return math.ZeroInt()
		}
		d := rentDec.
			MulInt(math.NewIntFromUint64(bps)).
			QuoInt(math.NewInt(10000))
		return d.Ceil().TruncateInt()
	}

	mint := applyBpsCeil(params.AuditBudgetBps)
	capAmt := applyBpsCeil(params.AuditBudgetCapBps)
	if capAmt.IsPositive() && mint.GT(capAmt) {
		mint = capAmt
	}

	if mint.IsPositive() {
		coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, mint))
		if err := k.BankKeeper.MintCoins(ctx, types.ProtocolBudgetModuleName, coins); err != nil {
			return math.ZeroInt(), capAmt, err
		}
	}

	// Carryover cap: bound the protocol budget module balance to N epochs worth of cap-mint.
	if capAmt.IsPositive() {
		carry := params.AuditBudgetCarryoverEpochs
		if carry == 0 {
			carry = 1
		}
		maxBalance := capAmt.Mul(math.NewIntFromUint64(carry))

		moduleAddr := authtypes.NewModuleAddress(types.ProtocolBudgetModuleName)
		bal := k.BankKeeper.GetBalance(ctx, moduleAddr, sdk.DefaultBondDenom).Amount
		if bal.GT(maxBalance) {
			excess := bal.Sub(maxBalance)
			coins := sdk.NewCoins(sdk.NewCoin(sdk.DefaultBondDenom, excess))
			// Burn excess via the main polystorechain module account (which has burner permission).
			if err := k.BankKeeper.SendCoinsFromModuleToModule(ctx, types.ProtocolBudgetModuleName, types.ModuleName, coins); err != nil {
				return mint, capAmt, err
			}
			if err := k.BankKeeper.BurnCoins(ctx, types.ModuleName, coins); err != nil {
				return mint, capAmt, err
			}
		}
	}

	return mint, capAmt, nil
}

func (k Keeper) totalActiveSlotBytes(ctx sdk.Context) (uint64, error) {
	height := uint64(ctx.BlockHeight())
	total := uint64(0)

	err := k.Deals.Walk(ctx, nil, func(dealID uint64, deal types.Deal) (stop bool, err error) {
		// end_block is exclusive: once height >= end_block, the deal is expired.
		if height < deal.StartBlock || height >= deal.EndBlock {
			return false, nil
		}
		in, ok := slabInputs(deal)
		if !ok {
			return false, nil
		}
		stripe, err := stripeParamsForDeal(deal)
		if err != nil {
			return false, nil
		}

		switch stripe.mode {
		case 2:
			slotBytes, overflow := mulUint64(in.userMdus, stripe.rows)
			if overflow {
				return false, fmt.Errorf("slot bytes overflow")
			}
			slotBytes, overflow = mulUint64(slotBytes, uint64(types.BlobSizeBytes))
			if overflow {
				return false, fmt.Errorf("slot bytes overflow")
			}
			if len(deal.Mode2Slots) == 0 {
				return false, nil
			}
			for _, slot := range deal.Mode2Slots {
				if slot == nil || slot.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
					continue
				}
				next, overflow := addUint64(total, slotBytes)
				if overflow {
					return false, fmt.Errorf("total slot bytes overflow")
				}
				total = next
			}
		default:
			// Mode 1: each provider holds the full user MDU payload.
			slotBytes, overflow := mulUint64(in.userMdus, uint64(types.MDU_SIZE))
			if overflow {
				return false, fmt.Errorf("slot bytes overflow")
			}
			for _, p := range deal.Providers {
				if strings.TrimSpace(p) == "" {
					continue
				}
				next, overflow := addUint64(total, slotBytes)
				if overflow {
					return false, fmt.Errorf("total slot bytes overflow")
				}
				total = next
			}
		}
		return false, nil
	})
	if err != nil {
		return 0, err
	}
	return total, nil
}

type auditTarget struct {
	dealID uint64
	deal   types.Deal
	stripe stripeParams
	in     quotaInputs

	mode     uint32
	provider string
	slot     uint32
}

func (k Keeper) deriveAuditTasks(ctx sdk.Context, epochID uint64) error {
	params := k.GetParams(ctx)
	if params.EpochLenBlocks == 0 {
		return nil
	}

	// Bound task derivation by what the protocol budget can actually afford.
	costPerTask := params.BaseRetrievalFee.Amount
	if params.RetrievalPricePerBlob.IsValid() && params.RetrievalPricePerBlob.Amount.IsPositive() {
		costPerTask = costPerTask.Add(params.RetrievalPricePerBlob.Amount)
	}
	if !costPerTask.IsPositive() {
		return nil
	}

	budgetAddr := authtypes.NewModuleAddress(types.ProtocolBudgetModuleName)
	budgetBal := k.BankKeeper.GetBalance(ctx, budgetAddr, sdk.DefaultBondDenom).Amount
	maxByBudget := budgetBal.Quo(costPerTask)
	if !maxByBudget.IsPositive() {
		return nil
	}
	maxTasks := auditTasksMaxPerEpoch
	if maxByBudget.LT(math.NewIntFromUint64(maxTasks)) {
		maxTasks = maxByBudget.Uint64()
	}
	if maxTasks == 0 {
		return nil
	}

	// Gather active providers (assignee pool).
	assigneePool := make([]string, 0, 32)
	if err := k.Providers.Walk(ctx, nil, func(addr string, p types.Provider) (stop bool, err error) {
		if strings.TrimSpace(p.Status) != "Active" {
			return false, nil
		}
		if p.Draining {
			return false, nil
		}
		assigneePool = append(assigneePool, strings.TrimSpace(p.Address))
		return false, nil
	}); err != nil {
		return err
	}
	if len(assigneePool) == 0 {
		return nil
	}

	// Gather audit targets (serving slots/providers).
	height := uint64(ctx.BlockHeight())
	targets := make([]auditTarget, 0, 64)
	if err := k.Deals.Walk(ctx, nil, func(dealID uint64, deal types.Deal) (stop bool, err error) {
		// end_block is exclusive: once height >= end_block, the deal is expired.
		if height < deal.StartBlock || height >= deal.EndBlock {
			return false, nil
		}
		if len(deal.ManifestRoot) != 48 {
			return false, nil
		}
		in, ok := slabInputs(deal)
		if !ok {
			return false, nil
		}
		stripe, err := stripeParamsForDeal(deal)
		if err != nil {
			return false, nil
		}

		if stripe.mode == 2 && len(deal.Mode2Slots) > 0 {
			for _, slot := range deal.Mode2Slots {
				if slot == nil {
					continue
				}
				if slot.Status != types.SlotStatus_SLOT_STATUS_ACTIVE {
					continue
				}
				provider := strings.TrimSpace(slot.Provider)
				if provider == "" {
					continue
				}
				targets = append(targets, auditTarget{
					dealID:   dealID,
					deal:     deal,
					stripe:   stripe,
					in:       in,
					mode:     2,
					provider: provider,
					slot:     slot.Slot,
				})
			}
			return false, nil
		}

		for _, provider := range deal.Providers {
			provider = strings.TrimSpace(provider)
			if provider == "" {
				continue
			}
			targets = append(targets, auditTarget{
				dealID:   dealID,
				deal:     deal,
				stripe:   stripe,
				in:       in,
				mode:     1,
				provider: provider,
			})
		}
		return false, nil
	}); err != nil {
		return err
	}
	if len(targets) == 0 {
		return nil
	}

	// Pin tasks to the epoch end (or deal end_block, whichever is sooner).
	epochEnd := height
	if params.EpochLenBlocks > 0 {
		epochEnd = height + params.EpochLenBlocks - 1
	}

	seed := k.getEpochSeed(ctx, epochID)

	pickAssignee := func(serving string, dealID uint64, slot uint32, taskID uint64) string {
		buf := make([]byte, 0, 32+8+4+8+len(serving))
		buf = append(buf, seed[:]...)
		buf = binary.BigEndian.AppendUint64(buf, dealID)
		var slotB [4]byte
		binary.BigEndian.PutUint32(slotB[:], slot)
		buf = append(buf, slotB[:]...)
		buf = binary.BigEndian.AppendUint64(buf, taskID)
		buf = append(buf, []byte(serving)...)
		sum := sha256.Sum256(buf)
		idx := int(binary.BigEndian.Uint64(sum[:8]) % uint64(len(assigneePool)))
		assignee := strings.TrimSpace(assigneePool[idx])
		if assignee == "" {
			return serving
		}
		if assignee == serving && len(assigneePool) > 1 {
			assignee = assigneePool[(idx+1)%len(assigneePool)]
		}
		return assignee
	}

	for i := uint64(1); i <= maxTasks; i++ {
		// Pick target with replacement (simple v1 strategy).
		buf := make([]byte, 0, 32+8)
		buf = append(buf, seed[:]...)
		buf = binary.BigEndian.AppendUint64(buf, i)
		sum := sha256.Sum256(buf)
		targetIdx := int(binary.BigEndian.Uint64(sum[:8]) % uint64(len(targets)))
		target := targets[targetIdx]

		startMdu := uint64(0)
		startBlob := uint32(0)
		switch target.mode {
		case 2:
			startMdu, startBlob = deriveMode2Challenge(seed, target.dealID, target.deal.CurrentGen, uint64(target.slot), i-1, target.in, target.stripe)
		default:
			assignment, err := assignmentBytesMode1(target.provider)
			if err != nil {
				continue
			}
			startMdu, startBlob = deriveMode1Challenge(seed, target.dealID, target.deal.CurrentGen, assignment, i-1, target.in)
		}

		expiresAt := target.deal.EndBlock
		if epochEnd < expiresAt {
			expiresAt = epochEnd
		}

		assignee := pickAssignee(target.provider, target.dealID, target.slot, i)
		if strings.TrimSpace(assignee) == "" {
			assignee = target.provider
		}

		task := types.AuditTask{
			EpochId:        epochID,
			TaskId:         i,
			DealId:         target.dealID,
			Assignee:       assignee,
			Provider:       target.provider,
			ManifestRoot:   target.deal.ManifestRoot,
			StartMduIndex:  startMdu,
			StartBlobIndex: startBlob,
			BlobCount:      1,
			ExpiresAt:      expiresAt,
		}

		if err := k.AuditTasks.Set(ctx, collections.Join(epochID, i), task); err != nil {
			return fmt.Errorf("failed to store audit task: %w", err)
		}
	}

	return nil
}
